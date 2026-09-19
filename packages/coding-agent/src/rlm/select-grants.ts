import type { RlmHit, RlmStore } from "./store";
import type { RlmGrant } from "./view";

/** Deterministic range policy for search → grant selection (no learned router). */
export interface RlmGrantSelectPolicy {
	/** Max literal/regex matches kept (default 4). */
	maxMatches?: number;
	/** Characters of context on each side of a match (default 512). */
	contextChars?: number;
	/** Hard cap on total UTF-8 bytes across merged grants (default 8192). */
	maxTotalBytes?: number;
	/** Search mode (default literal). */
	mode?: "literal" | "regex";
}

export interface RlmSelectedHit extends RlmHit {
	pattern: string;
	matchEnd: number;
}

export interface RlmGrantSelectResult {
	grants: RlmGrant[];
	hits: RlmSelectedHit[];
	/** UTF-8 bytes after merge + cap. */
	grantedBytes: number;
	/** True when maxTotalBytes forced dropping or shrinking ranges. */
	truncated: boolean;
	/** True when no patterns matched. */
	empty: boolean;
}

interface Range {
	start: number;
	end: number;
}

const DEFAULT_MAX_MATCHES = 4;
const DEFAULT_CONTEXT_CHARS = 512;
const DEFAULT_MAX_TOTAL_BYTES = 8_192;

/**
 * Build grant ranges from top-N search hits:
 * top matches → ± context → merge overlaps → hard total byte cap.
 *
 * Does **not** default to the first 8 KiB of the handle.
 */
export function selectGrantsFromSearch(
	store: RlmStore,
	handle: string,
	patterns: string | readonly string[],
	policy?: RlmGrantSelectPolicy,
): RlmGrantSelectResult {
	const maxMatches = policy?.maxMatches ?? DEFAULT_MAX_MATCHES;
	const contextChars = Math.max(0, policy?.contextChars ?? DEFAULT_CONTEXT_CHARS);
	const maxTotalBytes = Math.max(1, policy?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
	const mode = policy?.mode ?? "literal";
	const list = (Array.isArray(patterns) ? patterns : [patterns])
		.map(p => p.trim())
		.filter(p => p.length > 0);

	const record = store.get(handle);
	if (!record) {
		throw new Error(`unknown rlm handle: ${handle}`);
	}
	const body = record.text;
	const bodyLen = body.length;

	const hits: RlmSelectedHit[] = [];
	if (list.length === 0) {
		return { grants: [], hits, grantedBytes: 0, truncated: false, empty: true };
	}

	// Collect hits across patterns; stable order = pattern order then index.
	for (const pattern of list) {
		const found = store.search(handle, pattern, maxMatches, mode);
		for (const hit of found) {
			const matchEnd =
				mode === "literal" ? hit.index + pattern.length : hit.index + Math.max(1, hit.text.length - 80);
			// Prefer citation span when present: rlm://h/id[start:end]
			const cited = hit.citation.match(/\[(\d+):(\d+)\]$/);
			const end = cited ? Number(cited[2]) : matchEnd;
			hits.push({
				...hit,
				pattern,
				matchEnd: end,
			});
		}
	}

	// Deduplicate identical match starts; keep earliest pattern order.
	hits.sort((a, b) => a.index - b.index || a.pattern.localeCompare(b.pattern));
	const deduped: RlmSelectedHit[] = [];
	const seenStarts = new Set<number>();
	for (const hit of hits) {
		if (seenStarts.has(hit.index)) continue;
		seenStarts.add(hit.index);
		deduped.push(hit);
		if (deduped.length >= maxMatches) break;
	}

	if (deduped.length === 0) {
		store.note("select-grants", `handle=${handle} empty patterns=${list.join("|")}`);
		return { grants: [], hits: deduped, grantedBytes: 0, truncated: false, empty: true };
	}

	// Expand ± context.
	let ranges: Range[] = deduped.map(hit => ({
		start: Math.max(0, hit.index - contextChars),
		end: Math.min(bodyLen, hit.matchEnd + contextChars),
	}));

	ranges = mergeRanges(ranges);

	// Enforce total byte cap: keep leading ranges (document order), shrink last if needed.
	const capped = capRangesByBytes(body, ranges, maxTotalBytes);
	const grants: RlmGrant[] = capped.ranges.map(r => ({
		handle,
		start: r.start,
		end: r.end,
	}));
	// search() already increments metrics.searches per pattern.

	store.note(
		"select-grants",
		`handle=${handle} hits=${deduped.length} grants=${grants.length} bytes=${capped.bytes}${capped.truncated ? " truncated" : ""}`,
	);


	return {
		grants,
		hits: deduped,
		grantedBytes: capped.bytes,
		truncated: capped.truncated,
		empty: false,
	};
}

/** Merge overlapping / adjacent [start,end) ranges. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Range[] = [{ ...sorted[0]! }];
	for (let i = 1; i < sorted.length; i++) {
		const cur = sorted[i]!;
		const last = out[out.length - 1]!;
		if (cur.start <= last.end) {
			last.end = Math.max(last.end, cur.end);
		} else {
			out.push({ ...cur });
		}
	}
	return out;
}

function capRangesByBytes(
	body: string,
	ranges: readonly Range[],
	maxTotalBytes: number,
): { ranges: Range[]; bytes: number; truncated: boolean } {
	const kept: Range[] = [];
	let total = 0;
	let truncated = false;

	for (const range of ranges) {
		const slice = body.slice(range.start, range.end);
		const bytes = Buffer.byteLength(slice, "utf8");
		if (total + bytes <= maxTotalBytes) {
			kept.push({ ...range });
			total += bytes;
			continue;
		}
		const remaining = maxTotalBytes - total;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		// Shrink from the end so match start stays in grant when possible.
		const shrunk = shrinkToBytes(body, range.start, range.end, remaining);
		if (shrunk) {
			kept.push(shrunk);
			total += Buffer.byteLength(body.slice(shrunk.start, shrunk.end), "utf8");
		}
		truncated = true;
		break;
	}

	return { ranges: kept, bytes: total, truncated };
}

function shrinkToBytes(body: string, start: number, end: number, maxBytes: number): Range | null {
	if (maxBytes <= 0 || start >= end) return null;
	let lo = start;
	let hi = end;
	// Binary-search end so UTF-8 bytes of body[start:end] ≤ maxBytes.
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		const bytes = Buffer.byteLength(body.slice(start, mid), "utf8");
		if (bytes <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	if (lo <= start) {
		// Even one char may exceed — take empty failure.
		const one = body.slice(start, start + 1);
		if (Buffer.byteLength(one, "utf8") > maxBytes) return null;
		return { start, end: start + 1 };
	}
	return { start, end: lo };
}

/** Parse `start:end,start:end` grant range list for a single handle. */
export function parseGrantRanges(handle: string, ranges: string | undefined): RlmGrant[] {
	if (!ranges?.trim()) return [];
	const grants: RlmGrant[] = [];
	for (const part of ranges.split(/[\s,]+/)) {
		const m = /^(\d+):(\d+)$/.exec(part.trim());
		if (!m) continue;
		const start = Number(m[1]);
		const end = Number(m[2]);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
		grants.push({ handle, start, end });
	}
	return grants;
}
