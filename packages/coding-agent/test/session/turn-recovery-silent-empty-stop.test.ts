import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Real-world failure shapes (production session JSONL + #9415/#8511):
 *
 * 1. zero-billed brownout drop:  stop, content=[], usage all zero        -> PROMOTE (flag on)
 * 2. billed-but-dropped filter:  stop, content=[], output>0              -> keep legacy terminal
 * 3. reasoning-only stop:        stop, content=[thinking], output>0      -> not an empty stop at all
 * 4. providerEmptyOutput:        error + EmptyResponse flag, thinking ok -> existing providerEmpty path
 * 5. EOS-only invisible stop:    stop, content=[], output=1              -> NOT promoted (output > 0)
 * 6. cache-served dispatch fail: stop, content=[], cacheRead>0           -> NOT promoted (input processed)
 * 7. prompt-billed empty:        stop, content=[], input>0               -> NOT promoted
 * 8. flag off                    zero-billed shape                       -> legacy terminal behavior
 * 9. flag on + no chain          zero-billed shape                       -> terminal restored
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
	const settings = Settings.isolated({});
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
			appendMessage: () => {},
		} as never,
	};
}

describe("TurnRecovery silentEmptyStopFallback", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-silent-empty-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function makeRecovery(flagOn: boolean) {
		const host = createHost(model, modelRegistry);
		host.settings = Settings.isolated({
			"features.silentEmptyStopFallback": flagOn,
		});
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		host.emitSessionEvent = async event => {
			events.push(event as { type: string });
		};
		const recovery = new TurnRecovery(host);
		return { recovery, events };
	}

	function zeroBilled(): AssistantMessage {
		return makeMessage([], model, { usage: usage({}) });
	}

	async function driveToCap(recovery: TurnRecovery, message: AssistantMessage) {
		let result: "continue" | "terminal" | undefined;
		for (let i = 0; i < 12; i++) {
			result = await recovery.handleEmptyAssistantStop(message);
			if (result === "terminal") break;
		}
		return result;
	}

	it("1. promotes zero-billed clean stop when flag is ON (one-shot budget extension)", async () => {
		const { recovery, events } = makeRecovery(true);
		const msg = zeroBilled();
		for (let i = 0; i < 3; i++) {
			expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		}
		// 4th empty: cap reached -> single silent promotion -> retry scheduled.
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		// SILENT contract: no terminal failure event may fire for the promoted turn.
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false)).toEqual([]);
		// Latch spent: subsequent empties walk the legacy path to terminal.
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		expect(await recovery.handleEmptyAssistantStop(msg)).toBe("continue");
		const final = await recovery.handleEmptyAssistantStop(msg);
		expect(final).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("2. does NOT promote billed-but-dropped (filter) stops — output tokens present", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([], model, { usage: usage({ output: 137 }) });
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
		expect(msg.errorMessage).toContain("provider billed 137 output token");
	});

	it("3. does NOT touch reasoning-only stops (has content; not an empty stop)", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([{ type: "thinking", thinking: "hmm" }], model, {
			usage: usage({ output: 5 }),
		});
		const result = await recovery.handleEmptyAssistantStop(msg);
		// Unsigned thinking has no actionable content: the guard retries (legacy path).
		expect(result).toBe("continue");
		expect(msg.stopReason).toBe("stop");
	});

	it("4. does NOT promote the providerEmptyOutput error path", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([{ type: "thinking", thinking: "partial reasoning" }], model, {
			stopReason: "error",
			errorMessage: "upstream network_error",
			errorId: AIError.create(AIError.Flag.EmptyResponse),
		});
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.errorMessage).toBe("Assistant returned no final output after retry cap; try switching models");
	});

	it("5. does NOT promote EOS-only one-token invisible stop (output=1)", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([], model, { usage: usage({ output: 1 }) });
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("6. does NOT promote when cacheRead > 0 (request WAS processed)", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([], model, { usage: usage({ cacheRead: 4096 }) });
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("7. does NOT promote when input tokens were billed", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([], model, { usage: usage({ input: 24381 }) });
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("6b. does NOT promote when cacheWrite > 0 (prompt processed as cache writes)", async () => {
		const { recovery, events } = makeRecovery(true);
		const msg = makeMessage([], model, { usage: usage({ cacheWrite: 2048 }) });
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
		expect(events.filter(e => e.type === "auto_retry_end" && e.success === false).length).toBe(1);
	});

	it("7b. does NOT promote reasoning-billed empties (output === reasoningTokens)", async () => {
		const { recovery } = makeRecovery(true);
		const msg = makeMessage([], model, {
			usage: usage({ output: 64, reasoningTokens: 64 }),
		});
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("8. flag OFF preserves legacy terminal behavior for zero-billed stops", async () => {
		const { recovery } = makeRecovery(false);
		const msg = zeroBilled();
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
		expect(msg.errorMessage).toContain("/shake images");
	});

	it("9. flag ON with no fallback chain available settles terminal with stop restored", async () => {
		const host = createHost(model, modelRegistry);
		host.settings = Settings.isolated({
			"features.silentEmptyStopFallback": true,
		});
		const recovery = new TurnRecovery(host);
		const msg = zeroBilled();
		const result = await driveToCap(recovery, msg);
		expect(result).toBe("terminal");
		expect(msg.stopReason).toBe("stop");
	});

	it("10. counter resets after a non-empty turn between empties", async () => {
		const { recovery } = makeRecovery(false);
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
		const result = await recovery.handleEmptyAssistantStop(msgB);
		expect(result).toBe("terminal");
	});
});
