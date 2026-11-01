/**
 * Contract (issue #10363): print mode is single-shot by default — it disposes
 * after its prompts, so a background job the run started never reaches the
 * model. With `async.printWake` the run stays alive while owned async work is
 * pending, each job result wakes the same session for another turn (a turn may
 * start further jobs), and the text output is the answer of the last turn.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncPrintWake } from "@oh-my-pi/pi-coding-agent/tools/settings";

function assistant(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as unknown as AssistantMessage;
}

/**
 * Session whose first prompt starts `jobs` background jobs. Each settle delivers
 * one job result, which runs a follow-up turn answering `result <n>`; the first
 * follow-up turn starts `jobsStartedByFirstWake` more jobs. `retryBackoff` puts the
 * prompt turn or the first follow-up turn into a retry backoff that, as in the real
 * session, keeps `waitForIdle()` pending until dispose cancels the retry.
 */
function sessionWithJobs(
	settings: Settings,
	jobs: number,
	options: {
		jobsNeverFinish?: boolean;
		jobsStartedByFirstWake?: number;
		settleMs?: number;
		retryBackoff?: "prompt" | "follow-up";
	} = {},
) {
	const events: string[] = [];
	let pending = 0;
	let last: AssistantMessage | undefined;
	let delivered = 0;
	let retrying = false;
	const retryCancelled = Promise.withResolvers<void>();
	const waitForIdle = async () => {
		if (retrying) await retryCancelled.promise;
	};
	const session = {
		extensionRunner: undefined,
		subscribe: () => () => {},
		settings,
		isDisposed: false,
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			getCwd: () => process.cwd(),
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => events.push("advisor-drain"),
		waitForIdle,
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => {
			events.push("advisor-catchup");
			return true;
		},
		prompt: async (text: string) => {
			events.push(`prompt:${text}`);
			pending = jobs;
			last = assistant("started");
			retrying = options.retryBackoff === "prompt";
		},
		hasPendingAsyncWork: () => pending > 0,
		settleAsyncWork: async () => {
			// a job that never finishes on its own: only the deadline can end the wait
			if (options.jobsNeverFinish) await Promise.withResolvers<void>().promise;
			// Real delay on purpose: the oversized-deadline test needs Bun's real setTimeout
			// overflow (an oversized delay fires in ~1 ms) to beat a settle that takes longer.
			if (options.settleMs) await Bun.sleep(options.settleMs);
			delivered++;
			pending--;
			if (delivered === 1) pending += options.jobsStartedByFirstWake ?? 0;
			events.push(`wake:${delivered}`);
			last = assistant(`result ${delivered}`);
			if (delivered === 1 && options.retryBackoff === "follow-up") retrying = true;
			await waitForIdle();
		},
		getLastAssistantMessage: () => last,
		dispose: async () => {
			retryCancelled.resolve();
			events.push(`dispose(pending=${pending})`);
		},
	};
	return { session: session as unknown as AgentSession, events };
}

function captureStdout(): { lines: string[] } {
	const lines: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: (err?: Error) => void) => {
		lines.push(String(chunk));
		cb?.();
		return true;
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
	return { lines };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("print mode async-result wake", () => {
	test("by default exits after the prompt and disposes with the job still pending", async () => {
		const { lines } = captureStdout();
		const { session, events } = sessionWithJobs(Settings.isolated(), 1);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(events).toEqual(["prompt:go", "advisor-drain", "advisor-catchup", "dispose(pending=1)"]);
		expect(lines.join("")).toBe("started\n");
	});

	test("with async.printWake, every job result wakes the session before the advisor drain and exit", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 2);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(events).toEqual([
			"prompt:go",
			"wake:1",
			"wake:2",
			"advisor-drain",
			"advisor-catchup",
			"dispose(pending=0)",
		]);
		expect(lines.join("")).toBe("result 2\n");
	});

	test("with async.printWake, a job started by a follow-up turn is waited for and answers last", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1, { jobsStartedByFirstWake: 1 });

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(events).toEqual([
			"prompt:go",
			"wake:1",
			"wake:2",
			"advisor-drain",
			"advisor-catchup",
			"dispose(pending=0)",
		]);
		expect(lines.join("")).toBe("result 2\n");
	});

	test("with async.printWake, a --max-time beyond the 32-bit timer range does not expire early", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1, { settleMs: 30 });

		const code = await runPrintMode(session, {
			mode: "text",
			messages: ["go"],
			deadline: Date.now() + 600 * 60 * 60 * 1000,
		});

		expect(code).toBe(0);
		expect(events).toEqual(["prompt:go", "wake:1", "advisor-drain", "advisor-catchup", "dispose(pending=0)"]);
		expect(lines.join("")).toBe("result 1\n");
	});

	test("with async.printWake, a run that never reached the model does not wait on background work", async () => {
		captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1);

		expect(await runPrintMode(session, { mode: "text", messages: [] })).toBe(0);

		expect(events).toEqual(["advisor-drain", "advisor-catchup", "dispose(pending=0)"]);
	});

	test("with async.printWake, reaching --max-time while a job runs cancels it at once and fails the run", async () => {
		const { lines } = captureStdout();
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as never);
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1, { jobsNeverFinish: true });

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() + 50 });

		expect(code).toBe(1);
		// no advisor catch-up: the jobs stay live until dispose cancels them
		expect(events).toEqual(["prompt:go", "advisor-drain", "dispose(pending=1)"]);
		expect(lines.join("")).toBe("");
		expect(stderr.join("")).toContain("--max-time reached before background work settled");
	});

	test("with async.printWake, a deadline already past does not deliver work that finished meanwhile", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1);

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() - 1 });

		expect(code).toBe(1);
		expect(events).toEqual(["prompt:go", "advisor-drain", "dispose(pending=1)"]);
		expect(lines.join("")).toBe("");
	});

	test("with async.printWake, --max-time during a follow-up turn's retry backoff still disposes and fails the run", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1, { retryBackoff: "follow-up" });

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() + 50 });

		expect(code).toBe(1);
		expect(events).toEqual(["prompt:go", "wake:1", "advisor-drain", "dispose(pending=0)"]);
		expect(lines.join("")).toBe("");
	});

	test("with async.printWake, --max-time during the prompt turn's retry backoff with a job pending still disposes", async () => {
		captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, events } = sessionWithJobs(settings, 1, { retryBackoff: "prompt" });

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() + 50 });

		expect(code).toBe(1);
		expect(events).toEqual(["prompt:go", "advisor-drain", "dispose(pending=1)"]);
	});
});

/** A real AgentSession and AsyncJobManager: the first turn starts a background job and answers STARTED. */
describe("print mode async-result wake with a real session", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		AsyncJobManager.resetForTests();
	});

	async function realSession(printWake: boolean) {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		// The job finishes only once the first run is idle, so only the print-mode wait can deliver it.
		const firstRunIdle = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const resultDelivered = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("JOB_DONE_42")
						: message.content.some(part => part.type === "text" && part.text.includes("JOB_DONE_42")),
				);
				if (resultDelivered) return { content: ["JOB_DONE_42"] };
				manager.register(
					"bash",
					"echo JOB_DONE_42",
					async () => {
						await firstRunIdle.promise;
						return "JOB_DONE_42";
					},
					{ id: "print-job", ownerId: "Main" },
				);
				return { content: ["STARTED"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated();
		if (printWake) cfgAsyncPrintWake.override(settings, true);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			asyncJobManager: manager,
		});
		// Without the wake the job must still be running at dispose: keep its gate shut.
		if (printWake) {
			const waitForIdle = session.waitForIdle.bind(session);
			vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
				await waitForIdle();
				firstRunIdle.resolve();
			});
		}
		return { session, mock, manager };
	}

	test("by default prints the first answer and cancels the job at dispose", async () => {
		const { lines } = captureStdout();
		const { session, mock, manager } = await realSession(false);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("STARTED\n");
		expect(mock.calls).toHaveLength(1);
		expect(manager.getJob("print-job")?.status).toBe("cancelled");
	});

	test("with async.printWake, the job result wakes the same session and its answer is printed", async () => {
		const { lines } = captureStdout();
		const { session, mock } = await realSession(true);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("JOB_DONE_42\n");
		expect(mock.calls).toHaveLength(2);
	});
});
