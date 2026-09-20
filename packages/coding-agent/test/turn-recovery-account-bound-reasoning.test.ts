import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ACCOUNT_BOUND_REASONING_ERROR =
	"400 encrypted reasoning was created for a different account or model\n" +
	"encrypted reasoning was created for a different account or model (type=invalid_request_error param=validation_error)";

function makeAssistantMessage(
	model: Model,
	options: { withProviderPayload?: boolean; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: options.errorMessage ? [] : [{ type: "text", text: "prior turn" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: options.errorMessage ? "error" : "stop",
		errorMessage: options.errorMessage,
		errorStatus: options.errorMessage ? 400 : undefined,
		timestamp: Date.now(),
		...(options.withProviderPayload
			? { providerPayload: { type: "openaiResponsesHistory" as const, provider: model.provider, items: [] } }
			: {}),
	};
}

function createHost(model: Model, modelRegistry: ModelRegistry, messages: AgentMessage[]): TurnRecoveryHost {
	const settings = Settings.isolated({ "retry.baseDelayMs": 0 });
	const agentState = { messages };
	return {
		agent: {
			state: agentState,
			replaceMessages(next: AgentMessage[]) {
				agentState.messages = next;
			},
		} as never,
		sessionManager: { getLastModelChangeRole: () => undefined, getBranch: () => [] } as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
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
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }) as never,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery account-bound reasoning replay", () => {
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled model openai/gpt-4o-mini");

	let tempDir: TempDir;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-account-bound-reasoning-");
		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
	});

	it("drops the surviving assistant message's native replay payload on this exact 400 (no fallback configured)", async () => {
		const priorTurn = makeAssistantMessage(model, { withProviderPayload: true });
		const failedTurn = makeAssistantMessage(model, { errorMessage: ACCOUNT_BOUND_REASONING_ERROR });
		const host = createHost(model, modelRegistry, [priorTurn, failedTurn]);
		const recovery = new TurnRecovery(host);

		const retried = await recovery.handleRetryableError(failedTurn);

		expect(retried).toBe(true);
		const survivingPriorTurn = host.agent.state.messages.find(
			(m): m is AssistantMessage => m.role === "assistant" && m !== failedTurn,
		);
		expect(survivingPriorTurn).toBeDefined();
		expect(survivingPriorTurn?.providerPayload).toBeUndefined();
	});

	it("leaves other assistant messages' native replay payload alone for an unrelated 400", async () => {
		const priorTurn = makeAssistantMessage(model, { withProviderPayload: true });
		const failedTurn = makeAssistantMessage(model, {
			errorMessage: "400 Bad Request: unsupported parameter 'foo'",
		});
		const host = createHost(model, modelRegistry, [priorTurn, failedTurn]);
		const recovery = new TurnRecovery(host);

		await recovery.handleRetryableError(failedTurn);

		const survivingPriorTurn = host.agent.state.messages.find(
			(m): m is AssistantMessage => m.role === "assistant" && m !== failedTurn,
		);
		expect(survivingPriorTurn).toBeDefined();
		expect(survivingPriorTurn?.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: model.provider,
			items: [],
		});
	});
});
