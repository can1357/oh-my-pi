import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ContextMaintenance,
	type ContextMaintenanceHost,
} from "../src/session/context-maintenance";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(model: Model, text: string, inputTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

interface OwnerHarness {
	agent: Agent;
	controller: ContextMaintenance;
	notices: string[];
	settings: Settings;
}

describe("shared context-maintenance owner parity", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function createOwner(model: Model, overrides: Record<string, unknown> = {}): OwnerHarness {
		const messages: Array<UserMessage | AssistantMessage> = [
			userMessage("owner-private-old-decision", 1),
			assistantMessage(model, "owner-private-old-answer", 1_000, 2),
			userMessage("owner-recent-question", 3),
			assistantMessage(model, "owner-recent-answer", 170_000, 4),
		];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Owner-specific system prompt"], tools: [], messages: [...messages] },
		});
		const sessionManager = SessionManager.inMemory();
		for (const message of messages) sessionManager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.midTurnEnabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			...overrides,
		});
		const notices: string[] = [];
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("soft compaction seam should be stubbed");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => agent.state.systemPrompt,
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			hasExperimentalContextRolloverTools: () => false,
			takeExperimentalContextRolloverRequest: () => false,
			queueExperimentalContextNotesReminder: () => {},
			memoryBackendSession: () => undefined,
			emitSessionEvent: async () => {},
			emitNotice: (_level: string, message: string) => notices.push(message),
			schedulePostPromptTask: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async (context: AgentTurnEndContext | undefined) => {
				if (!context) return true;
				sessionManager.appendMessage(context.message as AssistantMessage);
				for (const result of context.toolResults) sessionManager.appendMessage(result);
				return true;
			},
			findLastAssistantMessage: () => agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			convertToLlmForSideRequest: (ownerMessages: AgentMessage[]) => ownerMessages as never,
			getContextBreakdown: () => ({
				contextWindow: model.contextWindow,
				anchored: true,
				usedTokens: agent.state.messages.some(message => message.role === "compactionSummary") ? 20_000 : 170_000,
				systemPromptTokens: 0,
				systemToolsTokens: 0,
				systemContextTokens: 0,
				skillsTokens: 0,
				messagesTokens: agent.state.messages.some(message => message.role === "compactionSummary")
					? 20_000
					: 170_000,
			}),
			getContextUsage: () => undefined,
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => undefined,
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as ContextMaintenanceHost;
		return { agent, controller: new ContextMaintenance(host), notices, settings };
	}

	it("uses each owner's model window: 170k rewrites a 200k advisor but not a 1m primary at 80%", async () => {
		const advisorModel = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const primaryModel = createMockModel({ id: "primary-million", provider: "anthropic", contextWindow: 1_000_000 });
		const advisorOwner = createOwner(advisorModel);
		const primaryOwner = createOwner(primaryModel);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "OWNER-WINDOW-SUMMARY",
			shortSummary: "owner window",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await advisorOwner.controller.runPrePromptCompactionIfNeeded([userMessage("advisor incoming", 5)]);
		await primaryOwner.controller.runPrePromptCompactionIfNeeded([userMessage("primary incoming", 5)]);

		expect(JSON.stringify(advisorOwner.agent.state.messages)).toContain("OWNER-WINDOW-SUMMARY");
		expect(JSON.stringify(primaryOwner.agent.state.messages)).not.toContain("OWNER-WINDOW-SUMMARY");
		expect(JSON.stringify(primaryOwner.agent.state.messages)).toContain("owner-private-old-decision");
	});

	it("leaves submitted owner history unchanged when automatic maintenance is disabled", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model, { "compaction.enabled": false });
		const before = [...owner.agent.state.messages];
		const compactSpy = vi.spyOn(compactionModule, "compact");

		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("disabled incoming", 5)]);

		expect(owner.agent.state.messages).toEqual(before);
		expect(compactSpy).not.toHaveBeenCalled();
	});
	it("gates an oversized continuing tool loop on mid-turn maintenance rather than generic turn guards", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const createActiveTurn = (owner: OwnerHarness): AgentTurnEndContext => {
			const message: AssistantMessage = {
				...assistantMessage(model, "calling read before continuing", 170_000, 5),
				content: [{ type: "toolCall", id: "midturn-read", name: "read", arguments: { path: "large.ts" } }],
				stopReason: "toolUse",
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "midturn-read",
				toolName: "read",
				content: [{ type: "text", text: "large completed tool output" }],
				isError: false,
				timestamp: 6,
			};
			owner.agent.state.messages.push(message, result);
			return { message, toolResults: [result], willContinue: true };
		};
		const disabled = createOwner(model, { "compaction.midTurnEnabled": false });
		const disabledContext = createActiveTurn(disabled);
		const disabledBefore = [...disabled.agent.state.messages];
		const enabled = createOwner(model);
		const enabledContext = createActiveTurn(enabled);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "MIDTURN-ENABLED-SUMMARY",
			shortSummary: "midturn enabled",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await disabled.controller.maintainContextMidRun(
			disabled.agent.state.messages,
			new AbortController().signal,
			disabledContext,
		);
		await enabled.controller.maintainContextMidRun(
			enabled.agent.state.messages,
			new AbortController().signal,
			enabledContext,
		);

		expect(disabled.agent.state.messages).toEqual(disabledBefore);
		const enabledHistory = JSON.stringify(enabled.agent.state.messages);
		expect(enabledHistory).toContain("MIDTURN-ENABLED-SUMMARY");
		expect(enabledHistory).toContain("large completed tool output");
		expect(enabledHistory.match(/large completed tool output/g)).toHaveLength(1);
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});
});
