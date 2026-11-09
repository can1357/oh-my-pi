/**
 * A blank `model` is absence, not a selector: callers that emit JSON pad optional
 * strings with `""`, and whitespace alone names no model.
 */
export function normalizeModelSelector<T>(model: T): T | undefined {
	return typeof model === "string" && model.trim() === "" ? undefined : model;
}
