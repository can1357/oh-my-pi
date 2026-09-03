import { scheduler } from "node:timers/promises";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	isSyntheticToolResultMessage,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Effort,
	Model,
	ModelUsageHealth,
	TextContent,
	ThinkingContent,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { extractRetryHint, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";

import type { Settings } from "../config/settings";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import malformedFunctionCallRetryTemplate from "../prompts/system/malformed-function-call-retry.md" with { type: "text" };
import thinkingLoopRedirectTemplate from "../prompts/system/thinking-loop-redirect.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampThinkingLevelToCeiling,
	modelSupportsEffortCeiling,
} from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type {
	InitialRetryFallbackState,
	UsageFallbackConfirmation,
	UsageFallbackConfirmer,
} from "./agent-session-types";
import { assistantTurnProducedOutput, isEmptyAssistantStop, isEmptyErrorTurn } from "./messages";
import {
	type ActiveRetryFallbackState,
	calculateRetryBackoffDelayMs,
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	getRetryFallbackChains,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	type RetryFallbackRevertPolicy,
	type RetryFallbackSelector,
	resolveRetryFallbackChainKey,
	type ServingModel,
	validateRetryFallbackChains,
} from "./retry-fallback-chains";
import { getLatestCompactionEntry } from "./session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";

const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const MALFORMED_FUNCTION_CALL_MAX_RETRIES = 3;
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;
const USAGE_PREFLIGHT_BLOCKED_PREFIX = "Usage preflight blocked:";
const STREAM_STALL_ERROR_RE = /stream stall/i;
const HTTP2_STREAM_RESET_ERROR_RE =
	/stream closed with error code\s+nghttp2_(?:internal_error|refused_stream)|nghttp2_(?:internal_error|refused_stream)|HTTP2(?:StreamReset|RefusedStream)/i;
// Gateway closes the SSE stream mid-generation without a terminal chunk
// (openai-completions "finish_reason", openai/azure responses "terminal
// response event"). Same transport-failure class as the stall/reset entries:
// retriable, and eligible for preserved-turn continuation on resolved tool turns.
const PREMATURE_STREAM_CLOSE_ERROR_RE = /stream closed before a (?:finish_reason|terminal response event)/i;
const IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN =
	/messages\.\d+\.content\.\d+.*\b(?:thinking|redacted_thinking)\b.*\blatest assistant message cannot be modified\b/is;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

function syntheticToolResultTailStart(messages: readonly AgentMessage[]): number {
	let index = messages.length;
	while (index > 0 && isSyntheticToolResultMessage(messages[index - 1])) {
		index--;
	}
	return index;
}

function retryableAssistantTurnEnd(messages: readonly AgentMessage[]): number | undefined {
	const turnEnd = syntheticToolResultTailStart(messages);
	const message = messages[turnEnd - 1];
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return turnEnd;
}
/** Whether `messages` ends in a failed/aborted turn whose most recent activity was a tool call. */
function abortedToolCallTail(messages: readonly AgentMessage[]): boolean {
	const turnEnd = retryableAssistantTurnEnd(messages);
	if (turnEnd === undefined) return false;
	// Synthetic tool results only ever trail a turn that emitted tool calls.
	if (turnEnd < messages.length) return true;
	const beforeTurn = messages[turnEnd - 2];
	return beforeTurn?.role === "toolResult" && beforeTurn.isError === true;
}
/**
 * Index of the first trailing failed tool result to strip for a tool replay,
 * or undefined when the tail does not qualify.
 *
 * Qualifies when the transcript ends in a fully failed/aborted tool batch
 * whose anchor assistant turn completed with runnable arguments
 * (`toolUse`/`stop`) — optionally followed by an aborted boundary with no tool
 * calls of its own (a live Esc; a restored session has already dropped it).
 * Stripping from the returned index leaves that assistant as the transcript
 * tail, which `Agent.continue()` resumes by re-executing the calls. A
 * partially successful batch never qualifies: re-running a completed call
 * would repeat its side effects. Synthetic placeholder tails never qualify
 * either — their anchor is the aborted turn itself and its arguments may be
 * truncated, so those are re-generated via a fresh model call instead.
 */
function toolReplayStart(messages: readonly AgentMessage[]): number | undefined {
	let end = messages.length;
	const tail = messages[end - 1];
	if (tail?.role === "assistant") {
		if (tail.stopReason !== "aborted" && tail.stopReason !== "error") return undefined;
		if (tail.content.some(block => block.type === "toolCall")) return undefined;
		end -= 1;
	}
	let start = end;
	while (start > 0 && messages[start - 1].role === "toolResult") start--;
	if (start === end) return undefined;
	const anchor = messages[start - 1];
	if (anchor?.role !== "assistant") return undefined;
	if (anchor.stopReason !== "toolUse" && anchor.stopReason !== "stop") return undefined;
	const callIds = new Set<string>();
	for (const block of anchor.content) {
		if (block.type === "toolCall") callIds.add(block.id);
	}
	if (end - start !== callIds.size) return undefined;
	for (let i = start; i < end; i++) {
		const result = messages[i];
		if (result.role !== "toolResult" || result.isError !== true || !callIds.has(result.toolCallId)) {
			return undefined;
		}
	}
	return start;
}

/** Result shape shared with automatic maintenance recovery. */
export interface RecoveryCompactionResult {
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface TurnRecoveryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	configWarnings: string[];
	model(): Model | undefined;
	/**
	 * Whether the live context fits `model`'s usable window. `excludedMessage`
	 * identifies a failed assistant turn that will be removed before retrying, so
	 * selection judges the request that will actually be sent. See
	 * `SessionMaintenance.contextFitsModel`.
	 */
	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean;
	/** Whether streamed text has already been committed to the active output sink. */
	textOutputCommitted(): boolean;
	thinkingLevel(): ThinkingLevel | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	/** Hard per-session effort ceiling; fallback recovery must never raise thinking above it. */
	thinkingLevelCeiling(): Effort | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	abortInProgress(): boolean;
	streamingEditAbortTriggered(): boolean;
	promptGeneration(): number;
	sessionId(): string;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: {
		source: string;
		delayMs?: number;
		generation?: number;
		onError?: (error: unknown) => void;
	}): void;
	waitForSessionMessagePersistence(message: AssistantMessage): Promise<void>;
	appendSessionMessage(message: AssistantMessage): void;
	persistedAssistantEntryId(message: AssistantMessage): string | undefined;
	sessionMessageAlreadyPersisted(message: AssistantMessage): boolean;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	resetCurrentResponsesProviderSession(reason: string): void;
	/**
	 * Spend a saved Codex reset for the blocked pool, if eligible.
	 * `activeBlockUnblockAtMs` is the absolute unblock time parsed from the
	 * live usage-limit error — authoritative for the active account when the
	 * usage report still shows a pre-block snapshot.
	 */
	maybeAutoRedeemCodexReset(activeBlockUnblockAtMs?: number): Promise<boolean>;
	runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred?: boolean,
		allowDefer?: boolean,
		options?: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
		},
	): Promise<RecoveryCompactionResult>;
	withBashBranchTransition<T>(operation: () => T): T;
}

/** Construction-time retry state restored from model selection. */
export interface TurnRecoveryOptions {
	initialRetryFallback?: InitialRetryFallbackState;
}

type PendingRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

type UsageLimitOutcome = {
	switchedCredential: boolean;
	retryAfterMs: number;
	retryAtMs: number | undefined;
};

/** Owns terminal-stop recovery, automatic retries, and fallback routing. */
export class TurnRecovery {
	readonly #host: TurnRecoveryHost;
	#retryAbortController: AbortController | undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined;
	#retryResolve: (() => void) | undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined;
	#usageReserveApprovedSelector: string | undefined;
	#pendingRetryErrors: PendingRetryError[] = [];
	#usageLimitOutcomes = new WeakMap<AssistantMessage, Promise<UsageLimitOutcome>>();
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#malformedFunctionCallRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;
	// Three fields sit near the word "serve" and are deliberately distinct:
	// `#activeRetryFallback.served` gates the one-shot `retry_fallback_succeeded`
	// event for the current arm, `#fallbackRouted` says how the CURRENT model was
	// reached, and `#lastServed` is the session's attribution. A fallback flipping
	// to served does not by itself move attribution — only a settled turn does.
	/**
	 * Attribution of the newest turn that produced output, tagged with the
	 * session it belongs to. Anchoring rather than resetting follows
	 * `#ensurePersistedMessageKeys`: every real switch mints a new session id, so
	 * stale attribution drops itself and no mutation call site has to remember to
	 * clear it. The id — not the file — is the anchor because an unpersisted
	 * session has no file, and comparing two `undefined`s would never invalidate.
	 */
	#lastServed: { attribution: ServingModel; sessionId: string } | undefined;
	/**
	 * Session whose current model was reached by fallback routing rather than by
	 * the configured primary, or `undefined` when it was not. Tracked separately
	 * from {@link #activeRetryFallback} because the Fireworks Fast degrade swaps
	 * models without arming a chain, and anchored like {@link #lastServed}:
	 * switching transcripts in place must not describe a fresh session's model
	 * with how the previous one was routed.
	 */
	#fallbackRoutedFor: string | undefined;
	/** Memoized bootstrap answer, for the window before anything has served. */
	#bootstrapCache:
		| { model: Model; level: ThinkingLevel | undefined; routed: boolean; value: ServingModel }
		| undefined;
	/**
	 * Fallback-chain warnings pushed to `configWarnings` by startup validation,
	 * tracked so a post-discovery re-check can retract the ones discovery
	 * resolved (#10048).
	 */
	#fallbackChainWarnings = new Set<string>();
	/** Whether startup validation deferred any warning pending in-flight discovery (#10048). */
	#pendingDiscoveryDeferredValidation = false;

	constructor(host: TurnRecoveryHost, options: TurnRecoveryOptions = {}) {
		this.#host = host;
		if (options.initialRetryFallback) {
			this.#activeRetryFallback = {
				...options.initialRetryFallback,
				lastAppliedFallbackThinkingLevel: host.configuredThinkingLevel(),
				pinned: options.initialRetryFallback.pinned ?? false,
			};
			this.#markFallbackRouted();
		}
		this.#validateRetryFallbackChains();
	}

	/** Current automatic retry attempt. */
	get attempt(): number {
		return this.#retryAttempt;
	}

	/** Promise settled when the active retry saga finishes. */
	get retryPromise(): Promise<void> | undefined {
		return this.#retryPromise;
	}

	/** Whether the CURRENT session's model was reached by fallback routing. */
	get #fallbackRouted(): boolean {
		return (
			this.#fallbackRoutedFor !== undefined && this.#fallbackRoutedFor === this.#host.sessionManager.getSessionId()
		);
	}

	#markFallbackRouted(): void {
		this.#fallbackRoutedFor = this.#host.sessionManager.getSessionId();
	}

	/**
	 * Model this session's produced work is attributed to.
	 *
	 * A model switch is a routing decision, not evidence the target can produce
	 * anything: a candidate that errors on its first request produced none of the
	 * turns already in this session. So attribution only ever names a model that
	 * has settled a turn here, and a switch — into a fallback, back to a restored
	 * primary, or anywhere else — moves it only once the new model answers.
	 *
	 * Before anything has served there is no earlier work to miscredit, so the
	 * configured model is both the only available answer and a safe one.
	 */
	get servingModel(): ServingModel | undefined {
		const served = this.#lastServed;
		if (served && served.sessionId === this.#host.sessionManager.getSessionId()) return served.attribution;
		const model = this.#host.model();
		if (!model) return undefined;
		// Polled per streaming event and per render, so the pre-first-turn window
		// must not format a selector on every call.
		const level = this.#host.thinkingLevel();
		const cached = this.#bootstrapCache;
		if (cached && cached.model === model && cached.level === level && cached.routed === this.#fallbackRouted) {
			return cached.value;
		}
		const value: ServingModel = {
			selector: formatRetryFallbackSelector(model, level),
			isFallback: this.#fallbackRouted,
		};
		this.#bootstrapCache = { model, level, routed: this.#fallbackRouted, value };
		return value;
	}

	/**
	 * Carries attribution onto a new session id that continues this conversation.
	 *
	 * The session-id anchor assumes a new id means an unrelated transcript, which
	 * holds for `/new` and for resuming something else. A fork breaks that
	 * assumption on purpose: it clones the transcript and keeps running the same
	 * recovery state under a fresh id. Dropping attribution there would bootstrap
	 * an unproven fallback as the primary and re-credit it with the work the
	 * previous model did — the very bug the anchor exists to prevent.
	 *
	 * Only state belonging to `previousSessionId` moves, so an id left behind by
	 * an earlier switch stays expired.
	 */
	reanchorServedAttribution(previousSessionId: string): void {
		const sessionId = this.#host.sessionManager.getSessionId();
		if (this.#lastServed?.sessionId === previousSessionId) {
			this.#lastServed = { ...this.#lastServed, sessionId };
		}
		if (this.#fallbackRoutedFor === previousSessionId) {
			this.#fallbackRoutedFor = sessionId;
		}
	}

	/** Resets per-prompt recovery counters and terminal-stop acceptance. */
	resetForNewPrompt(): void {
		this.#emptyStopRetryCount = 0;
		this.#unexpectedStopRetryCount = 0;
		this.#malformedFunctionCallRetryCount = 0;
		this.#acceptTerminalEmptyStopForPrompt = false;
	}

	/** Sets whether one terminal empty stop is accepted for the current prompt. */
	setAcceptTerminalEmptyStop(accept: boolean): void {
		this.#acceptTerminalEmptyStopForPrompt = accept;
	}

	/**
	 * Records which model produced this turn, marks an active fallback as having
	 * served, then closes a successful retry saga and annotates recovered
	 * persisted errors.
	 */
	async onAssistantSettledSuccessfully(message: AssistantMessage): Promise<void> {
		if (!assistantTurnProducedOutput(message)) {
			return;
		}
		const model = this.#host.model();
		if (model) {
			this.#lastServed = {
				attribution: {
					selector: formatRetryFallbackSelector(model, this.#host.thinkingLevel()),
					isFallback: this.#fallbackRouted,
				},
				sessionId: this.#host.sessionManager.getSessionId(),
			};
		}
		// Independent of the retry saga below: a usage-aware fallback is applied
		// before a request without ever incrementing `#retryAttempt`, and it still
		// owns every turn it serves. Gating this on the saga left such a fallback
		// permanently unproven, hiding it from observers for the whole session.
		if (this.#activeRetryFallback && !this.#activeRetryFallback.served && model) {
			this.#activeRetryFallback.served = true;
			await this.#host.emitSessionEvent({
				type: "retry_fallback_succeeded",
				model:
					this.#lastServed?.attribution.selector ?? formatRetryFallbackSelector(model, this.#host.thinkingLevel()),
				role: this.#activeRetryFallback.role,
			});
		}
		if (this.#retryAttempt === 0) {
			return;
		}
		const retryErrors = await this.#markPendingRetryErrors({
			status: "recovered",
			supersedingMessage: message,
		});
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: this.#retryAttempt,
			retryErrors,
		});
		this.#clearPendingRetryErrors();
		this.#retryAttempt = 0;
		this.resolveRetry();
	}

	/** Closes a failed retry saga when no compaction continuation took ownership. */
	async onErrorSettledWithoutRetry(message: AssistantMessage, compaction: RecoveryCompactionResult): Promise<void> {
		if (message.stopReason !== "error" || this.#retryAttempt === 0 || compaction.continuationScheduled) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: message.errorMessage,
		});
		this.#clearPendingRetryErrors();
	}

	/** Persists an otherwise skipped terminal empty error turn. */
	persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		return this.#persistTerminalEmptyErrorTurn(message);
	}

	/** Handles empty terminal assistant turns and schedules bounded recovery. */
	handleEmptyAssistantStop(message: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		return this.#handleEmptyAssistantStop(message);
	}

	/** Classifies suspicious terminal stops and schedules bounded recovery. */
	handleUnexpectedAssistantStop(message: AssistantMessage): Promise<boolean> {
		return this.#handleUnexpectedAssistantStop(message);
	}

	/**
	 * Continue past a provider-rejected function call that the replay-based
	 * retry declined. Gemini reports `MALFORMED_FUNCTION_CALL` when the model
	 * transcribes the call as text (`call:default_api:read{…}`, a tool_code
	 * fence) instead of emitting a structured call; the text is already
	 * rendered, so {@link isRetryableError} refuses to replay the turn and the
	 * session stopped on a pinned error. Nothing ran and nothing needs
	 * replaying: keep the failed turn in context so the model sees its own
	 * output, append a corrective developer message, and resume. Bounded per
	 * prompt; past the cap the error surfaces as before.
	 */
	handleMalformedFunctionCallStop(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		if (!AIError.is(id, AIError.Flag.MalformedFunctionCall)) {
			this.#malformedFunctionCallRetryCount = 0;
			return false;
		}
		if (this.#host.abortInProgress() || this.#host.isDisposed()) return false;

		this.#malformedFunctionCallRetryCount++;
		if (this.#malformedFunctionCallRetryCount > MALFORMED_FUNCTION_CALL_MAX_RETRIES) {
			logger.warn("Assistant kept emitting malformed function calls after retry cap", {
				attempts: this.#malformedFunctionCallRetryCount - 1,
				model: message.model,
				provider: message.provider,
			});
			this.#malformedFunctionCallRetryCount = 0;
			return false;
		}

		logger.info("Malformed function call; continuing with corrective reminder", {
			attempt: this.#malformedFunctionCallRetryCount,
			model: message.model,
			provider: message.provider,
		});
		this.#host.agent.appendMessage({
			role: "developer",
			content: [
				{
					type: "text",
					text: prompt.render(malformedFunctionCallRetryTemplate, {
						retryCount: this.#malformedFunctionCallRetryCount,
						maxRetries: MALFORMED_FUNCTION_CALL_MAX_RETRIES,
					}),
				},
			],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "malformed-function-call-retry",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	/** Removes a persisted failed assistant turn after its persistence slot settles; returns the dropped branch entry id. */
	dropPersistedAssistantTurn(message: AssistantMessage): Promise<string | undefined> {
		return this.#dropPersistedAssistantTurn(message);
	}

	/** Runs recovery compaction and restores the failed turn when no rewrite occurs. */
	runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		return this.#runRecoveryCompactionWithRollback(reason, message, allowDefer, options);
	}

	/**
	 * Restores the configured primary after fallback cooldown expiry.
	 * @returns true when the active model was actually switched back to the
	 * primary, so callers can re-run the pre-send context-fit check against the
	 * reverted (possibly smaller) window before issuing the next request.
	 */
	maybeRestoreRetryFallbackPrimary(): Promise<boolean> {
		return this.#maybeRestoreRetryFallbackPrimary();
	}

	/** Applies model fallback policy from live usage health before a turn starts. */
	maybeApplyUsageAwareFallback(signal: AbortSignal, confirmer?: UsageFallbackConfirmer): Promise<boolean> {
		return this.#maybeApplyUsageAwareFallback(signal, confirmer);
	}

	/** Applies automatic retry, credential rotation, and model fallback policy. */
	handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		return this.#handleRetryableError(message, options);
	}

	/**
	 * Records a usage-limit failure before replay eligibility decides whether the
	 * failed turn may be discarded. Returns whether credential recovery switched
	 * the active account.
	 */
	async recordUsageLimitOutcome(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		const activeModel = this.#host.model();
		if (!activeModel || !AIError.is(id, AIError.Flag.UsageLimit)) return false;

		let recorded = this.#usageLimitOutcomes.get(message);
		if (!recorded) {
			const errorMessage = message.errorMessage || "Unknown error";
			const retryAfterMs =
				this.#parseRetryAfterMsFromError(errorMessage) ??
				calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			recorded = (async (): Promise<UsageLimitOutcome> => {
				const outcome = await this.#host.modelRegistry.authStorage.markUsageLimitReached(
					activeModel.provider,
					this.#host.sessionId(),
					{ retryAfterMs, baseUrl: activeModel.baseUrl, modelId: activeModel.id },
				);
				return {
					switchedCredential: outcome.switched,
					retryAfterMs,
					retryAtMs: outcome.retryAtMs,
				};
			})();
			this.#usageLimitOutcomes.set(message, recorded);
		}
		return (await recorded).switchedCredential;
	}

	/** Prompts after transient overlap with a prior agent run. */
	promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		return this.#promptAgentWithIdleRetry(messages, options);
	}

	/** Parses provider retry and rate-limit reset hints into a delay. */
	parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		return this.#parseRetryAfterMsFromError(errorMessage);
	}

	/** Resolve the pending retry promise */
	resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	#clearPendingRetryErrors(): void {
		this.#pendingRetryErrors = [];
	}

	/**
	 * Durably record a terminal empty error turn (`stopReason: "error"` with no
	 * substantive content) that `#persistSessionMessageIfMissing` skipped, so the
	 * session JSONL keeps a record of why the run stopped instead of ending at the
	 * last tool result. A no-op for non-empty/non-error turns and idempotent via
	 * the already-persisted guard; the turn is dropped from active context by the
	 * caller (or `isProviderRefusalMessage`/`isEmptyErrorTurn` filters) so it is
	 * never replayed on the wire. Used by the retry-lifecycle dead-ends and the
	 * non-retry terminal error tail.
	 */
	async #persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		await this.#host.waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#host.sessionMessageAlreadyPersisted(message)) return;
		this.#host.appendSessionMessage(message);
	}

	#retryRecoveryKind(
		id: number,
		switchedCredential: boolean,
		switchedModel: boolean,
		delayMs: number,
	): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (switchedModel) return "model";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("rate-limited");
		} else if (recovery === "plain") {
			parts.push("error");
		}
		if (recovery === "credential") {
			parts.push("switched account");
		} else if (recovery === "model") {
			parts.push("switched model");
		} else if (recovery === "wait") {
			parts.push("waited");
		}
		parts.push("retried");
		return parts.join("; ");
	}

	async #recordPendingRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.persistTerminalEmptyErrorTurn(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		for (const entry of this.#host.sessionManager.getBranch().slice().reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !this.#isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRetryErrors(
		completion: { status: "recovered"; supersedingMessage: AssistantMessage } | { status: "superseded" },
	): Promise<RetryErrorUpdate[]> {
		if (this.#pendingRetryErrors.length === 0) return [];
		const branch = this.#host.sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const retryErrors: RetryErrorUpdate[] = [];
		for (const pending of this.#pendingRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			let retryRecovery: AssistantRetryRecovery;
			if (completion.status === "recovered") {
				retryRecovery = {
					kind: "auto-retry",
					status: "recovered",
					attempt: pending.attempt,
					recoveredAt: new Date().toISOString(),
					recovery: pending.recovery,
					note: pending.note,
					supersededBy: {
						timestamp: completion.supersedingMessage.timestamp,
						...(completion.supersedingMessage.responseId === undefined
							? {}
							: { responseId: completion.supersedingMessage.responseId }),
						provider: completion.supersedingMessage.provider,
						model: completion.supersedingMessage.model,
					},
				};
			} else {
				retryRecovery = {
					kind: "auto-retry",
					status: "superseded",
					attempt: pending.attempt,
					recovery: pending.recovery,
					note: pending.note,
				};
			}
			entry.message.retryRecovery = retryRecovery;
			retryErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (retryErrors.length > 0) {
			await this.#host.sessionManager.rewriteEntries();
		}
		return retryErrors;
	}

	#isRecoverableProviderEmptyOutput(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		if (!AIError.is(id, AIError.Flag.EmptyResponse)) return false;
		return message.content.every(
			block => block.type === "thinking" || (block.type === "text" && !hasNonWhitespace(block.text)),
		);
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		const providerEmptyOutput = this.#isRecoverableProviderEmptyOutput(assistantMessage);
		if (!isEmptyAssistantStop(assistantMessage) && !providerEmptyOutput) {
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const outputTokens = assistantMessage.usage.output;
			const outputTokensExcludingKnownReasoning = Math.max(
				0,
				outputTokens - (assistantMessage.usage.reasoningTokens ?? 0),
			);
			let finalError: string;
			if (providerEmptyOutput) {
				finalError = "Assistant returned no final output after retry cap; try switching models";
			} else if (outputTokensExcludingKnownReasoning > 0 && assistantMessage.content.length === 0) {
				// Billed non-reasoning output on a truly zero-block stop means content was
				// generated and then dropped downstream (a filter/refusal flattened to
				// `finish_reason: "stop"` by a proxy, or a lossy API translation) — the
				// context/`/shake images` hint is wrong here, so name the billed output
				// instead. Known reasoning-only usage is not evidence that deliverable
				// content was dropped, and thinking-only stops retain a thinking block.
				finalError = `Assistant returned an empty stop after retry cap, but the provider billed ${outputTokens} output token${outputTokens === 1 ? "" : "s"} for it; content was generated and then dropped before delivery, which usually points to a provider-side content filter or a lossy API translation rather than a context problem`;
			} else {
				finalError =
					"Assistant returned empty stop after retry cap; try switching models or `/shake images` to remove archived frames";
			}
			assistantMessage.errorMessage = finalError;
			if (providerEmptyOutput) assistantMessage.errorId = AIError.create();
			logger.warn(finalError, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
				outputTokens,
			});
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,
				finalError,
			});
			this.#clearPendingRetryErrors();
			this.#retryAttempt = 0;
			this.resolveRetry();
			// A turn with no actionable output carries no transcript value, while its
			// provider usage can anchor the next prompt at the full failed-request size
			// and re-trigger compaction at the same boundary. Remove every capped
			// empty output; toolUse orphans still need this for Anthropic history.
			await this.#dropAssistantTurnDurably(assistantMessage);
			return "terminal";
		}
		// The reparented leaf must be durably persisted before the retry continues:
		// the loader rebuilds the active branch from the last physical entry, so an
		// in-memory-only reparent lets the empty stop resurface on reload or after
		// a mid-retry process kill.
		await this.#dropAssistantTurnDurably(assistantMessage);
		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "empty-stop-retry",
			generation: this.#host.promptGeneration(),
		});
		return "continue";
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		const mode = this.#host.settings.get("features.unexpectedStopDetection");
		if (mode === "none") {
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		let text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");
		const hasTextContent = hasNonWhitespace(text);

		// A thinking-only terminal turn has no visible assistant message, so both
		// mechanical and smart modes retry it directly. Tool-call turns never reach
		// this path: isUnexpectedStopCandidate excludes them, including forced tools.
		if (!hasTextContent) {
			text = assistantMessage.content
				.filter((content): content is ThinkingContent => content.type === "thinking")
				.map(content => content.thinking)
				.join("\n");
			if (!hasNonWhitespace(text)) {
				this.#unexpectedStopRetryCount = 0;
				return false;
			}
		} else if (mode === "mechanical") {
			this.#unexpectedStopRetryCount = 0;
			return false;
		} else {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
			let classification: boolean | undefined;
			try {
				classification = await classifyUnexpectedStop(text, {
					settings: this.#host.settings,
					registry: this.#host.modelRegistry,
					sessionId: this.#host.sessionId(),
					metadataResolver: (provider: string) => this.#host.agent.metadataForProvider(provider),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			if (classification !== true) {
				this.#unexpectedStopRetryCount = 0;
				return false;
			}
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "unexpected-stop-retry",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.#host.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.#host.agent.replaceMessages(messages.slice(0, -1));
			return;
		}
		// A miss means the failed turn is still in active context (or was never
		// there); log just enough to explain why the identity check failed.
		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<string | undefined> {
		await this.#host.waitForSessionMessagePersistence(assistantMessage);
		return this.discardAssistantTurn(assistantMessage);
	}

	/**
	 * Drop the failed turn from active context and the persisted branch, then
	 * durably persist the reparented leaf so the empty stop cannot resurface on
	 * reload or after a mid-retry process kill.
	 */
	async #dropAssistantTurnDurably(assistantMessage: AssistantMessage): Promise<void> {
		const droppedEntryId = await this.#dropPersistedAssistantTurn(assistantMessage);
		if (droppedEntryId) await this.#host.sessionManager.discardEntryDurably(droppedEntryId);
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * {@link #runAutoCompaction} for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		await this.dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#host.runAutoCompaction(reason, true, false, allowDefer, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#host.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.#host.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.#host.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.#host.sessionManager.getBranch();
		const branchEntry = branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message, assistantMessage),
			);
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		this.removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.#host.agent.state.messages.at(-1)?.role === "custom") {
			this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		this.#host.withBashBranchTransition(() => {
			if (targetParentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(targetParentId);
			}
		});
		this.#host.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	discardAssistantTurn(assistantMessage: AssistantMessage): string | undefined {
		this.removeAssistantMessageFromActiveContext(assistantMessage);

		const branch = this.#host.sessionManager.getBranch();
		const persistedEntryId = this.#host.persistedAssistantEntryId(assistantMessage);
		const branchEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch
				.slice()
				.reverse()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
				);
		if (!branchEntry) {
			return undefined;
		}
		this.#host.withBashBranchTransition(() => {
			if (branchEntry.parentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(branchEntry.parentId);
			}
		});
		return branchEntry.id;
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason &&
				left.errorMessage === right.errorMessage &&
				Bun.hash(JSON.stringify(left.content)) === Bun.hash(JSON.stringify(right.content)))
		);
	}

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.#host.model();
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	#isUsagePreflightBlocked(message: AssistantMessage): boolean {
		return message.errorMessage?.startsWith(USAGE_PREFLIGHT_BLOCKED_PREFIX) === true;
	}
	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort (`#abortInProgress`), a dispose-driven
	 * abort (`#isDisposed`), or a session-induced streaming-edit guard abort
	 * (`StreamingEditGuard.abortTriggered` — auto-generated-file guard or failed-patch
	 * preview) is deliberate and MUST settle the turn instead: routing it through
	 * retry would orphan `#retryPromise` on a continuation the guard skips
	 * (hanging the in-flight `prompt()`) or silently undo the guard's intended
	 * abort. Deliberate user interrupts (`UserInterrupt`) and silent aborts carry
	 * their own marker, not the generic sentinel, so they never match here.
	 */
	isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#host.abortInProgress() ||
			this.#host.isDisposed() ||
			this.#host.streamingEditAbortTriggered()
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (message.errorMessage !== "Request was aborted" && message.errorMessage !== "Request was aborted.") {
			return false;
		}

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	/**
	 * Check if an error is retryable (transient errors, usage limits, or
	 * account-scoped policy denials that can rotate credentials).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 */
	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		const model = this.#host.model();
		const immutableAnthropicThinkingError =
			model?.api === "anthropic-messages" &&
			(message.errorStatus === 400 ||
				message.errorId === 400 ||
				message.errorMessage?.startsWith("400 ") === true) &&
			IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN.test(message.errorMessage ?? "");
		if (immutableAnthropicThinkingError) return false;

		const id = this.#classifyRetryMessage(message);
		// Context overflow is handled by compaction, not retry.
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		// Credential rotation and classifier fallbacks are safe only before
		// committed text, images, tool calls, or server tools. Thinking-only
		// output remains replay-safe. A classifier refusal, malformed-function
		// response, or retriable transport error (the provider stream died
		// mid-turn after a complete tool call — e.g. a socket close — and every
		// emitted call was paired with a synthetic `executed: false` result) may
		// also be replayed when every emitted tool call is paired with positive
		// proof that it never executed.
		const replaySafeUnexecutedTools =
			(this.isClassifierRefusal(message) ||
				AIError.is(id, AIError.Flag.MalformedFunctionCall) ||
				AIError.retriable(id)) &&
			this.#unexecutedToolCallsReplaySafe(message);
		if (this.#hasReplayUnsafeOutput(message) && !replaySafeUnexecutedTools) return false;
		if (AIError.is(id, AIError.Flag.AccountPolicy) || this.isClassifierRefusal(message)) return true;
		return AIError.retriable(id);
	}

	/**
	 * True when every emitted tool call provably never executed and no other
	 * replay-unsafe output exists. The caller restricts this exception to
	 * classifier refusals, malformed-function responses, and retriable
	 * transport errors.
	 *
	 * Gemini can report `MALFORMED_FUNCTION_CALL` after streaming an earlier,
	 * well-formed call. Anthropic classifiers can likewise refuse after a call.
	 * The agent loop pairs each emitted-but-unrun call with a synthetic
	 * `executed: false` result, which proves `tool.execute()` never ran.
	 *
	 * Any uncertainty keeps the replay veto in place: the assistant must exist
	 * in state, every call must have a later synthetic result, every result must
	 * say `executed === false`, and the turn must contain no image, server tool,
	 * or committed non-whitespace text.
	 */
	#unexecutedToolCallsReplaySafe(message: AssistantMessage): boolean {
		const emittedToolCallIds = new Set<string>();
		for (const block of message.content) {
			if (block.type === "toolCall") {
				emittedToolCallIds.add(block.id);
				continue;
			}
			if (block.type === "image" || block.type === "anthropicServerTool") return false;
			if (block.type === "text" && this.#host.textOutputCommitted() && hasNonWhitespace(block.text)) return false;
		}
		if (emittedToolCallIds.size === 0) return false;

		// The errored assistant message is NOT the tail of state: the agent loop
		// appends the synthetic results after it before the turn ends, so locate it
		// by walking backwards exactly as `classifyResolvedInterruptedToolTurn` does.
		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return false;

		const unexecutedToolCallIds = new Set<string>();
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role !== "toolResult" || !emittedToolCallIds.has(candidate.toolCallId)) continue;
			// Every result for an emitted call is inspected, not just the first: a
			// real result anywhere in the tail means the tool ran.
			if (!isSyntheticToolResultMessage(candidate) || candidate.details?.executed !== false) return false;
			unexecutedToolCallIds.add(candidate.toolCallId);
		}
		return unexecutedToolCallIds.size === emittedToolCallIds.size;
	}

	/**
	 * Classify a reasonless abort, idle stream stall, HTTP/2 stream reset, or
	 * premature stream close whose emitted tool calls all have results. The failed
	 * assistant/tool-result pair stays in context so continuation cannot replay
	 * completed side effects; synthetic results tell the next turn that an
	 * unexecuted call must be reissued.
	 */
	classifyResolvedInterruptedToolTurn(message: AssistantMessage): "reasonless-abort" | "stream-stall" | undefined {
		const id = this.#classifyRetryMessage(message);
		const genericAbort =
			message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
		const reasonlessAbort =
			(message.stopReason === "aborted" || message.stopReason === "error") &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered() &&
			((message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) || genericAbort);
		const errorMessage = message.errorMessage ?? "";
		const streamStall =
			message.stopReason === "error" && STREAM_STALL_ERROR_RE.test(errorMessage) && AIError.retriable(id);
		const transportReset =
			message.stopReason === "error" &&
			HTTP2_STREAM_RESET_ERROR_RE.test(errorMessage) &&
			AIError.retriable(id) &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered();
		// A premature gateway close (no finish_reason/terminal event) is the same
		// transport-failure class as the stall/reset cases: mid-generation death.
		// Preserved-turn continuation lets the retry resume after the partial
		// output instead of surfacing the error or replaying rendered content.
		const prematureClose =
			message.stopReason === "error" &&
			PREMATURE_STREAM_CLOSE_ERROR_RE.test(errorMessage) &&
			AIError.retriable(id) &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered();
		if (!reasonlessAbort && !streamStall && !transportReset && !prematureClose) return undefined;
		if (reasonlessAbort && genericAbort) message.errorId = AIError.create(AIError.Flag.Abort);

		// Idle stall and HTTP/2 RST both close the Cursor Connect stream:
		// the lazy watchdog aborts the request signal, and cursor.ts then
		// calls `h2Request.close()`. There is no in-flight server exec to
		// race, so unmarked MCP/todo blocks can continue once every emitted
		// call has a matching result. A reasonless abort ends the turn and
		// the agent loop pairs leftover calls with `executed: false`.
		const resolvedToolCallIds: string[] = [];
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			resolvedToolCallIds.push(block.id);
		}
		if (resolvedToolCallIds.length === 0) return undefined;

		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return undefined;

		const unresolvedToolCallIds = new Set(resolvedToolCallIds);
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role === "toolResult") unresolvedToolCallIds.delete(candidate.toolCallId);
		}
		if (unresolvedToolCallIds.size > 0) return undefined;
		return reasonlessAbort ? "reasonless-abort" : "stream-stall";
	}
	/**
	 * Retried turns remove the failed assistant message from active context.
	 * Thinking-only partials are safe to discard and replay: reasoning models
	 * routinely stall after long thinking with no visible output, and duplicated
	 * thinking display is materially lower harm than duplicated final text.
	 * Whitespace-only and buffered text are likewise safe since nothing meaningful
	 * reached the user. Committed text, generated images, server tools, and retained
	 * tool calls are NOT safe: each has already rendered or may have side effects,
	 * so replaying the turn can duplicate user-visible output or work.
	 */
	#hasReplayUnsafeOutput(message: AssistantMessage): boolean {
		return message.content.some(
			block =>
				block.type === "toolCall" ||
				block.type === "image" ||
				block.type === "anthropicServerTool" ||
				(block.type === "text" && this.#host.textOutputCommitted() && block.text.trim().length > 0),
		);
	}

	/**
	 * Known provider routes can repeatedly close after completing an expensive
	 * reasoning phase. One retry covers a transient edge failure; the normal
	 * ten-retry budget would otherwise replay the same reasoning cycle unchanged.
	 */
	#isBoundedThinkingStreamClose(message: AssistantMessage): boolean {
		if (!message.content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)) {
			return false;
		}
		const errorMessage = message.errorMessage ?? "";
		return (
			(message.provider === "openrouter" &&
				/server_error:\s*stream closed with reason:\s*error/i.test(errorMessage)) ||
			(message.provider === "github-copilot" &&
				message.model === "grok-4.6" &&
				message.api === "openai-responses" &&
				/OpenAI responses stream closed before a terminal response event was received/i.test(errorMessage))
		);
	}

	/** Checks whether a provider error represents a classifier refusal. */
	isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#getRetryFallbackResolutionContext(): RetryFallbackResolutionContext {
		return {
			chains: this.#getRetryFallbackChains(),
			getModelRole: role => this.#host.settings.getModelRole(role),
			modelLookup: this.#host.modelRegistry,
		};
	}
	#getRetryFallbackChains(): RetryFallbackChains {
		return getRetryFallbackChains(this.#host.settings);
	}

	#validateRetryFallbackChains(): void {
		let deferred = false;
		validateRetryFallbackChains(
			this.#host.settings,
			this.#host.modelRegistry,
			message => {
				logger.warn(message);
				this.#fallbackChainWarnings.add(message);
				this.#host.configWarnings.push(message);
			},
			{
				isDiscoveryPending: provider => {
					const pending = this.#host.modelRegistry.isProviderDiscoveryPending(provider);
					if (pending) deferred = true;
					return pending;
				},
			},
		);
		this.#pendingDiscoveryDeferredValidation = deferred;
	}

	/** Whether startup fallback-chain validation deferred any warning pending in-flight discovery (#10048). */
	hasPendingDiscoveryDeferredFallbackValidation(): boolean {
		return this.#pendingDiscoveryDeferredValidation;
	}

	/**
	 * Re-run fallback-chain validation once background discovery has settled and
	 * reconcile `configWarnings`. Startup validation suppresses "unknown model"
	 * warnings for selectors whose config-declared discovery provider had not yet
	 * populated the registry (a cold cache after `omp update` bumps the discovery
	 * namespace, #10048). With discovery done, drop any startup warning discovery
	 * resolved and surface warnings for selectors that stayed unknown.
	 *
	 * @returns true when `configWarnings` changed and the header must rebuild.
	 */
	revalidateRetryFallbackChainsAfterDiscovery(): boolean {
		const definitive = new Set<string>();
		validateRetryFallbackChains(this.#host.settings, this.#host.modelRegistry, message => definitive.add(message));
		this.#pendingDiscoveryDeferredValidation = false;
		let changed = false;
		for (const message of Array.from(this.#fallbackChainWarnings)) {
			if (definitive.has(message)) continue;
			const index = this.#host.configWarnings.indexOf(message);
			if (index !== -1) {
				this.#host.configWarnings.splice(index, 1);
				changed = true;
			}
			this.#fallbackChainWarnings.delete(message);
		}
		for (const message of definitive) {
			if (this.#fallbackChainWarnings.has(message)) continue;
			logger.warn(message);
			this.#fallbackChainWarnings.add(message);
			this.#host.configWarnings.push(message);
			changed = true;
		}
		return changed;
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return getRetryFallbackRevertPolicy(this.#host.settings);
	}

	/** Clears fallback ownership after an explicit model change or a restore. */
	clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
		this.#fallbackRoutedFor = undefined;
	}

	/** Checks whether a fallback selector remains in cooldown. */
	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#host.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	/** Records the cooldown that should suppress a failing selector. */
	noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#host.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	/**
	 * Map the failing model selector to the chain key that owns it, by
	 * specificity: an exact model-selector key, then a `provider/*` wildcard,
	 * then a model role whose current assignment matches, then `default`.
	 * Model-oriented keys win over roles so a chain follows the model across
	 * role reassignments.
	 */
	resolveRetryFallbackRole(
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
		roleHint?: string,
	): string | undefined {
		return resolveRetryFallbackChainKey(
			this.#getRetryFallbackResolutionContext(),
			currentSelector,
			currentModel,
			roleHint ?? this.#liveRetryRoleHint(currentModel),
		);
	}

	/**
	 * Chain keys to consult for the active model, most specific walk first: the
	 * chain that owns the current fallback walk, then the chain the CURRENT model
	 * owns when that is a different key.
	 *
	 * The second key is what makes a chain reachable from the end of another one.
	 * `#activeRetryFallback.role` is pinned at the first hop and never
	 * re-resolved, so a session that lands on the last entry of one chain has no
	 * candidate left and retries the same model until the budget is gone — even
	 * when that entry is itself a chain key with its own fallbacks configured
	 * (`anthropic/claude-opus-5 -> … -> runinfra/deepseek-v4-pro`, whose own
	 * `runinfra/deepseek-v4-pro -> openrouter/deepseek/…` chain was unreachable).
	 *
	 * Two keys is the whole walk per attempt. Chains that point at each other
	 * alternate models instead of looping in place, and every hop still spends a
	 * retry attempt, so the budget terminates either way.
	 */
	retryFallbackChainKeys(
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
		options?: { pinnedRole?: string; roleHint?: string },
	): string[] {
		const pinned = options?.pinnedRole ?? this.#activeRetryFallback?.role;
		const current = this.resolveRetryFallbackRole(currentSelector, currentModel, options?.roleHint);
		if (!pinned) return current ? [current] : [];
		return current && current !== pinned ? [pinned, current] : [pinned];
	}

	/** Live session role for chain lookup, provided its assignment still matches the active model. */
	#liveRetryRoleHint(currentModel: Model | null | undefined): string | undefined {
		const role = this.#host.sessionManager?.getLastModelChangeRole?.();
		if (!role || role === EPHEMERAL_MODEL_CHANGE_ROLE || !currentModel) return undefined;
		const configured = this.#host.settings.getModelRole(role);
		if (!configured) return undefined;
		const resolved = resolveModelOverride([configured], this.#host.modelRegistry, this.#host.settings);
		return resolved.model && modelsAreEqual(resolved.model, currentModel) ? role : undefined;
	}

	/** Finds fallback candidates that follow the active selector. */
	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
		options?: { wrapAround?: boolean },
	): RetryFallbackSelector[] {
		return findRetryFallbackCandidates(
			this.#getRetryFallbackResolutionContext(),
			role,
			currentSelector,
			currentModel,
			options,
		);
	}

	async #maybeApplyUsageAwareFallback(signal: AbortSignal, confirmer?: UsageFallbackConfirmer): Promise<boolean> {
		if (!this.#host.settings.get("retry.usageAwareFallback")) return false;
		const currentModel = this.#host.model();
		if (!currentModel) return false;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel());
		let health: ModelUsageHealth;
		try {
			health = await this.#host.modelRegistry.authStorage.getModelUsageHealth(currentModel.provider, {
				modelId: currentModel.id,
				sessionId: this.#host.sessionId(),
				baseUrl: currentModel.baseUrl,
				reserveFraction: this.#host.settings.get("retry.usageReservePct") / 100,
				signal,
			});
		} catch (error) {
			if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
			logger.debug("Usage-aware runtime preflight failed open", {
				provider: currentModel.provider,
				model: currentModel.id,
				error: String(error),
			});
			return false;
		}
		if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
		const selectedAccount = health.accounts.find(account => account.selected);
		if (health.state === "healthy") {
			this.#usageReserveApprovedSelector = undefined;
			if (
				selectedAccount &&
				selectedAccount.state !== "healthy" &&
				health.accounts.some(account => account.state === "healthy")
			) {
				this.#host.modelRegistry.authStorage.releaseSessionCredentialForReselection(
					currentModel.provider,
					this.#host.sessionId(),
				);
			}
			return false;
		}
		if (health.state === "unknown") {
			this.#usageReserveApprovedSelector = undefined;
			return false;
		}
		if (health.state !== "reserve") this.#usageReserveApprovedSelector = undefined;

		const reservePolicy = this.#host.settings.get("retry.usageReservePolicy");
		if (reservePolicy === "fail-closed") {
			const condition = health.state === "reserve" ? "reserve reached" : "usage depleted";
			throw new Error(
				`${USAGE_PREFLIGHT_BLOCKED_PREFIX} ${condition} for ${currentSelector}; reserve policy is fail-closed.`,
			);
		}
		if (
			reservePolicy === "confirm" &&
			health.state === "reserve" &&
			this.#usageReserveApprovedSelector === currentSelector
		) {
			return false;
		}
		if (!this.#host.settings.get("retry.modelFallback")) return false;

		let fallback: { role: string; selector: RetryFallbackSelector; apiKey: string } | undefined;
		const ceiling = this.#host.thinkingLevelCeiling();
		const chainKeys = this.retryFallbackChainKeys(currentSelector, currentModel);
		for (const role of chainKeys) {
			for (const candidate of this.findRetryFallbackCandidates(role, currentSelector, currentModel)) {
				if (this.isRetryFallbackSelectorSuppressed(candidate)) continue;
				const resolved = resolveModelOverride([candidate.raw], this.#host.modelRegistry, this.#host.settings);
				const candidateModel = resolved.model ?? this.#host.modelRegistry.find(candidate.provider, candidate.id);
				if (!candidateModel || !this.#host.modelRegistry.hasConfiguredAuth(candidateModel)) continue;
				if (ceiling !== undefined && !modelSupportsEffortCeiling(candidateModel, ceiling)) continue;
				// A usage fallback must also fit: skip a candidate whose window cannot
				// hold the live context so we never switch onto an oversized request
				// (issue #8065).
				if (!this.#host.contextFitsModel(candidateModel)) continue;
				try {
					const candidateHealth = await this.#host.modelRegistry.authStorage.getModelUsageHealth(
						candidateModel.provider,
						{
							modelId: candidateModel.id,
							sessionId: this.#host.sessionId(),
							baseUrl: candidateModel.baseUrl,
							reserveFraction: this.#host.settings.get("retry.usageReservePct") / 100,
							signal,
						},
					);
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
					if (candidateHealth.state === "depleted" || candidateHealth.state === "reserve") continue;
					if (candidateHealth.state === "healthy") {
						const selected = candidateHealth.accounts.find(account => account.selected);
						if (
							selected &&
							selected.state !== "healthy" &&
							candidateHealth.accounts.some(account => account.state === "healthy")
						) {
							this.#host.modelRegistry.authStorage.releaseSessionCredentialForReselection(
								candidateModel.provider,
								this.#host.sessionId(),
							);
						}
					}
				} catch {
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
					// Unknown usage fails open for an otherwise valid fallback.
				}
				if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
				let apiKey: string | undefined;
				try {
					apiKey = await this.#host.modelRegistry.getApiKey(candidateModel, this.#host.sessionId(), { signal });
				} catch {
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
					continue;
				}
				if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
				if (!apiKey) continue;
				fallback = { role, selector: candidate, apiKey };
				break;
			}
			if (fallback) break;
		}
		if (!fallback) return false;

		let shouldFallback = health.state === "depleted" || reservePolicy === "auto" || !confirmer;
		if (!shouldFallback && health.state === "reserve" && confirmer) {
			const remainingFraction =
				selectedAccount?.remainingFraction ??
				health.accounts.reduce<number | undefined>((minimum, account) => {
					if (account.remainingFraction === undefined) return minimum;
					return minimum === undefined ? account.remainingFraction : Math.min(minimum, account.remainingFraction);
				}, undefined);
			shouldFallback = await this.#confirmUsageFallback(
				confirmer,
				{
					from: currentSelector,
					to: fallback.selector.raw,
					remainingPercent: remainingFraction === undefined ? undefined : Math.max(0, remainingFraction * 100),
				},
				signal,
			);
			if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
		}
		if (!shouldFallback) {
			this.#usageReserveApprovedSelector = currentSelector;
			return false;
		}
		this.#usageReserveApprovedSelector = undefined;
		return this.applyRetryFallbackCandidate(fallback.role, fallback.selector, currentSelector, {
			pinFallback: true,
			apiKey: fallback.apiKey,
			signal,
		});
	}

	async #confirmUsageFallback(
		confirmer: UsageFallbackConfirmer,
		confirmation: UsageFallbackConfirmation,
		signal: AbortSignal,
	): Promise<boolean> {
		if (signal.aborted) return false;
		const aborted = Promise.withResolvers<boolean>();
		const onAbort = () => aborted.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([confirmer(confirmation, signal), aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean; apiKey?: string; signal?: AbortSignal },
	): Promise<boolean> {
		const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
		const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey =
			options?.apiKey ??
			(await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId(), { signal: options?.signal }));
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}
		if (options?.signal?.aborted) return false;

		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const requestedThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		// A fallback selector's explicit level (or the carried level after the
		// replacement model's floor clamp) must never exceed the session's
		// per-spawn effort ceiling.
		const nextThinkingLevel =
			requestedThinkingLevel === AUTO_THINKING
				? requestedThinkingLevel
				: clampThinkingLevelToCeiling(candidate, requestedThinkingLevel, this.#host.thinkingLevelCeiling());
		const candidateSelector = formatModelStringWithRouting(candidate);
		const previousModel = this.#host.model();
		// Mark routing BEFORE the swap: `setModelWithProviderSessionReset` moves the
		// model and fans `model_changed` out to subscribers synchronously, and a
		// listener reading attribution in that window must already see the incoming
		// candidate as fallback-routed. Attribution itself is safe regardless — it
		// names the last model that served, which this swap has not changed.
		const routedBeforeSwap = this.#fallbackRoutedFor;
		const servedBeforeSwap = this.#activeRetryFallback?.served;
		this.#markFallbackRouted();
		if (this.#activeRetryFallback) this.#activeRetryFallback.served = false;
		await this.#host.setModelWithProviderSessionReset(candidate);
		if (options?.signal?.aborted) {
			this.#fallbackRoutedFor = routedBeforeSwap;
			if (this.#activeRetryFallback) this.#activeRetryFallback.served = servedBeforeSwap;
			if (previousModel && this.#host.model() === candidate) {
				await this.#host.setModelWithProviderSessionReset(previousModel);
			}
			return false;
		}
		if (this.#host.model() !== candidate) {
			this.#fallbackRoutedFor = routedBeforeSwap;
			if (this.#activeRetryFallback) this.#activeRetryFallback.served = servedBeforeSwap;
			return false;
		}
		this.#host.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE, true);
		this.#host.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.#host.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
		return true;
	}

	async #tryRetryModelFallback(
		currentSelector: string,
		failedMessage: AssistantMessage,
		options?: {
			excludeProvider?: string;
			pinFallback?: boolean;
			preserveFailedTurn?: boolean;
			wrapAround?: boolean;
		},
	): Promise<boolean> {
		const ceiling = this.#host.thinkingLevelCeiling();
		const latestAssistant = options?.preserveFailedTurn
			? failedMessage
			: this.#host.agent.state.messages.findLast(
					(message): message is AssistantMessage => message.role === "assistant" && message !== failedMessage,
				);
		for (const role of this.retryFallbackChainKeys(currentSelector)) {
			for (const selector of this.findRetryFallbackCandidates(role, currentSelector, undefined, options)) {
				if (this.isRetryFallbackSelectorSuppressed(selector)) continue;
				const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
				const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
				if (!candidate) continue;
				if (options?.excludeProvider === candidate.provider) continue;
				// Anthropic signatures and redacted blocks are model-bound, while the
				// latest assistant response must remain byte-identical. A same-provider
				// model switch can satisfy neither constraint, so keep retrying the
				// source model or consider a later cross-provider candidate whose
				// message transform can safely demote the foreign thinking.
				if (
					candidate.api === "anthropic-messages" &&
					latestAssistant?.api === "anthropic-messages" &&
					latestAssistant.provider === candidate.provider &&
					latestAssistant.model !== candidate.id &&
					latestAssistant.content.some(
						block =>
							(block.type === "thinking" && Boolean(block.thinkingSignature?.trim())) ||
							block.type === "redactedThinking",
					)
				) {
					continue;
				}
				// A candidate whose effort floor exceeds the per-spawn ceiling would be
				// clamped UP past the cap by its model floor — skip it entirely.
				if (ceiling !== undefined && !modelSupportsEffortCeiling(candidate, ceiling)) continue;
				// Skip a candidate whose window cannot hold the retry context. The
				// failed assistant is excluded only when retry removes it; preserved
				// unexecuted-tool turns remain part of the request (issue #8065).
				if (!this.#host.contextFitsModel(candidate, options?.preserveFailedTurn ? undefined : failedMessage)) {
					continue;
				}
				const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId());
				if (!apiKey) continue;
				return this.applyRetryFallbackCandidate(role, selector, currentSelector, options);
			}
		}

		return false;
	}

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.#host.model();
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	/**
	 * True when the current turn failed on a Fireworks Fast (`-fast`) model in a
	 * way that should degrade to the reliable base (Standard) model. Fast is a
	 * speed-optimized router with no SLA, so any *pre-content* failure — a
	 * transient overload/5xx or a hard "router/model not found / unsupported" —
	 * is worth retrying on the base id. Skips failures the base model shares:
	 * context overflow (compaction's job), usage limits and auth errors (same
	 * account/key), and turns that already emitted any replay-unsafe output.
	 * Requires the base model to exist in the registry.
	 */
	isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		// A thinking loop is a same-model resample signal, not a router fault, so a
		// base-model swap would abandon the loop-guard redirect (issue #8760).
		if (AIError.is(id, AIError.Flag.ThinkingLoop)) return false;
		// Byte/media budget 413s fail identically on the base model — swapping cannot fix them (#9235).
		if (AIError.isPayloadRejection(message)) return false;
		return this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	/**
	 * True when a turn failed with a hard (non-retryable) provider error but a
	 * configured `retry.fallbackChains` entry covers the active model: the same
	 * model is not worth retrying, yet a DIFFERENT model is a fresh chance, so
	 * the chain is consulted before the error becomes final. Skips failures a
	 * model switch cannot fix or must not replay: cancellations (abort-flavored
	 * errors are not model faults), context overflow (compaction's job),
	 * classifier refusals (chain consult is handled on the retryable path with
	 * `pinFallback`), and turns that already emitted replay-unsafe output.
	 */
	isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		const model = this.#host.model();
		if (!model) return false;
		const immutableAnthropicThinkingError =
			model.api === "anthropic-messages" &&
			(message.errorStatus === 400 ||
				message.errorId === 400 ||
				message.errorMessage?.startsWith("400 ") === true) &&
			IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN.test(message.errorMessage ?? "");
		if (immutableAnthropicThinkingError) return false;
		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		// Text-ambiguous overflows waive the veto; usage-backed do not — see AIError.isTextAmbiguousContextOverflow (#9235).
		const contextWindow = model.contextWindow ?? 0;
		const textAmbiguousOverflow = AIError.isTextAmbiguousContextOverflow(id, message, contextWindow);
		if (!textAmbiguousOverflow && AIError.isContextOverflow(message, contextWindow)) {
			return false;
		}
		if (this.#hasReplayUnsafeOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.#host.thinkingLevel());
		return this.retryFallbackChainKeys(currentSelector).some(
			role => this.findRetryFallbackCandidates(role, currentSelector).length > 0,
		);
	}

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
	async #tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#host.modelRegistry.getApiKey(baseModel, this.#host.sessionId());
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);
		// A capability degrade is fallback routing too, even though it arms no
		// chain: the base model must not be reported as the configured primary.
		this.#markFallbackRouted();
		await this.#host.setModelWithProviderSessionReset(baseModel);
		this.#host.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE, true);
		this.#host.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<boolean> {
		if (!this.#activeRetryFallback) return false;
		if (this.#activeRetryFallback.pinned) return false;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return false;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#host.modelRegistry);
		if (!originalSelector) {
			// Defensive: the stored selector is always produced by
			// `formatRetryFallbackSelector`, so it should never fail to parse. If it
			// somehow does, nothing is restored and the session keeps running on the
			// fallback — so drop the chain record but NOT `#fallbackRouted`, whose
			// clearing would report the fallback's remaining turns as the primary.
			this.#activeRetryFallback = undefined;
			return false;
		}

		const currentModel = this.#host.model();
		if (!currentModel) return false;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel());
		if (currentSelector === originalSelector.raw) {
			if (!this.isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.clearActiveRetryFallback();
			}
			return false;
		}
		if (this.isRetryFallbackSelectorSuppressed(originalSelector)) return false;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#host.modelRegistry,
			this.#host.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#host.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return false;
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, this.#host.sessionId());
		if (!apiKey) return false;

		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);
		// Clear before the swap: `setModelWithProviderSessionReset` and
		// `setThinkingLevel` both notify subscribers, and an observer reading
		// attribution in that window would see the restored primary still tagged
		// as fallback-served.
		this.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(primaryModel);
		this.#host.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#host.settings.getStorage()?.recordModelUsage(primarySelector);
		this.#host.setThinkingLevel(thinkingToApply);
		return true;
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff, credential rotation, and
	 * model-fallback chains. Also entered for NON-retryable errors when a switch
	 * is the recovery (`fireworksFastFallback`, `hardErrorFallback`): then a
	 * successful model switch retries immediately, and a failed switch surfaces
	 * the error without a same-model backoff retry.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		const retrySettings = this.#host.settings.getGroup("retry");
		// The Fireworks Fast→base degrade is an intrinsic model-selection safety net,
		// not a retry loop, so it runs even when the user disabled retries: it switches
		// the model once and lets the base turn proceed.
		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const classifierRefusal = this.isClassifierRefusal(message);

		const generation = this.#host.promptGeneration();
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		// All attempts on the current model are spent. Don't fail yet: the
		// fallback chain below gets one last consult. Credential rotation can
		// consume the entire budget without the fallback branch ever running
		// (every rotation sets switchedCredential and skips it), so without
		// this last resort a provider-wide usage cap never fails over to the
		// configured chain.
		const maxRetries = this.#isBoundedThinkingStreamClose(message)
			? Math.min(retrySettings.maxRetries, 1)
			: retrySettings.maxRetries;
		const retryBudgetExhausted = this.#retryAttempt > maxRetries;

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classifyRetryMessage(message);
		const preserveFailedTurn =
			options?.preserveFailedTurn === true ||
			((classifierRefusal || AIError.is(id, AIError.Flag.MalformedFunctionCall) || AIError.retriable(id)) &&
				this.#unexecutedToolCallsReplaySafe(message));
		const rateLimitReason = parseRateLimitReason(errorMessage);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const accountPolicyDenial = AIError.is(id, AIError.Flag.AccountPolicy);
		const recordedUsageLimitOutcome = await this.#usageLimitOutcomes.get(message);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);
		// Transient rate/concurrency caps stay on the same credential, but must
		// honor their reason-specific windows. The default exponential base
		// (≈500ms, capped at 8s) otherwise re-hits the cap and burns the retry
		// budget before either window can clear. An explicit provider
		// retry-after is authoritative in both directions, so the heuristic
		// window only applies when the error carries no parsed timing.
		if (
			!staleOpenAIResponsesReplayError &&
			!AIError.is(id, AIError.Flag.UsageLimit) &&
			parsedRetryAfterMs === undefined &&
			(rateLimitReason === "CONCURRENT_LIMIT" || rateLimitReason === "RATE_LIMIT_EXCEEDED")
		) {
			const reasonBackoffMs = calculateRateLimitBackoffMs(rateLimitReason);
			if (reasonBackoffMs > delayMs) delayMs = reasonBackoffMs;
		}
		let switchedCredential = false;
		let switchedModel = false;
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
		let usageLimitWaitMs: number | undefined;
		const siblingAvailabilityWaitMs =
			recordedUsageLimitOutcome?.retryAtMs === undefined
				? undefined
				: Math.max(0, recordedUsageLimitOutcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;

		if (staleOpenAIResponsesReplayError) {
			this.#host.resetCurrentResponsesProviderSession("stale replay error");
		}

		if (!retryBudgetExhausted && !staleOpenAIResponsesReplayError && recordedUsageLimitOutcome) {
			if (
				recordedUsageLimitOutcome.switchedCredential ||
				// Convert the parsed hint to an absolute timestamp NOW, before the
				// hook's usage IO — a duration re-anchored after slow fetches drifts.
				(await this.#host.maybeAutoRedeemCodexReset(
					parsedRetryAfterMs === undefined ? undefined : Date.now() + parsedRetryAfterMs,
				))
			) {
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the provider's retry-after window for the current
				// account, or the earliest moment a temporarily blocked sibling
				// frees up (e.g. a 60s post-401 block or a 5-min usage-probe
				// block) — the next attempt's getApiKey re-ranks and picks it up.
				// Without this, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
				usageLimitWaitMs = recordedUsageLimitOutcome.retryAfterMs;
				if (siblingAvailabilityWaitMs !== undefined && siblingAvailabilityWaitMs < usageLimitWaitMs) {
					usageLimitWaitMs = siblingAvailabilityWaitMs;
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentModel = this.#host.model();
		const currentSelector = currentModel
			? formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel())
			: undefined;
		if (accountPolicyDenial && currentModel) {
			switchedCredential = await this.#host.modelRegistry.authStorage.rotateSessionCredential(
				currentModel.provider,
				this.#host.sessionId(),
				{ error: errorMessage, modelId: currentModel.id },
			);
			if (switchedCredential) delayMs = 0;
		}
		// A thinking-loop abort is not a provider failure — it is the loop guard
		// asking for a same-model resample, paired with a hidden
		// `thinking-loop-redirect` notice that only makes sense on the model that
		// looped. Walking `fallbackChains` (or parking the selector on a cooldown)
		// would swap a healthy planning turn to another family based on chain
		// contents, not model health (issue #8760). Keep it on the same model; the
		// retry budget still bounds a genuinely stuck stream.
		const thinkingLoop = AIError.is(id, AIError.Flag.ThinkingLoop);
		const effectiveUsageLimitWaitMs =
			usageLimitWaitMs ??
			(siblingAvailabilityWaitMs === undefined
				? (recordedUsageLimitOutcome?.retryAfterMs ?? parsedRetryAfterMs)
				: Math.min(
						recordedUsageLimitOutcome?.retryAfterMs ?? parsedRetryAfterMs ?? Infinity,
						siblingAvailabilityWaitMs,
					));
		const waitForSiblingCredential =
			siblingAvailabilityWaitMs !== undefined &&
			effectiveUsageLimitWaitMs !== undefined &&
			effectiveUsageLimitWaitMs <= retrySettings.maxDelayMs;
		const longUsageLimitFallback =
			currentModel !== undefined &&
			resolveModelPolicy(currentModel).catalog.longUsageLimitFallback === true &&
			retrySettings.maxDelayMs > 0 &&
			effectiveUsageLimitWaitMs !== undefined &&
			effectiveUsageLimitWaitMs > retrySettings.maxDelayMs &&
			/\bGoUsageLimitError\b/.test(errorMessage) &&
			(!this.#hasReplayUnsafeOutput(message) || this.#unexecutedToolCallsReplaySafe(message));

		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			// A refusal chain stops at the retry budget: the exhausted-attempt
			// last resort is for provider failures, not classifier decisions.
			if (
				allowModelFallback &&
				retrySettings.modelFallback &&
				!thinkingLoop &&
				!waitForSiblingCredential &&
				!(retryBudgetExhausted && classifierRefusal)
			) {
				if (!classifierRefusal) {
					this.noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, message, {
					excludeProvider: longUsageLimitFallback ? currentModel.provider : undefined,
					pinFallback: classifierRefusal,
					preserveFailedTurn,
					wrapAround: longUsageLimitFallback,
				});
			}
			// Auto fallback from a Fireworks Fast variant to its base model. Independent
			// of the role-fallback setting: it's intrinsic to the Fast contract (speed
			// best-effort, degrade to Standard on failure) and triggers on hard router
			// errors the generic retry classifier would otherwise reject.
			if (!switchedModel && allowModelFallback && options?.fireworksFastFallback) {
				switchedModel = await this.#tryFireworksFastFallback(currentSelector);
			}
			if (switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}

		if (retryBudgetExhausted) {
			if (!switchedModel && !switchedCredential) {
				const attempt = this.#retryAttempt - 1;
				message.errorMessage = `Retry budget exhausted after ${attempt} ${attempt === 1 ? "retry" : "retries"}: ${errorMessage}`;
				await this.persistTerminalEmptyErrorTurn(message);
				const retryErrors = await this.#markPendingRetryErrors({ status: "superseded" });
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: errorMessage,
					retryErrors,
				});
				this.#clearPendingRetryErrors();
				this.#retryAttempt = 0;
				this.resolveRetry(); // Resolve so waitForRetry() completes
				return false;
			}
			// A fallback model gets a fresh retry budget. Credential rotation
			// instead keeps the cumulative attempt count while bypassing the
			// same-route budget: every distinct account must be tried first.
			if (switchedModel) this.#retryAttempt = 1;
		}
		if ((classifierRefusal || accountPolicyDenial) && !switchedCredential && !switchedModel) {
			// A prior attempt in this saga already announced `auto_retry_start`
			// (retryAttempt was incremented for each call to this method, so > 1
			// means at least one earlier attempt started the loop) but this
			// attempt is not going to retry — the saga must close with its own
			// `auto_retry_end` so subscribers tracking retry-outstanding state
			// (e.g. suppressing a duplicate error toast) don't stay latched on
			// an announcement that never resolves.
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}
		// A fallback switch was the whole reason we entered (Fast→base degrade or
		// a hard-error chain consult) but it could not happen (e.g. no candidate
		// has a credential). Don't fall through to backing-off and retrying the
		// failing model for an error the generic classifier wouldn't retry —
		// surface it instead.
		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback) &&
			!switchedModel &&
			!this.isRetryableError(message)
		) {
			// Same auto_retry_end backstop as the classifier-refusal branch above.
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const maxDelayMs = retrySettings.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			await this.persistTerminalEmptyErrorTurn(message);
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${Math.ceil(delayMs)}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#clearPendingRetryErrors();
			this.resolveRetry();
			return false;
		}

		await this.#recordPendingRetryError(message, id, { switchedCredential, switchedModel, delayMs });

		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		// Resolved stream-stall tools and proven-unexecuted malformed/refused
		// calls keep their assistant/result pair. Continuation then sees explicit
		// synthetic results and cannot repeat a side effect.
		if (!preserveFailedTurn) {
			this.removeAssistantMessageFromActiveContext(message, "auto-retry");
		}

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#clearPendingRetryErrors();
			this.resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// The identity-keyed removal above can miss when a context rebuild
		// recreated the failed turn's message object between settle and retry
		// (fresh identity, same failed tail — issue #5382). Agent.continue()
		// rejects any assistant tail, so a missed removal fails the scheduled
		// retry locally before a provider request is ever made. Re-check the
		// tail after the backoff (covering rebuilds during the sleep too) and
		// strip a still-failed assistant tail by position. Never when preserving
		// the failed turn — the kept turn ends in synthetic tool results that
		// continue() accepts — and never once a newer prompt owns the session.
		if (!preserveFailedTurn && this.#host.promptGeneration() === generation) {
			this.#stripFailedAssistantTail();
		}

		// Retry via continue() outside the agent_end event callback chain. A
		// continuation that still fails locally must close the retry saga —
		// otherwise auto_retry_end never fires, retryPromise stays pending, and
		// the in-flight prompt() (and the TUI retry indicator) hang forever.
		this.#host.scheduleAgentContinue({
			source: "automatic-retry",
			delayMs: 1,
			generation,
			onError: error => void this.#failRetryAfterLocalContinueError(message, error),
		});

		return true;
	}

	/**
	 * Positional backstop for {@link removeAssistantMessageFromActiveContext}:
	 * when the identity check missed, the failed assistant turn is still the
	 * active tail and the scheduled continue() would reject it. An
	 * error/aborted-stopped assistant tail is never legal continuation input
	 * and no recovery path wants it replayed on the wire, so drop it by
	 * position; any healthy tail is left untouched.
	 */
	#stripFailedAssistantTail(): void {
		const messages = this.#host.agent.state.messages;
		const tail = messages[messages.length - 1];
		if (tail?.role !== "assistant") return;
		if (tail.stopReason !== "error" && tail.stopReason !== "aborted") return;
		logger.debug("agent active context failed assistant tail stripped positionally", {
			stopReason: tail.stopReason,
			timestamp: tail.timestamp,
		});
		this.#host.agent.replaceMessages(messages.slice(0, -1));
	}

	/**
	 * Close the retry saga when the scheduled continue() failed locally (no
	 * provider request was made). Mirrors the other retry dead-ends: emit the
	 * closing `auto_retry_end` so subscribers stop showing retry progress, and
	 * resolve the retry promise so the in-flight prompt() unwinds (issue #5382).
	 */
	async #failRetryAfterLocalContinueError(message: AssistantMessage, error: unknown): Promise<void> {
		if (this.#retryAttempt === 0) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		const localError = error instanceof Error ? error.message : String(error);
		await this.persistTerminalEmptyErrorTurn(message);
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: `Retry continuation failed locally: ${localError}. Original error: ${message.errorMessage ?? "Unknown error"}`,
		});
		this.#clearPendingRetryErrors();
		this.resolveRetry();
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.#host.settings.get("model.loopGuard.enabled") !== true) return;
		this.#host.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: thinkingLoopRedirectTemplate,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			thinkingLoopRedirectTemplate,
			false,
			undefined,
			"agent",
		);
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.#host.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.#host.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.#host.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.#host.settings.set("retry.enabled", enabled);
	}
	/**
	 * Whether the transcript tail is a failed/aborted assistant turn whose most
	 * recent activity was a tool call: synthetic placeholder results trail the
	 * failed turn (stream died mid-tool-call), or the message right before the
	 * aborted boundary is an errored/aborted tool result (Esc landed during
	 * tool execution). Drives the TUI's idle "F5 to Retry" status row;
	 * {@link retry} is the matching action.
	 */
	get hasAbortedToolCallTail(): boolean {
		const active = this.#host.agent.state.messages;
		if (abortedToolCallTail(active)) return true;
		// A trailing assistant message is authoritative for a live session: a
		// settled successful turn leaves nothing to retry.
		if (active.at(-1)?.role === "assistant") return false;
		// A restored session omits the failed turn (and its synthetic results)
		// from provider context, so — mirroring retry() — the persisted display
		// transcript decides whether a retryable tool-call tail exists.
		return abortedToolCallTail(this.#host.sessionManager.buildSessionContext({ transcript: true }).messages);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from active agent state when present and
	 * re-attempts with a fresh retry budget.
	 *
	 * A stream that stalls or aborts mid-tool-call ends the turn with
	 * `stopReason: "error" | "aborted"` and then appends one synthetic
	 * {@link isSyntheticToolResultMessage tool_result} per emitted tool call to
	 * preserve the provider's tool_use/tool_result pairing (see
	 * `createAbortedToolResult` in `agent-loop.ts`). Those placeholders trail the
	 * failed assistant turn, so the retry lookback walks back over them before
	 * checking the assistant message; it strips both the placeholders and the
	 * failed turn before re-attempting.
	 *
	 * A restored session deliberately omits failed assistant turns from provider
	 * context. In that case, the persisted display transcript remains the source
	 * of truth for whether the current branch has a retryable failed tail.
	 *
	 * When the failure is a fully failed/aborted tool batch with complete
	 * arguments (see {@link toolReplayStart}), the retry strips the failed
	 * results (and the aborted boundary) instead of the whole turn, leaving the
	 * tool-calling assistant as the tail — the continuation then re-executes
	 * the same tool calls directly rather than paying a model call to re-issue
	 * them.
	 *
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.#host.isStreaming() || this.#host.isCompacting() || this.isRetrying) return false;

		const messages = this.#host.agent.state.messages;
		const activeTurnEnd = retryableAssistantTurnEnd(messages);
		if (activeTurnEnd !== undefined) {
			const replayStart = toolReplayStart(messages);
			if (replayStart !== undefined) {
				await this.#stripForToolReplay(messages, replayStart);
			} else {
				// Remove the failed/aborted assistant message plus its synthetic tool
				// results (same as auto-retry does before re-attempting).
				this.#host.agent.replaceMessages(messages.slice(0, activeTurnEnd - 1));
			}
		} else {
			// A restored session already dropped the failed assistant turn (and its
			// paired synthetic tool results) from provider context, so the persisted
			// display transcript is the source of truth for a retryable failed tail.
			const transcriptMessages = this.#host.sessionManager.buildSessionContext({ transcript: true }).messages;
			if (retryableAssistantTurnEnd(transcriptMessages) === undefined) return false;
			// The boundary is already gone from active context; when the intact
			// failed batch is still the tail, replay the tools directly.
			const replayStart = toolReplayStart(messages);
			if (replayStart !== undefined) await this.#stripForToolReplay(messages, replayStart);
		}

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#host.scheduleAgentContinue({ source: "manual-retry", delayMs: 1 });

		return true;
	}
	/**
	 * Strip the failed tool batch (and any aborted boundary) for a tool replay:
	 * reparent the persisted leaf onto the anchor assistant entry — so the
	 * dropped results cannot resurface on reload or pair duplicate toolCallIds
	 * on replay — then cut the active context to the same point.
	 */
	async #stripForToolReplay(messages: readonly AgentMessage[], replayStart: number): Promise<void> {
		const tail = messages[messages.length - 1];
		if (tail?.role === "assistant") {
			try {
				await this.#host.waitForSessionMessagePersistence(tail);
			} catch (err) {
				logger.debug("Tool replay: boundary persistence wait failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		const anchor = messages[replayStart - 1] as AssistantMessage;
		const branch = this.#host.sessionManager.getBranch();
		const persistedEntryId = this.#host.persistedAssistantEntryId(anchor);
		const anchorEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch
				.slice()
				.reverse()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						this.#isSameAssistantMessage(entry.message as AssistantMessage, anchor),
				);
		if (anchorEntry) {
			this.#host.withBashBranchTransition(() => {
				this.#host.sessionManager.branch(anchorEntry.id);
			});
		}
		this.#host.agent.replaceMessages(messages.slice(0, replayStart));
	}
}
