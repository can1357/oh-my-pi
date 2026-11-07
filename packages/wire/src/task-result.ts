/**
 * Missing-yield provenance of a settled `task` result.
 *
 * A structured subagent that ends without calling `yield` gets a mark on its
 * result: `"initial"` for its first run, `"wake"` for a parent-owned follow-up
 * turn. The executor then writes the warning as the output's first paragraph.
 */
export type MissingYield = "initial" | "wake";

/** Whether `value` (a JSON field read off the wire) is a missing-yield mark. */
export function isMissingYield(value: unknown): value is MissingYield {
	return value === "initial" || value === "wake";
}

/**
 * Split a result's output into its missing-yield warning and the report after
 * it. The mark decides, not the warning text: an unmarked output, or a marked
 * one whose first paragraph is blank, comes back whole as `rest`.
 */
export function splitMissingYieldWarning(output: string, missingYield: unknown): { warning?: string; rest: string } {
	if (!isMissingYield(missingYield)) return { rest: output };
	const end = output.indexOf("\n\n");
	const warning = (end < 0 ? output : output.slice(0, end)).trim();
	if (!warning) return { rest: output };
	return { warning, rest: end < 0 ? "" : output.slice(end + 2) };
}
