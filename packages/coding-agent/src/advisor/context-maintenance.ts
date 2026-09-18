import {
	type Agent,
	type AgentMessage,
	type AgentTurnEndContext,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import {
	calculatePromptTokens,
	isTranscriptUsageAnchor,
	resolveThresholdTokens,
} from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	CodexCompactionContext,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resetOpenAICodexHistoryAfterCompaction } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { ContextUsage } from "../extensibility/extensions/types";
import { deobfuscateSessionContext } from "../secrets/message-transform";
import type { AgentSessionEvent } from "../session/agent-session-events";
import {
	ContextMaintenance,
	COMPACTION_CHECK_NONE,
	type ContextMaintenanceHost,
	type CompactionCheckResult,
} from "../session/context-maintenance";
import {
	dropFailedAssistantTurn,
	removeFailedAssistantFromActiveContext,
	runContextRecoveryTransaction,
	type ContextRecoveryHost,
} from "../session/context-recovery";
import { invalidateConvertToLlmArrayCache } from "../session/messages";
import type { CompactionEntry } from "../session/session-entries";
import { SessionHandoff } from "../session/session-handoff";
import { SessionManager, type SessionManagerJournalSnapshot } from "../session/session-manager";
import { SessionStatsTracker } from "../session/session-stats";
import { sameMessageContent, sessionMessagePersistenceKey } from "../session/turn-persistence";
import {
	ADVISOR_CONTEXT_MAINTENANCE_VERSION,
	type AdvisorContinuationMode,
	type AdvisorHistoryCheckpoint,
	type AdvisorMaintenanceEvent,
	type AdvisorMaintenanceEventSink,
	type AdvisorTurnDisposition,
	advisorMaintenanceReason,
	advisorMaintenanceSafeError,
	createAdvisorMaintenanceRunId,
} from "./maintenance-types";

interface StoredCheckpoint {
	public: AdvisorHistoryCheckpoint;
	journal: SessionManagerJournalSnapshot;
	ledgerSequence: number;
}

interface AttemptMessage {
	sequence: number;
	message: AgentMessage;
}

export interface AdvisorContextMaintenanceOptions {
	readonly name: string;
	readonly agent: Agent;
	readonly primarySessionManager: SessionManager;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly sideStreamFn: StreamFn;
	readonly providerSessionState: Map<string, ProviderSessionState>;
	readonly preferWebsockets: boolean | undefined;
	readonly obfuscator: SecretObfuscator | undefined;
	readonly model: () => Model;
	readonly thinkingLevel: () => ThinkingLevel;
	readonly sessionId: () => string;
	readonly convertToLlmForSideRequest: (messages: AgentMessage[]) => Message[];
	readonly prepareSimpleStreamOptions: (options: SimpleStreamOptions, provider?: string) => SimpleStreamOptions;
	readonly effectiveServiceTier: (model: Model | undefined) => ServiceTier | undefined;
	readonly setModel: (model: Model, thinkingLevel?: ThinkingLevel) => Promise<void> | void;
	readonly emitNotice: (level: "info" | "warning" | "error", message: string, source?: string) => void;
	readonly tryHardFallback?: (message: AssistantMessage, signal: AbortSignal) => Promise<boolean>;
	readonly createCodexCompactionContext: (options: {
		trigger: CodexCompactionContext["trigger"];
		reason: CodexCompactionContext["reason"];
		phase: CodexCompactionContext["phase"];
	}) => CodexCompactionContext;
	readonly continueReview: (mode: AdvisorContinuationMode) => Promise<void>;
	readonly isDisposed: () => boolean;
	readonly onHistoryRewrite?: (reason: string, entry?: CompactionEntry) => void;
	readonly captureMaintenanceSink?: () => AdvisorMaintenanceEventSink | undefined;
}

/** Production owner adapter binding shared maintenance to one advisor generation. */
export class AdvisorContextMaintenance {
	readonly #options: AdvisorContextMaintenanceOptions;
	#journal: SessionManager;
	#stats: SessionStatsTracker;
	#handoff: SessionHandoff;
	#controller: ContextMaintenance;
	#generation = 1;
	#rewriteVersion = 0;
	#checkpointSequence = 0;
	#checkpoints = new Map<string, StoredCheckpoint>();
	#persistedMessages = new Map<string, AgentMessage[]>();
	#activeOperations = new Set<Promise<unknown>>();
	#attemptSequence = 0;
	#scheduledTasks = new Set<AbortController>();
	#scheduledTaskCompletions = new Set<Promise<void>>();
	#attemptMessages: AttemptMessage[] = [];
	#promptResetPending = true;
	#settledSignal: AbortSignal | undefined;
	#persistedEntryIds = new WeakMap<AgentMessage, string>();
	#disposed = false;

	constructor(options: AdvisorContextMaintenanceOptions) {
		this.#options = options;
		this.#journal = this.#createJournal();
		this.#stats = this.#createStats();
		this.#handoff = this.#createHandoff();
		this.#controller = this.#createController();
	}
	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean {
		return this.#controller.contextFitsModel(model, excludedMessage);
	}
	getContextUsage(): ContextUsage | undefined {
		return this.#stats.getContextUsage({
			contextWindow: this.#options.model().contextWindow ?? undefined,
		});
	}

	get generation(): number {
		return this.#generation;
	}

	get journal(): SessionManager {
		return this.#journal;
	}

	get hasPendingUpdates(): boolean {
		return this.#controller.isCompacting || this.#controller.speculationState !== "idle";
	}

	#createJournal(): SessionManager {
		const journal = SessionManager.inMemory(this.#options.primarySessionManager.getCwd());
		journal.adoptArtifactSession(this.#options.primarySessionManager);
		return journal;
	}

	#createStats(): SessionStatsTracker {
		return new SessionStatsTracker({
			session: { systemPrompt: this.#options.agent.state.systemPrompt, agent: this.#options.agent },
			agent: this.#options.agent,
			sessionManager: this.#journal,
			modelRegistry: this.#options.modelRegistry,
			model: this.#options.model,
			sessionId: this.#options.sessionId,
		});
	}

	#createHandoff(): SessionHandoff {
		return new SessionHandoff({
			agent: this.#options.agent,
			sessionManager: this.#journal,
			settings: this.#options.settings,
			modelRegistry: this.#options.modelRegistry,
			sideStreamFn: this.#options.sideStreamFn,
			obfuscator: this.#options.obfuscator,
			model: this.#options.model,
			thinkingLevel: this.#options.thinkingLevel,
			sessionId: this.#options.sessionId,
			baseSystemPrompt: () => this.#options.agent.state.systemPrompt,
			setSkipPostTurnMaintenance: timestamp => {
				this.#controller.skipPostTurnMaintenanceAssistantTimestamp = timestamp;
			},
			obfuscateTextForProvider: text => this.#obfuscateText(text),
			deobfuscateFromProvider: text => this.#options.obfuscator?.deobfuscate(text) ?? text,
			convertMessagesToLlm: async messages => this.#options.convertToLlmForSideRequest(messages),
			prepareSimpleStreamOptions: this.#options.prepareSimpleStreamOptions,
			effectiveServiceTier: this.#options.effectiveServiceTier,
		});
	}

	#createController(): ContextMaintenance {
		const host: ContextMaintenanceHost = {
			agent: this.#options.agent,
			sessionManager: this.#journal,
			settings: this.#options.settings,
			modelRegistry: this.#options.modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: this.#options.sideStreamFn,
			providerSessionState: this.#options.providerSessionState,
			preferWebsockets: this.#options.preferWebsockets,
			model: this.#options.model,
			thinkingLevel: this.#options.thinkingLevel,
			isDisposed: () => this.#disposed || this.#options.isDisposed() || this.#settledSignal?.aborted === true,
			isStreaming: () => this.#options.agent.state.isStreaming,
			isGeneratingHandoff: () => this.#handoff.isGeneratingHandoff,
			promptGeneration: () => this.#generation,
			sessionId: this.#options.sessionId,
			messages: () => this.#options.agent.state.messages,
			baseSystemPrompt: () => this.#options.agent.state.systemPrompt,
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({
				systemPrompt: this.#options.agent.state.systemPrompt,
				agent: this.#options.agent,
			}),
			hasExperimentalContextRolloverTools: () => false,
			takeExperimentalContextRolloverRequest: () => false,
			queueExperimentalContextNotesReminder: () => {},
			memoryBackendSession: () => undefined,
			captureMaintenanceDiagnosticTarget: this.#options.captureMaintenanceSink
				? () => {
						const sink = this.#options.captureMaintenanceSink?.();
						return sink
							? { sink, advisorId: this.#options.name, advisorGeneration: this.#generation }
							: undefined;
					}
				: undefined,
			emitSessionEvent: async (_event: AgentSessionEvent) => {},
			emitNotice: this.#options.emitNotice,
			schedulePostPromptTask: (task, scheduleOptions) => {
				const generation = scheduleOptions?.generation ?? this.#generation;
				const controller = new AbortController();
				const settled = Promise.withResolvers<void>();
				let started = false;
				const completion = settled.promise;
				this.#scheduledTasks.add(controller);
				this.#scheduledTaskCompletions.add(completion);
				const run = async () => {
					if (started) return;
					started = true;
					try {
						if (!this.#isCurrent(generation)) {
							scheduleOptions?.onSkip?.("stale-generation");
							return;
						}
						await task(controller.signal);
						if (!this.#isCurrent(generation)) scheduleOptions?.onSkip?.("stale-generation");
					} catch (error) {
						logger.warn("advisor scheduled maintenance failed", {
							error: advisorMaintenanceSafeError(error).message,
						});
					} finally {
						this.#scheduledTasks.delete(controller);
						this.#scheduledTaskCompletions.delete(completion);
						settled.resolve();
					}
				};
				controller.signal.addEventListener("abort", () => void run(), { once: true });
				if ((scheduleOptions?.delayMs ?? 0) > 0) setTimeout(() => void run(), scheduleOptions?.delayMs);
				else queueMicrotask(() => void run());
			},
			// AdvisorRuntime owns execution of the continuation returned by the
			// settled disposition. These ports only admit it; they never start a
			// second core loop out of band.
			scheduleAgentContinue: scheduleOptions => {
				if (!this.#isCurrent(scheduleOptions.generation ?? this.#generation)) {
					scheduleOptions.onSkip?.("stale-generation");
				}
			},
			scheduleCompactionContinuation: scheduleOptions =>
				this.#isCurrent(scheduleOptions.generation) &&
				scheduleOptions.autoContinue &&
				!scheduleOptions.suppressContinuation,
			persistTurnMessagesForMidRunCompaction: context => this.#persistCompletedTurn(context),
			findLastAssistantMessage: () =>
				this.#options.agent.state.messages.findLast(
					(message): message is AssistantMessage => message.role === "assistant",
				),
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () =>
				deobfuscateSessionContext(this.#journal.buildSessionContext(), this.#options.obfuscator),
			convertToLlmForSideRequest: this.#options.convertToLlmForSideRequest,
			obfuscateTextForProvider: text => this.#obfuscateText(text),
			obfuscatePreparationForProvider: preparation => this.#obfuscatePreparation(preparation),
			closeCodexProviderSessionsForHistoryRewrite: () => this.#closeProviderSessions(),
			resetCodexProviderAfterCompaction: compaction => {
				resetOpenAICodexHistoryAfterCompaction({
					providerSessionState: this.#options.providerSessionState,
					sessionId: this.#options.sessionId(),
					compaction,
				});
				this.#invalidateProviderState();
			},
			onHistoryRewrite: (reason, entry) => this.#commitRewrite(reason, entry),
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => this.#stats.rebaseAfterCompaction(),
			recordAnchoredHistoryRewrite: tokens => this.#stats.recordAnchoredHistoryRewrite(tokens),
			getContextBreakdown: options => this.#stats.getContextBreakdown(options),
			generateHandoffDocument: (instructions, options) => this.#handoff.generateDocument(instructions, options),
			getContextUsage: options => this.#stats.getContextUsage(options),
			shake: (mode, options) => this.#controller.shake(mode, options),
			dropImages: () => this.#controller.dropImages(),
			removeAssistantMessageFromActiveContext: message => this.#removeFailedAssistant(message),
			dropPersistedAssistantTurn: message => this.#dropFailedAssistant(message),
			runRecoveryCompactionWithRollback: (reason, message, allowDefer, options) =>
				this.#runRecoveryCompaction(reason, message, allowDefer, options),
			parseRetryAfterMsFromError: errorMessage =>
				extractProviderRetryHint(this.#options.model().provider, errorMessage),
			setModelTemporary: async (model, thinkingLevel) =>
				this.#options.setModel(model, thinkingLevel === "auto" ? undefined : thinkingLevel),
			abort: async abortOptions => {
				this.#options.agent.abort(abortOptions?.reason);
			},
			abortHandoff: () => this.#handoff.abortHandoff(),
		};
		return new ContextMaintenance(host);
	}

	#recordLifecycleDiagnostic(
		kind: "checkpoint" | "reset",
		status: "applied" | "skipped",
		reason: string,
		checkpointId: string | null = null,
	): void {
		const sink = this.#options.captureMaintenanceSink?.();
		if (!sink) return;
		const model = this.#options.model();
		const contextWindow = model.contextWindow ?? 0;
		const breakdown = this.#stats.getContextBreakdown({ contextWindow });
		const branch = this.#journal.getBranch();
		const boundary = branch.findLastIndex(entry => entry.type === "compaction");
		const providerAnchor = branch
			.slice(boundary + 1)
			.some(entry => entry.type === "message" && isTranscriptUsageAnchor(entry.message));
		const compaction = branch[boundary];
		const opaqueNative =
			!providerAnchor &&
			compaction?.type === "compaction" &&
			isRecord(compaction.preserveData?.openaiRemoteCompaction);
		const measurement: AdvisorMaintenanceEvent["before"] =
			!opaqueNative && breakdown && Number.isFinite(breakdown.usedTokens)
				? {
						value: Math.max(0, Math.floor(breakdown.usedTokens)),
						source: breakdown.anchored && providerAnchor ? "provider" : "estimated",
					}
				: { value: null, source: "unknown" };
		const event: AdvisorMaintenanceEvent = {
			version: ADVISOR_CONTEXT_MAINTENANCE_VERSION,
			kind,
			status,
			runId: createAdvisorMaintenanceRunId(),
			attemptId: null,
			advisorId: this.#options.name,
			advisorGeneration: this.#generation,
			phase: "lifecycle",
			trigger: "lifecycle",
			method: null,
			candidateModel: null,
			ownerModel: { provider: model.provider, id: model.id },
			ownerContextWindow: contextWindow,
			ownerThreshold:
				contextWindow > 0
					? resolveThresholdTokens(contextWindow, this.#options.settings.getGroup("compaction"))
					: 0,
			before: kind === "reset" ? measurement : { value: null, source: "unknown" },
			after: kind === "checkpoint" ? measurement : { value: null, source: "unknown" },
			historyChanged: status === "applied",
			continuation: { decision: "none", mode: null },
			workingJournalBoundaryEntryId: null,
			workingJournalCheckpointId: checkpointId,
			reason: advisorMaintenanceReason(reason),
			error: null,
		};
		try {
			sink(event);
		} catch (error) {
			logger.warn("advisor lifecycle diagnostic sink failed", {
				error: advisorMaintenanceSafeError(error).message,
			});
		}
	}

	#isCurrent(generation: number): boolean {
		return (
			!this.#disposed &&
			generation === this.#generation &&
			!this.#options.isDisposed() &&
			!this.#settledSignal?.aborted
		);
	}

	#invalidateProviderState(): void {
		this.#options.agent.appendOnlyContext?.resetSyncCursor();
	}

	#closeProviderSessions(): void {
		for (const state of this.#options.providerSessionState.values()) state.close();
		this.#options.providerSessionState.clear();
		this.#invalidateProviderState();
	}

	#obfuscateText(text: string | undefined): string | undefined {
		if (!text || !this.#options.obfuscator?.hasSecrets()) return text;
		return this.#options.obfuscator.obfuscate(text);
	}

	#obfuscatePreparation(preparation: CompactionPreparation): CompactionPreparation {
		const obfuscator = this.#options.obfuscator;
		if (!obfuscator?.hasSecrets()) return preparation;
		const previousSummary = this.#obfuscateText(preparation.previousSummary);
		const preserveData = preparation.previousPreserveData;
		const slot = preserveData?.[snapcompact.PRESERVE_KEY];
		let previousPreserveData = preserveData;
		if (preserveData && isRecord(slot) && snapcompact.getPreservedArchive(preserveData)) {
			const obfuscated: Record<string, unknown> = { ...slot };
			let changed = false;
			for (const key of ["text", "textHead", "textTail"] as const) {
				const value = slot[key];
				if (typeof value !== "string" || value.length === 0) continue;
				const next = obfuscator.obfuscate(value);
				if (next === value) continue;
				obfuscated[key] = next;
				changed = true;
			}
			if (changed) previousPreserveData = { ...preserveData, [snapcompact.PRESERVE_KEY]: obfuscated };
		}
		if (previousSummary === preparation.previousSummary && previousPreserveData === preserveData) return preparation;
		return { ...preparation, previousSummary, previousPreserveData };
	}

	#commitRewrite(reason: string, entry?: CompactionEntry): void {
		this.#rewriteVersion++;
		this.#reindexPersistedKeys();
		this.#persistedEntryIds = new WeakMap();
		for (const journalEntry of this.#journal.getBranch()) {
			if (journalEntry.type === "message") this.#persistedEntryIds.set(journalEntry.message, journalEntry.id);
		}
		this.#invalidateProviderState();
		this.#options.onHistoryRewrite?.(reason, entry);
	}

	#isPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		return this.#persistedMessages.get(key)?.some(persisted => sameMessageContent(persisted, message)) === true;
	}

	recordFinalized(message: AgentMessage): void {
		this.#attemptMessages.push({ sequence: ++this.#attemptSequence, message });
		if (this.#isPersisted(message)) return;
		if (
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			message.usage
		) {
			message.contextSnapshot = {
				promptTokens: calculatePromptTokens(message.usage),
				nonMessageTokens:
					this.#stats.pendingNonMessageTokens ??
					computeNonMessageTokens(
						{ systemPrompt: this.#options.agent.state.systemPrompt, agent: this.#options.agent },
						this.#options.agent.tokenizer,
						this.#options.settings.revision,
					),
				compactionEpoch: this.#stats.compactionEpoch,
			};
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "assistant" ||
			message.role === "toolResult" ||
			message.role === "fileMention"
		) {
			const entryId = this.#journal.appendMessage(message);
			this.#persistedEntryIds.set(message, entryId);
			const key = sessionMessagePersistenceKey(message);
			if (key !== undefined) {
				const bucket = this.#persistedMessages.get(key) ?? [];
				bucket.push(message);
				this.#persistedMessages.set(key, bucket);
			}
		}
	}

	async #persistCompletedTurn(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const messages = [context.message, ...context.toolResults];
		const persisted = messages.map(message => this.#isPersisted(message));
		let laterPersisted = false;
		for (let index = persisted.length - 1; index >= 0; index--) {
			if (persisted[index]) {
				laterPersisted = true;
			} else if (laterPersisted) {
				return false;
			}
		}
		for (let index = 0; index < messages.length; index++) {
			if (!persisted[index]) this.recordFinalized(messages[index]);
		}
		return true;
	}

	checkpoint(): AdvisorHistoryCheckpoint {
		this.#promptResetPending = true;
		const id = `${this.#generation}:${++this.#checkpointSequence}`;
		this.#attemptMessages = [];
		const publicCheckpoint: AdvisorHistoryCheckpoint = {
			id,
			generation: this.#generation,
			rewriteVersion: this.#rewriteVersion,
			messages: [...this.#options.agent.state.messages],
		};
		this.#checkpoints.set(id, {
			public: publicCheckpoint,
			journal: this.#journal.captureJournalSnapshot(),
			ledgerSequence: this.#attemptSequence,
		});
		for (const key of this.#checkpoints.keys()) {
			if (key !== id) this.#checkpoints.delete(key);
		}
		return publicCheckpoint;
	}

	messagesSince(checkpoint: AdvisorHistoryCheckpoint): readonly AgentMessage[] {
		const stored = this.#checkpoints.get(checkpoint.id);
		if (!stored) return [];
		return this.#attemptMessages.filter(event => event.sequence > stored.ledgerSequence).map(event => event.message);
	}

	hasCommittedRewrite(checkpoint: AdvisorHistoryCheckpoint): boolean {
		return checkpoint.generation === this.#generation && checkpoint.rewriteVersion !== this.#rewriteVersion;
	}

	async restoreCheckpoint(checkpoint: AdvisorHistoryCheckpoint, reason: string): Promise<void> {
		const stored = this.#checkpoints.get(checkpoint.id);
		if (!stored || checkpoint.generation !== this.#generation || this.hasCommittedRewrite(checkpoint)) return;
		this.#journal.restoreJournalSnapshot(stored.journal);
		const restored = deobfuscateSessionContext(
			this.#journal.buildSessionContext(),
			this.#options.obfuscator,
		).messages;
		this.#options.agent.replaceMessages(restored);
		this.#closeProviderSessions();
		this.#reindexPersistedKeys();
		this.#options.agent.state.error = undefined;
		this.#checkpoints.delete(checkpoint.id);
		this.#recordLifecycleDiagnostic("checkpoint", "applied", reason, checkpoint.id);
	}

	async discardFailedAttempt(checkpoint: AdvisorHistoryCheckpoint): Promise<void> {
		const failed = this.messagesSince(checkpoint).findLast(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
		);
		if (failed) await this.#dropFailedAssistant(failed);
		this.#options.agent.state.error = undefined;
	}

	#trackOperation<T>(operation: Promise<T>): Promise<T> {
		this.#activeOperations.add(operation);
		void operation.finally(() => this.#activeOperations.delete(operation)).catch(() => {});
		return operation;
	}

	maintainBeforePrompt(incoming: AgentMessage[], signal: AbortSignal): Promise<void> {
		return this.#trackOperation(this.#maintainBeforePrompt(incoming, signal));
	}

	async #maintainBeforePrompt(incoming: AgentMessage[], signal: AbortSignal): Promise<void> {
		if (this.#promptResetPending) {
			this.#controller.resetForNewPrompt();
			this.#promptResetPending = false;
		}
		const generation = this.#generation;
		for (const message of this.#options.agent.state.messages) {
			if (!this.#isPersisted(message)) this.recordFinalized(message);
		}
		await this.#controller.runPrePromptCompactionIfNeeded(incoming, signal);
		signal.throwIfAborted();
		if (!this.#isCurrent(generation)) return;
		const nonMessageTokens = computeNonMessageTokens(
			{ systemPrompt: this.#options.agent.state.systemPrompt, agent: this.#options.agent },
			this.#options.agent.tokenizer,
			this.#options.settings.revision,
		);
		const breakdown = this.#stats.getContextBreakdown({
			contextWindow: this.#options.model().contextWindow ?? undefined,
			pendingMessages: incoming,
		});
		this.#stats.setPendingSnapshot({
			promptTokens:
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.#options.agent.tokenizer.countMessages(this.#options.agent.state.messages) +
					this.#options.agent.tokenizer.countMessages(incoming),
			nonMessageTokens,
			cutoffCount: this.#options.agent.state.messages.length + incoming.length,
		});
	}

	maintainMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<boolean> {
		return this.#trackOperation(this.#maintainMidRun(activeMessages, signal, context));
	}

	async #maintainMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<boolean> {
		const generation = this.#generation;
		await this.#controller.maintainContextMidRun(activeMessages, signal, context);
		if (signal?.aborted || !this.#isCurrent(generation)) return false;
		invalidateConvertToLlmArrayCache(activeMessages);
		return true;
	}

	settle(checkpoint: AdvisorHistoryCheckpoint, signal: AbortSignal, error?: unknown): Promise<AdvisorTurnDisposition> {
		return this.#trackOperation(this.#settle(checkpoint, signal, error));
	}

	async #settle(
		checkpoint: AdvisorHistoryCheckpoint,
		signal: AbortSignal,
		error?: unknown,
	): Promise<AdvisorTurnDisposition> {
		const stats = this.#stats;
		this.#settledSignal = signal;
		const onAbort = () => {
			void this.#controller.abortCompaction(new Error("advisor turn cancelled"));
			this.#controller.cancelSpeculation();
			this.#handoff.abortHandoff(new Error("advisor turn cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal.aborted || checkpoint.generation !== this.#generation) return { kind: "terminal", error };
			const failed = this.messagesSince(checkpoint).findLast(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			if (!failed) return { kind: "not-applicable" };
			const hardFallbackApplied =
				failed.stopReason === "error" && (await this.#options.tryHardFallback?.(failed, signal)) === true;
			if (signal.aborted || checkpoint.generation !== this.#generation) return { kind: "terminal", error };
			if (hardFallbackApplied) return { kind: "continue", mode: "retry" };
			const result = await this.#controller.checkCompaction(failed, true, false, true);
			if (signal.aborted || checkpoint.generation !== this.#generation) return { kind: "terminal", error };
			return this.#disposition(result, error);
		} finally {
			signal.removeEventListener("abort", onAbort);
			stats.setPendingSnapshot(undefined);
			if (this.#settledSignal === signal) this.#settledSignal = undefined;
		}
	}

	#disposition(result: CompactionCheckResult, error?: unknown): AdvisorTurnDisposition {
		if (result.continuationScheduled || result.deferredHandoff) {
			return { kind: "continue", mode: result.contextRecovery ? "retry" : "auto" };
		}
		if (result.contextRecovery === true) return { kind: "terminal", error };
		return { kind: "not-applicable" };
	}

	async continue(mode: AdvisorContinuationMode): Promise<void> {
		await this.#options.continueReview(mode);
	}

	#recoveryHost(): ContextRecoveryHost {
		const generation = this.#generation;
		const signal = this.#settledSignal;
		return {
			agent: this.#options.agent,
			sessionManager: this.#journal,
			waitForMessagePersistence: async () => {},
			persistedAssistantEntryId: message => this.#persistedEntryIds.get(message),
			sameAssistantMessage: (left, right) => {
				const leftKey = sessionMessagePersistenceKey(left);
				const rightKey = sessionMessagePersistenceKey(right);
				return (
					((leftKey !== undefined && leftKey === rightKey) || left.timestamp === right.timestamp) &&
					sameMessageContent(left, right)
				);
			},
			withBranchTransition: operation => operation(),
			isCurrent: () => !signal?.aborted && this.#isCurrent(generation),
		};
	}
	#removeFailedAssistant(message: AssistantMessage): void {
		removeFailedAssistantFromActiveContext(this.#recoveryHost(), message);
		this.#invalidateProviderState();
	}

	async #dropFailedAssistant(message: AssistantMessage): Promise<string | undefined> {
		const entryId = await dropFailedAssistantTurn(this.#recoveryHost(), message);
		this.#reindexPersistedKeys();
		this.#invalidateProviderState();
		return entryId;
	}

	async #runRecoveryCompaction(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number; excludeMediaMethods?: boolean },
	): Promise<CompactionCheckResult> {
		const recovery = await runContextRecoveryTransaction(this.#recoveryHost(), message, () =>
			this.#controller.runAutoCompaction(reason, true, false, allowDefer, {
				...options,
				phase: "mid_turn",
				signal: this.#settledSignal,
			}),
		);
		return recovery.kind === "complete" ? recovery.result : COMPACTION_CHECK_NONE;
	}

	#reindexPersistedKeys(): void {
		this.#persistedMessages.clear();
		for (const entry of this.#journal.getBranch()) {
			if (entry.type !== "message") continue;
			const key = sessionMessagePersistenceKey(entry.message);
			if (key === undefined) continue;
			const bucket = this.#persistedMessages.get(key) ?? [];
			bucket.push(entry.message);
			this.#persistedMessages.set(key, bucket);
		}
	}
	async pauseAndDrain(): Promise<void> {
		const scheduled = [...this.#scheduledTaskCompletions];
		for (const controller of this.#scheduledTasks) controller.abort("advisor session transition");
		const speculation = this.#controller.speculationDrainCompletion;
		const cleanup = this.#controller.abortCompaction(new Error("advisor session transition"));
		this.#controller.cancelSpeculation();
		this.#handoff.abortHandoff(new Error("advisor session transition"));
		await Promise.allSettled([
			...this.#activeOperations,
			...scheduled,
			...[cleanup, speculation].filter((value): value is Promise<void> => value !== undefined),
		]);
	}

	reset(reason = "advisor-context-reset"): void {
		this.#recordLifecycleDiagnostic("reset", "applied", reason);
		this.#generation++;
		const speculation = this.#controller.speculationDrainCompletion;
		if (speculation) this.#trackOperation(speculation);
		void this.#controller.abortCompaction(new Error("advisor context reset"));
		this.#controller.cancelSpeculation();
		this.#handoff.abortHandoff(new Error("advisor context reset"));
		for (const controller of this.#scheduledTasks) controller.abort("advisor context reset");
		this.#scheduledTasks.clear();
		this.#checkpoints.clear();
		this.#persistedMessages.clear();
		this.#attemptMessages = [];
		this.#promptResetPending = true;
		this.#rewriteVersion = 0;
		this.#journal = this.#createJournal();
		this.#stats = this.#createStats();
		this.#handoff = this.#createHandoff();
		this.#controller = this.#createController();
	}

	async dispose(): Promise<void> {
		this.#recordLifecycleDiagnostic("reset", "applied", "advisor-context-disposed");
		this.#disposed = true;
		const scheduled = [...this.#scheduledTaskCompletions];
		for (const controller of this.#scheduledTasks) controller.abort("advisor context disposed");
		const speculation = this.#controller.speculationDrainCompletion;
		const cleanup = this.#controller.abortCompaction(new Error("advisor context disposed"));
		this.#controller.cancelSpeculation();
		this.#handoff.abortHandoff(new Error("advisor context disposed"));
		await Promise.allSettled([
			...this.#activeOperations,
			...scheduled,
			...[cleanup, speculation].filter((value): value is Promise<void> => value !== undefined),
		]);
		this.#generation++;
		this.#checkpoints.clear();
		this.#closeProviderSessions();
		this.#attemptMessages = [];
	}
}
