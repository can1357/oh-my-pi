import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AdvisorContextMaintenance } from "@oh-my-pi/pi-coding-agent/advisor/context-maintenance";
import {
	ContextMaintenance,
	type ContextMaintenanceHost,
	createCodexCompactionContext,
} from "../src/session/context-maintenance";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AdvisorMaintenanceEvent } from "@oh-my-pi/pi-coding-agent/advisor/maintenance-types";
import { AdvisorTranscriptRecorder } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import type { AdvisorMaintenanceEventSink } from "@oh-my-pi/pi-coding-agent/advisor/maintenance-types";
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
	sessionManager: SessionManager;
	notices: string[];
	settings: Settings;
	maintenanceEvents: AdvisorMaintenanceEvent[];
	host: ContextMaintenanceHost;
}

describe("shared context-maintenance owner parity", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let temporaryDirectory: string;

	beforeAll(async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-parity-"));
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
		authStorage.close();
	});

	function createOwner(
		model: Model,
		overrides: Record<string, unknown> = {},
		throwingSink = false,
		sink?: AdvisorMaintenanceEventSink,
	): OwnerHarness {
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
		const maintenanceEvents: AdvisorMaintenanceEvent[] = [];
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
			captureMaintenanceDiagnosticTarget: () => ({
				advisorId: "test-advisor",
				advisorGeneration: 7,
				sink: (event: AdvisorMaintenanceEvent) => {
					if (throwingSink) throw new Error("diagnostic sink unavailable");
					maintenanceEvents.push(event);
					sink?.(event);
				},
			}),
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
			findLastAssistantMessage: () =>
				agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage,
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
		return {
			agent,
			controller: new ContextMaintenance(host),
			host,
			sessionManager,
			notices,
			settings,
			maintenanceEvents,
		};
	}
	function createAdapter(
		owner: OwnerHarness,
		model: Model,
		sink: AdvisorMaintenanceEventSink,
	): AdvisorContextMaintenance {
		return new AdvisorContextMaintenance({
			name: "test-advisor",
			agent: owner.agent,
			primarySessionManager: owner.sessionManager,
			settings: owner.settings,
			modelRegistry,
			sideStreamFn: async () => {
				throw new Error("side stream not expected");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			obfuscator: undefined,
			model: () => model,
			thinkingLevel: () => "inherit",
			sessionId: () => "advisor-test-session",
			convertToLlmForSideRequest: messages => messages as never,
			prepareSimpleStreamOptions: options => options,
			effectiveServiceTier: () => undefined,
			setModel: () => {},
			emitNotice: () => {},
			createCodexCompactionContext,
			continueReview: async () => {},
			isDisposed: () => false,
			captureMaintenanceSink: () => sink,
		});
	}

	async function durableEvents(stem: string): Promise<AdvisorMaintenanceEvent[]> {
		const manager = await SessionManager.open(path.join(temporaryDirectory, stem, "__advisor.jsonl"));
		try {
			return manager
				.getEntries()
				.flatMap(entry =>
					entry.type === "custom" && entry.customType === "advisor-context-maintenance"
						? [entry.data as AdvisorMaintenanceEvent]
						: [],
				);
		} finally {
			await manager.close();
		}
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

	it("emits actual attempt and commit boundaries with working-journal attribution", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model, { "compaction.methodOrder": ["handoff", "soft"] });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "OBSERVABLE-SUMMARY",
			shortSummary: "observable",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("observable incoming", 5)]);

		expect(owner.maintenanceEvents.map(event => [event.kind, event.status])).toEqual([
			["start", "started"],
			["attempt", "failed"],
			["attempt", "prepared-only"],
			["commit", "applied"],
			["completion", "applied"],
		]);
		const attempts = owner.maintenanceEvents.filter(event => event.kind === "attempt");
		expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId);
		const commit = owner.maintenanceEvents.find(event => event.kind === "commit");
		const boundaryId = owner.sessionManager.getBranch().findLast(entry => entry.type === "compaction")?.id;
		expect(commit?.workingJournalBoundaryEntryId).toBe(boundaryId);
		expect(typeof commit?.workingJournalBoundaryEntryId).toBe("string");
		expect(commit?.before).toEqual({ value: 170_000, source: "provider" });
		expect(commit?.historyChanged).toBe(true);
		expect(commit?.candidateModel).toEqual(attempts[1].candidateModel);
		expect(commit?.method).toBe("soft");
		expect(commit?.after.source).toBe("estimated");
	});

	it("does not let a throwing diagnostic sink change a successful commit", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model, {}, true);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "SINK-FAILURE-SUMMARY",
			shortSummary: "sink failure",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("sink failure incoming", 5)]);

		expect(JSON.stringify(owner.agent.state.messages)).toContain("SINK-FAILURE-SUMMARY");
		expect(owner.maintenanceEvents).toHaveLength(0);
	});

	it("records real checkpoint restoration and explicit reset reasons", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model);
		const events: AdvisorMaintenanceEvent[] = [];
		const recorder = new AdvisorTranscriptRecorder(
			() => path.join(temporaryDirectory, "lifecycle.jsonl"),
			() => temporaryDirectory,
		);
		const sink = recorder.captureMaintenanceSink();
		const maintenance = createAdapter(owner, model, event => {
			events.push(event);
			sink?.(event);
		});
		for (const message of owner.agent.state.messages) maintenance.recordFinalized(message);
		const checkpoint = maintenance.checkpoint();
		const transient = userMessage("transient failed attempt", 10);
		owner.agent.appendMessage(transient);
		maintenance.recordFinalized(transient);

		await maintenance.restoreCheckpoint(checkpoint, "ordinary-provider-retry");
		maintenance.reset("primary-history-rewrite");

		expect(events.map(event => [event.kind, event.status, event.reason])).toEqual([
			["checkpoint", "applied", "ordinary-provider-retry"],
			["reset", "applied", "primary-history-rewrite"],
		]);
		expect(events[0].workingJournalCheckpointId).toBe(checkpoint.id);
		expect(events[1].workingJournalCheckpointId).toBeNull();
		await recorder.flush();
		expect((await durableEvents("lifecycle")).map(event => event.kind)).toEqual(["checkpoint", "reset"]);
		await maintenance.dispose();
		await recorder.close();
	});
	it.each(["slow", "failed"] as const)("keeps %s diagnostic I/O outside the working-history barrier", async mode => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const stem = `io-${mode}`;
		if (mode === "failed") await fs.writeFile(path.join(temporaryDirectory, stem), "not a directory");
		const recorder = new AdvisorTranscriptRecorder(
			() => path.join(temporaryDirectory, `${stem}.jsonl`),
			() => temporaryDirectory,
		);
		const release = Promise.withResolvers<void>();
		if (mode === "slow") await recorder.blockWritesUntil(release.promise);
		const owner = createOwner(
			model,
			{ "compaction.methodOrder": ["handoff", "soft"] },
			false,
			recorder.captureMaintenanceSink(),
		);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "IO-INDEPENDENT-SUMMARY",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		try {
			await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
			expect(JSON.stringify(owner.agent.state.messages)).toContain("IO-INDEPENDENT-SUMMARY");
			expect(compact).toHaveBeenCalledTimes(1);
			expect(owner.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		} finally {
			release.resolve();
			await recorder.close();
		}
		if (mode === "slow") {
			const events = await durableEvents(stem);
			expect(events.map(event => [event.kind, event.status])).toEqual([
				["start", "started"],
				["attempt", "failed"],
				["attempt", "prepared-only"],
				["commit", "applied"],
				["completion", "applied"],
			]);
			expect(events[3].workingJournalBoundaryEntryId).toBe(owner.sessionManager.getLeafId());
		}
	});

	it("drains cancelled foreground maintenance before closing its durable recorder", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model);
		const recorder = new AdvisorTranscriptRecorder(
			() => path.join(temporaryDirectory, "cancelled.jsonl"),
			() => temporaryDirectory,
		);
		const sink = recorder.captureMaintenanceSink();
		if (!sink) throw new Error("missing sink");
		const maintenance = createAdapter(owner, model, sink);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			entered.resolve();
			await release.promise;
			return {
				summary: "STALE-SUMMARY",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		const before = [...owner.agent.state.messages];
		const operation = maintenance.maintainBeforePrompt([userMessage("incoming", 5)], new AbortController().signal);
		await entered.promise;
		let closed = false;
		const disposed = maintenance.dispose().then(async () => {
			await recorder.close();
			closed = true;
		});
		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(closed).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([operation, disposed]);
		}
		expect(owner.agent.state.messages).toEqual(before);
		expect(compact).toHaveBeenCalledTimes(1);
		const events = await durableEvents("cancelled");
		expect(events.some(event => event.kind === "commit")).toBe(false);
		expect(events.find(event => event.kind === "completion")?.status).toBe("cancelled");
		expect(events.find(event => event.kind === "attempt")?.status).toBe("cancelled");
	});

	it.each(["discard", "install"] as const)("records speculative preparation separately from %s", async outcome => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const stem = `speculation-${outcome}`;
		const recorder = new AdvisorTranscriptRecorder(
			() => path.join(temporaryDirectory, `${stem}.jsonl`),
			() => temporaryDirectory,
		);
		const owner = createOwner(model, { "compaction.asyncEnabled": true }, false, recorder.captureMaintenanceSink());
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "SPECULATIVE-SUMMARY",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		owner.controller.maybeStartSpeculativeCompaction(155_000, 200_000);
		await owner.controller.speculationCompletion;
		expect(owner.controller.speculationState).toBe("armed");
		expect(owner.maintenanceEvents.some(event => event.kind === "commit")).toBe(false);
		if (outcome === "discard") {
			owner.controller.cancelSpeculation();
		} else {
			owner.settings.override("compaction.methodOrder", ["handoff", "soft"]);
			await owner.controller.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: 170_000 });
		}
		await recorder.close();
		const events = await durableEvents(stem);
		expect(events.find(event => event.kind === "attempt")?.status).toBe("prepared-only");
		expect(new Set(events.map(event => event.runId)).size).toBe(1);
		expect(compact).toHaveBeenCalledTimes(1);
		if (outcome === "discard") {
			expect(events.find(event => event.kind === "discard")?.status).toBe("discarded");
			expect(events.some(event => event.kind === "commit")).toBe(false);
			expect(JSON.stringify(owner.agent.state.messages)).not.toContain("SPECULATIVE-SUMMARY");
		} else {
			expect(events.find(event => event.kind === "commit")?.method).toBe("soft");
			expect(events.find(event => event.kind === "completion")?.method).toBe("soft");
			expect(events.find(event => event.kind === "commit")?.candidateModel).toEqual(events[1].candidateModel);
			expect(JSON.stringify(owner.agent.state.messages)).toContain("SPECULATIVE-SUMMARY");
		}
	});
	it("retains the actual fallback candidate and distinct provider attempt identities", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const fallback = createMockModel({ id: "fallback-summary", provider: "anthropic", contextWindow: 300_000 });
		const owner = createOwner(model);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model, fallback]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			if (candidate.id === model.id) throw new Error("401 Unauthorized");
			return {
				summary: "FALLBACK-SUMMARY",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
		expect(compact).toHaveBeenCalledTimes(2);
		const attempts = owner.maintenanceEvents.filter(event => event.kind === "attempt");
		expect(attempts.map(event => event.status)).toEqual(["failed", "prepared-only"]);
		expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId);
		const commit = owner.maintenanceEvents.find(event => event.kind === "commit");
		expect(commit?.candidateModel).toEqual({ provider: fallback.provider, id: fallback.id });
		expect(commit?.attemptId).toBe(attempts[1].attemptId);
		expect(JSON.stringify(owner.agent.state.messages)).toContain("FALLBACK-SUMMARY");
	});

	it("keeps opaque native occupancy unknown through completion rather than inventing savings", async () => {
		const bundled = getBundledModel("openai", "gpt-5");
		if (!bundled) throw new Error("missing native fixture");
		const model = { ...bundled, contextWindow: 200_000 };
		const owner = createOwner(model, { "compaction.methodOrder": ["remote"] });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compactionItem = { type: "compaction", encrypted_content: "opaque-native-state" };
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "native summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			preserveData: {
				openaiRemoteCompaction: { provider: "openai", compactionItem, replacementHistory: [compactionItem] },
			},
		}));
		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
		const outcomes = owner.maintenanceEvents.filter(event => event.kind === "commit" || event.kind === "completion");
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every(event => event.after.value === null && event.after.source === "unknown")).toBe(true);
		expect(owner.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("records model promotion without claiming a history rewrite or continuation", async () => {
		const target = createMockModel({ id: "larger-owner", provider: "anthropic", contextWindow: 1_000_000 });
		const model = {
			...createMockModel({ provider: "anthropic", contextWindow: 200_000 }),
			contextPromotionTarget: `${target.provider}/${target.id}`,
		};
		const owner = createOwner(model, { "contextPromotion.enabled": true });
		owner.host.model = () => owner.agent.state.model;
		owner.host.setModelTemporary = async candidate => {
			owner.agent.setModel(candidate);
		};
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model, target]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
		expect(owner.agent.state.model.id).toBe(target.id);
		expect(owner.maintenanceEvents.map(event => [event.kind, event.status])).toEqual([
			["start", "started"],
			["promotion", "applied"],
			["completion", "applied"],
		]);
		const completion = owner.maintenanceEvents.at(-1);
		expect(completion?.ownerContextWindow).toBe(200_000);
		expect(completion?.ownerThreshold).toBe(160_000);
		expect(completion?.candidateModel).toEqual({ provider: target.provider, id: target.id });
		expect(completion?.historyChanged).toBe(false);
		expect(completion?.continuation.decision).toBe("none");
	});
	it("does not report application when the working-journal append fails", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model);
		const before = [...owner.agent.state.messages];
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "UNCOMMITTED-SUMMARY",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		vi.spyOn(owner.sessionManager, "appendCompaction").mockImplementation(() => {
			throw new Error("journal append failed");
		});
		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
		expect(owner.agent.state.messages).toEqual(before);
		expect(owner.maintenanceEvents.some(event => event.kind === "commit" || event.status === "applied")).toBe(false);
		expect(owner.maintenanceEvents.at(-1)?.status).toBe("failed");
	});

	it("does not record a checkpoint restoration over a completed working-history commit", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model);
		const events: AdvisorMaintenanceEvent[] = [];
		const maintenance = createAdapter(owner, model, event => events.push(event));
		for (const message of owner.agent.state.messages) maintenance.recordFinalized(message);
		const checkpoint = maintenance.checkpoint();
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "COMMITTED-RETRY-SUMMARY",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		await maintenance.maintainBeforePrompt([userMessage("incoming", 5)], new AbortController().signal);
		await maintenance.restoreCheckpoint(checkpoint, "ordinary-provider-retry");
		expect(events.some(event => event.kind === "commit")).toBe(true);
		expect(events.some(event => event.kind === "checkpoint")).toBe(false);
		expect(JSON.stringify(owner.agent.state.messages)).toContain("COMMITTED-RETRY-SUMMARY");
		await maintenance.dispose();
	});
	it("retains durable commit attribution when a post-installation callback throws", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const recorder = new AdvisorTranscriptRecorder(
			() => path.join(temporaryDirectory, "installed-callback-failure.jsonl"),
			() => temporaryDirectory,
		);
		const owner = createOwner(model, {}, false, recorder.captureMaintenanceSink());
		owner.host.onHistoryRewrite = () => {
			throw new Error("post-installation callback failed");
		};
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "INSTALLED-BEFORE-CALLBACK",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		await owner.controller.runPrePromptCompactionIfNeeded([userMessage("incoming", 5)]);
		await recorder.close();
		expect(JSON.stringify(owner.agent.state.messages)).toContain("INSTALLED-BEFORE-CALLBACK");
		expect(compact).toHaveBeenCalledTimes(1);
		const events = await durableEvents("installed-callback-failure");
		const commit = events.find(event => event.kind === "commit");
		expect(commit?.status).toBe("applied");
		expect(commit?.workingJournalBoundaryEntryId).toBe(owner.sessionManager.getLeafId());
		expect(events.at(-1)?.status).toBe("failed");
		expect(events.at(-1)?.historyChanged).toBe(true);
	});

	it.each([false, true])("attributes the actual successful handoff model (speculative=%s)", async speculative => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model, {
			"compaction.asyncEnabled": speculative,
			"compaction.methodOrder": ["handoff"],
		});
		owner.host.generateHandoffDocument = async () => ({ document: "Continue the owner's preserved implementation." });
		if (speculative) {
			owner.controller.maybeStartSpeculativeCompaction(155_000, 200_000);
			await owner.controller.speculationCompletion;
			expect(owner.controller.speculationState).toBe("armed");
		}
		await owner.controller.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: 170_000 });
		const outcomes = owner.maintenanceEvents.filter(event => event.kind !== "start");
		expect(outcomes.map(event => event.kind)).toEqual(["attempt", "commit", "completion"]);
		expect(outcomes.every(event => event.method === "handoff")).toBe(true);
		expect(
			outcomes.every(
				event => event.candidateModel?.provider === model.provider && event.candidateModel.id === model.id,
			),
		).toBe(true);
		expect(JSON.stringify(owner.agent.state.messages)).toContain("Continue the owner's preserved implementation.");
	});

	it("drains an ignored-abort speculative backend after blocking maintenance supersedes it", async () => {
		const model = createMockModel({ provider: "anthropic", contextWindow: 200_000 });
		const owner = createOwner(model, { "compaction.asyncEnabled": true, "compaction.thresholdPercent": 85 });
		const events: AdvisorMaintenanceEvent[] = [];
		const maintenance = createAdapter(owner, model, event => events.push(event));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			const speculative = ++calls === 1;
			if (speculative) {
				entered.resolve();
				await release.promise;
			}
			return {
				summary: speculative ? "SUPERSEDED-SUMMARY" : "BLOCKING-SUMMARY",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		await maintenance.maintainBeforePrompt([userMessage("incoming", 5)], new AbortController().signal);
		await entered.promise;
		owner.settings.override("compaction.asyncEnabled", false);
		owner.settings.override("compaction.thresholdPercent", 50);
		await maintenance.maintainBeforePrompt([userMessage("incoming", 6)], new AbortController().signal);
		expect(calls).toBe(2);
		let disposed = false;
		const disposal = maintenance.dispose().then(() => {
			disposed = true;
		});
		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(disposed).toBe(false);
		} finally {
			release.resolve();
			await disposal;
		}
		expect(JSON.stringify(owner.agent.state.messages)).toContain("BLOCKING-SUMMARY");
		expect(JSON.stringify(owner.agent.state.messages)).not.toContain("SUPERSEDED-SUMMARY");
		const speculativeRun = events.find(event => event.trigger === "speculation")?.runId;
		expect(speculativeRun).toBeDefined();
		expect(events.filter(event => event.runId === speculativeRun && event.kind === "commit")).toHaveLength(0);
	});
});
