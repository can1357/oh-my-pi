import type { JsonRecord, JsonValue, SecretObfuscator } from "./obfuscator";
import {
	lookupFriendlyPlaceholderAlias,
	PLACEHOLDER_RE,
	type RegexScanSegment,
	type ReplaceRegexScan,
	resumePlaceholderScanAfterRejectedCandidate,
} from "./placeholder";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// Like the untracked walk, but threads a parallel `origin` tag string through:
// preserved placeholder spans keep their existing origin tag (so a
// same-call-fresh "F" placeholder is never relabeled prior-call "I", and vice
// versa), while `transform`'s output — always freshly generated or redacted
// content in both callers below — is tagged "I" (it must not be re-matched as
// though it arrived in the input, mirroring plain-secret replacement tagging).
export function transformOutsidePlaceholdersTracked(
	text: string,
	origin: string,
	shouldSkipPlaceholder: (placeholder: string) => boolean,
	transform: (chunk: string) => string,
	preservePlaceholder?: (placeholder: string) => string,
): { text: string; origin: string } {
	PLACEHOLDER_RE.lastIndex = 0;
	let result = "";
	let resultOrigin = "";
	let pendingIndex = 0;
	for (;;) {
		const match = PLACEHOLDER_RE.exec(text);
		if (match === null) break;
		if (!shouldSkipPlaceholder(match[0])) {
			resumePlaceholderScanAfterRejectedCandidate(match);
			continue;
		}
		const transformed = transform(text.slice(pendingIndex, match.index));
		result += transformed;
		resultOrigin += "I".repeat(transformed.length);
		const preserved = preservePlaceholder ? preservePlaceholder(match[0]) : match[0];
		result += preserved;
		resultOrigin += origin.slice(match.index, match.index + match[0].length);
		pendingIndex = match.index + match[0].length;
	}
	const trailing = transform(text.slice(pendingIndex));
	result += trailing;
	resultOrigin += "I".repeat(trailing.length);
	return { text: result, origin: resultOrigin };
}

export function trailingOutsidePreservedPlaceholderChunk(
	text: string,
	shouldPreservePlaceholder: (placeholder: string) => boolean,
): string {
	PLACEHOLDER_RE.lastIndex = 0;
	let pendingIndex = 0;
	let sawPlaceholder = false;
	for (;;) {
		const match = PLACEHOLDER_RE.exec(text);
		if (match === null) break;
		if (!shouldPreservePlaceholder(match[0])) {
			resumePlaceholderScanAfterRejectedCandidate(match);
			continue;
		}
		sawPlaceholder = true;
		pendingIndex = match.index + match[0].length;
	}
	return sawPlaceholder ? text.slice(pendingIndex) : "";
}

export function buildReplaceRegexScan(
	text: string,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): ReplaceRegexScan {
	let scanText = "";
	let cursor = 0;
	const segments: RegexScanSegment[] = [];
	const appendSegment = (
		value: string,
		textStart: number,
		textEnd: number,
		generatedPlaceholder: boolean,
		recursive: boolean,
	) => {
		if (value.length === 0) return;
		const scanStart = scanText.length;
		scanText += value;
		segments.push({
			scanStart,
			scanEnd: scanStart + value.length,
			textStart,
			textEnd,
			generatedPlaceholder,
			recursive,
		});
	};

	for (const range of ranges) {
		appendSegment(text.slice(cursor, range.start), cursor, range.start, false, false);
		const placeholder = text.slice(range.start, range.end);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		appendSegment(mapping?.secret ?? placeholder, range.start, range.end, true, mapping?.recursive ?? false);
		cursor = range.end;
	}
	appendSegment(text.slice(cursor), cursor, text.length, false, false);

	return { text: scanText, segments };
}

export function mapReplaceRegexMatch(
	segments: ReadonlyArray<RegexScanSegment>,
	scanStart: number,
	scanEnd: number,
): {
	start: number;
	end: number;
	recursive: boolean;
	preserveGeneratedPlaceholders: boolean;
	partialPlaceholderCut: boolean;
	cutResumeIndex: number;
	firstPlaceholderScanStart: number;
} {
	const startSegment = findScanSegment(segments, scanStart);
	const endSegment = findScanSegment(segments, scanEnd - 1);
	const start = startSegment.generatedPlaceholder
		? startSegment.textStart
		: startSegment.textStart + (scanStart - startSegment.scanStart);
	const end = endSegment.generatedPlaceholder
		? endSegment.textEnd
		: endSegment.textStart + (scanEnd - endSegment.scanStart);
	// A match boundary that falls strictly inside a generated placeholder's
	// expanded value cuts the underlying secret: the snap above pulls the span out
	// to the whole `#…#` token, so the obfuscate path can leave it alone instead of
	// consuming a partial placeholder expansion.
	const partialPlaceholderCut =
		(startSegment.generatedPlaceholder && scanStart > startSegment.scanStart) ||
		(endSegment.generatedPlaceholder && scanEnd < endSegment.scanEnd);
	let recursive = false;
	let preserveGeneratedPlaceholders = false;
	// When the match straddles a placeholder, resume scanning just past the last
	// overlapping placeholder so trailing wholly-outside content (e.g. an 8-char
	// run after the secret) still gets matched instead of being consumed by the
	// straddling span. `firstPlaceholderScanStart` marks where the leading
	// wholly-outside prefix ends, so a prefix that independently matches can be
	// redacted on its own rather than skipped along with the cut span.
	let cutResumeIndex = scanStart;
	let firstPlaceholderScanStart = -1;
	for (const segment of segments) {
		if (segment.scanStart >= scanEnd || segment.scanEnd <= scanStart) continue;
		recursive ||= segment.recursive;
		preserveGeneratedPlaceholders ||= segment.generatedPlaceholder;
		if (segment.generatedPlaceholder) {
			if (firstPlaceholderScanStart === -1) firstPlaceholderScanStart = segment.scanStart;
			if (segment.scanEnd > cutResumeIndex) cutResumeIndex = segment.scanEnd;
		}
	}
	return {
		start,
		end,
		recursive,
		preserveGeneratedPlaceholders,
		partialPlaceholderCut,
		cutResumeIndex,
		firstPlaceholderScanStart,
	};
}

function findScanSegment(segments: ReadonlyArray<RegexScanSegment>, scanIndex: number): RegexScanSegment {
	for (const segment of segments) {
		if (scanIndex >= segment.scanStart && scanIndex < segment.scanEnd) return segment;
	}
	throw new Error("regex match did not map to source text");
}

/**
 * Extend a scan-space resume position past a consecutive run of generated
 * placeholder segments starting exactly at it, with no raw gap in between. A
 * cut-resolution resume point that happens to land precisely on the START of
 * ANOTHER placeholder must not stop there and hand it to a fresh `regex.exec`
 * attempt — the same content, scanned as an opaque adjacent placeholder run,
 * must resolve identically whether the run's LEADING member is still raw text
 * (this call is about to placeholder it) or is ALREADY a placeholder from a
 * prior call or an earlier pass of this same call. Without this, a bounded
 * regex whose reach spans two adjacent secrets plus trailing spillover bytes
 * (e.g. `[A-Z]{9}` over `ABCDEFGH` + `SECRETUV` + `A`) resolves the leading
 * secret as its own independent redaction on the FIRST obfuscate() call (a
 * genuinely raw prefix gets its own match, then the discard for the rest
 * resumes right after it), but on a LATER call — once that prefix is itself a
 * placeholder — the very first match attempt starts already inside the
 * placeholder run, cannot be prefix-narrowed at all, and its discard resume
 * point lands mid-run instead of past it, exposing a shorter tail (`SECRETUV`
 * + `A`) to a clean, un-cut match the first call never attempted. Chaining the
 * resume point through every immediately-adjacent placeholder makes both
 * calls land on the exact same next scan position.
 */
export function extendPastAdjacentPlaceholders(segments: ReadonlyArray<RegexScanSegment>, index: number): number {
	let cursor = index;
	for (;;) {
		const segment = segments.find(candidate => candidate.scanStart === cursor && candidate.generatedPlaceholder);
		if (!segment) return cursor;
		cursor = segment.scanEnd;
	}
}

// Apply a fixed custom replacement across a matched span while preserving any
// inner generated placeholders. Usually the replacement is the user's single
// redaction marker for the whole match, so emit it for the first non-empty
// surrounding chunk and drop later chunks. But bounded regexes can cut through
// an already-emitted marker on the trailing side (`X#…#RED` from
// `XSECRETUVREDACTED`), where dropping the later prefix would leave raw bytes
// (`ACTED`) to be consumed on the next pass. Promote later chunks that are a
// prefix of the replacement to the FULL marker so the first pass is already a
// fixed point. The reversible placeholder stays intact in its relative
// position.
export function redactWithFixedReplacementOutsidePlaceholders(
	text: string,
	origin: string,
	replacement: string,
	shouldPreservePlaceholder: (placeholder: string) => boolean,
): { text: string; origin: string } {
	let emitted = false;
	return transformOutsidePlaceholdersTracked(
		text,
		origin,
		shouldPreservePlaceholder,
		chunk => {
			if (chunk.length === 0) return "";
			if (!emitted) {
				emitted = true;
				return replacement;
			}
			return replacement.startsWith(chunk) ? replacement : "";
		},
		placeholder => placeholder,
	);
}

export function deobfuscateGeneratedPlaceholderRanges(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): { text: string; recursive: boolean } {
	let result = "";
	let cursor = start;
	let recursive = false;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		result += text.slice(cursor, overlapStart);
		const placeholder = text.slice(overlapStart, overlapEnd);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		result += mapping?.secret ?? placeholder;
		recursive ||= mapping?.recursive ?? false;
		cursor = overlapEnd;
	}
	result += text.slice(cursor, end);
	return { text: result, recursive };
}

// Concatenate ONLY the deobfuscated placeholder ranges within [start, end),
// dropping the bytes that lie outside them. Used to test whether a regex match
// that straddles a prior-call placeholder would still match on the placeholder's
// own (expanded) secret value alone — i.e. the surrounding raw bytes are greedy
// spillover the match does not need, rather than content the match depends on.
export function placeholderInnerText(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): string {
	let result = "";
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		const placeholder = text.slice(overlapStart, overlapEnd);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		result += mapping?.secret ?? placeholder;
	}
	return result;
}

// Concatenate the bytes of [start, end) that lie OUTSIDE the given (ascending,
// non-overlapping) placeholder ranges. Used to test whether a regex match that
// straddles a prior-call placeholder would still match on its surrounding bytes
// alone — i.e. those bytes are genuinely new content to redact rather than a
// match that only exists because the deobfuscated placeholder bridges them.
export function textOutsidePlaceholderRanges(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
	let result = "";
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		result += text.slice(cursor, overlapStart);
		cursor = overlapEnd;
	}
	result += text.slice(cursor, end);
	return result;
}

// Like `textOutsidePlaceholderRanges`, but tests each outside chunk against
// `regex` in its REAL context instead of on an isolated slice — tried in BOTH
// the literal `#…#` placeholder-token text AND the EXPANDED scan context
// (placeholder resolved to its secret value), since either can be the reason a
// chunk independently requires redaction:
//  - Literal-token context matters when the placeholder TOKEN's own non-word
//    boundary is what completes a boundary-sensitive pattern, e.g. a prefix
//    "ABCDEFGH" next to a placeholder token matches `\b[A-Z]{8}\b` because the
//    token's leading `#` is a non-word byte — but that boundary disappears
//    once the placeholder expands into more `[A-Z]` bytes with no separator.
//  - Expanded scan context matters when a lookbehind/lookahead only resolves
//    once the neighboring placeholder is expanded, e.g. a prior plain
//    placeholder for `ABCDEFGH` next to raw `SECRET`, matched by
//    `(?<=ABCDEFGH)SECRET`: the literal placeholder token before `SECRET`
//    never satisfies the lookbehind, so literal-context alone wrongly reports
//    no independent match.
// A match only counts when it lies ENTIRELY within one outside chunk (in
// whichever context it was tested); a match that reaches into the
// placeholder itself is not evidence the outside chunk independently
// requires redaction.
export function outsidePlaceholderRangesAnyIndependentlyMatch(
	text: string,
	scanText: string,
	segments: ReadonlyArray<RegexScanSegment>,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	regex: RegExp,
): boolean {
	// A text-space outside chunk lies entirely within one non-placeholder scan
	// segment (placeholder ranges are exactly the gaps between such segments),
	// so its scan-space span is a fixed offset from its text-space span.
	const toScanSpace = (chunkStart: number, chunkEnd: number): [number, number] | undefined => {
		for (const segment of segments) {
			if (segment.generatedPlaceholder || segment.textStart > chunkStart || segment.textEnd < chunkEnd) continue;
			const offset = segment.scanStart - segment.textStart;
			return [chunkStart + offset, chunkEnd + offset];
		}
		return undefined;
	};
	const chunkIndependentlyMatches = (chunkStart: number, chunkEnd: number): boolean => {
		if (chunkMatchesInSourceContext(text, chunkStart, chunkEnd, regex)) return true;
		const scanSpan = toScanSpace(chunkStart, chunkEnd);
		return scanSpan !== undefined && chunkMatchesInSourceContext(scanText, scanSpan[0], scanSpan[1], regex);
	};
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart && chunkIndependentlyMatches(cursor, overlapStart)) return true;
		cursor = overlapEnd;
	}
	return cursor < end && chunkIndependentlyMatches(cursor, end);
}

// Whether `regex` (global) has a match fully contained in [chunkStart, chunkEnd)
// when run against the full `text` — so lookbehind/lookahead see the actual
// surrounding bytes rather than an isolated slice's edges.
function chunkMatchesInSourceContext(text: string, chunkStart: number, chunkEnd: number, regex: RegExp): boolean {
	regex.lastIndex = chunkStart;
	for (;;) {
		const found = regex.exec(text);
		if (found === null || found.index >= chunkEnd) return false;
		const matchEnd = found.index + found[0].length;
		if (matchEnd <= chunkEnd) return true;
		regex.lastIndex = found[0].length === 0 ? found.index + 1 : matchEnd;
	}
}

export function firstOutsidePlaceholderRange(
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): { start: number; end: number } | undefined {
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart) return { start: cursor, end: overlapStart };
		cursor = overlapEnd;
	}
	return cursor < end ? { start: cursor, end } : undefined;
}

export function countOutsidePlaceholderRanges(
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): number {
	let count = 0;
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart) count++;
		cursor = overlapEnd;
	}
	if (cursor < end) count++;
	return count;
}

export function replaceRange(text: string, start: number, end: number, replacement: string): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

/** Deep-walk an object, transforming all string values. */
export function deepWalkStrings<T>(obj: T, transform: (s: string) => string): T {
	if (typeof obj === "string") {
		return transform(obj) as unknown as T;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const transformed = deepWalkStrings(item, transform);
			if (transformed !== item) changed = true;
			return transformed;
		});
		return (changed ? result : obj) as unknown as T;
	}
	if (obj !== null && typeof obj === "object" && isPlainRecord(obj)) {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			const value = (obj as Record<string, unknown>)[key];
			const transformed = deepWalkStrings(value, transform);
			if (transformed !== value) changed = true;
			result[key] = transformed;
		}
		return (changed ? result : obj) as T;
	}
	return obj;
}

function isPlainRecord(obj: object): obj is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(obj);
	return prototype === Object.prototype || prototype === null;
}

export function collectJsonRegexSecretValues(obfuscator: SecretObfuscator, value: JsonValue): Set<string> {
	const values = new Set<string>();
	const collect = (item: JsonValue): void => {
		if (typeof item === "string") {
			for (const secretValue of obfuscator.collectRegexSecretValuesForObfuscation(item)) {
				values.add(secretValue);
			}
			return;
		}
		if (Array.isArray(item)) {
			for (const child of item) collect(child);
			return;
		}
		if (item !== null && typeof item === "object") {
			for (const child of Object.values(item)) {
				if (child !== undefined) collect(child);
			}
		}
	};
	collect(value);
	return values;
}

/**
 * Map every string in arbitrary JSON. Used ONLY for tool-call arguments, whose
 * shape is model-authored and not known ahead of time. No other caller may walk
 * untyped data: every message/content path is handled by a typed transformer.
 */
export function mapJsonStrings(value: JsonValue, fn: (s: string) => string): JsonValue {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = mapJsonStrings(item, fn);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const out: JsonRecord = {};
		for (const key of Object.keys(value)) {
			const item = value[key];
			if (item === undefined) continue;
			const next = mapJsonStrings(item, fn);
			if (next !== item) changed = true;
			out[key] = next;
		}
		return changed ? out : value;
	}
	return value;
}
