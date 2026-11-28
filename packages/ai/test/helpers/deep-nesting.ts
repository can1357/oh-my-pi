/**
 * Values nested deeper than code that recurses can walk. A tool's arguments and
 * its result are any JSON, and a session line holds what `JSON.parse` reads
 * (millions of levels), while a recursive walk stops near 22,000 and Bun's
 * `JSON.stringify` near 40,000. This file imports nothing, so a test may also
 * bundle it for the browser.
 */

/**
 * Levels past what a recursive walk (about 22,000) and `JSON.stringify`
 * (40,000) reach; `JSON.parse` reads millions.
 */
export const DEEP_LEVELS = 50_000;

/** `{ next: … }` nested `levels` levels around `bottom`. */
export function nestedChain(
	bottom: Record<string, unknown> = { leaf: "bottom" },
	levels = DEEP_LEVELS,
): Record<string, unknown> {
	let node = bottom;
	for (let level = 0; level < levels; level++) node = { next: node };
	return node;
}

/**
 * The compact JSON text of {@link nestedChain}`(bottom, levels)`, written
 * without `JSON.stringify`, which stops near 40,000 levels.
 */
export function nestedChainJson(bottom: Record<string, unknown> = { leaf: "bottom" }, levels = DEEP_LEVELS): string {
	return `${'{"next":'.repeat(levels)}${JSON.stringify(bottom)}${"}".repeat(levels)}`;
}

/** How many `next` levels `value` nests, and the value at the bottom. */
export function nestingOf(value: unknown): { levels: number; bottom: unknown } {
	let levels = 0;
	let node = value;
	while (typeof node === "object" && node !== null && "next" in node) {
		node = node.next;
		levels++;
	}
	return { levels, bottom: node };
}
