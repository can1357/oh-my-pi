import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { concreteThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Real-world failure shapes (production session JSONL + #9415/#8511):
 *
 * 1. zero-billed brownout drop + usable chain  -> fallback applied, no cap banner
 * 2. billed-but-dropped filter:  stop, content=[], output>0              -> keep legacy terminal
 * 3. reasoning-only stop:        stop, content=[thinking], output>0      -> not an empty stop at all
 * 4. providerEmptyOutput:        error + EmptyResponse flag, thinking ok -> existing providerEmpty path
 * 5. EOS-only invisible stop:    stop, content=[], output=1              -> NOT promoted (output > 0)
 * 6. cache-served dispatch fail: stop, content=[], cacheRead>0           -> NOT promoted (input processed)
 * 7. prompt-billed empty:        stop, content=[], input>0               -> NOT promoted
 * 8. orchestration-billed empty: input/output 0, orchestration/total > 0 -> NOT promoted
 * 9. no usable fallback chain    zero-billed shape                       -> terminal at first cap
 * 10. counter reset after good turn                                      -> no cross-run bleed
 */

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LEGACY_CAP: Array<"continue" | "terminal"> = ["continue", "continue", "continue", "terminal"];

function usage(patch: Partial<Usage>): Usage {
	return { ...USAGE, ...patch };
}

function makeMessage(
	content: AssistantMessage["content"],
	model: Model,
	patch: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "stop",
		timestamp: Date.now(),
		...patch,
	} as AssistantMessage;
}

function createHost(model: Model, modelRegistry: ModelRegistry): TurnRecoveryHost {
	const settings = Settings.isolated({ "retry.baseDelayMs": 0 });
	return {
		agent: { state: { messages: [] }, appendMessage: () => {}, replaceMessages: () => {} } as never,
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
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }) as never,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "test-session",
			appendMessage: () => {},
			appendModelChange: () => {},
		} as never,
	};
}

describe("TurnRecovery zero-billed empty-stop fallback", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
	const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
	if (!fallbackModel) throw new Error("Expected bundled model gpt-4o-mini");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-silent-empty-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const fallbackChains = {
		default: [`${fallbackModel.provider}/${fallbackModel.id}`],
		[`${model.provider}/${model.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
	};

	function makeRecovery(options: { fallbackChains?: Record<string, string[]> } = {}) {
		const host = createHost(model, modelRegistry);
		let currentModel: Model = model;
		host.model = () => currentModel;
		host.setModelWithProviderSessionReset = async next => {
			currentModel = next;
		};
		host.settings = Settings.isolated({
			"retry.baseDelayMs": 0,
			...(options.fallbackChains ? { "retry.fallbackChains": options.fallbackChains } : {}),
		});
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		host.emitSessionEvent = async event => {
			events.push(event as { type: string });
		};
		const recovery = new TurnRecovery(host);
		return { recovery, events, getModel: () => currentModel };
	}

	function zeroBilled(): AssistantMessage {
		return makeMessage([], model, { usage: usage({}) });
	}

	async function settle(
		recovery: TurnRecovery,
		message: AssistantMessage,
	): Promise<Array<"continue" | "terminal" | undefined>> {
		const outcomes: Array<"continue" | "terminal" | undefined> = [];
		for (let i = 0; i < 12; i++) {
			const result = await recovery.handleEmptyAssistantStop(message);
			outcomes.push(result);
			if (result === "terminal" || result === undefined) break;
		}
		return outcomes;
	}

	it("1. zero-billed cap with a usable chain switches models and stays silent", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const msg = zeroBilled();
		for (let i = 0; i < 3; i++) {
			expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		}
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(getModel().id).toBe(fallbackModel.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(true);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false)).toEqual([]);
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("2. does NOT promote billed-but-dropped (filter) stops — output tokens present", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, { usage: usage({ output: 137 }) });
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(msg.stopReason).toBe("stop");
		expect(msg.errorMessage).toContain("provider billed 137 output token");
	});

	it("3. does NOT touch reasoning-only stops (has content; not an empty stop)", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([{ type: "thinking", thinking: "hmm" }], model, {
			usage: usage({ output: 5 }),
		});
		const result = await recovery.handleEmptyAssistantStop(msg);
		// Unsigned thinking has no actionable content: the guard retries (legacy path).
		expect(result).toBe("continue");
		expect(msg.stopReason).toBe("stop");
		expect(getModel().id).toBe(model.id);
	});

	it("4. does NOT promote the providerEmptyOutput error path", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([{ type: "thinking", thinking: "partial reasoning" }], model, {
			stopReason: "error",
			errorMessage: "upstream network_error",
			errorId: AIError.create(AIError.Flag.EmptyResponse),
		});
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(msg.errorMessage).toBe("Assistant returned no final output after retry cap; try switching models");
	});

	it("5. does NOT promote EOS-only one-token invisible stop (output=1)", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, { usage: usage({ output: 1 }) });
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
	});

	it("6. does NOT promote when cacheRead > 0 (request WAS processed)", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, { usage: usage({ cacheRead: 4096 }) });
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
	});

	it("7. does NOT promote when input tokens were billed", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, { usage: usage({ input: 24381 }) });
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
	});

	it("6b. does NOT promote when cacheWrite > 0 (prompt processed as cache writes)", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, { usage: usage({ cacheWrite: 2048 }) });
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
	});

	it("7b. does NOT promote reasoning-billed empties (output === reasoningTokens)", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, {
			usage: usage({ output: 64, reasoningTokens: 64 }),
		});
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
	});

	it("8. does NOT promote orchestration-billed empties (Responses sidecar usage)", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, {
			usage: usage({
				totalTokens: 70,
				orchestration: { input: 25, output: 40, cacheRead: 5 },
			}),
		});
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
		expect(msg.stopReason).toBe("stop");
	});

	it("8b. does NOT promote premium-request or cost.total billed empties", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const premium = makeMessage([], model, { usage: usage({ premiumRequests: 1 }) });
		expect(await settle(recovery, premium)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);

		const { recovery: recovery2, getModel: getModel2 } = makeRecovery({ fallbackChains });
		const charged = makeMessage([], model, {
			usage: usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } }),
		});
		expect(await settle(recovery2, charged)).toEqual(LEGACY_CAP);
		expect(getModel2().id).toBe(model.id);
	});

	it("8c. does NOT promote credit-meter billed empties (Devin committedCost/acuCost)", async () => {
		const { recovery, getModel } = makeRecovery({ fallbackChains });
		const msg = makeMessage([], model, {
			usage: usage({ credits: { cost: 0, committedCost: 2, acuCost: 0.25 } }),
		});
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
	});

	it("8d. does NOT promote a final zero-billed stop when earlier stops in the cycle were billed", async () => {
		const { recovery, events, getModel } = makeRecovery({ fallbackChains });
		const billed = makeMessage([], model, { usage: usage({ input: 100 }) });
		expect(await recovery.handleEmptyAssistantStop(billed)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(billed)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(billed)).toBe("continue");
		const finalZero = zeroBilled();
		expect(await settle(recovery, finalZero)).toEqual(["terminal"]);
		expect(getModel().id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
	});

	it("9. no usable fallback chain settles terminal at the first cap", async () => {
		const { recovery, events, getModel } = makeRecovery();
		const msg = zeroBilled();
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(getModel().id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
		expect(msg.stopReason).toBe("stop");
	});

	it("9b. same-model effort-only chain does not count as takeover", async () => {
		const sameModelChain = {
			[`${model.provider}/${model.id}:high`]: [`${model.provider}/${model.id}:low`],
			[`${model.provider}/${model.id}`]: [`${model.provider}/${model.id}:low`],
		};
		const host = createHost(model, modelRegistry);
		let currentModel: Model = model;
		let thinking: ConfiguredThinkingLevel | undefined = ThinkingLevel.High;
		host.model = () => currentModel;
		host.thinkingLevel = () => concreteThinkingLevel(thinking);
		host.configuredThinkingLevel = () => thinking;
		host.setThinkingLevel = next => {
			thinking = next;
		};
		host.setModelWithProviderSessionReset = async next => {
			currentModel = next;
		};
		host.settings = Settings.isolated({
			"retry.baseDelayMs": 0,
			"retry.fallbackChains": sameModelChain,
		});
		const events: Array<{ type: string; success?: boolean }> = [];
		host.emitSessionEvent = async event => {
			events.push(event as { type: string });
		};
		const recovery = new TurnRecovery(host);
		const msg = zeroBilled();
		expect(await settle(recovery, msg)).toEqual(LEGACY_CAP);
		expect(currentModel.id).toBe(model.id);
		expect(events.some(e => e.type === "retry_fallback_applied")).toBe(false);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
	});

	it("10. counter resets after a non-empty turn between empties", async () => {
		const { recovery } = makeRecovery();
		const msgA = zeroBilled();
		await recovery.handleEmptyAssistantStop(msgA);
		await recovery.handleEmptyAssistantStop(msgA);
		const good = makeMessage([{ type: "text", text: "ok" }], model, {
			usage: usage({ output: 10 }),
		});
		await recovery.handleEmptyAssistantStop(good);
		const msgB = zeroBilled();
		expect(await recovery.handleEmptyAssistantStop(msgB)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msgB)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msgB)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msgB)).toBe("terminal");
	});

	it("11. ordinary hardErrorFallback settles an in-flight saga when no candidate switches", async () => {
		const { recovery, events } = makeRecovery();
		const transient = makeMessage([], model, {
			stopReason: "error",
			errorMessage: "503 service unavailable: overloaded_error",
			errorId: AIError.create(AIError.Flag.Transient),
		});
		expect(await recovery.handleRetryableError(transient)).toBe(true);
		expect(events.some(e => e.type === "auto_retry_start")).toBe(true);

		const hard = makeMessage([], model, {
			stopReason: "error",
			errorMessage: "model refused permanently",
			errorId: AIError.create(),
		});
		// Ordinary hard-error path (agent-session) — no empty-stop cap owns settlement.
		expect(await recovery.handleRetryableError(hard, { hardErrorFallback: true })).toBe(false);
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
	});
});
