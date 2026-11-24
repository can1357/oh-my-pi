import { ToolError } from "../tool-errors";

/** A `select()` choice as the model writes it: a string (value, then label) or exactly one of label, value or index. */
export type SelectOptionInput = string | { label: string } | { value: string } | { index: number };

/** A validated choice, the shape the page-side matchers (Chromium, Tern's page kit, cmux) consume. */
export type SelectOptionChoice =
	| { kind: "string" | "label" | "value"; value: string }
	| { kind: "index"; value: number };

/**
 * Validate `select()` choices before any element is looked up; throws `ToolError` on an object that is not exactly
 * `{label: string}`, `{value: string}` or `{index: non-negative integer}`. `coercePrimitives` keeps Tern's and cmux's
 * `String()` of other non-object choices.
 */
export function normalizeSelectOptions(
	values: readonly unknown[],
	options?: { coercePrimitives: boolean },
): SelectOptionChoice[] {
	return values.map(value => {
		if (typeof value === "string") return { kind: "string", value };
		// Tern and cmux have always stringified non-object choices.
		if (options?.coercePrimitives && (value === null || typeof value !== "object")) {
			return { kind: "string", value: String(value) };
		}
		if (value && typeof value === "object") {
			const keys = Object.keys(value);
			const key = keys.length === 1 ? keys[0] : undefined;
			if (key === "label" && "label" in value && typeof value.label === "string") {
				return { kind: "label", value: value.label };
			}
			if (key === "value" && "value" in value && typeof value.value === "string") {
				return { kind: "value", value: value.value };
			}
			if (
				key === "index" &&
				"index" in value &&
				typeof value.index === "number" &&
				Number.isInteger(value.index) &&
				value.index >= 0
			) {
				return { kind: "index", value: value.index };
			}
		}
		throw new ToolError(
			"select() expects strings, {label: string}, {value: string}, or {index: non-negative integer}",
		);
	});
}
