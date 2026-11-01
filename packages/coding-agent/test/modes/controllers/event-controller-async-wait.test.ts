/**
 * A turn can end while background jobs it started are still running: the
 * session settles with `awaitingAsyncWork` and only a job result can resume it.
 *
 * Contracts:
 *  1. The working row names that wait and its jobs — not the last tool call's
 *     intent — until a woken run takes the row back.
 *  2. Ending the wait (Esc → `stopAwaitingAsyncWork`) interrupts the session and
 *     tears the run down at once, while the jobs keep running; the settle watch
 *     must not tear it down a second time when they finish.
 *  3. End to end on a real session: a job that finishes after the wait was
 *     ended lands in context and does not start a model turn.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

type AgentEnd = Extract<AgentSessionEvent, { type: "agent_end" }>;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function asyncWaitEnd(): AgentEnd {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "started the job" }],
		stopReason: "stop",
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
	return { type: "agent_end", messages: [message], isTerminal: false, yielded: true, awaitingAsyncWork: true };
}

function runningJobs(ids: string[]): AsyncJobSnapshot {
	return {
		running: ids.map(id => ({ id, type: "bash", status: "running", label: `job ${id}`, startTime: 0 })),
		recent: [],
		delivery: { queued: 0, inFlight: 0, deliveredRecently: 0 },
	} as unknown as AsyncJobSnapshot;
}

/** Stub session whose background jobs stay pending until `drain()`; `cancel(id)` drops one job without a wake. */
function makeWaitingContext(jobIds: string[]) {
	let pending = true;
	const running = [...jobIds];
	const settled = Promise.withResolvers<void>();
	const abort = vi.fn(async (_options?: { reason?: string }) => {});
	const suppressAutoResumeUntilPrompt = vi.fn(() => {});
	const ctx = createInteractiveModeContext({
		sessionManager: { getSessionName: () => "test-session" },
		session: {
			hasAdmittedSubmission: true,
			hasPendingAsyncWork: () => pending,
			settleAsyncWork: () => settled.promise,
			getAsyncJobSnapshot: () => runningJobs(pending ? running : []),
			abort,
			suppressAutoResumeUntilPrompt,
		},
	});
	const drain = () => {
		pending = false;
		settled.resolve();
	};
	const cancel = (id: string) => {
		running.splice(running.indexOf(id), 1);
	};
	return { ctx, drain, abort, cancel, suppressAutoResumeUntilPrompt };
}

/** What the working row shows now, as the loader reads it on a tick. */
function rowLabel(setWorkingMessage: { mock: { calls: unknown[][] } }): string | undefined {
	const message = setWorkingMessage.mock.calls.at(-1)?.[0];
	if (typeof message === "function") return message();
	return typeof message === "string" ? message : undefined;
}

/** One macrotask hop: every microtask continuation queued so far has run. */
async function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("EventController — run waiting only on background jobs", () => {
	it("names the waited-on jobs on the working row, then hands the row back to a woken run", async () => {
		const { ctx } = makeWaitingContext(["bg_1", "bg_2"]);
		const setWorkingMessage = vi.spyOn(ctx, "setWorkingMessage");
		const ensureLoadingAnimation = vi.spyOn(ctx, "ensureLoadingAnimation");
		const controller = new EventController(ctx);

		await controller.handleEvent(asyncWaitEnd());

		// The prompt's own completion may already have torn the loader down.
		expect(ensureLoadingAnimation).toHaveBeenCalled();
		const label = rowLabel(setWorkingMessage);
		expect(label).toContain("bg_1");
		expect(label).toContain("bg_2");
		expect(controller.isAwaitingAsyncWork()).toBe(true);

		// A job result woke the run: the row must not keep claiming it waits.
		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		expect(setWorkingMessage).toHaveBeenLastCalledWith();
		expect(controller.isAwaitingAsyncWork()).toBe(false);
	});

	it("drops a job cancelled without a wake from the row on the next tick", async () => {
		// `/jobs kill bg_1` enqueues no wake, so no settle or agent_start refreshes
		// the row; a label built once at the settle kept naming the dead job.
		const { ctx, cancel } = makeWaitingContext(["bg_1", "bg_2"]);
		const setWorkingMessage = vi.spyOn(ctx, "setWorkingMessage");
		const controller = new EventController(ctx);
		await controller.handleEvent(asyncWaitEnd());
		expect(rowLabel(setWorkingMessage)).toContain("bg_1");

		cancel("bg_1");

		const label = rowLabel(setWorkingMessage);
		expect(label).not.toContain("bg_1");
		expect(label).toContain("bg_2");
		expect(label).not.toContain("2 background jobs");
	});

	it("ends the wait with a user interrupt and tears the run down while its jobs keep running", async () => {
		const { ctx, drain, abort, suppressAutoResumeUntilPrompt } = makeWaitingContext(["bg_1"]);
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const notify = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const controller = new EventController(ctx);
		await controller.handleEvent(asyncWaitEnd());
		expect(markActivityEnd).not.toHaveBeenCalled();

		await controller.stopAwaitingAsyncWork();

		expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		// The abort stops no run here, so it suppresses nothing by itself: ending the
		// wait is what keeps the job results from starting a turn.
		expect(suppressAutoResumeUntilPrompt).toHaveBeenCalledTimes(1);
		// Torn down now, with the job still pending — not when it finishes.
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(controller.isAwaitingAsyncWork()).toBe(false);
		// The user stopped it on purpose: no "Complete" toast.
		expect(notify).not.toHaveBeenCalled();
		// It says what is still running, since its result will now arrive silently.
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("1 background job"));

		drain();
		await nextMacrotask();
		// The retired settle watch must not run the teardown again.
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});
});

describe("EventController — ending the wait on a real session", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let manager: AsyncJobManager | undefined;
	let authStorage: AuthStorage | undefined;
	const gates: Array<PromiseWithResolvers<string>> = [];

	afterEach(async () => {
		for (const gate of gates.splice(0)) gate.resolve("done");
		await session?.dispose();
		manager?.cancelAll();
		await manager?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		session = undefined;
		manager = undefined;
		authStorage = undefined;
		tempDir = undefined;
	});

	it("folds a job result that lands after the wait was ended into context without starting a turn", async () => {
		tempDir = TempDir.createSync("@pi-async-wait-esc-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({
			responses: [{ content: ["job started"], stopReason: "stop" }],
			handler: () => ({ content: ["woke up after the job"], stopReason: "stop" }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			agentId: "Main",
			asyncJobManager: manager,
		});
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", "sleep 150", async () => await gate.promise, { ownerId: "Main" });

		const ends: AgentEnd[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") ends.push(event);
		});
		await session.prompt("start the long job");
		await session.waitForIdle();
		const waitEnd = ends.findLast(event => event.awaitingAsyncWork === true);
		if (!waitEnd) throw new Error("Expected the turn to settle waiting on the background job");
		expect(mock.calls.length).toBe(1);

		const ctx = createInteractiveModeContext({ session, sessionManager });
		const controller = new EventController(ctx);
		await controller.handleEvent(waitEnd);
		expect(controller.isAwaitingAsyncWork()).toBe(true);

		await controller.stopAwaitingAsyncWork();
		expect(session.isStreaming).toBe(false);

		gate.resolve("JOB_FINISHED");
		await session.settleAsyncWork();
		await session.waitForIdle();

		expect(mock.calls.length).toBe(1);
		const results = session.agent.state.messages.filter(
			message => "customType" in message && message.customType === "async-result",
		);
		expect(results).toHaveLength(1);
	});
});
