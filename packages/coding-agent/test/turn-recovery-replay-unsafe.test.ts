import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage, SyntheticToolResultDetails } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, CredentialRankingStrategy, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
	usageLimitBlockCoversModel,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createProviderErrorMessage } from "../../ai/src/providers/error-message";
import { streamFactoryDroidGemini } from "../../ai/src/providers/factory-droid/gemini";
import { captureFetch, gemini as factoryGemini } from "../../ai/test/helpers/factory-droid";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	options: {
		fallbackChains?: Record<string, string[]>;
		textOutputCommitted?: boolean;
		messages?: readonly AgentMessage[];
		lastModelChangeRole?: string;
		modelRoles?: Record<string, string>;
		shakeSucceeds?: boolean;
	} = {},
): TurnRecoveryHost {
	const settings = Settings.isolated({
		"retry.baseDelayMs": 1,
		...(options.fallbackChains ? { "retry.fallbackChains": options.fallbackChains } : {}),
		...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
	});
	if (options.modelRoles) {
		for (const [role, selector] of Object.entries(options.modelRoles)) {
			settings.setModelRole(role, selector);
		}
	}
	const agentState = { messages: options.messages ?? [] };
	return {
		agent: {
			state: agentState,
			replaceMessages(messages: AgentMessage[]) {
				agentState.messages = messages;
			},
		} as never,
		sessionManager: {
			getLastModelChangeRole: () => options.lastModelChangeRole,
			getBranch: () => [],
			getBranchView: () => [],
			getSessionId: () => "test-session",
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => options.textOutputCommitted !== false,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => options.shakeSucceeds === true,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery replay-unsafe output classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		// Live-role resolution (#liveRetryRoleHint) filters by provider auth;
		// pin a runtime key so the test does not depend on host env credentials.
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistrySettings = Settings.isolated();
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: modelRegistrySettings });
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rolls back a usage fallback cancelled during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await fallbackApplied.promise;
		controller.abort();
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(model);
		expect(modelChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});

	it("does not commit a fallback superseded during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback race model");
		const selectedModel = { ...fallback, baseUrl: "https://user-selected-route.example" };
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const thinkingChanges: unknown[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setThinkingLevel = level => thinkingChanges.push(level);
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key" },
		);

		await fallbackApplied.promise;
		activeModel = selectedModel;
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(selectedModel);
		expect(modelChanges).toEqual([]);
		expect(thinkingChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});
	it("keeps a committed fallback when cancellation arrives during applied-event delivery", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const eventStarted = Promise.withResolvers<void>();
		const releaseEvent = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
		};
		host.emitSessionEvent = async event => {
			if (event.type !== "retry_fallback_applied") return;
			eventStarted.resolve();
			await releaseEvent.promise;
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await eventStarted.promise;
		controller.abort();
		releaseEvent.resolve();
		const committed = await applying;

		expect(committed).toBe(true);
		expect(activeModel.provider).toBe(fallback.provider);
		expect(activeModel.id).toBe(fallback.id);
		expect(modelChanges).toEqual([`${fallback.provider}/${fallback.id}`]);
	});

	it("treats a failed turn with partial non-whitespace text as NOT retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps visible partial output when the full-replay timeout recovery is vetoed", async () => {
		const message = {
			...makeMessage([{ type: "text", text: "Visible partial answer" }], model),
			api: "openai-responses" as const,
			errorStatus: 408,
			errorMessage: "Timed out reading request body.",
			requestBodyReadTimeoutFullReplay: true,
		};
		const host = createHost(model, modelRegistry, { messages: [message] });
		const recovery = new TurnRecovery(host);
		expect(await recovery.handleResponsesRequestBodyReadTimeout(message)).toBe("handled-terminal");
		expect(host.agent.state.messages).toContain(message);
	});

	it("keeps tool-call output when the full-replay timeout recovery is vetoed", async () => {
		const message = {
			...makeMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }], model),
			api: "openai-responses" as const,
			errorStatus: 408,
			errorMessage: "Timed out reading request body.",
			requestBodyReadTimeoutFullReplay: true,
		};
		const host = createHost(model, modelRegistry, { messages: [message] });
		const recovery = new TurnRecovery(host);
		expect(await recovery.handleResponsesRequestBodyReadTimeout(message)).toBe("handled-terminal");
		expect(host.agent.state.messages).toContain(message);
	});

	it("ignores a stale full-replay marker on an aborted turn", async () => {
		const message = {
			...makeMessage([], model),
			api: "openai-responses" as const,
			stopReason: "aborted" as const,
			errorStatus: 408,
			errorMessage: "Timed out reading request body.",
			requestBodyReadTimeoutFullReplay: true,
		};
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { messages: [message] }));
		expect(await recovery.handleResponsesRequestBodyReadTimeout(message)).toBe("not-applicable");
	});

	describe("full-replay timeout one-shot lifecycle", () => {
		const timeoutTurn = (): AssistantMessage => ({
			...makeMessage([], model),
			api: "openai-responses" as const,
			errorStatus: 408,
			errorMessage: "Timed out reading request body.",
			requestBodyReadTimeoutFullReplay: true,
		});
		const settledTurn = (content: AssistantMessage["content"]): AssistantMessage => ({
			...makeMessage(content, model),
			stopReason: "stop" as const,
			errorMessage: undefined,
		});

		it("re-arms the recovery after an intervening turn that produced output", async () => {
			const recovery = new TurnRecovery(createHost(model, modelRegistry, { shakeSucceeds: true }));
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-retry");
			await recovery.onAssistantSettledSuccessfully(
				settledTurn([{ type: "toolCall", id: "call-progress", name: "bash", arguments: { command: "pwd" } }]),
			);
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-retry");
		});

		it("stays bound to one changed retry while the same prompt makes no progress", async () => {
			const recovery = new TurnRecovery(createHost(model, modelRegistry, { shakeSucceeds: true }));
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-retry");
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-terminal");
		});

		it("does not re-arm on a settled turn that produced no output", async () => {
			const recovery = new TurnRecovery(createHost(model, modelRegistry, { shakeSucceeds: true }));
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-retry");
			await recovery.onAssistantSettledSuccessfully(settledTurn([]));
			expect(await recovery.handleResponsesRequestBodyReadTimeout(timeoutTurn())).toBe("handled-terminal");
		});
	});

	it("does not replay a long OpenCode Go usage limit after committed text", () => {
		const openCodeModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!openCodeModel) throw new Error("Expected bundled OpenCode Go model");
		const recovery = new TurnRecovery(
			createHost(openCodeModel, modelRegistry, {
				fallbackChains: {
					[`${openCodeModel.provider}/${openCodeModel.id}`]: ["openai/gpt-4o-mini"],
				},
			}),
		);
		const message = {
			...makeMessage([{ type: "text", text: "Already shown to the user" }], openCodeModel),
			errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
		} as AssistantMessage;
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("records a delayed usage limit against the provider that failed, not the switched-in fallback", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!codex) throw new Error("Expected bundled openai-codex model gpt-6.1-sol");
		// The session already fell back to Anthropic when an in-flight Codex run
		// settles with its usage-limit error (#17098): the block must land on
		// the Codex credential that failed, not the healthy fallback provider.
		const host = createHost(model, modelRegistry);
		const recovery = new TurnRecovery(host);
		const markReached = vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const failed: AssistantMessage = {
			...makeMessage([], codex),
			errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
			// The request resolved against this credential; the block must target
			// it even if a sibling rotation already moved the session affinity.
			credentialId: 42,
		};
		await recovery.recordUsageLimitOutcome(failed);
		expect(markReached).toHaveBeenCalledTimes(1);
		// The whole attribution must describe the failing model, not the
		// switched-in fallback: provider, modelId, baseUrl, and the failing
		// request's credential all say codex.
		expect(markReached).toHaveBeenCalledWith("openai-codex", "test-session", {
			retryAfterMs: expect.any(Number),
			providerTimed: true,
			baseUrl: codex.baseUrl,
			modelId: codex.id,
			credentialId: 42,
		});
	});

	it("drops the pinned credential id when its store generation was replaced", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!codex) throw new Error("Expected bundled openai-codex model gpt-6.1-sol");
		const host = createHost(model, modelRegistry);
		const recovery = new TurnRecovery(host);
		const markReached = vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const base = {
			...makeMessage([], codex),
			errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
		} as AssistantMessage;
		// The pin was minted by a previous store generation: replaceStore
		// retires the old store's row ids, and the current store may reuse id 42
		// for a different account, so the mark must fall back to affinity
		// resolution instead of pinning an unrelated healthy credential.
		const staleStorePin: AssistantMessage = {
			...base,
			credentialId: 42,
			credentialStoreEpoch: authStorage.credentialStoreEpoch + 1,
		};
		await recovery.recordUsageLimitOutcome(staleStorePin);
		expect(markReached).toHaveBeenLastCalledWith("openai-codex", "test-session", {
			retryAfterMs: expect.any(Number),
			providerTimed: true,
			baseUrl: codex.baseUrl,
			modelId: codex.id,
			credentialId: undefined,
		});
		// A pin from the current store generation keeps targeting the row.
		const currentStorePin: AssistantMessage = {
			...base,
			credentialId: 42,
			credentialStoreEpoch: authStorage.credentialStoreEpoch,
		};
		await recovery.recordUsageLimitOutcome(currentStorePin);
		expect(markReached).toHaveBeenLastCalledWith("openai-codex", "test-session", {
			retryAfterMs: expect.any(Number),
			providerTimed: true,
			baseUrl: codex.baseUrl,
			modelId: codex.id,
			credentialId: 42,
		});
	});

	it("drops the credential pin when its epoch belongs to an independent store", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!codex) throw new Error("Expected bundled openai-codex model gpt-6.1-sol");
		// An SDK session can resolve keys through a second AuthStorage
		// (`options.getApiKey`): that store stamps its own epoch onto the
		// message, and row ids are only unique within one store, so the foreign
		// epoch must never validate against this registry — otherwise the pin
		// would block this registry's unrelated healthy row that happens to
		// reuse the same numeric id.
		const foreign = await AuthStorage.create(tempDir.join("foreign-auth.db"));
		try {
			expect(foreign.credentialStoreEpoch).not.toBe(authStorage.credentialStoreEpoch);
			const host = createHost(model, modelRegistry);
			const recovery = new TurnRecovery(host);
			const markReached = vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
			const foreignStorePin: AssistantMessage = {
				...makeMessage([], codex),
				errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
				credentialId: 42,
				credentialStoreEpoch: foreign.credentialStoreEpoch,
			};
			await recovery.recordUsageLimitOutcome(foreignStorePin);
			expect(markReached).toHaveBeenCalledTimes(1);
			expect(markReached).toHaveBeenCalledWith("openai-codex", "test-session", {
				retryAfterMs: expect.any(Number),
				providerTimed: true,
				baseUrl: codex.baseUrl,
				modelId: codex.id,
				credentialId: undefined,
			});
		} finally {
			foreign.close();
		}
	});

	it("keeps a delayed foreign-provider usage limit out of the active model's retry policy", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!codex) throw new Error("Expected bundled openai-codex model gpt-6.1-sol");
		// #17098: the session already fell back to Anthropic when the in-flight
		// Codex run settles with its usage-limit error. The block is recorded
		// against Codex; the retry policy for the healthy switched-in model must
		// not spend that outcome — no reset redemption on the Anthropic account,
		// no Codex quota-window wait on the retry, and no Codex-window cooldown
		// on the Anthropic selector.
		const host = createHost(model, modelRegistry);
		const maybeAutoRedeemReset = vi.spyOn(host, "maybeAutoRedeemReset").mockResolvedValue({ restored: false });
		const events: { type: string; delayMs?: number }[] = [];
		host.emitSessionEvent = async event => {
			events.push(
				event.type === "auto_retry_start" ? { type: event.type, delayMs: event.delayMs } : { type: event.type },
			);
		};
		const recovery = new TurnRecovery(host);
		const noteCooldown = vi.spyOn(recovery, "noteRetryFallbackCooldown").mockImplementation(() => {});
		vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const failed: AssistantMessage = {
			...makeMessage([], codex),
			errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
		};
		// agent-session.ts records the outcome before the retry policy runs.
		await recovery.recordUsageLimitOutcome(failed);

		const retried = await recovery.handleRetryableError(failed);

		expect(maybeAutoRedeemReset).not.toHaveBeenCalled();
		// The walk itself is bypassed for a stale cross-provider outcome: the
		// active selector is healthy, so it gets neither a cooldown (not even
		// the generic heuristic one) nor a fallback swap — the session just
		// retries the active model plainly.
		expect(noteCooldown).not.toHaveBeenCalled();
		const retryStart = events.find(event => event.type === "auto_retry_start");
		expect(retried).toBe(true);
		expect(retryStart).toBeDefined();
		// The ~9701-minute Codex window must not hold back the healthy model:
		// the generic backoff stays far below retry.maxDelayMs.
		expect(retryStart?.delayMs ?? Number.POSITIVE_INFINITY).toBeLessThan(60_000);
	});

	it("keeps a same-provider outcome for a sibling model on the shared quota pool", async () => {
		const codexSol = getBundledModel("openai-codex", "gpt-6.1-sol");
		const codexAstra = getBundledModel("openai-codex", "gpt-6-astra");
		if (!codexSol || !codexAstra) throw new Error("Expected bundled openai-codex models gpt-6.1-sol and gpt-6-astra");
		// Two non-Spark Codex models share the chat quota scope: a usage limit
		// recorded against one covers the pool the active sibling also draws
		// from, so the outcome is NOT stale — its rotation signal must still
		// reach the retry policy for the active model.
		const host = createHost(codexSol, modelRegistry);
		const maybeAutoRedeemReset = vi.spyOn(host, "maybeAutoRedeemReset").mockResolvedValue({ restored: false });
		const events: { type: string; delayMs?: number }[] = [];
		host.emitSessionEvent = async event => {
			events.push(
				event.type === "auto_retry_start" ? { type: event.type, delayMs: event.delayMs } : { type: event.type },
			);
		};
		const recovery = new TurnRecovery(host);
		const noteCooldown = vi.spyOn(recovery, "noteRetryFallbackCooldown").mockImplementation(() => {});
		// A sibling credential is free right now: markReached rotates to it.
		vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: true });
		const failed: AssistantMessage = {
			...makeMessage([], codexAstra),
			errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
		};
		await recovery.recordUsageLimitOutcome(failed);

		const retried = await recovery.handleRetryableError(failed);

		// The outcome survived attribution to a sibling model: its rotation
		// signal is consumed — retry proceeds at zero delay on the switched
		// sibling instead of a generic backoff. (A dropped outcome would lose
		// switchedCredential and fall back to a nonzero heuristic delay.)
		expect(retried).toBe(true);
		const retryStart = events.find(event => event.type === "auto_retry_start");
		expect(retryStart).toBeDefined();
		expect(retryStart?.delayMs).toBe(0);
		// Rotation already moved the pool; no redeem walk and no selector
		// cooldown are needed once the outcome's switch is honored.
		expect(maybeAutoRedeemReset).not.toHaveBeenCalled();
		expect(noteCooldown).not.toHaveBeenCalled();
	});

	it("scopes block coverage by quota pool, not by provider", () => {
		// Codex `spark` and ordinary `chat` meters are disjoint pools: a Spark
		// block must not be treated as covering an ordinary chat model even
		// though both share the openai-codex provider.
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-5.3-codex-spark", "openai-codex", "gpt-6.1-sol")).toBe(
			false,
		);
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-6.1-sol", "openai-codex", "gpt-5.3-codex-spark")).toBe(
			false,
		);
		// Two ordinary Codex models share the chat scope: covered both ways.
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-6.1-sol", "openai-codex", "gpt-6-astra")).toBe(true);
		// Anthropic's ordinary models carry no block scope: provider-wide.
		expect(usageLimitBlockCoversModel("anthropic", "claude-sonnet-4-5", "anthropic", "claude-sonnet-4-5-v2")).toBe(
			true,
		);
		// Cross-provider is never covered.
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-6.1-sol", "anthropic", "claude-sonnet-4-5")).toBe(false);
		// Same model is trivially covered.
		expect(
			usageLimitBlockCoversModel("openai-codex", "gpt-5.3-codex-spark", "openai-codex", "gpt-5.3-codex-spark"),
		).toBe(true);
	});

	it("honors every scope the active request checks, not just the primary block scope", () => {
		// A resolver whose requests check a compat scope of another tier: the
		// mark is written under the attributed request's primary scope, but the
		// active request still checks that scope, so the block genuinely binds
		// it and the outcome is NOT stale — comparing only the two primaries
		// would wrongly drop live rotation/reset/wait signals.
		const compatTiered = {
			blockScope: (ctx?: { modelId?: string }) => `scope-${ctx?.modelId === "model-b" ? "b" : "a"}`,
			blockScopes: (ctx?: { modelId?: string }) =>
				ctx?.modelId === "model-b" ? ["scope-b", "scope-a"] : ["scope-a"],
		} as unknown as CredentialRankingStrategy;
		const resolver = (provider: string) => (provider === "openai-codex" ? compatTiered : undefined);
		expect(usageLimitBlockCoversModel("openai-codex", "model-a", "openai-codex", "model-b", resolver)).toBe(true);
		// Without the shared checked scope the pools are disjoint: stale.
		const disjoint = {
			blockScope: (ctx?: { modelId?: string }) => `scope-${ctx?.modelId}`,
			blockScopes: (ctx?: { modelId?: string }) => [`scope-${ctx?.modelId}`],
		} as unknown as CredentialRankingStrategy;
		expect(
			usageLimitBlockCoversModel("openai-codex", "model-a", "openai-codex", "model-b", provider =>
				provider === "openai-codex" ? disjoint : undefined,
			),
		).toBe(false);
		// The bundled Codex strategy's legacy "shared" read scope must NOT make
		// a spark mark cover chat: usage-limit marks are written under the
		// attributed request's primary scope only, and no request's primary is
		// "shared".
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-5.3-codex-spark", "openai-codex", "gpt-6.1-sol")).toBe(
			false,
		);
	});

	it("resolves block coverage through the supplied strategy resolver, not just the bundled default", () => {
		// An embedder overriding AuthStorage's `rankingStrategyResolver` marks
		// scopes through that resolver; a coverage check consulting only the
		// bundled default could disagree with what the mark actually wrote.
		const codexPool = { blockScope: () => "codex-unified" } as unknown as CredentialRankingStrategy;
		const resolver = (provider: string) => (provider === "openai-codex" ? codexPool : undefined);
		// Under the bundled default these are disjoint pools (spark vs chat).
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-5.3-codex-spark", "openai-codex", "gpt-6.1-sol")).toBe(
			false,
		);
		// Under the embedder's unified scope the same pair is covered.
		expect(
			usageLimitBlockCoversModel("openai-codex", "gpt-5.3-codex-spark", "openai-codex", "gpt-6.1-sol", resolver),
		).toBe(true);
		// A resolver that scopes only the attributed provider still applies to it.
		expect(usageLimitBlockCoversModel("openai-codex", "gpt-6.1-sol", "openai-codex", "gpt-6.1-sol", resolver)).toBe(
			true,
		);
		// Cross-provider stays uncovered regardless of the resolver.
		expect(
			usageLimitBlockCoversModel("openai-codex", "gpt-6.1-sol", "anthropic", "claude-sonnet-4-5", resolver),
		).toBe(false);
	});

	it("treats an empty-string block scope as provider-wide, like CredentialBlocks does", () => {
		// An SDK-supplied resolver whose global scope is "" writes the mark to
		// the bare provider key — scopedBackoffKey folds "" into the provider
		// key, which every request of the provider checks — while
		// credentialBlockScopesForRequest omits the empty value. Falling
		// through to `includes("")` would label the live outcome stale and
		// discard a valid sibling rotation / reset-wait signal.
		const emptyScope = { blockScope: () => "" } as unknown as CredentialRankingStrategy;
		const resolver = (provider: string) => (provider === "openai-codex" ? emptyScope : undefined);
		expect(usageLimitBlockCoversModel("openai-codex", "model-a", "openai-codex", "model-b", resolver)).toBe(true);
		// The reverse direction stays uncovered: an active request scoped ""
		// checks only the provider key, so a mark written under a real scope
		// ("scope-a") does not bind it.
		const mixed = {
			blockScope: (ctx?: { modelId?: string }) => (ctx?.modelId === "model-a" ? "scope-a" : ""),
		} as unknown as CredentialRankingStrategy;
		expect(
			usageLimitBlockCoversModel("openai-codex", "model-a", "openai-codex", "model-b", provider =>
				provider === "openai-codex" ? mixed : undefined,
			),
		).toBe(false);
	});

	it("drops an outcome that went stale while the reset-redeem lookup awaited", async () => {
		const codexSol = getBundledModel("openai-codex", "gpt-6.1-sol");
		const codexAstra = getBundledModel("openai-codex", "gpt-6-astra");
		const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!codexSol || !codexAstra || !claude) throw new Error("Expected bundled codex/anthropic models");
		// #17571 (review): the outcome is attributed to astra while sol serves
		// the session — same chat pool, NOT stale, so the redeem branch runs.
		// The user then switches to Claude while the redeem lookup awaits: the
		// still-recorded outcome must be revalidated against the post-await
		// model and dropped, instead of setting Claude's retry deadline or
		// cooldown from a Codex block.
		const host = createHost(codexSol, modelRegistry);
		const maybeAutoRedeemReset = vi.spyOn(host, "maybeAutoRedeemReset").mockImplementation(async () => {
			vi.spyOn(host, "model").mockReturnValue(claude);
			return { restored: false };
		});
		const events: { type: string; delayMs?: number }[] = [];
		host.emitSessionEvent = async event => {
			events.push(
				event.type === "auto_retry_start" ? { type: event.type, delayMs: event.delayMs } : { type: event.type },
			);
		};
		const recovery = new TurnRecovery(host);
		const noteCooldown = vi.spyOn(recovery, "noteRetryFallbackCooldown").mockImplementation(() => {});
		vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const failed: AssistantMessage = {
			...makeMessage([], codexAstra),
			errorMessage: "429 usage_limit_reached: You've reached your ChatGPT plan limit. Try again in ~9701 min.",
		};
		await recovery.recordUsageLimitOutcome(failed);

		const retried = await recovery.handleRetryableError(failed);

		// The outcome was live for the pre-await model, so the redeem lookup ran…
		expect(maybeAutoRedeemReset).toHaveBeenCalled();
		expect(retried).toBe(true);
		const retryStart = events.find(event => event.type === "auto_retry_start");
		expect(retryStart).toBeDefined();
		// …but the model switched across the await, so the ~9701-minute Codex
		// window must not hold back the Claude retry: generic backoff only.
		expect(retryStart?.delayMs ?? Number.POSITIVE_INFINITY).toBeLessThan(60_000);
		expect(noteCooldown).not.toHaveBeenCalled();
	});

	it("parses a naive reset stamp with the attributed provider's timezone", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!codex) throw new Error("Expected bundled openai-codex model gpt-6.1-sol");
		// A delayed Z.AI-style error settling while the session runs Anthropic:
		// the naive `reset at` stamp must be read as +08:00 (Z.AI's catalog
		// policy), not as the active provider's interpretation. Parsing it as
		// UTC would stretch the stored block by 8 hours.
		const host = createHost(model, modelRegistry);
		const recovery = new TurnRecovery(host);
		const resetAt = new Date(Date.now() + 12 * 3_600_000);
		const pad = (n: number) => String(n).padStart(2, "0");
		const naiveStamp = `${resetAt.getUTCFullYear()}-${pad(resetAt.getUTCMonth() + 1)}-${pad(resetAt.getUTCDate())} ${pad(resetAt.getUTCHours())}:${pad(resetAt.getUTCMinutes())}:${pad(resetAt.getUTCSeconds())}`;
		const message = `429 rate limit exceeded. Your limit will reset at ${naiveStamp}`;

		const asZai = recovery.parseRetryAfterMsFromError(message, "zai");
		const asActiveAnthropic = recovery.parseRetryAfterMsFromError(message);

		// +08:00 reads the wall clock 8h earlier than UTC: both parse to a
		// future instant, 8 hours apart, with the Z.AI reading shorter.
		expect(asZai).toBeDefined();
		expect(asActiveAnthropic).toBeDefined();
		expect(asActiveAnthropic! - asZai!).toBeCloseTo(8 * 3_600_000, -4);
		expect(asZai!).toBeLessThan(12 * 3_600_000);
	});

	it("allows replay-safe hard fallback and excludes committed text with a configured chain", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		// Thinking-only output is replay-safe: nothing visible reached the user.
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }], model);
		const visible = makeMessage([{ type: "text", text: "Already shown" }], model);
		expect(recovery.isHardErrorFallbackEligible(visible)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("retries partial text while its buffered output remains uncommitted", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, { fallbackChains, textOutputCommitted: false }),
		);
		const message = makeMessage([{ type: "text", text: "Buffered partial answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with partial visible text from Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k3-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k3-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		const message = makeMessage([{ type: "text", text: "partial visible output" }], fastModel);
		expect(recovery.isFireworksFastFallbackEligible(message)).toBe(false);
	});

	it("keeps a Fireworks Fast empty/whitespace failed turn eligible for Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k3-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k3-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([], fastModel))).toBe(true);
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([{ type: "text", text: "   \n" }], fastModel))).toBe(
			true,
		);
	});

	it("bars usage-backed payload-shaped overflows from the hard-error fallback chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: { ...USAGE, input: (model.contextWindow ?? 0) + 1_000 },
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isPayloadRejection(message)).toBe(true);
		expect(AIError.isUsageBackedContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps text-ambiguous media-budget 413s eligible for the configured chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "request_too_large: image count exceeds the limit of 20",
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("keeps pure token-context overflows barred from the configured chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(AIError.isPayloadRejection(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("treats a thinking-only partial turn as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a whitespace-only text partial as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("keeps the tool-call case replay-unsafe (no regression)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps side-effecting output replay-unsafe while text is uncommitted", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { textOutputCommitted: false }));
		const message = makeMessage(
			[
				{ type: "text", text: "Buffered partial answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps an empty-content error retriable (baseline)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Reasoning before the visible answer." },
				{ type: "text", text: "The answer is 42." },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Long reasoning." },
				{ type: "text", text: "  " },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not retry malformed calls after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Already shown" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("retries malformed calls with replay-safe output", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Unshown reasoning" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats generated images as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats Anthropic server tools as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps replay-safe classifier refusals retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const thinking = makeMessage([{ type: "thinking", thinking: "reasoning before refusal" }], model);
		thinking.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(thinking)).toBe(true);

		const whitespace = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		whitespace.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(whitespace)).toBe(true);

		const empty = makeMessage([], model);
		empty.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(empty)).toBe(true);
	});

	it("does not retry a classifier refusal after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Visible refusal output" }], model);
		message.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps pre-stream provider diagnostics replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = createProviderErrorMessage(model, new Error("fetch failed"));
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	// Anthropic's request classifier can refuse AFTER the model streamed a tool
	// call. Production shape (omp.2026-08-07 log): `stopDetails.type === "refusal"`,
	// `errorId: 0` (no AIError flag, so `AIError.retriable` cannot rescue it), and
	// the agent loop appends a synthetic `executed: false` result AFTER the refused
	// assistant message, so state ends with `lastRole: "toolResult"`.
	describe("classifier refusal with emitted tool calls", () => {
		function makeRefusal(content: AssistantMessage["content"]): AssistantMessage {
			const message = makeMessage(content, model);
			message.errorMessage =
				"Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
			message.stopDetails = { type: "refusal" };
			message.errorId = 0;
			return message;
		}

		function toolCall(id: string): AssistantMessage["content"][number] {
			return { type: "toolCall", id, name: "read", arguments: { path: "https://developer.android.com/reference" } };
		}

		function syntheticResult(toolCallId: string): ToolResultMessage<SyntheticToolResultDetails> {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "Tool call was not executed." }],
				isError: true,
				details: { __synthetic: true, source: "assistant_stop_error", executed: false },
				timestamp: Date.now(),
			};
		}

		function realResult(toolCallId: string): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "# Android reference" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryFor(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("retries a refusal whose only tool call provably never executed", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(message.errorId).toBe(0);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry a refusal whose tool call produced a real result", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(recoveryFor(message, [realResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal when only some tool calls went unexecuted", () => {
			const message = makeRefusal([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryFor(message, [realResult("call-1"), syntheticResult("call-2")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal that also committed visible text", () => {
			const message = makeRefusal([{ type: "text", text: "Let me fetch that page." }, toolCall("call-1")]);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal whose tool call has no result at all", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(recoveryFor(message, []).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal when one call is synthetic-paired and another has no result", () => {
			// Reachable in practice: the agent loop skips Cursor server-resolved calls
			// when pairing synthetic results, so a turn can carry one accounted-for
			// call beside one it never paired. Accounting for only some of them is
			// not proof that none ran.
			const message = makeRefusal([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryFor(message, [syntheticResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("keeps a refusal with no tool calls retriable (baseline)", () => {
			const message = makeRefusal([{ type: "thinking", thinking: "reasoning before refusal" }]);
			expect(recoveryFor(message, []).isRetryableError(message)).toBe(true);
		});

		it("retries a malformed function call whose tool call provably never executed", () => {
			const message = makeMessage([toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry a malformed function call whose tool call produced a real result", () => {
			const message = makeMessage([toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [realResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a malformed function call that also committed visible text", () => {
			const message = makeMessage([{ type: "text", text: "Let me fetch that page." }, toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("retries a transport error with a provably unexecuted tool call", () => {
			const message = makeMessage([toolCall("call-1")], model);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});
	});

	// A provider transport error (e.g. `The socket connection was closed
	// unexpectedly` after the model emitted a complete tool call) ends the turn
	// with `stopReason: "error"`; the agent loop pairs every emitted-but-unrun
	// call with a synthetic `executed: false` result. With positive proof that
	// none of them ran, the turn is replay-safe the same way a post-call
	// classifier refusal is, so the configured retry/fallback policy gets its
	// chance instead of surfacing the socket error as terminal.
	describe.each([
		[
			"socket close",
			"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
		],
		[
			"Codex body-read error",
			"Anthropic stream error (api_error): Transport error reading Codex response body: error decoding response body",
		],
	])("%s with emitted tool calls", (_label, errorMessage) => {
		function transportError(content: AssistantMessage["content"]): AssistantMessage {
			const message = makeMessage(content, model);
			message.errorMessage = errorMessage;
			return message;
		}

		function toolCall(id: string): AssistantMessage["content"][number] {
			return { type: "toolCall", id, name: "bash", arguments: { command: "ssh host" } };
		}

		function syntheticResult(toolCallId: string): ToolResultMessage<SyntheticToolResultDetails> {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "Tool call was not executed." }],
				isError: true,
				details: { __synthetic: true, source: "assistant_stop_error", executed: false },
				timestamp: Date.now(),
			};
		}

		function realResult(toolCallId: string): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryForTransport(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("retries when the only tool call provably never executed", () => {
			const message = transportError([toolCall("call-1")]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry when the tool call produced a real result", () => {
			const message = transportError([toolCall("call-1")]);
			const recovery = recoveryForTransport(message, [realResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not retry when a synthetic result is followed by a real result for the same call", () => {
			const message = transportError([toolCall("call-1")]);
			const recovery = recoveryForTransport(message, [syntheticResult("call-1"), realResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not retry when only some tool calls went unexecuted", () => {
			const message = transportError([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryForTransport(message, [realResult("call-1"), syntheticResult("call-2")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("does not retry when the turn also committed visible text", () => {
			const message = transportError([{ type: "text", text: "Connecting..." }, toolCall("call-1")]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry when the tool call has no result at all", () => {
			const message = transportError([toolCall("call-1")]);
			expect(recoveryForTransport(message, []).isRetryableError(message)).toBe(false);
		});

		it("does not retry when one call is synthetic-paired and another has no result", () => {
			const message = transportError([toolCall("call-1"), toolCall("call-2")]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry generated images beside a provably unexecuted call", () => {
			const message = transportError([
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				toolCall("call-1"),
			]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry Anthropic server tools beside a provably unexecuted call", () => {
			const message = transportError([
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
				toolCall("call-1"),
			]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});
	});

	describe("HTTP/2 stream reset after resolved tool calls", () => {
		const nghttp2Internal = "Stream closed with error code NGHTTP2_INTERNAL_ERROR";
		const nghttp2Refused = "Stream closed with error code NGHTTP2_REFUSED_STREAM";
		const stallMessage = "Provider stream stalled while waiting for the next event";

		function cursorMessage(content: AssistantMessage["content"], errorMessage: string): AssistantMessage {
			const message = makeMessage(content, model);
			message.provider = "cursor";
			message.errorMessage = errorMessage;
			return message;
		}

		function execToolCall(id: string, marked = false): AssistantMessage["content"][number] {
			const block: AssistantMessage["content"][number] = {
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: "pwd" },
			};
			if (marked) (block as { [kCursorExecResolved]?: true })[kCursorExecResolved] = true;
			return block;
		}

		function mcpToolCall(id: string): AssistantMessage["content"][number] {
			return {
				type: "toolCall",
				id,
				name: "mcp__databricks_production_execute_sql",
				arguments: { query: "SELECT 1" },
			};
		}

		function realResult(toolCallId: string, toolName = "bash"): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "/workspace" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryForReset(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		function pythonResetMessage(content: AssistantMessage["content"], errorMessage: string): AssistantMessage {
			return {
				...makeMessage(content, model),
				api: "openai-codex-responses",
				provider: "openai-codex",
				errorId: 0,
				errorMessage,
			};
		}

		describe.each([
			[
				"Python HTTP/2 reset",
				"Codex error event: <StreamReset stream_id:1283, error_code:2, remote_reset:True> (code=api_error)",
			],
			[
				"Python HTTP/1.1 chunked body",
				"Codex error event: peer closed connection without sending complete message body (incomplete chunked read) (code=api_error)",
			],
		])("%s recovery", (_label, errorMessage) => {
			it("preserves the replay veto with committed text", () => {
				const message = pythonResetMessage([{ type: "text", text: "Partial answer." }], errorMessage);
				const recovery = recoveryForReset(message, []);
				expect(recovery.isRetryableError(message)).toBe(false);
				expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
			});

			it("continues completed tools through preserved-turn recovery", () => {
				const message = pythonResetMessage([execToolCall("call-1")], errorMessage);
				const recovery = recoveryForReset(message, [realResult("call-1")]);
				expect(recovery.isRetryableError(message)).toBe(false);
				expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
			});

			it("keeps an unresolved tool outside recovery", () => {
				const message = pythonResetMessage([execToolCall("call-1")], errorMessage);
				const recovery = recoveryForReset(message, []);
				expect(recovery.isRetryableError(message)).toBe(false);
				expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
			});
		});

		it("continues a Cursor NGHTTP2_INTERNAL_ERROR after a marked exec result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Internal);
			const recovery = recoveryForReset(message, [realResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("continues a Cursor NGHTTP2_REFUSED_STREAM after a marked exec result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Refused);
			expect(recoveryForReset(message, [realResult("call-1")]).classifyResolvedInterruptedToolTurn(message)).toBe(
				"stream-stall",
			);
		});

		it.each([
			"Request was aborted",
			"Request was aborted.",
			"The operation was aborted",
			"The operation was aborted.",
		])("resumes a generic %s abort after resolved tool calls", errorMessage => {
			const message = cursorMessage([execToolCall("call-1")], errorMessage);
			expect(recoveryForReset(message, [realResult("call-1")]).classifyResolvedInterruptedToolTurn(message)).toBe(
				"reasonless-abort",
			);
		});

		it("continues a Cursor HTTP/2 reset after an unmarked MCP result", () => {
			const message = cursorMessage([mcpToolCall("mcp-1")], nghttp2Internal);
			const recovery = recoveryForReset(message, [realResult("mcp-1", "mcp__databricks_production_execute_sql")]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("continues a Cursor idle stall after an unmarked MCP call", () => {
			const message = cursorMessage([mcpToolCall("mcp-1")], stallMessage);
			const recovery = recoveryForReset(message, [realResult("mcp-1", "mcp__databricks_production_execute_sql")]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("does not continue an HTTP/2 reset whose tool call has no result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Internal);
			expect(recoveryForReset(message, []).classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not continue an HTTP/2 CANCEL reset", () => {
			const message = cursorMessage([execToolCall("call-1", true)], "Stream closed with error code NGHTTP2_CANCEL");
			expect(
				recoveryForReset(message, [realResult("call-1")]).classifyResolvedInterruptedToolTurn(message),
			).toBeUndefined();
		});

		it("matches a Connect-wrapped NGHTTP2 close", () => {
			const message = cursorMessage(
				[mcpToolCall("mcp-1")],
				"Connect error failed_precondition: Error: Stream closed with error code NGHTTP2_INTERNAL_ERROR",
			);
			expect(
				recoveryForReset(message, [
					realResult("mcp-1", "mcp__databricks_production_execute_sql"),
				]).classifyResolvedInterruptedToolTurn(message),
			).toBe("stream-stall");
		});
	});

	describe("premature stream close after resolved tool calls", () => {
		const completionsClose = "OpenAI completions stream closed before a finish_reason was received";
		const responsesClose = "OpenAI responses stream closed before a terminal response event was received";
		const codexClose = "Codex stream ended before terminal completion event";
		const cursorClose = "Cursor stream ended before turnEnded";

		function gatewayMessage(content: AssistantMessage["content"], errorMessage: string): AssistantMessage {
			const message = makeMessage(content, model);
			message.provider = "opencode-go";
			message.errorMessage = errorMessage;
			// Production persists the Transient flag that ProviderResponseError(kind:
			// "incomplete-stream") attaches; the bare message text classifies as 0.
			message.errorId = AIError.create(AIError.Flag.Transient);
			return message;
		}

		function recoveryForClose(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it.each([
			["completions", completionsClose],
			["responses", responsesClose],
			["Codex responses", codexClose],
			["Cursor", cursorClose],
		])("continues a premature %s close after a resolved tool call", (_provider, errorMessage) => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				errorMessage,
			);
			const recovery = recoveryForClose(message, [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "Tool call was not executed." }],
					isError: true,
					details: { __synthetic: true, source: "assistant_stop_error", executed: false },
					timestamp: Date.now(),
				},
			]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("does not continue a premature close whose tool call has no result", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				completionsClose,
			);
			expect(recoveryForClose(message, []).classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not continue an unrelated provider error", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				"Provider returned 500 boom",
			);
			const recovery = recoveryForClose(message, [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "/workspace" }],
					isError: false,
					timestamp: Date.now(),
				},
			]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});
	});

	it("maps an ephemeral fallback hop to the default chain instead of a shared later-listed role", () => {
		const vision = getBundledModel("openai", "gpt-4o-mini");
		if (!vision) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "fallback",
				modelRoles: {
					default: selector,
					vision: selector,
				},
				fallbackChains: {
					vision: [`${vision.provider}/${vision.id}`],
					default: [`${vision.provider}/${vision.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("default");
	});

	it("uses the live vision role when that role shares a model with default", () => {
		const visionFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!visionFallback) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "vision",
				modelRoles: {
					default: selector,
					vision: selector,
				},
				fallbackChains: {
					vision: [`${visionFallback.provider}/${visionFallback.id}`],
					default: [`${visionFallback.provider}/${visionFallback.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("vision");
	});

	it("ignores a recorded role whose assignment no longer matches the active model", () => {
		const vision = getBundledModel("openai", "gpt-4o-mini");
		if (!vision) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "vision",
				modelRoles: {
					default: selector,
					vision: `${vision.provider}/${vision.id}`,
				},
				fallbackChains: {
					vision: [`${vision.provider}/${vision.id}`],
					default: [`${vision.provider}/${vision.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("default");
	});

	it("attaches the default chain to an ephemeral-hopped model that is not default's primary (#12421)", () => {
		const other = getBundledModel("openai", "gpt-4o-mini");
		if (!other) throw new Error("Expected bundled model gpt-4o-mini");
		const recovery = new TurnRecovery(
			createHost(other, modelRegistry, {
				lastModelChangeRole: "fallback",
				modelRoles: {
					default: `${model.provider}/${model.id}`,
				},
				fallbackChains: {
					default: [`${model.provider}/${model.id}`],
				},
			}),
		);
		// Resolving no chain let a wait past retry.maxDelayMs fail-fast with no
		// walk (#12421), for `/model`-chosen models and ephemeral hops alike. A
		// walk that produced the hop stays reachable first through
		// retryFallbackChainKeys' pinned `#activeRetryFallback.role`, so
		// attaching `default` here cannot displace the owning chain.
		expect(recovery.resolveRetryFallbackRole(`${other.provider}/${other.id}`, other)).toBe("default");
	});

	// Gemini reports MALFORMED_FUNCTION_CALL when the model transcribes the call
	// as text (`call:default_api:read{…}`). The text is committed, so the replay
	// retry refuses the turn; the session must still recover by keeping the turn
	// and continuing with a corrective reminder instead of pinning the error.
	describe("malformed function call without a structured tool call", () => {
		function malformedTextTurn(): AssistantMessage {
			const message = makeMessage(
				[
					{
						type: "text",
						text: "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```",
					},
				],
				model,
			);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			return message;
		}

		function continuationHost(message: AssistantMessage) {
			const messages: AgentMessage[] = [message];
			const continues: string[] = [];
			const host = createHost(model, modelRegistry, { messages });
			host.agent = {
				state: { messages },
				appendMessage: (appended: AgentMessage) => messages.push(appended),
			} as never;
			host.scheduleAgentContinue = options => continues.push(options.source);
			return { host, messages, continues };
		}

		it("continues with a corrective developer message when replay is refused", () => {
			const message = malformedTextTurn();
			const { host, messages, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);

			expect(messages[0]).toBe(message);
			const reminder = messages[1];
			expect(reminder?.role).toBe("developer");
			if (reminder?.role !== "developer") throw new Error("expected developer reminder");
			const text =
				typeof reminder.content === "string"
					? reminder.content
					: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(text).toContain("malformed");
			expect(text).toContain("Attempt #1/3");
			expect(continues).toEqual(["malformed-function-call-retry"]);
		});

		it("stops continuing past the per-prompt cap and resets on a new prompt", () => {
			const message = malformedTextTurn();
			const { host, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(false);
			expect(continues).toHaveLength(3);

			recovery.resetForNewPrompt();
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
		});

		it("ignores errors that are not malformed function calls", () => {
			const message = makeMessage([{ type: "text", text: "partial answer" }], model);
			message.errorMessage = "500 Internal Server Error";
			const { host, messages, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(false);
			expect(messages).toHaveLength(1);
			expect(continues).toEqual([]);
		});
	});

	// A stream that dies after text rendered cannot be replayed (duplicated
	// output) and has no tool calls for the preserved-turn continuation, so the
	// session used to stop on "Anthropic stream stalled while waiting for the
	// next event". It must keep the partial turn and continue after it.
	describe("mid-stream transport failure after committed text", () => {
		function stalledTextTurn(
			content: AssistantMessage["content"] = [{ type: "text", text: "Here is the first half of the answ" }],
			errorMessage = "Anthropic stream stalled while waiting for the next event",
		): AssistantMessage {
			const message = makeMessage(content, model);
			message.errorMessage = errorMessage;
			message.errorId = AIError.create(AIError.Flag.Transient);
			return message;
		}

		function continuationHost(message: AssistantMessage, textOutputCommitted = true) {
			const messages: AgentMessage[] = [message];
			const continues: string[] = [];
			const host = createHost(model, modelRegistry, { messages, textOutputCommitted });
			host.agent = {
				state: { messages },
				appendMessage: (appended: AgentMessage) => messages.push(appended),
			} as never;
			host.scheduleAgentContinue = options => continues.push(options.source);
			return { host, messages, continues };
		}

		it("keeps the partial turn and continues with a resume reminder", () => {
			const message = stalledTextTurn();
			const { host, messages, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);

			expect(messages[0]).toBe(message);
			const reminder = messages[1];
			if (reminder?.role !== "developer") throw new Error("expected developer reminder");
			const text =
				typeof reminder.content === "string"
					? reminder.content
					: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(text).toContain("Continue exactly where it stopped");
			expect(text).toContain("Attempt #1/3");
			expect(continues).toEqual(["stream-stall-continue"]);
		});

		it("also resumes HTTP/2 resets, premature closes, and sockets closed mid-body", () => {
			for (const errorMessage of [
				"Stream closed with error code NGHTTP2_INTERNAL_ERROR",
				"OpenAI responses stream closed before a terminal response event was received",
				"The socket connection was closed unexpectedly before the response completed",
				// A gateway/proxy that cuts the upstream stream substitutes an in-band
				// `error` frame for the missing terminal event; the provider reports it
				// as the same envelope truncation a dropped connection produces.
				"Anthropic stream envelope error: error frame received before message_stop (type=server_error code=upstream_stream_truncated): [upstream stream truncated (no completion event; 0 text chars)]",
			]) {
				const message = stalledTextTurn(undefined, errorMessage);
				const { host, continues } = continuationHost(message);
				expect(new TurnRecovery(host).handleCommittedTextStreamStall(message)).toBe(true);
				expect(continues).toEqual(["stream-stall-continue"]);
			}
		});

		it("resumes a Factory Droid Gemini text stream that ends without a finish reason", async () => {
			const truncated = JSON.stringify({
				candidates: [{ content: { role: "model", parts: [{ text: "Here is the first half" }] } }],
			});
			const message = await streamFactoryDroidGemini(
				factoryGemini(),
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					baseUrl: "https://api.factory.ai/api/llm/g/v1",
					headers: { "x-api-provider": "google" },
					fetch: captureFetch([], [truncated]),
				},
			).result();
			const { host, continues } = continuationHost(message);
			expect(new TurnRecovery(host).handleCommittedTextStreamStall(message)).toBe(true);
			expect(continues).toEqual(["stream-stall-continue"]);
		});

		it("stops continuing past the per-prompt cap and resets on a new prompt", () => {
			const message = stalledTextTurn();
			const { host, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(false);
			expect(continues).toHaveLength(3);

			recovery.resetForNewPrompt();
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);
		});

		it("continues a Codex turn the native lane dropped over omp's steer after committed text", () => {
			// The steer rejection drops the response mid-stream like a transport
			// failure; committed text vetoes the replay retry, so without a
			// continuation the session stopped on a pinned "Request failed".
			const codex = getBundledModel("openai-codex", "gpt-6-astra");
			if (!codex) throw new Error("Expected bundled Codex model");
			const message = makeMessage(
				[{ type: "text", text: "RoboOMP's attribution is already in. I'll squash" }],
				codex,
			);
			message.errorMessage =
				"Codex error event: The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. Start a new independent response.create turn instead. (code=unsupported_native_inflight_message)";
			const messages: AgentMessage[] = [message];
			const continues: string[] = [];
			const host = createHost(codex, modelRegistry, { messages, textOutputCommitted: true });
			host.agent = {
				state: { messages },
				appendMessage: (appended: AgentMessage) => messages.push(appended),
			} as never;
			host.scheduleAgentContinue = options => continues.push(options.source);
			const recovery = new TurnRecovery(host);

			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(true);
			expect(messages[0]).toBe(message);
			expect(continues).toEqual(["stream-stall-continue"]);
		});

		it("leaves uncommitted text, tool turns, other errors, and disabled retry to the error path", () => {
			const cases: Array<[AssistantMessage, boolean]> = [
				[stalledTextTurn(), false],
				[
					stalledTextTurn([
						{ type: "text", text: "Reading it now" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
					]),
					true,
				],
				[stalledTextTurn([{ type: "thinking", thinking: "Unshown reasoning" }]), true],
				[stalledTextTurn(undefined, "500 Internal Server Error"), true],
			];
			for (const [message, committed] of cases) {
				const { host, messages, continues } = continuationHost(message, committed);
				expect(new TurnRecovery(host).handleCommittedTextStreamStall(message)).toBe(false);
				expect(messages).toHaveLength(1);
				expect(continues).toEqual([]);
			}

			const message = stalledTextTurn();
			const { host, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);
			recovery.setAutoRetryEnabled(false);
			expect(recovery.handleCommittedTextStreamStall(message)).toBe(false);
			expect(continues).toEqual([]);
		});
	});

	describe("reasonless abort carrying only a fallback boundary", () => {
		// A mid-turn server-side fallback persists a `fallback` boundary block
		// before the fallback model emits anything. An abort right there leaves
		// `[fallback]`: bookkeeping, no output, so the turn is as replay-safe to
		// retry as an empty one.
		function abortedTurn(content: AssistantMessage["content"]): AssistantMessage {
			const message = makeMessage(content, model);
			message.stopReason = "aborted";
			message.errorMessage = "Request was aborted";
			return message;
		}

		it("retries a boundary-only abort and still settles one carrying output", () => {
			const boundary = abortedTurn([
				{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
			]);
			expect(new TurnRecovery(createHost(model, modelRegistry)).isRetryableReasonlessAbort(boundary)).toBe(true);

			const withOutput = abortedTurn([
				{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "text", text: "Partial answer" },
			]);
			expect(new TurnRecovery(createHost(model, modelRegistry)).isRetryableReasonlessAbort(withOutput)).toBe(false);
		});
	});
});
