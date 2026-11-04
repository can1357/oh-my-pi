/**
 * Which models actually produced a subagent's answer, for the `<served-by>`
 * line of its `<task-result>` envelope.
 *
 * The question a parent needs answered is not "which model was configured" —
 * a result's `resolvedModel` already carries the latest attribution —
 * but "which models wrote the turns I am about to read", and in what order. A
 * run whose primary died and whose fallback finished the work reads exactly
 * like a clean run otherwise, so a parent that dispatched a cross-family
 * reviewer cannot tell that it got a same-family one.
 *
 * **Only assistant turns count.** A subagent's transcript also records model
 * calls that are not part of its answer: title generation and title-drift
 * judgments, async-job captions and widget authoring, the completion probe,
 * cache warms, composer predictions. Every one of those is written through
 * `SessionManager.appendModelUsage` as a `model-usage` journal row, never as a
 * message, and none of them runs on the session's own agent loop — so none
 * reaches the executor's event stream as an assistant `message_end`. Advisors
 * are the same: an advisor is a separate agent with its own recorder, and what
 * it contributes to the primary session is a `role: "custom"` card. The filter
 * here is therefore structural — an assistant `message_end` on this session's
 * own stream — not a denylist of helper model ids, which is why reading the raw
 * transcript reports models the run never answered on and this does not.
 *
 * **A turn that failed is not a turn.** A candidate model that errors, aborts,
 * or stops empty on its first request produced none of the run's output;
 * crediting it would invent a model change that never happened. The test is
 * {@link assistantTurnProducedOutput}, the same predicate the live session uses
 * to decide when a fallback has "served", so this line and the session's own
 * fallback badge can never disagree.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ServedModelTurns } from "@oh-my-pi/pi-tui/tools/task";
import { assistantTurnProducedOutput } from "../session/messages";

/** The assistant-message fields attribution reads. */
type ServedTurn = Pick<AssistantMessage, "provider" | "model" | "upstreamModel" | "stopReason" | "content">;

/**
 * Longest model label rendered, and the characters allowed in one. Provider ids
 * and model ids are upstream-controlled strings that land inside an XML-ish
 * element a model reads, so they are reduced to the shape a model id actually
 * has rather than trusted and escaped.
 *
 * This is a RENDERING step and must never decide identity. Both reductions lose
 * information — `a(v1)` and `a[v1]` reduce to the same text, and two ids that
 * agree on their first {@link MODEL_LABEL_MAX} characters reduce to the same
 * text — so counting by the label merges two models into one and reports no
 * change for exactly the run this line exists to expose. The tally therefore
 * keys on the identity the provider reported, and the label is applied only on
 * the way out.
 */
const MODEL_LABEL_MAX = 120;
const UNSAFE_LABEL_CHARS = /[^\w./:@+-]+/gu;

function label(value: string): string {
	const cleaned = value.replace(UNSAFE_LABEL_CHARS, "_");
	return cleaned.length > MODEL_LABEL_MAX ? cleaned.slice(0, MODEL_LABEL_MAX) : cleaned;
}

/**
 * Attribution key for one assistant turn: `<provider>/<id>` exactly as the
 * message reported them, plus `→<served>` when the provider named a different
 * model as the one that answered. A gateway handing a request to something
 * other than the id it was asked for is part of what this line exists to
 * expose, so it must not collapse into the requested id.
 */
export function servedModelKey(message: Pick<ServedTurn, "provider" | "model" | "upstreamModel">): string {
	const requested = `${message.provider}/${message.model}`;
	const upstream = message.upstreamModel;
	if (!upstream || upstream === message.model) return requested;
	return `${requested}→${upstream}`;
}

/** One tally entry rendered safe for the envelope, without merging two identities. */
function renderEntry({ model, turns }: ServedModelTurns): string {
	return `${label(model)} (${turns} ${turns === 1 ? "turn" : "turns"})`;
}

/** Per-model assistant-turn counts for one run, in the order each model first served. */
export class ServedModelTally {
	// Insertion order is service order, which is what makes a mid-run model
	// change readable as "A then B" instead of an unordered set.
	readonly #turns = new Map<string, number>();

	/**
	 * Count an assistant `message_end`; a turn that produced no output is not
	 * credited. Returns whether this turn changed the tally, so a caller can
	 * take a fresh {@link snapshot} only when there is something new to take.
	 */
	record(message: ServedTurn): boolean {
		if (!assistantTurnProducedOutput(message)) return false;
		const key = servedModelKey(message);
		this.#turns.set(key, (this.#turns.get(key) ?? 0) + 1);
		return true;
	}

	/** Served models in service order, or `undefined` when nothing served. */
	snapshot(): ServedModelTurns[] | undefined {
		if (this.#turns.size === 0) return undefined;
		return Array.from(this.#turns, ([model, turns]) => ({ model, turns }));
	}
}

/**
 * Stated when a result carries no attribution, so an absent line never means
 * "one model, fine". It says the attribution is missing, not that no model
 * answered: a result built off the normal settle path — a worker lost mid-run,
 * a run restored from a transcript — can carry no tally even though turns were
 * produced, and claiming none were is a false statement about the run rather
 * than an admission of ignorance.
 */
export const SERVED_BY_UNKNOWN = "unknown (no model attribution on this result)";

/**
 * The `<served-by>` body: one `<model> (<n> turns)` per model that served, in
 * service order, joined by `→`. Reports {@link SERVED_BY_UNKNOWN} rather than
 * nothing when the result carries no tally — a missing line would otherwise
 * mean both "single model" and "no idea".
 */
export function formatServedBy(served: readonly ServedModelTurns[] | undefined): string {
	if (!served || served.length === 0) return SERVED_BY_UNKNOWN;
	return served.map(renderEntry).join(" → ");
}

/** Whether the run changed model partway, i.e. more than one model produced turns. */
export function servedModelChanged(served: readonly ServedModelTurns[] | undefined): boolean {
	return (served?.length ?? 0) > 1;
}
