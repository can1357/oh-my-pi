/**
 * Detect and resolve materialized Git and Jujutsu conflicts surfaced by
 * `read`.
 *
 * Marker parsing supports Git diff3 plus Jujutsu diff/snapshot styles,
 * arbitrary side/base arity, CRLF, and dynamically lengthened markers. Inside
 * a repository, marker blocks are exposed only when the owning VCS records the
 * path as conflicted; standalone marker files remain usable. Registered hunks
 * receive session-stable ids which `write conflict://N` resolves by exact
 * marker-block replacement.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsConflictRegion } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const MIN_MARKER_LENGTH = 7;

export type ConflictStyle = "git" | "jj-diff" | "jj-snapshot";
export type ConflictGrammar = "all" | "git";

export interface ConflictSection {
	label?: string;
	lines: string[];
	/** Exact semantic term content, including its terminal EOL when present. */
	content?: string;
	/** 1-indexed file line of the first body line. */
	startLine: number;
}

export interface ConflictBlock {
	/** 1-indexed line of the opening marker. */
	startLine: number;
	/** 1-indexed line of the Git separator, or first jj term marker. */
	separatorLine: number;
	/** 1-indexed line of the closing marker. */
	endLine: number;
	/** 1-indexed line of the first base marker, when present. */
	baseLine?: number;
	style?: ConflictStyle;
	markerLength?: number;
	/** Exact LF-normalized marker block, including its outer markers. */
	rawLines?: string[];
	sides?: ConflictSection[];
	bases?: ConflictSection[];
	/** Legacy two-side projection retained for callers constructing entries directly. */
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

function contentLines(content: string): string[] {
	const lines = content.split("\n").map(stripTrailingCr);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function conflictStyle(style: string): ConflictStyle {
	if (style === "git" || style === "jj-diff" || style === "jj-snapshot") return style;
	throw new ToolError(`Native conflict parser returned unknown style '${style}'.`);
}

function buildConflictBlock(region: VcsConflictRegion, rawLines: string[], lineOffset: number): ConflictBlock {
	const sides = region.sides.map((term, index) => ({
		label: term.label,
		lines: contentLines(term.content),
		content: term.content,
		startLine: (index === 0 ? region.startLine + 1 : region.separatorLine + 1) + lineOffset,
	}));
	const bases = region.bases.map(term => ({
		label: term.label,
		lines: contentLines(term.content),
		content: term.content,
		startLine: (region.baseLine ?? region.startLine) + 1 + lineOffset,
	}));
	const [ours, theirs = { label: undefined, lines: [], startLine: region.endLine + lineOffset }] = sides;
	const base = bases[0];
	return {
		startLine: region.startLine + lineOffset,
		separatorLine: region.separatorLine + lineOffset,
		endLine: region.endLine + lineOffset,
		baseLine: region.baseLine === undefined ? undefined : region.baseLine + lineOffset,
		style: conflictStyle(region.style),
		markerLength: region.markerLength,
		rawLines,
		sides,
		bases,
		oursLabel: ours?.label,
		baseLabel: base?.label,
		theirsLabel: theirs.label,
		oursLines: ours?.lines ?? [],
		baseLines: base?.lines,
		theirsLines: theirs.lines,
	};
}

/**
 * Parse standalone marker content through the native Git grammar and jj-lib
 * parser. Repository-backed callers use backend-validated regions instead.
 */
export function scanConflictLines(
	lines: readonly string[],
	firstLineNumber: number,
	minimumMarkerLength = MIN_MARKER_LENGTH,
	exactMarkerLength = false,
	grammar: ConflictGrammar = "all",
): ConflictBlock[] {
	const normalized = lines.map(stripTrailingCr);
	return vcs
		.parseConflictMarkers(Buffer.from(normalized.join("\n")), minimumMarkerLength)
		.filter(
			region =>
				(!exactMarkerLength || region.markerLength === minimumMarkerLength) &&
				(grammar === "all" || region.style === "git"),
		)
		.map(region => {
			const start = region.startLine - 1;
			const end = region.endLine;
			return buildConflictBlock(region, normalized.slice(start, end), firstLineNumber - 1);
		});
}

export function scanRecordedConflictLines(
	lines: readonly string[],
	firstLineNumber: number,
	authority: Extract<ConflictAuthority, { state: "recorded"; kind: "file" }>,
): ConflictBlock[] {
	const normalized = lines.map(stripTrailingCr);
	const lastLineNumber = firstLineNumber + normalized.length - 1;
	return authority.regions
		.filter(region => region.startLine >= firstLineNumber && region.endLine <= lastLineNumber)
		.map(region => {
			const start = region.startLine - firstLineNumber;
			const end = region.endLine - firstLineNumber + 1;
			return buildConflictBlock(region, normalized.slice(start, end), 0);
		});
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
	options: {
		maxBytes?: number;
		minimumMarkerLength?: number;
		exactMarkerLength?: boolean;
		authority?: Extract<ConflictAuthority, { state: "recorded"; kind: "file" }>;
	} = {},
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
	return {
		blocks: options.authority
			? scanRecordedConflictLines(lines, 1, options.authority)
			: scanConflictLines(lines, 1, options.minimumMarkerLength, options.exactMarkerLength),
		scanTruncated: truncated,
	};
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
	authority?: "git" | "jj" | "unverified";
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

export type ConflictAuthorityRegion = VcsConflictRegion;

export type ConflictAuthority =
	| { state: "unverified" }
	| { state: "clean"; backend: "git" | "jj" }
	| { state: "recorded"; backend: "git" | "jj"; kind: "file"; regions: ConflictAuthorityRegion[] }
	| { state: "recorded"; backend: "git" | "jj"; kind: "other" };

/**
 * Ask the owning VCS whether `absolutePath` is recorded as conflicted. A
 * standalone file outside a repository remains marker-verifiable so conflict
 * fixtures and exported merge results can still use the protocol.
 */
async function canonicalTrackedPath(absolutePath: string): Promise<string> {
	const requested = path.resolve(absolutePath);
	const parent = await fs.realpath(path.dirname(requested)).catch(() => path.dirname(requested));
	const requestedName = path.basename(requested);
	const entries = await fs.readdir(parent).catch(() => []);
	const exactName = entries.find(name => name === requestedName);
	const foldedNames = exactName ? [] : entries.filter(name => name.toLowerCase() === requestedName.toLowerCase());
	const actualName = exactName ?? (foldedNames.length === 1 ? foldedNames[0]! : requestedName);
	return path.join(parent, actualName);
}

export async function inspectConflictAuthority(absolutePath: string, signal?: AbortSignal): Promise<ConflictAuthority> {
	const resolvedPath = await canonicalTrackedPath(absolutePath);
	const directory = path.dirname(resolvedPath);
	const repository = vcs.repo(directory);
	const jjWorkspace = vcs.jj(directory);
	if (!repository && !jjWorkspace) return { state: "unverified" };

	const jjOwns =
		jjWorkspace !== null &&
		(repository === null ||
			repository.kind() === "jj" ||
			path.resolve(repository.root()) === path.resolve(jjWorkspace.root()));
	const backend = jjOwns ? "jj" : "git";
	const root = jjOwns ? jjWorkspace.root() : repository?.root();
	if (!root) return { state: "unverified" };
	const resolvedRoot = await fs.realpath(root).catch(() => path.resolve(root));
	const relativePath = path.relative(resolvedRoot, resolvedPath).split(path.sep).join("/");
	if (relativePath === ".." || relativePath.startsWith("../")) return { state: "clean", backend };

	const conflicts = jjOwns
		? await jjWorkspace.conflictedPaths([relativePath], signal)
		: await repository!.conflictedPaths([relativePath], signal);
	const conflict = conflicts.find(item => item.path === relativePath);
	if (!conflict) return { state: "clean", backend };
	if (conflict.kind === "other") return { state: "recorded", backend, kind: "other" };
	const regions = conflict.regions;
	if (
		!Array.isArray(regions) ||
		regions.some(
			region =>
				!Number.isInteger(region.startLine) ||
				region.startLine < 1 ||
				!Number.isInteger(region.separatorLine) ||
				region.separatorLine <= region.startLine ||
				!Number.isInteger(region.endLine) ||
				region.endLine <= region.separatorLine ||
				!Number.isInteger(region.markerLength) ||
				region.markerLength < 1 ||
				!Array.isArray(region.sides) ||
				region.sides.length < 2 ||
				!Array.isArray(region.bases),
		)
	) {
		throw new ToolError(`The ${backend} conflict at '${relativePath}' has invalid materialized region metadata.`);
	}
	return { state: "recorded", backend, kind: "file", regions };
}

/** One indexed positive side or negative base. Git names normalize here. */
export interface ConflictScope {
	role: "side" | "base";
	index: number;
}

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
 * Parse a `conflict://<N>`, Git `/<ours|theirs|base>`, indexed
 * Jujutsu `/side/<M>` or `/base/<M>`, or `conflict://*` URI.
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
			throw new ToolError(`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment.`);
		}
		return recoveredPrefix !== undefined ? { id: "*", recoveredPrefix } : { id: "*" };
	}

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': use 'conflict://<N>', a Git '/ours', '/theirs', or '/base' scope, an indexed '/side/<M>' or '/base/<M>' scope, or 'conflict://*'.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new ToolError(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (scopePart === "ours") scope = { role: "side", index: 1 };
		else if (scopePart === "theirs") scope = { role: "side", index: 2 };
		else if (scopePart === "base") scope = { role: "base", index: 1 };
		else {
			const scopeMatch = scopePart.match(/^(side|base)\/([1-9]\d*)$/);
			if (!scopeMatch) {
				throw new ToolError(
					`Invalid conflict URI '${raw}': use a Git 'ours', 'theirs', or 'base' scope, or an indexed 'side/<M>' or 'base/<M>' scope.`,
				);
			}
			scope = {
				role: scopeMatch[1] as ConflictScope["role"],
				index: Number.parseInt(scopeMatch[2]!, 10),
			};
		}
	}

	return recoveredPrefix !== undefined ? { id, scope, recoveredPrefix } : { id, scope };
}

/** Result of an exact marker-block replacement. */
export interface ConflictSplice {
	text: string;
}

/**
 * Locate the exact recorded marker block and replace it verbatim. Line numbers
 * are only a preferred anchor; content identity tolerates unrelated edits
 * earlier in the file without silently rewriting the supplied resolution.
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

	const hasFollowingLine = match.endIdx + 1 < lines.length;
	const normalizedReplacement = hasFollowingLine ? normalizeTrailingNewline(replacement) : replacement;
	let replacementLines = normalizedReplacement.split("\n").map(stripTrailingCr);
	// Round-trip fidelity for CRLF files: recorded sections are LF-normalized,
	// so re-apply \r to spliced lines when the matched region used CRLF. The
	// final replacement line only carries \r when another line follows it.
	if (lines[match.startIdx]!.endsWith("\r")) {
		// `hasFollowingLine` also preserves an intentional final EOL when the
		// conflict itself occupies an unterminated EOF.
		replacementLines = replacementLines.map((l, i) =>
			i < replacementLines.length - 1 || hasFollowingLine ? `${l}\r` : l,
		);
	}
	const next = [...lines.slice(0, match.startIdx), ...replacementLines, ...lines.slice(match.endIdx + 1)];
	return { text: next.join("\n") };
}

/** Reconstruct the recorded marker block as it should appear in the file. */
function buildRecordedRegion(entry: ConflictBlock): string[] {
	if (entry.rawLines) return [...entry.rawLines];
	const out: string[] = [];
	out.push(entry.oursLabel ? `<<<<<<< ${entry.oursLabel}` : "<<<<<<<");
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(entry.baseLabel ? `||||||| ${entry.baseLabel}` : "|||||||");
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(entry.theirsLabel ? `>>>>>>> ${entry.theirsLabel}` : ">>>>>>>");
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

function conflictSides(entry: ConflictEntry): ConflictSection[] {
	return (
		entry.sides ?? [
			{ label: entry.oursLabel, lines: entry.oursLines, startLine: entry.startLine + 1 },
			{ label: entry.theirsLabel, lines: entry.theirsLines, startLine: entry.separatorLine + 1 },
		]
	);
}

function conflictBases(entry: ConflictEntry): ConflictSection[] {
	if (entry.bases) return entry.bases;
	if (entry.baseLines === undefined) return [];
	return [{ label: entry.baseLabel, lines: entry.baseLines, startLine: (entry.baseLine ?? entry.startLine) + 1 }];
}

function usesGitConflictTerms(entry: ConflictEntry): boolean {
	if (entry.authority === "jj") return false;
	if (entry.authority === "git") return true;
	return (entry.style ?? "git") === "git";
}

const GIT_CONFLICT_TERMS: Readonly<Record<string, ConflictScope>> = {
	"@ours": { role: "side", index: 1 },
	"@theirs": { role: "side", index: 2 },
	"@base": { role: "base", index: 1 },
};

/** Expand Git named tokens or indexed Jujutsu term tokens. */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const sides = conflictSides(entry);
	const bases = conflictBases(entry);
	const out: string[] = [];
	for (const rawLine of content.split("\n")) {
		const line = stripTrailingCr(rawLine);
		if (line === "@both") {
			if (!usesGitConflictTerms(entry)) {
				throw new ToolError(`Conflict #${entry.id} is a Jujutsu conflict; combine indexed terms explicitly.`);
			}
			const first = sides[0]!.content ?? sides[0]!.lines.join("\n");
			const second = sides[1]!.content ?? sides[1]!.lines.join("\n");
			out.push(first + (first.endsWith("\n") || second.length === 0 ? "" : "\n") + second);
			continue;
		}
		const gitTerm = GIT_CONFLICT_TERMS[line];
		const indexed = line.match(/^@(side|base)\/([1-9]\d*)$/);
		const term =
			gitTerm ??
			(indexed
				? {
						role: indexed[1] as ConflictScope["role"],
						index: Number.parseInt(indexed[2]!, 10),
					}
				: undefined);
		if (!term) {
			out.push(rawLine);
			continue;
		}
		const { role, index } = term;
		const section = (role === "side" ? sides : bases)[index - 1];
		if (!section) {
			const count = role === "side" ? sides.length : bases.length;
			throw new ToolError(
				`Conflict #${entry.id} has ${count} ${role}${count === 1 ? "" : "s"}; \`@${role}/${index}\` is out of range.`,
			);
		}
		out.push(section.content ?? section.lines.join("\n"));
	}
	return out.join("\n");
}

/** Materialize a full marker block or one normalized conflict term. */
export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (!scope) return { lines: buildRecordedRegion(entry), startLine: entry.startLine };
	const sections = scope.role === "side" ? conflictSides(entry) : conflictBases(entry);
	const section = sections[scope.index - 1];
	if (!section) {
		throw new ToolError(
			`Conflict #${entry.id} has ${sections.length} ${scope.role}${sections.length === 1 ? "" : "s"}; ` +
				`\`conflict://${entry.id}/${scope.role}/${scope.index}\` is out of range.`,
		);
	}
	return { lines: [...section.lines], startLine: section.startLine };
}

const PREVIEW_SIDE_LINES = 6;

export interface FormatConflictWarningOptions {
	totalInFile?: number;
	displayPath?: string;
	scanTruncated?: boolean;
}

export function formatConflictWarning(
	entries: readonly ConflictEntry[],
	options: FormatConflictWarningOptions = {},
): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [""];
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
	const termNotice = usesGitConflictTerms(entries[0]!)
		? "NOTICE: Git terms use `/ours` / `/theirs` / `/base` and `@ours` / `@theirs` / `@base` / `@both`."
		: "NOTICE: Jujutsu terms use indexed `/side/<M>` / `/base/<M>` and `@side/<M>` / `@base/<M>`.";
	out.push(
		termNotice,
		'Write one block with `write({ path: "conflict://<N>", content })`, or bulk pick terms with `write({ path: "conflict://*", content: "1: <term>\\n2: <term>" })`. Writes replace only marker blocks; unlisted ids remain registered.',
	);

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const sides = conflictSides(entry);
		const bases = conflictBases(entry);
		out.push("", `──── #${entry.id}  ${range}  ${entry.style ?? "git"} ────`);
		if (usesGitConflictTerms(entry)) {
			const [ours, theirs] = sides;
			out.push(`<<< ours${ours?.label ? `  ${ours.label}` : ""}`);
			appendBody(out, ours?.lines ?? []);
			const base = bases[0];
			if (base) {
				out.push(`=== base${base.label ? `  ${base.label}` : ""}`);
				appendBody(out, base.lines);
			}
			out.push(`>>> theirs${theirs?.label ? `  ${theirs.label}` : ""}`);
			appendBody(out, theirs?.lines ?? []);
		} else {
			for (let i = 0; i < sides.length; i++) {
				const section = sides[i]!;
				out.push(`+++ side/${i + 1}${section.label ? `  ${section.label}` : ""}`);
				appendBody(out, section.lines);
			}
			for (let i = 0; i < bases.length; i++) {
				const section = bases[i]!;
				out.push(`--- base/${i + 1}${section.label ? `  ${section.label}` : ""}`);
				appendBody(out, section.lines);
			}
		}
	}
	return out.join("\n");
}

/** Render a one-line-per-hunk index for the `<path>:conflicts` selector. */
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
	const termNotice = usesGitConflictTerms(entries[0]!)
		? "NOTICE: Git uses `/ours` / `/theirs` / `/base`; resolve with `@ours` / `@theirs` / `@base` / `@both`."
		: "NOTICE: Jujutsu uses indexed `/side/<M>` / `/base/<M>`; resolve with `@side/<M>` / `@base/<M>`.";
	lines.push(
		termNotice,
		"Write one `conflict://<N>` block, or bulk-resolve with per-id `<id>: <term>` directives.",
		"",
	);
	const idWidth = String(entries[entries.length - 1]?.id ?? 1).length;
	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const idCell = `#${String(entry.id).padStart(idWidth, " ")}`;
		const sides = conflictSides(entry).length;
		const bases = conflictBases(entry).length;
		lines.push(
			`${idCell}  ${range}  (${sides} side${sides === 1 ? "" : "s"}, ${bases} base${bases === 1 ? "" : "s"}, ${entry.style ?? "git"})`,
		);
	}
	return lines.join("\n");
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
