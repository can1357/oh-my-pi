import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments } from "../secrets/message-transform";
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
	reset(): void;
	/**
	 * Drop messages appended past `count`. Called after a failed `prompt()` so a
	 * retry doesn't replay the failed user batch + synthetic assistant-error
	 * turn `Agent.#runLoop` records on its internal state.
	 */
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor must clear its own context before sending the current
	 * incremental update. The cursor stays at the current primary position: this
	 * recovery path must never replay the full primary transcript.
	 *
	 * Takes the pending update as a message rather than a token count: sizing it
	 * needs the advisor model's tokenizer, which the host owns.
	 * Optional: hosts that omit it get no proactive maintenance.
	 */
	maintainContext?(incoming: AgentMessage, signal: AbortSignal): Promise<boolean>;
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
 * Replaces an advisor assistant turn that requested unavailable tools or generated
 * output-only destructive directives with a sanitized error before dispatch.
 *
 * The agent loop records assistant turns before dispatching tools. Without this
 * pre-dispatch rewrite, an advisor hallucination can leave unrelated text in the
 * advisor transcript even though the action itself never executes.
 */
export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		// Cursor exec-channel native blocks (bash/read/grep/...) are stamped
		// kCursorExecResolved: they already ran server-side through the
		// advisor-scoped CursorExecHandlers bridge, which rejects ungranted
		// tools in-band ("Tool not available") and lets the model self-correct.
		// Quarantining them would discard the legitimate advise emitted in the
		// same turn (issue #5900). The scoped bridge is the grant gate here, not
		// this pre-dispatch check.
		if (
			block.type === "toolCall" &&
			!availableToolNames.has(block.name) &&
			(block as CursorExecResolvedCarrier)[kCursorExecResolved] !== true
		) {
			unavailableToolNames.add(block.name);
		}
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
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
	overflowRecovery?: boolean;
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
	#promptInFlight: Promise<void> | undefined;
	#iterationAbort: AbortController | undefined;
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
			(this.#hasReviewed && !this.#busy && this.#backlog === 0 && this.#pending.length === 0)
		);
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
		let rendered: Omit<PendingDelta, "turns" | "overflowRecovery"> | null = null;
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
			void this.#drain();
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

	#clearAdvisorContextAtCurrentCursor(): void {
		this.#consecutiveFailures = 0;
		this.#clearSeenContext();
		try {
			this.agent.reset();
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
		this.#deliveredPrefix = [];
		this.#pending = [];
		this.#clearAdvisorContextAtCurrentCursor();
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

	/** Stop new advisor work and wait only for the active prompt's recorder-visible events. */
	pauseForSessionTransition(): Promise<void> {
		if (!this.#sessionTransitionPaused) {
			this.#sessionTransitionPaused = true;
			this.#wakeAllWaiters();
			this.#iterationAbort?.abort("advisor session transition");
			try {
				this.agent.abort("advisor session transition");
			} catch {}
		}
		return (
			this.#promptInFlight?.then(
				() => {},
				() => {},
			) ?? Promise.resolve()
		);
	}

	/** Continue queued work after a session transition rolls back or preserves the conversation. */
	resumeAfterSessionTransition(): void {
		if (!this.#sessionTransitionPaused) return;
		this.#sessionTransitionPaused = false;
		if (!this.#quotaExhausted && !this.#halted) void this.#drain();
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
	 * primary-context custom messages and the rendered markdown, scrub the
	 * advisor's own history, and refresh pending placeholder prefixes when new
	 * secrets appear. Returns whether new secret values were discovered.
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
		scrubAdvisorHistory(obfuscator, this.agent.state.messages, this.#advisorRegexSecretValues);
		if (discoveredNewRegexSecretValue) {
			this.#pending = this.#pending.map(delta => ({
				...delta,
				text: obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(delta.text, this.#advisorRegexSecretValues),
			}));
		}
		return discoveredNewRegexSecretValue;
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

	#renderDelta(messages?: AgentMessage[], wip = false): Omit<PendingDelta, "turns" | "overflowRecovery"> | null {
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

	/**
	 * Drop the user batch + synthetic assistant-error turn `Agent.#runLoop`
	 * appended for a failed prompt so a retry replays a clean baseline and the
	 * dropped-after-3 path never leaks orphan failures into the next successful
	 * run. Prefers the agent's own `rollbackTo` (which also re-syncs its
	 * append-only context); falls back to truncating `state.messages` for tests
	 * that hand-roll a minimal facade.
	 */
	#restoreSeenContextInFlight(): void {
		if (!this.#seenContextInFlight) return;
		this.#seenContext.clear();
		for (const [key, value] of this.#seenContextInFlight) this.#seenContext.set(key, value);
		this.#seenContextInFlight = undefined;
	}

	#rollbackFailedTurn(snapshot: number): void {
		// Restore the primary-context dedup map to its pre-batch state: the
		// failed turn never reached the advisor, so first-time context collapsed
		// to "(unchanged…)" by this batch's #prepareBatch must expand again on
		// the retry/requeue pass.
		this.#restoreSeenContextInFlight();
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	/**
	 * Collect the popped deltas into one batch, running `maintainContext` for
	 * correct token budgeting. Loops until the pending queue is stable (no new
	 * deltas arrived during a maintenance check) or the round cap is reached.
	 * Every `await` inside the loop has an epoch guard so a reset/dispose
	 * mid-await cannot leak a stale batch into the post-reset conversation.
	 *
	 * When maintenance requests recovery, only the advisor Agent/log is reset
	 * (at the current primary cursor) and the already-collected raw batch is
	 * re-rendered — older, already-delivered primary transcript is never
	 * replayed.
	 *
	 * The coalescing loop is capped at {@link MAX_COALESCE_ROUNDS} iterations so
	 * a pathologically fast primary combined with a slow `maintainContext` cannot
	 * stall dispatch indefinitely — any items still in `#pending` after the cap
	 * are left for the next drain iteration. Overflow-recovery batches skip
	 * coalescing entirely: they retry exactly the bounded batch that overflowed.
	 *
	 * Returns `null` when the epoch was invalidated — caller should `continue`.
	 */
	async #collectAndMaintainBatch(
		epoch: number,
		initial: PendingDelta[],
		recoveringOverflow: boolean,
		signal: AbortSignal,
	): Promise<{
		batch: string | null;
		rawMessages: AgentMessage[];
		preparedMessages: AgentMessage[];
		finalTurns: number;
		wip: boolean;
		resetContext: boolean;
	} | null> {
		let batchText = initial.map(b => b.text).join("\n\n");
		let rawMessages = initial.flatMap(b => b.rawMessages);
		let turns = initial.reduce((sum, b) => sum + b.turns, 0);
		// Track WIP state of the most recent delta — forwarded to the re-render
		// so a willContinue:true turn keeps its [in progress] heading. Also
		// returned to #drain so the retry-requeue path preserves it on failed turns.
		let wip = initial.at(-1)?.wip ?? false;

		for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
			if (this.#sessionTransitionPaused) break;
			if (this.host.maintainContext) {
				let shouldResetContext = false;
				try {
					shouldResetContext = await this.host.maintainContext(
						{ role: "user", content: batchText, timestamp: Date.now() },
						signal,
					);
				} catch (err) {
					logger.debug("advisor context maintenance failed", { err: String(err) });
				}
				// Epoch guard — a reset/dispose during the maintainContext await
				// invalidates this batch.
				if (this.#epoch !== epoch) return null;

				if (shouldResetContext) {
					// Once coalescing has begun (round > 0), deltas that arrived during
					// this await are part of the coalescing window: tally them so
					// finalTurns stays accurate for backlog accounting and their raw
					// messages join the bounded re-render. On the initial round the
					// popped batch stays bounded exactly as dispatched — later arrivals
					// remain queued and ship as their own subsequent batch.
					if (round > 0) {
						const lateItems = this.#pending.splice(0);
						initial.push(...lateItems);
						turns += lateItems.reduce((sum, b) => sum + b.turns, 0);
						if (lateItems.length > 0) {
							wip = lateItems.at(-1)!.wip;
							rawMessages = rawMessages.concat(lateItems.flatMap(b => b.rawMessages));
						}
					}
					// Reset only the advisor Agent/log. The primary cursor, backlog,
					// waiters, latest snapshot, and epoch stay untouched. Re-render only
					// this already-popped raw batch so active plan/reference bodies are
					// restored without replaying any older primary transcript.
					logger.debug("advisor context reset", {
						reason: "context-maintenance",
						lastCount: this.#lastCount,
						pending: this.#pending.length,
						backlog: this.#backlog,
					});
					this.#clearAdvisorContextAtCurrentCursor();
					const { batch: rerendered, preparedMessages } = this.#prepareBatch(rawMessages, wip, batchText);
					return {
						batch: rerendered ?? (batchText || null),
						rawMessages,
						preparedMessages,
						finalTurns: turns,
						wip,
						resetContext: true,
					};
				}
			}

			// Overflow-recovery batches retry exactly the bounded batch that
			// overflowed; pending updates stay queued behind them.
			if (recoveringOverflow) break;

			// On the final round stop here — any late arrivals would ship without
			// a subsequent maintainContext budget check. Leave them in #pending for
			// the next drain iteration where they will be properly budgeted.
			if (round === MAX_COALESCE_ROUNDS - 1) break;

			// Coalesce any deltas that arrived while we were awaiting maintenance.
			// If none arrived the batch is stable and we're done; otherwise merge,
			// update WIP state, and re-check the maintenance budget.
			const late = this.#pending.splice(0);
			if (late.length === 0) break;
			initial.push(...late);
			batchText = [batchText, ...late.map(b => b.text)].join("\n\n");
			rawMessages = rawMessages.concat(late.flatMap(b => b.rawMessages));
			turns += late.reduce((sum, b) => sum + b.turns, 0);
			wip = late.at(-1)!.wip;
		}

		// Prepare the deduped view AFTER coalescing (rawMessages is complete by
		// now): filters advisor custom messages and collapses re-injected
		// primary-context to "(unchanged…)". BOTH the single-block text and the
		// multi-message split derive from this exact list so they never diverge.
		const { batch: preparedBatch, preparedMessages } = this.#prepareBatch(rawMessages, wip, batchText);
		return {
			batch: preparedBatch ?? (batchText || null),
			rawMessages,
			preparedMessages,
			finalTurns: turns,
			wip,
			resetContext: false,
		};
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

	#terminalAssistantFailure(snapshot: number): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= snapshot; i--) {
			const message = messages[i];
			if (message.role === "assistant" && message.stopReason === "error") return message;
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

	async #drain(): Promise<void> {
		if (this.#busy || this.#sessionTransitionPaused) return;
		this.#busy = true;
		try {
			this.#syncModelIdentity();
			while (!this.disposed && !this.#sessionTransitionPaused && this.#pending.length) {
				this.#syncModelIdentity();
				let popped: PendingDelta[];
				if (this.#pending[0]?.overflowRecovery) {
					const recovery = this.#pending.shift();
					if (!recovery) continue;
					popped = [recovery];
				} else {
					popped = this.#pending.splice(0);
				}
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
				const recoveringOverflow = popped.some(delta => delta.overflowRecovery === true);
				const result = await this.#collectAndMaintainBatch(
					epoch,
					popped,
					recoveringOverflow,
					iterationAbort.signal,
				);

				// Epoch was invalidated during batch collection; restart the loop.
				if (result === null) continue;
				if (this.#sessionTransitionPaused) {
					this.#restoreSeenContextInFlight();
					this.#pending.unshift(...popped);
					continue;
				}

				const { batch, rawMessages, preparedMessages, finalTurns, wip, resetContext } = result;

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn Agent.#runLoop
				// appends to internal state. Without this, a retry would replay the failed
				// batch on top of stale turns and the dropped-after-3 path would leak
				// orphan failures into the next successful run's context.
				const messageSnapshot = this.agent.state.messages.length;
				const contextWasFresh = resetContext || recoveringOverflow || messageSnapshot === 0;
				try {
					this.host.beginAdvisorUpdate?.(wip);
					// Candidate 4 (multi-message split): deliver the Session update as
					// multiple user messages so the provider prompt cache can
					// incrementally hit each appended message (cache_read grows with
					// the session instead of staying pinned at the instructions/tools
					// boundary). Falls back to the single-block string when the chunk
					// renderer cannot split (e.g. empty delta). The split is
					// byte-equivalent to the old single-block render (equivalence
					// tested), so the advisor sees identical context.
					const splitMessages = this.#formatRawDeltaMessageChunks(preparedMessages, wip);
					const promptInput: string | AgentMessage[] = splitMessages ?? batch;
					const prompt = this.agent.prompt(promptInput);
					this.#promptInFlight = prompt;
					try {
						await prompt;
					} finally {
						if (this.#promptInFlight === prompt) this.#promptInFlight = undefined;
					}
					// Agent.#runLoop catches provider/stream failures internally and
					// resolves prompt() cleanly with stopReason: "error". Treat that
					// as a failed turn so endpoint rejections trip the retry path.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					// A content-less stop is a deliberate silent review — the documented
					// verifier behavior ("prefer silence when the agent is on track") — and
					// completes the turn. Sessions can legitimately have nothing to advise
					// on for any number of consecutive turns, so silence is never warned
					// about (#5216 did, spamming "Advisor unavailable" at quiet models).
					const turnError = getAdvisorTurnError(this.agent.state.messages.slice(messageSnapshot));
					if (turnError) throw turnError;
					success = true;
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
							await raceWithSignal(Promise.resolve(this.host.onTurnSuccess()), iterationAbort.signal);
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					}
				} catch (err) {
					if (this.#sessionTransitionPaused) {
						this.#rollbackFailedTurn(messageSnapshot);
						this.#pending.unshift(...popped);
						continue;
					}
					// reset()/dispose() aborts the in-flight prompt; treat it as a
					// reset, not a transient failure — drop the stale batch.
					if (this.#epoch !== epoch) continue;
					// Release any parked primary-agent waiters IMMEDIATELY — before
					// the async onTurnError hook or any retry sleep — and refuse new
					// parks until a turn succeeds. A failing advisor must never hold
					// the primary on the catch-up gate.
					this.#failing = true;
					this.#wakeAllWaiters();
					const failedMessages = this.agent.state.messages.slice(messageSnapshot);
					const terminalFailure = this.#terminalAssistantFailure(messageSnapshot);
					const rawErrorId = AIError.classify(err);
					const terminalFailureId =
						terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
					const classifierRefusal =
						(terminalFailure !== undefined && isClassifierRefusal(terminalFailure)) ||
						(!AIError.is(rawErrorId, AIError.Flag.AccountPolicy) &&
							AIError.is(rawErrorId, AIError.Flag.ContentBlocked));
					const contextOverflow =
						(terminalFailureId !== undefined && AIError.is(terminalFailureId, AIError.Flag.ContextOverflow)) ||
						AIError.is(rawErrorId, AIError.Flag.ContextOverflow);
					// A terminal provider failure that is neither retriable nor an
					// overflow (e.g. a blocked prompt) will fail identically on every
					// retry — classify it before rollback so the batch is dropped after
					// one attempt instead of burning the 3-attempt budget (#5468).
					const terminalFailureRetriable =
						terminalFailureId === undefined ||
						AIError.retriable(terminalFailureId) ||
						AIError.is(terminalFailureId, AIError.Flag.ContextOverflow);
					this.#rollbackFailedTurn(messageSnapshot);
					logger.debug("advisor turn failed", { err: String(err) });
					if (classifierRefusal) {
						if (this.#includeThinking) {
							this.#includeThinking = false;
							// Do NOT advance #seenContext here: the requeued batch is
							// re-deduped by #prepareBatch on the next drain, so a mutation
							// now would double-fold first-time primary context into
							// "(unchanged — still in effect)" on the retry.
							const strippedBatch = this.#formatRawDelta(rawMessages, wip, false);
							if (strippedBatch) {
								this.#pending.unshift({
									text: strippedBatch,
									rawMessages,
									renderRevision: this.#renderRevision,
									turns: finalTurns,
									wip,
									overflowRecovery: recoveringOverflow || undefined,
								});
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
									(await raceWithSignal(
										Promise.resolve(this.host.onTurnError?.(err, failedMessages, iterationAbort.signal)),
										iterationAbort.signal,
									)) === true;
							} else {
								logger.debug("advisor refusal chain exhausted", { model: refusalModel });
							}
						} catch (hookErr) {
							logger.debug("advisor onTurnError hook failed after refusal", { err: String(hookErr) });
						}
						if (this.#epoch !== epoch) continue;
						if (this.#sessionTransitionPaused) {
							this.#pending.unshift(...popped);
							continue;
						}
						if (refusalRecovered) {
							this.#consecutiveFailures = 0;
							this.#failureNotified = false;
							this.#pending.unshift({
								text: batch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: recoveringOverflow || undefined,
							});
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
							(await raceWithSignal(
								Promise.resolve(this.host.onTurnError?.(err, failedMessages, iterationAbort.signal)),
								iterationAbort.signal,
							)) === true;
					} catch (hookErr) {
						logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
					}
					if (this.#sessionTransitionPaused) {
						this.#pending.unshift(...popped);
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
					// Epoch guard after the async error hook.
					if (this.#epoch !== epoch) continue;
					if (recovered) {
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
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
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
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
					} else if (contextOverflow) {
						this.#clearAdvisorContextAtCurrentCursor();
						if (contextWasFresh) {
							// The bounded update cannot fit even with no advisor history. Drop
							// only this batch after its one fresh-context retry; pending and later
							// deltas remain eligible so one oversized update cannot disable the advisor.
							logger.warn("advisor update overflowed a fresh context; dropping bounded batch");
							this.#notifyFailureOnce(err);
							this.#notifyTurnAbandoned();
							success = true;
						} else {
							// Retry once against the fresh advisor context, using only the same
							// bounded raw batch. Pending updates remain queued behind it.
							// Same double-fold guard as the refusal branch: #prepareBatch
							// re-dedups on retry, so this preview render must not mutate
							// #seenContext.
							const recoveryBatch = this.#formatRawDelta(rawMessages, wip, false) ?? batch;
							this.#pending.unshift({
								text: recoveryBatch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: true,
							});
							logger.debug("advisor context overflow recovered at current primary cursor");
						}
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
							this.#pending.unshift({
								text: batch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: recoveringOverflow || undefined,
							});
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
	sharedRegexSecretValues: ReadonlySet<string>,
): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const next = obfuscateAdvisorMessage(obfuscator, message, sharedRegexSecretValues);
		if (next !== message) messages[index] = next;
	}
}
