import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, AssistantMessage, AssistantRetryRecovery, Model, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

type RecoveryRun = {
	session: AgentSession;
	sessionManager: SessionManager;
	retryEndEvents: AutoRetryEndEvent[];
	requestedKeys: string[];
};

const RATE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
const SOCKET_CLOSE_MID_STREAM =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";
const CODEX_STEER_REJECTION =
	"Codex error event: The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. Start a new independent response.create turn instead. (code=unsupported_native_inflight_message)";
/** A gateway's own chunked-transfer diagnostic for a cut SSE body — no HTTP status. */
const TRANSFER_ENCODING_CUT = "TransferEncodingError: the chunked response body ended before its terminating chunk";
/** A gateway 5xx raised before the request ever reached a model. */
const GATEWAY_KEY_LOOKUP_500 = "500 Internal Server Error: key lookup did not answer within 10s";
const RATE_LIMIT_429 = "429 Too Many Requests: rate limit exceeded";
const OVERLOADED_529 = "529 Overloaded";
/** A gateway naming its upstream's throttle beside its own wire diagnostic — no HTTP status. */
const THROTTLE_WITH_WIRE_WORDING = "TooManyRequests: upstream closed the connection";
/** What the Anthropic client reports once its own provider retries are spent. */
const PROVIDER_CONNECTION_ERROR = "Connection error.";
/**
 * Envoy's own diagnostic for an upstream that never answered. It reads as both
 * a wire failure and a timeout, which is what makes it test the timeout
 * exclusion rather than pass because no flag was set at all.
 */
const ENVOY_CONNECTION_TIMEOUT =
	"upstream connect error or disconnect/reset before headers. reset reason: connection timeout";
/** An HTTP/2 peer reset as a gateway forwards it — a cut stream with no status line. */
const HTTP2_STREAM_RESET = "Stream closed with error code NGHTTP2_INTERNAL_ERROR";
/** A Codex failure event whose code and prose its own loop declines to replay. */
const CODEX_UNREPLAYED_WIRE_EVENT = "Codex error event: read ECONNRESET (code=api_error)";
/** A Codex failure event its loop replays before surfacing it. */
const CODEX_REPLAYED_EVENT = "Codex error event: stream failed (code=model_error)";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function retryRecovery(recovery: AssistantRetryRecovery["recovery"], note: string): AssistantRetryRecovery {
	return {
		kind: "auto-retry",
		status: "recovered",
		attempt: 1,
		recoveredAt: "2026-07-04T00:00:00.000Z",
		recovery,
		note,
	};
}

function resolveInitialApiKey(apiKey: ApiKey | undefined): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	const bearer =
		typeof resolved === "string" ? resolved : resolved && "apiKey" in resolved ? resolved.apiKey : undefined;
	if (typeof bearer !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return bearer;
}

interface AssistantEntry {
	entry: SessionMessageEntry;
	message: AssistantMessage;
}

function assistantEntries(sessionManager: SessionManager): AssistantEntry[] {
	const result: AssistantEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		result.push({ entry, message });
	}
	return result;
}

function recoveredAssistantEntry(sessionManager: SessionManager): AssistantEntry {
	const found = assistantEntries(sessionManager).find(
		candidate => candidate.message.retryRecovery?.status === "recovered",
	);
	if (!found) {
		throw new Error("Expected a recovered assistant entry");
	}
	return found;
}

function successfulAssistantEntry(sessionManager: SessionManager, text: string): AssistantEntry {
	const found = assistantEntries(sessionManager).find(candidate =>
		candidate.message.content.some(block => block.type === "text" && block.text === text),
	);
	if (!found) {
		throw new Error(`Expected successful assistant entry containing ${text}`);
	}
	return found;
}

describe("AgentSession retry recovery", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-retry-recovery-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-recovery-");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.credentials.remove("anthropic");
		authStorage.keys.removeRuntime("anthropic");
		modelRegistry.clearSuppressedSelectors();
		sessions = [];
		managers = [];
	});

	afterEach(async () => {
		for (const activeSession of sessions.splice(0).reverse()) {
			await activeSession.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	async function runCredentialRecovery(): Promise<RecoveryRun> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.keys.removeRuntime("anthropic");
		await authStorage.credentials.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const mock = createMockModel();
		const requestedKeys: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: RATE_LIMIT_ERROR });
				} else {
					mock.push({ content: ["recovered after credential switch"], stopReason: "stop" });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);

		mockSchedulerWaitWithClock();
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit recovery");
		await session.waitForIdle();
		await sessionManager.flush();

		return { session, sessionManager, retryEndEvents, requestedKeys };
	}

	it("waitForIdle waits for retry recovery event delivery", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { content: ["Recovered after retry."], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
				"features.unexpectedStopDetection": "none",
			}),
			modelRegistry,
		});
		sessions.push(session);
		mockSchedulerWaitWithClock();

		const rewriteStarted = Promise.withResolvers<void>();
		const resumeRewrite = Promise.withResolvers<void>();
		const rewriteEntries = sessionManager.rewriteEntries.bind(sessionManager);
		vi.spyOn(sessionManager, "rewriteEntries").mockImplementation(async () => {
			rewriteStarted.resolve();
			await resumeRewrite.promise;
			await rewriteEntries();
		});
		const retryEndEvents: AutoRetryEndEvent[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		let idleResolved = false;
		const completion = (async () => {
			await session.prompt("Recover from the transient failure.");
			await session.waitForIdle();
			idleResolved = true;
			unsubscribe();
		})();

		try {
			await Promise.race([rewriteStarted.promise, completion]);
			// Drain runnable work without releasing the recovery persistence gate.
			const nextImmediate = Promise.withResolvers<void>();
			setImmediate(nextImmediate.resolve);
			await nextImmediate.promise;
			expect(idleResolved).toBe(false);
			expect(retryEndEvents).toEqual([]);
		} finally {
			resumeRewrite.resolve();
			try {
				await completion;
			} finally {
				unsubscribe();
			}
		}

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
	});

	it("marks a recovered retry error, emits it, persists it, and excludes only model-context replay", async () => {
		const { sessionManager, retryEndEvents, requestedKeys } = await runCredentialRecovery();

		expect(new Set(requestedKeys)).toEqual(new Set(["anthropic-key-1", "anthropic-key-2"]));
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(retryEndEvents[0].retryErrors).toHaveLength(1);

		const recoveredEntry = recoveredAssistantEntry(sessionManager);
		const successfulEntry = successfulAssistantEntry(sessionManager, "recovered after credential switch");
		const recoveredEvent = retryEndEvents[0].retryErrors?.[0];
		if (!recoveredEvent) {
			throw new Error("Expected a recovered error payload on auto_retry_end");
		}
		const recoveredMarker = recoveredEntry.message.retryRecovery;
		if (recoveredMarker?.status !== "recovered") {
			throw new Error("Expected recovered marker on superseded assistant message");
		}
		expect(recoveredEvent.entryId).toBe(recoveredEntry.entry.id);
		expect(recoveredEvent.persistenceKey).toBeString();
		expect(recoveredEvent.note).toBe("rate-limited; switched account; retried");
		expect(recoveredEvent.retryRecovery).toEqual(recoveredMarker);
		expect(recoveredEntry.message.stopReason).toBe("error");
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recovery: "credential",
			note: "rate-limited; switched account; retried",
			supersededBy: {
				provider: successfulEntry.message.provider,
				model: successfulEntry.message.model,
				timestamp: successfulEntry.message.timestamp,
			},
		});
		expect(Date.parse(recoveredMarker.recoveredAt)).not.toBeNaN();

		const modelContext = sessionManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});

		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(transcriptContext.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
		expect(
			transcriptContext.messages.some(
				message => message.role === "assistant" && message.retryRecovery?.status === "recovered",
			),
		).toBe(true);
	});

	it("waits through a local busy overlap before continuing an automatic retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: RETRIABLE_SERVER_ERROR },
				{ content: ["recovered after local overlap"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const continueAgent = agent.continue.bind(agent);
		let continueCalls = 0;
		const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async signal => {
			continueCalls++;
			if (continueCalls === 1) throw new AgentBusyError();
			await continueAgent(signal);
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		mockSchedulerWaitWithClock();
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Recover after a local continuation overlap");
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(2);
		expect(mock.calls).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const last = session.agent.state.messages.at(-1);
		expect(last).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered after local overlap" }],
		});
	});

	it("does not issue another provider request when a retry races session abort", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { content: ["resumed on request"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 4,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		sessions.push(session);
		mockSchedulerWaitWithClock();
		const abortCompleted = Promise.withResolvers<void>();
		const unsubscribeAbort = agent.subscribe(event => {
			if (event.type === "agent_end") {
				void session.abort().then(abortCompleted.resolve, abortCompleted.reject);
			}
		});

		await session.prompt("Stop after the provider failure");
		await abortCompleted.promise;
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		unsubscribeAbort();
		await session.prompt("Resume explicitly after abort");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "resumed on request" }],
		});
	});

	it("collapses exhausted retries into one terminal error naming the spent budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { throw: RETRIABLE_SERVER_ERROR }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		mockSchedulerWaitWithClock();
		vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Exhaust retry attempts");
		await session.waitForIdle();
		await sessionManager.flush();

		expect(mock.calls).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(retryEndEvents[0].retryErrors).toHaveLength(1);
		expect(retryEndEvents[0].retryErrors?.[0].retryRecovery).toMatchObject({
			status: "superseded",
			attempt: 1,
		});

		const errors = assistantEntries(sessionManager).filter(candidate => candidate.message.stopReason === "error");
		expect(errors).toHaveLength(2);
		expect(errors[0].message.retryRecovery).toMatchObject({ status: "superseded", attempt: 1 });
		expect(resolveAssistantErrorPresentation(errors[0].message)).toEqual({ kind: "none" });

		const terminalError = errors[1].message;
		const terminalErrorText = terminalError.errorMessage;
		if (!terminalErrorText) {
			throw new Error("Expected an aggregated terminal error message");
		}
		expect(terminalError.retryRecovery).toBeUndefined();
		expect(terminalErrorText).toBe(`Retry budget exhausted after 1 retry: ${RETRIABLE_SERVER_ERROR}`);
		expect(resolveAssistantErrorPresentation(terminalError)).toEqual({
			kind: "full",
			text: terminalErrorText,
			isError: true,
		});

		const visibleErrors = errors
			.map(candidate => resolveAssistantErrorPresentation(candidate.message))
			.filter(presentation => presentation.kind !== "none");
		expect(visibleErrors).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages.map(message => message.role)).toEqual(["user"]);
	});
	/**
	 * Runs one prompt against a primary model with a fallback chain — `fallback`
	 * first, then each of `models.rest` — scripting each provider attempt in
	 * order. Returns the model each request went to and the fallback switches
	 * the session announced.
	 */
	async function runFallbackChainRecovery(
		responses: MockResponse[],
		maxRetries = 2,
		models: { primary: Model; fallback: Model; rest?: Model[] } = {
			primary: getBundledModel("anthropic", "claude-sonnet-4-5"),
			fallback: getBundledModel("openai", "gpt-5.5"),
		},
		retryDelays: { baseDelayMs?: number; maxDelayMs?: number } = {},
		/** Called once the session exists, before the prompt: lets a test act on its events. */
		onSession?: (session: AgentSession, agent: Agent) => void,
	): Promise<{
		primary: string;
		fallback: string;
		requestedModels: string[];
		fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>>;
		sessionManager: SessionManager;
		retryStartDelaysMs: number[];
	}> {
		const { primary: model, fallback: fallbackModel, rest = [] } = models;
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled primary and fallback test models to exist");
		}
		authStorage.keys.setRuntime(model.provider, `${model.provider}-test-key`);
		authStorage.keys.setRuntime(fallbackModel.provider, `${fallbackModel.provider}-test-key`);
		for (const entry of rest) authStorage.keys.setRuntime(entry.provider, `${entry.provider}-test-key`);
		const primary = `${model.provider}/${model.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": retryDelays.baseDelayMs ?? 5,
			"retry.maxDelayMs": retryDelays.maxDelayMs ?? 100,
			"retry.maxRetries": maxRetries,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [fallback, ...rest.map(entry => `${entry.provider}/${entry.id}`)],
			},
		});
		settings.setModelRole("default", primary);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		managers.push(sessionManager);
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);
		mockSchedulerWaitWithClock();
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryStartDelaysMs: number[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
			if (event.type === "auto_retry_start") retryStartDelaysMs.push(event.delayMs);
		});
		onSession?.(session, agent);

		await session.prompt("Trigger a socket drop");
		await session.waitForIdle();
		await sessionManager.flush();
		return { primary, fallback, requestedModels, fallbackEvents, sessionManager, retryStartDelaysMs };
	}

	/**
	 * A cut after reasoning streamed, on a request the provider reports it put
	 * on the wire exactly once — the one shape that earns the same-model hold.
	 */
	const droppedAfterThinking: MockResponse = {
		content: [{ type: "thinking", thinking: "partial plan for the edit" }],
		stopReason: "error",
		errorMessage: SOCKET_CLOSE_MID_STREAM,
		providerReplays: 0,
	};

	it("retries a mid-stream socket drop on the same model before consulting the fallback chain", async () => {
		// The transport died after the model had already emitted reasoning, and
		// the provider reports a single request, so the failure says nothing about
		// model health: the first attempt stays on the primary instead of
		// switching to the fallback chain.
		const { primary, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery([
			droppedAfterThinking,
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
		successfulAssistantEntry(sessionManager, "recovered on the same model");
		const errors = assistantEntries(sessionManager).filter(candidate => candidate.message.stopReason === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message.retryRecovery).toMatchObject({ recovery: "plain", note: "error; retried" });
	});

	it.each<[string, MockResponse]>([
		["reasoning streamed before the socket closed", { ...droppedAfterThinking, providerReplays: undefined }],
		[
			"a block opened and died before its first delta",
			{ content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: SOCKET_CLOSE_MID_STREAM },
		],
		[
			"a cut chunked transfer after reasoning",
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: TRANSFER_ENCODING_CUT,
			},
		],
		["a contentless diagnostic no provider loop retries", { stopReason: "error", errorMessage: "premature close" }],
		[
			"a contentless failure event whose code the Codex loop declines",
			{ stopReason: "error", errorMessage: CODEX_UNREPLAYED_WIRE_EVENT },
		],
		[
			"a contentless failure event whose code the Codex loop replays",
			{ stopReason: "error", errorMessage: CODEX_REPLAYED_EVENT },
		],
	])("advances the fallback chain at once for an unreported wire failure: %s", async (_label, failure) => {
		// A provider that does not report `providerReplays` has said nothing about
		// how often the request went out, and nothing is not one. The OpenAI
		// completions route is the measured case: `fetchWithRetry` replayed a 503,
		// the replay then streamed and died, and the message it surfaced carries
		// content, a wording no provider loop retries, and no count. Reading the
		// content or the wording as "sent once" sent the identical body six times
		// where the chain needed two.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			failure,
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("spends at most two held retries per recovery, across every model the chain tries", async () => {
		// The hold is bounded by the recovery, not by the model: a fallback that
		// the spent retry budget hands a fresh budget does not get two more held
		// retries of its own. Without the bound every chain entry reached that way
		// re-opens the hold, so the added delay grows with the length of the chain.
		const next = getBundledModel("google", "gemini-2.5-flash");
		const { primary, fallback, requestedModels } = await runFallbackChainRecovery(
			[
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				{ content: ["recovered on the second fallback"], stopReason: "stop" },
			],
			2,
			{
				primary: getBundledModel("anthropic", "claude-sonnet-4-5"),
				fallback: getBundledModel("openai", "gpt-5.5"),
				rest: [next],
			},
		);

		// Two held retries on the primary; its third failure spends the budget and
		// walks to the first fallback, whose own failure walks on at once.
		expect(requestedModels).toEqual([primary, primary, primary, fallback, `${next.provider}/${next.id}`]);
	});

	it.each([
		["two retry-after-ms values", "retry-after-ms=200 retry-after-ms=9000"],
		["two try-again durations", "try again in 200ms; try again in 9000ms"],
	])("declines the hold for the longest of %s, not the first", async (_label, hints) => {
		// The wait that counts is the longest the message names: a resend inside
		// a window the server said is closed fails again. Reading the first
		// occurrence held 250 ms and resent where the 9 s hint should decline.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { primary, fallback, requestedModels, retryStartDelaysMs } = await runFallbackChainRecovery(
			[
				{ ...droppedAfterThinking, errorMessage: `${SOCKET_CLOSE_MID_STREAM} ${hints}` },
				{ content: ["recovered on fallback"], stopReason: "stop" },
			],
			2,
			undefined,
			{ baseDelayMs: 500, maxDelayMs: 20_000 },
		);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(retryStartDelaysMs).toEqual([0]);
	});

	it("does not hold when the provider's retry hint is longer than the held window", async () => {
		// The held sleep is bounded by the full-jitter window, `base × 2^(k-1)`
		// for the k-th hold. A provider hint is never shortened, so a hint past
		// that window means the hold cannot keep its bound: consult the chain.
		// Honouring a 9 s hint twice slept 18 s on a feature promised under 1.5 s.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { primary, fallback, requestedModels, retryStartDelaysMs } = await runFallbackChainRecovery(
			[
				{ ...droppedAfterThinking, errorMessage: `${SOCKET_CLOSE_MID_STREAM} retry-after-ms=900` },
				{ content: ["recovered on fallback"], stopReason: "stop" },
			],
			2,
			undefined,
			{ baseDelayMs: 500, maxDelayMs: 10_000 },
		);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(retryStartDelaysMs).toEqual([0]);
	});

	it("honours a provider hint that fits inside the held window", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { primary, requestedModels, retryStartDelaysMs } = await runFallbackChainRecovery(
			[
				{ ...droppedAfterThinking, errorMessage: `${SOCKET_CLOSE_MID_STREAM} retry-after-ms=400` },
				{ content: ["recovered on the same model"], stopReason: "stop" },
			],
			2,
			undefined,
			{ baseDelayMs: 500, maxDelayMs: 10_000 },
		);

		expect(requestedModels).toEqual([primary, primary]);
		expect(retryStartDelaysMs).toEqual([400]);
	});

	it.each([
		["the first held window", 600, [600]],
		["the second held window", 500, [400, 1000]],
		["the 8 s cap", 8000, [8000]],
	] as [string, number, number[]][])("does not hold a hint exactly at %s", async (_label, baseDelayMs, hintsMs) => {
		// The window is half-open, `[0, min(base × 2^(k-1), 8 s))`: full jitter
		// never reaches its upper end, and neither may a hint. Holding at it
		// scheduled exactly 1.5 s at the default base and exactly 16 s at the
		// cap, against a promise of strictly under.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { primary, fallback, requestedModels, retryStartDelaysMs } = await runFallbackChainRecovery(
			[
				...hintsMs.map(hint => ({
					...droppedAfterThinking,
					errorMessage: `${SOCKET_CLOSE_MID_STREAM} retry-after-ms=${hint}`,
				})),
				{ content: ["recovered on fallback"], stopReason: "stop" },
			],
			2,
			undefined,
			{ baseDelayMs, maxDelayMs: 20_000 },
		);

		// Every hint inside its window is held and slept as given; the one at its
		// window's end consults the chain, which zeroes the wait.
		expect(requestedModels).toEqual([...hintsMs.slice(0, -1).map(() => primary), primary, fallback]);
		expect(retryStartDelaysMs).toEqual([...hintsMs.slice(0, -1), 0]);
		expect(retryStartDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBeLessThan(
			Math.min(baseDelayMs, 8000) + Math.min(2 * baseDelayMs, 8000),
		);
	});

	it.each([
		["from an auto_retry_start listener, before any wait is installed", "retry-start", 1],
		["at the fallback switch, before the switched request is sent", "fallback-applied", 2],
		["while the held request is on the wire, as it reports its replays", "replay-report", 2],
	] as const)("ends the recovery when abortRetry() lands %s", async (_label, moment, requestsSent) => {
		// Cancellation is a property of the recovery, not of the moment: whichever
		// point the saga reaches next — the check after it announces a retry, the
		// one after a wait, or the failure of a request already on the wire —
		// ends it as cancelled. Read only at the backoff sleep, a call from an
		// `auto_retry_start` listener let 14 more requests through, and a call
		// as the held request reported its replays let the chain run on.
		const models = {
			primary: getBundledModel("anthropic", "claude-sonnet-4-5"),
			fallback: getBundledModel("openai", "gpt-5.5"),
			rest: [getBundledModel("google", "gemini-2.5-flash"), getBundledModel("openai", "gpt-4o")],
		};
		let aborted = false;
		const retryEnds: (string | undefined)[] = [];
		const { requestedModels } = await runFallbackChainRecovery(
			[
				droppedAfterThinking,
				{ ...droppedAfterThinking, providerReplays: 10 },
				droppedAfterThinking,
				droppedAfterThinking,
				{ content: ["recovered on the last fallback"], stopReason: "stop" },
			],
			2,
			models,
			{},
			(session, agent) => {
				const cancel = () => {
					if (aborted) return;
					aborted = true;
					session.abortRetry();
				};
				session.subscribe(event => {
					if (event.type === "auto_retry_end") retryEnds.push(event.finalError);
					if (moment === "retry-start" && event.type === "auto_retry_start") cancel();
					if (moment === "fallback-applied" && event.type === "retry_fallback_applied") cancel();
				});
				agent.subscribe(event => {
					if (
						moment === "replay-report" &&
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						(event.message.providerReplays ?? 0) > 0
					) {
						cancel();
					}
				});
			},
		);

		expect(aborted).toBe(true);
		expect(requestedModels).toHaveLength(requestsSent);
		expect(retryEnds).toEqual(["Retry cancelled"]);
	});

	it("remembers nothing from an abortRetry() made with no retry in progress", async () => {
		// Outside a saga there is nothing to cancel; the next recovery must not
		// start out cancelled.
		const { primary, requestedModels } = await runFallbackChainRecovery(
			[droppedAfterThinking, { content: ["recovered on the same model"], stopReason: "stop" }],
			2,
			undefined,
			{},
			session => session.abortRetry(),
		);

		expect(requestedModels).toEqual([primary, primary]);
	});

	it("stops holding for the rest of the recovery once a held retry reports a replay", async () => {
		// The held retry on the primary spent the provider's own budget and says
		// so. A later model reached on a fresh retry budget must not hold again:
		// that would let a second held call spend a second provider budget.
		const models = {
			primary: getBundledModel("anthropic", "claude-sonnet-4-5"),
			fallback: getBundledModel("openai", "gpt-5.5"),
			rest: [getBundledModel("google", "gemini-2.5-flash"), getBundledModel("openai", "gpt-4o")],
		};
		const [third, fourth] = models.rest.map(entry => `${entry.provider}/${entry.id}`);
		const { primary, fallback, requestedModels } = await runFallbackChainRecovery(
			[
				droppedAfterThinking,
				{ ...droppedAfterThinking, providerReplays: 10 },
				droppedAfterThinking,
				droppedAfterThinking,
				{ content: ["recovered on the last fallback"], stopReason: "stop" },
			],
			2,
			models,
		);

		// Held once on the primary; its held retry reports ten replays and walks
		// on. The first fallback spends the budget; the second, on a fresh one,
		// walks on at once instead of holding.
		expect(requestedModels).toEqual([primary, primary, fallback, third, fourth]);
	});

	it("keeps a repeated wire failure on the same model for two retries, then consults the fallback chain", async () => {
		// The same-model hold is bounded: a third drop falls through to the chain
		// rather than keep retrying the primary for ever.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			droppedAfterThinking,
			droppedAfterThinking,
			droppedAfterThinking,
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary, primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("still consults the fallback chain when no same-model retry is left", async () => {
		// With `retry.maxRetries: 0` the first attempt is already over budget, so the
		// chain is the only recovery: the socket-drop gate must not suppress it.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery(
			[droppedAfterThinking, { content: ["recovered on fallback"], stopReason: "stop" }],
			0,
		);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("keeps the immediate fallback for a wire failure the provider loop already replayed", async () => {
		// Nothing streamed, so the Anthropic loop replayed this request on its own
		// budget and says so: ten replays. Holding the chain here would run that
		// loop again, so the first attempt still switches.
		const { primary, fallback, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery([
			{ stopReason: "error", errorMessage: SOCKET_CLOSE_MID_STREAM, providerReplays: 10 },
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
		successfulAssistantEntry(sessionManager, "recovered on fallback");
	});

	it("keeps the immediate fallback for a provider connection error wrapping a wire cause", async () => {
		// `Connection error.` is what the Anthropic client reports once its own
		// ten provider retries are spent; the wire wording rides in on the
		// cause. The chain must not wait behind a request already replayed.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{ stopReason: "error", errorMessage: PROVIDER_CONNECTION_ERROR, providerReplays: 10 },
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("retries a cut chunked transfer on the same model instead of advancing the chain", async () => {
		// A gateway relaying SSE reports its own transfer-encoding diagnostic
		// rather than the runtime's socket wording. Before this was classified
		// the wording matched no transport pattern, so the turn advanced the
		// chain on the first failure instead of replaying a route that works —
		// even with the provider reporting it sent the request once.
		const { primary, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: TRANSFER_ENCODING_CUT,
				providerReplays: 0,
			},
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
		successfulAssistantEntry(sessionManager, "recovered on the same model");
	});

	it("advances the fallback chain at once for a timeout that streamed reasoning", async () => {
		// A held replay of a timeout costs a whole first-event window each, so
		// the timeout exclusion must hold even where every other condition of
		// the hold is met, a reported single request included.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: ENVOY_CONNECTION_TIMEOUT,
				providerReplays: 0,
			},
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("waits a full-jitter backoff on a held retry, not the narrow band", async () => {
		// With `Math.random()` pinned at 0, full jitter is 0ms while the usual
		// 0.75-1.0 band is the whole capped delay. A fleet cut together must be
		// able to land anywhere in the window, not only in its last quarter.
		vi.spyOn(Math, "random").mockReturnValue(0);
		const { requestedModels, primary, retryStartDelaysMs } = await runFallbackChainRecovery([
			droppedAfterThinking,
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(retryStartDelaysMs).toEqual([0]);
	});

	it("consults the fallback chain when the delay cap would refuse the held retry", async () => {
		// A `retry.maxDelayMs` below the backoff base makes the held same-model
		// retry impossible: the fail-fast branch ends the turn because neither
		// model nor credential switched. Holding would spend the turn's only
		// chain consult on a retry the cap then refuses, so the session dies with
		// a healthy fallback untried. With random pinned at 0.9 the held wait is
		// 900ms against a 100ms cap.
		vi.spyOn(Math, "random").mockReturnValue(0.9);
		const { primary, fallback, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery(
			[
				{
					content: [{ type: "thinking", thinking: "partial plan for the edit" }],
					stopReason: "error",
					errorMessage: TRANSFER_ENCODING_CUT,
					providerReplays: 0,
				},
				{ content: ["recovered on fallback"], stopReason: "stop" },
			],
			2,
			undefined,
			{ baseDelayMs: 1000, maxDelayMs: 100 },
		);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
		successfulAssistantEntry(sessionManager, "recovered on fallback");
	});

	it("consults the fallback chain when the provider's own wait would refuse the held retry", async () => {
		// The held wait is not the jittered backoff alone: with no usage-limit
		// wait in play, a longer provider hint replaces it before the fail-fast
		// cap measures it. Testing the hold against the backoff alone passes a
		// 20s hint under a 100ms cap, suppresses the chain, and then ends the
		// turn on the cap with the fallback never asked.
		const { primary, fallback, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: `${SOCKET_CLOSE_MID_STREAM} retry-after-ms=20000`,
				providerReplays: 0,
			},
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
		successfulAssistantEntry(sessionManager, "recovered on fallback");
	});

	it("advances the chain when the provider reports replays it already spent", async () => {
		// The Codex loop replays an empty reasoning start on its own budget, so
		// the opened block it leaves behind is not evidence that the request was
		// made once. Reading the block instead of the reported count held three
		// more attempts on top of three six-request provider loops.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "" }],
				stopReason: "error",
				errorMessage: CODEX_UNREPLAYED_WIRE_EVENT,
				providerReplays: 5,
			},
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("holds the chain when the provider reports the request went out exactly once", async () => {
		// Same opened block and same wording, but the loop below reports it
		// never replayed, so the held same-model retry is the first replay this
		// request gets rather than the seventh.
		const { primary, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "" }],
				stopReason: "error",
				errorMessage: CODEX_UNREPLAYED_WIRE_EVENT,
				providerReplays: 0,
			},
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
	});

	it("holds the chain on a reported zero whose wording a provider loop would retry", async () => {
		// Nothing streamed and the wording is one the loops below do replay, but
		// the layer that would have done it reports that this request went out
		// exactly once. The count decides, not the wording.
		const { primary, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{ stopReason: "error", errorMessage: SOCKET_CLOSE_MID_STREAM, providerReplays: 0 },
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
	});

	it("holds the chain for an HTTP/2 peer reset that streamed reasoning", async () => {
		// A forwarded `NGHTTP2_INTERNAL_ERROR` is a cut stream with no status
		// line, the same family as the resets turn recovery already recognises.
		const { primary, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: HTTP2_STREAM_RESET,
				providerReplays: 0,
			},
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
	});

	it.each([7, 429, 503, 529])("holds the chain for a Go h2 stream error on stream %d", async streamId => {
		// Go's `stream error: stream ID N` carries no status line; the stream
		// number is not one. Read as a 429, 503 or 529 it vetoed the hold for
		// those three stream numbers alone, on a failure otherwise identical to 7.
		const { primary, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: `stream error: stream ID ${streamId}; INTERNAL_ERROR; received from peer`,
				providerReplays: 0,
			},
			{ content: ["recovered on the same model"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
	});

	it("advances the fallback chain at once for an account-policy denial worded as a wire failure", async () => {
		// The denial is account-scoped and reproduces on replay; another
		// credential or another model is the recovery, not a third try here.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				errorMessage: "permission_error: socket is closed",
				providerReplays: 0,
			},
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("advances the fallback chain at once for a refusal worded as a wire failure", async () => {
		// A refusal reproduces on the same model however the stream then died.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{
				content: [{ type: "thinking", thinking: "partial plan for the edit" }],
				stopReason: "error",
				stopDetails: { type: "refusal" },
				errorMessage: "socket is closed",
				providerReplays: 0,
			},
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it.each([
		["a gateway 5xx raised before any model output", GATEWAY_KEY_LOOKUP_500],
		["a rate limit", RATE_LIMIT_429],
		["an overload", OVERLOADED_529],
		["a statusless throttle reported as the wire died", THROTTLE_WITH_WIRE_WORDING],
	])("advances the fallback chain on the first failure for %s", async (_label, errorMessage) => {
		// The first three carry a status, so the transport retry and the
		// provider's pre-output retry have already replayed the same model many
		// times. The fourth carries none, but names a cap the replay re-hits
		// while a chain entry may sit under a different one. None may hold the
		// chain, even on a reported single request.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery([
			{ stopReason: "error", errorMessage, providerReplays: 0 },
			{ content: ["recovered on fallback"], stopReason: "stop" },
		]);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("ends on the retry budget when the wire keeps failing past the chain", async () => {
		// The hold delays the chain, it does not replace the budget: once the
		// chain entry fails the same way the turn must terminate, not loop.
		const { primary, fallback, requestedModels } = await runFallbackChainRecovery(
			[
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
				droppedAfterThinking,
			],
			2,
		);

		// Three tries on the primary (two of them held), the chain's one entry and
		// one plain same-model retry on it — the saga spent its held retries on the
		// primary — then the spent budget ends the turn: eight scripted failures,
		// five requests.
		expect(requestedModels).toEqual([primary, primary, primary, fallback, fallback]);
	});

	const codexModels = {
		primary: getBundledModel("openai-codex", "gpt-6-astra"),
		fallback: getBundledModel("openai-codex", "gpt-6.1-sol"),
	};
	const steerRejectedAfterThinking: MockResponse = {
		content: [{ type: "thinking", thinking: "planning the next tool call" }],
		stopReason: "error",
		errorMessage: CODEX_STEER_REJECTION,
	};

	it("retries a Codex steering rejection on the same model instead of consulting the fallback chain", async () => {
		// Codex dropped the response because omp steered it mid-stream, after
		// reasoning had streamed. The provider already stopped steering the
		// session, so the primary replays cleanly; switching models fixes nothing.
		const { primary, requestedModels, fallbackEvents, sessionManager } = await runFallbackChainRecovery(
			[steerRejectedAfterThinking, { content: ["recovered on the same model"], stopReason: "stop" }],
			2,
			codexModels,
		);

		expect(requestedModels).toEqual([primary, primary]);
		expect(fallbackEvents).toEqual([]);
		successfulAssistantEntry(sessionManager, "recovered on the same model");
		const errors = assistantEntries(sessionManager).filter(candidate => candidate.message.stopReason === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message.retryRecovery).toMatchObject({ recovery: "plain" });
	});

	it("still consults the fallback chain for a Codex steering rejection when no same-model retry is left", async () => {
		// With `retry.maxRetries: 0` the chain is the only recovery left.
		const { primary, fallback, requestedModels, fallbackEvents } = await runFallbackChainRecovery(
			[steerRejectedAfterThinking, { content: ["recovered on fallback"], stopReason: "stop" }],
			0,
			codexModels,
		);

		expect(requestedModels).toEqual([primary, fallback]);
		expect(fallbackEvents).toHaveLength(1);
	});

	it("maps assistant error presentation for recovered, unrecovered, and silent abort turns", () => {
		const recoveredCases: Array<{
			name: string;
			recovery: AssistantRetryRecovery["recovery"];
			note: string;
		}> = [
			{ name: "credential", recovery: "credential", note: "rate-limited; switched account; retried" },
			{ name: "model", recovery: "model", note: "rate-limited; switched model; retried" },
			{ name: "wait", recovery: "wait", note: "rate-limited; waited; retried" },
			{ name: "plain", recovery: "plain", note: "error; retried" },
		];

		for (const testCase of recoveredCases) {
			expect(
				resolveAssistantErrorPresentation(
					assistantMessage({
						stopReason: "error",
						errorMessage: `${testCase.name} retry was superseded`,
						retryRecovery: retryRecovery(testCase.recovery, testCase.note),
					}),
				),
			).toEqual({ kind: "compact-recovered", text: testCase.note, isError: false });
		}

		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "error", errorMessage: "503 service unavailable" }),
			),
		).toEqual({ kind: "full", text: "503 service unavailable", isError: true });
		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "aborted", errorMessage: SILENT_ABORT_MARKER }),
			),
		).toEqual({ kind: "none" });
	});

	it("keeps recovered markers durable across session reload and still excludes them from model context", async () => {
		const { sessionManager } = await runCredentialRecovery();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected recovery run to persist a session file");
		}

		const reloadedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"), undefined, {
			suppressBreadcrumb: true,
		});
		managers.push(reloadedManager);
		const recoveredEntry = recoveredAssistantEntry(reloadedManager);
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			recovery: "credential",
			note: "rate-limited; switched account; retried",
		});

		const modelContext = reloadedManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});
	});
});
