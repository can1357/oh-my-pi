import type { LineRange } from "./path-utils";
import { parseLineRanges, parseTailCount } from "./path-utils";
import { ToolError } from "./tool-errors";
/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "image" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
	/** `:-N` — the last N lines. Needs the source's line count before it can be sliced. */
	| { kind: "tail"; count: number; raw?: boolean };

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
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

/**
 * Pin a `:-N` tail selector to absolute lines against a source of `totalLines`
 * lines; every other selector passes through unchanged. The last N lines become
 * one inclusive range clamped to the source (`totalLines - N + 1` .. `totalLines`),
 * so downstream slicing, context expansion, and out-of-bounds reporting behave
 * exactly as for an explicit `:N-M`.
 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ResolvedSelector {
	if (parsed.kind !== "tail") return parsed;
	const startLine = Math.max(1, totalLines - parsed.count + 1);
	return { kind: "lines", ranges: [{ startLine, endLine: Math.max(startLine, totalLines) }], raw: parsed.raw };
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

/** Parse a bare (non-compound) chunk as a line-range list or a tail count. */
function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
	const ranges = parseLineRanges(chunk);
	if (ranges) return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
	const count = parseTailCount(chunk);
	if (count !== null) return raw ? { kind: "tail", count, raw } : { kind: "tail", count };
	return null;
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
