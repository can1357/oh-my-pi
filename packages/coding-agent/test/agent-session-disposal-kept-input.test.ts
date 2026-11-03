import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
	options: { streamFn?: StreamFn; sideStreamFn?: StreamFn; extension?: ExtensionFactory } = {},
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

test("a steer and follow-up queued after beginDispose that no turn ran are kept at dispose", async () => {
	const held = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const entered = Promise.withResolvers<void>();
	const { session, manager } = await createSession({
		streamFn: (requestModel, context, options) => {
			entered.resolve();
			return held.stream(requestModel, context, options);
		},
	});

	const running = session.prompt("the running task").catch(() => undefined);
	await withTimeout(entered.promise, 15_000, "The provider request did not start");
	session.beginDispose();
	// Submitted after beginDispose(): each may run once, but dispose() aborts the turn first.
	await session.steer("steer after disposal began");
	await session.followUp("follow-up after disposal began");
	await session.dispose();
	await running;

	const shape = await persistedShape(manager);
	const marker = shape.indexOf("session_exit");
	expect(marker).toBe(shape.length - 1);
	expect(shape.slice(0, marker)).toEqual(
		expect.arrayContaining(["user:steer after disposal began", "user:follow-up after disposal began"]),
	);
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
