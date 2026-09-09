/**
 * Detect and resolve unresolved git merge conflicts that surface in `read`
 * output.
 *
 * Workflow:
 *   1. `read` collects lines from disk as usual.
 *   2. `scanConflictLines` inspects those lines (no extra I/O) for
 *      well-formed `<<<<<<<` / `=======` / `>>>>>>>` blocks.
 *   3. Each completed block is registered with the session's
 *      `ConflictHistory`, which assigns it a stable id.
 *   4. The read output is returned verbatim with a short footer naming
 *      every conflict id surfaced, and the agent calls
 *      `write({ path: "conflict://<id>", content })` to splice the
 *      recorded region with the chosen content.
 *
 * Marker shape is strict: only column-0 markers of the exact prefix length
 * followed by either EOL or a single space + label count. Lines that
 * merely start with `<` or `=` never match.
 */

import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

export interface ConflictBlock {
	/** 1-indexed line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-indexed line of the `=======` separator. */
	separatorLine: number;
	/** 1-indexed line of the `>>>>>>>` marker. */
	endLine: number;
	/** 1-indexed line of the `|||||||` base marker (diff3 only). */
	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

/**
 * Scan an already-collected array of file lines for completed conflict
 * blocks. `firstLineNumber` is the 1-indexed line number of `lines[0]`
 * (so a windowed read starting at line 200 passes `firstLineNumber: 200`).
 *
 * Only fully-closed blocks (opener + separator + closer all present in
 * the window) are returned. A block whose closer is past the window's
 * tail is dropped — the agent will see the open marker and can widen
 * the read.
 */
export function scanConflictLines(lines: readonly string[], firstLineNumber: number): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let phase: "idle" | "ours" | "base" | "theirs" = "idle";
	let partial: {
		startLine: number;
		oursLabel?: string;
		oursLines: string[];
		baseLine?: number;
		baseLabel?: string;
		baseLines?: string[];
		separatorLine?: number;
		theirsLines?: string[];
	} | null = null;

	for (let i = 0; i < lines.length; i++) {
		// Strip a trailing \r so CRLF checkouts match the same markers; stored
		// section lines are LF-normalized (splice re-applies \r on write).
		const line = stripTrailingCr(lines[i]);
		const ln = firstLineNumber + i;

		const oursLabel = matchMarker(line, OURS_PREFIX);
		if (oursLabel !== null) {
			partial = { startLine: ln, oursLabel: oursLabel || undefined, oursLines: [] };
			phase = "ours";
			continue;
		}

		if (phase === "idle" || partial === null) continue;

		const baseLabel = matchMarker(line, BASE_PREFIX);
		if (baseLabel !== null) {
			if (phase !== "ours") {
				partial = null;
				phase = "idle";
				continue;
			}
			partial.baseLine = ln;
			partial.baseLabel = baseLabel || undefined;
			partial.baseLines = [];
			phase = "base";
			continue;
		}

		if (line === SEPARATOR) {
			if (phase === "ours" || phase === "base") {
				partial.separatorLine = ln;
				partial.theirsLines = [];
				phase = "theirs";
			} else {
				partial = null;
				phase = "idle";
			}
			continue;
		}

		const theirsLabel = matchMarker(line, THEIRS_PREFIX);
		if (theirsLabel !== null) {
			if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
				blocks.push({
					startLine: partial.startLine,
					separatorLine: partial.separatorLine,
					endLine: ln,
					baseLine: partial.baseLine,
					oursLabel: partial.oursLabel,
					baseLabel: partial.baseLabel,
					theirsLabel: theirsLabel || undefined,
					oursLines: partial.oursLines,
					baseLines: partial.baseLines,
					theirsLines: partial.theirsLines,
				});
			}
			partial = null;
			phase = "idle";
			continue;
		}

		if (phase === "ours") partial.oursLines.push(line);
		else if (phase === "base" && partial.baseLines) partial.baseLines.push(line);
		else if (phase === "theirs" && partial.theirsLines) partial.theirsLines.push(line);
	}

	return blocks;
}

const SCAN_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Scan a whole file for unresolved conflict blocks.
 *
 * Reads at most `maxBytes` (default 10 MB) so this stays cheap on
 * pathological files. Files truncated by the cap report
 * `scanTruncated: true`; only complete blocks within the scanned prefix
 * are returned, so trailing partial markers never invent fake blocks.
 */
export async function scanFileForConflicts(
	absolutePath: string,
	options: { maxBytes?: number } = {},
): Promise<{ blocks: ConflictBlock[]; scanTruncated: boolean }> {
	const maxBytes = options.maxBytes ?? SCAN_FILE_DEFAULT_MAX_BYTES;
	const file = Bun.file(absolutePath);
	const size = file.size;
	const truncated = size > maxBytes;
	const bytes = truncated ? new Uint8Array(await file.slice(0, maxBytes).arrayBuffer()) : await file.bytes();
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	// `split("\n")` over a truncated read may leave a partial last line; the
	// scanner already tolerates an unclosed opener, so no extra trimming.
	const lines = text.split("\n");
	return { blocks: scanConflictLines(lines, 1), scanTruncated: truncated };
}

/**
 * Return the label after a marker prefix when the line is a valid
 * column-0 marker, or `null` when it isn't. Strict shape: prefix alone,
 * or prefix + single space + label.
 */
function matchMarker(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) return null;
	if (line.length === prefix.length) return "";
	if (line.charCodeAt(prefix.length) !== 32 /* space */) return null;
	return line.slice(prefix.length + 1);
}

/**
 * Recorded conflict block keyed by a session-stable id. The history is
 * append-only; ids stay valid even after later writes resolve other
 * blocks in the same file, so retries don't depend on re-reading.
 */
export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

/** Per-session log of conflict regions surfaced by `read`. */
export class ConflictHistory {
	#nextId = 1;
	#entries = new Map<number, ConflictEntry>();

	/**
	 * Register a conflict block. Returns the (possibly pre-existing) entry
	 * — if the same `absolutePath`+`startLine` was registered before, the
	 * earlier id is reused so a re-read does not inflate the counter or
	 * orphan the prior id. The recorded region is overwritten on re-read
	 * so the splice always reflects the current marker positions on disk.
	 */
	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				const merged: ConflictEntry = { ...input, id: existing.id };
				this.#entries.set(existing.id, merged);
				return merged;
			}
		}
		const id = this.#nextId++;
		const entry: ConflictEntry = { ...input, id };
		this.#entries.set(id, entry);
		return entry;
	}

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	/** Snapshot every registered entry in insertion (id) order. */
	entries(): ConflictEntry[] {
		return [...this.#entries.values()];
	}

	/** Drop a single entry by id. Used after a successful resolve. */
	invalidate(id: number): void {
		this.#entries.delete(id);
	}

	/** Drop every entry referencing `absolutePath`. Used after a successful resolve. */
	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.#entries) {
			if (entry.absolutePath === absolutePath) {
				this.#entries.delete(id);
			}
		}
	}
}

/** Lazily attach a `ConflictHistory` to the session and return it. */
export function getConflictHistory(session: ToolSession): ConflictHistory {
	if (!session.conflictHistory) session.conflictHistory = new ConflictHistory();
	return session.conflictHistory;
}

/** A side of a conflict block that the `read` tool can render via `conflict://N/<scope>`. */
export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

/** Parsed `conflict://<N>` / `conflict://<N>/<scope>` / `conflict://*` URI. */
export interface ParsedConflictUri {
	/** `"*"` selects every currently-registered conflict (bulk write only). */
	id: number | "*";
	scope?: ConflictScope;
	/**
	 * When `raw` was a malformed `<file-prefix>:conflict://…` path, the
	 * stripped prefix is preserved here so callers can surface a gentle
	 * "you don't need the file path" note. `undefined` for clean URIs.
	 */
	recoveredPrefix?: string;
}

// Accept an optional `<prefix>:` before the scheme so paths like
// `path/to/file.ts:conflict://3` (where the agent mixed the `:conflicts`
// read selector with the `conflict://` scheme) still resolve. The prefix
// is greedy so the LAST `:conflict://` wins for multi-colon inputs.
const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

/**
 * Parse a `conflict://<N>`, `conflict://<N>/<scope>`, or `conflict://*` URI.
 *
 * Returns `null` for non-conflict paths; throws `ToolError` for a
 * well-formed scheme with an invalid id or scope so the agent gets a
 * clear actionable message rather than a confusing "not found" later.
 *
 * `*` is the bulk-write wildcard — only valid as `conflict://*` (no
 * scope segment). Use it with `write({ path: "conflict://*", content })`
 * to apply `content` (with optional `@ours` / `@theirs` / `@base` /
 * `@both` shorthand) to every currently-registered conflict in one shot.
 */
export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const recoveredPrefix = match[1];
	const tail = match[2];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (idPart === "*") {
		if (scopePart !== undefined) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`,
			);
		}
		return recoveredPrefix !== undefined ? { id: "*", recoveredPrefix } : { id: "*" };
	}

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior \`read\`.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new ToolError(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`,
			);
		}
		scope = scopePart as ConflictScope;
	}

	return recoveredPrefix !== undefined ? { id, scope, recoveredPrefix } : { id, scope };
}

/** Result of {@link spliceConflict}: the new file text plus any boundary-echo repair applied. */
export interface ConflictSplice {
	text: string;
	/** Replacement lines dropped because they duplicated the context directly above the region. */
	trimmedLeading: number;
	/** Replacement lines dropped because they duplicated the context directly below the region. */
	trimmedTrailing: number;
}

/**
 * Splice the conflict region recorded in `entry` out of `originalText`
 * and replace it with `replacement` (markers and all sides included).
 *
 * Works like the edit tool's patch infra: locates the recorded marker
 * block by content (anchored to `entry.startLine` as the preferred
 * match), so out-of-band edits earlier in the file that shift line
 * numbers don't break resolution. Throws clearly when the marker block
 * has actually been altered or removed.
 *
 * Boundary-echo repair (same philosophy as the edit tool's hashline
 * keeper repair): models frequently paste the "whole resolved function"
 * including the lines that live directly before/after the marker block,
 * which the verbatim splice would duplicate. Replacement lines that
 * exactly echo the adjacent context are dropped when the echo is
 * unambiguous — two or more consecutive lines, or a single line whose
 * removal fixes a delimiter-balance mismatch against the recorded sides.
 */
export function spliceConflict(originalText: string, entry: ConflictEntry, replacement: string): ConflictSplice {
	const lines = originalText.split("\n");
	const expected = buildRecordedRegion(entry);
	const match = locateRegion(lines, expected, entry.startLine - 1);
	if (!match) {
		throw new ToolError(
			`Conflict #${entry.id} no longer present in '${entry.displayPath}': the recorded marker block can't be located. The file changed since the conflict was registered — re-read it to re-register conflicts.`,
		);
	}

	const trimmed = normalizeTrailingNewline(replacement);
	let replacementLines = trimmed.split("\n").map(stripTrailingCr);
	const echo = trimBoundaryEcho(replacementLines, lines, match, entry);
	replacementLines = echo.lines;
	// Round-trip fidelity for CRLF files: recorded sections are LF-normalized,
	// so re-apply \r to spliced lines when the matched region used CRLF. The
	// final replacement line only carries \r when another line follows it.
	if (lines[match.startIdx]!.endsWith("\r")) {
		const hasFollowingLine = match.endIdx + 1 < lines.length;
		replacementLines = replacementLines.map((l, i) =>
			i < replacementLines.length - 1 || hasFollowingLine ? `${l}\r` : l,
		);
	}
	const next = [...lines.slice(0, match.startIdx), ...replacementLines, ...lines.slice(match.endIdx + 1)];
	return { text: next.join("\n"), trimmedLeading: echo.leading, trimmedTrailing: echo.trailing };
}

const MAX_ECHO_LINES = 12;

/**
 * Net `{}`/`()`/`[]` count over `lines`. Crude (string/comment-blind) —
 * used only to corroborate single-line echo trims, never alone.
 */
function delimiterBalance(lines: readonly string[]): number {
	let balance = 0;
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const ch = line.charCodeAt(i);
			if (ch === 123 /* { */ || ch === 40 /* ( */ || ch === 91 /* [ */) balance++;
			else if (ch === 125 /* } */ || ch === 41 /* ) */ || ch === 93 /* ] */) balance--;
		}
	}
	return balance;
}

/**
 * Drop replacement lines that exactly echo the file lines adjacent to the
 * located region. A multi-line echo is trimmed unconditionally (a correct
 * resolution ending with the exact lines that already follow the region
 * would mean intentionally duplicated code — vanishingly unlikely, and the
 * untrimmed splice produces exactly that duplication). A single-line echo
 * is trimmed only when the recorded sides agree on the region's delimiter
 * balance and dropping the echo is what restores it.
 */
function trimBoundaryEcho(
	replacement: string[],
	fileLines: readonly string[],
	match: { startIdx: number; endIdx: number },
	entry: ConflictBlock,
): { lines: string[]; leading: number; trailing: number } {
	const oursBalance = delimiterBalance(entry.oursLines);
	const expectedBalance = oursBalance === delimiterBalance(entry.theirsLines) ? oursBalance : null;
	const singleEchoJustified = (lines: string[], without: string[]) =>
		expectedBalance !== null &&
		delimiterBalance(lines) !== expectedBalance &&
		delimiterBalance(without) === expectedBalance;

	let lines = replacement;
	let trailing = 0;
	const after: string[] = [];
	for (let i = match.endIdx + 1; i < fileLines.length && after.length < MAX_ECHO_LINES; i++) {
		after.push(stripTrailingCr(fileLines[i]!));
	}
	for (let k = Math.min(after.length, lines.length - 1); k >= 1; k--) {
		if (!after.slice(0, k).every((line, i) => lines[lines.length - k + i] === line)) continue;
		if (k >= 2 || singleEchoJustified(lines, lines.slice(0, -1))) {
			trailing = k;
			lines = lines.slice(0, lines.length - k);
		}
		break;
	}

	let leading = 0;
	const before: string[] = [];
	for (let i = match.startIdx - 1; i >= 0 && before.length < MAX_ECHO_LINES; i--) {
		before.unshift(stripTrailingCr(fileLines[i]!));
	}
	for (let k = Math.min(before.length, lines.length - 1); k >= 1; k--) {
		if (!before.slice(before.length - k).every((line, i) => lines[i] === line)) continue;
		if (k >= 2 || singleEchoJustified(lines, lines.slice(1))) {
			leading = k;
			lines = lines.slice(k);
		}
		break;
	}

	return { lines, leading, trailing };
}

/** Reconstruct the recorded marker block as it should appear in the file. */
function buildRecordedRegion(entry: ConflictBlock): string[] {
	const out: string[] = [];
	out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX);
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX);
		out.push(...entry.baseLines);
	}
	out.push(SEPARATOR);
	out.push(...entry.theirsLines);
	out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX);
	return out;
}

/**
 * True when two registered blocks record the same marker-block content
 * (labels and all sides). Out-of-band edits can shift a block's line
 * numbers between reads, registering a fresh id while the stale one
 * persists; callers use content identity to treat a locate-miss for the
 * stale twin as "already resolved" instead of a hard failure.
 */
export function conflictRegionsEqual(a: ConflictBlock, b: ConflictBlock): boolean {
	const ra = buildRecordedRegion(a);
	const rb = buildRecordedRegion(b);
	if (ra.length !== rb.length) return false;
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return false;
	}
	return true;
}

/**
 * True when the entry's recorded marker block still occurs in `content`
 * (LF-normalized — recorded sections are stored LF). Distinguishes a stale
 * re-registration of a just-resolved region (no longer present) from a
 * DISTINCT conflict block that happens to be byte-identical (still present
 * elsewhere in the file and must stay addressable).
 */
export function conflictRegionPresent(content: string, entry: ConflictBlock): boolean {
	const region = buildRecordedRegion(entry).join("\n");
	const normalized = content.includes("\r") ? content.replace(/\r\n/g, "\n") : content;
	return normalized.includes(region);
}

/**
 * Find a contiguous match of `expected` inside `lines`, preferring the
 * occurrence closest to `preferredIdx` to disambiguate when an identical
 * block (vanishingly unlikely for real conflicts) appears more than once.
 */
function locateRegion(
	lines: readonly string[],
	expected: readonly string[],
	preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
	if (expected.length === 0 || expected.length > lines.length) return null;
	// Fast path: try the recorded position first.
	if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
		return { startIdx: preferredIdx, endIdx: preferredIdx + expected.length - 1 };
	}
	let best: number | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	const limit = lines.length - expected.length;
	for (let i = 0; i <= limit; i++) {
		if (!matchesAt(lines, i, expected)) continue;
		const dist = Math.abs(i - preferredIdx);
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	if (best === null) return null;
	return { startIdx: best, endIdx: best + expected.length - 1 };
}

function matchesAt(lines: readonly string[], startIdx: number, expected: readonly string[]): boolean {
	if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
	for (let i = 0; i < expected.length; i++) {
		// Recorded lines are LF-normalized; tolerate CRLF on-disk lines.
		if (stripTrailingCr(lines[startIdx + i]!) !== expected[i]) return false;
	}
	return true;
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function normalizeTrailingNewline(replacement: string): string {
	if (replacement.endsWith("\r\n")) return replacement.slice(0, -2);
	if (replacement.endsWith("\n")) return replacement.slice(0, -1);
	return replacement;
}

/**
 * Expand `@ours` / `@theirs` / `@base` / `@both` line tokens against the
 * recorded sections of `entry`. A token only triggers when it is the
 * entire content of a line (after CRLF normalisation), so `@ours` inside
 * actual code is left alone. Other lines pass through verbatim.
 *
 * - `@ours`    → expands to the recorded `oursLines` (in order).
 * - `@theirs`  → expands to the recorded `theirsLines` (in order).
 * - `@base`    → expands to `baseLines`; throws if no base section was
 *               recorded (i.e. the conflict was 2-way, not diff3).
 * - `@both`    → expands to `oursLines` then `theirsLines`.
 */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const inputLines = content.split("\n");
	const out: string[] = [];
	for (const rawLine of inputLines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		switch (line) {
			case "@ours":
				out.push(...entry.oursLines);
				break;
			case "@theirs":
				out.push(...entry.theirsLines);
				break;
			case "@base":
				if (!entry.baseLines) {
					throw new ToolError(
						`Conflict #${entry.id} has no base section (2-way merge). \`@base\` is only valid for diff3 conflicts.`,
					);
				}
				out.push(...entry.baseLines);
				break;
			case "@both":
				out.push(...entry.oursLines, ...entry.theirsLines);
				break;
			default:
				out.push(rawLine);
				break;
		}
	}
	return out.join("\n");
}

/** Reconstruct a conflict-marker line from prefix and optional label. */
function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

/**
 * Materialise a conflict block for `conflict://<N>` reads (and their
 * `/ours` / `/theirs` / `/base` scopes).
 *
 * Returns:
 * - `lines`: the lines to render, ordered top-to-bottom.
 * - `startLine`: the 1-indexed file line number `lines[0]` corresponds
 *   to, so the read formatter can label hashline anchors with the
 *   original file positions.
 *
 * Bare (no scope) returns the full block including marker lines. A
 * scoped view returns only that side's body — `base` throws when the
 * recorded conflict is a 2-way merge with no base section.
 */
export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new ToolError(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}

const PREVIEW_SIDE_LINES = 6;

/**
 * Build a compact diff-style footer describing the conflicts registered
 * during a read. Designed to be appended after the file content.
 *
 * Format:
 *
 *     ⚠ N unresolved conflicts detected
 *     - ours = HEAD
 *     - theirs = feature/x
 *     NOTICE: …
 *
 *     ──── #1  L42-48 ────
 *     <<< ours
 *     …ours body…
 *     === base ≡ ours
 *     >>> theirs
 *     …theirs body…
 *
 * Labels are aggregated once at the top from the first entry that has
 * them; when a section body equals another section's body the redundant
 * body is collapsed to `≡ <other>`.
 */
export interface FormatConflictWarningOptions {
	/**
	 * Total number of conflicts in the underlying file. If greater than
	 * `entries.length` the header notes how many are visible vs the total
	 * and points at `:conflicts` for the compact list.
	 */
	totalInFile?: number;
	/** Display path used inside the `:conflicts` hint. */
	displayPath?: string;
	/** Whether the underlying file scan hit its byte cap. */
	scanTruncated?: boolean;
}

export function formatConflictWarning(
	entries: readonly ConflictEntry[],
	options: FormatConflictWarningOptions = {},
): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [];
	out.push("");
	const word = total === 1 ? "conflict" : "conflicts";
	if (partial) {
		const hintPath = options.displayPath ?? "<file>";
		out.push(
			`⚠ ${entries.length} of ${total} unresolved ${word} visible in this window (read \`${hintPath}:conflicts\` for the full list).`,
		);
	} else {
		out.push(`⚠ ${total} unresolved ${word} detected`);
	}
	if (options.scanTruncated) {
		out.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}

	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) out.push(`- ours = ${oursLabel}`);
	if (theirsLabel) out.push(`- theirs = ${theirsLabel}`);
	if (anyBase) out.push(`- base = ${baseLabel ?? "(no label)"}`);
	out.push(
		'NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side). Resolve with `write({ path: "conflict://<N>", content })`, or bulk-resolve every registered conflict with `write({ path: "conflict://*", content })`. Writes replace ONLY the marker block (markers + all sides) — never repeat the lines before/after it; they stay in place.',
	);
	out.push(
		'`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. `@both` is ours-then-theirs with no separator — only for additive conflicts where each side adds something different; NEVER for competing edits of the same lines (pick a side or write the combined text). Lines that are not a token pass through verbatim, so `"// keep both\\n@ours\\n@theirs"` literally writes the comment, then ours, then theirs.',
	);
	out.push(
		'Per-id bulk: `write({ path: "conflict://*", content: "1: @ours\\n2: @theirs\\n…" })` resolves each listed id with that side in ONE call — the cheapest way through many pick-one conflicts; unlisted ids stay registered.',
	);
	out.push(
		"Resolve each block faithfully: keep one side (`@ours`/`@theirs`), or combine them when both intents apply — never invent content beyond the recorded sides, and never stack both sides of competing edits. Resolve several conflicts in a single turn by issuing multiple `write` calls at once; ids stay valid as earlier blocks are resolved.",
	);

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		out.push("");
		out.push(`──── #${entry.id}  ${range} ────`);

		const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines);
		const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines);
		const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines);

		out.push("<<< ours");
		appendBody(out, entry.oursLines);

		if (entry.baseLines !== undefined) {
			if (baseEqualsOurs) {
				out.push("=== base ≡ ours");
			} else if (baseEqualsTheirs) {
				out.push("=== base ≡ theirs");
			} else {
				out.push("=== base");
				appendBody(out, entry.baseLines);
			}
		}

		if (theirsEqualsOurs) {
			out.push(">>> theirs ≡ ours");
		} else {
			out.push(">>> theirs");
			appendBody(out, entry.theirsLines);
		}
	}
	return out.join("\n");
}

/**
 * Render a single-line-per-block index of every conflict in a file.
 * Used by the `<path>:conflicts` read selector to give the agent a cheap overview
 * of a heavily-conflicted file without dumping every body.
 */
export function formatConflictSummary(
	entries: readonly ConflictEntry[],
	options: { displayPath: string; scanTruncated?: boolean } = { displayPath: "" },
): string {
	const lines: string[] = [];
	const total = entries.length;
	const word = total === 1 ? "conflict" : "conflicts";
	lines.push(`⚠ ${total} unresolved ${word} in ${options.displayPath || "<file>"}`);
	if (options.scanTruncated) {
		lines.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}
	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) lines.push(`- ours = ${oursLabel}`);
	if (theirsLabel) lines.push(`- theirs = ${theirsLabel}`);
	if (anyBase) lines.push(`- base = ${baseLabel ?? "(no label)"}`);
	lines.push(
		'NOTICE: Bulk-resolve with `write({ path: "conflict://*", content })`, or address a single block with `write({ path: "conflict://<N>", content })`. Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for a single side).',
	);
	lines.push(
		'`content` shorthand: `@ours` / `@theirs` / `@base` / `@both` lines expand to the recorded sections; `@both` = ours-then-theirs (additive conflicts only — never for competing edits of the same lines). Per-id bulk: content of `<id>: @side` lines (e.g. "1: @ours\\n2: @theirs") resolves each listed id in one call. Non-token lines pass through verbatim. Writes replace ONLY the marker block — never repeat the surrounding lines. Keep one side or combine faithfully; never invent content beyond the recorded sides.',
	);
	lines.push("");
	const idWidth = String(entries[entries.length - 1]?.id ?? 1).length;
	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const idCell = `#${String(entry.id).padStart(idWidth, " ")}`;
		const kind = entry.baseLines !== undefined ? "  (3-way)" : "";
		lines.push(`${idCell}  ${range}${kind}`);
	}
	return lines.join("\n");
}

function pickLabel(
	entries: readonly ConflictEntry[],
	get: (e: ConflictEntry) => string | undefined,
): string | undefined {
	for (const e of entries) {
		const label = get(e);
		if (label && label.trim().length > 0) return label;
	}
	return undefined;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	const shown = section.slice(0, PREVIEW_SIDE_LINES);
	for (const line of shown) out.push(line);
	const hidden = section.length - shown.length;
	if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? "" : "s"})`);
}
