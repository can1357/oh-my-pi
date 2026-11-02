import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompactionKeepRecentTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	tempDir = TempDir.createSync("@pi-disposal-prompts-");
	await initTheme();
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	vi.restoreAllMocks();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

test("a prompt parked on compaction cleanup rejects if disposal starts before dispatch", async () => {
	const hookStarted = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const manager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("session_before_compact", async event => {
				hookStarted.resolve();
				await releaseHook.promise;
				return {
					compaction: {
						summary: "must not commit after disposal",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"disposal-parked-prompt",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, registry);
	const mock = createMockModel();
	const requested: string[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestModel, context, options) => {
			requested.push(requestModel.id);
			mock.push({ content: ["done"] });
			return mock.stream(requestModel, context, options);
		},
	});
	const settings = Settings.isolated({ "compaction.enabled": false });
	cfgCompactionKeepRecentTokens.set(settings, 1);
	session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: registry, extensionRunner });
	await session.prompt("first full task");
	await session.prompt("second task");
	const compacting = session.compact(undefined, { mode: "soft" }).catch(() => undefined);
	await withTimeout(hookStarted.promise, 15_000, "Compaction hook did not start");

	const submitted = session.prompt("parked before disposal");
	session.beginDispose();
	releaseHook.resolve();

	await expect(withTimeout(submitted, 15_000, "Parked prompt did not settle")).rejects.toMatchObject({
		name: "PromptDroppedError",
		sessionDisposed: true,
	});
	await compacting;
	expect(requested).toHaveLength(2);
}, 30_000);

test("a queued follow-up submitted before disposal rejects instead of entering the queue", async () => {
	const manager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const providerEntered = Promise.withResolvers<void>();
	const mock = createMockModel({ responses: [{ content: ["held"], delayMs: 600_000 }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestModel, context, options) => {
			providerEntered.resolve();
			return mock.stream(requestModel, context, options);
		},
	});
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});
	const active = session.prompt("turn already running").catch(() => undefined);
	await withTimeout(providerEntered.promise, 15_000, "Active provider request did not start");

	const queued = session.prompt("submitted before disposal", { streamingBehavior: "followUp" });
	session.beginDispose();

	await expect(withTimeout(queued, 15_000, "Queued prompt did not settle")).rejects.toMatchObject({
		name: "PromptDroppedError",
		sessionDisposed: true,
	});
	expect(session.queuedMessageCount).toBe(0);
	await session.dispose();
	await active;
}, 30_000);

test("beginDispose sends no request for an accepted follow-up and steer, and dispose records both before session_exit", async () => {
	const sessionDir = path.join(tempDir.path(), "queued-at-disposal");
	const manager = SessionManager.create(sessionDir, sessionDir);
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const firstRequestStarted = Promise.withResolvers<void>();
	const releaseFirstRequest = Promise.withResolvers<void>();
	let requestCount = 0;
	const mock = createMockModel({
		handler: async () => {
			requestCount++;
			if (requestCount === 1) {
				firstRequestStarted.resolve();
				await releaseFirstRequest.promise;
				return { content: ["first response"] };
			}
			return { content: ["unexpected follow-up response"] };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const current = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});
	session = current;

	const running = current.prompt("turn already running");
	await withTimeout(firstRequestStarted.promise, 15_000, "First provider request did not start");
	await current.followUp("follow-up queued before disposal");
	await current.steer("steer queued before disposal");
	expect(current.queuedMessageCount).toBe(2);

	current.beginDispose();
	releaseFirstRequest.resolve();
	await withTimeout(running, 15_000, "First prompt did not settle");
	await current.dispose();

	// The continuing turn sent nothing for them...
	expect(requestCount).toBe(1);
	// ...and both were accepted, so the transcript keeps them: after the turn they waited for,
	// ahead of the exit marker.
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const reopened = await SessionManager.open(sessionFile, sessionDir);
	const entries = reopened.getEntries();
	await reopened.close();
	const shape = entries.flatMap(entry => {
		if (entry.type === "custom" && entry.customType === "session_exit") return ["session_exit"];
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") return [];
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(part => ("text" in part ? part.text : "")).join("");
		return [`${message.role}:${text}`];
	});
	expect(shape).toEqual([
		"user:turn already running",
		"assistant:first response",
		"user:steer queued before disposal",
		"user:follow-up queued before disposal",
		"session_exit",
	]);
}, 30_000);

test("a follow-up submitted after beginDispose reaches one later model request", async () => {
	const manager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const firstRequestStarted = Promise.withResolvers<void>();
	const releaseFirstRequest = Promise.withResolvers<void>();
	let requestCount = 0;
	const mock = createMockModel({
		handler: async () => {
			requestCount++;
			if (requestCount === 1) {
				firstRequestStarted.resolve();
				await releaseFirstRequest.promise;
				return { content: ["first response"] };
			}
			return { content: ["follow-up response"] };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});

	const running = session.prompt("turn already running");
	await withTimeout(firstRequestStarted.promise, 15_000, "First provider request did not start");
	session.beginDispose();
	await session.followUp("queued after disposal");
	expect(session.queuedMessageCount).toBe(1);
	releaseFirstRequest.resolve();

	await withTimeout(running, 15_000, "Post-disposal follow-up did not settle");
	expect(requestCount).toBe(2);
}, 30_000);

test("dispose does not re-abort a prompt admitted after beginDispose", async () => {
	const manager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const beforeAgentStart = Promise.withResolvers<void>();
	const releaseBeforeAgentStart = Promise.withResolvers<void>();
	const shutdownStarted = Promise.withResolvers<void>();
	const releaseShutdown = Promise.withResolvers<void>();
	const providerStarted = Promise.withResolvers<void>();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", async () => {
				beforeAgentStart.resolve();
				await releaseBeforeAgentStart.promise;
			});
			pi.on("session_shutdown", async () => {
				shutdownStarted.resolve();
				await releaseShutdown.promise;
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"post-disposal-prompt",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, registry);
	const mock = createMockModel({
		handler: async () => {
			providerStarted.resolve();
			return { content: ["held"], delayMs: 600_000 };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		extensionRunner,
	});

	session.beginDispose();
	const prompt = session.prompt("submitted after disposal");
	await withTimeout(beforeAgentStart.promise, 15_000, "Post-disposal prompt did not enter setup");
	const closing = session.dispose();
	try {
		await withTimeout(shutdownStarted.promise, 15_000, "session_shutdown did not start");
		releaseBeforeAgentStart.resolve();
		await withTimeout(providerStarted.promise, 15_000, "Post-disposal prompt did not reach the provider");
		expect(mock.calls).toHaveLength(1);
	} finally {
		releaseBeforeAgentStart.resolve();
		releaseShutdown.resolve();
		await closing;
		await prompt.catch(() => undefined);
	}
}, 30_000);

/** A session whose provider requests are counted; `hold` keeps the first one streaming until aborted. */
function createCountingSession(options: { hold?: boolean } = {}) {
	const manager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const providerEntered = Promise.withResolvers<void>();
	const requested: string[] = [];
	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestModel, context, streamOptions) => {
			requested.push(requestModel.id);
			mock.push(options.hold ? { content: ["held"], delayMs: 600_000 } : { content: ["done"] });
			providerEntered.resolve();
			return mock.stream(requestModel, context, streamOptions);
		},
	});
	const created = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});
	session = created;
	return { session: created, manager, requested, providerEntered: providerEntered.promise };
}

test("a steer submitted before disposal rejects instead of entering the running turn's queue", async () => {
	const { session: active, providerEntered } = createCountingSession({ hold: true });
	const running = active.prompt("turn already running").catch(() => undefined);
	await withTimeout(providerEntered, 15_000, "Active provider request did not start");

	const steering = active.steer("submitted before disposal");
	active.beginDispose();

	await expect(steering).rejects.toMatchObject({ name: "PromptDroppedError", sessionDisposed: true });
	expect(active.queuedMessageCount).toBe(0);
	await active.dispose();
	await running;
}, 30_000);

test("a custom prompt submitted before disposal resolves false and sends nothing", async () => {
	const { session: active, requested } = createCountingSession();

	const submitted = active.promptCustomMessage({
		customType: "disposal-probe",
		content: "a skill prompt submitted before disposal",
		display: false,
		attribution: "user",
	});
	active.beginDispose();

	expect(await submitted).toBe(false);
	expect(requested).toEqual([]);
}, 30_000);

test("a custom message submitted before disposal appends no entry", async () => {
	const { session: active, manager } = createCountingSession();

	const sent = active.sendCustomMessage({ customType: "disposal-probe", content: "late note", display: false });
	active.beginDispose();

	expect(await sent).toBe(false);
	expect(manager.getEntries()).toEqual([]);
}, 30_000);

// A custom message submitted while the session is live waits on several awaits before its turn
// starts (the context-replacement wait, image normalization, the usage preflight). Disposal that
// begins at any of them leaves it no turn and no entry. Each run begins disposal one microtask
// later, until a run finds the turn already started: that turn is the running-turn exception.
for (const delivery of ["triggerTurn", "nextTurn", "aside"] as const) {
	test(`a ${delivery} custom message submitted before disposal starts no turn at any await before dispatch`, async () => {
		let reachedDispatch = false;
		for (let ticks = 0; ticks < 40 && !reachedDispatch; ticks++) {
			const { session: active, manager, requested } = createCountingSession();
			try {
				const sent = active.sendCustomMessage(
					{ customType: "disposal-sweep", content: "submitted while live", display: true },
					delivery === "triggerTurn"
						? { triggerTurn: true }
						: delivery === "nextTurn"
							? { deliverAs: "nextTurn", triggerTurn: true }
							: { deliverAs: "aside" },
				);
				for (let i = 0; i < ticks; i++) await Promise.resolve();
				if (requested.length > 0 || active.agent.state.isStreaming) {
					reachedDispatch = true;
					await sent;
					continue;
				}
				const entriesBefore = manager.getEntries().length;
				active.beginDispose();

				expect(await sent).toBe(false);
				expect(requested).toEqual([]);
				expect(manager.getEntries().slice(entriesBefore)).toEqual([]);
			} finally {
				await active.dispose();
			}
		}
		expect(reachedDispatch).toBe(true);
	}, 60_000);
}
