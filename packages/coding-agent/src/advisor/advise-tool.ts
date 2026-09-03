import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import { normalizeAdvisorNote } from "./emission-guard";

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

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/** Highest delivered severity rank per normalized note. A new call passes
	 *  through only when its rank strictly exceeds the recorded one (a real
	 *  escalation: nit → concern → blocker), so an advisor cannot bypass dedupe
	 *  by retagging the same text at a lower or equal severity. */
	#deliveredNoteSeverities = new Map<string, number>();
	#inProgressUpdate = false;
	/** Notes withheld while the primary was mid-turn, in arrival order. Flushed
	 *  deterministically on the first `beginUpdate(false)` so delivery does not
	 *  depend on the advisor model choosing to re-raise (it may not, since the
	 *  tool previously returned "Recorded." for a note that was never routed).
	 *  Cleared on `resetDeliveredNotes` alongside the delivered-rank map. */
	#deferredNotes: { key: string; note: string; severity?: AdviseDetails["severity"] }[] = [];

	/**
	 * @param onAdvice Route an accepted note to the primary (channel selection +
	 *   delivery). Never re-filters — the note already cleared `accept`.
	 * @param accept The emission guard's noise/empty/dedupe filter plus the
	 *   one-advise-per-update budget, consumed the moment a note is emitted
	 *   (live or deferred). A suppressed note returns `false` without spending
	 *   the budget, so it cannot burn an update's slot ahead of a real concern.
	 *   Defaults to always-accept for standalone use/tests without a guard.
	 */
	constructor(
		private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void,
		private readonly accept: (note: string) => boolean = () => true,
	) {}

	/**
	 * Mark whether the next advisor prompt reviews an in-progress primary turn.
	 * Non-blockers are withheld until a completed update so partial work does
	 * not interrupt the primary before it can finish its planned steps.
	 */
	beginUpdate(inProgress: boolean): void {
		const wasInProgress = this.#inProgressUpdate;
		this.#inProgressUpdate = inProgress;
		// Turn just completed: flush everything withheld mid-turn, oldest first.
		// Each note already cleared the emission guard (filter + per-update budget)
		// when it was reserved, so the flush routes it without re-accepting — a
		// backlog of one note per originating update reaches the primary intact.
		if (wasInProgress && !inProgress && this.#deferredNotes.length > 0) {
			const pending = this.#deferredNotes;
			this.#deferredNotes = [];
			for (const { note, severity } of pending) this.#deliver(note, severity, true);
		}
	}

	/** Clear delivered-note memory when the advisor starts a fresh conversation. */
	resetDeliveredNotes(): void {
		this.#deliveredNoteSeverities.clear();
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
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			// Withheld, not delivered: queue for the deterministic flush on the next
			// completed update. Skip if an identical note is already pending so a
			// long mid-turn can't pile up 20 copies of the same advice. Tell the
			// advisor the truth — the previous "Recorded." made it believe the note
			// reached the primary, so it never re-raised and the advice was lost.
			const key = advisorNoteDedupeKey(args.note);
			const pending = this.#deferredNotes.find(item => item.key === key);
			if (pending) {
				// Escalating an already-queued note reuses its slot; never a new one.
				if (advisorSeverityRank(args.severity) > advisorSeverityRank(pending.severity))
					pending.severity = args.severity;
			} else if (this.accept(args.note)) {
				// Reserve the update's one slot now (the emission guard filters noise
				// and enforces the per-update budget at the moment the note is emitted,
				// exactly like the live path); hold it for the flush. A suppressed or
				// over-budget note fails `accept` here and is dropped without a slot.
				this.#deferredNotes.push({ key, note: args.note, severity: args.severity });
			}
			return {
				content: [
					{
						type: "text",
						text: "Deferred — primary is mid-turn; this note will be delivered automatically when the turn completes. Do not re-raise the same point.",
					},
				],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		// Live path (completed update, or a blocker that must interrupt now). If the
		// note already holds a deferred reservation, it cleared the emission guard
		// when reserved — pull it from the backlog and deliver without re-accepting,
		// so a blocker escalation of a still-queued nit/concern interrupts at its
		// blocker severity instead of being rejected as already-seen and arriving
		// late at the lower deferred severity.
		const key = advisorNoteDedupeKey(args.note);
		const reservedIndex = this.#deferredNotes.findIndex(item => item.key === key);
		if (reservedIndex !== -1) this.#deferredNotes.splice(reservedIndex, 1);
		const delivered = this.#deliver(args.note, args.severity, reservedIndex !== -1);
		return {
			content: [{ type: "text", text: delivered ? "Recorded." : "Duplicate advice ignored." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}

	/** Run one note through the escalation-rank dedupe and, if it passes, route it
	 *  to the primary. Returns true when the note was actually delivered. Shared by
	 *  the live path (`execute`) and the deferred flush (`beginUpdate(false)`). */
	#deliver(note: string, severity?: AdviseDetails["severity"], alreadyAccepted = false): boolean {
		const key = advisorNoteDedupeKey(note);
		const rank = advisorSeverityRank(severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (rank <= previousRank) return false;
		// Live notes clear the emission guard here; deferred notes already cleared
		// it when reserved, so the flush passes `alreadyAccepted` to avoid a second
		// (budget-consuming, dedupe-rejecting) pass.
		if (!alreadyAccepted && !this.accept(note)) return false;
		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(note, severity);
		return true;
	}
}
