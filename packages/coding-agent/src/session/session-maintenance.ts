/** Context maintenance for an active coding-agent session. */

import { scheduler } from "node:timers/promises";
import {
	type Agent,
	type AgentMessage,
	type AgentTurnEndContext,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	applyShakeRegions,
	CompactionCancelledError,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectShakeRegions,
	compact,
	compactionContextTokens,
	computeFileLists,
	createCompactionSummaryMessage,
	DEFAULT_SHAKE_CONFIG,
	type CompactionSettings as EngineCompactionSettings,
	effectiveReserveTokens,
	invalidateMessageCache,
	isTranscriptUsageAnchor,
	NativeCompactionError,
	prepareCompaction,
	RESCUE_SHAKE_CONFIG,
	remotePreserveReusable,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	type ShakeConfig,
	type ShakeRegion,
	type SummaryOptions,
	shouldCompact,
	shouldUseProviderNativeCompaction,
	upsertFileOperations,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { ProtectedToolMatcher } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, CodexCompactionContext, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../config/model-registry";
import { MODEL_ROLE_IDS } from "../config/model-roles";
import type { CompactionSettings as ConfiguredCompactionSettings, Settings } from "../config/settings";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { GoalModeState } from "../goals/state";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackendOperationContext } from "../memory-backend/types";
import type { NonMessageTokenSource } from "../modes/utils/context-usage";
import { computeNonMessageTokens } from "../modes/utils/context-usage";
import { createPlanReadMatcher } from "../plan-mode/plan-protection";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ContextUsageBreakdown, HandoffResult, SessionHandoffOptions } from "./agent-session-types";
import { findCompactMode } from "./compact-modes";
import {
	type CompactionMethod,
	canUseRemoteCompaction,
	DEFAULT_COMPACTION_METHOD_ORDER,
	resolveCompactionMethodOrder,
	resolveMethodSettings,
	resolveSpeculationMethod,
} from "./compaction-methods";
import { convertToLlm, stripImagesFromMessage } from "./messages";
import { isTerminalTextAssistantAnswer } from "./queued-messages";
import {
	resolveCompactionConfiguredTarget,
	resolveContextPromotionConfiguredTarget,
	resolveRoleModelFull,
} from "./role-models";
import type { SessionContext } from "./session-context";
import { getLatestCompactionEntry, getOpenAiRemoteCompactionPayload } from "./session-context";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";
import { resolveSpeculationLeadTokens, SPECULATION_LEAD_MIN_TOKENS } from "./speculation-lead";

export type CompactionCheckResult = Readonly<{
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}>;

/** Shared no-op result for dispatcher paths that perform no maintenance. */
export const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
};
const COMPACTION_CHECK_DEFERRED_HANDOFF: CompactionCheckResult = {
	deferredHandoff: true,
	continuationScheduled: false,
};
const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: true,
};
const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

/** Whether a configured preference list contains at least one automatic method. */
function hasConfiguredCompactionMethod(settings: ConfiguredCompactionSettings): boolean {
	return resolveCompactionMethodOrder(settings.methodOrder).length > 0;
}

/**
 * User-facing notice for a compaction dead end: maintenance freed too little
 * to retry safely. `remedies` names the recovery actions left on the emitting
 * path — by the time the post-pass dead end fires, the tiered rescue has
 * already attempted both elide and image-drop automatically.
 */
function compactionDeadEndWarning(remedies: string): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		`The most recent turn alone is too large to reduce further; ${remedies} or switch to a larger-context model.`
	);
}

/** Honest-skip notice for a payload-shaped HTTP 413 where compaction was correctly withheld (#9235). */
function payloadRejectionNotice(storedTokens: number, contextWindow: number): string {
	const remedies =
		"Token compaction cannot shrink bytes or image budgets; reduce or remove archived image frames (e.g. switch compaction.methodOrder away from snapcompact) or raise the server/proxy body limit.";
	if (contextWindow <= 0) {
		return `The provider rejected the request size or media budget (HTTP 413), and this model has no known context window to compare against — this is NOT a token-context problem. ${remedies}`;
	}
	const headroom = Math.max(0, Math.floor(contextWindow - storedTokens));
	return `The provider rejected the request size or media budget (HTTP 413), but ~${headroom.toLocaleString("en-US")} tokens of headroom remain locally — this is NOT a token-context problem. ${remedies}`;
}

/** Dead-end notice when provider-reported usage proves context overflow but no recovery exists (#9235). */
function usageOverflowDeadEndNotice(reportedInputTokens: number, contextWindow: number): string {
	const windowLabel = contextWindow > 0 ? contextWindow.toLocaleString("en-US") : "unknown";
	return (
		`The provider reports ~${reportedInputTokens.toLocaleString("en-US")} input tokens against a ${windowLabel}-token context window — this IS a token-context problem, but automatic compaction is unavailable to shrink it. ` +
		"Enable a compaction method (compaction.enabled with a configured methodOrder), reduce the conversation's token usage, or switch to a larger-context model."
	);
}

/** Creates one provider-scoped compaction lifecycle descriptor. */
export function createCodexCompactionContext(options: {
	trigger: CodexCompactionContext["trigger"];
	reason: CodexCompactionContext["reason"];
	phase: CodexCompactionContext["phase"];
}): CodexCompactionContext {
	return {
		operationId: crypto.randomUUID(),
		trigger: options.trigger,
		reason: options.reason,
		phase: options.phase,
		strategy: "memento",
	};
}

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL — "long" retention (the OAuth default) is 1h — or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * check shared by the shake tail and the context-full / snapcompact tail. A
 * pass counts as having resolved threshold pressure only when residual context
 * lands at or below `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against
 * the raw threshold lets a pass keep reclaiming a trickle of the previous
 * turn's output and land just under the line every turn, sustaining the
 * auto-continue dead loop reported in #2275; the same band stops the
 * context-full / snapcompact tail from re-firing on a history whose single
 * most-recent kept turn already exceeds the threshold (the snapcompact thrash).
 */
const COMPACTION_RECOVERY_BAND = 0.8;

/** Payload-shaped 413s share text patterns with overflow; trust the payload classification when local
 *  occupancy stays under this ceiling (≥10% headroom) and reported usage stays within the window (#9235). */
const PAYLOAD_REJECTION_OCCUPANCY_CEILING = 0.9;

/** A speculation-produced compaction result, ready to commit at threshold. */
interface ArmedSpeculation {
	result: CompactionResult;
	action: "context-full" | "handoff" | "remote";
	method: CompactionMethod;
	codexCompaction?: CodexCompactionContext;
	/** Last branch entry covered by the speculated summary's source snapshot. */
	snapshotLeafId: string;
	/** Context size when speculation started; drives refresh-on-growth. */
	contextTokensAtStart: number;
}

/** One background speculative-compaction run and (once resolved) its armed result. */
interface SpeculationRun {
	controller: AbortController;
	promise: Promise<void>;
	contextTokensAtStart: number;
	armed?: ArmedSpeculation;
}

function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...hookPreserveData, ...resultPreserveData };
	return snapcompact.stripPreservedArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}

/** Wrap a handoff document as a compaction summary: append the cumulative file-operations tag and derive entry details. */
function handoffSummaryFromDocument(
	document: string,
	preparation: CompactionPreparation,
): { summary: string; details: CompactionDetails } {
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		summary: upsertFileOperations(document, readFiles, modifiedFiles, preparation.fileOps.read),
		details: { readFiles, modifiedFiles },
	};
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionMaintenanceHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner: ExtensionRunner | undefined;
	sideStreamFn: StreamFn;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isGeneratingHandoff(): boolean;
	promptGeneration(): number;
	sessionId(): string;
	messages(): AgentMessage[];
	baseSystemPrompt(): string[];
	goalModeState(): GoalModeState | undefined;
	planReferencePath(): string;
	nonMessageTokenSource(): NonMessageTokenSource;
	memoryBackendSession(): MemoryBackendOperationContext["session"];
	emitSessionEvent(event: AgentSessionEvent, options?: { detachExtensions?: boolean }): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: (reason: "aborted" | "stale-generation") => void },
	): void;
	scheduleAgentContinue(options: {
		source: string;
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onSkip?: (
			reason:
				| "aborted"
				| "stale-generation"
				| "session-unavailable"
				| "should-continue-false"
				| "post-restore-unavailable",
		) => void;
		onError?: () => void;
	}): void;
	scheduleCompactionContinuation(options: {
		generation: number;
		autoContinue: boolean;
		terminalTextAnswer: boolean;
		suppressContinuation: boolean;
	}): boolean;
	persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean>;
	findLastAssistantMessage(): AssistantMessage | undefined;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	drainStrandedQueuedMessages(): void;
	buildDisplaySessionContext(): SessionContext;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	obfuscateTextForProvider(text: string | undefined): string | undefined;
	obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation;
	closeCodexProviderSessionsForHistoryRewrite(): void;
	resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void;
	resetPlanReference(): void;
	syncTodoPhasesFromBranch(): void;
	resetAdvisorRuntimes(reason?: string): void;
	rebaseAfterCompaction(): void;
	recordAnchoredHistoryRewrite(tokensRemoved: number): void;
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined;
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined;
	shake(mode: ShakeMode, options?: { config?: ShakeConfig; signal?: AbortSignal }): Promise<ShakeResult>;
	dropImages(): Promise<{ removed: number }>;
	generateHandoffDocument(
		customInstructions?: string,
		options?: SessionHandoffOptions,
	): Promise<HandoffResult | undefined>;
	removeAssistantMessageFromActiveContext(message: AssistantMessage): void;
	dropPersistedAssistantTurn(message: AssistantMessage): Promise<string | undefined>;
	runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult>;
	parseRetryAfterMsFromError(errorMessage: string): number | undefined;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		preserveCompaction?: boolean;
	}): Promise<void>;
	abortHandoff(): void;
}

/** Owns compaction, pruning, shake, promotion, and automatic context maintenance. */
export class SessionMaintenance {
	#compactionAbortController: AbortController | undefined;
	/** Resolves after an active manual compaction has reconnected the agent subscription. */
	#manualCompactionCleanup: Promise<void> | undefined;
	#autoCompactionAbortController: AbortController | undefined;
	/**
	 * Live tool-loop contexts parked after mid-turn maintenance hit a no-progress
	 * dead end. Membership suppresses the repeated rescue + warning while no cut
	 * point exists; {@link maintainContextMidRun} re-arms the entry once a later
	 * tool result makes `prepareCompaction` viable again.
	 */
	readonly #midTurnCompactionDeadEnds = new WeakSet<AgentMessage[]>();
	/**
	 * Carries a mid-turn dead end across the loop's final answer to the next
	 * pre-prompt check. That check must not warn again for the same oversized
	 * persisted turn, but a new agent loop still gets its own live-array guard.
	 */
	#midTurnDeadEndPendingPrePrompt = false;
	/** In-flight or armed background speculative compaction, if any. */
	#speculation: SpeculationRun | undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined;
	readonly #host: SessionMaintenanceHost;

	get #model(): Model | undefined {
		return this.#host.model();
	}

	get #tokenizer() {
		return this.#host.agent.tokenizer;
	}

	get #goalModeState(): GoalModeState | undefined {
		return this.#host.goalModeState();
	}

	constructor(host: SessionMaintenanceHost) {
		this.#host = host;
	}

	/** Whether manual or automatic context maintenance is active. */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** Background speculative-compaction state, for UI indicators. */
	get speculationState(): "idle" | "running" | "armed" {
		const run = this.#speculation;
		if (!run) return "idle";
		return run.armed ? "armed" : "running";
	}

	/** Completion of the current speculative pass, used to resume maintenance skipped during its handoff. */
	get speculationCompletion(): Promise<void> | undefined {
		return this.#speculation?.promise;
	}

	/** Abort and discard any in-flight or armed speculative compaction. */
	cancelSpeculation(): void {
		const run = this.#speculation;
		if (!run) return;
		this.#speculation = undefined;
		run.controller.abort();
	}

	/** Assistant timestamp whose post-turn maintenance must be skipped once. */
	get skipPostTurnMaintenanceAssistantTimestamp(): number | undefined {
		return this.#skipPostTurnMaintenanceAssistantTimestamp;
	}

	set skipPostTurnMaintenanceAssistantTimestamp(timestamp: number | undefined) {
		this.#skipPostTurnMaintenanceAssistantTimestamp = timestamp;
	}

	/**
	 * Emit a compaction lifecycle event. Mid-turn callers detach only extension
	 * fan-out for post-commit events; ordered subscriber delivery still completes
	 * before maintenance returns.
	 */
	#emitLifecycleEvent(event: AgentSessionEvent, detach: boolean): Promise<void> {
		return this.#host.emitSessionEvent(event, detach ? { detachExtensions: true } : undefined);
	}
	/**
	 * Append plan-read protection to a prune/shake config so the active plan
	 * file survives compaction alongside skill reads (the config defaults
	 * already carry skill protection). The matcher reads the current plan
	 * reference path at match time, so retitled plans are covered.
	 */
	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#host.planReferencePath());
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.#host.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#tokenizer,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.#host.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#host.sessionManager.rewriteEntries();
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.resetAdvisorRuntimes("prune-tool-outputs");
		this.#host.syncTodoPhasesFromBranch();
		this.#host.closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Per-turn stale-result pass: prune older `read` results that a newer read
	 * of the same file has made stale, plus results their tool flagged
	 * contextually useless. Cache-aware (only fires when the suffix after a
	 * candidate is small or the session has been idle long enough that the
	 * provider prompt cache is cold), so it is cheap to run every turn. Gated
	 * on the `compaction.supersedeReads` and `compaction.dropUseless` settings.
	 *
	 * Persists via `rewriteEntries` like every other history rewrite — the
	 * session file must match the live (pruned) context or file-based forks
	 * (`/fork`, `/tan`) and resume rebuild a divergent prefix and cold-miss the
	 * provider prompt cache.
	 */
	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const { supersedeReads, dropUseless } = this.#host.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = this.#host.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#tokenizer,
			this.#withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#host.sessionManager.rewriteEntries();
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.resetAdvisorRuntimes("prune-stale-tool-results");
		this.#host.syncTodoPhasesFromBranch();
		this.#host.closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Strip image content blocks from every message on the current branch and
	 * persist the rewrite. Walks `SessionManager.getBranch()` in place — both
	 * `SessionMessageEntry.message` and `CustomMessageEntry.content` arrays
	 * are mutated, then `rewriteEntries` durably commits the new shape. The
	 * agent's runtime view is rebuilt from the freshly-mutated entries so any
	 * provider sessions caching message identity (Codex Responses) are torn
	 * down to force a clean replay on the next turn.
	 *
	 * No-op when the branch carries no images; returns `{ removed: 0 }` and
	 * skips the disk rewrite.
	 */
	async dropImages(): Promise<{ removed: number }> {
		const branchEntries = this.#host.sessionManager.getBranch();
		let removed = 0;
		for (const entry of branchEntries) {
			if (entry.type === "message") {
				removed += stripImagesFromMessage(entry.message);
				continue;
			}
			if (entry.type === "custom_message" && typeof entry.content !== "string") {
				const kept: typeof entry.content = [];
				let dropped = 0;
				for (const part of entry.content) {
					if (part.type === "image") {
						dropped++;
					} else {
						kept.push(part);
					}
				}
				if (dropped > 0) {
					if (kept.length === 0) {
						kept.push({ type: "text", text: "[image removed]" });
					}
					entry.content = kept;
					removed += dropped;
				}
			}
		}
		if (removed === 0) {
			return { removed: 0 };
		}
		await this.#host.sessionManager.rewriteEntries();
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.resetAdvisorRuntimes("drop-images");
		this.#host.closeCodexProviderSessionsForHistoryRewrite();
		return { removed };
	}

	/**
	 * Surgically reduce context by dropping heavy content ("shake").
	 *
	 * - `images` delegates to {@link dropImages}.
	 * - `thinking` removes assistant reasoning blocks without replacement text.
	 * - `elide` replaces whole tool-call results and large fenced/XML blocks
	 *   with short placeholders that embed an `artifact://` recovery link.
	 *
	 * Mutates the branch in place, persists via `rewriteEntries`, replays the
	 * rebuilt context through the agent, and tears down provider sessions that
	 * cache message identity — same rewrite contract as {@link dropImages}.
	 *
	 * No-op (zero counts) when nothing is eligible.
	 */
	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.#host.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		if (mode === "thinking") {
			const branchEntries = this.#host.sessionManager.getBranch();
			let removed = 0;
			for (const entry of branchEntries) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const message = entry.message;
				const kept = message.content.filter(
					block => block.type !== "thinking" && block.type !== "redactedThinking",
				);
				const dropped = message.content.length - kept.length;
				if (dropped === 0) continue;
				// Provider serializers omit empty assistant turns, so don't invent model-authored text.
				message.content = kept;
				invalidateMessageCache(message);
				removed += dropped;
			}
			if (removed === 0) {
				return { mode, toolResultsDropped: 0, blocksDropped: 0, thinkingBlocksDropped: 0, tokensFreed: 0 };
			}
			await this.#host.sessionManager.rewriteEntries();
			const sessionContext = this.#host.buildDisplaySessionContext();
			this.#host.agent.replaceMessages(sessionContext.messages);
			this.#host.resetAdvisorRuntimes("shake");
			this.#host.closeCodexProviderSessionsForHistoryRewrite();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, thinkingBlocksDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.#host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			// Skip entries summarized away by the latest compaction — shaking them
			// only churns persisted history with no prompt/cache effect. The cut is
			// unconditional on the wire (see `buildSessionContext`), so a compaction
			// the active model cannot replay still hides its prefix from the prompt.
			keepBoundaryId: latestCompaction?.firstKeptEntryId,
		});
		const regions = collectShakeRegions(branchEntries, this.#tokenizer, config);
		if (regions.length === 0) {
			return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		}

		const artifactId = await this.#saveShakeArtifact(regions);
		const replacements = regions.map((region, index) => this.#shakeElidePlaceholder(region, index, artifactId));

		const hasRemoteReplacementHistory = getOpenAiRemoteCompactionPayload(latestCompaction) !== undefined;
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		let anchorIndex = -1;
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || !isTranscriptUsageAnchor(entry.message)) continue;
			anchorIndex = index;
			break;
		}
		const entryIndexes = new Map(branchEntries.map((entry, index) => [entry, index]));

		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		let anchoredTokensRemoved = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = replacements[index];
			const replacementTokenCount = replacement.length > 0 ? this.#tokenizer.countTokens(replacement) : 0;
			replacementTokens += replacementTokenCount;
			const entryIndex = entryIndexes.get(region.entry) ?? -1;
			if (
				entryIndex >= 0 &&
				entryIndex < anchorIndex &&
				(!hasRemoteReplacementHistory || entryIndex > compactionIndex)
			) {
				anchoredTokensRemoved += Math.max(0, region.tokens - replacementTokenCount);
			}
			return { region, replacement };
		});

		applyShakeRegions(items);
		this.#host.recordAnchoredHistoryRewrite(anchoredTokensRemoved);

		await this.#host.sessionManager.rewriteEntries();
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.resetAdvisorRuntimes("shake");
		this.#host.closeCodexProviderSessionsForHistoryRewrite();

		return {
			mode,
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	#shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
		if (artifactId) {
			return `[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`;
		}
		return `[shaken ~${region.tokens} tokens]`;
	}

	/**
	 * Concatenate the original region contents into one session artifact so the
	 * agent can read them back via `artifact://<id>`. Returns `undefined` when
	 * the session is not persisted or the write fails — callers degrade to a
	 * bare placeholder.
	 */
	async #saveShakeArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.#host.sessionManager.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(
		customInstructions?: string,
		options?: CompactOptions,
		methodOffset = 0,
		retryController?: AbortController,
	): Promise<CompactionResult> {
		const ownsCompactionController = retryController === undefined;
		if (this.#compactionAbortController && this.#compactionAbortController !== retryController) {
			throw new Error("Compaction already in progress");
		}
		// Resolve the `/compact <mode>` subcommand up front so input validation
		// runs before we disconnect/abort the active agent operation below.
		const compactMode = options?.mode ? findCompactMode(options.mode) : undefined;
		// Modes that produce no LLM summary (snapcompact) have nothing to focus.
		// Reject focus text loudly so programmatic callers don't silently lose
		// instructions (the slash path pre-validates via parseCompactArgs).
		// `internalGuidance` counts the same way — plan-mode approval never
		// combines with a rejects-focus mode, but reject early if a caller ever
		// wires it up so we don't silently drop the directive on the snapcompact
		// fallback (issue #4359).
		if (compactMode?.rejectsFocus && (customInstructions || options?.internalGuidance)) {
			throw new Error(`/compact ${compactMode.name} does not take focus instructions.`);
		}
		let methods: CompactionMethod[] = [];
		let selectedMethodIndex = -1;
		let compactionCommitted = false;
		let methodAttempted = false;
		const compactionAbortController = retryController ?? new AbortController();
		const manualCompactionCleanup = ownsCompactionController ? Promise.withResolvers<void>() : undefined;
		if (ownsCompactionController) {
			this.#compactionAbortController = compactionAbortController;
			this.#manualCompactionCleanup = manualCompactionCleanup?.promise;
		}
		// A manual pass supersedes any background speculation; running both would
		// double-bill the summarizer and race the commit.
		this.cancelSpeculation();

		try {
			if (ownsCompactionController) {
				this.#host.disconnectFromAgent();
				await this.#host.abort({ goalReason: "internal", preserveCompaction: true });
			}
			const activeModel = this.#model;
			if (!activeModel) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.#host.settings.getGroup("compaction");
			methods = resolveCompactionMethodOrder(compactMode?.overrides.methodOrder ?? compactionSettings.methodOrder);
			const explicitSnapcompact = compactMode?.name === "snapcompact";
			let selectedMethod: CompactionMethod | undefined;
			for (let index = methodOffset; index < methods.length; index++) {
				const method = methods[index];
				if (method === "remote") {
					if (canUseRemoteCompaction(activeModel, resolveMethodSettings(compactionSettings, method))) {
						selectedMethod = method;
						selectedMethodIndex = index;
						break;
					}
					continue;
				}
				if (method === "snapcompact") {
					if (
						explicitSnapcompact ||
						(!customInstructions && !options?.internalGuidance && activeModel.input.includes("image"))
					) {
						selectedMethod = method;
						selectedMethodIndex = index;
						break;
					}
					continue;
				}
				if (method === "soft") {
					selectedMethod = method;
					selectedMethodIndex = index;
					break;
				}
			}
			if (!selectedMethod) {
				throw new Error("No configured compaction method can run manually.");
			}

			const effectiveSettings = resolveMethodSettings(compactionSettings, selectedMethod);
			const availableModels = this.#host.modelRegistry.getAvailable();
			const requireProviderRemote = selectedMethod === "remote" && !effectiveSettings.remoteEndpoint;
			const compactionCandidates = this.#getCompactionModelCandidates(
				availableModels,
				requireProviderRemote
					? candidate =>
							candidate.provider === activeModel.provider &&
							shouldUseProviderNativeCompaction(candidate, effectiveSettings)
					: undefined,
			);
			if (requireProviderRemote && compactionCandidates.length === 0) {
				this.#host.emitNotice(
					"warning",
					`remote compaction is unavailable for ${activeModel.id}; trying the next preferred method`,
					"compaction",
				);
				return await this.compact(customInstructions, options, selectedMethodIndex + 1, compactionAbortController);
			}
			const pathEntries = this.#host.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, effectiveSettings, activeModel, this.#tokenizer);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#host.extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#host.extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new CompactionCancelledError();
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);
			if (compactionPrep.kind !== "fromHook") methodAttempted = true;

			// Focus instructions require an LLM summary, so the preference resolver
			// only selects snapcompact for an undirected manual compaction.
			const wantsSnapcompact = compactionPrep.kind !== "fromHook" && selectedMethod === "snapcompact";
			const snapcompactReady = wantsSnapcompact;
			const snapcompactShapeSetting = this.#host.settings.get("snapcompact.shape");
			let snapcompactShape: snapcompact.Shape | undefined;
			// Claude refuses inputs that reproduce its own reasoning as text
			// ("reasoning_extraction"), and the snapcompact archive is replayed as
			// text into every later request; drop `¶think:` sections for
			// Anthropic-dialect targets (issue #6093).
			const snapcompactIncludeThinking = preferredDialect(this.#model.id) !== "anthropic";
			if (wantsSnapcompact && !this.#model.input.includes("image")) {
				this.#host.emitNotice(
					"warning",
					`snapcompact needs a vision-capable model (${this.#model.id} is text-only)`,
					"compaction",
				);
				throw new Error(`snapcompact cannot run locally: ${this.#model.id} is text-only.`);
			} else if (snapcompactReady) {
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
					{ includeThinking: snapcompactIncludeThinking },
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				snapcompactShape = snapcompact.resolveShapeForText(probeText, this.#model, snapcompactShapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape: snapcompactShape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					this.#host.emitNotice(
						"warning",
						`snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%).`,
						"compaction",
					);
					throw new Error(
						`snapcompact cannot render this conversation locally: unsupported characters for selected snapcompact font (${percent}%).`,
					);
				}
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let codexCompaction: CodexCompactionContext | undefined;

			// Snapcompact runs locally first. The frame cap is sized from the live
			// model window via #computeSnapcompactMaxFrames so the post-render context
			// fits without the warning loop (issue #3247). A local blocker rejects
			// this method, allowing the configured preference order to continue.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			if (snapcompactReady) {
				const maxFrames = this.#computeSnapcompactMaxFrames(preparation, effectiveSettings);
				if (maxFrames < 1) {
					logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
						model: this.#model?.id,
					});
					this.#host.emitNotice(
						"warning",
						"snapcompact: kept history alone exceeds the context budget.",
						"compaction",
					);
					throw new Error("snapcompact cannot run locally: kept history alone exceeds the context budget.");
				} else {
					const shape = snapcompactShape;
					if (!shape) {
						throw new Error("snapcompact shape was not resolved before rendering.");
					}
					snapcompactResult = await snapcompact.compact(preparation, {
						convertToLlm,
						model: this.#model,
						...(snapcompactShapeSetting === "auto" ? {} : { shape }),
						maxFrames,
						includeThinking: snapcompactIncludeThinking,
					});
					const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
					if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
						logger.warn("Snapcompact exceeded the per-request frame payload budget", {
							model: this.#model?.id,
							framePayloadBytes,
							budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
						});
						this.#host.emitNotice(
							"warning",
							"snapcompact produced too much standing image payload.",
							"compaction",
						);
						throw new Error(
							"snapcompact cannot run locally: standing image payload exceeds the per-request budget.",
						);
					}
					const ctxWindow = this.#model?.contextWindow ?? 0;
					const budget =
						ctxWindow > 0
							? ctxWindow - effectiveReserveTokens(ctxWindow, effectiveSettings)
							: Number.POSITIVE_INFINITY;
					const projected = this.#projectSnapcompactContextTokens(preparation, snapcompactResult);
					const reductionBaseline = this.#projectPreSnapcompactContextTokens(preparation);
					if (projected >= reductionBaseline) {
						logger.warn("Snapcompact projection would not reduce context", {
							model: this.#model?.id,
							projected,
							reductionBaseline,
						});
						this.#host.emitNotice("warning", "snapcompact would not reduce context.", "compaction");
						throw new Error("snapcompact would not reduce context locally.");
					}
					if (projected > budget) {
						logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
							model: this.#model?.id,
						});
						this.#host.emitNotice(
							"warning",
							"snapcompact could not bring the context under the limit.",
							"compaction",
						);
						throw new Error("snapcompact could not bring the context under the limit locally.");
					}
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...compactionPrep.preserveData, ...snapcompactResult.preserveData };
			} else {
				codexCompaction = createCodexCompactionContext({
					trigger: "manual",
					reason: "user_requested",
					phase: "standalone_turn",
				});
				// Generate compaction result. Only convert known abort-shaped
				// rejections (AbortError raised while the abort signal is set,
				// or an already-typed sentinel) into `CompactionCancelledError`
				// so downstream callers can discriminate cancel from generic
				// failure via `instanceof` without inspecting message strings.
				// Real compaction bugs (network, server, parsing, etc.) keep
				// their original shape — they must not be silently relabeled
				// as cancellations even if the signal happens to be aborted
				// for an unrelated reason. Assignments live inside the try
				// block because every catch path throws — the post-try reads
				// of the result-derived locals are reachable only on success.
				try {
					const result = await this.#compactWithFallbackModel(
						preparation,
						options?.internalGuidance ?? customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: this.#host.obfuscateTextForProvider(compactionPrep.hookPrompt),
							extraContext: compactionPrep.hookContext,
							remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
							convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
							codexCompaction,
						},
						compactionCandidates,
					);
					summary = result.summary;
					shortSummary = result.shortSummary;
					firstKeptEntryId = result.firstKeptEntryId;
					tokensBefore = result.tokensBefore;
					details = result.details;
					preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, result.preserveData);
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						if (!compactionAbortController.signal.aborted || err.cause !== undefined) throw err;
						throw new CompactionCancelledError(err.message, {
							cause: compactionAbortController.signal.reason,
						});
					}
					if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
						throw new CompactionCancelledError(undefined, {
							cause: compactionAbortController.signal.reason,
						});
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError(undefined, {
					cause: compactionAbortController.signal.reason,
				});
			}

			compactionCommitted = true;
			await this.#commitCompactionEntry({
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
				method: fromExtension ? undefined : selectedMethod,
				codexCompaction,
				advisorResetReason: "compact",
			});

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData: snapcompact.stripPreservedArchive(preserveData),
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			if (
				methodAttempted &&
				!compactionCommitted &&
				!compactionAbortController.signal.aborted &&
				!(error instanceof CompactionCancelledError) &&
				selectedMethodIndex >= 0 &&
				selectedMethodIndex + 1 < methods.length
			) {
				this.#host.emitNotice(
					"warning",
					`${methods[selectedMethodIndex]} compaction failed; trying the next preferred method`,
					"compaction",
				);
				return await this.compact(customInstructions, options, selectedMethodIndex + 1, compactionAbortController);
			}
			options?.onError?.(err);
			throw error;
		} finally {
			if (ownsCompactionController) {
				if (this.#compactionAbortController === compactionAbortController) {
					this.#compactionAbortController = undefined;
				}
				this.#host.reconnectToAgent();
				// Compaction disconnected before `await abort()`, so abort's finally drain
				// (and any steer/follow-up that arrived mid-compaction — async IRC, an
				// `xd://` mount notice, an SDK/RPC steer) was suppressed while disconnected
				// (issue #5800). Unlike `/new`/switchSession, compaction preserves the agent
				// queues, so nothing else resumes them: re-drain now that the listener is back
				// and `isCompacting` is false, or the queued turn hangs until the next prompt.
				this.#host.drainStrandedQueuedMessages();
				if (this.#manualCompactionCleanup === manualCompactionCleanup?.promise) {
					this.#manualCompactionCleanup = undefined;
				}
				manualCompactionCleanup?.resolve();
			}
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = await resolveMemoryBackend(this.#host.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.#host.settings, this.#host.memoryBackendSession());
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress context maintenance and return the active manual pass's
	 * cleanup barrier. The barrier resolves only after its agent subscription reconnects.
	 */
	abortCompaction(reason?: unknown): Promise<void> | undefined {
		const manualCompactionCleanup = this.#manualCompactionCleanup;
		this.#compactionAbortController?.abort(reason);
		this.#autoCompactionAbortController?.abort(reason);
		this.#host.abortHandoff();
		return manualCompactionCleanup;
	}

	/**
	 * Resolves once an in-flight manual compaction has reconnected the agent
	 * subscription and re-drained its preserved queues; `undefined` when no manual
	 * compaction is active. Callers that must not start a turn against the
	 * disconnected session (e.g. ordinary prompts) await this first.
	 */
	get manualCompactionCleanup(): Promise<void> | undefined {
		return this.#manualCompactionCleanup;
	}

	/** Cancel only automatic maintenance while preserving a manual compaction. */
	abortAutomaticCompaction(): void {
		this.#autoCompactionAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.#host.isStreaming() || this.isCompacting) return;
		await this.runAutoCompaction("idle", false, true);
	}

	/**
	 * Manual handoff: generate a handoff document and commit it as a compaction
	 * entry on the current session — the document becomes the summary and recent
	 * history is kept per `compaction.keepRecentTokens`. Unlike `/compact`, the
	 * live agent is not aborted; generation reads a snapshot of the live
	 * messages through the cache-friendly side-request pipeline.
	 */
	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		if (this.isCompacting) throw new Error("Compaction already in progress");
		this.cancelSpeculation();
		const model = this.#model;
		if (!model) throw new Error("No model selected for handoff");
		const entries = this.#host.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;
		if (messageCount < 2) throw new Error("Nothing to hand off (no messages yet)");
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const preparation = prepareCompaction(
			entries,
			resolveMethodSettings(compactionSettings, "handoff"),
			model,
			this.#tokenizer,
		);
		if (!preparation) throw new Error("Nothing to hand off (already compacted)");
		const result = await this.#host.generateHandoffDocument(customInstructions, options);
		if (!result) return undefined;
		const { summary, details } = handoffSummaryFromDocument(result.document, preparation);
		await this.#commitCompactionEntry({
			summary,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details,
			fromExtension: false,
			preserveData: undefined,
			method: "handoff",
			codexCompaction: undefined,
			advisorResetReason: "handoff",
		});
		return result;
	}

	/**
	 * Start a background speculative compaction when context has entered the
	 * pre-threshold band `[threshold − lead, threshold)`. The produced summary
	 * is held (armed) and committed instantly by the next real maintenance
	 * pass, hiding summarization latency. Only LLM-backed methods
	 * (remote/handoff/soft) are speculated — shake and snapcompact are local
	 * and effectively instant. Never rewrites history itself; stale results are
	 * discarded by apply-time branch validation in {@link #claimArmedSpeculation}.
	 * A turn that jumps past the threshold before a run armed is handled by
	 * {@link deferThresholdCompactionToSpeculation}'s grace band instead.
	 */
	maybeStartSpeculativeCompaction(contextTokens: number, contextWindow: number): void {
		if (contextWindow <= 0 || this.#host.isDisposed()) return;
		const settings = this.#host.settings.getGroup("compaction");
		if (!settings.enabled || settings.asyncEnabled === false || !hasConfiguredCompactionMethod(settings)) return;
		if (this.isCompacting || this.#host.isGeneratingHandoff()) return;
		// Extensions that intercept compaction (cancel/replace) keep exact
		// blocking semantics; a speculated result would bypass their veto.
		if (this.#host.extensionRunner?.hasHandlers("session_before_compact")) return;
		const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
		if (contextTokens >= thresholdTokens) return; // real maintenance owns it now
		if (thresholdTokens - contextTokens > resolveSpeculationLeadTokens(thresholdTokens)) return;
		const current = this.#speculation;
		if (current) {
			if (!current.armed) return; // one run at a time
			// Refresh-on-growth: the armed summary's kept tail grows with every
			// turn; once the growth exceeds the keep-recent budget, a fresh cut
			// reclaims materially more context at apply time.
			const growth = contextTokens - current.armed.contextTokensAtStart;
			const refreshBudget = Math.max(settings.keepRecentTokens, SPECULATION_LEAD_MIN_TOKENS);
			if (growth <= refreshBudget && this.#armedSpeculationValid(current.armed)) return;
			this.cancelSpeculation();
		}
		const model = this.#model;
		if (!model) return;
		const method = resolveSpeculationMethod(model, settings);
		if (!method) return;
		this.#startSpeculationRun(contextTokens, method);
	}

	/** Install and launch one background speculation run for `method`. */
	#startSpeculationRun(contextTokens: number, method: "remote" | "handoff" | "soft"): void {
		const controller = new AbortController();
		const run: SpeculationRun = { controller, promise: Promise.resolve(), contextTokensAtStart: contextTokens };
		this.#speculation = run;
		run.promise = this.#runSpeculation(run, method, contextTokens).catch(error => {
			logger.debug("Speculative compaction failed", {
				method,
				error: error instanceof Error ? error.message : String(error),
			});
			if (this.#speculation === run) this.#speculation = undefined;
		});
	}

	/**
	 * Grace band above the compaction threshold: when a single turn jumps past
	 * the threshold before the background speculation armed (or even started),
	 * the threshold pass keeps serving the user instead of blocking on a
	 * synchronous summarization — the speculation finishes in the background
	 * and the next maintenance boundary splices it in for free. Returns true
	 * while deferral is in effect (a run was live, or one was started here);
	 * the caller MUST skip its blocking compaction then.
	 *
	 * Deferral ends — and the blocking pass resumes — once context grows past
	 * `threshold + lead`, clamped to keep {@link SPECULATION_LEAD_MIN_TOKENS}
	 * of headroom below the window. A provider overflow inside the band is
	 * recovered by the existing overflow path (compact + retry). Never defers
	 * for local-first method orders (shake/snapcompact are instant), when
	 * async compaction is disabled, or when a `session_before_compact`
	 * extension must keep exact blocking semantics.
	 */
	deferThresholdCompactionToSpeculation(contextTokens: number, contextWindow: number): boolean {
		if (contextWindow <= 0 || this.#host.isDisposed()) return false;
		const settings = this.#host.settings.getGroup("compaction");
		if (!settings.enabled || settings.asyncEnabled === false || !hasConfiguredCompactionMethod(settings))
			return false;
		if (this.isCompacting || this.#host.isGeneratingHandoff()) return false;
		if (this.#host.extensionRunner?.hasHandlers("session_before_compact")) return false;
		const model = this.#model;
		if (!model) return false;
		const method = resolveSpeculationMethod(model, settings);
		if (!method) return false;
		const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
		const graceCapTokens = Math.min(
			thresholdTokens + resolveSpeculationLeadTokens(thresholdTokens),
			contextWindow - SPECULATION_LEAD_MIN_TOKENS,
		);
		if (contextTokens >= graceCapTokens) return false;
		const run = this.#speculation;
		if (run) {
			if (run.armed) return false; // ready — the real pass splices it in now
			return true; // still summarizing in the background
		}
		this.#startSpeculationRun(contextTokens, method);
		return true;
	}

	/** Produce and arm one speculative compaction result off a branch snapshot. */
	async #runSpeculation(
		run: SpeculationRun,
		method: "remote" | "handoff" | "soft",
		contextTokens: number,
	): Promise<void> {
		const clear = () => {
			if (this.#speculation === run) this.#speculation = undefined;
		};
		const model = this.#model;
		if (!model) return clear();
		const settings = this.#host.settings.getGroup("compaction");
		const effectiveSettings = resolveMethodSettings(settings, method);
		const branch = this.#host.sessionManager.getBranch();
		const snapshotLeafId = branch[branch.length - 1]?.id;
		if (!snapshotLeafId) return clear();
		const preparation = prepareCompaction(branch, effectiveSettings, model, this.#tokenizer);
		if (!preparation) return clear();
		const signal = run.controller.signal;
		let armed: ArmedSpeculation;
		if (method === "handoff") {
			const generated = await this.#host.generateHandoffDocument(AUTO_HANDOFF_THRESHOLD_FOCUS, {
				autoTriggered: true,
				signal,
			});
			if (!generated) return clear();
			const { summary, details } = handoffSummaryFromDocument(generated.document, preparation);
			armed = {
				result: {
					summary,
					shortSummary: undefined,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details,
				},
				action: "handoff",
				method,
				snapshotLeafId,
				contextTokensAtStart: contextTokens,
			};
		} else {
			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, undefined);
			// No hookCompaction is passed above, so "fromHook" is unreachable;
			// the guard just narrows the union.
			if (compactionPrep.kind === "fromHook") return clear();
			const candidates = this.#getCompactionModelCandidates(
				this.#host.modelRegistry.getAvailable(),
				method === "remote" && !effectiveSettings.remoteEndpoint
					? candidate =>
							candidate.provider === model.provider &&
							shouldUseProviderNativeCompaction(candidate, effectiveSettings)
					: undefined,
			);
			if (candidates.length === 0) return clear();
			const codexCompaction = createCodexCompactionContext({
				trigger: "auto",
				reason: "context_limit",
				phase: "standalone_turn",
			});
			const result = await this.#compactWithFallbackModel(
				preparation,
				undefined,
				signal,
				{
					promptOverride: this.#host.obfuscateTextForProvider(compactionPrep.hookPrompt),
					extraContext: compactionPrep.hookContext,
					remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
					codexCompaction,
					// Isolate from the live turn: remote compaction transports key
					// sticky provider sessions by sessionId, and a speculation
					// overlapping the live stream must never interleave with it.
					sessionId: `${this.#host.sessionId()}:spec:${Snowflake.next()}`,
					preferWebsockets: false,
				},
				candidates,
			);
			armed = {
				result: {
					...result,
					preserveData: mergeLlmCompactionPreserveData(compactionPrep.preserveData, result.preserveData),
				},
				action: method === "remote" ? "remote" : "context-full",
				method,
				codexCompaction,
				snapshotLeafId,
				contextTokensAtStart: contextTokens,
			};
		}
		if (signal.aborted || this.#speculation !== run) return;
		run.armed = armed;
		logger.debug("Speculative compaction armed", {
			method,
			snapshotLeafId,
			tokensBefore: armed.result.tokensBefore,
		});
	}

	/**
	 * An armed result is committable only when the branch prefix it summarized
	 * is still intact: its snapshot leaf is on the active path with no later
	 * compaction or reset boundary, and any provider-native replay payload is
	 * still readable by the active model.
	 */
	#armedSpeculationValid(armed: ArmedSpeculation): boolean {
		const model = this.#model;
		if (!model) return false;
		const settings = this.#host.settings.getGroup("compaction");
		if (
			armed.result.preserveData &&
			!remotePreserveReusable(armed.result.preserveData, model, resolveMethodSettings(settings, armed.method))
		) {
			return false;
		}
		const branch = this.#host.sessionManager.getBranch();
		const leafIdx = branch.findIndex(entry => entry.id === armed.snapshotLeafId);
		if (leafIdx < 0) return false;
		for (let i = leafIdx + 1; i < branch.length; i++) {
			const type = branch[i].type;
			if (type === "compaction" || type === "reset_boundary") return false;
		}
		return true;
	}

	/**
	 * Consume the speculation slot for a real maintenance pass. An in-flight run
	 * is aborted (the real pass supersedes it); an armed result is returned only
	 * when still valid for the current branch, model, and settings.
	 */
	#claimArmedSpeculation(): ArmedSpeculation | undefined {
		const run = this.#speculation;
		if (!run) return undefined;
		this.#speculation = undefined;
		if (!run.armed) {
			run.controller.abort();
			return undefined;
		}
		const settings = this.#host.settings.getGroup("compaction");
		if (settings.asyncEnabled === false) return undefined;
		if (this.#host.extensionRunner?.hasHandlers("session_before_compact")) return undefined;
		return this.#armedSpeculationValid(run.armed) ? run.armed : undefined;
	}

	/**
	 * Append a compaction entry and run the shared post-commit sequence:
	 * rebuild the display context, swap live agent messages, re-anchor stats,
	 * reset plan/advisor/todo runtime state derived from the replaced history,
	 * reset provider sessions, and emit the `session_compact` extension hook.
	 */
	async #commitCompactionEntry(args: {
		summary: string;
		shortSummary: string | undefined;
		firstKeptEntryId: string;
		tokensBefore: number;
		details: unknown;
		fromExtension: boolean;
		preserveData: Record<string, unknown> | undefined;
		method: CompactionMethod | undefined;
		codexCompaction: CodexCompactionContext | undefined;
		providerReplayThroughEntryId?: string;
		advisorResetReason: string;
		detachExtensionEmit?: boolean;
	}): Promise<CompactionEntry | undefined> {
		const entryId = this.#host.sessionManager.appendCompaction(
			args.summary,
			args.shortSummary,
			args.firstKeptEntryId,
			args.tokensBefore,
			{
				details: args.details,
				fromExtension: args.fromExtension,
				preserveData: args.preserveData,
				method: args.method,
				providerReplayThroughEntryId: args.providerReplayThroughEntryId,
				tokensAfter: this.#projectCompactedContextTokens(args),
			},
		);
		const newEntries = this.#host.sessionManager.getEntries();
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.rebaseAfterCompaction();
		// Compaction discarded the conversation history that carried the approved
		// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
		// the plan from disk and re-injects it on the next turn (issue #1246).
		this.#host.resetPlanReference();
		this.#host.resetAdvisorRuntimes(args.advisorResetReason);
		this.#host.syncTodoPhasesFromBranch();
		if (args.codexCompaction) {
			this.#host.resetCodexProviderAfterCompaction(args.codexCompaction);
		} else {
			this.#host.closeCodexProviderSessionsForHistoryRewrite();
		}
		const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.id === entryId) as
			| CompactionEntry
			| undefined;
		if (this.#host.extensionRunner && savedCompactionEntry) {
			const compactEmit = this.#host.extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension: args.fromExtension,
			});
			if (args.detachExtensionEmit) {
				void compactEmit.catch(error => {
					logger.warn("Detached session_compact emit failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			} else {
				await compactEmit;
			}
		}
		return savedCompactionEntry;
	}

	/**
	 * Local token estimate of the stored conversation (plus any pending messages),
	 * independent of provider-reported usage. A `before_provider_request` hook
	 * (e.g. a compression extension such as Headroom) or other on-wire payload
	 * transform can shrink the request below the real stored conversation; the
	 * provider then reports deflated prompt tokens, so anchoring the compaction
	 * decision purely on that usage lets the real history grow unbounded until it
	 * overflows and native compaction can no longer run. This estimate is the
	 * floor the compaction decision respects so on-wire compression can never
	 * suppress it.
	 */
	#estimateStoredContextTokens(pendingMessages: AgentMessage[] = []): number {
		// Local counting is the whole point of this arm: provider usage is
		// exactly what it must not trust. Exclude encrypted reasoning
		// (thinkingSignature / redactedThinking) too — its local byte size
		// diverges from what the provider bills, so counting it would let a
		// thinking-heavy turn falsely trip the floor. The provider usage (the
		// other arm of compactionContextTokens) already accounts for it.
		const opts = { excludeEncryptedReasoning: true } as const;
		return (
			computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer) +
			this.#tokenizer.countMessages(this.#host.messages(), opts) +
			this.#tokenizer.countMessages(pendingMessages, opts)
		);
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		const breakdown = this.#host.getContextBreakdown({ contextWindow, pendingMessages: messages });
		const localEstimate = this.#estimateStoredContextTokens(messages);
		// Floor by the local estimate: a payload-shrinking before_provider_request
		// hook deflates the provider-anchored breakdown, which must not suppress
		// pre-prompt compaction (see #estimateStoredContextTokens).
		return compactionContextTokens(breakdown?.usedTokens ?? 0, localEstimate);
	}

	/**
	 * Local pre-compaction context for a snapcompact preparation, measured on the
	 * exact same non-message overhead and tokenizer as
	 * {@link #projectSnapcompactContextTokens}: fixed overhead + the region that
	 * would be archived (`messagesToSummarize` + `turnPrefixMessages`) + the kept
	 * tail (`recentMessages`). Comparing the projection against this
	 * self-consistent baseline isolates the single thing snapcompact changes —
	 * the archived region becomes an imaged summary — so a result whose frames
	 * cost more tokens than the text they replace is rejected, while genuine
	 * reductions are not. Recomputed from the live messages rather than
	 * `preparation.tokensBefore`, which carries only provider usage (zero for
	 * imported sessions with no usage metadata, or a deflated figure behind a
	 * payload-shrinking hook) and would falsely reject reducing archives (#10023).
	 */
	#projectPreSnapcompactContextTokens(preparation: CompactionPreparation): number {
		let tokens = computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer);
		tokens += this.#tokenizer.countMessages(preparation.messagesToSummarize);
		tokens += this.#tokenizer.countMessages(preparation.turnPrefixMessages);
		tokens += this.#tokenizer.countMessages(preparation.recentMessages);
		return tokens;
	}

	async runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.#model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const contextTokens = this.#estimatePrePromptContextTokens(messages, contextWindow);
		const pendingMidTurnDeadEnd = this.#midTurnDeadEndPendingPrePrompt;
		this.#midTurnDeadEndPendingPrePrompt = false;
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			this.maybeStartSpeculativeCompaction(contextTokens, contextWindow);
			return;
		}
		if (
			pendingMidTurnDeadEnd &&
			prepareCompaction(this.#host.sessionManager.getBranch(), compactionSettings, model, this.#tokenizer) ===
				undefined
		) {
			// The prior tool loop already attempted the rescue and warned for this
			// persisted oversized turn. Only a later persisted cut point makes a
			// pre-prompt retry useful; the new agent loop may warn for its own turn.
			return;
		}
		// Grace band: a live (or just-started) background speculation absorbs the
		// blocking summarization; the user's prompt goes out immediately and the
		// armed result is spliced in at the next boundary.
		if (this.deferThresholdCompactionToSpeculation(contextTokens, contextWindow)) {
			logger.debug("Pre-prompt threshold deferred to speculative compaction", {
				contextTokens,
				contextWindow,
			});
			return;
		}

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact (snapcompact/summary) a session that should have just been promoted.
		if (await this.#promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			pendingContextTokens: this.#tokenizer.countMessages(messages),
			preparedContextTokens: this.#estimateStoredContextTokens(),
			phase: "pre_turn",
		});
	}

	/**
	 * Compact continuing tool-loop runs before the next provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn
	 * are already paired in `activeMessages`, the live array the agent loop reads
	 * before its next model call. Before compacting, the just-finished turn is
	 * synchronously persisted if async message hooks have not reached the normal
	 * append path yet.
	 */
	async maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (
			signal?.aborted ||
			this.#host.isDisposed() ||
			this.isCompacting ||
			this.#host.isGeneratingHandoff() ||
			!context?.willContinue
		)
			return;

		const model = this.#model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (
			!compactionSettings.enabled ||
			!hasConfiguredCompactionMethod(compactionSettings) ||
			compactionSettings.midTurnEnabled === false
		) {
			return;
		}

		const lastAssistant = [...activeMessages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		// Decide from the live agent context before waiting for the asynchronous
		// session journal. The persistence barrier is required only when maintenance
		// will actually rewrite history; awaiting it on every ordinary tool turn lets
		// a slow message_end listener leave the TUI "generating" with no provider
		// request or tool running.
		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			this.maybeStartSpeculativeCompaction(contextTokens, contextWindow);
			return;
		}
		// Grace band: keep the tool loop moving while a background speculation
		// (live or started here) produces the summary; checked before the
		// persistence barrier so deferred boundaries never await the journal.
		if (this.deferThresholdCompactionToSpeculation(contextTokens, contextWindow)) {
			logger.debug("Mid-run threshold deferred to speculative compaction", {
				contextTokens,
				contextWindow,
			});
			return;
		}

		if (!(await this.#host.persistTurnMessagesForMidRunCompaction(context))) return;
		if (this.#midTurnCompactionDeadEnds.has(activeMessages)) {
			// A prior boundary already ran the dead-end rescue and could not reduce
			// this turn. Re-running the rescue and re-emitting its warning on every
			// following tool boundary is wasted work while nothing summarizable
			// exists. But the tool loop keeps appending turns: once a later
			// (smaller) tool result gives prepareCompaction a cut point before the
			// now-older oversized turn, compaction can finally make progress and
			// MUST run rather than stay suppressed until provider overflow (#7153
			// review). Stay parked only while no cut point is available; re-arm as
			// soon as one appears.
			if (
				!model ||
				prepareCompaction(this.#host.sessionManager.getBranch(), compactionSettings, model, this.#tokenizer) ===
					undefined
			) {
				return;
			}
			this.#midTurnCompactionDeadEnds.delete(activeMessages);
			this.#midTurnDeadEndPendingPrePrompt = false;
		}

		// Promote to a larger-context sibling before compacting, mirroring the
		// pre-prompt (runPrePromptCompactionIfNeeded) and post-turn threshold
		// (checkCompaction) paths. Without this, a long mid-turn tool loop that
		// crosses the threshold compacts the history (and can hit the no-progress
		// dead-end on a single oversized turn) on a model that should have just
		// been promoted to a larger window instead.
		if (await this.#promoteContextModel()) {
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		const result = await this.runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			suppressContinuation: true,
			triggerContextTokens: contextTokens,
			phase: "mid_turn",
			detachPostCommit: true,
		});
		if (result.automaticContinuationBlocked) {
			this.#midTurnCompactionDeadEnds.add(activeMessages);
			this.#midTurnDeadEndPendingPrePrompt = true;
		}

		if (signal?.aborted) return;
		const compactedMessages = this.#host.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		logger.debug("Mid-run compaction ran between provider calls", {
			contextTokens,
			contextWindow,
			methods: resolveCompactionMethodOrder(compactionSettings.methodOrder),
			goalActive: this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
		});
	}
	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Four cases (in order):
	 * 1. Input overflow + promotion: promote to larger model, retry without maintenance.
	 * 2. Input overflow + no promotion target: run context maintenance, auto-retry on same model.
	 * 3. Output incomplete (stopReason === "length", e.g. `response.incomplete`): the
	 *    model burned its output budget without producing an actionable deliverable
	 *    (reasoning-only or truncated). Drop the dead turn, try promotion, otherwise
	 *    run compaction/handoff and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param allowDefer If true, a threshold-driven handoff preference may schedule
	 *   itself as a deferred post-prompt task instead of running inline. Callers running
	 *   inside the `agent_end` handler set this to true so `session.prompt()` resolves
	 *   cleanly; callers on the pre-prompt path (where the next agent turn is about to
	 *   start) set it to false to avoid racing the deferred handoff against the new turn.
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction/recovery scheduled a handoff, retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	async checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		allowDefer = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const contextWindow = this.#model?.contextWindow ?? 0;
		const generation = this.#host.promptGeneration();
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.#model && assistantMessage.provider === this.#model.provider && assistantMessage.model === this.#model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		const payloadRejection =
			sameModel && !errorIsFromBeforeCompaction && AIError.isPayloadRejection(assistantMessage);
		const ambiguousPayloadRejection =
			payloadRejection && AIError.is(assistantMessage.errorId, AIError.Flag.ContextOverflow);
		const storedTokens = payloadRejection && contextWindow > 0 ? this.#estimateStoredContextTokens() : 0;
		const reportedInputTokens =
			assistantMessage.usage.input + assistantMessage.usage.cacheRead + assistantMessage.usage.cacheWrite;
		const trustedPayloadRejection =
			payloadRejection &&
			contextWindow > 0 &&
			reportedInputTokens <= contextWindow &&
			storedTokens < contextWindow * PAYLOAD_REJECTION_OCCUPANCY_CEILING;
		if ((payloadRejection && !ambiguousPayloadRejection && contextWindow <= 0) || trustedPayloadRejection) {
			this.#host.removeAssistantMessageFromActiveContext(assistantMessage);
			this.#host.emitNotice("warning", payloadRejectionNotice(storedTokens, contextWindow), "compaction");
			logger.debug("Payload-shaped 413 withheld from token compaction", {
				provider: assistantMessage.provider,
				model: assistantMessage.model,
				message: assistantMessage.errorMessage,
				storedTokens,
				contextWindow,
			});
			return COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION;
		}
		const overflowEvidence =
			sameModel && !errorIsFromBeforeCompaction && AIError.isContextOverflow(assistantMessage, contextWindow);
		if (overflowEvidence || (payloadRejection && !trustedPayloadRejection)) {
			this.#host.removeAssistantMessageFromActiveContext(assistantMessage);

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#host.dropPersistedAssistantTurn(assistantMessage);
				// Retry on the promoted (larger) model without compacting
				this.#host.scheduleAgentContinue({
					source: "context-promotion-overflow",
					delayMs: 100,
					generation,
				});
				return COMPACTION_CHECK_CONTINUATION;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.#host.settings.getGroup("compaction");
			if (compactionSettings.enabled && hasConfiguredCompactionMethod(compactionSettings)) {
				return await this.#host.runRecoveryCompactionWithRollback("overflow", assistantMessage, allowDefer, {
					autoContinue,
				});
			}
			if (payloadRejection) {
				const usageBackedOverflow = AIError.isUsageBackedContextOverflow(assistantMessage, contextWindow);
				this.#host.emitNotice(
					"warning",
					usageBackedOverflow
						? usageOverflowDeadEndNotice(reportedInputTokens, contextWindow)
						: payloadRejectionNotice(storedTokens, contextWindow),
					"compaction",
				);
				logger.debug("Payload-shaped 413 has no runnable recovery; blocking automatic continuation", {
					provider: assistantMessage.provider,
					model: assistantMessage.model,
					message: assistantMessage.errorMessage,
					storedTokens,
					contextWindow,
				});
				return COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION;
			}
			return COMPACTION_CHECK_NONE;
		}
		// A context promotion can land while the failing call is already in
		// flight (or on a run whose loop predates the switch): the overflow
		// error then arrives stamped with the pre-promotion model while
		// `this.#host.model()` is already the promoted target. The sameModel guard
		// above deliberately ignores stale foreign-model errors, but this
		// state is not stale — recover exactly like the promotion path:
		// drop the dead turn and retry on the already-promoted model. Gated
		// narrowly on "current model IS the failed model's promotion target
		// with a strictly larger window" so genuinely stale errors from
		// old user-switched models keep surfacing untouched.
		if (
			!sameModel &&
			autoContinue &&
			!errorIsFromBeforeCompaction &&
			assistantMessage.stopReason === "error" &&
			this.#model &&
			contextWindow > 0 &&
			this.#host.settings.getGroup("contextPromotion").enabled
		) {
			const failedModel = this.#host.modelRegistry.find(assistantMessage.provider, assistantMessage.model);
			const failedWindow = failedModel?.contextWindow ?? 0;
			const promotionTarget = failedModel
				? resolveContextPromotionConfiguredTarget(failedModel, this.#host.modelRegistry.getAvailable())
				: undefined;
			if (
				failedModel &&
				failedWindow > 0 &&
				contextWindow > failedWindow &&
				promotionTarget &&
				modelsAreEqual(promotionTarget, this.#model) &&
				AIError.isContextOverflow(assistantMessage, failedWindow)
			) {
				this.#host.removeAssistantMessageFromActiveContext(assistantMessage);
				await this.#host.dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Overflow on pre-promotion model; retrying on promoted model", {
					failed: `${assistantMessage.provider}/${assistantMessage.model}`,
					current: `${this.#model.provider}/${this.#model.id}`,
				});
				this.#host.scheduleAgentContinue({
					source: "promoted-model-overflow",
					delayMs: 100,
					generation,
				});
				return COMPACTION_CHECK_CONTINUATION;
			}
		}

		// Case 3: Output-side incomplete — `response.incomplete` from OpenAI Responses
		// (and Codex) maps to stopReason === "length". The model burned its
		// `max_output_tokens` budget on reasoning/text and emitted no actionable
		// deliverable. Same recovery class as overflow: promotion if available,
		// otherwise compaction/handoff. Unlike overflow, the *input* is fine, so a
		// reachable handoff preference may run.
		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			// Same active-context vs persisted-history split as the overflow path
			// above: clear the dead turn from agent state so it cannot be replayed,
			// but keep it on the branch unless promotion or compaction actually runs.
			this.#host.removeAssistantMessageFromActiveContext(assistantMessage);

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#host.dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Context promotion triggered by response.incomplete (length stop)", {
					from: `${assistantMessage.provider}/${assistantMessage.model}`,
				});
				this.#host.scheduleAgentContinue({
					source: "context-promotion-incomplete",
					delayMs: 100,
					generation,
				});
				return COMPACTION_CHECK_CONTINUATION;
			}

			const incompleteCompactionSettings = this.#host.settings.getGroup("compaction");
			if (incompleteCompactionSettings.enabled && hasConfiguredCompactionMethod(incompleteCompactionSettings)) {
				logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
					model: `${assistantMessage.provider}/${assistantMessage.model}`,
					methods: resolveCompactionMethodOrder(incompleteCompactionSettings.methodOrder),
				});
				return await this.#host.runRecoveryCompactionWithRollback("incomplete", assistantMessage, allowDefer, {
					autoContinue,
					triggerContextTokens: calculateContextTokens(assistantMessage.usage),
				});
			}
			// Neither promotion nor compaction is available — surface the dead-end so
			// the user understands why the turn yielded with nothing.
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (!compactionSettings.enabled || !hasConfiguredCompactionMethod(compactionSettings))
			return COMPACTION_CHECK_NONE;

		// Case 4: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#pruneToolOutputs();
		const maintenanceTokensFreed = (supersedeResult?.tokensSaved ?? 0) + (pruneResult?.tokensSaved ?? 0);
		// `errorIsFromBeforeCompaction` (computed above) is the general
		// "this assistant message predates the latest compaction" predicate here,
		// not just an error-specific one; alias it locally so the threshold intent
		// reads clearly (#3412 review).
		const assistantPredatesCompaction = errorIsFromBeforeCompaction;
		// An assistant that predates the latest compaction carries stale, pre-rewrite
		// `usage`: the scheduled auto-continue re-enters this check with the kept
		// assistant (#promptWithMessage → checkCompaction), and its old high prompt
		// count would re-trip the threshold on a freshly compacted history. Drop the
		// stale provider number for those messages and let the live stored estimate
		// (the floor applied below) drive the decision instead.
		const assistantUsageContextTokens = assistantPredatesCompaction
			? 0
			: calculateContextTokens(assistantMessage.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		// Pruning frees bytes for the NEXT prompt; it does not change the size of
		// the prompt the LLM just billed for. Earlier revisions subtracted the
		// per-turn supersede/prune `tokensSaved` from the threshold input, which
		// let a long-running `/goal` session sit above `compaction.thresholdTokens`
		// indefinitely whenever per-turn pruning saved enough to drop the
		// post-prune estimate below the user-configured trigger — the visible
		// context (anchored to the same provider billing) still showed >threshold,
		// but `shouldCompact` no-op'd (#3174). Anchor the initial trigger on the
		// last turn's billed context tokens, floored by the post-prune
		// stored-conversation estimate so a payload-compression hook still can't
		// deflate the trigger.
		const contextTokens = compactionContextTokens(assistantUsageContextTokens, storedContextTokens);
		const postMaintenanceContextTokens = compactionContextTokens(
			Math.max(0, assistantUsageContextTokens - maintenanceTokensFreed),
			storedContextTokens,
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const shouldThresholdCompact = shouldCompact(contextTokens, contextWindow, compactionSettings);
		logger.debug("Auto-compaction threshold decision", {
			phase: "post-agent-end",
			goalModeEnabled: this.#goalModeState?.enabled === true,
			goalStatus: this.#goalModeState?.goal.status,
			stopReason: assistantMessage.stopReason,
			sameModel: sameModel === true,
			contextWindow,
			methods: resolveCompactionMethodOrder(compactionSettings.methodOrder),
			thresholdTokens,
			assistantUsageContextTokens,
			storedContextTokens,
			resolvedContextTokens: contextTokens,
			postMaintenanceContextTokens,
			maintenanceTokensFreed,
			shouldCompact: shouldThresholdCompact,
			contextPromotionEnabled: this.#host.settings.get("contextPromotion.enabled") === true,
		});
		if (shouldThresholdCompact) {
			// Grace band: a live (or just-started) background speculation absorbs
			// the blocking summarization; the session stays responsive and the
			// armed result lands at the next boundary. Deferral delays promotion
			// by at most the band — the eventual real pass still promotes first.
			if (this.deferThresholdCompactionToSpeculation(postMaintenanceContextTokens, contextWindow)) {
				logger.debug("Post-turn threshold deferred to speculative compaction", {
					postMaintenanceContextTokens,
					contextWindow,
				});
				return COMPACTION_CHECK_NONE;
			}
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				return await this.runAutoCompaction("threshold", false, false, allowDefer, {
					autoContinue,
					triggerContextTokens: postMaintenanceContextTokens,
					phase: "pre_turn",
					terminalTextAnswer: isTerminalTextAssistantAnswer(assistantMessage),
				});
			}
			logger.debug("Auto-compaction threshold satisfied but context promotion took over", {
				contextTokens,
				contextWindow,
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
		} else {
			this.maybeStartSpeculativeCompaction(contextTokens, contextWindow);
		}
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.#model;
		if (!currentModel) return false;
		// The overflow/length error may have come from a model the user already
		// switched away from; only promote when the failing turn was this model.
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.#promoteContextModel();
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a
	 * target with a strictly larger window (and a usable key) exists. Returns true
	 * when the model was switched, so the caller can retry without compacting.
	 * Message-independent core shared by the post-turn overflow path
	 * ({@link #tryContextPromotion}) and the pre-prompt threshold path
	 * ({@link runPrePromptCompactionIfNeeded}).
	 */
	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.#host.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.#model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.#host.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async resolveContextPromotionTarget(
		currentModel: Model,
		contextWindow: number,
		signal?: AbortSignal,
	): Promise<Model | undefined> {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId(), { signal });
		if (!apiKey) return undefined;
		return candidate;
	}

	#getCompactionModelCandidates(availableModels: Model[], filter?: (model: Model) => boolean): Model[] {
		return this.resolveCompactionModelCandidates(this.#model, availableModels, filter);
	}

	resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) return;
			seen.add(key);
			// `seen` still tracks rejected models so the largest-context fallback
			// scan below doesn't reintroduce them; the filter just suppresses
			// inclusion in this caller's candidate chain.
			if (filter && !filter(model)) return;
			candidates.push(model);
		};

		if (preferredModel) {
			addCandidate(resolveCompactionConfiguredTarget(preferredModel, availableModels));
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(
				resolveRoleModelFull(this.#host.settings, role, availableModels, preferredModel ?? undefined).model,
			);
		}

		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			if (!seen.has(`${model.provider}/${model.id}`)) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.#model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
		);
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		precomputedCandidates?: Model[],
	): Promise<CompactionResult> {
		const candidates =
			precomputedCandidates ?? this.#getCompactionModelCandidates(this.#host.modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId());
		let nativeCompactionFailure: { error: NativeCompactionError; provider: string } | undefined;

		for (const candidate of candidates) {
			const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId());
			if (!apiKey) continue;
			if (
				nativeCompactionFailure &&
				(candidate.provider !== nativeCompactionFailure.provider ||
					!shouldUseProviderNativeCompaction(candidate, preparation.settings))
			) {
				throw nativeCompactionFailure.error;
			}

			try {
				return await compact(
					this.#host.obfuscatePreparationForProvider(preparation),
					candidate,
					this.#host.modelRegistry.resolver(candidate, this.#host.sessionId()),
					this.#host.obfuscateTextForProvider(customInstructions),
					signal,
					{
						...options,
						metadata: this.#host.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
						telemetry,
						// Honor the user's /model thinking selection (incl. `off`) on
						// the manual `/compact` path. Clamped per-model inside compact()
						// via resolveCompactionEffort so unsupported-effort models
						// (xai-oauth/grok-build) don't trip requireSupportedEffort.
						thinkingLevel: this.#host.thinkingLevel(),
						tools: this.#host.agent.state.tools,
						sessionId: this.#host.sessionId(),
						promptCacheKey: this.#host.agent.promptCacheKey ?? this.#host.agent.sessionId,
						providerSessionState: this.#host.providerSessionState,
						preferWebsockets: this.#host.preferWebsockets,
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// subagents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: async (requestModel, requestContext, requestOptions) => {
							const stream = await this.#host.sideStreamFn(requestModel, requestContext, requestOptions);
							return stream.result();
						},
					},
				);
			} catch (error) {
				const id = AIError.classify(error instanceof NativeCompactionError ? error.cause : error, candidate.api);
				if (AIError.is(id, AIError.Flag.AuthFailed)) continue;
				if (error instanceof NativeCompactionError) {
					nativeCompactionFailure ??= { error, provider: candidate.provider };
					continue;
				}
				throw error;
			}
		}

		if (nativeCompactionFailure) throw nativeCompactionFailure.error;
		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#host.extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#host.extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.#host.sessionId(),
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Cap on snapcompact frames the post-compaction context can carry without
	 * busting the model window. Mirrors the per-frame token charge used by the
	 * projection ({@link snapcompact.FRAME_TOKEN_ESTIMATE}, the conservative
	 * high-res Anthropic ceiling), so picking `maxFrames` from this helper makes
	 * {@link #projectSnapcompactContextTokens} succeed by construction.
	 *
	 * Skip vs. cap use different reserves on purpose. The **skip** decision
	 * (return `0`) trips only when kept-recent plus non-message tokens already
	 * eat the entire `ctxWindow − reserve` envelope: at that point no archive
	 * shape — frame-bearing or text-only — can fit, and the caller MUST
	 * shortcut to the LLM summarizer instead of re-running snapcompact to
	 * re-emit the "could not bring the context under the limit" warning every
	 * threshold tick. The **cap** calculation subtracts a shape-aware reserve
	 * (`2 × geometry(shape).capacity` chars worth of text edges, billed at the
	 * tiktoken cl100k baseline, plus a 2k summary-template allowance) sized
	 * from the same `shape` snapcompact will use, so the projection still
	 * passes once frames land — but it MUST NOT gate the skip decision, since
	 * a frame-less archive (`text.length <= 2 * edgeCap` short-circuit in
	 * `planArchive`) typically costs only a few hundred tokens of summary
	 * lead and would fit under residual headroom far smaller than the cap
	 * reserve (chatgpt-codex reviews on #3249).
	 *
	 * Returns `1` when the frame charge would overflow but the text-only path
	 * still has room: snapcompact's planner picks the frame-less layout
	 * automatically when the discarded text fits in the edges, so giving it
	 * the minimum cap lets it succeed instead of being skipped outright.
	 *
	 * Without this cap, the bundled `MAX_FRAMES_DEFAULT = 80` × 5024 tokens =
	 * ~402k frame-token projection always overflows any sub-1M-token window
	 * (issue #3247).
	 */
	#computeSnapcompactMaxFrames(preparation: CompactionPreparation, settings: EngineCompactionSettings): number {
		const ctxWindow = this.#model?.contextWindow ?? 0;
		if (ctxWindow <= 0) {
			return Math.min(
				snapcompact.MAX_FRAMES_DEFAULT,
				snapcompact.maxFramesForDataBudget(),
				snapcompact.providerFrameBudget(this.#model?.provider),
			);
		}
		const reserve = effectiveReserveTokens(ctxWindow, settings);
		let baseTokens = computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer);
		baseTokens += this.#tokenizer.countMessages(preparation.recentMessages);
		const totalBudget = ctxWindow - reserve;
		// Skip iff there is no headroom whatsoever; a text-only archive costs
		// far less than the cap reserve below, so any positive residual is
		// worth attempting and the projection guard catches actual overflow.
		if (baseTokens >= totalBudget) return 0;
		// Cap reserve mirrors what `countMessage(summaryMessage)` will charge
		// when frames > 0: `countTokens(summaryTemplate ‖ textHead ‖ textTail)`
		// plus `numFrames × FRAME_TOKEN_ESTIMATE`. Resolve the shape this
		// snapcompact pass will actually use (matches the `shape` argument
		// passed to `snapcompact.compact` in the auto and manual paths) so the
		// text-edge cost reflects the live frame geometry rather than a fixed
		// approximation. Reviewer (chatgpt-codex on #3249): a 4k reserve
		// undersized the ~7k text-edge cost on the default Anthropic
		// 11on16-bw shape, so the projection then rejected the `maxFrames`
		// the cap had picked and the warning loop reappeared.
		//
		// - `textHead` and `textTail` each consume up to `geometry.capacity`
		//   chars when frames > 0 (one HQ-capacity page per edge: see
		//   `TEXT_EDGE_PAGES = 1` in `planArchive`), so 2 × capacity chars
		//   total. Per-shape capacity: Anthropic 11on16-bw ~13.9k, Opus
		//   1932px ~21k, Gemini 8on22-bw 2048px ~23.8k, OpenAI 1568px ~13.9k.
		// - tiktoken cl100k ≈ 4 chars/token on ASCII (verified empirically
		//   for prose, code, and JSON); a 1.15 multiplier absorbs tokenizer
		//   drift on denser content (e.g. dense JSON / tool-result blobs).
		// - Summary template (intro + FILES section + grid notes) bills
		//   ~2k tokens for typical sessions.
		const shape = snapcompact.resolveShape(this.#model, this.#host.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const capReserve = textEdgeTokens + SUMMARY_TEMPLATE_TOKENS;
		const frameBudget = totalBudget - baseTokens - capReserve;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 1;
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
			snapcompact.providerFrameBudget(this.#model?.provider),
		);
	}

	#snapcompactFramePayloadBytes(result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		return archive ? snapcompact.frameDataBytes(archive.frames) : 0;
	}

	#deadEndRemedies(defaultRemedies: string, implicatedFrames: number): string {
		if (implicatedFrames <= 0) return defaultRemedies;
		return `reduce archived image frames (${implicatedFrames} held) — providers often bill vision media separately from tokens; ${defaultRemedies}`;
	}

	/**
	 * Project the post-compaction context size of a snapcompact result: kept
	 * recent messages + the summary message with its re-attached frames + the
	 * fixed non-message overhead (system prompt + tools). Mirrors how the
	 * compacted context is rebuilt, so the estimate matches the wire shape, and
	 * lets the caller decide whether snapcompact brought the context under the
	 * window or should fall back to an LLM summary.
	 */
	#projectSnapcompactContextTokens(preparation: CompactionPreparation, result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const blocks = archive
			? snapcompact.historyBlocks(archive, { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET })
			: undefined;
		const summaryMessage = createCompactionSummaryMessage(
			result.summary,
			result.tokensBefore,
			new Date().toISOString(),
			{
				shortSummary: result.shortSummary,
				blocks,
			},
		);
		let tokens =
			computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer) +
			this.#tokenizer.countMessage(summaryMessage);
		tokens += this.#tokenizer.countMessages(preparation.recentMessages);
		return tokens;
	}

	/**
	 * Estimated context tokens after a compaction commit: fixed non-message
	 * overhead + the summary message (with any snapcompact frames re-attached)
	 * + every message from `firstKeptEntryId` to the branch leaf. Mirrors the
	 * post-commit context rebuild; persisted as `tokensAfter` on the entry so
	 * the transcript divider can show the before → after amounts.
	 */
	#projectCompactedContextTokens(args: {
		summary: string;
		shortSummary: string | undefined;
		tokensBefore: number;
		firstKeptEntryId: string;
		preserveData: Record<string, unknown> | undefined;
	}): number {
		const archive = snapcompact.getPreservedArchive(args.preserveData);
		const blocks = archive
			? snapcompact.historyBlocks(archive, { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET })
			: undefined;
		const summaryMessage = createCompactionSummaryMessage(args.summary, args.tokensBefore, new Date().toISOString(), {
			shortSummary: args.shortSummary,
			blocks,
		});
		let tokens =
			computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer) +
			this.#tokenizer.countMessage(summaryMessage);
		let inKeptRegion = false;
		for (const entry of this.#host.sessionManager.getBranch()) {
			if (entry.id === args.firstKeptEntryId) inKeptRegion = true;
			if (!inKeptRegion) continue;
			if (entry.type === "message") tokens += this.#tokenizer.countMessage(entry.message);
		}
		return tokens;
	}

	/**
	 * Post-maintenance progress check for the context-full / snapcompact tail.
	 *
	 * After `appendCompaction` rewrote history and `replaceMessages` swapped in the
	 * compacted context, measure the residual context off the live message set and
	 * decide whether maintenance actually created headroom. Mirrors the shake
	 * recovery-band logic (#2275): a session whose single most-recent turn already
	 * blows the threshold cannot be reduced by compaction (findCutPoint keeps that
	 * turn verbatim), so re-firing on the next agent_end just thrashes. We only
	 * report progress when residual context lands at or below
	 * `COMPACTION_RECOVERY_BAND × threshold` — a band that sits strictly under the
	 * compaction threshold, so reaching it guarantees the next turn cannot
	 * re-trip threshold compaction.
	 *
	 * When the model/window is unknown we cannot evaluate the band, so we
	 * optimistically allow the continuation (preserving prior behavior).
	 */
	#compactionCreatedHeadroom(): boolean {
		const contextWindow = this.#model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.#host.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		// Residual at/below the band is authoritative headroom: the band sits
		// strictly under the compaction threshold, so the next turn cannot
		// re-trip threshold compaction regardless of how little this pass shaved.
		// Don't add a secondary "smaller than the trigger" guard — when stale/
		// tool-output pruning already dropped context under the band before this
		// pass, the trigger is itself sub-band, and requiring a strict reduction
		// would suppress a valid continuation and emit a false no-progress warning
		// even though compaction left the session safe.
		return residualTokens <= recoveryBand;
	}

	/**
	 * Whether the current stored context fits `model`'s usable window
	 * (`contextWindow - reserve`), using the same reserve resolution as
	 * compaction. This is deliberately independent of `compaction.enabled`: an
	 * oversized request overflows the provider whether or not compaction would
	 * have run, so a fit check must judge the raw budget.
	 *
	 * The default absolute reserve can exceed bundled small-context windows, or
	 * nearly consume a 16k-class window; those known-impossible defaults fall
	 * back to the proportional 15% reserve. Explicit valid reserves still define
	 * the usable prompt budget so callers do not enter headroom the user
	 * intentionally reserved.
	 *
	 * Used by the retry-fallback selector to skip a candidate whose window cannot
	 * hold the retry context before switching onto it, and (via
	 * {@link #compactionCreatedRetryFit}) to decide whether an overflow recovery
	 * produced a retryable prompt. `excludedMessage` identifies a failed assistant
	 * turn that will be removed before retrying; subtracting it makes the selector
	 * judge the request that will actually be sent. When the window is unknown we
	 * cannot evaluate the budget, so we optimistically report a fit (preserving
	 * prior behavior).
	 */
	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean {
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const activeExcludedMessage =
			excludedMessage && this.#host.messages().includes(excludedMessage) ? excludedMessage : undefined;
		const providerExcludedTokens = activeExcludedMessage ? this.#tokenizer.countMessage(activeExcludedMessage) : 0;
		const storedExcludedTokens = activeExcludedMessage
			? this.#tokenizer.countMessage(activeExcludedMessage, { excludeEncryptedReasoning: true })
			: 0;
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			Math.max(0, (this.#host.getContextUsage({ contextWindow })?.tokens ?? 0) - providerExcludedTokens),
			Math.max(0, this.#estimateStoredContextTokens() - storedExcludedTokens),
		);
		const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, compactionSettings));
		return residualTokens <= fitBudget;
	}

	/**
	 * Retry-side check: whether an overflow/incomplete recovery rebuilt a prompt
	 * that fits the active model's window again. Callers MUST invoke this AFTER
	 * dropping the failed assistant from `this.#host.messages()` so the just-failed
	 * turn (absent from the retry prompt) is excluded from the estimate. Unlike
	 * the `COMPACTION_RECOVERY_BAND × threshold` hysteresis the auto-continue
	 * thrash guard uses, a retry only needs to *fit* — a 200k-window prompt
	 * compacted from overflow down to ~150k is retryable even though it sits above
	 * `0.8 × 170k` (PR #3412 review).
	 */
	#compactionCreatedRetryFit(): boolean {
		return this.#model ? this.contextFitsModel(this.#model) : true;
	}

	/**
	 * Last-resort tiered reducer when {@link runAutoCompaction} would otherwise
	 * dead-end. The summarizer cut at the only available turn boundary, but the
	 * kept tail is still over the recovery band because a single recent turn (a
	 * large tool-result, a heavy fenced/XML block, attached images) is itself
	 * bigger than the band and `findCutPoint` cannot cut inside one message.
	 *
	 * Tier 1 — `shake("elide")` reaches INSIDE that tail: heavy tool-result /
	 * block content is offloaded to one `artifact://` blob behind a recoverable
	 * placeholder. Skipped when this pass already ran a shake (`skipElide`).
	 * Tier 2 — `dropImages()`: the manual `/shake images` remedy, automated.
	 * Image blocks are stripped from the branch; unlike elided text they are NOT
	 * artifact-recoverable, so this tier only runs once elide has failed the
	 * progress re-test.
	 *
	 * Each tier that rewrote history re-anchors the in-flight context snapshot,
	 * then the caller's progress predicate is re-tested; the first tier that
	 * restores progress emits one info notice describing everything freed and
	 * stops. Returns whether progress was restored — `false` falls through to
	 * the dead-end warning.
	 */
	async #rescueCompactionDeadEnd(
		signal: AbortSignal,
		options: { skipElide: boolean; hasProgress: () => boolean },
	): Promise<boolean> {
		if (signal.aborted) return false;
		// Tier 0 — a snapcompact pass whose just-written frame archive is itself
		// the over-budget cost (each pass re-renders the carried-forward text
		// into MORE frames, so the archive grows past the recovery band and the
		// elide/image tiers below can never shrink it): rebuild the archive at
		// a threshold-derived frame budget.
		const frameRescue = await this.#rescueSnapcompactFrameOverflow(
			this.#host.sessionManager.getBranch(),
			resolveMethodSettings(this.#host.settings.getGroup("compaction"), "snapcompact"),
			signal,
		);
		if (frameRescue !== undefined && options.hasProgress()) return true;
		let elided = 0;
		let elidedTokens = 0;
		let elideSink = "placeholders";
		if (!options.skipElide) {
			try {
				const result = await this.#host.shake("elide", { config: RESCUE_SHAKE_CONFIG, signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
				if (elided > 0) {
					// The elide pass rewrote history; re-anchor the in-flight snapshot
					// so the caller's headroom/retry-fit re-test measures the shaken
					// context.
					this.#host.rebaseAfterCompaction();
				}
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (elided > 0 && options.hasProgress()) {
				this.#host.emitNotice(
					"info",
					`Compaction dead-end recovery: ${this.#describeElideRescue(elided, elidedTokens, elideSink)} so maintenance could make progress.`,
					"compaction",
				);
				return true;
			}
		}
		if (signal.aborted) return false;
		let imagesDropped = 0;
		try {
			imagesDropped = (await this.#host.dropImages()).removed;
			if (imagesDropped > 0) this.#host.rebaseAfterCompaction();
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (imagesDropped > 0 && options.hasProgress()) {
			const elidedPart = elided > 0 ? `${this.#describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
			this.#host.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${imagesDropped} attached image${imagesDropped === 1 ? "" : "s"} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${elided} heavy block${elided === 1 ? "" : "s"} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	/**
	 * Frame budget for {@link #rescueSnapcompactFrameOverflow}: targets
	 * `COMPACTION_RECOVERY_BAND × threshold` (the same band
	 * {@link #compactionCreatedHeadroom} re-tests), not the window-fit budget
	 * {@link #computeSnapcompactMaxFrames} sizes against — a rebuilt archive
	 * must land back under the maintenance trigger, or the next settle
	 * re-enters the same dead-end. Cap reserve mirrors
	 * #computeSnapcompactMaxFrames (text edges + summary template), and
	 * `keptTailTokens` charges the kept entries AFTER the archive so the
	 * budget mirrors what #compactionCreatedHeadroom will actually measure.
	 * Returns 0 when not even one frame fits that budget — the rebuild could
	 * never create headroom, so the caller must not append it.
	 */
	#computeSnapcompactRescueMaxFrames(settings: EngineCompactionSettings, keptTailTokens: number): number {
		const ctxWindow = this.#model?.contextWindow ?? 0;
		if (ctxWindow <= 0) {
			return Math.min(
				snapcompact.MAX_FRAMES_DEFAULT,
				snapcompact.maxFramesForDataBudget(),
				snapcompact.providerFrameBudget(this.#model?.provider),
			);
		}
		const thresholdTokens = resolveThresholdTokens(ctxWindow, settings);
		const recoveryBandTokens = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		const baseTokens = computeNonMessageTokens(this.#host.nonMessageTokenSource(), this.#tokenizer);
		const shape = snapcompact.resolveShape(this.#model, this.#host.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const frameBudget = recoveryBandTokens - baseTokens - keptTailTokens - textEdgeTokens - SUMMARY_TEMPLATE_TOKENS;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 0;
		// Same hard caps as #computeSnapcompactMaxFrames: a threshold-derived
		// count above the per-request payload or provider image budget would
		// "shrink" a huge archive to a frame count the rebuilt prompt can never
		// attach anyway.
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
			snapcompact.providerFrameBudget(this.#model?.provider),
		);
	}

	/**
	 * Dead-end rescue for a branch whose latest snapcompact CompactionEntry is
	 * itself billed past the maintenance threshold
	 * (`FRAME_TOKEN_ESTIMATE × frames`). Reaching the `!preparation` dead-end
	 * proves everything after that entry is already kept-recent (nothing to
	 * summarize), so the archive is the irreducible cost — and the elide/image
	 * tiers can never touch it: `collectShakeRegions` and `dropImages()` only
	 * inspect "message"/"custom_message" entries, so a `type: "compaction"`
	 * entry falls through both and the session re-warns on every resume (the
	 * shape issue #4786's rescue does not cover).
	 *
	 * Rebuilds the SAME archive locally — no LLM, no network — by re-running
	 * `snapcompact.compact()` over the entry's carried-forward source text at
	 * a maxFrames derived from the trigger threshold instead of the window:
	 * `planArchive` truncates the oldest chars to fit, so the rebuilt entry
	 * genuinely shrinks. The rebuilt entry keeps the stale entry's
	 * `firstKeptEntryId`, so the kept tail is untouched, and persisting
	 * through `appendCompaction()` lets the write-time superseded-compaction
	 * elision drop the stale frame payload from the JSONL automatically.
	 */
	async #rescueSnapcompactFrameOverflow(
		branchEntries: SessionEntry[],
		settings: EngineCompactionSettings,
		signal: AbortSignal,
	): Promise<snapcompact.CompactionResult | undefined> {
		if (signal.aborted) return undefined;
		// Re-rendering frames needs a vision-capable model, same gate as the
		// snapcompact method.
		if (!this.#model?.input.includes("image")) return undefined;
		const staleEntry = getLatestCompactionEntry(branchEntries);
		if (!staleEntry) return undefined;
		// Only rescue when the archive is the actual source of the overflow.
		// The frame budget below charges every kept entry the rebuilt context
		// will still carry — the kept-recent region from `firstKeptEntryId`
		// (re-emitted before the archive by buildSessionContext) plus the
		// entries after the archive — on top of the fixed context, mirroring
		// what #compactionCreatedHeadroom will measure. When not even one
		// frame fits (e.g. a huge kept tool result dominates), rebuilding
		// would append the replacement compaction at the leaf — turning the
		// branch tail into a compaction entry, which prepareCompaction's
		// last-entry guard can never summarize past even after an elide
		// shrinks the real culprit. Bail and let the elide/image tiers handle
		// that tail instead.
		let keptTailTokens = 0;
		let inKeptRegion = false;
		for (const entry of branchEntries) {
			if (entry.id === staleEntry.firstKeptEntryId) inKeptRegion = true;
			if (entry.id === staleEntry.id) {
				// Everything after the archive is always kept.
				inKeptRegion = true;
				continue;
			}
			if (!inKeptRegion) continue;
			const message = (entry as { message?: AgentMessage }).message;
			if (message) keptTailTokens += this.#tokenizer.countMessage(message);
		}
		const archive = snapcompact.getPreservedArchive(staleEntry.preserveData);
		if (!archive || archive.frames.length <= 1) return undefined;
		const archiveText = snapcompact.archiveSourceText(archive);
		if (!archiveText) return undefined;
		const maxFrames = this.#computeSnapcompactRescueMaxFrames(settings, keptTailTokens);
		if (maxFrames < 1 || maxFrames >= archive.frames.length) return undefined;

		const staleDetails = staleEntry.details as snapcompact.CompactionDetails | undefined;
		const fileOps = snapcompact.createFileOps();
		for (const file of staleDetails?.readFiles ?? []) fileOps.read.add(file);
		for (const file of staleDetails?.modifiedFiles ?? []) fileOps.edited.add(file);
		const shapeSetting = this.#host.settings.get("snapcompact.shape");
		const shape = snapcompact.resolveShapeForText(archiveText, this.#model, shapeSetting);
		let result: snapcompact.CompactionResult;
		try {
			result = await snapcompact.compact(
				{
					firstKeptEntryId: staleEntry.firstKeptEntryId,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					tokensBefore: staleEntry.tokensBefore,
					previousSummary: staleEntry.summary,
					previousPreserveData: staleEntry.preserveData,
					fileOps,
				},
				{
					convertToLlm,
					model: this.#model,
					...(shapeSetting === "auto" ? {} : { shape }),
					maxFrames,
				},
			);
		} catch (error) {
			logger.warn("Dead-end snapcompact frame rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (signal.aborted) return undefined;
		const rebuilt = snapcompact.getPreservedArchive(result.preserveData);
		if (!rebuilt || rebuilt.frames.length >= archive.frames.length) return undefined;

		const rebuiltEntryId = this.#host.sessionManager.appendCompaction(
			result.summary,
			result.shortSummary,
			result.firstKeptEntryId,
			result.tokensBefore,
			{
				details: result.details,
				preserveData: result.preserveData,
				method: "snapcompact",
				tokensAfter: this.#projectCompactedContextTokens({
					summary: result.summary,
					shortSummary: result.shortSummary,
					tokensBefore: result.tokensBefore,
					firstKeptEntryId: result.firstKeptEntryId,
					preserveData: result.preserveData,
				}),
			},
		);
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.rebaseAfterCompaction();
		// Same post-rewrite bookkeeping as the regular compaction append: the
		// rebuilt context no longer carries the transient plan reference (#1246),
		// and advisor cursors / todo phases were derived from the replaced
		// history.
		this.#host.resetPlanReference();
		this.#host.resetAdvisorRuntimes("compaction-rescue");
		this.#host.syncTodoPhasesFromBranch();
		this.#host.closeCodexProviderSessionsForHistoryRewrite();
		// Extensions must see the entry that is now active, not (only) the one
		// this rebuild just superseded — mirror the regular append path's hook.
		const rebuiltEntry = this.#host.sessionManager.getEntries().find(e => e.id === rebuiltEntryId) as
			| CompactionEntry
			| undefined;
		if (this.#host.extensionRunner && rebuiltEntry) {
			await this.#host.extensionRunner.emit({
				type: "session_compact",
				compactionEntry: rebuiltEntry,
				fromExtension: false,
			});
		}
		this.#host.emitNotice(
			"info",
			`Compaction dead-end recovery: rebuilt the trailing snapcompact archive at a smaller frame budget (${archive.frames.length} → ${rebuilt.frames.length} frames) so maintenance could make progress.`,
			"compaction",
		);
		return result;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 *
	 * @param allowDefer If true (default), a threshold-driven handoff preference
	 *   may schedule itself as a deferred post-prompt task and return a
	 *   deferred-handoff result immediately. The caller MUST avoid separately
	 *   scheduling `agent.continue()` then; pre-prompt callers pass `false` to
	 *   complete the handoff before the next agent turn begins.
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			/** Tokens from pending messages included in triggerContextTokens but absent from the prepared history. */
			pendingContextTokens?: number;
			/** Stored context before pending messages, measured before preparation rewrites its representation. */
			preparedContextTokens?: number;
			suppressContinuation?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
			/** Mid-turn: splice history then return; do not await UI/extension fan-out. */
			detachPostCommit?: boolean;
			/** Index to resume from after an earlier preferred method failed. */
			methodIndex?: number;
			/** A preceding shake already rewrote history before this fallback attempt. */
			fallbackFromShake?: boolean;
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (reason !== "idle" && !compactionSettings.enabled) return COMPACTION_CHECK_NONE;
		const methods = resolveCompactionMethodOrder(compactionSettings.methodOrder);
		if (methods.length === 0) return COMPACTION_CHECK_NONE;
		const generation = this.#host.promptGeneration();
		const terminalTextAnswer =
			options.terminalTextAnswer ?? isTerminalTextAssistantAnswer(this.#host.findLastAssistantMessage());
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;
		const startIndex = options.methodIndex ?? 0;
		let methodIndex = -1;
		let method: CompactionMethod | undefined;
		for (let index = startIndex; index < methods.length; index++) {
			const candidate = methods[index];
			const available =
				candidate === "remote"
					? canUseRemoteCompaction(this.#model, resolveMethodSettings(compactionSettings, candidate))
					: candidate === "snapcompact"
						? this.#model?.input.includes("image") === true
						: candidate === "handoff"
							? reason !== "overflow"
							: true;
			if (!available) continue;
			method = candidate;
			methodIndex = index;
			break;
		}
		if (!method) return COMPACTION_CHECK_NONE;

		// A speculative pass may have already produced this compaction's summary
		// in the background. Claiming consumes the slot either way: an in-flight
		// run is aborted (this real pass supersedes it) and an armed result is
		// returned only when still valid for the current branch/model/settings.
		// Snapcompact is local and instant, so an armed LLM summary (possible
		// only when settings/model changed since arming) never overrides it.
		const claimedSpec = this.#claimArmedSpeculation();
		const armedSpec = method === "snapcompact" ? undefined : claimedSpec;

		const effectiveSettings = resolveMethodSettings(compactionSettings, method);
		const fallbackFromShake = options.fallbackFromShake === true;
		// Shake runs inline (cheap, no remote LLM). If it cannot recover enough
		// context, resume from the next configured method instead of hardcoding a
		// context-full summary.
		if (method === "shake" && !armedSpec) {
			const outcome = await this.#runAutoShake(
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				terminalTextAnswer,
				options.triggerContextTokens,
				suppressContinuation,
				options.detachPostCommit === true,
			);
			if (outcome !== "fallback") return outcome;
			return await this.runAutoCompaction(reason, willRetry, deferred, allowDefer, {
				...options,
				methodIndex: methodIndex + 1,
				fallbackFromShake: true,
			});
		}
		// "overflow" and "incomplete" force inline execution because they are recovery
		// paths the caller wants resolved before scheduling the next turn. "idle" is
		// triggered by the idle loop and does its own scheduling.
		if (
			method === "handoff" &&
			!armedSpec &&
			!deferred &&
			allowDefer &&
			reason !== "overflow" &&
			reason !== "incomplete" &&
			reason !== "idle"
		) {
			this.#host.schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.runAutoCompaction(reason, willRetry, true, true, {
						...options,
						methodIndex,
						terminalTextAnswer,
					});
				},
				{ generation },
			);
			return {
				...COMPACTION_CHECK_DEFERRED_HANDOFF,
				continuationScheduled: shouldAutoContinue,
			};
		}

		const action: "context-full" | "handoff" | "snapcompact" | "remote" =
			armedSpec?.action ??
			(method === "remote"
				? "remote"
				: method === "snapcompact"
					? "snapcompact"
					: method === "handoff"
						? "handoff"
						: "context-full");
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		let compactionCommitted = false;
		try {
			// Emit start AFTER the controller is installed so isCompacting is already true
			// for any listener — and for input routed during this emit's event-loop yield:
			// a message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue (which handoff's agent.reset() would wipe).
			const startEvent = { type: "auto_compaction_start" as const, reason, action };
			await this.#emitLifecycleEvent(startEvent, false);
			if (armedSpec) {
				// A background speculation already produced this compaction's
				// summary; splice it in instead of paying for a blocking
				// summarization. tokensBefore reflects the live trigger size when
				// known — the armed value measured the smaller prefix at compute
				// time.
				logger.debug("Applying armed speculative compaction", {
					method: armedSpec.method,
					action,
					reason,
				});
				return await this.#commitAutoCompactionResult({
					summary: armedSpec.result.summary,
					shortSummary: armedSpec.result.shortSummary,
					firstKeptEntryId: armedSpec.result.firstKeptEntryId,
					tokensBefore: options.triggerContextTokens ?? armedSpec.result.tokensBefore,
					details: armedSpec.result.details,
					preserveData: armedSpec.result.preserveData,
					fromExtension: false,
					codexCompaction: armedSpec.codexCompaction,
					method: armedSpec.method,
					providerReplayThroughEntryId: armedSpec.result.preserveData?.openaiRemoteCompaction
						? armedSpec.snapshotLeafId
						: undefined,
					action,
					reason,
					willRetry,
					generation,
					shouldAutoContinue,
					terminalTextAnswer,
					suppressContinuation,
					fallbackFromShake,
					detachPostCommit: options.detachPostCommit === true,
					autoCompactionSignal,
					onCommitted: () => {
						compactionCommitted = true;
					},
				});
			}

			if (!this.#model) {
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
						skipped: true,
					},
					options.detachPostCommit === true,
				);
				return COMPACTION_CHECK_NONE;
			}

			const availableModels = this.#host.modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
						skipped: true,
					},
					options.detachPostCommit === true,
				);
				return COMPACTION_CHECK_NONE;
			}

			const pathEntries = this.#host.sessionManager.getBranch();

			let pathEntriesForCompaction = pathEntries;
			let preparation = prepareCompaction(pathEntriesForCompaction, effectiveSettings, this.#model, this.#tokenizer);
			if (!preparation) {
				// prepareCompaction found nothing to summarize because the kept region
				// is a single oversized recent turn — findCutPoint never cuts inside a
				// tool result, so a huge tool-result / fenced block tail leaves nothing
				// on the summarizable side and summary compaction cannot even start.
				// That is exactly the dead-end the elide shake rescues: it reaches
				// INSIDE the tail and offloads heavy content to an artifact placeholder,
				// shrinking the tail so findCutPoint can then move the cut and leave
				// older turns to summarize. Run the same tiered rescue the
				// post-maintenance guard uses (elide, then image drop), with progress
				// defined as "prepareCompaction now succeeds on the rewritten branch",
				// and fall through to the normal compaction body when it does (writing
				// a compaction entry anchors the stale billed usage so the
				// auto-continue re-check cannot re-trip and loop the warning — issue
				// #4786). `skipElide` when we already fell through from a shake
				// method (it tried and found nothing); skip entirely on the idle timer
				// (it re-checks usage on its own cadence).
				let rescueRewroteHistory = false;
				// A snapcompact CompactionEntry is invisible to both rescue tiers
				// below (they only inspect message entries) and to prepareCompaction
				// itself (last-entry-is-compaction guard), so a frame archive billed
				// past the threshold dead-ends here on every resume. Rebuild it at a
				// threshold-derived frame budget first — but treat that as complete
				// only when it actually created headroom: the latest archive may not
				// be the oversized tail (e.g. a huge kept tool result after it), and
				// declaring victory on a mere frame-count shrink would skip the
				// elide/image tiers that can still reach that tail and suppress a
				// warning the user should see.
				let frameRescueResult: snapcompact.CompactionResult | undefined;
				let frameRescueCreatedHeadroom = false;
				if (reason !== "idle") {
					frameRescueResult = await this.#rescueSnapcompactFrameOverflow(
						pathEntriesForCompaction,
						effectiveSettings,
						autoCompactionSignal,
					);
					if (frameRescueResult) {
						rescueRewroteHistory = true;
						pathEntriesForCompaction = this.#host.sessionManager.getBranch();
						frameRescueCreatedHeadroom = this.#compactionCreatedHeadroom();
					}
					if (!frameRescueCreatedHeadroom) {
						await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
							skipElide: fallbackFromShake,
							hasProgress: () => {
								// Only reached when a tier actually freed something, so the
								// branch has been rewritten either way.
								rescueRewroteHistory = true;
								pathEntriesForCompaction = this.#host.sessionManager.getBranch();
								preparation = prepareCompaction(
									pathEntriesForCompaction,
									effectiveSettings,
									this.#model,
									this.#tokenizer,
								);
								return preparation !== undefined;
							},
						});
					}
				}
				if (!preparation) {
					const noProgressDeadEnd = reason !== "idle" && !frameRescueCreatedHeadroom;
					const implicatedFrames =
						frameRescueResult && !frameRescueCreatedHeadroom
							? (snapcompact.getPreservedArchive(frameRescueResult.preserveData)?.frames.length ?? 0)
							: 0;
					const deadEndWarning = noProgressDeadEnd
						? compactionDeadEndWarning(
								this.#deadEndRemedies("shrink it (e.g. clear large tool output)", implicatedFrames),
							)
						: undefined;
					// A rescue that appended a rebuilt archive without creating
					// headroom must carry the dead-end badge on the entry the
					// transcript actually shows (the rebuilt one), or the pause
					// loses its explanation once the notice scrolls away. Stamp it
					// BEFORE the auto_compaction_end event: a result-carrying event
					// makes the TUI rebuild the chat from the current entries
					// immediately, so a later stamp would not appear until some
					// unrelated rebuild.
					if (deadEndWarning && frameRescueResult) {
						const stampEntry = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
						if (stampEntry) {
							stampEntry.warning = deadEndWarning;
							await this.#host.sessionManager.rewriteEntries();
						}
					}
					// A successful frame rescue rewrote history and activated a new
					// compaction entry — surface it as a real (non-skipped) result so
					// the TUI rebuilds the transcript instead of treating the pass as
					// a benign no-op.
					await this.#emitLifecycleEvent(
						{
							type: "auto_compaction_end",
							action,
							result: frameRescueResult && {
								...frameRescueResult,
								preserveData: snapcompact.stripPreservedArchive(frameRescueResult.preserveData),
							},
							aborted: false,
							willRetry: false,
							skipped: frameRescueResult === undefined,
						},
						options.detachPostCommit === true,
					);
					let continuationScheduled = false;
					if (frameRescueCreatedHeadroom) {
						continuationScheduled = this.#host.scheduleCompactionContinuation({
							generation,
							autoContinue: shouldAutoContinue,
							terminalTextAnswer,
							suppressContinuation,
						});
					} else if (!suppressContinuation && this.#host.agent.hasQueuedMessages()) {
						this.#host.scheduleAgentContinue({
							source: "frame-rescue-queued-message",
							delayMs: 100,
							generation,
							shouldContinue: () => this.#host.agent.hasQueuedMessages(),
						});
						continuationScheduled = true;
					}
					if (deadEndWarning) {
						this.#host.emitNotice("warning", deadEndWarning, "compaction");
					}
					// A rescue that offloaded content but still could not produce a
					// preparation rewrote the branch; flag it so the overflow-recovery
					// rollback does not re-restore the just-failed assistant turn on top
					// of the elided tail.
					const base = continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: noProgressDeadEnd
							? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION
							: COMPACTION_CHECK_NONE;
					return rescueRewroteHistory ? { ...base, historyRewritten: true } : base;
				}
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;
			let codexCompaction: CodexCompactionContext | undefined;

			if (this.#host.extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#host.extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntriesForCompaction,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#emitLifecycleEvent(
						{
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						},
						options.detachPostCommit === true,
					);
					return COMPACTION_CHECK_NONE;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			// Handoff runs as a summary source: generate the document off the live
			// context (cache-friendly side request), then commit it like any other
			// compaction summary. A failed generation advances to the next
			// configured preference.
			let handoffDocument: HandoffResult | undefined;
			if (action === "handoff" && compactionPrep.kind !== "fromHook") {
				handoffDocument = await this.#host.generateHandoffDocument(AUTO_HANDOFF_THRESHOLD_FOCUS, {
					autoTriggered: true,
					signal: autoCompactionSignal,
				});
				if (autoCompactionSignal.aborted) {
					await this.#emitLifecycleEvent(
						{
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						},
						options.detachPostCommit === true,
					);
					return COMPACTION_CHECK_NONE;
				}
				if (!handoffDocument) {
					logger.warn("Auto-handoff returned no document; trying next preferred compaction method", {
						reason,
					});
					await this.#emitLifecycleEvent(
						{
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: false,
							willRetry: false,
							errorMessage: "Auto-handoff returned no document; trying the next preferred compaction method.",
						},
						options.detachPostCommit === true,
					);
					return await this.runAutoCompaction(reason, willRetry, deferred, allowDefer, {
						...options,
						methodIndex: methodIndex + 1,
					});
				}
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			// Snapcompact runs locally first. The post-compaction context = kept-recent
			// + a summary message carrying the imaged archive at FRAME_TOKEN_ESTIMATE
			// per frame; #computeSnapcompactMaxFrames sizes the frame cap from the
			// live window so we don't run snapcompact just to overflow every threshold
			// tick. Any local blocker (unsupported snapcompact glyphs, kept-history too
			// large, post-render overflow) advances automatic maintenance to the next
			// configured preference instead of wedging the session (#3659). Manual
			// `/compact snapcompact` remains local-only because its one-method override
			// leaves no fallback.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			let snapcompactBlocker: string | undefined;
			if (action === "snapcompact" && compactionPrep.kind !== "fromHook") {
				// Drop `¶think:` sections for Anthropic-dialect targets: the archive
				// is replayed as text and Claude refuses reproduced reasoning
				// ("reasoning_extraction", issue #6093).
				const snapcompactIncludeThinking = preferredDialect(this.#model.id) !== "anthropic";
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
					{ includeThinking: snapcompactIncludeThinking },
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				const shapeSetting = this.#host.settings.get("snapcompact.shape");
				const shape = snapcompact.resolveShapeForText(probeText, this.#model, shapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					logger.warn("Snapcompact disabled: unsupported characters for selected snapcompact font", {
						model: this.#model?.id,
						unrenderableRatio: renderScan.unrenderableRatio,
					});
					snapcompactBlocker = `snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%); trying the next preferred compaction method.`;
				} else {
					const maxFrames = this.#computeSnapcompactMaxFrames(preparation, effectiveSettings);
					if (maxFrames < 1) {
						logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
							model: this.#model?.id,
						});
						snapcompactBlocker =
							"snapcompact: kept history alone exceeds the context budget; trying the next preferred compaction method.";
					} else {
						snapcompactResult = await snapcompact.compact(preparation, {
							convertToLlm,
							model: this.#model,
							...(shapeSetting === "auto" ? {} : { shape }),
							maxFrames,
							includeThinking: snapcompactIncludeThinking,
						});
						const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
						if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
							logger.warn("Snapcompact exceeded the per-request frame payload budget", {
								model: this.#model?.id,
								framePayloadBytes,
								budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
							});
							snapcompactBlocker =
								"snapcompact produced too much standing image payload; trying the next preferred compaction method.";
							snapcompactResult = undefined;
						}
						if (snapcompactResult) {
							const ctxWindow = this.#model?.contextWindow ?? 0;
							const budget =
								ctxWindow > 0
									? ctxWindow - effectiveReserveTokens(ctxWindow, effectiveSettings)
									: Number.POSITIVE_INFINITY;
							const projected = this.#projectSnapcompactContextTokens(preparation, snapcompactResult);
							const reductionBaseline =
								options.triggerContextTokens !== undefined
									? Math.max(0, options.triggerContextTokens - (options.pendingContextTokens ?? 0))
									: this.#projectPreSnapcompactContextTokens(preparation);
							const preparedReductionBaseline =
								options.preparedContextTokens === undefined
									? reductionBaseline
									: Math.max(0, reductionBaseline - options.preparedContextTokens) +
										this.#projectPreSnapcompactContextTokens(preparation);
							if (projected >= preparedReductionBaseline) {
								logger.warn("Snapcompact projection would not reduce context", {
									model: this.#model?.id,
									projected,
									reductionBaseline: preparedReductionBaseline,
								});
								snapcompactBlocker =
									"snapcompact would not reduce context; trying the next preferred compaction method.";
								snapcompactResult = undefined;
							} else if (projected > budget) {
								logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
									model: this.#model?.id,
									projected,
									budget,
								});
								snapcompactBlocker =
									"snapcompact could not bring the context under the limit; trying the next preferred compaction method.";
								snapcompactResult = undefined;
							}
						}
					}
				}
				if (snapcompactBlocker) {
					this.#host.emitNotice("warning", snapcompactBlocker, "compaction");
					await this.#emitLifecycleEvent(
						{
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: false,
							willRetry: false,
							errorMessage: snapcompactBlocker,
						},
						options.detachPostCommit === true,
					);
					return await this.runAutoCompaction(reason, willRetry, deferred, allowDefer, {
						...options,
						methodIndex: methodIndex + 1,
					});
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (handoffDocument) {
				const handoffSummary = handoffSummaryFromDocument(handoffDocument.document, preparation);
				summary = handoffSummary.summary;
				shortSummary = undefined;
				firstKeptEntryId = preparation.firstKeptEntryId;
				tokensBefore = preparation.tokensBefore;
				details = handoffSummary.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...compactionPrep.preserveData, ...snapcompactResult.preserveData };
			} else {
				const candidates = this.#getCompactionModelCandidates(
					availableModels,
					method === "remote" && !effectiveSettings.remoteEndpoint
						? candidate =>
								candidate.provider === this.#model?.provider &&
								shouldUseProviderNativeCompaction(candidate, effectiveSettings)
						: undefined,
				);
				const retrySettings = this.#host.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId());
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;
				let nativeCompactionFailure: { error: NativeCompactionError; provider: string } | undefined;
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});

				for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId());
					if (!apiKey) continue;
					if (
						nativeCompactionFailure &&
						(candidate.provider !== nativeCompactionFailure.provider ||
							!shouldUseProviderNativeCompaction(candidate, preparation.settings))
					) {
						throw nativeCompactionFailure.error;
					}

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#host.obfuscatePreparationForProvider(preparation),
								candidate,
								this.#host.modelRegistry.resolver(candidate, this.#host.sessionId()),
								undefined,
								autoCompactionSignal,
								{
									promptOverride: this.#host.obfuscateTextForProvider(compactionPrep.hookPrompt),
									extraContext: compactionPrep.hookContext,
									remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
									metadata: this.#host.agent.metadataForProvider(candidate.provider),
									initiatorOverride: "agent",
									convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
									telemetry,
									// Honor the user's /model thinking selection on the
									// auto-compaction path — the most-fired compaction
									// site. Clamped per-model inside compact() via
									// resolveCompactionEffort.
									thinkingLevel: this.#host.thinkingLevel(),
									tools: this.#host.agent.state.tools,
									sessionId: this.#host.sessionId(),
									promptCacheKey: this.#host.agent.promptCacheKey ?? this.#host.agent.sessionId,
									providerSessionState: this.#host.providerSessionState,
									preferWebsockets: this.#host.preferWebsockets,
									codexCompaction,
									// This loop already retries the whole compaction attempt on
									// transient errors, so the summarization oneshots must not
									// retry too — the budgets would multiply and each outer
									// wait would stack on top of an inner backoff.
									oneshotRetry: false,
								},
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							const id = AIError.classify(
								error instanceof NativeCompactionError ? error.cause : error,
								candidate.api,
							);
							if (AIError.is(id, AIError.Flag.AuthFailed)) {
								if (!nativeCompactionFailure) lastError = this.#buildCompactionAuthError();
								break;
							}
							if (AIError.is(id, AIError.Flag.Timeout)) {
								const nativeFailure = error instanceof NativeCompactionError;
								logger.warn(
									nativeFailure
										? "Provider-native auto-compaction timed out, preserving native failure"
										: hasMoreCandidates
											? "Auto-compaction summarization timed out, trying next model"
											: "Auto-compaction summarization timed out, not retrying same model",
									{
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									},
								);
								if (nativeFailure) {
									nativeCompactionFailure ??= { error, provider: candidate.provider };
									lastError = nativeCompactionFailure.error;
								} else {
									lastError = error;
								}
								break;
							}

							const retryAfterMs = this.#host.parseRetryAfterMsFromError(message);
							// An input the summarizer cannot fit is deterministic: the same
							// prompt fails identically every attempt, so the retry budget is
							// pure latency and the next candidate (a larger window) is the
							// only move that can succeed. Overflow therefore vetoes the
							// transient/usage-limit arms, which a provider blob can trip on
							// coincidence alone.
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								!AIError.is(id, AIError.Flag.ContextOverflow) &&
								(retryAfterMs !== undefined ||
									AIError.is(id, AIError.Flag.Transient) ||
									AIError.is(id, AIError.Flag.UsageLimit));
							if (!shouldRetry) {
								if (error instanceof NativeCompactionError) {
									nativeCompactionFailure ??= { error, provider: candidate.provider };
									lastError = nativeCompactionFailure.error;
								} else {
									lastError = error;
								}
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								if (error instanceof NativeCompactionError) {
									nativeCompactionFailure ??= { error, provider: candidate.provider };
									lastError = nativeCompactionFailure.error;
									break;
								}
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = error;
								break; // Exit retry loop, continue to next candidate
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, compactResult.preserveData);
			}

			return await this.#commitAutoCompactionResult({
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
				fromExtension,
				codexCompaction,
				method: fromExtension ? undefined : method,
				action,
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				terminalTextAnswer,
				suppressContinuation,
				fallbackFromShake,
				detachPostCommit: options.detachPostCommit === true,
				autoCompactionSignal,
				onCommitted: () => {
					compactionCommitted = true;
				},
			});
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					},
					options.detachPostCommit === true,
				);
				return COMPACTION_CHECK_NONE;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const contextErrorMessage =
				reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: reason === "incomplete"
						? `Incomplete response recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`;
			if (!compactionCommitted && methodIndex + 1 < methods.length) {
				logger.warn("Automatic compaction method failed; trying next preference", {
					method,
					error: errorMessage,
				});
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
						errorMessage: `${contextErrorMessage}; trying the next preferred compaction method.`,
					},
					options.detachPostCommit === true,
				);
				return await this.runAutoCompaction(reason, willRetry, deferred, allowDefer, {
					...options,
					methodIndex: methodIndex + 1,
				});
			}
			await this.#emitLifecycleEvent(
				{
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: contextErrorMessage,
				},
				options.detachPostCommit === true,
			);
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Shared auto-maintenance commit tail: append the compaction entry, splice
	 * the rebuilt context into the live agent, run the post-commit progress
	 * checks (retry fit / recovery band with the tiered dead-end rescue), emit
	 * `auto_compaction_end`, and schedule the follow-up turn. Used by both the
	 * blocking production path and the armed speculative-apply path.
	 */
	async #commitAutoCompactionResult(args: {
		summary: string;
		shortSummary: string | undefined;
		firstKeptEntryId: string;
		tokensBefore: number;
		details: unknown;
		preserveData: Record<string, unknown> | undefined;
		fromExtension: boolean;
		codexCompaction: CodexCompactionContext | undefined;
		method: CompactionMethod | undefined;
		providerReplayThroughEntryId?: string;
		action: "context-full" | "handoff" | "snapcompact" | "remote";
		reason: "overflow" | "threshold" | "idle" | "incomplete";
		willRetry: boolean;
		generation: number;
		shouldAutoContinue: boolean;
		terminalTextAnswer: boolean;
		suppressContinuation: boolean;
		fallbackFromShake: boolean;
		detachPostCommit: boolean;
		autoCompactionSignal: AbortSignal;
		onCommitted: () => void;
	}): Promise<CompactionCheckResult> {
		const { action, reason, willRetry, detachPostCommit, autoCompactionSignal } = args;
		if (autoCompactionSignal.aborted) {
			await this.#emitLifecycleEvent(
				{
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				},
				detachPostCommit,
			);
			return COMPACTION_CHECK_NONE;
		}

		args.onCommitted();
		const savedCompactionEntry = await this.#commitCompactionEntry({
			summary: args.summary,
			shortSummary: args.shortSummary,
			firstKeptEntryId: args.firstKeptEntryId,
			tokensBefore: args.tokensBefore,
			details: args.details,
			fromExtension: args.fromExtension,
			preserveData: args.preserveData,
			codexCompaction: args.codexCompaction,
			method: args.method,
			providerReplayThroughEntryId: args.providerReplayThroughEntryId,
			advisorResetReason: "auto-compaction",
			detachExtensionEmit: detachPostCommit,
		});

		const result: CompactionResult = {
			summary: args.summary,
			shortSummary: args.shortSummary,
			firstKeptEntryId: args.firstKeptEntryId,
			tokensBefore: args.tokensBefore,
			details: args.details,
			preserveData: snapcompact.stripPreservedArchive(args.preserveData),
		};
		// Post-maintenance progress guard — evaluated BEFORE emitting
		// auto_compaction_end so the TUI rebuild triggered by that event
		// already reflects any rescue rewrite (elide / image-drop) and the
		// dead-end warning stamped on the compaction entry. Snapcompact can
		// project over budget and fall back to a context-full summary; the
		// summarizer keeps `keepRecentTokens` of recent history verbatim and
		// findCutPoint can only cut at turn boundaries (never tool results),
		// so a single oversized recent turn (e.g. a huge tool result) leaves
		// the rewritten context still above threshold. Scheduling the
		// continuation regardless means the next agent_end re-enters
		// checkCompaction over the same oversized tail and re-fires forever.
		// The retry and the threshold auto-continue use different progress
		// tests (a recoverable overflow only has to fit; the auto-continue
		// thrash needs the stricter recovery band), so each branch evaluates
		// its own below.
		let continuationScheduled = false;
		// A non-idle pass that wanted to continue (retry or auto-continue) but freed
		// too little for that path to proceed is a dead-end: warn once so the user
		// understands why maintenance paused instead of silently looping.
		let noProgressDeadEnd = false;
		let retryFits = false;
		let hasHeadroom = false;

		if (willRetry) {
			const messages = this.#host.agent.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "assistant") {
				const lastAssistant = lastMsg as AssistantMessage;
				// Drop the prior turn before retry when it carries no actionable deliverable:
				// - "error": failure was kept in history but must not re-enter the next turn's prompt.
				// - reason === "incomplete" && stopReason === "length": truncated output (typically
				//   reasoning-only) — re-running it produces the same dead-end.
				const shouldDrop =
					lastAssistant.stopReason === "error" ||
					(reason === "incomplete" && lastAssistant.stopReason === "length");
				if (shouldDrop) {
					this.#host.agent.replaceMessages(messages.slice(0, -1));
					this.#host.rebaseAfterCompaction();
				}
			}

			// Retry only needs the rebuilt prompt to fit the window again — measured
			// AFTER the drop above so the just-failed turn (which the retry prompt
			// won't include) is excluded. Reusing the auto-continue recovery band
			// here turned recoverable overflows into manual dead-ends (#3412 review),
			// so use the looser fit budget.
			retryFits = this.#compactionCreatedRetryFit();
			if (!retryFits) {
				retryFits = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
					skipElide: args.fallbackFromShake,
					hasProgress: () => this.#compactionCreatedRetryFit(),
				});
			}
			if (!retryFits) {
				noProgressDeadEnd = true;
			}
		} else if (reason !== "idle") {
			// Mirror the shake recovery-band check: only auto-continue when compaction
			// landed residual context under `COMPACTION_RECOVERY_BAND × threshold`.
			// Re-firing on a history that still sits just over the line is the
			// snapcompact thrash, so require genuine headroom, not a bare fit. Even
			// when auto-continue is disabled, a no-headroom threshold pass must still
			// block later automatic continuations (todo reminders/session_stop hooks)
			// from re-entering the same oversized context.
			hasHeadroom = this.#compactionCreatedHeadroom();
			if (!hasHeadroom) {
				hasHeadroom = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
					skipElide: args.fallbackFromShake,
					hasProgress: () => this.#compactionCreatedHeadroom(),
				});
			}
			if (!hasHeadroom) {
				noProgressDeadEnd = true;
			}
		}

		const deadEndWarning = noProgressDeadEnd ? compactionDeadEndWarning("clear large tool output") : undefined;
		if (deadEndWarning) {
			// Stamp the divider: the compaction bar badges the dead-end and
			// carries the full warning in its ctrl+o detail, so the pause
			// stays explained even after the notice row scrolls away. Stamp
			// the branch's LATEST compaction entry — a frame rescue may have
			// superseded `savedCompactionEntry` with a rebuilt one, and the
			// collapsed transcript badges only the active entry.
			const stampEntry = getLatestCompactionEntry(this.#host.sessionManager.getBranch()) ?? savedCompactionEntry;
			if (stampEntry) {
				stampEntry.warning = deadEndWarning;
				await this.#host.sessionManager.rewriteEntries();
			}
		}

		await this.#emitLifecycleEvent(
			{ type: "auto_compaction_end", action, result, aborted: false, willRetry },
			detachPostCommit,
		);

		if (retryFits) {
			this.#host.scheduleAgentContinue({
				source: "compaction-retry",
				delayMs: 100,
				generation: args.generation,
			});
			continuationScheduled = true;
		} else {
			continuationScheduled = this.#host.scheduleCompactionContinuation({
				generation: args.generation,
				autoContinue: hasHeadroom && args.shouldAutoContinue,
				terminalTextAnswer: args.terminalTextAnswer,
				suppressContinuation: args.suppressContinuation,
			});
		}

		if (deadEndWarning) {
			this.#host.emitNotice("warning", deadEndWarning, "compaction");
		}
		if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
		return noProgressDeadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
	}

	/**
	 * Run a shake-method auto-maintenance pass. Emits the
	 * `auto_compaction_start`/`auto_compaction_end` pair with a shake `action`,
	 * runs {@link shake} inline against the protect-window config, and schedules
	 * continuation exactly like the context-full tail.
	 *
	 * Returns `"fallback"` when the caller should advance to the next configured
	 * method; returns a check result when shake handled the maintenance itself.
	 */
	async #runAutoShake(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		generation: number,
		autoContinue: boolean,
		terminalTextAnswer: boolean,
		triggerContextTokens?: number,
		suppressContinuation = false,
		detachPostCommit = false,
	): Promise<CompactionCheckResult | "fallback"> {
		const action = "shake";
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		const signal = controller.signal;
		try {
			await this.#emitLifecycleEvent({ type: "auto_compaction_start", reason, action }, false);
			const result = await this.#host.shake("elide", { config: DEFAULT_SHAKE_CONFIG, signal });
			if (signal.aborted) {
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					},
					detachPostCommit,
				);
				return COMPACTION_CHECK_NONE;
			}
			const reclaimed = result.toolResultsDropped + result.blocksDropped > 0;
			// Detect the dead-loop reported in issues #2119/#2275: the threshold check
			// fires, shake runs, but residual context is still above the configured
			// threshold. The next agent_end would re-trigger shake, which has nothing
			// new to drop on the second pass, so the loop spins until the user kills it.
			// Same hazard for "incomplete" (the retry would re-hit the length cap) and
			// for the existing "overflow + nothing reclaimed" case. In every recovery
			// reason we advance to the next preferred method so the situation actually
			// resolves; "idle" is exempt because its 60s+ timer re-checks usage before
			// re-firing and cannot dead-loop on its own.
			//
			// #2275: the post-shake check MUST stay provider-anchored when caller
			// usage and local estimates diverge. The local estimator undercounts
			// thinking-signature payloads, so thinking-heavy sessions can read well
			// below the provider usage that fired the threshold. Prefer the caller's
			// context figure when supplied, then subtract shake's own savings and add
			// hysteresis (80% recovery band) so we don't oscillate at the boundary.
			// Threshold callers pass the provider-billed trigger after accounting for
			// any supersede/drop-useless pruning that already rewrote the next prompt;
			// without that pre-shake savings, shake can advance to the next preference
			// even though the post-prune history is already inside the recovery band.
			const contextWindow = this.#model?.contextWindow ?? 0;
			const compactionSettings = this.#host.settings.getGroup("compaction");
			let stillOverThreshold = false;
			if (contextWindow > 0) {
				if (typeof triggerContextTokens === "number" && Number.isFinite(triggerContextTokens)) {
					const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
					const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
					const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
					stillOverThreshold = correctedTokens > recoveryBand;
				} else {
					const postShakeTokens = this.#host.getContextUsage({ contextWindow })?.tokens ?? 0;
					stillOverThreshold = shouldCompact(postShakeTokens, contextWindow, compactionSettings);
				}
			}
			const shouldFallBack = reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
			if (shouldFallBack) {
				const errorMessage = reclaimed
					? `Auto-shake reclaimed ~${result.tokensFreed} tokens but context is still above the threshold; trying the next preferred compaction method.`
					: "Auto-shake found nothing eligible to drop; trying the next preferred compaction method.";
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
						skipped: !reclaimed,
						errorMessage,
					},
					detachPostCommit,
				);
				return "fallback";
			}
			await this.#emitLifecycleEvent(
				{
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry,
					skipped: !reclaimed,
				},
				detachPostCommit,
			);

			let continuationScheduled = false;
			if (willRetry) {
				// The shake rebuild replays every entry, so a trailing error/length
				// assistant from the failed turn re-enters agent state — drop it before
				// retrying, same as the context-full tail.
				const messages = this.#host.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) this.#host.agent.replaceMessages(messages.slice(0, -1));
				}
				this.#host.scheduleAgentContinue({
					source: "shake-retry",
					delayMs: 100,
					generation,
				});
				continuationScheduled = true;
			} else {
				continuationScheduled = this.#host.scheduleCompactionContinuation({
					generation,
					autoContinue: reason !== "idle" && autoContinue,
					terminalTextAnswer,
					suppressContinuation,
				});
			}
			if (!reclaimed) {
				return willRetry && continuationScheduled
					? { ...COMPACTION_CHECK_CONTINUATION, historyRewritten: true }
					: continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: COMPACTION_CHECK_NONE;
			}
			return {
				...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
				historyRewritten: true,
			};
		} catch (error) {
			if (signal.aborted) {
				await this.#emitLifecycleEvent(
					{
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					},
					detachPostCommit,
				);
				return COMPACTION_CHECK_NONE;
			}
			const message = error instanceof Error ? error.message : "shake failed";
			await this.#emitLifecycleEvent(
				{
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: message,
					skipped: false,
				},
				detachPostCommit,
			);
			// Overflow still needs recovery even if shake threw.
			return reason === "overflow" ? "fallback" : COMPACTION_CHECK_NONE;
		} finally {
			if (this.#autoCompactionAbortController === controller) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.#host.settings.set("compaction.enabled", enabled);
		if (enabled && resolveCompactionMethodOrder(this.#host.settings.get("compaction.methodOrder")).length === 0) {
			this.#host.settings.set("compaction.methodOrder", [...DEFAULT_COMPACTION_METHOD_ORDER]);
		}
	}

	/** Whether automatic maintenance has an enabled method to run. */
	get autoCompactionEnabled(): boolean {
		return (
			this.#host.settings.get("compaction.enabled") &&
			resolveCompactionMethodOrder(this.#host.settings.get("compaction.methodOrder")).length > 0
		);
	}
}
