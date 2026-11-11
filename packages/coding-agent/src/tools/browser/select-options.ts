import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

export type SelectOptionInput = string | { label: string } | { value: string } | { index: number };

export type SelectOptionChoice =
	| { kind: "string" | "label" | "value"; value: string }
	| { kind: "index"; value: number };

export function normalizeSelectOptions(values: readonly unknown[]): SelectOptionChoice[] {
	return values.map(value => {
		if (typeof value === "string") return { kind: "string", value };
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
