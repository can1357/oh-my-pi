import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	Effort,
	type Message,
	type Model,
	type ModelUsageHealth,
	type ProviderSessionState,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { parseModelPattern, parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type ServingModel,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const FALLBACK_TEST_RETRY_AFTER_MS = 60_000;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function createFallbackAgent(
	primaryModel: Model,
	requestedModels: string[],
	options: { retryAfterMs?: number; firstError?: string | Error } = {},
): Agent {
	const retryAfterMs = options.retryAfterMs ?? FALLBACK_TEST_RETRY_AFTER_MS;
	const firstError = options.firstError ?? `rate limit exceeded retry-after-ms=${retryAfterMs}`;
	const mock = createMockModel();
	let primaryAttempts = 0;
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: {
			model: primaryModel,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === primaryModel.provider && model.id === primaryModel.id && primaryAttempts === 0) {
				primaryAttempts += 1;
				mock.push({ throw: firstError });
			} else {
				mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			}
			return mock.stream(model, context, options);
		},
	});
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A stream that terminates with a `ThinkingLoop`-flagged error, exactly as the
 *  loop guard aborts a repetitive reasoning stream (issue #8760). */
function thinkingLoopErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage:
				"Thinking loop detected: the model repeated near-identical content (4 near-identical segments within the last 16). Treating as a stream stall and retrying.",
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A stream that completes normally with a single text block. */
function recoveredTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}
function transportErrorAfterToolCallStream(
	model: Model<Api>,
	toolCall: ToolCall,
	thinkingSignature?: string,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const thinking =
			thinkingSignature === undefined
				? undefined
				: {
						type: "thinking" as const,
						thinking: "Signed reasoning before the tool call.",
						thinkingSignature,
					};
		if (thinking) partial.content.push(thinking);
		const toolCallIndex = partial.content.length;
		partial.content.push(toolCall);
		stream.push({ type: "start", partial });
		if (thinking) {
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		}
		stream.push({ type: "toolcall_start", contentIndex: toolCallIndex, partial });
		stream.push({
			type: "toolcall_delta",
			contentIndex: toolCallIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial,
		});
		stream.push({ type: "toolcall_end", contentIndex: toolCallIndex, toolCall, partial });
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...partial,
				stopReason: "error",
				errorMessage: "The socket connection was closed unexpectedly.",
				duration: 1000,
			},
		});
	});
	return stream;
}

describe("AgentSession retry fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sharedRegistry: ModelRegistry;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// The model registry is an immutable fixture whose construction builds a
	// canonical index over ~2.7k bundled models (~100ms). Build it (and the
	// auth DB) once for the whole file instead of per-test; reset only the
	// mutable retry-fallback cooldown state between tests.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		authStorage.setRuntimeApiKey("fireworks", "fireworks-test-key");
		authStorage.setRuntimeApiKey("google", "google-test-key");
		authStorage.setRuntimeApiKey("google-vertex", "google-vertex-test-key");
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		authStorage.setRuntimeApiKey("devin", "devin-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "openai-codex-test-key");
		sharedRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		// Reset to the shared registry (a few tests reassign it to a scoped
		// instance) and clear cooldown suppressions left by fallback-path tests
		// (default 5-minute suppression) so state never leaks between tests.
		modelRegistry = sharedRegistry;
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("advances through a role-keyed fallback chain across retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const requestedContexts: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				requestedContexts.push(JSON.stringify(context));
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "service unavailable: 503 overloaded" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on second fallback"] });
				} else {
					throw new Error(`Unexpected model requested during retry fallback test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(new Set(requestedContexts).size).toBe(1);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 0]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 2 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
	});

	it("hops to the chain owned by a fallback that is the last entry of the chain it came from", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "503 Hosted inference is temporarily unavailable" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on the second chain"] });
				} else {
					throw new Error(`Unexpected model requested during chain-hop test: ${model.provider}/${model.id}`);
				}
				return mock.stream(model, context, options);
			},
		});

		// Two chains, joined only by their shared entry: the role chain ends at
		// the first fallback, which is itself a chain key. Reaching the second
		// fallback requires re-resolving the chain for the active model.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${firstFallback.provider}/${firstFallback.id}`],
				[`${firstFallback.provider}/${firstFallback.id}`]: [`${secondFallback.provider}/${secondFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover across two chains");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: `${firstFallback.provider}/${firstFallback.id}`,
			},
		]);
	});

	it("keeps non-Gemini empty-body errors on the model-fallback path", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled empty-body fallback models");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, {
			firstError: new AIError.ProviderResponseError("Devin API error: empty response body", {
				provider: "devin",
				kind: "empty-body",
			}),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		await session.prompt("Recover the empty provider body");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("forwards retry fallback events to extension handlers", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const appliedFromExtension: Array<{ from: string; to: string; role: string }> = [];
		const succeededFromExtension: Array<{ model: string; role: string }> = [];
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("retry_fallback_applied", event => {
					appliedFromExtension.push({ from: event.from, to: event.to, role: event.role });
				});
				pi.on("retry_fallback_succeeded", event => {
					succeededFromExtension.push({ model: event.model, role: event.role });
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"retry-fallback-observer",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const appliedFromSubscribe: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const succeededFromSubscribe: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") appliedFromSubscribe.push(event);
			if (event.type === "retry_fallback_succeeded") succeededFromSubscribe.push(event);
		});

		await session.prompt("Recover onto the fallback model");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		// Extension handlers must observe the same transition and success the session broadcasts.
		expect(appliedFromExtension).toEqual([
			{
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(succeededFromExtension).toEqual([
			{ model: `${fallbackModel.provider}/${fallbackModel.id}`, role: "default" },
		]);
		expect(appliedFromExtension).toEqual(appliedFromSubscribe.map(({ from, to, role }) => ({ from, to, role })));
		expect(succeededFromExtension).toEqual(succeededFromSubscribe.map(({ model, role }) => ({ model, role })));
	});

	it("confirms before crossing models when every pooled account is inside reserve", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled reserve fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["continued with full context"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePct": 10,
			"retry.usageReservePolicy": "confirm",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.08,
							},
							{
								credentialId: 2,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.02,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmFallback = vi.fn(async () => true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);
		await session.prompt("Keep working on the same task");
		await session.waitForIdle();
		expect(confirmFallback).toHaveBeenCalledWith(
			{
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				remainingPercent: 2,
			},
			expect.any(AbortSignal),
		);
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(session.messages.some(message => message.role === "user")).toBe(true);
	});

	it("honors a live fail-closed policy after reserve spending was approved", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled reserve policy models");
		const mock = createMockModel({ responses: [{ content: ["stayed on primary"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async provider =>
				provider === primaryModel.provider
					? {
							state: "reserve",
							accounts: [
								{
									credentialId: 1,
									credentialType: "oauth",
									state: "reserve",
									remainingFraction: 0.05,
								},
							],
						}
					: { state: "healthy", accounts: [] },
			);
		const confirmFallback = vi.fn(async () => false);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);

		await session.prompt("Stay on the primary");
		await session.waitForIdle();
		settings.override("retry.usageReservePolicy", "fail-closed");
		expect(settings.get("retry.usageReservePolicy")).toBe("fail-closed");

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
		expect(confirmFallback).toHaveBeenCalledTimes(1);
		expect(usageHealth).toHaveBeenCalledTimes(3);
	});
	it("reselects a healthy same-provider account before considering a model fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled pooled fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["same provider continued"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					selected: true,
					state: "reserve",
					remainingFraction: 0.05,
				},
				{ credentialId: 2, credentialType: "oauth", state: "healthy", remainingFraction: 0.8 },
			],
		});
		const release = vi
			.spyOn(modelRegistry.authStorage, "releaseSessionCredentialForReselection")
			.mockReturnValue(true);
		const confirmFallback = vi.fn(async () => true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(confirmFallback);
		await session.prompt("Stay on this provider");
		await session.waitForIdle();
		expect(release).toHaveBeenCalledWith(primaryModel.provider, session.sessionId);
		expect(confirmFallback).not.toHaveBeenCalled();
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("reselects a healthy sibling before applying a same-provider model fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled same-provider fallback models");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["same-provider fallback continued"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) =>
			options.modelId === primaryModel.id
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.05,
							},
							{
								credentialId: 2,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		const release = vi
			.spyOn(modelRegistry.authStorage, "releaseSessionCredentialForReselection")
			.mockReturnValue(true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Use the healthy sibling for the fallback model");
		await session.waitForIdle();

		expect(release).toHaveBeenCalledWith(primaryModel.provider, session.sessionId);
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
	});

	it("does not dispatch a prompt after its usage preflight is cancelled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled preflight model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		const probeStarted = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) => {
			probeStarted.resolve();
			const aborted = Promise.withResolvers<ModelUsageHealth>();
			options.signal?.addEventListener(
				"abort",
				() => aborted.reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			return aborted.promise;
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompt = session.prompt("Do not send this after cancellation");
		await probeStarted.promise;
		await session.abort();
		await prompt;

		expect(requestedModels).toEqual([]);
	});

	it("cancels a pending reserve confirmation without dispatching the prompt", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled confirmation cancellation models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmationStarted = Promise.withResolvers<void>();
		const pendingConfirmation = Promise.withResolvers<boolean>();
		const confirmationAborted = Promise.withResolvers<void>();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(async (_confirmation, signal) => {
			confirmationStarted.resolve();
			signal.addEventListener("abort", () => confirmationAborted.resolve(), { once: true });
			return pendingConfirmation.promise;
		});

		const prompt = session.prompt("Do not send after confirmation cancellation");
		await confirmationStarted.promise;
		await session.abort();
		await confirmationAborted.promise;
		await prompt;

		expect(requestedModels).toEqual([]);
	});

	it("defers usage fallback for a queued steer until the active stream finishes", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued fallback models");
		const requestedModels: string[] = [];
		const streamStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<{ content: string[] }>();
		const mock = createMockModel({
			responses: [
				async () => {
					streamStarted.resolve();
					return firstResponse.promise;
				},
				{ content: ["queued steer completed"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		let useReserve = false;
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async provider =>
				provider === primaryModel.provider
					? useReserve
						? {
								state: "reserve",
								accounts: [
									{
										credentialId: 1,
										credentialType: "oauth",
										state: "reserve",
										remainingFraction: 0.05,
									},
								],
							}
						: {
								state: "healthy",
								accounts: [
									{
										credentialId: 1,
										credentialType: "oauth",
										state: "healthy",
										remainingFraction: 0.8,
									},
								],
							}
					: { state: "healthy", accounts: [] },
			);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("Keep the primary stream active");
		await streamStarted.promise;
		useReserve = true;
		await session.sendUserMessage("Queue this steer", { deliverAs: "steer" });

		expect(usageHealth).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(primaryModel.id);

		firstResponse.resolve({ content: ["primary stream completed"] });
		await firstPrompt;
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("cancels queued-turn usage confirmation when post-prompt work is disposed", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued cancellation models");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		const confirmationStarted = Promise.withResolvers<void>();
		const pendingConfirmation = Promise.withResolvers<boolean>();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setUsageFallbackConfirmer(async () => {
			confirmationStarted.resolve();
			return pendingConfirmation.promise;
		});

		await session.sendUserMessage("Queue this turn", { deliverAs: "steer" });
		await confirmationStarted.promise;
		await session.dispose();
		session = undefined;

		expect(requestedModels).toEqual([]);
	});

	it("does not reschedule a queued drain after a dequeue hook rejects", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled queued-drain model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const hookRan = Promise.withResolvers<void>();
		let attempts = 0;
		const failingHook = vi.fn(() => {
			hookRan.resolve();
			if (++attempts === 1) throw new Error("blocked before dequeue");
		});
		agent.addBeforeQueuedMessageDequeueHook(failingHook);

		await session.sendUserMessage("Keep this queued", { deliverAs: "steer" });
		await hookRan.promise;
		await session.waitForIdle();

		expect(failingHook).toHaveBeenCalledTimes(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(requestedModels).toEqual([]);
	});

	it("enforces fail-closed usage health when model fallback is disabled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled fail-closed model");
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel().stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "reserve",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "reserve",
					remainingFraction: 0.05,
				},
			],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
	});

	it("does not degrade Fireworks Fast or retry a chain after queued fail-closed preflight", async () => {
		const primaryModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled queued fail-closed models");
		const requestedModels: string[] = [];
		const streamStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<{ content: string[] }>();
		const mock = createMockModel({
			responses: [
				async () => {
					streamStarted.resolve();
					return firstResponse.promise;
				},
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		let useReserve = false;
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("Keep the primary stream active");
		await streamStarted.promise;
		useReserve = true;
		await session.sendUserMessage("Queue blocked work", { deliverAs: "steer" });
		firstResponse.resolve({ content: ["primary stream completed"] });
		await firstPrompt;
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("rechecks fail-closed usage health before an internally scheduled continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled scheduled continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const mock = createMockModel({
			responses: [
				async () => {
					useReserve = true;
					return { content: [], stopReason: "stop" };
				},
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Retry this empty response");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("rechecks fail-closed usage health before a same-turn tool continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled tool-continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "consume",
			label: "Consume",
			description: "Consume plan quota",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				useReserve = true;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "consume", arguments: { value: "done" } }] },
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Use the tool");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});
	it("rechecks fail-closed usage health when prompt setup changes the model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const setupTarget = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !setupTarget) throw new Error("Expected bundled setup-handoff models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				const reserve = options.modelId === setupTarget.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn(async () => {
				if (!session) throw new Error("Expected active session");
				await session.setModelTemporary(setupTarget, undefined, { ephemeral: true });
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Change models during setup");

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, setupTarget.id]);
		expect(requestedModels).toEqual([]);
	});

	it("restarts usage preflight when the model changes during a health request", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !selectedModel) throw new Error("Expected bundled preflight race models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const healthStarted = Promise.withResolvers<void>();
		const releaseHealth = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage, "getModelUsageHealth")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				if (options.modelId === primaryModel.id) {
					healthStarted.resolve();
					await releaseHealth.promise;
				}
				const reserve = options.modelId === selectedModel.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompting = session.prompt("Change models during preflight");
		await healthStarted.promise;
		await session.setModelTemporary(selectedModel, undefined, { ephemeral: true });
		releaseHealth.resolve();
		await expect(prompting).rejects.toThrow(`reserve reached for ${selectedModel.provider}/${selectedModel.id}`);

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, selectedModel.id]);
		expect(session.model?.id).toBe(selectedModel.id);
		expect(requestedModels).toEqual([]);
	});

	it("finishes usage preflight when no model is selected", async () => {
		const agent = new Agent({
			initialState: { model: undefined, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("No model configured")).rejects.toThrow("No model selected");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("continues a startup-owned role fallback chain from the active fallback", async () => {
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!firstFallback || !secondFallback) {
			throw new Error("Expected bundled fallback models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: firstFallback,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
					mock.push({ content: ["Recovered on the remaining fallback"] });
				} else {
					throw new Error(
						`Unexpected model requested during startup fallback test: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const primarySelector = "missing-provider/missing-model";
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				slow: [`${firstFallback.provider}/${firstFallback.id}`, `${secondFallback.provider}/${secondFallback.id}`],
			},
		});
		settings.setModelRole("slow", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			initialRetryFallback: {
				role: "slow",
				originalSelector: primarySelector,
				originalThinkingLevel: undefined,
			},
		});
		// Startup-owned: selected before the session ran, so it owns every turn
		// from the first request — there is no earlier model's work to misattribute.
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});

		const swapProbe: Array<ServingModel | undefined> = [];
		const observed = session;
		observed.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
				swapProbe.push(observed.servingModel);
			}
		});

		await session.prompt("Continue the startup fallback chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "slow",
			},
		]);
		// Nothing had served when the chain advanced, so there was no earlier work
		// to miscredit and the candidate being attempted is the only answer — but
		// it is still reported as fallback-routed.
		expect(swapProbe).toEqual([{ selector: `${secondFallback.provider}/${secondFallback.id}`, isFallback: true }]);
		expect(session.servingModel).toEqual({
			selector: `${secondFallback.provider}/${secondFallback.id}`,
			isFallback: true,
		});
	});

	it("keeps advisor fallback recovery on its role chain when another role shares its model", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const unrelatedFallback = getBundledModel("openai", "gpt-4o");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !unrelatedFallback || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({
			responses: [{ content: ["Primary complete"] }, { content: ["Primary complete again"] }],
		});
		const advisorMock = createMockModel();
		let advisorPrimaryAttempts = 0;
		const requestedAdvisorModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorFailures: string[] = [];
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const unrelatedFallbackSelector = `${unrelatedFallback.provider}/${unrelatedFallback.id}`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				commit: [unrelatedFallbackSelector],
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${advisorPrimarySelector}:medium`);
		settings.setModelRole("advisor", advisorRoleSelector);
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "fallback-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector && advisorPrimaryAttempts++ === 0) {
					advisorMock.push({
						throw: "Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 1s.",
					});
				} else if (selector === advisorPrimarySelector) {
					advisorMock.push({ content: ["Advisor primary restored"] });
				} else if (selector === unrelatedFallbackSelector) {
					advisorMock.push({ content: ["Unrelated fallback answered"] });
				} else if (selector === advisorFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
				fallbackSucceeded.resolve();
			}
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailures.push(event.message);
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		// The catch-up gate releases immediately while the advisor is mid-failure
		// (a failing advisor must never park the primary), so waitForIdle can
		// return before the fallback retry lands — await the success event.
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorFallback.provider,
			id: advisorFallback.id,
		});
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: advisorRoleSelector,
				to: advisorFallbackSelector,
				role: "advisor",
			},
		]);
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${advisorFallbackSelector}:high`,
				role: "advisor",
			},
		]);
		expect(advisorFailures).toEqual([]);

		const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
		const afterCooldown = Date.now() + 2_000;
		vi.spyOn(Date, "now").mockReturnValue(afterCooldown);
		await session.prompt("Complete another primary turn after the advisor cooldown");
		await session.waitForIdle();
		expect(getApiKey).toHaveBeenCalledWith(
			expect.objectContaining({ provider: advisorPrimary.provider, id: advisorPrimary.id }),
			expect.any(String),
			{ signal: expect.any(AbortSignal) },
		);

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector, advisorPrimarySelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("switches an advisor off a dual-classified media-budget 413 with no token excess", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorFailures: string[] = [];
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${mainModel.provider}/${mainModel.id}`);
		settings.setModelRole("advisor", advisorRoleSelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "media-budget-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector) {
					advisorMock.push({
						stopReason: "error",
						errorMessage: "request_too_large: image count exceeds the limit of 20",
						usage: { input: 5_000 },
					});
				} else if (selector === advisorFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fallbackSucceeded.resolve();
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailures.push(event.message);
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorFallback.provider,
			id: advisorFallback.id,
		});
		expect(advisorFailures).toEqual([]);
	});

	it("keeps a usage-backed media-budget overflow from switching the advisor", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const advisorFailed = Promise.withResolvers<void>();
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("commit", `${mainModel.provider}/${mainModel.id}`);
		settings.setModelRole("advisor", advisorRoleSelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "media-budget-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector) {
					advisorMock.push({
						stopReason: "error",
						errorMessage: "request_too_large: image count exceeds the limit of 20",
						usage: { input: (advisorPrimary.contextWindow ?? 200_000) + 100_000 },
					});
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "advisor" && event.message.includes("unavailable")) {
				advisorFailed.resolve();
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await advisorFailed.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("hops an advisor to the chain owned by the fallback it landed on", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!mainModel || !advisorPrimary || !advisorFallback || !secondFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const requestedAdvisorModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorRoleSelector = `${advisorPrimarySelector}:high`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;
		const secondFallbackSelector = `${secondFallback.provider}/${secondFallback.id}`;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		// The advisor role chain ends at the first fallback, which owns a chain of
		// its own. Reaching the second requires re-resolving from the live model.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [advisorFallbackSelector],
				[advisorFallbackSelector]: [secondFallbackSelector],
			},
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", advisorRoleSelector);
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "chain-hop-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === advisorPrimarySelector || selector === advisorFallbackSelector) {
					advisorMock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (selector === secondFallbackSelector) {
					advisorMock.push({ content: ["Advisor recovered on the second chain"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "retry_fallback_succeeded") fallbackSucceeded.resolve();
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		await fallbackSucceeded.promise;

		expect(requestedAdvisorModels).toEqual([advisorPrimarySelector, advisorFallbackSelector, secondFallbackSelector]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: secondFallback.provider,
			id: secondFallback.id,
		});
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: advisorRoleSelector,
				to: advisorFallbackSelector,
				role: "advisor",
			},
			{
				type: "retry_fallback_applied",
				from: `${advisorFallbackSelector}:high`,
				to: secondFallbackSelector,
				role: advisorFallbackSelector,
			},
		]);
	});

	it("ignores late advisor fallback credentials after a session transition", async () => {
		const mainModel = getBundledModel("openai", "gpt-4o-mini");
		const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorFallback = getBundledModel("openai", "gpt-4o");
		if (!mainModel || !advisorPrimary || !advisorFallback) {
			throw new Error("Expected bundled advisor fallback models to exist");
		}

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel({
			responses: [{ throw: "service unavailable: 503 overloaded" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});
		const advisorPrimarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
		const advisorFallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				[advisorPrimarySelector]: [advisorFallbackSelector],
			},
		});
		settings.setModelRole("advisor", advisorPrimarySelector);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		session.setAdvisorEnabled(true);

		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const credentialReturned = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _sessionId, options) => {
			if (model.provider === advisorFallback.provider && model.id === advisorFallback.id) {
				credentialSignal = options?.signal;
				credentialStarted.resolve();
				await releaseCredential.promise;
				credentialReturned.resolve();
			}
			return `${model.provider}-test-key`;
		});

		await session.prompt("Trigger advisor fallback");
		await credentialStarted.promise;
		await session.newSession();
		releaseCredential.resolve();
		await credentialReturned.promise;
		await Bun.sleep(0);

		expect(credentialSignal?.aborted).toBe(true);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorPrimary.provider,
			id: advisorPrimary.id,
		});
	});

	it("activates a model-keyed fallback chain without any role assignment", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via model-keyed chain");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: `${primaryModel.provider}/${primaryModel.id}`,
			},
		]);
	});

	it("prefers a model-keyed chain over the matching role chain", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const modelKeyFallback = getBundledModel("openai", "gpt-4o-mini");
		const roleChainFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !modelKeyFallback || !roleChainFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${roleChainFallback.provider}/${roleChainFallback.id}`],
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${modelKeyFallback.provider}/${modelKeyFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Model-keyed chain wins");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${modelKeyFallback.provider}/${modelKeyFallback.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${modelKeyFallback.provider}/${modelKeyFallback.id}`,
				role: `${primaryModel.provider}/${primaryModel.id}`,
			},
		]);
	});

	it("falls back to the chain when credential rotation exhausts the retry budget", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "429 usage_limit_reached" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		// Rotation always claims a sibling credential is available — the shape
		// of a multi-account pool where the sibling check passes but every
		// subsequent request keeps failing on the same capped account.
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: true });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Exhaust rotation, then fail over");
		await session.waitForIdle();

		// Two rotation retries burn the budget on the primary; the exhausted
		// attempt consults the chain instead of giving up.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		// The fallback model gets a fresh retry budget (attempt resets to 1).
		expect(retryStartEvents.map(event => event.attempt)).toEqual([1, 2, 1]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
	});
	it("rotates sibling credentials on 402 Payment Required without invoking model fallback", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("google", "gemini-1.5-pro") ?? getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedCalls: Array<{ model: string; apiKey: string | undefined }> = [];
		let currentKey = "key-A";
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: () => currentKey,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
				requestedCalls.push({ model: `${model.provider}/${model.id}`, apiKey });
				if (requestedCalls.length === 1) {
					// The mock model keeps only the thrown error's message text, so the
					// 402 must travel inside the message for classification to rotate.
					mock.push({ throw: new Error("HTTP 402 Payment Required") });
				} else {
					mock.push({ content: ["ok:sibling-credential-success"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const markUsageLimitSpy = vi
			.spyOn(modelRegistry.authStorage, "markUsageLimitReached")
			.mockImplementation(async () => {
				currentKey = "key-B";
				return { switched: true };
			});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Prompt requiring credential rotation");
		await session.waitForIdle();

		expect(markUsageLimitSpy).toHaveBeenCalledTimes(1);
		expect(requestedCalls).toHaveLength(2);
		expect(requestedCalls[0]).toEqual({
			model: `${primaryModel.provider}/${primaryModel.id}`,
			apiKey: "key-A",
		});
		expect(requestedCalls[1]).toEqual({
			model: `${primaryModel.provider}/${primaryModel.id}`,
			apiKey: "key-B",
		});
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
	});
	it("rotates sibling credentials on 402 Payment is required and status-only 402 without invoking model fallback", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("google", "gemini-1.5-pro") ?? getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// The mock model reduces a thrown error to its message text (a `status`
		// property never reaches the AssistantMessage), so carry the 402 inside
		// the message: the first iteration exercises the quota-worded body, the
		// second an opaque status-only body.
		for (const errorToThrow of [new Error("HTTP 402 Payment is required"), new Error("HTTP 402")]) {
			const requestedCalls: Array<{ model: string; apiKey: string | undefined }> = [];
			let currentKey = "key-A";
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: () => currentKey,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
					requestedCalls.push({ model: `${model.provider}/${model.id}`, apiKey });
					if (requestedCalls.length === 1) {
						mock.push({ throw: errorToThrow });
					} else {
						mock.push({ content: ["ok:sibling-credential-success"] });
					}
					return mock.stream(model, context, options);
				},
			});

			// `vi.spyOn` on an already-spied method returns the existing spy with
			// its accumulated call history, so clear it between the parameterized
			// iterations — each must observe exactly one credential rotation.
			const markUsageLimitSpy = vi
				.spyOn(modelRegistry.authStorage, "markUsageLimitReached")
				.mockClear()
				.mockImplementation(async () => {
					currentKey = "key-B";
					return { switched: true };
				});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
				},
			});

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			await session.prompt("Prompt requiring credential rotation");
			await session.waitForIdle();

			expect(markUsageLimitSpy).toHaveBeenCalledTimes(1);
			expect(requestedCalls).toHaveLength(2);
			expect(requestedCalls[0]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-A",
			});
			expect(requestedCalls[1]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-B",
			});
			expect(session.model?.provider).toBe(primaryModel.provider);
			expect(session.model?.id).toBe(primaryModel.id);
			await session.dispose();
			session = undefined;
		}
	});

	it("allows model fallback on 402 Payment Required when all sibling credentials are exhausted", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("google", "gemini-1.5-pro") ?? getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: Object.assign(new Error("Payment Required"), { status: 402 }) });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Prompt triggering fallback on exhausted siblings");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("applies a provider-wildcard chain to any model of that provider", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-opus-4-1");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// No exact key for this model and no role assignment: only the
		// `anthropic/*` wildcard can match, proving provider-level coverage.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via provider wildcard");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "anthropic/*",
			},
		]);
	});

	it("consults the fallback chain on a non-retryable hard error instead of failing the turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider) {
					// Classifies as neither transient, usage-limit, nor auth:
					// the generic retry classifier rejects it outright.
					mock.push({ throw: "unrecoverable model quirk" });
				} else {
					mock.push({ content: ["Recovered on fallback"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Survive a hard error");
		await session.waitForIdle();

		// Exactly one attempt on the failing model: a hard error switches models
		// immediately, it never backoff-retries the same model.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "anthropic/*",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});
	it("surfaces immutable Anthropic thinking errors without retry fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const immutableThinkingError =
			"400 invalid_request_error: messages.1.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified";
		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else {
					mock.push({ throw: immutableThinkingError });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		await session.prompt("Continue");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			errorMessage: immutableThinkingError,
		});
	});

	it("keeps signed Anthropic thinking on its source model during transient retry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else if (requestCount === 2) {
					mock.push({ throw: "503 overloaded_error: provider returned error" });
				} else {
					mock.push({ content: ["Recovered on Sonnet"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		const seededAssistant = agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!seededAssistant) throw new Error("Expected seeded assistant message");
		seededAssistant.api = primaryModel.api;
		seededAssistant.provider = primaryModel.provider;
		seededAssistant.model = primaryModel.id;
		await session.prompt("Retry a transient failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("keeps signed thinking in a preserved transport-error turn on its source Anthropic model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-1");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "signed-transport-call",
			name: "bash",
			arguments: { command: "ssh host" },
		};
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					return transportErrorAfterToolCallStream(model, toolCall, "sonnet-signature");
				}
				const mock = createMockModel({ id: model.id, provider: model.provider });
				mock.push({ content: ["Recovered on Sonnet"] });
				return mock.stream(mock, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
		});

		await session.prompt("Run a signed tool turn");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("surfaces a non-retryable error without same-model retries when no fallback candidate has a credential", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) =>
			model.provider === fallbackModel.provider ? Promise.resolve(undefined) : originalGetApiKey(model, sessionId),
		);

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: "unrecoverable model quirk" });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Fail hard with no fallback credential");
		await session.waitForIdle();

		// The switch could not happen and the error is non-retryable: surface it
		// after a single attempt instead of backoff-retrying the failing model.
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("substitutes the failing model id into provider-wildcard chain entries", async () => {
		const primaryModel = getBundledModel("google", "gemini-2.5-flash");
		const fallbackModel = getBundledModel("google-vertex", "gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// `google-vertex/*` is not a fixed target: it must adopt the failing
		// model's id (google/gemini-2.5-flash -> google-vertex/gemini-2.5-flash).
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"google/*": ["google-vertex/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via id-preserving wildcard entry");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe("google-vertex");
		expect(session.model?.id).toBe(primaryModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `google-vertex/${primaryModel.id}`,
				role: "google/*",
			},
		]);
	});

	it("re-prefixes the failing model's bare id for id-prefixed wildcard chain entries", async () => {
		const primaryModel = getBundledModel("google", "gemini-2.5-flash");
		const fallbackModel = getBundledModel("openrouter", "google/gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// `openrouter/google/*` splits into provider `openrouter` + id prefix
		// `google`: the failing bare id is re-prefixed into the aggregator's
		// namespace (google/gemini-2.5-flash -> openrouter/google/gemini-2.5-flash).
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"google/*": ["openrouter/google/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via id-prefixed wildcard entry");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe("openrouter");
		expect(session.model?.id).toBe(`google/${primaryModel.id}`);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `openrouter/google/${primaryModel.id}`,
				role: "google/*",
			},
		]);
	});

	it("matches id-prefixed wildcard keys and strips the vendor prefix for direct-provider targets", async () => {
		const primaryModel = getBundledModel("openrouter", "google/gemini-2.5-flash");
		const fallbackModel = getBundledModel("google-vertex", "gemini-2.5-flash");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		// Key `openrouter/google/*` covers only openrouter's google-namespaced
		// ids; the plain `google-vertex/*` target drops the aggregator's vendor
		// prefix because vertex only knows the bare id.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"openrouter/google/*": ["google-vertex/*"],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover via id-prefixed wildcard key");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe("google-vertex");
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `google-vertex/${fallbackModel.id}`,
				role: "openrouter/google/*",
			},
		]);
	});

	it("uses the active initial model as the default fallback primary when other role fallback chains are configured", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		const otherRoleFallbackModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !fallbackModel || !otherRoleFallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
				smol: [`${otherRoleFallbackModel.provider}/${otherRoleFallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Recover using implicit default primary");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
	});

	it("falls back on structured classifier refusals and pins the fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const refusalDetails = {
			type: "refusal",
			category: "cyber",
			explanation: "Classifier declined this turn.",
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					primaryAttempts += 1;
					mock.push({
						content: [{ type: "thinking", thinking: "Classifier evaluation before refusal." }],
						stopReason: "error",
						stopDetails: refusalDetails,
						errorMessage: "Refusal (cyber): Classifier declined this turn.",
					});
				} else if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) {
					mock.push({ content: [`ok:${primaryAttempts}`] });
				} else {
					throw new Error(
						`Unexpected model requested during refusal fallback test: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Recover from classifier refusal");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 10 * 60 * 1000;
		await session.prompt("Next turn stays pinned on fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("drops classifier refusal messages before later prompts", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["Classifier declined this turn."],
					stopReason: "error",
					stopDetails: {
						type: "refusal",
						category: "bio",
						explanation: "Classifier declined this turn.",
					},
					errorMessage: "Refusal (bio): Classifier declined this turn.",
				},
				context => {
					const replayedAssistantText = context.messages
						.filter((message): message is AssistantMessage => message.role === "assistant")
						.flatMap(message => message.content)
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					return {
						content: [replayedAssistantText.includes("Classifier declined this turn.") ? "polluted" : "clean"],
					};
				},
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionStopCalls: number[] = [];
		const sessionStopLastAssistantMessages: Array<AssistantMessage | undefined> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { last_assistant_message?: AssistantMessage }) => {
				sessionStopCalls.push(mock.calls.length);
				sessionStopLastAssistantMessages.push(event.last_assistant_message);
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();
		await session.prompt("Next prompt should not replay the refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const replayedAssistantText = mock.calls[1]?.context.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(replayedAssistantText).not.toContain("Classifier declined this turn.");
		expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "clean" }]);
		// session_stop hooks must fire after each settled turn — including the
		// refusal turn (regression: prior to PR #3594's review fix, the refusal
		// branch short-circuited before `#emitSessionStopEvent`).
		expect(sessionStopCalls).toEqual([1, 2]);
		expect(sessionStopLastAssistantMessages[0]?.stopReason).toBe("error");
		expect(sessionStopLastAssistantMessages[0]?.stopDetails).toEqual({
			type: "refusal",
			category: "bio",
			explanation: "Classifier declined this turn.",
		});
	});

	it("keeps the pruned refusal visible to getLastAssistantMessage until the next run", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
				{ content: ["recovered"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();

		// The refusal turn is pruned from active context (no assistant tail)…
		expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		// …but terminal-outcome consumers (print mode, task executor) must still
		// see the settled error instead of a silently successful-looking state.
		const settled = session.getLastAssistantMessage();
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe("Refusal (cyber): Declined.");
		expect(settled?.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: "Declined." });

		await session.prompt("Next prompt supersedes the pruned refusal");
		await session.waitForIdle();

		const recovered = session.getLastAssistantMessage();
		expect(recovered?.stopReason).toBe("stop");
		expect(recovered?.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("does not exceed retry.maxRetries for classifier fallback chains", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const mock = createMockModel();
		const refusalMessage = "Refusal (cyber): Classifier declined this fallback turn.";
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
					mock.push({
						stopReason: "error",
						stopDetails: {
							type: "refusal",
							category: "cyber",
							explanation: "Classifier declined this fallback turn.",
						},
						errorMessage: refusalMessage,
					});
				} else {
					throw new Error(
						`Unexpected model requested after retry budget exhaustion: ${model.provider}/${model.id}`,
					);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await session.prompt("Stop after the configured retry budget");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: refusalMessage,
		});
		// The superseded first attempt is aggregated onto the terminal event so
		// the transcript renders one budget-labeled error, not per-attempt rows.
		expect(retryEndEvents[0]?.retryErrors).toHaveLength(1);
		expect(retryEndEvents[0]?.retryErrors?.[0]?.retryRecovery).toMatchObject({
			kind: "auto-retry",
			recovery: "model",
			status: "superseded",
			attempt: 1,
		});
	});

	it("emits auto_retry_end when a mid-saga classifier refusal has no fallback to switch to", async () => {
		// Regression: `#handleRetryableError`'s classifier-refusal branch used to
		// return `false` without emitting `auto_retry_end` whenever no fallback
		// model was available to switch to. A saga that already announced
		// `auto_retry_start` on an earlier (non-refusal) attempt would then never
		// get a matching `auto_retry_end` — leaving any subscriber tracking
		// "retry outstanding" state (e.g. suppressing a duplicate error toast)
		// latched open forever. With `retry.maxRetries: 2` and no fallback chain
		// configured, the second attempt's classifier refusal hits that branch
		// while `retryAttempt (2) <= maxRetries (2)`, so it can't fall through
		// the pre-existing maxRetries-exceeded path (which already emits
		// `auto_retry_end`) — isolating the branch this regression covers.
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const requestedModels: string[] = [];
		const refusalMessage = "Refusal (cyber): Classifier declined this retried turn.";
		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				calls += 1;
				if (calls === 1) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (calls === 2) {
					mock.push({
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined." },
						errorMessage: refusalMessage,
					});
				} else {
					throw new Error(`Unexpected model call after the classifier refusal settled: call ${calls}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry once, then hit a classifier refusal with no fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.attempt).toBe(1);
		expect(retryEndEvents).toEqual([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: refusalMessage,
			},
		]);
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(waitSpy).toHaveBeenCalledWith(50, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("keeps retry on the primary model when retry model fallback is disabled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: "rate limit exceeded retry-after-ms=200" }, { content: ["Recovered on primary retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Retry rate limit without switching models");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: "rate limit exceeded retry-after-ms=200",
		});
		expect(waitSpy).toHaveBeenCalledWith(200, { signal: expect.any(AbortSignal) });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on primary retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("restarts Responses provider state before retrying stale item-id replay errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const staleReplayError = "Item with id 'rs_stale' not found.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stale OpenAI replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: staleReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after Responses state reset",
		});
	});

	it("restarts Responses provider state before retrying Zero Data Retention errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mirrors the live wire error from OpenAI ZDR orgs after the in-provider
		// retry has already exhausted itself; the higher-level retry must still
		// classify the failure as a stale-replay event so the session reset and
		// zero-delay backoff fire instead of a model fallback.
		const zdrReplayError = "400 Previous response cannot be used for this organization due to Zero Data Retention.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: zdrReplayError }, { content: ["Recovered after ZDR reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry ZDR replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: zdrReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after ZDR reset" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_start before message_start";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_start");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: stream ended before message_stop";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_stop");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("falls back on mid-stream Anthropic envelope failures without same-model retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mid-stream envelope corruption is not auto-retried on the same model
		// (partial content may have been delivered), but a configured fallback
		// chain is still consulted: a different model is a fresh chance.
		const envelopeError = "Anthropic stream envelope error: received content_block_delta before terminal stop signal";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const mock = createMockModel({ handler: () => ({ throw: envelopeError }) });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Do not retry Anthropic envelope failure before terminal stop signal");
		await session.waitForIdle();

		// One attempt per model: chain advances, never a same-model backoff retry.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${fallbackModel.provider}/${fallbackModel.id}`,
				role: "default",
			},
		]);
		// The fallback fails with the same hard error and the chain is exhausted:
		// the failure surfaces instead of looping.
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe(envelopeError);
	});

	it("closes the retry lifecycle when a retried turn ends with a non-retryable error", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");

		const retryableError = "rate limit exceeded retry-after-ms=5";
		const terminalError = "invalid request: schema violation";
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push({ throw: requestedModels.length === 1 ? retryableError : terminalError });
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Retry once, then surface a terminal validation failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: terminalError }),
		]);
		expect(session.retryAttempt).toBe(0);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("auto-retries a bare Request was aborted error-stop turn (issue #5375)", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const requestedModels: string[] = [];
		// A stalled/dropped stream that the provider surfaces as stopReason:"error"
		// carrying the bare abort sentinel, then a clean recovery on the retry.
		const mock = createMockModel({
			responses: [{ throw: "Request was aborted." }, { content: ["recovered after bare abort error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry the bare abort error");
		await session.waitForIdle();

		// Same model, retried once (no model fallback for a reason-less abort).
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "recovered after bare abort error",
		});
	});

	it("matches plain fallback roles for compat-routed primary models", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const routedPrimary = buildModel({
			id: "z-ai/glm-4.7",
			name: "GLM 4.7",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { openRouterRouting: { only: ["cerebras"] } },
		});

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter" &&
					requestedModel.compat &&
					"openRouterRouting" in requestedModel.compat
						? requestedModel.compat.openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requestedModel.provider === "openrouter" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Compat-routed primary should still match plain role");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("keeps exact @-suffixed model IDs in fallback selectors", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("google-vertex", "claude-opus-4-8@default");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled OpenAI and Vertex Anthropic test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (requestedModel.provider === primaryModel.provider && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: `rate limit exceeded retry-after-ms=${FALLBACK_TEST_RETRY_AFTER_MS}` });
				} else {
					mock.push({ content: [`ok:${requestedModel.provider}/${requestedModel.id}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Fallback should keep exact @ model id");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
	});
	it("suppresses cooled selectors and lazily reverts to the role primary after cooldown expiry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, { retryAfterMs: 200 });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await session.prompt("Immediate second prompt should stay on fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		now += 240;
		await session.prompt("Third prompt should lazily revert to primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		// The restored primary answered, so attribution moves back with it.
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});
	});

	it("keeps credit with the fallback when a restored primary fails without serving", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Only the fallback ever produces anything; the primary rate-limits on
				// every request, including after its cooldown expires and it is
				// restored. `retry-after-ms` keeps the cooldown short enough to expire
				// within the test's clock jump.
				mock.push(
					model.id === fallbackModel.id
						? { content: ["the fallback did the work"] }
						: { throw: "rate limit exceeded retry-after-ms=200" },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Fail over to the fallback");
		await session.waitForIdle();
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});

		// Capture attribution inside the restore's synchronous `model_changed`
		// fan-out, which is the window the restore path reopens.
		const servingDuringSwaps: Array<ServingModel | undefined> = [];
		const restoring = session;
		restoring.subscribe(event => {
			if (event.type === "model_changed") servingDuringSwaps.push(restoring.servingModel);
		});

		now += 240;
		await session.prompt("Cooldown expired: revert to the primary and fail there");
		await session.waitForIdle();

		// A restore is a routing decision like a fallback is: the primary produced
		// nothing after coming back, so the work still belongs to the fallback.
		expect(requestedModels).toContain(`${primaryModel.provider}/${primaryModel.id}`);
		expect(servingDuringSwaps.length).toBeGreaterThan(0);
		for (const serving of servingDuringSwaps) {
			expect(serving?.selector).not.toBe(`${primaryModel.provider}/${primaryModel.id}`);
		}
	});

	it("reports a Fireworks Fast degrade as fallback-routed even though it arms no chain", async () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected the bundled Fireworks Fast model to exist");
		const baseId = fastModel.id.replace(/-fast$/, "");

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fastModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Fast rejects the request; the base model answers it.
				mock.push(
					model.id === fastModel.id
						? { throw: "rate limit exceeded retry-after-ms=200" }
						: { content: ["the base model did the work"] },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 5 });
		settings.setModelRole("default", `${fastModel.provider}/${fastModel.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Degrade off Fast and answer on the base model");
		await session.waitForIdle();

		// The degrade swaps models without arming a retry-fallback chain, but it is
		// still fallback routing — a bare model badge would hide that.
		expect(requestedModels).toEqual([`${fastModel.provider}/${fastModel.id}`, `fireworks/${baseId}`]);
		expect(session.servingModel).toEqual({ selector: `fireworks/${baseId}`, isFallback: true });

		// How the previous transcript was routed says nothing about a freshly
		// loaded one: switching sessions in place must not describe the new
		// session's model as fallback-routed.
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("some-other-session");
		expect(session.servingModel).toEqual({ selector: `fireworks/${baseId}`, isFallback: false });
	});

	it("re-checks context before a cooldown-expiry revert onto a smaller-window model in the auto-continue path", async () => {
		// Regression for #7952: a cooldown-expiry revert reverts the model at a
		// turn boundary. The user-prompt path re-checks context after the revert
		// (runPrePromptCompactionIfNeeded), but the automatic agent.continue()
		// path did not — so reverting onto a model whose window is smaller than
		// the accumulated context sent a predictably oversized request. Here the
		// small primary (4000-token window) fell back to a large-window model,
		// accumulated context past 4000 while there, then the cooldown expired and
		// a queued follow-up drained through the auto-continue path.
		const modelsConfigPath = path.join(tempDir.path(), "revert-overflow-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 4000, contextPromotionTarget: "openai/gpt-4o" },
							"gpt-4o": { contextWindow: 1_000_000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("openai", "gpt-4o-mini");
		const fallbackModel = modelRegistry.find("openai", "gpt-4o");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected override models to resolve");
		}
		expect(primaryModel.contextWindow).toBe(4000);
		expect(fallbackModel.contextWindow).toBe(1_000_000);

		// ~15k estimated tokens: over the primary's 4000 window (80% => 3200) but
		// far under the fallback's (800k), so it sits on the fallback without
		// compaction and only overflows once the window shrinks on revert.
		const bigText = "lorem ipsum ".repeat(5000);
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		let fallbackTurns = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else if (model.id === fallbackModel.id && fallbackTurns === 0) {
					fallbackTurns += 1;
					mock.push({ content: [bigText] });
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"contextPromotion.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Primary rate-limits, falls back to the large-window model, and that turn
		// returns a large payload that grows context past the primary's window.
		await session.prompt("Trigger fallback and grow context past the primary window");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.id).toBe(fallbackModel.id);

		// Cooldown expires; a queued follow-up drains through the auto-continue
		// (agent.continue) path, which reverts to the primary. The post-revert
		// context check now runs there too: the accumulated context no longer fits
		// the primary's 4000 window, so it promotes to the larger-window model
		// instead of issuing the oversized request. Before the fix the session
		// stayed on the reverted primary and received the over-window request.
		now += 60_000;
		await session.followUp("Please continue on the reverted primary");
		await session.waitForIdle();

		expect(session.model?.id).toBe(fallbackModel.id);
		expect(requestedModels.at(-1)).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		// The 4000-window primary is only ever hit by the initial rate-limited
		// request — never by an over-window continuation after the revert.
		expect(requestedModels.filter(id => id === `${primaryModel.provider}/${primaryModel.id}`)).toHaveLength(1);
	});

	it("does not send oversized context to a smaller retry fallback model", async () => {
		// Regression for #8065: the forward counterpart of #7952. A retryable
		// error on a large-window primary switches to a retry-fallback candidate,
		// but candidate selection never compared the candidate's window with the
		// live context. A 1M-window primary could fall onto a 4000-window fallback
		// and immediately send a predictably oversized request. The fit gate must
		// skip the undersized candidate and advance to the first configured
		// candidate whose window can hold the accumulated context.
		const modelsConfigPath = path.join(tempDir.path(), "fallback-overflow-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							"claude-sonnet-4-5": { contextWindow: 1_000_000 },
						},
					},
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 4000, contextPromotionTarget: "openai/gpt-4o" },
							"gpt-4o": { contextWindow: 1_000_000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const smallFallback = modelRegistry.find("openai", "gpt-4o-mini");
		const largeFallback = modelRegistry.find("openai", "gpt-4o");
		if (!primaryModel || !smallFallback || !largeFallback) {
			throw new Error("Expected override models to resolve");
		}
		expect(primaryModel.contextWindow).toBe(1_000_000);
		expect(smallFallback.contextWindow).toBe(4000);
		expect(largeFallback.contextWindow).toBe(1_000_000);

		// ~15k estimated tokens in the initial prompt: fits the 1M primary and the
		// 1M large fallback, but far exceeds the 4000-window small fallback
		// (80% => 3200), so the small fallback cannot legally receive the request.
		const bigText = "lorem ipsum ".repeat(5000);
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"contextPromotion.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${smallFallback.provider}/${smallFallback.id}`, `${largeFallback.provider}/${largeFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Primary rate-limits with a live ~15k context; the retry-fallback path
		// must skip the 4000-window candidate and land on the 1M-window one.
		await session.prompt(bigText);
		await session.waitForIdle();

		expect(requestedModels).not.toContain(`${smallFallback.provider}/${smallFallback.id}`);
		expect(requestedModels).toContain(`${largeFallback.provider}/${largeFallback.id}`);
		expect(session.model?.id).toBe(largeFallback.id);
		expect(requestedModels.at(-1)).toBe(`${largeFallback.provider}/${largeFallback.id}`);
	});

	it("fits retry fallbacks after excluding the failed assistant turn", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "fallback-failed-turn-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							"claude-sonnet-4-5": { contextWindow: 1_000_000 },
						},
					},
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 8000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const fallbackModel = modelRegistry.find("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected override models to resolve");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.id === primaryModel.id) {
					mock.push({
						content: [{ type: "thinking", thinking: "lorem ipsum ".repeat(5000) }],
						stopReason: "error",
						errorMessage: "rate limit exceeded retry-after-ms=200",
					});
				} else {
					mock.push({ content: ["ok"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// The input fits the 8k fallback, while the failed thinking-only assistant
		// does not. That assistant is removed before retry, so it must not make the
		// selector reject a fallback that can hold the request actually sent.
		await session.prompt("small retry input");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.id).toBe(fallbackModel.id);
	});

	it("includes a preserved transport-error turn when fitting retry fallback windows", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "preserved-failed-turn-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							"claude-sonnet-4-5": { contextWindow: 1_000_000 },
						},
					},
					openai: {
						modelOverrides: {
							"gpt-4o-mini": { contextWindow: 4000 },
							"gpt-4o": { contextWindow: 1_000_000 },
						},
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const primaryModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const smallFallback = modelRegistry.find("openai", "gpt-4o-mini");
		const largeFallback = modelRegistry.find("openai", "gpt-4o");
		if (!primaryModel || !smallFallback || !largeFallback) {
			throw new Error("Expected override models to resolve");
		}

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "large-transport-call",
			name: "write",
			arguments: { path: "report.txt", content: "lorem ipsum ".repeat(5000) },
		};
		const requestedModels: string[] = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) return transportErrorAfterToolCallStream(model, toolCall);
				const mock = createMockModel({ id: model.id, provider: model.provider });
				mock.push({ content: ["Recovered on a fitting fallback"] });
				return mock.stream(mock, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${smallFallback.provider}/${smallFallback.id}`, `${largeFallback.provider}/${largeFallback.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Write a large report");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${largeFallback.provider}/${largeFallback.id}`,
		]);
		expect(requestedModels).not.toContain(`${smallFallback.provider}/${smallFallback.id}`);
		expect(session.model?.id).toBe(largeFallback.id);
	});

	it("restores routed fallback primaries after cooldown expiry", async () => {
		const openRouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!openRouterModel || !fallbackModel) {
			throw new Error("Expected bundled OpenRouter and OpenAI test models to exist");
		}
		const routedPrimary = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", [openRouterModel]).model;
		if (!routedPrimary) {
			throw new Error("Expected routed OpenRouter primary to resolve");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: routedPrimary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const route =
					requestedModel.provider === "openrouter"
						? (
								requestedModel.compat as {
									openRouterRouting?: { only?: string[] };
								}
							).openRouterRouting?.only?.[0]
						: undefined;
				const requested = `${requestedModel.provider}/${requestedModel.id}${route ? `@${route}` : ""}`;
				requestedModels.push(requested);
				if (requested === "openrouter/z-ai/glm-4.7@cerebras" && primaryAttempts === 0) {
					primaryAttempts += 1;
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${requested}`] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", "openrouter/z-ai/glm-4.7@cerebras");

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers routed primary fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);

		now += 240;
		await session.prompt("Second prompt should restore routed primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			"openrouter/z-ai/glm-4.7@cerebras",
			`${fallbackModel.provider}/${fallbackModel.id}`,
			"openrouter/z-ai/glm-4.7@cerebras",
		]);
		expect(session.model?.provider).toBe("openrouter");
		expect(session.model?.id).toBe("z-ai/glm-4.7");
		expect(
			(session.model?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only,
		).toEqual(["cerebras"]);
	});
	it("preserves thinking on bare fallback selectors and does not overwrite user thinking on restore", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels, { retryAfterMs: 200 });

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}:high`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("First prompt triggers bare-selector fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		session.setThinkingLevel(Effort.Low);
		now += 240;
		await session.prompt("Second prompt should restore model but preserve user thinking change");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("clamps a fallback selector's explicit thinking level to the session effort ceiling", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				// Explicit `:high` on the fallback selector tries to raise effort
				// above the spawn's ceiling.
				default: [`${fallbackModel.provider}/${fallbackModel.id}:high`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			// Per-spawn cap (task.maxEffort resolved at spawn time): no recovery
			// path may raise effective effort above it.
			thinkingLevelCeiling: Effort.Low,
		});

		await session.prompt("First prompt triggers fallback with an above-ceiling selector");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		// Without the ceiling the fallback's `:high` would apply verbatim.
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("skips usage fallbacks whose effort floor exceeds the session ceiling", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const incompatibleFallback = getBundledModel("openrouter", "deepseek/deepseek-v4-pro");
		const compatibleFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !incompatibleFallback || !compatibleFallback) {
			throw new Error("Expected bundled usage fallback effort models");
		}
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				default: [
					`${incompatibleFallback.provider}/${incompatibleFallback.id}`,
					`${compatibleFallback.provider}/${compatibleFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, options) => {
			usageChecks.push(options.modelId ?? "");
			return options.modelId === primaryModel.id
				? {
						state: "depleted",
						accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }],
					}
				: { state: "healthy", accounts: [] };
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.Low,
		});

		await session.prompt("Use an effort-compatible fallback");
		await session.waitForIdle();

		expect(usageChecks).toEqual([primaryModel.id, compatibleFallback.id]);
		expect(requestedModels).toEqual([`${compatibleFallback.provider}/${compatibleFallback.id}`]);
		expect(session.model?.id).toBe(compatibleFallback.id);
	});

	it("accepts cached Ollama Cloud fallback selectors during startup validation", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const cachedModel: Model<"ollama-chat"> = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", path.join(tempDir.path(), "models.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: ["ollama-cloud/deepseek-v4-pro"] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).not.toContain(
			"Fallback chain for role 'default' references unknown model: ollama-cloud/deepseek-v4-pro",
		);
	});

	it("suppresses unknown-model warnings for a config-declared discovery provider with a cold cache", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const modelsConfigPath = path.join(tempDir.path(), "cold-discovery-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					litellm: {
						baseUrl: "https://litellm.example.net/v1",
						api: "openai-completions",
						discovery: { type: "litellm" },
					},
				},
			}),
		);
		// Cold cache: no discovery row exists, so the provider contributes no
		// models and its discovery state is `idle` (pending) at construction —
		// the exact state that made valid selectors look unknown (#10048).
		const coldRegistry = new ModelRegistry(authStorage, modelsConfigPath);
		expect(coldRegistry.isProviderDiscoveryPending("litellm")).toBe(true);
		expect(coldRegistry.find("litellm", "Qwen3.8-27B")).toBeUndefined();

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"litellm/Qwen3.8-27B": ["litellm/Qwen3.8-27B-hetzner"],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: coldRegistry,
		});
		await session.waitForIdle();

		expect(session.configWarnings).not.toContain(
			"retry.fallbackChains key references unknown model: litellm/Qwen3.8-27B",
		);
		expect(session.configWarnings).not.toContain(
			"Fallback chain for model 'litellm/Qwen3.8-27B' references unknown model: litellm/Qwen3.8-27B-hetzner",
		);
	});

	it("defers fallback warnings while a selector's provider discovery is pending, then surfaces them once settled", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"litellm/Qwen3.8-27B": ["litellm/Qwen3.8-27B-hetzner"],
			},
		});

		const pendingWarnings: string[] = [];
		validateRetryFallbackChains(settings, sharedRegistry, message => pendingWarnings.push(message), {
			isDiscoveryPending: provider => provider === "litellm",
		});
		expect(pendingWarnings).toEqual([]);

		const settledWarnings: string[] = [];
		validateRetryFallbackChains(settings, sharedRegistry, message => settledWarnings.push(message));
		expect(settledWarnings).toEqual([
			"retry.fallbackChains key references unknown model: litellm/Qwen3.8-27B",
			"Fallback chain for model 'litellm/Qwen3.8-27B' references unknown model: litellm/Qwen3.8-27B-hetzner",
		]);
	});

	it("resolves awaitInitialBackgroundRefresh for a refresh started after the waiter is armed", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "late-refresh-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					litellm: {
						baseUrl: "https://litellm.example.net/v1",
						api: "openai-completions",
						discovery: { type: "litellm" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsConfigPath);
		const cancelled = new AbortController();
		const cancelledWaiter = registry.awaitInitialBackgroundRefresh(cancelled.signal);
		cancelled.abort();
		await cancelledWaiter;

		// The CLI starts background discovery only after the session — and thus
		// this awaiter — is constructed, so a waiter armed before any refresh must
		// still resolve when the later refresh settles (#10048).
		let settled = false;
		const waiter = registry.awaitInitialBackgroundRefresh().then(() => {
			settled = true;
		});
		await scheduler.wait(10);
		expect(settled).toBe(false);

		registry.refreshInBackground("offline");
		await waiter;
		expect(settled).toBe(true);

		// Once settled, a fresh waiter resolves immediately.
		await registry.awaitInitialBackgroundRefresh();
	});

	it("rebinds the active model to its post-discovery same-selector window (#10488)", async () => {
		// A discovery-backed provider whose live catalog caps a selector below the
		// window the pre-discovery snapshot carried at startup — the same class as
		// the GitHub Copilot gpt-5.6-sol split, where the bundled base ships the
		// full long-context window and discovery caps it to the default tier.
		authStorage.setRuntimeApiKey("ollama-cloud", "ollama-cloud-test-key");
		const buildTieredModel = (contextWindow: number, input: Model<"ollama-chat">["input"]): Model<"ollama-chat"> =>
			buildModel({
				id: "deepseek-v4-tiered",
				name: "DeepSeek V4 Tiered",
				api: "ollama-chat",
				provider: "ollama-cloud",
				baseUrl: "https://ollama.com",
				reasoning: true,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: 32_000,
			});
		// Post-discovery catalog: the capped entry the registry resolves for the
		// selector once background discovery settles.
		writeModelCache(
			"ollama-cloud",
			Date.now(),
			[buildTieredModel(400_000, ["text"])],
			true,
			"",
			path.join(tempDir.path(), "models.db"),
		);
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		// The startup-bound model is the pre-discovery snapshot for the SAME
		// selector with the full long-context window — what buildSessionOptions
		// pins as options.model before discovery runs.
		const staleModel = buildTieredModel(1_050_000, ["text", "image"]);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: staleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			rebindModelAfterDiscovery: true,
		});

		// Stale until discovery settles: the active model and its context-usage
		// derivation both carry the 1.05M window that contradicts the catalog.
		expect(session.model?.contextWindow).toBe(1_050_000);
		expect(session.getContextUsage()?.contextWindow).toBe(1_050_000);

		const { promise: modelChanged, resolve: resolveModelChanged } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "model_changed") {
				unsubscribe();
				resolveModelChanged();
			}
		});

		// The CLI starts discovery only after the session is built; the rebind
		// waiter armed in the constructor resolves once this settles.
		registry.refreshInBackground("offline");
		await Promise.race([
			modelChanged,
			scheduler.wait(5_000).then(() => {
				throw new Error("model_changed was not emitted after discovery settled");
			}),
		]);

		// Rebound to the same selector's refreshed 400K window without a manual
		// re-selection; get_state / contextUsage now agree with the catalog.
		expect(session.model?.id).toBe("deepseek-v4-tiered");
		expect(session.model?.contextWindow).toBe(400_000);
		expect(session.getContextUsage()?.contextWindow).toBe(400_000);
	});

	it("warns on unknown or malformed model-selector chain keys at startup", () => {
		const primaryModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"nonexistent-provider/nonexistent-model": [`${primaryModel.provider}/${primaryModel.id}`],
				[`${primaryModel.provider}/${primaryModel.id}`]: ["openai/gpt-4o"],
			},
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings).toContain(
			"retry.fallbackChains key references unknown model: nonexistent-provider/nonexistent-model",
		);
		expect(session.configWarnings.filter(w => w.includes(`${primaryModel.provider}/${primaryModel.id}`))).toEqual([]);
	});

	it("normalizes suppression by base selector and clears it on model refresh", async () => {
		const future = Date.now() + 60_000;
		modelRegistry.suppressSelector("openai/gpt-4o:high", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:low")).toBe(true);

		// `:max` is a real thinking level now, not an xhigh alias — the two parse
		// to distinct selectors...
		expect(parseModelString("openai/gpt-4o:max", { allowMaxSuffix: true })?.thinkingLevel).toBe(Effort.Max);
		expect(parseModelString("openai/gpt-4o:xhigh")?.thinkingLevel).toBe(Effort.XHigh);
		// ...but suppression normalizes every thinking suffix to the base selector,
		// so suppressing either still covers both.
		modelRegistry.suppressSelector("openai/gpt-4o:max", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:xhigh")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:max")).toBe(true);

		await modelRegistry.refresh("offline");
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(false);
	});

	it("auto-retries Gemini MALFORMED_FUNCTION_CALL after an unexecuted tool call", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const requestedModels: string[] = [];
		let toolExecutions = 0;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "record",
			label: "Record",
			description: "Record a value",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				toolExecutions += 1;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "malformed-call",
							name: "record",
							arguments: { value: "must-not-execute" },
						},
					],
					stopReason: "error",
					errorMessage: malformedError,
				},
				{ content: ["Recovered after Gemini malformed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [tool],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from Gemini malformed error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(toolExecutions).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const failedAssistant = messages[1];
		if (failedAssistant.role !== "assistant") {
			throw new Error(`Expected failed assistant message, got ${failedAssistant.role}`);
		}
		expect(failedAssistant.errorMessage).toBe(malformedError);
		const syntheticResult = messages[2];
		if (syntheticResult.role !== "toolResult") {
			throw new Error(`Expected synthetic tool result, got ${syntheticResult.role}`);
		}
		expect(syntheticResult.toolCallId).toBe("malformed-call");
		expect(syntheticResult.details).toMatchObject({ executed: false, source: "assistant_stop_error" });
		const recoveredAssistant = messages[3];
		if (recoveredAssistant.role !== "assistant") {
			throw new Error(`Expected recovered assistant message, got ${recoveredAssistant.role}`);
		}
		const contentBlock = recoveredAssistant.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after Gemini malformed function call");
	});

	it("continues a Gemini MALFORMED_FUNCTION_CALL transcribed as text with a corrective reminder", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const transcribedCall = "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```";
		const requestContexts: Message[][] = [];
		const mock = createMockModel({
			responses: [
				{ content: [transcribedCall], stopReason: "error", errorMessage: malformedError },
				{ content: ["Recovered after transcribed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			// agent-core's default converter drops developer messages; the CLI wires
			// the coding-agent converter, which is what carries the reminder.
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requestContexts.push([...context.messages]);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);

		await session.prompt("recover from a transcribed function call");
		await session.waitForIdle();

		// The committed text vetoes the replay retry; the preserved-turn continuation
		// must carry the failed turn plus the corrective reminder to the provider.
		expect(retryStartEvents).toHaveLength(0);
		expect(requestContexts).toHaveLength(2);
		const secondRequest = requestContexts[1];
		expect(secondRequest.map(message => message.role)).toEqual(["user", "assistant", "developer"]);
		const failedTurn = secondRequest[1];
		if (failedTurn.role !== "assistant") throw new Error(`Expected assistant, got ${failedTurn.role}`);
		expect(failedTurn.content).toEqual([{ type: "text", text: transcribedCall }]);
		const reminder = secondRequest[2];
		if (reminder.role !== "developer") throw new Error(`Expected developer, got ${reminder.role}`);
		const reminderText =
			typeof reminder.content === "string"
				? reminder.content
				: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(reminderText).toContain("malformed");

		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "developer", "assistant"]);
		const recovered = messages[3];
		if (recovered.role !== "assistant") throw new Error(`Expected assistant, got ${recovered.role}`);
		expect(recovered.content).toEqual([{ type: "text", text: "Recovered after transcribed function call" }]);
	});

	it("auto-retries provider finish_reason errors after partial text", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after provider finish_reason error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
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
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from provider finish_reason error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toBe(errorMessage);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after provider finish_reason error");
	});

	it("reaches the provider and closes the saga when the failed assistant tail was recreated mid-retry", async () => {
		// Issue #5382: a context rebuild can recreate the failed turn's message
		// object between settle and retry (fresh identity, same failed tail), so
		// the identity-keyed removal misses (`agent active context assistant
		// removal missed ... lastRole=assistant lastStopReason=error`). The
		// scheduled continue() then rejected the assistant tail locally before
		// any provider request, auto_retry_end never fired, and the in-flight
		// prompt() hung forever behind the pending retryPromise.
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after tail rebuild"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
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
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		// Recreate the failed tail with a fresh object identity while the retry is
		// being scheduled, reproducing the removal-miss state from the issue.
		session.subscribe(event => {
			if (event.type !== "auto_retry_start") return;
			const messages = agent.state.messages;
			const tail = messages.at(-1);
			if (tail?.role !== "assistant" || tail.stopReason !== "error") return;
			agent.replaceMessages([...messages.slice(0, -1), { ...tail, timestamp: tail.timestamp + 1 }]);
		});

		const outcome = await Promise.race([
			session.prompt("recover after the failed tail is rebuilt").then(() => "completed" as const),
			scheduler.wait(3_000).then(() => "stuck" as const),
		]);

		expect(outcome).toBe("completed");
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	// `session.servingModel` is what the Agent Hub row reads for a live or
	// parked agent. A fallback that errors on its first request produced none of
	// the session's work, so announcing it credits the primary's output to it.
	it("withholds the fallback selector until the target has served a turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// The primary serves one real turn, then both models fail: the chain
				// switches but the target never produces anything.
				if (requestedModels.length === 1) {
					mock.push({ content: ["primary did the work"] });
				} else {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Do the work on the primary");
		await session.waitForIdle();
		expect(session.servingModel?.isFallback).toBeFalsy();
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});

		await session.prompt("Fail over and die on the fallback");
		await session.waitForIdle();

		// Routing moved; attribution stayed with the model that produced the work.
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(requestedModels).toContain(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.servingModel?.isFallback).toBeFalsy();
		expect(session.servingModel).toEqual({
			selector: `${primaryModel.provider}/${primaryModel.id}`,
			isFallback: false,
		});
		// Both attribution and how the model was routed belong to the session they
		// were earned in. Every real switch mints a new session id — including for
		// an unpersisted session, which has no file to compare — so both drop
		// themselves, leaving only the model this session currently points at,
		// described without a claim about how it got there.
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("some-other-session");
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: false,
		});
	});

	it("reports the fallback selector once the target serves a turn", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Observers poll this per streaming event and per render. Before anything
		// has served the answer is computed rather than stored, so that is the
		// window where a fresh allocation per call would show up.
		expect(session.servingModel).toBe(session.servingModel);

		await session.prompt("Fail over to a working fallback");
		await session.waitForIdle();

		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});
	});

	it("carries attribution across a fork, which continues the conversation under a new id", async () => {
		using tempDir = TempDir.createSync("@omp-fallback-fork-");
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("Fail over to the fallback");
		await session.waitForIdle();
		const served = {
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		};
		expect(session.servingModel).toEqual(served);

		const sessionIdBeforeFork = sessionManager.getSessionId();
		expect(await session.fork()).toBe(true);
		expect(sessionManager.getSessionId()).not.toBe(sessionIdBeforeFork);

		// A fork clones the transcript and keeps running the same session, so the
		// work the fallback produced is still this session's — unlike a switch to
		// an unrelated transcript, which expires it.
		expect(session.servingModel).toEqual(served);
	});

	it("keeps attribution on a served fallback while the next candidate is unproven", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("google", "gemini-2.0-flash");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				// Primary fails, candidate A serves, then everything fails again so
				// candidate B is armed but never produces anything.
				mock.push(
					requestedModels.length === 2
						? { content: ["candidate A did the work"] }
						: { throw: "overloaded_error: provider returned error 503" },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Fail over to candidate A");
		await session.waitForIdle();
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});

		// `model_changed` fans out synchronously from inside the swap, which is the
		// window where the incoming candidate could inherit the previous one's proof.
		const servingAtModelChange: Array<ServingModel | undefined> = [];
		const advancing = session;
		advancing.subscribe(event => {
			if (event.type === "model_changed") servingAtModelChange.push(advancing.servingModel);
		});
		await session.prompt("Advance to candidate B and die there");
		await session.waitForIdle();

		// Candidate B owns the routing but produced nothing, so the work still
		// belongs to candidate A — and it was reached by a fallback.
		expect(session.model?.id).toBe(secondFallback.id);
		expect(session.servingModel).toEqual({
			selector: `${firstFallback.provider}/${firstFallback.id}`,
			isFallback: true,
		});
		// Never the incoming candidate: mid-swap it has produced nothing.
		expect(servingAtModelChange.length).toBeGreaterThan(0);
		for (const serving of servingAtModelChange) {
			expect(serving?.selector).not.toBe(`${secondFallback.provider}/${secondFallback.id}`);
		}
	});

	// A usage-aware fallback is applied before a request and never increments the
	// retry counter, so gating "served" on a retry saga hid it for the whole
	// session — most visibly on the Main Session row, which has no executor
	// progress to fall back on.
	it("reports a usage-aware fallback selector without any retry saga", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["served on the fallback"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage, "getModelUsageHealth").mockImplementation(async provider =>
			provider === primaryModel.provider
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [] },
		);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Work on the healthy model");
		await session.waitForIdle();

		// Proactive: the primary was never requested, so no retry saga ran.
		expect(requestedModels).toEqual([`${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(session.servingModel).toEqual({
			selector: `${fallbackModel.provider}/${fallbackModel.id}`,
			isFallback: true,
		});
	});

	// A thinking-loop abort is a same-model resample signal (the guard pairs it
	// with a `thinking-loop-redirect` notice), not a provider failure. It must
	// not walk `retry.fallbackChains` or park the current selector on a cooldown,
	// or a healthy planning turn gets replaced by another family (issue #8760).
	it("retries the same model on a thinking-loop error instead of switching via fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return requestedModels.length === 1
					? thinkingLoopErrorStream(model)
					: recoveredTextStream(model, "Recovered on the same model.");
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallbackSelector] },
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Plan the ticket, then act");
		await session.waitForIdle();

		// The fallback chain lists a different family, but the thinking-loop abort
		// re-samples the SAME model: no chain consult, no model switch.
		expect(requestedModels).toEqual([primarySelector, primarySelector]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(fallbackAppliedEvents).toHaveLength(0);
		// The abort is a thinking-loop, and the retry stayed on the same model.
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		// The selector must not be parked on a fallback cooldown by the abort.
		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(false);
		const finalAssistant = getLastAssistantMessage(session);
		expect(finalAssistant.content).toEqual([{ type: "text", text: "Recovered on the same model." }]);
	});
});
