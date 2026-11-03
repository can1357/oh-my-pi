import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

// After beginDispose() the agent sends no further model request, and every input the session
// accepted is recorded exactly once, before session_exit, in the session's own file. Each case
// forces an ordering an earlier review found: input the running loop already held, a lent
// background result, prompt setup's copy of `nextTurn` messages, and transitions in flight.

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeAll(async () => {
	tempDir = TempDir.createSync("@pi-disposal-agent-barrier-");
	await initTheme();
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

let sessionDirs = 0;

/** A file-backed session that counts the provider requests it sends. */
async function createSession(
	options: {
		streamFn?: StreamFn;
		extension?: ExtensionFactory;
		asyncJobManager?: AsyncJobManager;
		agentId?: string;
	} = {},
) {
	const directory = path.join(tempDir.path(), `session-${++sessionDirs}`);
	const manager = SessionManager.create(directory, directory);
	let requests = 0;
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: (requestModel, context, streamOptions) => {
			requests++;
			return (options.streamFn ?? mock.stream)(requestModel, context, streamOptions);
		},
	});
	let extensionRunner: ExtensionRunner | undefined;
	if (options.extension) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			options.extension,
			directory,
			new EventBus(),
			runtime,
			"disposal-agent-barrier",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, directory, manager, modelRegistry);
	}
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner,
		asyncJobManager: options.asyncJobManager,
		agentId: options.agentId,
	});
	sessions.push(session);
	return { session, manager, agent, directory, requests: () => requests };
}

/** One line per entry of a session file: custom types, custom messages, and message role:text. */
async function persistedRows(sessionFile: string): Promise<string[]> {
	const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile));
	const entries = reopened.getEntries();
	await reopened.close();
	return entries.map(entry => {
		if (entry.type === "custom") return entry.customType;
		if (entry.type === "custom_message") {
			return `${entry.customType}:${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)}`;
		}
		if (entry.type !== "message") return entry.type;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") return message.role;
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(part => ("text" in part ? part.text : "")).join("");
		return `${message.role}:${text}`;
	});
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return file;
}

test("a steer the loop dequeued while a before-model-call hook waits is not sent after beginDispose, and is recorded once", async () => {
	const firstEntered = Promise.withResolvers<void>();
	const firstRelease = Promise.withResolvers<void>();
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	let calls = 0;
	const { session, manager, agent, requests } = await createSession({
		streamFn: async (requestModel, context, options) => {
			if (++calls === 1) {
				firstEntered.resolve();
				await firstRelease.promise;
			}
			return mock.stream(requestModel, context, options);
		},
	});
	const hookEntered = Promise.withResolvers<void>();
	const hookRelease = Promise.withResolvers<void>();
	let hooks = 0;
	agent.addBeforeModelCall(async () => {
		if (++hooks !== 2) return;
		hookEntered.resolve();
		await hookRelease.promise;
	});

	const running = session.prompt("initial");
	await withTimeout(firstEntered.promise, 15_000, "The first request did not start");
	await session.steer("accepted before the second call");
	firstRelease.resolve();
	await withTimeout(hookEntered.promise, 15_000, "The second model-call hook did not run");
	session.beginDispose();
	hookRelease.resolve();
	await running;
	const file = sessionFileOf(manager);
	await session.dispose();

	expect(requests()).toBe(1);
	const rows = await persistedRows(file);
	expect(rows.filter(row => row === "user:accepted before the second call")).toHaveLength(1);
	expect(rows.indexOf("user:accepted before the second call")).toBeGreaterThan(rows.indexOf("assistant:answer"));
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

for (const settle of ["declines", "never settles"] as const) {
	test(`a live steer the provider claimed and ${settle} after beginDispose starts no request, and is recorded once`, async () => {
		const entered = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
		let calls = 0;
		const { session, manager, requests } = await createSession({
			streamFn: async (requestModel, context, options) => {
				if (++calls === 1) {
					const live = options?.liveSteering;
					const signal = options?.signal;
					if (!live || !signal) throw new Error("Expected the live steering capability");
					entered.resolve();
					await live.wait(signal);
					const claim = await live.claim(signal);
					if (!claim) throw new Error("Expected the steer to be claimed");
					claimed.resolve();
					await release.promise;
					if (settle === "declines") claim.reject();
				}
				return mock.stream(requestModel, context, options);
			},
		});

		const running = session.prompt("initial");
		await withTimeout(entered.promise, 15_000, "The first request did not start");
		await session.steer("live input");
		await withTimeout(claimed.promise, 15_000, "Live steering did not claim the steer");
		session.beginDispose();
		release.resolve();
		await running;
		const file = sessionFileOf(manager);
		await session.dispose();

		expect(requests()).toBe(1);
		const rows = await persistedRows(file);
		expect(rows.filter(row => row === "user:live input")).toHaveLength(1);
		expect(rows.at(-1)).toBe("session_exit");
	}, 30_000);
}

test("a background result the yield queue already lent to the loop is recorded once and starts no request", async () => {
	const jobs = new AsyncJobManager({});
	AsyncJobManager.setInstance(jobs);
	const { session, manager, agent, requests } = await createSession({
		asyncJobManager: jobs,
		agentId: "barrier-owner",
	});
	await session.prompt("initial");
	const beforeYield = Promise.withResolvers<void>();
	const releaseYield = Promise.withResolvers<void>();
	agent.setOnBeforeYield(async () => {
		beforeYield.resolve();
		await releaseYield.promise;
	});
	const enqueued = Promise.withResolvers<void>();
	let receipt = "pending";
	const enqueue = session.yieldQueue.enqueueWithReceipt.bind(session.yieldQueue);
	vi.spyOn(session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
		const pending = enqueue(kind, entry);
		void pending.then(
			() => {
				receipt = "resolved";
			},
			() => {
				receipt = "rejected";
			},
		);
		enqueued.resolve();
		return pending;
	});
	const running = session.prompt("active turn");
	await withTimeout(beforeYield.promise, 15_000, "The turn did not reach its yield boundary");
	// A real process: its result reaches the queue while the turn waits at the boundary.
	jobs.register(
		"bash",
		"a job that finished at the boundary",
		async () => {
			const child = Bun.spawn(["bash", "-c", "printf lazy-real-process-result"], { stdout: "pipe", stderr: "pipe" });
			const output = await new Response(child.stdout).text();
			await child.exited;
			return output;
		},
		{ id: "barrier-lazy-job", ownerId: "barrier-owner" },
	);
	await withTimeout(enqueued.promise, 15_000, "The job result did not reach the queue");
	// Disposal begins in the microtask between the loop taking the thunks and calling them.
	const drainLazy = session.yieldQueue.drainLazy.bind(session.yieldQueue);
	let lent = false;
	vi.spyOn(session.yieldQueue, "drainLazy").mockImplementation(() => {
		const thunks = drainLazy();
		if (thunks.length > 0 && !lent) {
			lent = true;
			queueMicrotask(() => session.beginDispose());
		}
		return thunks;
	});
	releaseYield.resolve();
	await running;
	const file = sessionFileOf(manager);
	await session.dispose();

	expect(lent).toBe(true);
	expect(requests()).toBe(2);
	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("lazy-real-process-result"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
	expect(receipt).toBe("resolved");
}, 30_000);

test("a nextTurn message prompt setup took for its turn is recorded when disposal drops that prompt", async () => {
	const firstEntered = Promise.withResolvers<void>();
	const firstRelease = Promise.withResolvers<void>();
	const setupEntered = Promise.withResolvers<void>();
	const setupRelease = Promise.withResolvers<void>();
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	let calls = 0;
	let setups = 0;
	const { session, manager, requests } = await createSession({
		streamFn: async (requestModel, context, options) => {
			if (++calls === 1) {
				firstEntered.resolve();
				await firstRelease.promise;
			}
			return mock.stream(requestModel, context, options);
		},
		extension: pi => {
			pi.on("before_agent_start", async () => {
				if (++setups !== 2) return;
				setupEntered.resolve();
				await setupRelease.promise;
			});
		},
	});

	const first = session.prompt("initial");
	await withTimeout(firstEntered.promise, 15_000, "The first request did not start");
	await session.sendCustomMessage(
		{ customType: "kept-next-turn", content: "accepted before the next setup", display: true },
		{ deliverAs: "nextTurn" },
	);
	firstRelease.resolve();
	await first;
	const file = sessionFileOf(manager);
	const second = session.prompt("dropped before dispatch").then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.name : String(error)),
	);
	await withTimeout(setupEntered.promise, 15_000, "The second prompt did not reach setup");
	session.beginDispose();
	setupRelease.resolve();
	expect(await second).toBe("PromptDroppedError");
	await session.dispose();

	expect(requests()).toBe(1);
	const rows = await persistedRows(file);
	expect(rows.filter(row => row === "kept-next-turn:accepted before the next setup")).toHaveLength(1);
	expect(rows).not.toContain("user:dropped before dispatch");
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

test("a context reset that disposal overtakes clears nothing, and the accepted nextTurn input is recorded", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	await session.sendCustomMessage(
		{ customType: "kept-reset-input", content: "accepted before the reset", display: true },
		{ deliverAs: "nextTurn" },
	);
	const file = sessionFileOf(manager);

	const reset = session.resetSessionContext();
	session.beginDispose();
	expect(await reset).toBeUndefined();
	await session.dispose();

	const rows = await persistedRows(file);
	expect(rows).toContain("kept-reset-input:accepted before the reset");
	expect(rows).not.toContain("reset_boundary");
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

test("dispose() during a switch whose cwd hook has not returned writes the kept input and session_exit to the outgoing file", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	await session.sendCustomMessage(
		{ customType: "kept-switch-input", content: "accepted before the switch", display: true },
		{ deliverAs: "nextTurn" },
	);
	const answer = session.messages.find(message => message.role === "assistant");
	if (!answer) throw new Error("Expected an assistant answer");
	const otherDir = path.join(tempDir.path(), `switch-target-${sessionDirs}`);
	const target = SessionManager.create(otherDir, otherDir);
	target.appendMessage(answer);
	await target.flush();
	const targetFile = target.getSessionFile();
	await target.close();
	if (!targetFile) throw new Error("Expected a target session file");
	const outgoing = sessionFileOf(manager);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let cwdChanges = 0;

	const switched = session
		.switchSession(targetFile, {
			keepModel: true,
			onCwdChange: async () => {
				if (++cwdChanges === 1) {
					entered.resolve();
					await release.promise;
				}
				return true;
			},
		})
		.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	await withTimeout(entered.promise, 15_000, "The cwd hook did not run");
	session.beginDispose();
	// The hook is released only after dispose() returned, past its wait for the transition.
	await withTimeout(session.dispose({ drainTimeoutMs: 200 }), 30_000, "dispose() did not finish");
	release.resolve();
	expect(await switched).toBe("Session switch cancelled: the session is being disposed.");

	const outgoingRows = await persistedRows(outgoing);
	expect(outgoingRows.filter(row => row === "kept-switch-input:accepted before the switch")).toHaveLength(1);
	expect(outgoingRows.at(-1)).toBe("session_exit");
	expect(await persistedRows(targetFile)).not.toContain("session_exit");
}, 30_000);

test("dispose() waits for a switch that rolls back during its wait, and records the kept input once in the outgoing file", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	await session.sendCustomMessage(
		{ customType: "kept-rollback-input", content: "accepted before the switch", display: true },
		{ deliverAs: "nextTurn" },
	);
	const answer = session.messages.find(message => message.role === "assistant");
	if (!answer) throw new Error("Expected an assistant answer");
	const otherDir = path.join(tempDir.path(), `rollback-target-${sessionDirs}`);
	const target = SessionManager.create(otherDir, otherDir);
	target.appendMessage(answer);
	await target.flush();
	const targetFile = target.getSessionFile();
	await target.close();
	if (!targetFile) throw new Error("Expected a target session file");
	const outgoing = sessionFileOf(manager);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let cwdChanges = 0;

	const switched = session
		.switchSession(targetFile, {
			keepModel: true,
			onCwdChange: async () => {
				if (++cwdChanges === 1) {
					entered.resolve();
					await release.promise;
				}
				return true;
			},
		})
		.catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The cwd hook did not run");
	session.beginDispose();
	const closing = session.dispose();
	release.resolve();
	await withTimeout(closing, 30_000, "dispose() did not finish");
	await switched;

	const outgoingRows = await persistedRows(outgoing);
	expect(outgoingRows.filter(row => row === "kept-rollback-input:accepted before the switch")).toHaveLength(1);
	expect(outgoingRows.at(-1)).toBe("session_exit");
	expect(await persistedRows(targetFile)).not.toContain("session_exit");
}, 30_000);
