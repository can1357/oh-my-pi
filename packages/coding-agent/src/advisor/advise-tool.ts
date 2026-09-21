import { type } from "@oh-my-pi/omptype";
import { type AdvisorSeverity, type AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";
export { type AdvisorSeverity, type AdvisorNote, type AdvisorMessageDetails } from "@oh-my-pi/pi-tui/chat/messages";
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

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
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
 * Whether a note at this severity may wake or interrupt the primary. A
 * `blocker` steers even into a streaming turn; a `concern` only wakes an idle
 * mid-work primary and is subject to the immune-turn window; a plain `nit`
 * never does. A streaming primary receives concerns and nits as next-step
 * asides.
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
 * - The aside channel is only used while the primary loop is live — streaming
 *   and not aborting — because that is the only time the loop polls
 *   `getAsideMessages` again; a note parked any other time would strand. A
 *   live loop therefore receives a `nit` or a `concern` as a next-step aside
 *   and is never interrupted by a concern; only a `blocker` still steers into
 *   the live turn.
 * - Once the loop is idle a `nit` is preserved as a visible card. A `concern`
 *   after a terminal answer with no queued work is preserved instead of waking
 *   the primary to restate completion; a `concern` after a mid-work yield
 *   steers a triggered turn so the advice is acted on immediately. A `blocker`
 *   always steers a triggered turn: it means the agent handed off broken or
 *   unexercised work, so the primary must acknowledge and continue before the
 *   turn is considered done (#5628) — deferring it to the next user turn is
 *   the bug.
 * - The user-interrupt guard is unchanged: after a deliberate user interrupt
 *   (`autoResumeSuppressed`) the advisor must not auto-resume the stopped run.
 *   While the agent is idle — or still tearing the interrupted turn down
 *   (`aborting`) — the note is preserved as a visible card instead of
 *   restarting the run. But once a turn is actively streaming again (a resume
 *   the user already drove), steering the note in does NOT auto-resume
 *   anything, so it is delivered live. Parking it during an active run instead
 *   strands it (it never reaches the running agent) and the withheld notes
 *   dump as one burst at the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window an idle `concern` is
 *   preserved as a visible card instead of triggering a turn (a streaming one
 *   still rides the aside queue); a `blocker` remains exempt and still steers
 *   a triggered turn even right after a prior interrupt (#5628).
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
	const live = opts.streaming && !opts.aborting;
	if (!isInterruptingSeverity(opts.severity)) return live ? "aside" : "preserve";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (live && opts.severity !== "blocker") return "aside";
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return "preserve";
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

/** Rank advisor severities so the dedupe state can detect a real escalation
 *  (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 *  `nit` because the schema treats an omitted severity as a plain nit. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };

/** Admission acks: one line each — the advisor needs the verdict, not a policy essay. */
const ADVISOR_ACK_SENT = "Delivered.";
/** Held behind the in-progress primary turn; flushed when it completes. */
const ADVISOR_ACK_DEFERRED = "Queued for the end of the turn. Do not re-raise.";
/** A suppressed note is never described as recorded or queued. */
const ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string> = {
	empty: "Dropped: empty note.",
	noise: "Dropped: nothing actionable.",
	duplicate: "Dropped: already raised.",
	"rate-limit": "Dropped: this update's advice budget is spent.",
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
	/** Nits admitted but withheld while the primary was mid-turn, in arrival
	 *  order. Concerns and blockers route immediately. Flushed at the completed
	 *  update transition or an explicit {@link flushDeferredNotes}; only these
	 *  still-pending notes can be displaced by the guard. Routed notes are never
	 *  retracted. */
	#deferredNotes: { key: string; note: string; severity?: AdviseDetails["severity"] }[] = [];

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
	 * whether the update reviews an in-progress primary turn. Only nits are
	 * withheld so partial work is not nitpicked; concerns and blockers route
	 * immediately. Transitioning to a completed update flushes the backlog,
	 * oldest first, without re-admission: each nit was admitted when emitted.
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
		const rank = ADVISOR_SEVERITY_RANK[args.severity ?? "nit"];
		const key = normalizeAdvisorNote(args.note);
		const defer = this.#inProgressUpdate && rank === ADVISOR_SEVERITY_RANK.nit;
		// A nit already holding a reservation needs no second admission, even if
		// its key has aged out of the guard's bounded history.
		if (defer && this.#deferredNotes.some(item => item.key === key)) {
			return this.#result(ADVISOR_ACK_DEFERRED, args);
		}
		const decision = this.#guard.admit(args.note, { rank, pending: defer });
		if (!decision.accepted) return this.#suppressed(args, decision.reason);
		if (decision.displacedKey !== undefined) this.#removeDeferredNote(decision.displacedKey);
		if (defer) {
			this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			return this.#result(ADVISOR_ACK_DEFERRED, args);
		}
		// Drop a reservation only after admission succeeds: an escalation from
		// an older update can be rate-limited without losing the original nit.
		this.#removeDeferredNote(key);
		// Same-update nit → concern reuses its slot. It is now routed, so a later
		// blocker escalation must not refund that non-blocker delivery's budget.
		this.#guard.markRouted(args.note);
		this.onAdvice(args.note, args.severity);
		return this.#result(ADVISOR_ACK_SENT, args);
	}

	#removeDeferredNote(key: string): void {
		const index = this.#deferredNotes.findIndex(item => item.key === key);
		if (index !== -1) this.#deferredNotes.splice(index, 1);
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
