/**
 * `extendedContext: false` clamps a premium long-context model's window (e.g. a
 * 1.05M `openai/gpt-5.6-sol` down to its 272K standard-pricing threshold), which
 * makes threshold compaction fire on a session the uncapped model would have
 * carried. {@link SessionMaintenance} explains that once per session.
 *
 * Contracts under test:
 * 1. The notice promises that turning the setting on would have avoided *this*
 *    compaction, so it stays silent whenever the same `shouldCompact` decision
 *    still trips against the full window — a fixed `compaction.thresholdTokens`
 *    is window-independent, and a context past the full window's own threshold
 *    compacts either way.
 * 2. Every threshold-compaction entry point explains itself: the pre-prompt
 *    path, the mid-run tool-loop path, and the post-turn path. A capped model
 *    must not compact silently just because the threshold was crossed during an
 *    ordinary response instead of before a prompt.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	COMPACTION_CHECK_NONE,
	SessionMaintenance,
	type SessionMaintenanceHost,
} from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** `openai/gpt-5.6-sol` bills 2x input above 272K, so the cap clamps it there. */
const CLAMPED_WINDOW = 272_000;
const FULL_WINDOW = 1_050_000;

interface Notice {
	level: string;
	message: string;
}

interface HarnessOptions {
	/** Context tokens every threshold path should see. */
	contextTokens: number;
	thresholdTokens?: number;
	thresholdPercent?: number;
}

describe("extended-context cap explanation", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let cappedModel: Model;
	let notices: Notice[];
	let sessionManager: SessionManager;
	let agent: Agent;
	let autoCompactionCalls: string[];

	beforeAll(async () => {
		resetSettingsForTest();
		// The registry reads the global setting when it applies the clamp.
		await Settings.init({ inMemory: true, overrides: { extendedContext: false } });
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("openai", "sk-test");
		modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("openai", "gpt-5.6-sol");
		if (!model) throw new Error("Expected the bundled openai/gpt-5.6-sol model");
		cappedModel = model;
		// Guard: the rest of this file is meaningless if the fixture is not capped.
		expect(cappedModel.contextWindow).toBe(CLAMPED_WINDOW);
		expect(modelRegistry.cappedExtendedContextWindow(cappedModel)).toBe(FULL_WINDOW);
	});

	beforeEach(() => {
		notices = [];
		autoCompactionCalls = [];
		sessionManager = SessionManager.inMemory();
		// Threshold compaction itself is not under test; record that it was reached
		// so each path proves it ran the explanation on the way in.
		vi.spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async (reason, ...rest) => {
			const options = rest[3];
			autoCompactionCalls.push(`${reason}:${options?.phase ?? "none"}`);
			return COMPACTION_CHECK_NONE;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createMaintenance(options: HarnessOptions): SessionMaintenance {
		agent = new Agent({
			initialState: { model: cappedModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			// Speculation would defer the threshold pass before it can explain.
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": false,
			"compaction.midTurnEnabled": true,
			...(options.thresholdTokens === undefined ? {} : { "compaction.thresholdTokens": options.thresholdTokens }),
			...(options.thresholdPercent === undefined ? {} : { "compaction.thresholdPercent": options.thresholdPercent }),
			// Promotion would take over instead of compacting.
			"contextPromotion.enabled": false,
		});
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("No side stream in this harness");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			model: () => cappedModel,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async () => {},
			emitNotice: (level: string, message: string) => {
				notices.push({ level, message });
			},
			schedulePostPromptTask: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => true,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages,
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			// Both the pre-prompt estimate and the post-compaction residual read
			// this; pinning it makes every path see the same context size.
			getContextBreakdown: () => ({ usedTokens: options.contextTokens }),
			getContextUsage: () => ({ tokens: options.contextTokens }),
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => undefined,
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => COMPACTION_CHECK_NONE,
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	function assistantTurn(contextTokens: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: cappedModel.api,
			provider: cappedModel.provider,
			model: cappedModel.id,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextTokens,
				contextTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	test("a fixed thresholdTokens that also trips at the full window explains nothing", async () => {
		// 100K fixed threshold: 150K compacts against 272K *and* against 1.05M, so
		// `/extended-context on` would not have avoided this compaction.
		const maintenance = createMaintenance({ contextTokens: 150_000, thresholdTokens: 100_000 });
		await maintenance.runPrePromptCompactionIfNeeded([]);

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn"]);
		expect(notices).toEqual([]);
	});

	test("a context past the full window's own threshold explains nothing", async () => {
		// 80% of 1.05M is 840K; a 900K context compacts on either window.
		const maintenance = createMaintenance({ contextTokens: 900_000, thresholdPercent: 80 });
		await maintenance.runPrePromptCompactionIfNeeded([]);

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn"]);
		expect(notices).toEqual([]);
	});

	test("the pre-prompt path explains a compaction the full window would have avoided", async () => {
		// 250K is over 80% of 272K but well under 80% of 1.05M.
		const maintenance = createMaintenance({ contextTokens: 250_000, thresholdPercent: 80 });
		await maintenance.runPrePromptCompactionIfNeeded([]);

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.message).toContain("gpt-5.6-sol is capped at 272K tokens");
		expect(notices[0]?.message).toContain("restores its 1.1M window");
	});

	test("the explanation is emitted at most once per session", async () => {
		const maintenance = createMaintenance({ contextTokens: 250_000, thresholdPercent: 80 });
		await maintenance.runPrePromptCompactionIfNeeded([]);
		await maintenance.runPrePromptCompactionIfNeeded([]);

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn", "threshold:pre_turn"]);
		expect(notices).toHaveLength(1);
	});

	test("the mid-run tool-loop path explains the cap too", async () => {
		const maintenance = createMaintenance({ contextTokens: 250_000, thresholdPercent: 80 });
		const activeMessages: AgentMessage[] = [assistantTurn(250_000)];
		await maintenance.maintainContextMidRun(activeMessages, undefined, {
			willContinue: true,
		} as never);

		expect(autoCompactionCalls).toEqual(["threshold:mid_turn"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toContain("gpt-5.6-sol is capped at 272K tokens");
	});

	test("the post-turn path explains the cap too", async () => {
		const maintenance = createMaintenance({ contextTokens: 250_000, thresholdPercent: 80 });
		await maintenance.checkCompaction(assistantTurn(250_000));

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toContain("gpt-5.6-sol is capped at 272K tokens");
	});

	test("the post-turn path stays silent when the full window would not have helped", async () => {
		const maintenance = createMaintenance({ contextTokens: 150_000, thresholdTokens: 100_000 });
		await maintenance.checkCompaction(assistantTurn(150_000));

		expect(autoCompactionCalls).toEqual(["threshold:pre_turn"]);
		expect(notices).toEqual([]);
	});
});
