/**
 * "+Nk" turn token-budget directive.
 *
 * A standalone `+<number>[k|m]` token in the user's message sets a per-turn
 * output-token budget surfaced by the `eval` `budget` helper. By default it is
 * ADVISORY — the model self-limits via `budget.remaining()`. Append `!`
 * (`+500k!`) to make it a HARD ceiling: eval `agent()` refuses to spawn once the
 * turn's spend reaches it. Matching is anchored to token boundaries so it does
 * not fire on prices or version strings embedded in prose.
 */

// Number, optional k/m multiplier, optional `!` hard marker, bounded by whitespace/string edges.
const TURN_BUDGET = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])?(!)?(?=\s|$)/i;

export interface TurnBudget {
	/** Output-token ceiling for the turn. */
	total: number;
	/** Whether the ceiling is enforced (eval `agent()` throws past it) vs advisory. */
	hard: boolean;
}

/** Parse a `+Nk`/`+N`/`+Nm`(`!`) turn-budget directive from `text`, or null when absent. */
export function parseTurnBudget(text: string): TurnBudget | null {
	const match = TURN_BUDGET.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2]?.toLowerCase();
	const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1;
	return { total: Math.round(value * multiplier), hard: match[3] === "!" };
}
