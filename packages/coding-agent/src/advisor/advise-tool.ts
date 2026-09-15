import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, logger } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import { AdvisorEmissionGuard, type AdvisorSuppressionReason, normalizeAdvisorNote } from "./emission-guard";

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` always rides the non-interrupting aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no queued
 *   work, a late `concern` is preserved as a visible card instead of waking the
 *   primary to restate completion. A `blocker` is the exception: it means the
 *   agent handed off broken or unexercised work, so it still steers a triggered
 *   turn to force the primary to acknowledge and continue before the turn is
 *   considered done (#5628) — deferring it to the next user turn is the bug.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further `concern` notes are
 *   downgraded to asides; preservation still wins. A `blocker` is exempt: it
 *   means the agent handed off broken or unexercised work, so it still steers a
 *   triggered turn even right after a prior interrupt (#5628).
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * The tools an advisor receives by default when its config omits `tools` — the
 * read-only investigative set. The full available pool is every built tool the
 * session has (the advisor is a full agent); a config's `tools` selects from it.
 * The runtime build additionally admits `recall` into the default set when the
 * active memory backend built it (hindsight/mnemopi).
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

function advisorNoteDedupeKey(note: string): string {
	return normalizeAdvisorNote(note);
}

/** Rank advisor severities so the dedupe state can detect a real escalation
 *  (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 *  `nit` because the schema treats an omitted severity as a plain nit. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * Live admission: the guard accepted the note and handed it to the session's
 * delivery routing. That is the whole truthful claim — `onAdvice` is
 * synchronous void and MAY only buffer the note for a terminal-boundary flush
 * or preserve it as a card; no actual send or consumption acknowledgment
 * exists at this layer.
 */
const ADVISOR_ACK_SENT = "Accepted for primary delivery.";

/**
 * Deferred admission: the note holds a reservation behind an in-progress
 * primary turn and flushes automatically when the turn completes. The promise
 * is conditional on priority: a strictly-higher-severity note from the SAME
 * review may still displace it at a full budget. Truthful for both a fresh
 * reservation and a re-raise of an already-queued note.
 */
const ADVISOR_ACK_DEFERRED =
	"Deferred — primary is mid-turn; this note is queued for automatic delivery when the turn completes, " +
	"unless a higher-severity note from the same review displaces it. Do not re-raise the same point.";

/**
 * Rejections, keyed by the guard's suppression reason. A suppressed note is
 * never described as recorded, queued, or scheduled for delivery — the
 * advisor learns the note was dropped and why, so a rate-limited note is not
 * mislabeled a duplicate and a dropped deferred note is never promised.
 */
const ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string> = {
	empty: "Not recorded — empty note.",
	noise: "Not recorded — the note carries no concrete, actionable content.",
	duplicate: "Duplicate advice ignored — this point was already raised.",
	"rate-limit": "Not recorded — this update's non-blocker advice budget is spent; the note was dropped.",
};

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/**
	 * Single admission authority for every emission. The tool owns no parallel
	 * dedupe/budget state: the guard's {@link AdvisorAdmission} decides whether
	 * a note routes, holds pending, or is suppressed — and names any displaced
	 * pending note.
	 */
	readonly #guard: AdvisorEmissionGuard;
	#inProgressUpdate = false;
	/** Notes admitted but withheld while the primary was mid-turn, in arrival
	 *  order. Flushed deterministically at the completed-update transition or an
	 *  explicit {@link flushDeferredNotes}, so delivery does not depend on the
	 *  advisor model choosing to re-raise (it may not — the deferred
	 *  acknowledgment tells it the note is queued). Only these still-pending
	 *  notes can be displaced by the guard; routed notes are never retracted. */
	#deferredNotes: {
		key: string;
		note: string;
		severity?: AdviseDetails["severity"];
	}[] = [];

	/**
	 * @param onAdvice Route an admitted note to the primary (channel selection +
	 *   delivery). Never re-filters — the note already cleared the guard.
	 * @param guard The admission authority: noise/empty/dedupe filter, rank-aware
	 *   escalation, and the per-update non-blocker budget, decided the moment a
	 *   note is emitted (live or deferred). Defaults to a stock
	 *   {@link AdvisorEmissionGuard} (default budget
	 *   {@link ADVISOR_DEFAULT_BUDGET_PER_UPDATE}).
	 */
	constructor(
		private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void,
		guard?: AdvisorEmissionGuard,
	) {
		this.#guard = guard ?? new AdvisorEmissionGuard();
	}

	/**
	 * Start one advisor update: resets the guard's per-update budget and marks
	 * whether the update reviews an in-progress primary turn. Non-blockers
	 * emitted while in progress are withheld so partial work does not interrupt
	 * the primary before it can finish its planned steps. Transitioning to a
	 * completed update flushes the withheld backlog, oldest first — each note
	 * was admitted when emitted, so the flush routes without re-admission and a
	 * backlog of one note per originating update reaches the primary intact.
	 */
	beginUpdate(inProgress: boolean): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = inProgress;
		this.#guard.beginUpdate();
		if (wasInProgress && !inProgress) this.#flushDeferred();
	}

	/**
	 * Mark the primary no longer mid-turn and flush the withheld backlog
	 * WITHOUT starting a new advisor update or resetting the guard's budget.
	 * Called at the primary's terminal boundary (final yield), where no advisor
	 * review follows but reserved notes must still reach the primary. Flushed
	 * notes stay charged to their originating update as routed deliveries.
	 */
	flushDeferredNotes(): void {
		this.#inProgressUpdate = false;
		this.#flushDeferred();
	}

	/** Clear all note state when the advisor starts a fresh conversation: the
	 *  guard's dedupe/budget memory and this tool's pending backlog reset
	 *  together, so a re-primed advisor can re-raise old issues. */
	resetDeliveredNotes(): void {
		this.#guard.reset();
		this.#inProgressUpdate = false;
		this.#deferredNotes = [];
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		const rank = advisorSeverityRank(args.severity);
		const key = advisorNoteDedupeKey(args.note);
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			// Withheld, not delivered: reserve for the deterministic flush at the
			// completed-update transition / terminal boundary.
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (pending) {
				// Re-raise of a still-queued note is not a new admission: escalate
				// severity in place (never a second slot) and keep the dedupe rank
				// coherent so equal/lower repeats of the text stay suppressed.
				if (rank > advisorSeverityRank(pending.severity)) {
					pending.severity = args.severity;
					this.#guard.escalatePending(args.note, rank);
				}
				return this.#result(ADVISOR_ACK_DEFERRED, args);
			}
			const decision = this.#guard.admit(args.note, { rank, pending: true });
			if (!decision.accepted) return this.#suppressed(args, decision.reason);
			// The guard centrally names the still-pending note displaced by this
			// strictly-higher-severity admission; only same-update pending notes
			// can be displaced, so the backlog lookup is a drop, not a policy.
			if (decision.displacedKey !== undefined) {
				const displacedIndex = this.#deferredNotes.findIndex(item => item.key === decision.displacedKey);
				if (displacedIndex !== -1) this.#deferredNotes.splice(displacedIndex, 1);
			}
			this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			return this.#result(ADVISOR_ACK_DEFERRED, args);
		}
		// Live path (completed update, or a blocker that must interrupt now). A
		// blocker re-raise of a still-queued note pulls the reservation first:
		// the guard admits it as a rank escalation (nit/concern → blocker), so
		// it interrupts at blocker severity now instead of arriving late at the
		// lower deferred severity.
		const reservedIndex = this.#deferredNotes.findIndex(item => item.key === key);
		if (reservedIndex !== -1) this.#deferredNotes.splice(reservedIndex, 1);
		const decision = this.#guard.admit(args.note, { rank, pending: false });
		if (!decision.accepted) return this.#suppressed(args, decision.reason);
		this.onAdvice(args.note, args.severity);
		return this.#result(ADVISOR_ACK_SENT, args);
	}

	/** Route every withheld note, oldest first, without re-admission — each was
	 *  admitted when emitted. Routed notes are marked so their originating
	 *  update's slots stay charged and can no longer be displaced. */
	#flushDeferred(): void {
		if (this.#deferredNotes.length === 0) return;
		const pending = this.#deferredNotes;
		this.#deferredNotes = [];
		for (const { note, severity } of pending) {
			this.#guard.markRouted(note);
			this.onAdvice(note, severity);
		}
	}

	/** Truthful suppression acknowledgment keyed by the guard's reason: a
	 *  rejected note is never described as recorded, queued, or delivered. */
	#suppressed(args: AdviseParams, reason: AdvisorSuppressionReason | undefined): AgentToolResult<AdviseDetails> {
		logger.debug("advisor advice suppressed by emission guard", { reason, severity: args.severity });
		return this.#result(ADVISOR_ACK_SUPPRESSED[reason ?? "duplicate"], args);
	}

	#result(text: string, args: AdviseParams): AgentToolResult<AdviseDetails> {
		return {
			content: [{ type: "text", text }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
