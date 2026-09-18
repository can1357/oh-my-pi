import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AdvisorContinuationMode,
	AdvisorHistoryCheckpoint,
	AdvisorTurnDisposition,
} from "./maintenance-types";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { logger } from "@oh-my-pi/pi-utils";
import {
	collectNativeReplayRegexSecretValues,
	obfuscateNativeReplay,
	obfuscateToolArguments,
} from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	formatExecutionSourcePreview,
	formatSessionHistoryMarkdown,
	PRIMARY_CONTEXT_CUSTOM_TYPES,
} from "../session/session-history-format";
import { ADVISOR_RENDER_OPTIONS, renderAdvisorDeltaChunks } from "./delta-split";
import { fingerprintMessage } from "./message-fingerprint";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string | AgentMessage[]): Promise<void>;
	abort(reason?: unknown): void;
	reset(reason?: string): void;
	/** Capture the working-history transaction immediately before a core prompt. */
	checkpoint?(): AdvisorHistoryCheckpoint;
	/** Restore a no-rewrite attempt. Production adapters restore journal and live history together. */
	restoreCheckpoint?(checkpoint: AdvisorHistoryCheckpoint, reason: string): Promise<void> | void;
	/** Finalized messages belonging to this attempt, surviving in-place history rewrites. */
	messagesSince?(checkpoint: AdvisorHistoryCheckpoint): readonly AgentMessage[];
	hasCommittedRewrite?(checkpoint: AdvisorHistoryCheckpoint): boolean;
	/** Remove only the failed assistant attempt while retaining committed rewrites and tool progress. */
	discardFailedAttempt?(checkpoint: AdvisorHistoryCheckpoint): Promise<void> | void;
	/** Continue the current logical review without submitting its primary batch again. */
	continue?(mode: AdvisorContinuationMode): Promise<void>;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Admit the exact finalized, rendered messages that will be submitted for
	 * this advisor update. Maintenance may rewrite working history, but failure
	 * never asks the runtime to clear context.
	 */
	maintainContext?(incoming: AgentMessage[], signal: AbortSignal): Promise<void>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state and apply the in-progress delivery policy.
	 * The host owns these gates because it routes `advise()` results back to the
	 * primary.
	 */
	beginAdvisorUpdate?(inProgress: boolean): void;
	/**
	 * Called with the error of every failed advisor turn, before the retry sleep
	 * or the dropped-after-3 path. Lets the host apply credential-level remedies
	 * and configured model fallback that the advisor loop cannot perform itself.
	 * Return `true` after switching models so the same clean batch is retried
	 * immediately with a fresh failure budget. `failedMessages` contains the
	 * failed prompt's appended turns before rollback. Errors thrown here are
	 * logged and swallowed.
	 */
	onTurnError?(
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean | undefined> | boolean | undefined;
	/**
	 * Shared post-turn context/fallback arbitration. Called exactly once after
	 * every core prompt or continuation, including successful turns.
	 */
	onTurnSettled?(
		checkpoint: AdvisorHistoryCheckpoint,
		signal: AbortSignal,
		error?: unknown,
	): Promise<AdvisorTurnDisposition> | AdvisorTurnDisposition;
	/** Called after a successful advisor turn so the host can finish fallback lifecycle reporting. */
	onTurnSuccess?(): Promise<void> | void;
	/** Called when a failed batch is permanently dropped so replay-only state can be discarded. */
	onTurnAbandoned?(): void;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/** Signal that the advisor paused on a quota/rate-limit after host-level
	 *  recovery (credential switch, fallback chain) declined. Cleared only by
	 *  an explicit reset (`/new`, config rebuild, session restart). */
	notifyQuotaExhausted?(): void;
	/** Stable identity for the live advisor model. Used to restore full transcript rendering after a model switch. */
	getModelIdentity?(): string;
	/** Called once the runtime finishes draining its review backlog (or
	 *  hard-stops), so the host can repaint UI that reflects whether the
	 *  advisor is still going to comment on the current yield. */
	notifyIdle?(): void;
}

/**
 * A request rejection that no amount of retrying can fix for this advisor
 * configuration: the provider refuses the model/request shape outright (e.g.
 * "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a
 * ChatGPT account", code=invalid_request_error). Distinct from quota errors,
 * which pause via the dedicated quota path and auto-resume on reset.
 */
function isPermanentAdvisorError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i.test(message);
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

/** Signals that an advisor response was discarded before it could become model-visible context. */
export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}
class AdvisorSharedTerminalError extends Error {
	constructor(readonly terminalError: unknown) {
		super(terminalError instanceof Error ? terminalError.message : "Advisor context recovery ended");
	}
}

class AdvisorOrdinaryTurnError extends Error {
	constructor(
		readonly turnError: unknown,
		readonly checkpoint: AdvisorHistoryCheckpoint,
	) {
		super(turnError instanceof Error ? turnError.message : String(turnError));
	}
}


interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

/**
 * Replaces an advisor assistant turn that generated output-only destructive
 * directives with a sanitized error before dispatch.
 *
 * The agent loop records assistant turns before dispatching tools. Without this
 * pre-dispatch rewrite, a hazardous advisor turn would stay in the advisor
 * transcript as model-visible context. Calls to tools the advisor was not
 * granted are not a quarantine matter: the loop answers them with a
 * self-correcting `Tool <name> not found` result.
 */
export function quarantineAdvisorUnsafeOutput(message: AssistantMessage, sourceText = ""): string | undefined {
	const reasons: string[] = [];
	const generatedParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		const labels: string[] = [];
		const matchedLabels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (!hazard.pattern.test(generatedText)) continue;
			matchedLabels.push(hazard.label);
			if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
		}
		// A transcript can quote a destructive command while the advisor turns it
		// into a new instruction. The output-only override remains sufficient
		// provenance to quarantine that combination.
		if (
			matchedLabels.includes("destructive shell command") &&
			labels.includes("instruction override") &&
			!labels.includes("destructive shell command")
		) {
			labels.push("destructive shell command");
		}
		if (labels.includes("destructive shell command") || labels.length >= 3) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

/**
 * Builds the provenance text used to decide whether hazardous advisor output was
 * generated by the advisor or came from model-visible primary/tool context.
 */
export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}
/**
 * Maximum number of late-arrival coalescing rounds in {@link AdvisorRuntime.#collectAndMaintainBatch}.
 * After this many rounds any items still in `#pending` are left for the next drain iteration
 * so a pathologically fast primary + slow `maintainContext` cannot stall dispatch indefinitely.
 */
const MAX_COALESCE_ROUNDS = 3;

/**
 * Consecutive quarantined advisor turns tolerated before the failure is surfaced
 * to the host UI. A quarantine discards the advisor's whole turn before dispatch,
 * so its advice never reaches the primary; one silent re-prime is allowed to
 * recover a one-off hallucination, but a persistent quarantine loop is a real
 * supervision gap the user must see (issue #6661). Reset on any successful turn.
 */
const MAX_QUARANTINE_RETRIES = 2;

interface PendingDelta {
	text: string;
	rawMessages: AgentMessage[];
	renderRevision: number;
	turns: number;
	/** Whether the primary was mid-turn (willContinue:true) when this delta was rendered. */
	wip: boolean;
}

interface CatchupWaiter {
	threshold: number;
	finish: (caughtUp: boolean) => void;
	timer?: NodeJS.Timeout;
}

interface DeliveredMessage {
	message: AgentMessage;
	fingerprint: bigint | undefined;
}
interface OwnedContinuation {
	mode: AdvisorContinuationMode;
	checkpoint: AdvisorHistoryCheckpoint;
	epoch: number;
	finalTurns: number;
}

export class AdvisorRuntime {
	#lastCount = 0;
	/**
	 * Delivered prefix identities. References make the normal append-only path
	 * allocation-free; fingerprints preserve identity across equivalent clones.
	 */
	#deliveredPrefix: DeliveredMessage[] = [];
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	/** Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	/**
	 * Snapshot of {@link #seenContext} taken by #prepareBatch before the
	 * in-flight batch's first dedup mutation. Restored by
	 * {@link #rollbackFailedTurn} when the turn fails and its rawMessages are
	 * requeued, so first-time primary-context is re-delivered in full instead
	 * of collapsing to "(unchanged — still in effect)" against an advisor
	 * history that no longer contains it. Cleared on turn success.
	 */
	#seenContextInFlight: [string, string][] | undefined;
	/** Incremented whenever the advisor loses context so queued raw deltas are re-rendered against fresh dedupe state. */
	#renderRevision = 0;
	/** Regex secret values observed in primary deltas and retained until advisor context resets. */
	#advisorRegexSecretValues = new Set<string>();
	#pending: PendingDelta[] = [];
	#busy = false;
	#sessionTransitionPaused = false;
	/** Entire facade drain, including settled hooks and owned continuations. */
	#drainInFlight: Promise<void> | undefined;
	#promptInFlight: Promise<void> | undefined;
	#iterationAbort: AbortController | undefined;
	#ownedContinuation: OwnedContinuation | undefined;
	#deferredContinuations: OwnedContinuation[] = [];
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;
	/** Consecutive quarantined turns since the last success/reset (issue #6661). */
	#consecutiveQuarantines = 0;
	/**
	 * Model identities this refusal cascade has already tried. The cascade walks
	 * the fallback chain to exhaustion — that is what the chain is for — but
	 * visits each model at most once, so a chain whose keys point back at each
	 * other (A→B, B→A) cannot ping-pong forever. Cleared when a successful or
	 * terminal turn ends the cascade, or on reset, so a later refusal starts fresh.
	 */
	readonly #refusalModelsTried = new Set<string>();
	/** Whether primary reasoning is included in advisor deltas for the current model. */
	#includeThinking = true;
	#modelIdentity: string | undefined;
	/** Completed 3-failure backlog-drop cycles since the last success/reset. */
	#droppedBacklogs = 0;
	/**
	 * Hard stop after repeated drop cycles or a permanent request rejection
	 * (e.g. "model not supported"): without it the advisor re-attempts on every
	 * new delta forever, and in a shared daemon that unbounded churn burns CPU
	 * and starves every hosted session's event loop. Cleared only by an
	 * explicit {@link reset} (config rebuild, /new, session restart).
	 */
	#halted = false;
	/**
	 * Whether the runtime has completed at least one review (a drain batch that
	 * ended in a successful advisor turn). Gates {@link yielded} so the
	 * status-line eye stays open until a review actually completes — a fresh
	 * runtime with an empty backlog has not "finished" anything yet.
	 */
	#hasReviewed = false;
	/** True from the moment an advisor turn fails until one succeeds (or an
	 *  explicit reset/seed). While set, {@link waitForCatchup} resolves
	 *  immediately: the primary agent NEVER parks on a failing advisor. */
	#failing = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	#checkpointSequence = 0;
	disposed = false;
	/** Quota/rate-limit pause state. When `true`, the advisor stops processing
	 *  turns and drops new deltas until an explicit {@link reset} clears it
	 *  (triggered by `/new`, config rebuild, or session restart). There is no
	 *  timer-based auto-resume: provider quota windows (5h/7d) are far longer
	 *  than any reasonable timer, and premature retries waste calls and
	 *  re-trigger the same error. */
	#quotaExhausted = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}
	get quotaExhausted(): boolean {
		return this.#quotaExhausted;
	}
	get failureNotified(): boolean {
		return this.#failureNotified;
	}
	/** True after the runtime hard-stopped on repeated or permanent failures. */
	get halted(): boolean {
		return this.#halted;
	}
	/**
	 * True once the runtime has completed at least one review and has no queued
	 * or in-flight review work left, or has hard-stopped (halted/quota-paused/
	 * disposed): the advisor is not going to add any more comments until a new
	 * primary turn (or an explicit reset). A fresh runtime that has never
	 * reviewed anything is NOT yielded — the eye stays open until the first
	 * review completes. Drives the status-line closed-eye state.
	 */
	get yielded(): boolean {
		return (
			this.disposed ||
			this.#quotaExhausted ||
			this.#halted ||
			(this.#hasReviewed &&
				!this.#busy &&
				this.#backlog === 0 &&
				this.#pending.length === 0 &&
				this.#ownedContinuation === undefined)
		);
	}
	/** Queued primary updates take priority over optional automatic continuation. */
	get hasPendingUpdates(): boolean {
		return this.#pending.length > 0;
	}

	/**
	 * Called after each primary turn ends. Renders the incremental delta and
	 * queues it for the advisor model.
	 *
	 * @param messages - Live primary transcript snapshot (defaults to `snapshotMessages()`).
	 * @param opts.willContinue - When `true` the primary is mid-turn (more tool-call
	 *   steps will follow). The rendered heading is tagged `[in progress]` so the
	 *   advisor knows to withhold critique on partial work. The flag is carried on
	 *   the delta and forwarded to the reprime path so it is never silently dropped.
	 */
	onTurnEnd(messages?: AgentMessage[], opts?: { willContinue?: boolean }): void {
		if (this.disposed || this.#quotaExhausted || this.#halted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const wip = opts?.willContinue ?? false;
		let rendered: Omit<PendingDelta, "turns"> | null = null;
		// #renderDelta advances the cursor/prefix/dedup state before formatting
		// can throw; snapshot them so a formatter bug loses NOTHING — the next
		// turn re-renders this delta (a prefix change mid-render self-heals via
		// the fingerprint scan, at worst costing one full replay).
		const cursorBefore = this.#lastCount;
		const prefixBefore = this.#deliveredPrefix.slice();
		const seenBefore = [...this.#seenContext];
		try {
			rendered = this.#renderDelta(all, wip);
		} catch (err) {
			// A render bug must never propagate into the primary agent's
			// turn-end callback: the advisor skips this delta and stops gating
			// the catch-up wait until a turn succeeds.
			this.#lastCount = cursorBefore;
			this.#deliveredPrefix = prefixBefore;
			this.#seenContext.clear();
			for (const [key, value] of seenBefore) this.#seenContext.set(key, value);
			this.#failing = true;
			this.#wakeAllWaiters();
			logger.warn("advisor delta render failed", { err: String(err) });
		}
		if (rendered) {
			this.#pending.push({ ...rendered, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			this.#startDrain();
		}
	}

	/**
	 * Wait until the advisor backlog falls below `threshold`.
	 *
	 * Returns `false` when the deadline, abort signal, or a runtime failure releases
	 * the waiter before the requested backlog was drained.
	 */
	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<boolean> {
		if (
			this.disposed ||
			signal?.aborted ||
			this.#backlog < threshold ||
			this.#quotaExhausted ||
			this.#halted ||
			// An advisor mid-failure/retry must NEVER gate the primary agent:
			// its backlog cannot drain until the retry cycle resolves, and the
			// primary would otherwise park for the full catch-up budget.
			this.#failing
		)
			return Promise.resolve(this.#backlog < threshold);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const finish = (caughtUp: boolean): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", abort);
			resolve(caughtUp);
		};
		const abort = (): void => finish(false);
		const waiter = {
			threshold,
			finish,
			timer: setTimeout(abort, maxMs),
		};
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
		}
		return promise;
	}

	dispose(): void {
		this.#iterationAbort?.abort("advisor disposed");
		this.#ownedContinuation = undefined;
		this.#deferredContinuations = [];
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#advisorRegexSecretValues.clear();
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#clearSeenContext(): void {
		this.#seenContext.clear();
		this.#seenContextInFlight = undefined;
		this.#advisorRegexSecretValues.clear();
		this.#renderRevision++;
	}

	#clearAdvisorContextAtCurrentCursor(reason?: string): void {
		this.#consecutiveFailures = 0;
		this.#clearSeenContext();
		try {
			this.agent.reset(reason);
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean, reason?: string): void {
		if (reason) {
			logger.debug("advisor context reset", {
				reason,
				lastCount: this.#lastCount,
				pending: this.#pending.length,
				backlog: this.#backlog,
			});
		}
		this.#lastCount = 0;
		this.#ownedContinuation = undefined;
		this.#deferredContinuations = [];
		this.#deliveredPrefix = [];
		this.#pending = [];
		this.#clearAdvisorContextAtCurrentCursor(reason);
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
	}

	/**
	 * Account one completed 3-failure backlog-drop cycle. Repeated cycles (or a
	 * single permanent request rejection, e.g. "model not supported") hard-stop
	 * the runtime: in a shared daemon, unbounded advisor churn re-builds heavy
	 * context on every new delta and starves every hosted session's event loop.
	 * Only an explicit {@link reset} (config rebuild, /new, restart) resumes.
	 */
	#noteDroppedBacklog(error: unknown): void {
		this.#droppedBacklogs++;
		if (this.#droppedBacklogs < 3 && !isPermanentAdvisorError(error)) return;
		this.#halted = true;
		this.#pending = [];
		this.#wakeAllWaiters();
		logger.warn("advisor halted after repeated failures; use /advisor or reload config to re-enable", {
			droppedBacklogs: this.#droppedBacklogs,
			err: String(error),
		});
	}

	/** Stop new advisor work and wait for the whole owned facade transaction. */
	pauseForSessionTransition(): Promise<void> {
		if (!this.#sessionTransitionPaused) {
			this.#sessionTransitionPaused = true;
			this.#wakeAllWaiters();
			this.#iterationAbort?.abort("advisor session transition");
			try {
				this.agent.abort("advisor session transition");
			} catch {}
		}
		return this.#drainInFlight ?? Promise.resolve();
	}

	/** Continue queued work after a session transition rolls back or preserves the conversation. */
	resumeAfterSessionTransition(): void {
		if (!this.#sessionTransitionPaused) return;
		this.#sessionTransitionPaused = false;
		if (!this.#quotaExhausted && !this.#halted) this.#startDrain();
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(reason = "external"): void {
		// Step-1 observability (issue #7226): every re-prime logs its trigger so
		// live investigations can attribute full-transcript replays (cached_tokens
		// pinned at the instructions/tools boundary) to a concrete path instead of
		// inferring it from payload markers after the fact.
		this.#iterationAbort?.abort("advisor reset");
		this.#ownedContinuation = undefined;
		this.#deferredContinuations = [];
		this.#epoch++;
		this.#sessionTransitionPaused = false;
		this.#quotaExhausted = false;
		this.#halted = false;
		// A re-primed advisor has not reviewed the (new) conversation yet — drop
		// the latch so the eye stays open until the first post-reset review, and
		// so an aborted prior drain cannot emit a stale advisor_yielded.
		this.#hasReviewed = false;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#consecutiveQuarantines = 0;
		this.#refusalModelsTried.clear();
		this.#failureNotified = false;
		this.#resetAdvisorContext(true, true, reason);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		const messages = this.host.snapshotMessages().slice(0, count);
		this.#lastCount = messages.length;
		this.#deliveredPrefix = messages.map(message => ({
			message,
			fingerprint: fingerprintMessage(message),
		}));
		this.#pending = [];
		this.#ownedContinuation = undefined;
		this.#deferredContinuations = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#failureNotified = false;
		this.#clearSeenContext();
		this.#wakeAllWaiters();
	}

	#syncModelIdentity(): void {
		const identity = this.host.getModelIdentity?.();
		if (identity === undefined || identity === this.#modelIdentity) return;
		this.#modelIdentity = identity;
		this.#includeThinking = true;
	}

	// Candidate 4 (multi-message split): render the Session update as MULTIPLE
	// user messages — one per source message — instead of one ever-growing user
	// message. Provider prompt caches are prefix-based: a single user message
	// whose text keeps growing invalidates the whole message on every turn, so
	// cache_read stays pinned at the instructions/tools boundary (observed
	// 14491 in production, 11066 in tests). Splitting into per-source user
	// messages lets the provider cache each appended message (verified
	// experimentally: cache_read 11066 → 11091 → 11112 vs pinned 11066).
	//
	/**
	 * Shared obfuscation side effects for BOTH render paths (single-block
	 * {@link #renderPreparedDelta} and multi-message
	 * {@link #formatRawDeltaMessageChunks}): collect regex secret values from
	 * primary-context custom messages, rendered markdown and native advisor history
	 * before scrubbing that history, then refresh pending placeholder prefixes.
	 * Returns whether new secret values were discovered.
	 * Idempotent across the two calls one drain makes for the same prepared
	 * list: the second call discovers nothing new and skips the strip.
	 */
	#collectAdvisorSecrets(obfuscator: SecretObfuscator, delta: AgentMessage[], renderedMd: string): boolean {
		let discoveredNewRegexSecretValue = false;
		const addRegexValues = (text: string): void => {
			for (const secretValue of obfuscator.collectRegexSecretValuesForObfuscation(text) ?? []) {
				if (this.#advisorRegexSecretValues.has(secretValue)) continue;
				this.#advisorRegexSecretValues.add(secretValue);
				discoveredNewRegexSecretValue = true;
			}
		};
		const addTextualContent = (content: TextualContent): void => {
			if (typeof content === "string") {
				addRegexValues(content);
				return;
			}
			for (const block of content) {
				if (block.type === "text") addRegexValues(block.text);
			}
		};
		for (const message of delta) {
			if (
				message.role === "custom" &&
				PRIMARY_CONTEXT_CUSTOM_TYPES.has(message.customType) &&
				typeof message.content === "string"
			) {
				addRegexValues(message.content);
			}
			if (message.role === "toolResult") addTextualContent(message.content as TextualContent);
		}
		addRegexValues(renderedMd);
		discoveredNewRegexSecretValue =
			scrubAdvisorHistory(obfuscator, this.agent.state.messages, this.#advisorRegexSecretValues) ||
			discoveredNewRegexSecretValue;
		if (discoveredNewRegexSecretValue) {
			this.#refreshPendingSecretPrefixes(obfuscator);
		}
		return discoveredNewRegexSecretValue;
	}

	#refreshPendingSecretPrefixes(obfuscator: SecretObfuscator): void {
		this.#pending = this.#pending.map(delta => ({
			...delta,
			text: obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(delta.text, this.#advisorRegexSecretValues),
		}));
	}

	/**
	 * Map primary-context custom messages through the obfuscator. Shared by
	 * both render paths so the byte-equivalence contract lives in one place.
	 */
	#obfuscatePrimaryContextMessages(obfuscator: SecretObfuscator, delta: AgentMessage[]): AgentMessage[] {
		return delta.map(message =>
			message.role === "custom" && PRIMARY_CONTEXT_CUSTOM_TYPES.has(message.customType)
				? obfuscateAdvisorMessage(obfuscator, message, this.#advisorRegexSecretValues)
				: message,
		);
	}

	// Each source message is rendered INDEPENDENTLY via
	// formatSessionHistoryMarkdown in chunked mode (shared toolResultIndex +
	// consumedToolCallIds over the WHOLE delta), so a toolCall finds its
	// toolResult across chunk boundaries and consecutive same-role collapsing
	// is preserved. Concatenating the chunk texts with the same separator the
	// old single-block render used yields byte-identical advisor context.
	// Each chunk is delivered as its own user AgentMessage via a SINGLE
	// Agent.prompt(AgentMessage[]) call, so the advisor model still runs ONCE
	// per update (no per-message assistant turns).
	#formatRawDeltaMessageChunks(preparedMessages: AgentMessage[], wip = false): AgentMessage[] | null {
		// Consumes the ALREADY-prepared view from #prepareBatch: advisor custom
		// messages are filtered and primary-context dedup is applied there, so
		// splitting here never double-folds or leaks hidden messages.
		const delta = preparedMessages;
		if (delta.length === 0) return null;

		const obfuscator = this.host.obfuscator;
		// Side effects the pure renderer cannot own: collect secrets, scrub the
		// advisor's own history and refresh pending placeholder prefixes (shared
		// helper — see #collectAdvisorSecrets; idempotent for this drain's
		// single-block pass over the same prepared list).
		const probeMd = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.#includeThinking,
		});
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, probeMd);
		}

		// Message-level obfuscation mirrors the old #formatRawDelta path EXACTLY:
		// only primary-context custom messages are mapped (tool args, details.diff,
		// structured fields), because the old path's contract is whole-delta text
		// obfuscation as the final pass. Expanding to every role would mint
		// different placeholders and break byte-equivalence with the old render.
		const renderDelta = obfuscator?.hasSecrets() ? this.#obfuscatePrimaryContextMessages(obfuscator, delta) : delta;

		const chunks = renderAdvisorDeltaChunks(renderDelta, {
			wip,
			includeThinking: this.#includeThinking,
			obfuscator: obfuscator?.hasSecrets() ? obfuscator : undefined,
			advisorRegexSecretValues: this.#advisorRegexSecretValues,
		});
		return chunks;
	}

	#formatRawDelta(rawMessages: AgentMessage[], wip = false, updateSeenContext = true): string | null {
		const delta = rawMessages
			.filter(message => !(message.role === "custom" && message.customType === "advisor"))
			.map(message =>
				updateSeenContext ? this.#dedupContextMessage(message) : this.#dedupContextMessageReadOnly(message),
			);
		return this.#renderPreparedDelta(delta, wip);
	}

	/**
	 * Preview variant of #dedupContextMessage: returns the collapse decision
	 * WITHOUT advancing the live #seenContext map. Used by #renderDelta so the
	 * preview text does not make the batch's first real delivery look like a
	 * re-injection.
	 */
	#dedupContextMessageReadOnly(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		if (!PRIMARY_CONTEXT_CUSTOM_TYPES.has(msg.customType)) return msg;
		if (typeof msg.content !== "string") return msg;
		if (this.#seenContext.get(msg.customType) === msg.content) {
			return { ...msg, content: "(unchanged — still in effect)" };
		}
		return msg;
	}

	/**
	 * Render already-prepared (deduped + advisor-filtered) messages to the
	 * single-block Session update text. Does NOT dedup again — callers that
	 * prepared the list must pass it here directly, and callers that prepared
	 * via #prepareBatch get byte-identical batch text to what the multi-message
	 * split consumes.
	 */
	#renderPreparedDelta(preparedMessages: AgentMessage[], wip = false): string | null {
		const delta = preparedMessages;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		let md = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.#includeThinking,
		});
		if (!md.trim()) return null;
		if (obfuscator?.hasSecrets()) {
			this.#collectAdvisorSecrets(obfuscator, delta, md);
			md = formatSessionHistoryMarkdown(this.#obfuscatePrimaryContextMessages(obfuscator, delta), {
				...ADVISOR_RENDER_OPTIONS,
				includeThinking: this.#includeThinking,
				transformExpandedToolIO: text => obfuscator.obfuscate(text, this.#advisorRegexSecretValues),
			});
			md = obfuscator.obfuscate(md, this.#advisorRegexSecretValues);
		}
		// Candidate 3: keep the heading byte-identical between wip and final turns
		// and put the WIP marker at the END of the batch, so a wip/final flip
		// never changes the batch prefix. The provider prompt cache is
		// prefix-based; a heading that flips between turns re-prefills the whole
		// user message on every in-progress turn.
		const heading = "### Session update";
		const mdHead = `${heading}\n\n${md}`;
		if (!wip) return mdHead;
		return `${mdHead}\n\n---\n\n[in progress — more steps follow]`;
	}

	#renderDelta(messages?: AgentMessage[], wip = false): Omit<PendingDelta, "turns"> | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		let prefixChanged = all.length < this.#lastCount;
		for (let i = 0; !prefixChanged && i < this.#lastCount; i++) {
			const delivered = this.#deliveredPrefix[i];
			const current = all[i];
			if (delivered === undefined || current === undefined) {
				prefixChanged = true;
				break;
			}
			if (delivered.message === current) continue;
			const fingerprint = fingerprintMessage(current);
			if (
				delivered.fingerprint === undefined ||
				fingerprint === undefined ||
				delivered.fingerprint !== fingerprint
			) {
				prefixChanged = true;
				// Full replays are expensive (the whole transcript is re-sent and
				// the provider prompt cache re-prefills from the system prompt), so
				// record exactly which delivered message diverged and which
				// top-level fields changed — without this the trigger is invisible.
				try {
					const oldMsg: Record<string, unknown> = delivered.message as unknown as Record<string, unknown>;
					const newMsg: Record<string, unknown> = current as unknown as Record<string, unknown>;
					const differingFields: string[] = [];
					for (const key of new Set([...Object.keys(oldMsg), ...Object.keys(newMsg)])) {
						if (JSON.stringify(oldMsg[key]) !== JSON.stringify(newMsg[key])) differingFields.push(key);
					}
					logger.debug("advisor delivered prefix changed", { index: i, role: newMsg.role, differingFields });
				} catch {}
				break;
			}
			delivered.message = current;
		}
		if (prefixChanged) {
			this.#epoch++;
			logger.debug("advisor context reset", { reason: "delivered-prefix-changed", lastCount: this.#lastCount });
			this.#resetAdvisorContext(true, true);
		}
		const rawMessages = all.slice(this.#lastCount);
		for (let i = this.#lastCount; i < all.length; i++) {
			const message = all[i];
			if (message === undefined) continue;
			this.#deliveredPrefix.push({ message, fingerprint: fingerprintMessage(message) });
		}
		this.#lastCount = all.length;
		// Preview render: do NOT advance #seenContext — the batch's real dedup
		// happens once in #prepareBatch. Advancing here would make the first
		// real delivery of a re-injected primary-context message collapse to
		// "(unchanged…)" (double-fold).
		const text = this.#formatRawDelta(rawMessages, wip, false);
		return text ? { text, rawMessages, renderRevision: this.#renderRevision, wip } : null;
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		// Narrowed to CustomMessage: customType and content are properly typed.
		if (!PRIMARY_CONTEXT_CUSTOM_TYPES.has(msg.customType)) return msg;
		if (typeof msg.content !== "string") return msg;
		if (this.#seenContext.get(msg.customType) === msg.content) {
			return { ...msg, content: "(unchanged — still in effect)" };
		}
		this.#seenContext.set(msg.customType, msg.content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish(true);
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of Array.from(this.#waiters)) {
			w.finish(false);
		}
	}

	#restoreSeenContextInFlight(): void {
		if (!this.#seenContextInFlight) return;
		this.#seenContext.clear();
		for (const [key, value] of this.#seenContextInFlight) this.#seenContext.set(key, value);
		this.#seenContextInFlight = undefined;
	}

	#captureCheckpoint(): AdvisorHistoryCheckpoint {
		return (
			this.agent.checkpoint?.() ?? {
				id: `runtime-${this.#epoch}-${++this.#checkpointSequence}`,
				generation: this.#epoch,
				rewriteVersion: 0,
				messages: this.agent.state.messages.slice(),
			}
		);
	}

	#messagesSince(checkpoint: AdvisorHistoryCheckpoint): readonly AgentMessage[] {
		if (this.agent.messagesSince) return this.agent.messagesSince(checkpoint);
		const baseline = new Set(checkpoint.messages);
		return this.agent.state.messages.filter(message => !baseline.has(message));
	}

	#hasCommittedRewrite(checkpoint: AdvisorHistoryCheckpoint): boolean {
		return this.agent.hasCommittedRewrite?.(checkpoint) ?? false;
	}

	async #discardFailedAttempt(checkpoint: AdvisorHistoryCheckpoint): Promise<void> {
		if (this.agent.discardFailedAttempt) {
			await this.agent.discardFailedAttempt(checkpoint);
			return;
		}
		const baseline = new Set(checkpoint.messages);
		const retained = this.agent.state.messages.filter(message => baseline.has(message));
		this.agent.state.messages.splice(0, this.agent.state.messages.length, ...retained);
	}

	async #restoreCheckpoint(checkpoint: AdvisorHistoryCheckpoint, reason: string): Promise<void> {
		this.#restoreSeenContextInFlight();
		if (this.agent.restoreCheckpoint) {
			await this.agent.restoreCheckpoint(checkpoint, reason);
			return;
		}
		await this.#discardFailedAttempt(checkpoint);
	}

	/**
	 * Coalesce a bounded primary update and admit the exact finalized rendered
	 * messages before dispatch. A maintenance failure is advisory: it neither
	 * resets working history nor changes the primary delivery cursor.
	 */
	async #collectAndMaintainBatch(
		epoch: number,
		initial: PendingDelta[],
		signal: AbortSignal,
	): Promise<{
		promptInput: AgentMessage[];
		rawMessages: AgentMessage[];
		finalTurns: number;
		wip: boolean;
	} | null> {
		let batchText = initial.map(item => item.text).join("\n\n");
		let rawMessages = initial.flatMap(item => item.rawMessages);
		let turns = initial.reduce((sum, item) => sum + item.turns, 0);
		let wip = initial.at(-1)?.wip ?? false;
		const seenBeforeAdmission = [...this.#seenContext];

		for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
			if (this.#sessionTransitionPaused) {
				if (this.#epoch === epoch) {
					this.#restoreSeenContextInFlight();
					this.#pending.unshift(...initial);
				}
				return null;
			}
			this.#seenContext.clear();
			for (const [key, value] of seenBeforeAdmission) this.#seenContext.set(key, value);
			this.#seenContextInFlight = seenBeforeAdmission;

			const { batch, preparedMessages } = this.#prepareBatch(rawMessages, wip, batchText);
			const splitMessages = this.#formatRawDeltaMessageChunks(preparedMessages, wip);
			const promptInput =
				splitMessages ??
				(batch
					? ([{ role: "user", content: batch, timestamp: Date.now() }] as AgentMessage[])
					: []);

			if (this.host.maintainContext && promptInput.length > 0) {
				try {
					await this.host.maintainContext(promptInput, signal);
				} catch (err) {
					logger.debug("advisor context maintenance failed", { err: String(err) });
				}
				if (this.#epoch !== epoch) return null;
			}

			const obfuscator = this.host.obfuscator;
			if (obfuscator?.hasSecrets()) {
				if (scrubAdvisorHistory(obfuscator, this.agent.state.messages, this.#advisorRegexSecretValues)) {
					this.#refreshPendingSecretPrefixes(obfuscator);
				}
			}

			if (round === MAX_COALESCE_ROUNDS - 1) {
				return { promptInput, rawMessages, finalTurns: turns, wip };
			}
			const late = this.#pending.splice(0);
			if (late.length === 0) {
				return { promptInput, rawMessages, finalTurns: turns, wip };
			}

			this.#seenContext.clear();
			for (const [key, value] of seenBeforeAdmission) this.#seenContext.set(key, value);
			this.#seenContextInFlight = seenBeforeAdmission;
			initial.push(...late);
			batchText = [batchText, ...late.map(item => item.text)].join("\n\n");
			rawMessages = rawMessages.concat(late.flatMap(item => item.rawMessages));
			turns += late.reduce((sum, item) => sum + item.turns, 0);
			wip = late.at(-1)!.wip;
		}

		return null;
	}

	/**
	 * Single dedup+render pass shared by every batch finalization path (normal
	 * and context-reset). Filters advisor custom messages, collapses re-injected
	 * primary-context to "(unchanged…)" via #dedupContextMessage, renders the
	 * single-block batch text from the SAME prepared list the multi-message
	 * split consumes, so the two views can never diverge.
	 */
	#prepareBatch(
		rawMessages: AgentMessage[],
		wip: boolean,
		fallback: string | null,
	): { batch: string | null; preparedMessages: AgentMessage[] } {
		// Dedup against the LIVE #seenContext (populated by previous turns via
		// #renderDelta -> #formatRawDelta) so re-injected primary context that
		// was ALREADY shown collapses to "(unchanged…)", while a FIRST delivery
		// in this batch stays expanded. This pass advances the live map exactly
		// once per batch — #renderDelta's text is a preview and must not set it.
		// Snapshot the dedup map BEFORE this batch's first mutation so a failed
		// turn can restore it (see #rollbackFailedTurn). `??=` keeps the first
		// snapshot across coalescing re-prepares within one in-flight batch.
		this.#seenContextInFlight ??= [...this.#seenContext];
		const preparedMessages = rawMessages
			.filter(message => !(message.role === "custom" && message.customType === "advisor"))
			.map(message => this.#dedupContextMessage(message));
		const batch = this.#renderPreparedDelta(preparedMessages, wip);
		return { batch: batch ?? fallback, preparedMessages };
	}

	#terminalAssistantFailure(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant" && message.stopReason === "error") return message;
		}
		return undefined;
	}

	#notifyFailureOnce(error: unknown): void {
		if (this.#failureNotified) return;
		this.#failureNotified = true;
		try {
			this.host.notifyFailure?.(error);
		} catch (notifyErr) {
			logger.warn("advisor failure notification failed", { err: String(notifyErr) });
		}
	}
	#notifyTurnAbandoned(): void {
		try {
			this.host.onTurnAbandoned?.();
		} catch (err) {
			logger.debug("advisor onTurnAbandoned hook failed", { err: String(err) });
		}
	}

	#queueOwnedContinuation(continuation: OwnedContinuation): void {
		if (!this.#ownedContinuation) {
			this.#ownedContinuation = continuation;
			return;
		}
		if (continuation.mode === "retry") {
			this.#deferredContinuations.unshift(this.#ownedContinuation);
			this.#ownedContinuation = continuation;
			return;
		}
		this.#deferredContinuations.push(continuation);
	}

	async #runOwnedContinuation(
		mode: AdvisorContinuationMode,
		checkpoint: AdvisorHistoryCheckpoint,
		epoch: number,
		signal: AbortSignal,
	): Promise<"completed" | "deferred"> {
		let nextMode = mode;
		let currentCheckpoint = checkpoint;
		for (;;) {
			let core: Promise<void> | undefined;
			let turnError: unknown;
			try {
				core = this.agent.continue?.(nextMode);
				if (!core) throw new Error("Advisor continuation is unavailable");
				this.#promptInFlight = core;
				await core;
				const promptError = this.agent.state.error;
				turnError = promptError
					? new Error(promptError)
					: getAdvisorTurnError(this.#messagesSince(currentCheckpoint));
			} catch (err) {
				turnError = err;
			} finally {
				if (core && this.#promptInFlight === core) this.#promptInFlight = undefined;
			}

			let disposition: AdvisorTurnDisposition = { kind: "not-applicable" };
			if (this.host.onTurnSettled) {
				try {
					disposition = await Promise.resolve(
						this.host.onTurnSettled(currentCheckpoint, signal, turnError),
					);
				} catch (settledError) {
					throw new AdvisorSharedTerminalError(settledError);
				}
			}
			if (this.#epoch !== epoch) return "deferred";
			if (signal.aborted && (turnError !== undefined || disposition.kind === "continue")) {
				if (turnError !== undefined) {
					await this.#discardFailedAttempt(currentCheckpoint);
					if (this.#epoch !== epoch) return "deferred";
				}
				if (this.#ownedContinuation?.epoch === epoch) {
					this.#ownedContinuation = {
						...this.#ownedContinuation,
						mode: disposition.kind === "continue" ? disposition.mode : "retry",
						checkpoint: this.#captureCheckpoint(),
					};
				}
				throw signal.reason ?? new Error("Advisor continuation paused");
			}
			if (disposition.kind === "continue") {
				if (turnError !== undefined) {
					await this.#discardFailedAttempt(currentCheckpoint);
					if (this.#epoch !== epoch) return "deferred";
				}
				nextMode = disposition.mode;
				currentCheckpoint = this.#captureCheckpoint();
				if (nextMode === "auto" && this.#pending.length > 0) {
					if (this.#ownedContinuation?.epoch === epoch) {
						this.#ownedContinuation.mode = nextMode;
						this.#ownedContinuation.checkpoint = currentCheckpoint;
					}
					return "deferred";
				}
				continue;
			}
			if (disposition.kind === "terminal") {
				throw new AdvisorSharedTerminalError(
					disposition.error ?? turnError ?? new Error("Advisor context recovery ended"),
				);
			}
			if (turnError !== undefined) throw new AdvisorOrdinaryTurnError(turnError, currentCheckpoint);
			return "completed";
		}
	}

	#startDrain(): void {
		if (this.#drainInFlight || this.#sessionTransitionPaused || this.disposed) return;
		const drain = Promise.resolve().then(() => this.#drain());
		this.#drainInFlight = drain;
		void drain.finally(() => {
			if (this.#drainInFlight !== drain) return;
			this.#drainInFlight = undefined;
			if (
				!this.disposed &&
				!this.#sessionTransitionPaused &&
				!this.#quotaExhausted &&
				!this.#halted &&
				(this.#pending.length > 0 || this.#ownedContinuation !== undefined)
			) {
				this.#startDrain();
			}
		});
	}

	async #drain(): Promise<void> {
		if (this.#busy || this.#sessionTransitionPaused) return;
		this.#busy = true;
		try {
			this.#syncModelIdentity();
			while (
				!this.disposed &&
				!this.#sessionTransitionPaused &&
				!this.#quotaExhausted &&
				!this.#halted &&
				(this.#pending.length > 0 || this.#ownedContinuation !== undefined)
			) {
				const owned = this.#ownedContinuation;
				if (owned && (owned.mode === "retry" || this.#pending.length === 0)) {
					const iterationAbort = new AbortController();
					this.#iterationAbort = iterationAbort;
					owned.checkpoint = this.#captureCheckpoint();
					try {
						const continuationResult = await this.#runOwnedContinuation(
							owned.mode,
							owned.checkpoint,
							owned.epoch,
							iterationAbort.signal,
						);
						if (continuationResult === "deferred") continue;
						if (this.#epoch !== owned.epoch) continue;
						this.#ownedContinuation = this.#deferredContinuations.shift();
						this.#hasReviewed = true;
						this.#failing = false;
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#backlog = Math.max(0, this.#backlog - owned.finalTurns);
						this.#notifyWaiters();
						try {
							await Promise.resolve(this.host.onTurnSuccess?.());
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					} catch (err) {
						if (this.#epoch !== owned.epoch) continue;
						if (this.#sessionTransitionPaused) continue;
						if (err instanceof AdvisorSharedTerminalError) {
							this.#ownedContinuation = this.#deferredContinuations.shift();
							this.#notifyFailureOnce(err.terminalError);
							this.#notifyTurnAbandoned();
							this.#backlog = Math.max(0, this.#backlog - owned.finalTurns);
							this.#notifyWaiters();
							continue;
						}
						const ordinary = err instanceof AdvisorOrdinaryTurnError ? err : undefined;
						const turnError = ordinary?.turnError ?? err;
						const attemptCheckpoint = ordinary?.checkpoint ?? owned.checkpoint;
						const failedMessages = this.#messagesSince(attemptCheckpoint);
						await this.#discardFailedAttempt(attemptCheckpoint);
						if (this.#epoch !== owned.epoch) continue;
						let recovered = false;
						try {
							recovered =
								(await Promise.resolve(
									this.host.onTurnError?.(turnError, failedMessages, iterationAbort.signal),
								)) === true;
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
						}
						if (this.#epoch !== owned.epoch || this.#sessionTransitionPaused) continue;
						if (recovered) {
							owned.mode = "retry";
							owned.checkpoint = this.#captureCheckpoint();
							continue;
						}
						if (AIError.isUsageLimit(turnError)) {
							this.#quotaExhausted = true;
							owned.mode = "retry";
							owned.checkpoint = this.#captureCheckpoint();
							this.#wakeAllWaiters();
							this.host.notifyQuotaExhausted?.();
							break;
						}
						if (turnError instanceof AdvisorOutputQuarantinedError) {
							this.#consecutiveQuarantines++;
							if (this.#consecutiveQuarantines < MAX_QUARANTINE_RETRIES) {
								const rePrime = this.#latestMessages;
								this.#resetAdvisorContext(true, !rePrime, "quarantine-recovery");
								if (rePrime) this.onTurnEnd(rePrime);
								continue;
							}
							this.#consecutiveQuarantines = 0;
						}
						const terminalFailure = this.#terminalAssistantFailure(failedMessages);
						const terminalFailureId =
							terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
						const rawErrorId = AIError.classify(turnError);
						const classifierRefusal =
							(terminalFailure !== undefined && isClassifierRefusal(terminalFailure)) ||
							(!AIError.is(rawErrorId, AIError.Flag.AccountPolicy) &&
								AIError.is(rawErrorId, AIError.Flag.ContentBlocked));
						const retriable = terminalFailureId === undefined || AIError.retriable(terminalFailureId);
						if (!classifierRefusal && retriable) {
							this.#consecutiveFailures++;
							if (this.#consecutiveFailures < 3) {
								owned.mode = "retry";
								owned.checkpoint = this.#captureCheckpoint();
								if (this.retryDelayMs <= 0) {
									await Bun.sleep(0);
								} else {
									try {
										await raceWithSignal(Bun.sleep(this.retryDelayMs), iterationAbort.signal);
									} catch (sleepError) {
										if (!iterationAbort.signal.aborted) throw sleepError;
									}
								}
								continue;
							}
							this.#consecutiveFailures = 0;
							this.#noteDroppedBacklog(turnError);
						}
						this.#ownedContinuation = this.#deferredContinuations.shift();
						this.#notifyFailureOnce(turnError);
						this.#notifyTurnAbandoned();
						this.#backlog = Math.max(0, this.#backlog - owned.finalTurns);
						this.#notifyWaiters();
					}
					continue;
				}
				this.#syncModelIdentity();
				const popped = this.#pending.splice(0);
				const iterationAbort = new AbortController();
				this.#iterationAbort = iterationAbort;
				const epoch = this.#epoch;
				for (const delta of popped) {
					if (delta.renderRevision === this.#renderRevision) continue;
					// Context maintenance estimates this preview before #prepareBatch makes
					// its final deduped render. Rebuild stale text against the new context
					// so the maintenance budget cannot undercount an expanded re-injection.
					delta.text = this.#formatRawDelta(delta.rawMessages, delta.wip, false) ?? delta.text;
					delta.renderRevision = this.#renderRevision;
				}
				const result = await this.#collectAndMaintainBatch(epoch, popped, iterationAbort.signal);
				if (this.#epoch !== epoch) continue;

				// Epoch was invalidated during batch collection; restart the loop.
				if (result === null) continue;
				if (this.#sessionTransitionPaused) {
					this.#restoreSeenContextInFlight();
					this.#pending.unshift(...popped);
					continue;
				}

				const { promptInput, rawMessages, finalTurns, wip } = result;

				if (this.disposed || promptInput.length === 0) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				let checkpoint = this.#captureCheckpoint();
				let reviewHasCommittedRewrite = false;
				let deferredContinuation = false;
				let sharedTerminal = false;
				let continuationMode: AdvisorContinuationMode | undefined;
				try {
					this.host.beginAdvisorUpdate?.(wip);
					for (;;) {
						let turnError: unknown;
						try {
							const core = continuationMode
								? this.agent.continue?.(continuationMode)
								: this.agent.prompt(promptInput);
							if (!core) throw new Error("Advisor continuation is unavailable");
							this.#promptInFlight = core;
							try {
								await core;
							} finally {
								if (this.#promptInFlight === core) this.#promptInFlight = undefined;
							}
							const promptError = this.agent.state.error;
							if (promptError) {
								turnError = new Error(promptError);
							} else {
								turnError = getAdvisorTurnError(this.#messagesSince(checkpoint));
							}
						} catch (err) {
							turnError = err;
						}

						let disposition: AdvisorTurnDisposition = { kind: "not-applicable" };
						if (this.host.onTurnSettled) {
							try {
								disposition = await Promise.resolve(
									this.host.onTurnSettled(checkpoint, iterationAbort.signal, turnError),
								);
							} catch (settledError) {
								sharedTerminal = true;
								throw settledError;
							}
						}
						if (this.#epoch !== epoch) break;
						reviewHasCommittedRewrite ||= this.#hasCommittedRewrite(checkpoint);

						if (disposition.kind === "continue") {
							if (turnError !== undefined) await this.#discardFailedAttempt(checkpoint);
							if (this.#epoch !== epoch) break;
							const nextCheckpoint = this.#captureCheckpoint();
							if (
								iterationAbort.signal.aborted ||
								(disposition.mode === "auto" && this.#pending.length > 0)
							) {
								this.#queueOwnedContinuation({
									mode: disposition.mode,
									checkpoint: nextCheckpoint,
									epoch,
									finalTurns,
								});
								deferredContinuation = true;
								break;
							}
							continuationMode = disposition.mode;
							checkpoint = nextCheckpoint;
							continue;
						}
						if (disposition.kind === "terminal") {
							sharedTerminal = true;
							throw disposition.error ?? turnError ?? new Error("Advisor context recovery ended");
						}
						if (turnError !== undefined) throw turnError;
						success = true;
						break;
					}
					if (deferredContinuation) continue;
					if (this.#epoch !== epoch) continue;
					this.#seenContextInFlight = undefined;
					this.#hasReviewed = true;
					this.#failing = false;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
					this.#droppedBacklogs = 0;
					this.#consecutiveQuarantines = 0;
					this.#refusalModelsTried.clear();
					if (this.host.onTurnSuccess) {
						try {
							await Promise.resolve(this.host.onTurnSuccess());
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					}
				} catch (err) {
					// A reset invalidates the attempt before any history restoration.
					if (this.#epoch !== epoch) continue;
					reviewHasCommittedRewrite ||= this.#hasCommittedRewrite(checkpoint);
					if (this.#sessionTransitionPaused) {
						if (reviewHasCommittedRewrite || continuationMode !== undefined) {
							await this.#discardFailedAttempt(checkpoint);
							if (this.#epoch !== epoch) continue;
							this.#queueOwnedContinuation({
								mode: "retry",
								checkpoint: this.#captureCheckpoint(),
								epoch,
								finalTurns,
							});
						} else {
							await this.#restoreCheckpoint(checkpoint, "session-transition");
							if (this.#epoch !== epoch) continue;
							this.#pending.unshift(...popped);
						}
						continue;
					}
					if (sharedTerminal) {
						this.#notifyFailureOnce(err);
						this.#notifyTurnAbandoned();
						this.#backlog = Math.max(0, this.#backlog - finalTurns);
						this.#notifyWaiters();
						continue;
					}
					this.#failing = true;
					this.#wakeAllWaiters();
					const failedMessages = this.#messagesSince(checkpoint);
					const terminalFailure = this.#terminalAssistantFailure(failedMessages);
					const rawErrorId = AIError.classify(err);
					const terminalFailureId =
						terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
					const classifierRefusal =
						(terminalFailure !== undefined && isClassifierRefusal(terminalFailure)) ||
						(!AIError.is(rawErrorId, AIError.Flag.AccountPolicy) &&
							AIError.is(rawErrorId, AIError.Flag.ContentBlocked));
					const terminalFailureRetriable =
						terminalFailureId === undefined || AIError.retriable(terminalFailureId);
					const ownsContinuation = reviewHasCommittedRewrite || continuationMode !== undefined;
					if (ownsContinuation) {
						await this.#discardFailedAttempt(checkpoint);
						if (this.#epoch !== epoch) continue;
					} else {
						await this.#restoreCheckpoint(checkpoint, "ordinary-turn-failure");
						if (this.#epoch !== epoch) continue;
					}
					logger.debug("advisor turn failed", { err: String(err) });
					const retryText = this.#formatRawDelta(rawMessages, wip, false) ?? "";
					if (classifierRefusal) {
						if (this.#includeThinking) {
							this.#includeThinking = false;
							// Do NOT advance #seenContext here: the requeued batch is
							// re-deduped by #prepareBatch on the next drain, so a mutation
							// now would double-fold first-time primary context into
							// "(unchanged — still in effect)" on the retry.
							const strippedBatch = this.#formatRawDelta(rawMessages, wip, false);
							if (strippedBatch) {
								if (ownsContinuation) {
									this.#queueOwnedContinuation({
										mode: "retry",
										checkpoint: this.#captureCheckpoint(),
										epoch,
										finalTurns,
									});
								} else {
									this.#pending.unshift({
										text: strippedBatch,
										rawMessages,
										renderRevision: this.#renderRevision,
										turns: finalTurns,
										wip,
									});
								}
								logger.debug("advisor refusal recovered by stripping primary reasoning");
								continue;
							}
						}
						// A refusal that outlives the strip is this model's policy call, not
						// a malformed request, so hand it to the host's model fallback before
						// declaring the advisor dead. The cascade walks the chain to
						// exhaustion (the host returns false once candidates run out); the
						// tried-set only stops a cyclic chain from revisiting a model. The
						// primary turn-recovery path already allows fallback on refusals.
						const refusalModel = this.host.getModelIdentity?.() ?? this.#modelIdentity ?? "";
						let refusalRecovered = false;
						try {
							if (!this.#refusalModelsTried.has(refusalModel)) {
								this.#refusalModelsTried.add(refusalModel);
								refusalRecovered =
									(await Promise.resolve(
										this.host.onTurnError?.(err, failedMessages, iterationAbort.signal),
									)) === true;
							} else {
								logger.debug("advisor refusal chain exhausted", { model: refusalModel });
							}
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed after refusal", { err: String(hookErr) });
						}
						if (this.#epoch !== epoch) continue;
						if (this.#sessionTransitionPaused) {
							if (ownsContinuation) {
								this.#queueOwnedContinuation({
									mode: "retry",
									checkpoint: this.#captureCheckpoint(),
									epoch,
									finalTurns,
								});
							} else {
								this.#pending.unshift(...popped);
							}
							continue;
						}
						if (refusalRecovered) {
							this.#consecutiveFailures = 0;
							this.#failureNotified = false;
							if (ownsContinuation) {
								this.#queueOwnedContinuation({
									mode: "retry",
									checkpoint: this.#captureCheckpoint(),
									epoch,
									finalTurns,
								});
							} else {
								this.#pending.unshift({
									text: retryText,
									rawMessages,
									renderRevision: this.#renderRevision,
									turns: finalTurns,
									wip,
								});
							}
							logger.debug("advisor refusal recovered by model fallback");
							continue;
						}
						// The batch is terminal, so the next primary update is a new
						// refusal cascade and must be allowed to try the chain again.
						this.#refusalModelsTried.clear();
						this.#notifyFailureOnce(err);
						this.#notifyTurnAbandoned();
						this.#clearSeenContext();
						this.#backlog = Math.max(0, this.#backlog - finalTurns);
						this.#notifyWaiters();
						continue;
					}
					let recovered = false;
					try {
						recovered =
							(await Promise.resolve(
								this.host.onTurnError?.(err, failedMessages, iterationAbort.signal),
							)) === true;
					} catch (hookErr) {
						logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
					}
					if (this.#epoch !== epoch) continue;
					if (this.#sessionTransitionPaused) {
						if (ownsContinuation) {
							this.#queueOwnedContinuation({
								mode: "retry",
								checkpoint: this.#captureCheckpoint(),
								epoch,
								finalTurns,
							});
						} else {
							this.#pending.unshift(...popped);
						}
						continue;
					}
					if (err instanceof AdvisorOutputQuarantinedError) {
						// A quarantine discards the advisor's whole turn before dispatch, so
						// its advice never reaches the primary. One re-prime is allowed to
						// recover a one-off hallucination silently; a persistent quarantine
						// loop is a supervision gap the user must see in the main UI — not an
						// unbounded silent retry. Surface it (deduped by #notifyFailureOnce)
						// and drop the batch to break the loop (issue #6661).
						this.#consecutiveQuarantines++;
						if (this.#consecutiveQuarantines >= MAX_QUARANTINE_RETRIES) {
							this.#notifyFailureOnce(err);
							this.#consecutiveQuarantines = 0;
							this.#notifyTurnAbandoned();
							this.#resetAdvisorContext(true, true, "quarantine-retry-exhausted");
							continue;
						}
						const rePrime = this.#pending.length > 0 ? this.#latestMessages : undefined;
						// Wake catchup waiters only when nothing is re-primed; otherwise the
						// re-primed turn restores the backlog and waiters resolve on its completion.
						this.#resetAdvisorContext(true, !rePrime, "quarantine-recovery");
						if (rePrime) this.onTurnEnd(rePrime);
						continue;
					}
					if (recovered) {
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						if (ownsContinuation) {
							this.#queueOwnedContinuation({
								mode: "retry",
								checkpoint: this.#captureCheckpoint(),
								epoch,
								finalTurns,
							});
						} else {
							this.#pending.unshift({
								text: retryText,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
							});
						}
						continue;
					}
					if (AIError.isUsageLimit(err)) {
						// Host recovery (credential switch / fallback chain) declined:
						// pause on the quota latch instead of burning retries — provider
						// quota windows (5h/7d) outlast any retry budget. The batch is
						// requeued and the backlog stays visible so reset() replays it.
						logger.warn("advisor quota exhausted", { err: String(err) });
						this.#quotaExhausted = true;
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#clearSeenContext();
						if (ownsContinuation) {
							this.#queueOwnedContinuation({
								mode: "retry",
								checkpoint: this.#captureCheckpoint(),
								epoch,
								finalTurns,
							});
						} else {
							this.#pending.unshift({
								text: retryText,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
							});
						}
						this.#wakeAllWaiters();
						try {
							this.host.notifyQuotaExhausted?.();
						} catch (notifyErr) {
							logger.warn("advisor quota notification failed", { err: String(notifyErr) });
						}
						break;
					}
					if (!terminalFailureRetriable) {
						logger.warn("advisor terminal failure is non-retriable; dropping bounded batch");
						this.#notifyFailureOnce(err);
						this.#notifyTurnAbandoned();
						this.#consecutiveFailures = 0;
						// The dropped batch may carry primary-context we never delivered; drop
						// the seen-state too so queued raw deltas re-expand before delivery.
						this.#clearSeenContext();
						this.#noteDroppedBacklog(err);
						success = true;
					} else {
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= 3) {
							logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
							this.#notifyFailureOnce(err);
							this.#notifyTurnAbandoned();
							this.#consecutiveFailures = 0;
							// The dropped batch may carry primary-context we never delivered; drop
							// the seen-state too so queued raw deltas re-expand before delivery.
							this.#clearSeenContext();
							this.#noteDroppedBacklog(err);
							success = true;
						} else {
							if (ownsContinuation) {
								this.#queueOwnedContinuation({
									mode: "retry",
									checkpoint: this.#captureCheckpoint(),
									epoch,
									finalTurns,
								});
							} else {
								this.#pending.unshift({
									text: retryText,
									rawMessages,
									renderRevision: this.#renderRevision,
									turns: finalTurns,
									wip,
								});
							}
							if (this.retryDelayMs <= 0) {
								await Bun.sleep(0);
							} else {
								try {
									await raceWithSignal(Bun.sleep(this.retryDelayMs), iterationAbort.signal);
								} catch (sleepError) {
									if (!iterationAbort.signal.aborted) throw sleepError;
								}
							}
						}
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#iterationAbort = undefined;
			this.#busy = false;
			// Notify on EVERY path that lands the runtime in the yielded state —
			// not just an empty backlog. The quota branch requeues the failed
			// batch (backlog/pending stay non-empty) yet `yielded` is true via
			// the quota latch, and the eye must close without waiting for an
			// unrelated repaint. Same for halt.
			if (!this.disposed && this.yielded) {
				try {
					this.host.notifyIdle?.();
				} catch (err) {
					logger.debug("advisor idle notification failed", { err: String(err) });
				}
			}
		}
	}
}

/** Mirrors turn recovery's refusal classification without treating account eligibility as a model refusal. */
function isClassifierRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const id = AIError.classifyMessage(message);
	if (AIError.is(id, AIError.Flag.AccountPolicy)) return false;
	const stopType = message.stopDetails?.type;
	if (stopType === "refusal" || stopType === "sensitive") return true;
	return AIError.is(id, AIError.Flag.ContentBlocked);
}

/**
 * The only malformed advisor turn shape: the prompt resolved but produced no
 * assistant response at all. Everything an assistant message carries — advice,
 * reasoning, or deliberate silence (empty `stop`) — is a completed review.
 */
function getAdvisorTurnError(messages: readonly AgentMessage[]): Error | undefined {
	if (messages.length === 0) return undefined;
	if (messages.some(message => message.role === "assistant")) return undefined;
	return new Error("Advisor turn ended without an assistant response");
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(
	obfuscator: SecretObfuscator,
	content: TextualContent,
	sharedRegexSecretValues: ReadonlySet<string>,
): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content, sharedRegexSecretValues);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(
	obfuscator: SecretObfuscator,
	message: AssistantMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscator.obfuscate(block.thinking, sharedRegexSecretValues);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments, sharedRegexSecretValues);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
	sharedRegexSecretValues: ReadonlySet<string>,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details, sharedRegexSecretValues);
}

function obfuscateAdvisorMessage(
	obfuscator: SecretObfuscator,
	message: AgentMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(
				obfuscator,
				message.content as TextualContent,
				sharedRegexSecretValues,
			);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
				isError?: boolean;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content, sharedRegexSecretValues);
			let details = msg.details;
			if (typeof details?.diff === "string") {
				const diff = obfuscator.obfuscate(details.diff, sharedRegexSecretValues);
				if (diff !== details.diff) details = { ...details, diff };
			}
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(
				obfuscator,
				message as AssistantMessage,
				sharedRegexSecretValues,
			) as AgentMessage;
		case "custom":
		case "hookMessage": {
			if (!formatSessionHistoryMarkdown([message], { expandPrimaryContext: true }).trim()) return message;
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content, sharedRegexSecretValues);
			const details = obfuscateDetails(obfuscator, msg.details, sharedRegexSecretValues);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string };
			const command = obfuscator.obfuscate(formatExecutionSourcePreview(msg.command), sharedRegexSecretValues);
			return command === msg.command ? message : ({ ...(message as object), command } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string };
			const code = obfuscator.obfuscate(formatExecutionSourcePreview(msg.code), sharedRegexSecretValues);
			return code === msg.code ? message : ({ ...(message as object), code } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path, sharedRegexSecretValues);
				if (path === file.path) return file;
				changed = true;
				return { ...file, path };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function scrubAdvisorHistory(
	obfuscator: SecretObfuscator,
	messages: AgentMessage[],
	sharedRegexSecretValues: Set<string>,
): boolean {
	const previousSize = sharedRegexSecretValues.size;
	// Collect across the entire history first: redacting a search-only regex
	// value would otherwise erase the evidence needed to scrub an earlier prefix.
	for (const message of messages) {
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "assistant" ||
			message.role === "compactionSummary"
		) {
			collectNativeReplayRegexSecretValues(obfuscator, message, sharedRegexSecretValues);
		}
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const replay =
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "assistant" ||
			message.role === "compactionSummary"
				? obfuscateNativeReplay(obfuscator, message, sharedRegexSecretValues)
				: message;
		const next = obfuscateAdvisorMessage(obfuscator, replay, sharedRegexSecretValues);
		if (next !== message) messages[index] = next;
	}
	return sharedRegexSecretValues.size !== previousSize;
}
