import type { LineRange } from "./path-utils";
import { parseLineRanges } from "./path-utils";
import { ToolError } from "./tool-errors";
/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "image" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
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
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, :img for SVG rendering, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`. Split into chunks and accept
	// exactly one line range (possibly multi) plus the literal `raw`. Selector-like
	// compounds that are not in that accepted set are invalid rather than "none";
	// otherwise `read` can silently widen a malformed selector like
	// `artifact://5:conflicts:1-1` while `grep` rejects it.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const ranges = parseLineRanges(rangeChunk);
				if (ranges) {
					return { kind: "lines", ranges, raw: true };
				}
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	if (sel.toLowerCase() === "img") return { kind: "image" };
	const ranges = parseLineRanges(sel);
	if (ranges) {
		return { kind: "lines", ranges };
	}
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}
