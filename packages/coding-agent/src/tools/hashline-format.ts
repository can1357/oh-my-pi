import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
	hashlineStripPrefixes,
} from "@oh-my-pi/pi-natives";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";
export const HL_FILE_HASH_SEP = "#";
export const HL_FILE_HASH_LENGTH = 4;
export const HL_MOVE_KEYWORD = "MV";
export const HL_REM_KEYWORD = "REM";
export const HL_LINE_BODY_SEP = ":";

export function formatHashlineHeader(path: string, tag: string): string {
	return hashlineFormatHeader(path, tag);
}

export function formatNumberedLines(text: string, startLine?: number): string {
	return hashlineFormatNumberedLines(text, startLine);
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function stripHashlinePrefixes(lines: string[]): string[] {
	return hashlineStripPrefixes(lines);
}

/** Largest value `usize::from_str` accepts on every 64-bit target this addon builds for. */
const USIZE_MAX_DIGITS = "18446744073709551615";

/**
 * The 25 code points of the Unicode `White_Space` property, which is what
 * Rust's `char::is_whitespace` tests.
 */
const RUST_WHITESPACE_CLASS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM_RE = new RegExp(`^[${RUST_WHITESPACE_CLASS}]+|[${RUST_WHITESPACE_CLASS}]+$`, "gu");

/**
 * `str::trim` as Rust does it, which is not what JS `String.trim` strips.
 * Both sets hold 25 code points and they differ in both directions: JS trims
 * U+FEFF, which Rust keeps, and Rust trims U+0085, which JS keeps.
 *
 * The U+FEFF half is the one that bites. This classifier runs over content a
 * user is writing, so a real line that merely opens with a BOM, such as a
 * literal `[Showing lines 1-20 of 60. Use :21 to continue]` behind one, would
 * lose the BOM to `String.trim`, match as read metadata, and get the write
 * rejected as an incomplete read projection.
 */
function rustTrim(value: string): string {
	return value.replace(RUST_TRIM_RE, "");
}

/**
 * Whether `value` is what Rust's `usize::from_str` accepts: an optional `+`,
 * then one or more ASCII digits, with the value inside `usize` range.
 *
 * A bare `/^\d+$/` is not the same predicate and diverges in both directions:
 * it rejects `+5`, which Rust parses as 5, and accepts `18446744073709551616`,
 * which Rust rejects as overflow.
 *
 * The range check is a string comparison rather than a `BigInt` conversion.
 * `parse::<usize>()` is checked and allocates nothing, so it answers a count of
 * half a million digits as cheaply as a count of two. Converting first gives
 * that input a way to throw `RangeError: Out of memory` out of a classifier
 * whose only job is to return a boolean, and the write it was inspecting fails
 * with it. Leading zeros are stripped first because Rust accepts them.
 */
function parsesAsUsize(value: string): boolean {
	const body = value.startsWith("+") ? value.slice(1) : value;
	if (body.length === 0 || !/^\d+$/.test(body)) return false;
	const digits = body.replace(/^0+(?=\d)/, "");
	// Equal-length digit strings compare lexicographically the way they compare
	// numerically, so the only other question is which is longer.
	if (digits.length !== USIZE_MAX_DIGITS.length) return digits.length < USIZE_MAX_DIGITS.length;
	return digits <= USIZE_MAX_DIGITS;
}

/**
 * Whether a row is a truncation notice emitted by `read`.
 *
 * Behavioural port of `crates/pi-edit/src/modes/hashline/prefixes.rs::is_read_truncation_notice`,
 * which stays the source of truth: the Rust copy is load-bearing inside the
 * hashline parser through `is_read_metadata_line`, so it cannot be deleted the
 * way `description_compact` was in 95337cf22b3f. `test/hashline-truncation-notice.test.ts`
 * mirrors the corpus in `crates/pi-edit/tests/hashline_parse.rs` so the two
 * cannot drift silently; change both together.
 *
 * It is a port rather than a native call because PR CI tests against the latest
 * published `@oh-my-pi/pi-natives` release rather than a source build (ci.yml:212-219:
 * native changes are validated post-merge on main and at release), so a napi
 * export used in the same PR that adds it resolves to `undefined` and breaks
 * every PR's tests until the next release is cut. The check is plain string
 * matching with no native-only capability, so it does not need the boundary.
 */
export function isReadTruncationNotice(line: string): boolean {
	const trimmed = rustTrim(line);
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
	const body = trimmed.slice(1, -1);
	const showingNotice =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const moreLineSplitIndex = body.indexOf(" more line");
	const moreLineCount = moreLineSplitIndex === -1 ? null : body.slice(0, moreLineSplitIndex);
	const moreNotice =
		(body.startsWith("More lines in ") || (moreLineCount !== null && parsesAsUsize(moreLineCount))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elidedNotice =
		(body.startsWith("…") || body.startsWith("...")) &&
		body.includes("ln elided;") &&
		body.includes("re-read needed ranges");
	const oversizedLineNotice = body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showingNotice || moreNotice || elidedNotice || oversizedLineNotice;
}

export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
