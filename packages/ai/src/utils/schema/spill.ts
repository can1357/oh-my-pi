import type { JsonObject } from "./types";

export type DescriptionSpillFormat = "spill" | "paren";

function formatSpillValue(value: unknown): string {
	return JSON.stringify(value);
}

function formatParenValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Demote stripped JSON Schema keywords into a node's `description` so the model
 * still receives the constraint as natural-language context after the wire
 * schema drops it.
 */
export function spillToDescription(
	node: JsonObject,
	entries: ReadonlyArray<readonly [string, unknown]>,
	format: DescriptionSpillFormat = "spill",
): void {
	let spilled: Array<readonly [string, unknown]> | undefined;
	for (const entry of entries) {
		if (entry[1] === undefined) continue;
		if (spilled === undefined) spilled = [];
		spilled.push(entry);
	}
	if (spilled === undefined || spilled.length === 0) return;

	const existing = typeof node.description === "string" ? node.description : "";
	if (format === "paren") {
		let suffix = "";
		for (const [key, value] of spilled) {
			suffix += ` (${key}: ${formatParenValue(value)})`;
		}
		node.description = `${existing}${suffix}`;
		return;
	}

	const formatted = `{${spilled.map(([key, value]) => `${key}: ${formatSpillValue(value)}`).join(", ")}}`;
	node.description = existing ? `${existing}\n\n${formatted}` : formatted;
}
