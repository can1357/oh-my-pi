import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		usage: USAGE,
		stopReason: "error",
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
	} = {},
): TurnRecoveryHost & { activeModel: Model; switches: Model[] } {
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
	const agentState = { messages: options.messages ?? [], systemPrompt: ["Test prompt"], tools: [] };
	const switches: Model[] = [];
	const activeModel = model;

	const host: TurnRecoveryHost & { activeModel: Model; switches: Model[] } = {
		activeModel,
		switches,
		agent: {
			state: agentState,
			replaceMessages(messages: AgentMessage[]) {
				agentState.messages = messages;
			},
			appendMessage(message: AgentMessage) {
				agentState.messages.push(message);
			},
		} as never,
		sessionManager: {
			getLastModelChangeRole: () => options.lastModelChangeRole,
			getBranch: () => [],
			getBranchView: () => [],
			getSessionId: () => "test-session",
			appendModelChange: () => {},
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => host.activeModel,
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
		setModelWithProviderSessionReset: async nextModel => {
			host.activeModel = nextModel;
			host.switches.push(nextModel);
		},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
	return host;
}

describe("TurnRecovery ZYS-1910: <=3000ms retry-after-ms lock handling", () => {
	const model = getBundledModel("openrouter", "deepseek/deepseek-r1");
	const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
	if (!model || !fallbackModel) throw new Error("Expected bundled models");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-short-retry-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const modelRegistrySettings = Settings.isolated();
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: modelRegistrySettings });
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("retries active model without fallback on Attempt 1 when retry-after-ms <= 3000ms", async () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
		};
		const host = createHost(model, modelRegistry, { fallbackChains });
		const recovery = new TurnRecovery(host);

		const message = makeMessage([], model);
		message.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		message.errorId = AIError.classifyMessage(message);

		let emittedDelayMs: number | undefined;
		host.emitSessionEvent = async event => {
			if (event.type === "auto_retry_start") {
				emittedDelayMs = event.delayMs;
			}
		};

		const initiated = await recovery.handleRetryableError(message);
		expect(initiated).toBe(true);
		expect(host.switches).toHaveLength(0);
		expect(host.activeModel).toBe(model);
		expect(emittedDelayMs).toBe(1200);
	});

	it("retries active model without fallback on Attempt 2 when retry-after-ms <= 3000ms", async () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
		};
		const host = createHost(model, modelRegistry, { fallbackChains });
		const recovery = new TurnRecovery(host);

		// First attempt
		const msg1 = makeMessage([], model);
		msg1.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		msg1.errorId = AIError.classifyMessage(msg1);
		await recovery.handleRetryableError(msg1);
		expect(recovery.attempt).toBe(1);
		expect(host.switches).toHaveLength(0);

		// Second attempt
		const msg2 = makeMessage([], model);
		msg2.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		msg2.errorId = AIError.classifyMessage(msg2);
		let emittedDelayMs: number | undefined;
		host.emitSessionEvent = async event => {
			if (event.type === "auto_retry_start") {
				emittedDelayMs = event.delayMs;
			}
		};

		const initiated2 = await recovery.handleRetryableError(msg2);
		expect(initiated2).toBe(true);
		expect(recovery.attempt).toBe(2);
		expect(host.switches).toHaveLength(0);
		expect(host.activeModel).toBe(model);
		expect(emittedDelayMs).toBe(1200);
	});

	it("falls back to chain on Attempt 3 even if retry-after-ms <= 3000ms", async () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
		};
		const host = createHost(model, modelRegistry, { fallbackChains });
		const recovery = new TurnRecovery(host);

		// Attempt 1
		const msg1 = makeMessage([], model);
		msg1.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		msg1.errorId = AIError.classifyMessage(msg1);
		await recovery.handleRetryableError(msg1);

		// Attempt 2
		const msg2 = makeMessage([], model);
		msg2.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		msg2.errorId = AIError.classifyMessage(msg2);
		await recovery.handleRetryableError(msg2);

		// Attempt 3: should fall back to gpt-4o-mini
		const msg3 = makeMessage([], model);
		msg3.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=1200";
		msg3.errorId = AIError.classifyMessage(msg3);
		const initiated3 = await recovery.handleRetryableError(msg3);
		expect(initiated3).toBe(true);
		expect(host.switches.length).toBeGreaterThan(0);
		expect(host.activeModel.id).toBe(fallbackModel.id);
	});

	it("falls back to chain when retry-after-ms > 3000ms even on Attempt 1", async () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
		};
		const host = createHost(model, modelRegistry, { fallbackChains });
		const recovery = new TurnRecovery(host);

		const message = makeMessage([], model);
		message.errorMessage = "Provider returned HTTP 402: Insufficient credits retry-after-ms=3500";
		message.errorId = AIError.classifyMessage(message);

		const initiated = await recovery.handleRetryableError(message);
		expect(initiated).toBe(true);
		expect(host.switches.length).toBeGreaterThan(0);
		expect(host.activeModel.id).toBe(fallbackModel.id);
	});
});
