import type { LineRange } from "@oh-my-pi/pi-tui/tools/line-ranges";
import { parseTailCount } from "./path-utils";
import { mergeLineRanges, parseLineRanges } from "@oh-my-pi/pi-tui/tools/line-ranges";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "image" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
	/**
	 * `:-N` — the last N lines. Needs the source's line count before it can be sliced.
	 * `ranges` holds the other chunks of a comma list that mixes them in (`:1-12,-15`).
	 */
	| { kind: "tail"; count: number; ranges?: [LineRange, ...LineRange[]]; raw?: boolean };

/**
 * A selector whose bounds are absolute — every kind except `tail`. Slicing
 * helpers take this type so a tail selector cannot silently read from the head;
 * callers convert with {@link resolveTailSelector} once the line count is known.
 */
export type ResolvedSelector = Exclude<ParsedSelector, { kind: "tail" }>;

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || ((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return (
		(parsed.kind === "lines" && parsed.ranges.length > 1) || (parsed.kind === "tail" && parsed.ranges !== undefined)
	);
}

/**
 * Pin a `:-N` tail selector to absolute lines against a source of `totalLines`
 * lines; every other selector passes through unchanged. The last N lines become
 * one inclusive range clamped to the source (`totalLines - N + 1` .. `totalLines`),
 * so downstream slicing, context expansion, and out-of-bounds reporting behave
 * exactly as for an explicit `:N-M`. Ranges listed with the tail join it in
 * ascending order, merged where they overlap or touch.
 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ResolvedSelector {
	if (parsed.kind !== "tail") return parsed;
	const startLine = Math.max(1, totalLines - parsed.count + 1);
	const endLine = Math.max(startLine, totalLines);
	if (!parsed.ranges) return { kind: "lines", ranges: [{ startLine, endLine }], raw: parsed.raw };
	return { kind: "lines", ranges: mergeLineRanges([...parsed.ranges, { startLine, endLine }]), raw: parsed.raw };
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" ||
		lower === "conflicts" ||
		lower === "img" ||
		/^-\d+(?:[-+]\d+)?$/.test(chunk) ||
		parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), a comma-separated list of ranges, :raw, :img for SVG rendering, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

/** Parse a bare (non-compound) chunk as a line-range list, a tail count, or a list mixing both. */
function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
	const ranges = parseLineRanges(chunk, raw ? "single" : "onward");
	if (ranges) return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
	// A list with tails (`1-12,-15`, `-15`) keeps the longest tail; in a list of
	// several chunks a bare `N` stays that one line, as in a plain range list.
	const parts = chunk.split(",");
	let count = 0;
	const listed: string[] = [];
	for (const part of parts) {
		const partCount = parseTailCount(part);
		if (partCount !== null) count = Math.max(count, partCount);
		else listed.push(part);
	}
	if (count === 0) return null;
	// Beside a tail the list has several chunks, so a lone listed `N` is still one line.
	const listedRanges = listed.length > 0 ? parseLineRanges(listed.join(","), "single") : undefined;
	if (listedRanges === null) return null;
	return { kind: "tail", count, ...(listedRanges && { ranges: listedRanges }), ...(raw && { raw }) };
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw`, `raw:1-50`, or `raw:-60`. Split into chunks
	// and accept exactly one line range (possibly multi) or tail plus the literal
	// `raw`. Selector-like compounds that are not in that accepted set are invalid
	// rather than "none"; otherwise `read` can silently widen a malformed selector
	// like `artifact://5:conflicts:1-1` while `grep` rejects it.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const parsed = parseRangeOrTail(rangeChunk, true);
				if (parsed) return parsed;
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	if (sel.toLowerCase() === "img") return { kind: "image" };
	const parsed = parseRangeOrTail(sel, false);
	if (parsed) return parsed;
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
export function selToOffsetLimit(parsed: ResolvedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}
