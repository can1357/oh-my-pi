import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ShakeResult } from "@oh-my-pi/pi-coding-agent/session/shake-types";

const CONTEXT_WINDOW = 100_000;
const THRESHOLD = 50_000;
/** Above the 80% recovery band, so an auto-shake that frees little still falls back. */
const TRIGGER_TOKENS = THRESHOLD + 10_000;
const DEFAULT_ORDER: CompactionMethod[] = ["remote", "snapcompact", "handoff", "shake", "soft"];

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("auto-compaction fallback after a failed shake", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;
	let agent: Agent;
	/** `action` of every `auto_compaction_start`, in the order the pass ran them. */
	let startedActions: string[];
	let handoffCalls: number;
	let shakeCalls: number;

	function createMaintenance(options: { handoffDocument?: string } = {}): SessionMaintenance {
		agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": DEFAULT_ORDER,
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
		});
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			sideStreamFn: async () => {
				throw new Error("The compact seam should be used instead of the side stream");
			},
			providerSessionState: new Map(),
			preferWebsockets: () => undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isSessionTransitioning: () => false,
			waitForIdle: async () => {},
			promptGeneration: () => 0,
			hasExperimentalContextRolloverTools: () => false,
			queueExperimentalContextNotesReminder: () => {},
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async (event: { type: string; action?: string }) => {
				if (event.type === "auto_compaction_start" && event.action) startedActions.push(event.action);
			},
			emitNotice: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => false,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			replaceMessagesFromSessionContext: (messages: AgentMessage[]) => agent.replaceMessages(messages),
			persistEvalStateContext: () => {},
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
			buildLiveProviderContext: async (): Promise<Context> => ({ messages: [] }),
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			getPromptCacheKeyForModel: () => undefined,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async (): Promise<ShakeResult> => {
				shakeCalls++;
				// Reclaims a little, but the context stays above the recovery band:
				// exactly the "auto-shake did not free enough" fallback trigger.
				return { mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 100 };
			},
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async (): Promise<string | undefined> => {
				handoffCalls++;
				return options.handoffDocument;
			},
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("aimlapi", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		// Text-only, no provider-native compaction: `remote` and `snapcompact` are
		// never selectable, so the order effectively reduces to handoff/shake/soft.
		const bundled = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!bundled) throw new Error("Expected built-in model");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMessage("conversation ".repeat(8_000)));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage(userMessage("latest request"));
		startedActions = [];
		handoffCalls = 0;
		shakeCalls = 0;
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "soft summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restarts at the top of the configured order and reaches handoff", async () => {
		// Resuming at `shake` is the fallback state the order produces once an
		// earlier preference was passed over. The user configured handoff ahead of
		// shake, so a shake that frees too little must land on handoff — not skip
		// to the soft summary that merely follows shake in the list (#19603).
		maintenance = createMaintenance({ handoffDocument: "# Handoff\n\nstate" });

		await maintenance.runAutoCompaction("threshold", false, {
			triggerContextTokens: TRIGGER_TOKENS,
			methodIndex: DEFAULT_ORDER.indexOf("shake"),
		});

		expect(startedActions).toEqual(["shake", "handoff"]);
		expect(shakeCalls).toBe(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.method : undefined).toBe("handoff");
	});

	it("ends at the soft summary without re-running an attempted method", async () => {
		// Handoff produces no document, so the chain reaches shake; the restart
		// must skip the handoff that already failed and shake itself, leaving the
		// soft summary — a failed shake may never loop back onto its own order.
		maintenance = createMaintenance({ handoffDocument: undefined });

		await maintenance.runAutoCompaction("threshold", false, {
			triggerContextTokens: TRIGGER_TOKENS,
		});

		expect(startedActions).toEqual(["handoff", "shake", "context-full"]);
		expect(handoffCalls).toBe(1);
		expect(shakeCalls).toBe(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("soft summary");
	});
});
