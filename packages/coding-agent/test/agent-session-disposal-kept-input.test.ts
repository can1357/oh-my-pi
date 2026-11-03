import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
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

// Input the session accepted is kept when it is disposed (written before session_exit), and the
// work it has in flight starts no turn, delivers no result and commits no transition afterwards.

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeAll(async () => {
	tempDir = TempDir.createSync("@pi-disposal-kept-input-");
	await initTheme();
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

let sessionDirs = 0;

/** A file-backed session whose provider requests are counted. */
async function createSession(
	options: {
		streamFn?: StreamFn;
		sideStreamFn?: StreamFn;
		extension?: ExtensionFactory;
		asyncJobManager?: AsyncJobManager;
		agentId?: string;
	} = {},
): Promise<{ session: AgentSession; manager: SessionManager; agent: Agent; requests: () => number }> {
	const directory = path.join(tempDir.path(), `session-${++sessionDirs}`);
	const manager = SessionManager.create(directory, directory);
	let requests = 0;
	const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
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
			"disposal-kept-input",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, directory, manager, modelRegistry);
	}
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner,
		sideStreamFn: options.sideStreamFn,
		asyncJobManager: options.asyncJobManager,
		agentId: options.agentId,
	});
	sessions.push(session);
	return { session, manager, agent, requests: () => requests };
}

/** The persisted transcript after disposal, one line per entry kind and text. */
async function persistedShape(manager: SessionManager): Promise<string[]> {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile));
	const entries = reopened.getEntries();
	await reopened.close();
	return entries.flatMap(entry => {
		if (entry.type === "custom" && entry.customType === "session_exit") return ["session_exit"];
		if (entry.type === "custom_message") {
			const text = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
			return [`${entry.customType}:${text}`];
		}
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") return [];
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(part => ("text" in part ? part.text : "")).join("");
		return [`${message.role}:${text}`];
	});
}

test("an IRC message that would wake an idle session at beginDispose starts no turn, and dispose keeps it", async () => {
	const { session, manager, requests } = await createSession();
	// A session file exists only once a turn has answered.
	await session.prompt("the first task");
	const afterDisposal: string[] = [];
	session.subscribe(event => {
		if (session.isDisposed) afterDisposal.push(event.type);
	});

	const delivery = session.deliverIrcMessage({
		id: "idle-wake",
		from: "peer",
		to: "main",
		body: "accepted while idle",
		ts: Date.now(),
	});
	session.beginDispose();
	expect(await delivery).toBe("woken");
	await withTimeout(session.waitForIdle(), 15_000, "The session did not settle");
	await session.dispose();

	// The first task's request only: the wake started no turn.
	expect(requests()).toBe(1);
	expect(afterDisposal).not.toContain("agent_start");
	const shape = await persistedShape(manager);
	expect(shape.some(line => line.startsWith("irc:incoming:") && line.includes("accepted while idle"))).toBe(true);
	expect(shape.at(-1)).toBe("session_exit");
}, 30_000);

test("an IRC message parked for a pooled worker is kept when the session is disposed", async () => {
	const { session, manager, requests } = await createSession();
	await session.prompt("the first task");
	await session.setWorkPoolYieldItems([{ id: "pooled-task", index: 0 }]);

	expect(
		await session.deliverIrcMessage({
			id: "parked",
			from: "peer",
			to: "main",
			body: "parked for the pool",
			ts: Date.now(),
		}),
	).toBe("woken");
	await withTimeout(session.waitForIdle(), 15_000, "The parked wake did not settle");
	session.beginDispose();
	await session.dispose();

	// The only request is the first task's: the parked message started no turn.
	expect(requests()).toBe(1);
	const shape = await persistedShape(manager);
	expect(shape.some(line => line.startsWith("irc:incoming:") && line.includes("parked for the pool"))).toBe(true);
	expect(shape.at(-1)).toBe("session_exit");
}, 30_000);

test("a steer and follow-up submitted after beginDispose are refused, sent nowhere and not recorded", async () => {
	const held = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const entered = Promise.withResolvers<void>();
	const { session, manager, requests } = await createSession({
		streamFn: (requestModel, context, options) => {
			entered.resolve();
			return held.stream(requestModel, context, options);
		},
	});

	const running = session.prompt("the running task").catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The provider request did not start");
	session.beginDispose();
	// Not accepted: the session is disposing, so the callers learn it at once.
	const refused = { name: "PromptDroppedError", sessionDisposed: true };
	await expect(session.steer("steer after disposal began")).rejects.toMatchObject(refused);
	await expect(session.followUp("follow-up after disposal began")).rejects.toMatchObject(refused);
	await session.dispose();
	await running;

	expect(requests()).toBe(1);
	const shape = await persistedShape(manager);
	expect(shape.at(-1)).toBe("session_exit");
	expect(shape).not.toContain("user:steer after disposal began");
	expect(shape).not.toContain("user:follow-up after disposal began");
}, 30_000);

test("a steer held by live steering when disposal aborts the response is kept", async () => {
	const claimed = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const { session, manager } = await createSession({
		streamFn: async (_requestModel, _context, options) => {
			entered.resolve();
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("Expected the live steering capability");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener("abort", () => stream.fail(new DOMException("aborted", "AbortError")), { once: true });
			await live.wait(signal);
			if (!(await live.claim(signal))) throw new Error("Expected the steer to be claimed");
			claimed.resolve();
			return stream;
		},
	});

	const running = session.prompt("the running task").catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The provider request did not start");
	await session.steer("steer taken by the live response");
	await withTimeout(claimed.promise, 15_000, "Live steering did not take the steer");
	session.beginDispose();
	await session.dispose();
	await running;

	const shape = await persistedShape(manager);
	expect(shape).toContain("user:steer taken by the live response");
	expect(shape.at(-1)).toBe("session_exit");
}, 30_000);

test("a side turn delivers no text buffered before beginDispose and rejects with an AbortError", async () => {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "firstsecond" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const { session } = await createSession({ sideStreamFn: () => stream });
	const delivered: { text: string; disposed: boolean }[] = [];
	const firstDelivered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();

	const turn = session.runEphemeralTurn({
		promptText: "a side question",
		onTextDelta: async text => {
			delivered.push({ text, disposed: session.isDisposed });
			firstDelivered.resolve();
			await release.promise;
		},
	});
	const outcome = turn.then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.name : String(error)),
	);
	stream.push({ type: "text_delta", contentIndex: 0, delta: "first", partial: message });
	await withTimeout(firstDelivered.promise, 15_000, "The first delta was not delivered");
	// The rest of the answer is already buffered when disposal begins.
	stream.push({ type: "text_delta", contentIndex: 0, delta: "second", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	session.beginDispose();
	release.resolve();

	expect(await outcome).toBe("AbortError");
	expect(delivered).toEqual([{ text: "first", disposed: false }]);
}, 30_000);

test("a side turn whose transport stops on the disposal abort rejects with an AbortError", async () => {
	const requested = Promise.withResolvers<void>();
	const { session } = await createSession({
		sideStreamFn: (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			// As the real transports do: the abort ends the request with their own error.
			options?.signal?.addEventListener("abort", () => stream.fail(new Error("Request was aborted")), {
				once: true,
			});
			requested.resolve();
			return stream;
		},
	});

	const turn = session.runEphemeralTurn({ promptText: "a side question in flight" });
	await withTimeout(requested.promise, 15_000, "The side request did not start");
	session.beginDispose();

	await expect(turn).rejects.toMatchObject({ name: "AbortError" });
}, 30_000);

test("a /btw promotion waiting on session_before_branch at beginDispose commits nothing", async () => {
	const hookEntered = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const branchEvents: boolean[] = [];
	const holder: { session?: AgentSession } = {};
	const { session, manager } = await createSession({
		extension: pi => {
			pi.on("session_before_branch", async () => {
				hookEntered.resolve();
				await releaseHook.promise;
			});
			pi.on("session_branch", () => {
				branchEvents.push(holder.session?.isDisposed ?? false);
			});
		},
	});
	holder.session = session;
	await session.prompt("the first task");
	const answer = session.messages.find(message => message.role === "assistant");
	if (answer?.role !== "assistant") throw new Error("Expected an assistant answer");
	const leafId = manager.getLeafId();
	if (!leafId) throw new Error("Expected a persisted leaf");
	const sessionFile = manager.getSessionFile();

	const promotion = session.branchFromBtw("promoted after disposal began", answer, leafId, manager.getSessionId());
	await withTimeout(hookEntered.promise, 15_000, "The branch hook did not run");
	session.beginDispose();
	releaseHook.resolve();

	expect(await promotion).toEqual({ cancelled: true, sessionFile });
	expect(manager.getSessionFile()).toBe(sessionFile);
	expect(branchEvents).toEqual([]);
	await session.dispose();
	expect((await persistedShape(manager)).some(line => line.includes("promoted after disposal began"))).toBe(false);
}, 30_000);

test("a new session waiting on session_before_switch at beginDispose is not started", async () => {
	const hookEntered = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const { session, manager } = await createSession({
		extension: pi => {
			pi.on("session_before_switch", async () => {
				hookEntered.resolve();
				await releaseHook.promise;
			});
		},
	});
	await session.prompt("the first task");
	const sessionFile = manager.getSessionFile();

	const started = session.newSession();
	await withTimeout(hookEntered.promise, 15_000, "The switch hook did not run");
	session.beginDispose();
	releaseHook.resolve();

	expect(await started).toBe(false);
	expect(manager.getSessionFile()).toBe(sessionFile);
	await session.dispose();
	const shape = await persistedShape(manager);
	expect(shape).toEqual(["user:the first task", "assistant:done", "session_exit"]);
}, 30_000);

test("a new session whose final flush outlasts beginDispose is not started and announces nothing", async () => {
	const switches: string[] = [];
	const { session, manager } = await createSession({
		extension: pi => {
			pi.on("session_switch", event => {
				switches.push(event.reason);
			});
		},
	});
	await session.prompt("the first task");
	const sessionFile = manager.getSessionFile();
	const flush = manager.flush.bind(manager);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	vi.spyOn(manager, "flush").mockImplementation(async () => {
		await flush();
		if (held) return;
		held = true;
		entered.resolve();
		await release.promise;
	});

	const started = session.newSession();
	await withTimeout(entered.promise, 15_000, "newSession did not flush");
	session.beginDispose();
	release.resolve();

	expect(await started).toBe(false);
	expect(manager.getSessionFile()).toBe(sessionFile);
	expect(switches).toEqual([]);
}, 30_000);

test("a session switch whose cwd change outlasts beginDispose rolls back and announces nothing", async () => {
	const switches: string[] = [];
	const { session, manager } = await createSession({
		extension: pi => {
			pi.on("session_switch", event => {
				switches.push(event.reason);
			});
		},
	});
	await session.prompt("the first task");
	const answer = session.messages.find(message => message.role === "assistant");
	if (!answer) throw new Error("Expected an assistant answer");
	const otherCwd = path.join(tempDir.path(), "switch-target-cwd");
	const target = SessionManager.create(otherCwd, otherCwd);
	target.appendMessage(answer);
	await target.flush();
	const targetFile = target.getSessionFile();
	await target.close();
	if (!targetFile) throw new Error("Expected a target session file");
	const sessionFile = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cwdChanges: string[] = [];

	const switched = session
		.switchSession(targetFile, {
			keepModel: true,
			onCwdChange: async cwd => {
				cwdChanges.push(cwd);
				if (cwdChanges.length === 1) {
					entered.resolve();
					await release.promise;
				}
				return true;
			},
		})
		.then(
			value => ({ value }),
			(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
		);
	await withTimeout(entered.promise, 15_000, "The cwd change did not start");
	session.beginDispose();
	release.resolve();

	expect(await switched).toEqual({ error: "Session switch cancelled: the session is being disposed." });
	expect(manager.getSessionFile()).toBe(sessionFile);
	expect(manager.getSessionId()).toBe(sessionId);
	expect(switches).toEqual([]);
	// The rollback hands the cwd back to where the session was.
	expect(cwdChanges).toHaveLength(2);
}, 30_000);

test("a session switch refused after its reconciler leaves the session intact, and a later prompt is refused", async () => {
	const { session, manager, requests } = await createSession();
	await session.prompt("the first task");
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	session.setSessionBeforeSwitchReconciler(async () => {
		entered.resolve();
		await release.promise;
	});
	const switched = session.switchSession(sessionFile);
	await withTimeout(entered.promise, 15_000, "The reconciler did not run");
	session.beginDispose();
	release.resolve();
	expect(await switched).toBe(false);
	const events: string[] = [];
	session.subscribe(event => events.push(event.type));

	// Submitted after beginDispose(): refused, so it sends nothing and records nothing.
	await expect(session.prompt("submitted after the refused switch")).rejects.toMatchObject({
		name: "PromptDroppedError",
		sessionDisposed: true,
	});
	await session.dispose();

	expect(requests()).toBe(1);
	expect(events).not.toContain("agent_start");
	expect(manager.getSessionFile()).toBe(sessionFile);
	expect(await persistedShape(manager)).toEqual(["user:the first task", "assistant:done", "session_exit"]);
}, 30_000);

test("a steer the live response held is recorded ahead of a steer queued after it", async () => {
	const entered = Promise.withResolvers<void>();
	const claimed = Promise.withResolvers<void>();
	const { session, manager } = await createSession({
		streamFn: async (_requestModel, _context, options) => {
			entered.resolve();
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("Expected the live steering capability");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener("abort", () => stream.fail(new DOMException("aborted", "AbortError")), { once: true });
			await live.wait(signal);
			if (!(await live.claim(signal))) throw new Error("Expected the steer to be claimed");
			claimed.resolve();
			return stream;
		},
	});

	const running = session.prompt("the running task").catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The provider request did not start");
	await session.steer("the older steer the response took");
	await withTimeout(claimed.promise, 15_000, "Live steering did not take the steer");
	await session.steer("the newer steer still queued");
	session.beginDispose();
	await session.dispose();
	await running;

	const shape = await persistedShape(manager);
	expect(shape.filter(line => line.includes("steer"))).toEqual([
		"user:the older steer the response took",
		"user:the newer steer still queued",
	]);
	expect(shape.at(-1)).toBe("session_exit");
}, 30_000);

test("a displayable nextTurn message accepted during the turn is recorded at disposal", async () => {
	const entered = Promise.withResolvers<void>();
	const held = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const { session, manager } = await createSession({
		streamFn: (requestModel, context, options) => {
			entered.resolve();
			return held.stream(requestModel, context, options);
		},
	});

	const running = session.prompt("the running task").catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The provider request did not start");
	await session.sendCustomMessage(
		{ customType: "kept-next-turn", content: "accepted for the next turn", display: true },
		{ deliverAs: "nextTurn" },
	);
	session.beginDispose();
	await session.dispose();
	await running;

	const shape = await persistedShape(manager);
	expect(shape).toContain("kept-next-turn:accepted for the next turn");
	expect(shape.at(-1)).toBe("session_exit");
}, 30_000);

test("a finished background job's result waiting in the yield queue is recorded at disposal", async () => {
	const entered = Promise.withResolvers<void>();
	const held = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const jobs = new AsyncJobManager({});
	AsyncJobManager.setInstance(jobs);
	try {
		const { session, manager } = await createSession({
			asyncJobManager: jobs,
			agentId: "kept-input-owner",
			streamFn: (requestModel, context, options) => {
				entered.resolve();
				return held.stream(requestModel, context, options);
			},
		});
		const running = session.prompt("the running task").catch(() => undefined);
		await withTimeout(entered.promise, 15_000, "The provider request did not start");
		const enqueued = Promise.withResolvers<void>();
		const enqueue = session.yieldQueue.enqueueWithReceipt.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") enqueued.resolve();
			return receipt;
		});
		// A real process: its result reaches the queue while the turn still streams.
		jobs.register(
			"bash",
			"a job that finished during the turn",
			async () => {
				const child = Bun.spawn(["bash", "-c", "printf finished-job-output"], { stdout: "pipe", stderr: "pipe" });
				const output = await new Response(child.stdout).text();
				await child.exited;
				return output;
			},
			{ id: "kept-input-job", ownerId: "kept-input-owner" },
		);
		await withTimeout(enqueued.promise, 15_000, "The job result did not reach the queue");
		session.beginDispose();
		await session.dispose();
		await running;

		const shape = await persistedShape(manager);
		expect(shape.some(line => line.includes("finished-job-output"))).toBe(true);
		expect(shape.at(-1)).toBe("session_exit");
	} finally {
		AsyncJobManager.resetForTests();
	}
}, 30_000);
