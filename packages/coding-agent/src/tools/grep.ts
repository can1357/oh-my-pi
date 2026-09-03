import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type ArchiveReader,
	type ExtractedArchiveFile,
	openArchive,
	parseArchivePathCandidates,
} from "@oh-my-pi/pi-utils/ar";
import { getEditStore } from "../edit/store";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { formatHashlineHeader } from "./hashline-format";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { InternalUrlRouter } from "../internal-urls/router";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { Theme } from "../modes/theme/theme";
import grepDescription from "../prompts/tools/grep.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead, truncateLine } from "../session/streaming-output";
import { isScoutSpawnable } from "../task/spawn-policy";
import {
	Ellipsis,
	fileHyperlink,
	getTreeBranch,
	getTreeContinuePrefix,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
	tryResolveInternalUrlSync,
	uriHyperlink,
} from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { materializeReadUrlToFile, parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { classifyGroupedLines, formatGroupedFiles, groupLineIndicesByBlank } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import type { OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	hasGlobPathChars,
	isLineInRanges,
	type LineRange,
	parseLineRanges,
	pathTargetsSsh,
	type ResolvedSearchTarget,
	resolveReadPath,
	resolveToolSearchScope,
	selectorLineRanges,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
	toPathList,
} from "./path-utils";
import { isRawSelector } from "./read-selector";
import {
	createCachedComponent,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const searchPathEntry = type("string").describe(
	'file, directory, glob, internal URL, or "<file>:<lines>" selector to search (e.g. "src/foo.ts:50-100", "src/foo.ts:50+10", "src/foo.ts:50-100,200-300")',
);
const searchSchema = type({
	pattern: type("string").describe("regex pattern"),
	"path?": searchPathEntry.describe(
		'file, directory, glob, internal URL, or "<file>:<lines>" selector to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"case?": type("boolean").describe("case-sensitive search"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"skip?": type("number")
		.or("null")
		.describe("files to skip before collecting results — use to paginate when the prior call hit the file limit"),
});

export type GrepToolInput = typeof searchSchema.infer;

/** Maximum number of distinct files surfaced in a single response. The
 * agent paginates further pages via `skip`. */
export const DEFAULT_FILE_LIMIT = 20;
/** Per-file match cap for multi-file searches — keeps a single hot file
 * from crowding out diverse hits. Applied in JS after grep returns. */
export const MULTI_FILE_PER_FILE_MATCHES = 20;
/** Per-file match cap for single-file searches — there's no diversity
 * concern when the scope is one file. */
export const SINGLE_FILE_MATCHES = 200;
/** Hard safety ceiling on how many matches we fetch from native grep
 * before JS-side grouping. Sized to comfortably cover the file window
 * (DEFAULT_FILE_LIMIT files × MULTI_FILE_PER_FILE_MATCHES matches) plus
 * pagination headroom so the caller can see total file count. */
const INTERNAL_TOTAL_CAP = 2000;
/** Mirrors `MAX_FILE_BYTES` in `crates/pi-natives/src/grep.rs`. Native grep
 * searches only the first `MAX_FILE_BYTES` of a larger file (a leading mmap
 * window) and drops the rest; matches beyond the window are not returned. We
 * surface a partial-coverage note when the caller explicitly targeted such a
 * file so they know matches past the window are not shown. */
const NATIVE_GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Wall-clock budget for a single native grep invocation. Without it, an
 * aborted or runaway search (huge tree, network mount) keeps burning CPU on
 * the native thread pool after the JS promise is abandoned. */
const SEARCH_GREP_TIMEOUT_MS = 30_000;

/**
 * Parsed `paths` entry — a path (possibly archive-shaped) plus an optional
 * line-range selector peeled off the trailing `:N-M` (or `:N+K`, `:N,M`, …)
 * chunk via {@link splitPathAndSel}.
 */
interface GrepPathSpec {
	original: string;
	clean: string;
	literalFilesystemMatch?: boolean;
	ranges?: [LineRange, ...LineRange[]];
}

/**
 * Mirror of read's `parseSel` selector grammar (`read.ts`) so `grep` accepts
 * exactly the internal-URL selectors `read` accepts: a single chunk that is a
 * line range, `raw`, or `conflicts`; or a two-chunk compound of exactly one `raw`
 * plus one line range. Everything else (`:1-1:1-2`, `:conflicts:1-1`,
 * `:raw:conflicts`) is rejected. Read's `:-N` tail is rejected too: a tail is
 * only meaningful once the resource's line count is known, and search filters
 * matches by absolute line number.
 *
 * This mirrors the *accepted set* of `parseSel`; `read` rejects the same shapes
 * caller-side when a peeled internal-URL selector parses as `none`, so neither
 * tool silently widens on a malformed compound. Keep in sync with `read.parseSel`.
 */
function isReadSelectorGrammar(sel: string): boolean {
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length !== 2) return false;
		const [a, b] = chunks as [string, string];
		const aIsRaw = a.toLowerCase() === "raw";
		const bIsRaw = b.toLowerCase() === "raw";
		const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
		return rangeChunk !== null && parseLineRanges(rangeChunk) !== null;
	}
	const lower = sel.toLowerCase();
	return lower === "raw" || lower === "conflicts" || parseLineRanges(sel) !== null;
}

async function parsePathSpecs(rawEntries: readonly string[], cwd: string): Promise<GrepPathSpec[]> {
	const specs: GrepPathSpec[] = [];
	for (const entry of rawEntries) {
		// Internal URLs (`artifact://`, `skill://`, …) use the URL-aware splitter,
		// which peels selector-shaped tails only for selector-capable schemes and
		// leaves opaque ones (`mcp://`) intact. Unlike filesystem paths, their
		// verbatim/index display modes (`raw`, `conflicts`) carry no meaning for
		// content search, so we accept them — searching the whole resource — and
		// still honor any embedded line range as a match filter.
		const internalSplit = splitInternalUrlSel(entry);
		if (internalSplit.sel !== undefined) {
			// Reject selectors read's parseSel would reject (`:1-1:1-2`, `:conflicts:1-1`)
			// plus read-only tails (`:-10`) instead of silently widening the search or
			// dropping a chunk.
			if (!isReadSelectorGrammar(internalSplit.sel)) {
				throw new ToolError(
					`path entry "${entry}" has an invalid selector ":${internalSplit.sel}" — use ":N-M" line ranges, ":raw"/":conflicts", a range plus ":raw", or percent-encode a literal ":" as %3A`,
				);
			}
			specs.push({ original: entry, clean: internalSplit.path, ranges: selectorLineRanges(internalSplit.sel) });
			continue;
		}
		// Prefer a literal filesystem match when one exists — a real file named
		// `test:1-2` outranks the `:1-2` selector interpretation (issue #4618).
		const strictSplit = splitPathAndSel(entry);
		const split = await splitPathAndSelPreferringLiteral(entry, cwd);
		const literalFilesystemMatch = strictSplit.sel !== undefined && split.sel === undefined;
		let clean = literalFilesystemMatch ? resolveReadPath(entry, cwd) : entry;
		let ranges: [LineRange, ...LineRange[]] | undefined;
		if (!literalFilesystemMatch && split.sel) {
			const parsed = parseLineRanges(split.sel);
			if (!parsed) {
				throw new ToolError(
					`path entry "${entry}" — only line-range selectors like ":50-100" are supported (no ":raw"/":conflicts")`,
				);
			}
			if (hasGlobPathChars(split.path)) {
				throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
			}
			clean = split.path;
			ranges = parsed;
		}
		specs.push({
			original: entry,
			clean,
			literalFilesystemMatch,
			ranges,
		});
	}
	return specs;
}

function mergeRangesInto(map: Map<string, LineRange[]>, absKey: string, ranges: readonly LineRange[]): void {
	// Concat-without-merge is correct: `isLineInRanges` scans linearly, so
	// duplicates/overlaps only cost a few extra comparisons per match.
	const existing = map.get(absKey);
	if (existing) {
		existing.push(...ranges);
	} else {
		map.set(absKey, [...ranges]);
	}
}

function matchAbsolutePath(matchPath: string, searchPath: string): string {
	if (matchPath === "") return searchPath;
	if (path.isAbsolute(matchPath)) return matchPath;
	return path.resolve(searchPath, matchPath);
}

/**
 * Pre-resolve any `paths` entries that point at a member inside an archive
 * (e.g. `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md`). Native grep
 * cannot read archive members, so we materialize each text member to a
 * temp scratch file and substitute that path into the search inputs. After
 * grep returns, callers remap `match.path` back to the original
 * `archive:member` selector so it round-trips through the `read` tool.
 *
 * Returns the rewritten paths array (same length/order as input), a map
 * from absolute scratch path → original selector, a list of entries we
 * could not materialize (binary member, missing archive, etc.), and a
 * cleanup hook the caller MUST invoke in a `finally`.
 */
async function resolveArchiveSearchPaths(
	pathSpecs: readonly GrepPathSpec[],
	cwd: string,
): Promise<{
	resolvedPaths: string[];
	displayMap: Map<string, string>;
	displaySet: Set<string>;
	unreadable: string[];
	cleanup: () => Promise<void>;
}> {
	const resolvedPaths = pathSpecs.map(spec => spec.clean);
	const displayMap = new Map<string, string>();
	const displaySet = new Set<string>();
	const unreadable: string[] = [];
	let tempDir: string | undefined;
	const archiveCache = new Map<string, ArchiveReader>();

	for (let idx = 0; idx < pathSpecs.length; idx++) {
		const spec = pathSpecs[idx];
		if (!spec || spec.literalFilesystemMatch) continue;
		const entry = spec.clean;
		const candidates = parseArchivePathCandidates(entry);
		const member = candidates.find(c => c.subPath !== "" && c.archivePath !== entry);
		if (!member) continue;

		const archiveAbs = resolveReadPath(member.archivePath, cwd);
		let archive = archiveCache.get(archiveAbs);
		if (!archive) {
			try {
				archive = await openArchive(archiveAbs);
			} catch (err) {
				unreadable.push(`${entry} (cannot open archive: ${(err as Error).message})`);
				continue;
			}
			archiveCache.set(archiveAbs, archive);
		}

		let extracted: ExtractedArchiveFile;
		try {
			extracted = await archive.readFile(member.subPath);
		} catch (err) {
			unreadable.push(`${entry} (${(err as Error).message})`);
			continue;
		}
		// UTF-8 only — binary members would just produce noise through ripgrep.
		if (extracted.bytes.some(byte => byte === 0)) {
			unreadable.push(`${entry} (binary archive entry)`);
			continue;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(extracted.bytes);
		} catch {
			unreadable.push(`${entry} (non-UTF-8 archive entry)`);
			continue;
		}

		if (!tempDir) {
			tempDir = await mkdtemp(path.join(tmpdir(), "omp-search-archive-"));
		}
		// Per-entry filename keeps the scratch path unique even when two selectors
		// resolve to members with the same basename.
		const safeBase = path.basename(member.subPath).replace(/[^\w.-]+/g, "_") || "entry";
		const tempPath = path.join(tempDir, `${idx}-${safeBase}`);
		await writeFile(tempPath, text);
		resolvedPaths[idx] = tempPath;
		displayMap.set(tempPath, entry);
		displaySet.add(entry);
	}

	const cleanup = async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	};
	return { resolvedPaths, displayMap, displaySet, unreadable, cleanup };
}

interface VirtualSearchResource {
	path: string;
	content: string;
	ranges?: readonly LineRange[];
}

interface InternalSearchInputResolution {
	paths: string[];
	resolvedPathsByInput: string[];
	virtualResources: VirtualSearchResource[];
	virtualPathSet: Set<string>;
	virtualInputIndexes: Set<number>;
	immutableSourcePaths: Set<string>;
	virtualScopePath?: string;
}

function isImmutableSourcePath(filePath: string, immutableSourcePaths: ReadonlySet<string>): boolean {
	for (const immutablePath of immutableSourcePaths) {
		if (filePath === immutablePath || filePath.startsWith(`${immutablePath}${path.sep}`)) {
			return true;
		}
	}
	return false;
}

interface IndexedContentLines {
	lines: string[];
	starts: number[];
}

const OMP_ROOT_URL_RE = /^omp:\/\/(?:\/?|docs\/?)$/i;

function normalizeSearchLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function splitSearchLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map(normalizeSearchLine);
}

function indexSearchLines(content: string): IndexedContentLines {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	for (const rawLine of rawLines) {
		starts.push(offset);
		lines.push(normalizeSearchLine(rawLine));
		offset += rawLine.length + 1;
	}
	return { lines, starts };
}

function lineAllowed(lineNumber: number, ranges: readonly LineRange[] | undefined): boolean {
	return !ranges || isLineInRanges(lineNumber, ranges);
}

/**
 * Per-file native fetch budget that guarantees the JS range filter can still
 * surface `perFileKeep` in-range hits. Matches arrive one entry per matched
 * line in line order, so a bounded range's hits all sit within the first
 * `endLine` entries, and an open-ended range starting at S is preceded by at
 * most S-1 out-of-range entries — S-1+perFileKeep entries cover the kept
 * window or exhaust the file. Clamped to the native file-size ceiling (a
 * ≤4 MiB file cannot have more matched lines than bytes), which also keeps
 * the scaled global budget inside the native layer's u32 bounds.
 */
function lineRangeFetchCap(pathSpecs: readonly GrepPathSpec[], perFileKeep: number): number {
	let cap = 0;
	for (const spec of pathSpecs) {
		if (!spec.ranges) continue;
		for (const range of spec.ranges) {
			cap = Math.max(cap, range.endLine ?? range.startLine - 1 + perFileKeep);
		}
	}
	return Math.min(cap, NATIVE_GREP_MAX_FILE_BYTES);
}

/** Binary search for the index of the line containing byte `offset`. */
function findLineIndex(starts: readonly number[], offset: number): number {
	if (starts.length === 0) return -1;
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (starts[mid] <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(0, high);
}

/**
 * JS-`RegExp` fallback returning matched line indexes for a virtual resource too
 * large for native grep (>`NATIVE_GREP_MAX_FILE_BYTES`, which native grep silently
 * skips). Mirrors the native probe's output (sorted, deduped indexes) so
 * `buildVirtualMatches` rebuilds context/ranges identically; only the regex dialect
 * differs for these oversized inputs (the pre-RE2-parity behavior).
 */
function jsMatchedLineIndexes(
	content: string,
	lines: readonly string[],
	pattern: string,
	ignoreCase: boolean,
	multiline: boolean,
): number[] {
	const flags = `${ignoreCase ? "i" : ""}${multiline ? "gm" : ""}`;
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, flags);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(`Invalid regex: ${message.replace(/^Invalid regular expression:\s*/i, "")}`);
	}
	if (!multiline) {
		const out: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			regex.lastIndex = 0;
			if (regex.test(lines[i] ?? "")) out.push(i);
		}
		return out;
	}
	const { starts } = indexSearchLines(content);
	const seen = new Set<number>();
	const out: number[] = [];
	let match = regex.exec(content);
	while (match !== null) {
		const lineIndex = findLineIndex(starts, match.index);
		if (lineIndex >= 0 && !seen.has(lineIndex)) {
			seen.add(lineIndex);
			out.push(lineIndex);
		}
		if (match[0].length === 0) regex.lastIndex++;
		match = regex.exec(content);
	}
	out.sort((a, b) => a - b);
	return out;
}

/**
 * Native-grep an oversized (>NATIVE_GREP_MAX_FILE_BYTES) line-mode virtual resource
 * in line-boundary chunks (each <= the cap) so it keeps RE2 dialect parity instead of
 * the JS fallback. Each chunk's matched line numbers are offset by its starting line
 * index. A single line larger than the cap can't be native-grepped, so that one line
 * is JS-tested. Returns sorted 0-based line indexes.
 */
async function nativeChunkedLineIndexes(
	dir: string,
	resourceIdx: number,
	content: string,
	pattern: string,
	ignoreCase: boolean,
	signal: AbortSignal | undefined,
): Promise<number[]> {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	const indexes: number[] = [];
	let chunkStart = 0;
	let chunkBytes = 0;
	let chunkLines: string[] = [];
	let chunkSeq = 0;
	const flush = async (): Promise<void> => {
		if (chunkLines.length === 0) return;
		const scratch = path.resolve(dir, `${resourceIdx}-chunk-${chunkSeq++}`);
		await writeFile(scratch, chunkLines.join("\n"));
		const probe = await grep(
			{
				pattern,
				path: scratch,
				ignoreCase,
				multiline: false,
				hidden: true,
				gitignore: false,
				maxCount: chunkLines.length,
				contextBefore: 0,
				contextAfter: 0,
				maxColumns: DEFAULT_MAX_COLUMN,
				mode: GrepOutputMode.Content,
				signal,
				timeoutMs: SEARCH_GREP_TIMEOUT_MS,
			},
			undefined,
		);
		for (const match of probe.matches) indexes.push(chunkStart + match.lineNumber - 1);
		chunkLines = [];
		chunkBytes = 0;
	};
	let lineRegex: RegExp | undefined;
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (lineBytes > NATIVE_GREP_MAX_FILE_BYTES) {
			await flush();
			if (!lineRegex) {
				try {
					lineRegex = new RegExp(pattern, ignoreCase ? "i" : "");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new ToolError(`Invalid regex: ${message.replace(/^Invalid regular expression:\s*/i, "")}`);
				}
			}
			lineRegex.lastIndex = 0;
			if (lineRegex.test(line)) indexes.push(i);
			chunkStart = i + 1;
			continue;
		}
		if (chunkLines.length > 0 && chunkBytes + lineBytes > NATIVE_GREP_MAX_FILE_BYTES) {
			await flush();
			chunkStart = i;
		}
		if (chunkLines.length === 0) chunkStart = i;
		chunkLines.push(line);
		chunkBytes += lineBytes;
	}
	await flush();
	indexes.sort((a, b) => a - b);
	return indexes;
}

function makeContextLine(lines: readonly string[], lineIndex: number): { lineNumber: number; line: string } {
	const { text } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	return { lineNumber: lineIndex + 1, line: text };
}

function makeVirtualMatch(
	resource: VirtualSearchResource,
	lines: readonly string[],
	lineIndex: number,
	contextBefore: number,
	contextAfter: number,
	lastEmittedLine: number,
	nextMatchLine: number,
): GrepMatch {
	const lineNumber = lineIndex + 1;
	const { text, wasTruncated } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	const match: GrepMatch = {
		path: resource.path,
		lineNumber,
		line: text,
	};
	if (wasTruncated) match.truncated = true;

	if (contextBefore > 0) {
		const before: NonNullable<GrepMatch["contextBefore"]> = [];
		// Start after the previous match's last emitted line so adjacent matches
		// never repeat or rewind context lines (mirrors native grep's sink).
		const start = Math.max(0, lineIndex - contextBefore, lastEmittedLine);
		for (let idx = start; idx < lineIndex; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				before.push(makeContextLine(lines, idx));
			}
		}
		if (before.length > 0) match.contextBefore = before;
	}

	if (contextAfter > 0) {
		const after: NonNullable<GrepMatch["contextAfter"]> = [];
		// Stop before the next match line; it is emitted as a match itself.
		const end = Math.min(lines.length - 1, lineIndex + contextAfter, nextMatchLine - 2);
		for (let idx = lineIndex + 1; idx <= end; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				after.push(makeContextLine(lines, idx));
			}
		}
		if (after.length > 0) match.contextAfter = after;
	}

	return match;
}

/** Build matches for ascending matched line indexes with forward-only,
 * deduplicated context windows (line numbers never repeat or go backwards
 * within one resource). */
function buildVirtualMatches(
	resource: VirtualSearchResource,
	lines: readonly string[],
	matchedIndexes: readonly number[],
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
): GrepMatch[] {
	const matches: GrepMatch[] = [];
	let lastEmittedLine = 0;
	for (let i = 0; i < matchedIndexes.length && matches.length < maxCount; i++) {
		const lineIndex = matchedIndexes[i];
		const nextMatchLine = i + 1 < matchedIndexes.length ? matchedIndexes[i + 1] + 1 : Number.POSITIVE_INFINITY;
		const match = makeVirtualMatch(
			resource,
			lines,
			lineIndex,
			contextBefore,
			contextAfter,
			lastEmittedLine,
			nextMatchLine,
		);
		const after = match.contextAfter;
		lastEmittedLine = after && after.length > 0 ? after[after.length - 1].lineNumber : match.lineNumber;
		matches.push(match);
	}
	return matches;
}

async function searchVirtualResources(
	resources: readonly VirtualSearchResource[],
	pattern: string,
	ignoreCase: boolean,
	multiline: boolean,
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
	signal?: AbortSignal,
): Promise<GrepResult> {
	if (resources.length === 0) {
		return { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 0, limitReached: false };
	}
	const matches: GrepMatch[] = [];
	const filesWithMatches = new Set<string>();
	let totalMatches = 0;
	let limitReached = false;
	// Detect matched line numbers with native grep (RE2) — the SAME matcher local
	// search uses — so a pattern valid for local grep but not JS `RegExp` (`(?i)x`,
	// `[[:digit:]]`) behaves identically on virtual/remote resources. The JS helpers
	// below then rebuild the exact forward-only, range-trimmed context windows the
	// virtual-search contract requires.
	const dir = await mkdtemp(path.join(tmpdir(), "omp-search-virtual-"));
	try {
		for (let idx = 0; idx < resources.length; idx++) {
			const resource = resources[idx];
			const remaining = Math.max(maxCount - matches.length, 0);
			if (remaining === 0) {
				limitReached = true;
				break;
			}
			const lines = multiline ? indexSearchLines(resource.content).lines : splitSearchLines(resource.content);
			let matchedIndexes: number[];
			if (Buffer.byteLength(resource.content, "utf8") > NATIVE_GREP_MAX_FILE_BYTES) {
				// Native grep skips files above its 4 MiB cap. Search oversized content in
				// line-boundary chunks so line-mode keeps RE2 parity; multiline can't be chunked
				// without missing matches that span a chunk boundary, so it falls back to JS
				// (dialect-as-JS only for these oversized multiline inputs).
				matchedIndexes = (
					multiline
						? jsMatchedLineIndexes(resource.content, lines, pattern, ignoreCase, true)
						: await nativeChunkedLineIndexes(dir, idx, resource.content, pattern, ignoreCase, signal)
				).filter(lineIndex => lineAllowed(lineIndex + 1, resource.ranges));
			} else {
				const scratch = path.resolve(dir, `${idx}`);
				await writeFile(scratch, resource.content);
				const probe = await grep(
					{
						pattern,
						path: scratch,
						ignoreCase,
						multiline,
						hidden: true,
						gitignore: false,
						// A ranged selector must see every match so the range filter below never
						// drops in-range hits that fall after the cap; matches can't exceed the
						// line count. Unranged search keeps the overall result cap.
						maxCount: resource.ranges ? Math.max(lines.length, 1) : INTERNAL_TOTAL_CAP,
						contextBefore: 0,
						contextAfter: 0,
						maxColumns: DEFAULT_MAX_COLUMN,
						mode: GrepOutputMode.Content,
						signal,
						timeoutMs: SEARCH_GREP_TIMEOUT_MS,
					},
					undefined,
				);
				matchedIndexes = [...new Set(probe.matches.map(match => match.lineNumber - 1))]
					.filter(lineIndex => lineAllowed(lineIndex + 1, resource.ranges))
					.sort((a, b) => a - b);
			}
			const resourceMatches = buildVirtualMatches(
				resource,
				lines,
				matchedIndexes,
				contextBefore,
				contextAfter,
				remaining,
			);
			if (matchedIndexes.length > 0) filesWithMatches.add(resource.path);
			totalMatches += matchedIndexes.length;
			limitReached = limitReached || matchedIndexes.length > resourceMatches.length;
			matches.push(...resourceMatches);
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	return {
		matches,
		totalMatches,
		filesWithMatches: filesWithMatches.size,
		filesSearched: resources.length,
		limitReached,
	};
}

function mergeGrepResults(left: GrepResult, right: GrepResult, maxCount: number): GrepResult {
	if (left.matches.length === 0) return right;
	if (right.matches.length === 0) return left;
	const combinedMatches = [...left.matches, ...right.matches];
	const matches = combinedMatches.length > maxCount ? combinedMatches.slice(0, maxCount) : combinedMatches;
	return {
		matches,
		totalMatches: left.totalMatches + right.totalMatches,
		filesWithMatches: new Set(matches.map(match => match.path)).size,
		filesSearched: left.filesSearched + right.filesSearched,
		limitReached: left.limitReached || right.limitReached || matches.length < combinedMatches.length,
	};
}

async function expandVirtualInternalResource(
	rawPath: string,
	resource: InternalResource,
	internalRouter: InternalUrlRouter,
	context: ResolveContext,
	ranges: readonly LineRange[] | undefined,
): Promise<VirtualSearchResource[]> {
	if (OMP_ROOT_URL_RE.test(rawPath)) {
		const completions = await internalRouter.complete("omp", "");
		if (completions && completions.length > 0) {
			const resources: VirtualSearchResource[] = [];
			const seen = new Set<string>();
			for (const completion of completions) {
				if (seen.has(completion.value)) continue;
				seen.add(completion.value);
				const docUrl = `omp://${completion.value}`;
				const doc = await internalRouter.resolve(docUrl, context);
				if (!doc.sourcePath) {
					resources.push({ path: docUrl, content: doc.content, ranges });
				}
			}
			if (resources.length > 0) return resources;
		}
	}

	return [{ path: rawPath, content: resource.content, ranges }];
}

async function resolveInternalSearchInputs(opts: {
	pathSpecs: readonly GrepPathSpec[];
	resolvedPaths: string[];
	cwd: string;
	settings: unknown;
	signal?: AbortSignal;
	archiveDisplayMap: ReadonlyMap<string, string>;
	localProtocolOptions?: LocalProtocolOptions;
	skills?: ResolveContext["skills"];
	rules?: ResolveContext["rules"];
	sessionFile?: string;
}): Promise<InternalSearchInputResolution> {
	const internalRouter = InternalUrlRouter.instance();
	const paths = opts.resolvedPaths.slice();
	const virtualResources: VirtualSearchResource[] = [];
	const virtualPathSet = new Set<string>();
	const virtualInputIndexes = new Set<number>();
	const immutableSourcePaths = new Set<string>();
	let virtualScopePath: string | undefined;
	const context: ResolveContext = {
		cwd: opts.cwd,
		settings: opts.settings,
		signal: opts.signal,
		sessionFile: opts.sessionFile,
		localProtocolOptions: opts.localProtocolOptions,
		skills: opts.skills,
		rules: opts.rules,
		skipDirectoryListing: true,
		// Try path-only first so large artifacts (and any other handler that
		// separates path from content) resolve without materializing bytes.
		// Handlers that ignore the flag still return content, and virtual
		// resources without a sourcePath fall through to a second resolve.
		pathOnly: true,
	};

	for (let idx = 0; idx < paths.length; idx++) {
		const rawPath = paths[idx];
		if (!rawPath || opts.archiveDisplayMap.has(rawPath) || !internalRouter.canHandle(rawPath)) {
			continue;
		}
		// `ssh://[::1]/path` carries `[`/`]` in the IPv6 authority — glob metacharacters
		// — so check only the path portion for ssh:// (the SSH handler reads a single
		// remote file; there is no glob expansion). A glob in the remote path still trips.
		const globTarget = /^ssh:\/\//i.test(rawPath) ? rawPath.replace(/^ssh:\/\/[^/]*/i, "") : rawPath;
		if (hasGlobPathChars(globTarget)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		let resource = await internalRouter.resolve(rawPath, context);
		// A directory listing with no backing local path (e.g. a remote ssh:// dir)
		// has no real contents to grep — searching its listing text would be
		// misleading. Local/skill/vault dir resources set `sourcePath` and skip this.
		if (resource.isDirectory && !resource.sourcePath) {
			throw new ToolError(
				`grep cannot recurse the directory listing at ${rawPath}; grep a specific file under it (e.g. ${rawPath.replace(/\/+$/, "")}/<file>) or read ${rawPath} to list its entries`,
			);
		}
		if (resource.sourcePath) {
			paths[idx] = resource.sourcePath;
			if (resource.immutable) {
				immutableSourcePaths.add(path.resolve(resource.sourcePath));
			}
			continue;
		}

		// No sourcePath: this handler needs its content materialized so the
		// virtual expansion can search it. Re-resolve without pathOnly.
		if (context.pathOnly) {
			resource = await internalRouter.resolve(rawPath, { ...context, pathOnly: false });
		}

		const ranges = opts.pathSpecs[idx]?.ranges;
		const expanded = await expandVirtualInternalResource(
			rawPath,
			resource,
			internalRouter,
			{ ...context, pathOnly: false },
			ranges,
		);
		virtualInputIndexes.add(idx);
		for (const virtual of expanded) {
			virtualResources.push(virtual);
			virtualPathSet.add(virtual.path);
		}
		virtualScopePath = virtualScopePath ? `${virtualScopePath}, ${rawPath}` : rawPath;
	}

	return {
		resolvedPathsByInput: paths,
		paths: paths.filter((_, idx) => !virtualInputIndexes.has(idx)),
		virtualResources,
		virtualPathSet,
		virtualInputIndexes,
		immutableSourcePaths,
		virtualScopePath,
	};
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. The renderer resolves the display-relative
	 * (cwd-relative) header/match paths against this for OSC 8 hyperlinks;
	 * `searchPath` is the scope label target, not the display-path base. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

type SearchParams = typeof searchSchema.infer;

/**
 * Construction-time overrides for callers that are not the model.
 *
 * The model-facing schema deliberately does not grow these: they exist for
 * wire bridges (the Cursor `pi_grep` frame) whose protocol carries an explicit
 * context width and total match cap, and which would otherwise have to drop
 * them. Unset means "use the session settings / built-in caps" — the behavior
 * every model-issued call keeps.
 */
export interface GrepToolOptions {
	/** Overrides `grep.contextBefore`/`grep.contextAfter` for every call on this instance. */
	context?: number;
	/** Caps total surfaced matches. Applied on top of the built-in per-file and file-window caps, never above them. */
	totalMatchLimit?: number;
}

export class GrepTool implements AgentTool<typeof searchSchema, GrepToolDetails> {
	readonly name = "grep";
	readonly approval = (args: unknown): ToolTier => {
		const a = args as { path?: string | string[]; paths?: string | string[] };
		return toPathList(a.path ?? a.paths).some(pathTargetsSsh) ? "exec" : "read";
	};
	readonly label = "Grep";
	readonly loadMode = "discoverable";
	readonly summary = "Grep file contents using ripgrep (fast regex search)";
	get description(): string {
		const displayMode = resolveFileDisplayMode(this.session);
		return prompt.render(grepDescription, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = searchSchema;
	readonly strict = true;

	readonly #contextOverride?: number;
	readonly #totalMatchLimit?: number;

	constructor(
		private readonly session: ToolSession,
		options?: GrepToolOptions,
	) {
		const context = options?.context;
		this.#contextOverride = context !== undefined ? Math.max(0, Math.floor(context)) : undefined;
		const total = options?.totalMatchLimit;
		this.#totalMatchLimit = total !== undefined ? Math.max(1, Math.floor(total)) : undefined;
	}

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrepToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const { pattern, path: rawPath, case: caseSensitive, gitignore, skip } = params;

		return untilAborted(signal, async () => {
			// Preserve the pattern verbatim — leading/trailing whitespace is
			// meaningful in regexes (indentation anchors, trailing-space matches).
			if (!pattern.trim()) {
				throw new ToolError("Pattern must not be empty");
			}
			const normalizedPattern = pattern;

			const normalizedSkip =
				skip === undefined || skip === null ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
			if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
				throw new ToolError("Skip must be a non-negative number");
			}
			const scopedPaths = toPathList(rawPath);
			const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const rawEntries = await expandDelimitedPathEntries(effectivePaths, this.session.cwd);
			const pathSpecs = await parsePathSpecs(rawEntries, this.session.cwd);
			const materializedExternalPaths = new Map<string, string>();
			const materializeExternalUrlForSearch = async (rawPath: string) => {
				const target = parseReadUrlTarget(rawPath);
				if (!target) return undefined;
				const materialized = await materializeReadUrlToFile(
					this.session,
					{ path: target.path, raw: isRawSelector(target.sel) },
					signal,
				);
				materializedExternalPaths.set(rawPath, materialized.path);
				return { sourcePath: materialized.path, immutable: true };
			};
			const {
				resolvedPaths,
				displayMap: archiveDisplayMap,
				displaySet: archiveDisplaySet,
				unreadable: archiveUnreadable,
				cleanup: cleanupArchiveScratch,
			} = await resolveArchiveSearchPaths(pathSpecs, this.session.cwd);
			try {
				const internalResolution = await resolveInternalSearchInputs({
					pathSpecs,
					resolvedPaths,
					cwd: this.session.cwd,
					archiveDisplayMap,
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
					rules: this.session.activeRules,
					sessionFile: this.session.getSessionFile() ?? undefined,
				});
				const searchablePaths = internalResolution.paths;
				const { virtualResources, virtualPathSet, virtualInputIndexes } = internalResolution;
				const rangesByAbsPath = new Map<string, LineRange[]>();

				if (
					archiveUnreadable.length > 0 &&
					searchablePaths.length === archiveUnreadable.length &&
					virtualResources.length === 0
				) {
					// All inputs were archive selectors we couldn't materialize; surface the
					// reason instead of a downstream "path not found" from the scope resolver.
					throw new ToolError(
						`Cannot search archive member(s): ${archiveUnreadable.join(", ")}. ` +
							`Read the member with \`read <archive>:<member>\` and inspect the returned text, ` +
							`or pass a UTF-8 text member.`,
					);
				}
				const normalizedContextBefore = this.#contextOverride ?? this.session.settings.get("grep.contextBefore");
				const normalizedContextAfter = this.#contextOverride ?? this.session.settings.get("grep.contextAfter");
				const ignoreCase = !(caseSensitive ?? true);
				const useGitignore = gitignore ?? true;
				const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
				const effectiveMultiline = patternHasNewline;

				let searchPath: string;
				let scopePath: string;
				let globFilter: string | undefined;
				let isDirectory: boolean;
				let multiTargets: ResolvedSearchTarget[] | undefined;
				let exactFilePaths: string[] | undefined;
				let missingPaths: string[];
				const immutableSourcePaths = new Set(internalResolution.immutableSourcePaths);
				if (searchablePaths.length > 0) {
					const scope = await resolveToolSearchScope({
						rawPaths: searchablePaths,
						cwd: this.session.cwd,
						internalUrlAction: "search",
						settings: this.session.settings,
						localProtocolOptions: this.session.localProtocolOptions,
						skills: this.session.skills,
						rules: this.session.activeRules,
						sessionFile: this.session.getSessionFile() ?? undefined,
						resolveExternalUrl: materializeExternalUrlForSearch,
						trackImmutableSources: true,
						surfaceExactFilePaths: true,
						fanOutFileTargets: true,
						multipathStatHint: " (`path` list entries must each exist relative to cwd)",
					});
					searchPath = scope.searchPath;
					isDirectory = scope.isDirectory;
					multiTargets = scope.multiTargets;
					exactFilePaths = scope.exactFilePaths;
					missingPaths = scope.missingPaths;
					globFilter = scope.globFilter;
					for (const immutablePath of scope.immutableSourcePaths) {
						immutableSourcePaths.add(immutablePath);
					}
					// Build the per-file line-range filter after URL materialization has run:
					// archive entries are keyed by scratch path, URL entries by read-cache
					// content path, and ordinary files by their resolved filesystem path.
					for (let idx = 0; idx < pathSpecs.length; idx++) {
						const spec = pathSpecs[idx];
						if (!spec.ranges) continue;
						if (virtualInputIndexes.has(idx)) continue;
						const resolved = internalResolution.resolvedPathsByInput[idx];
						if (!resolved) continue;
						const materializedExternalPath = materializedExternalPaths.get(spec.clean);
						if (materializedExternalPath) {
							mergeRangesInto(rangesByAbsPath, path.resolve(materializedExternalPath), spec.ranges);
							continue;
						}
						if (resolved === spec.clean && !archiveDisplayMap.has(resolved)) {
							// Non-archive entry; ensure the cleaned path resolves to a regular file.
							const absKey = path.resolve(resolveReadPath(resolved, this.session.cwd));
							const stats = await stat(absKey).catch(() => null);
							if (!stats) {
								throw new ToolError(`Path not found for line-range selector: ${spec.original}`);
							}
							if (!stats.isFile()) {
								throw new ToolError(
									`Line-range selector requires a single file: ${spec.original} is a directory`,
								);
							}
							mergeRangesInto(rangesByAbsPath, absKey, spec.ranges);
						} else {
							mergeRangesInto(rangesByAbsPath, path.resolve(resolved), spec.ranges);
						}
					}
					// When the only input was an archive selector, surface that selector instead
					// of the temp scratch path the resolver substituted in.
					const physicalScopePath =
						searchablePaths.length === 1 && archiveDisplayMap.get(searchPath)
							? (archiveDisplayMap.get(searchPath) as string)
							: scope.scopePath;
					scopePath = internalResolution.virtualScopePath
						? `${physicalScopePath}, ${internalResolution.virtualScopePath}`
						: physicalScopePath;
				} else {
					searchPath = this.session.cwd;
					scopePath = internalResolution.virtualScopePath ?? ".";
					globFilter = undefined;
					isDirectory = false;
					multiTargets = undefined;
					exactFilePaths = undefined;
					missingPaths = [];
				}
				if (
					missingPaths.length > 0 &&
					missingPaths.length === searchablePaths.length &&
					virtualResources.length === 0
				) {
					const archiveHint =
						archiveUnreadable.length > 0
							? ` (archive members were not searchable: ${archiveUnreadable.join(", ")})`
							: "";
					throw new ToolError(
						`Path not found: ${missingPaths.join(", ")}; list each target in the semicolon-delimited \`path\`${archiveHint}`,
					);
				}
				const baseDisplayMode = resolveFileDisplayMode(this.session);

				const effectiveOutputMode = GrepOutputMode.Content;
				const isMultiScope =
					isDirectory ||
					Boolean(exactFilePaths) ||
					Boolean(multiTargets) ||
					(virtualResources.length > 0 && (virtualResources.length > 1 || searchablePaths.length > 0));
				const perFileMatchCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;
				// Range filtering happens in JS after the native fetch, so out-of-range
				// matches consume fetch budget. Widen the per-file budget just enough
				// that filtering can still yield `perFileMatchCap` in-range hits, and
				// scale the global safety ceiling by the same amplification so ranged
				// searches keep the baseline file coverage while staying finite.
				const hasLineRangeFilters = pathSpecs.some(spec => spec.ranges);
				const nativeMaxCountPerFile = hasLineRangeFilters
					? Math.max(perFileMatchCap + 1, lineRangeFetchCap(pathSpecs, perFileMatchCap + 1))
					: perFileMatchCap + 1;
				const nativeMaxCount = hasLineRangeFilters
					? Math.ceil(INTERNAL_TOTAL_CAP / (perFileMatchCap + 1)) * nativeMaxCountPerFile
					: INTERNAL_TOTAL_CAP;

				// Run grep
				let result: GrepResult = {
					matches: [],
					totalMatches: 0,
					filesWithMatches: 0,
					filesSearched: 0,
					limitReached: false,
				};
				let skippedOversizedCount = 0;
				try {
					if (searchablePaths.length > 0) {
						if (exactFilePaths || multiTargets) {
							const matches: GrepMatch[] = [];
							const seenMatchKeys = new Set<string>();
							let limitReached = false;
							let totalMatches = 0;
							let filesSearched = 0;
							const targets = exactFilePaths
								? exactFilePaths.map(filePath => ({
										basePath: filePath,
										glob: undefined as string | undefined,
									}))
								: (multiTargets ?? []);
							for (const target of targets) {
								const targetResult = await grep(
									{
										pattern: normalizedPattern,
										path: target.basePath,
										glob: target.glob,
										ignoreCase,
										multiline: effectiveMultiline,
										hidden: true,
										gitignore: useGitignore,
										maxCount: nativeMaxCount,
										contextBefore: normalizedContextBefore,
										contextAfter: normalizedContextAfter,
										maxColumns: DEFAULT_MAX_COLUMN,
										mode: effectiveOutputMode,
										maxCountPerFile: nativeMaxCountPerFile,
										signal,
										timeoutMs: SEARCH_GREP_TIMEOUT_MS,
									},
									undefined,
								);
								skippedOversizedCount += targetResult.skippedOversized ?? 0;
								limitReached = limitReached || Boolean(targetResult.limitReached);
								totalMatches += targetResult.totalMatches;
								filesSearched += targetResult.filesSearched;
								for (const match of targetResult.matches) {
									const absolute = path.resolve(target.basePath, match.path);
									// Overlapping targets (a directory plus a file nested
									// inside it) surface the same physical line twice;
									// keep the first occurrence.
									const matchKey = `${absolute}\0${match.lineNumber}`;
									if (seenMatchKeys.has(matchKey)) {
										totalMatches = Math.max(0, totalMatches - 1);
										continue;
									}
									seenMatchKeys.add(matchKey);
									const rebased = path.relative(searchPath, absolute).replace(/\\/g, "/");
									matches.push({ ...match, path: rebased });
								}
							}
							result = {
								matches,
								totalMatches: exactFilePaths ? matches.length : totalMatches,
								filesWithMatches: new Set(matches.map(match => match.path)).size,
								filesSearched: exactFilePaths ? exactFilePaths.length : filesSearched,
								limitReached,
							};
						} else {
							result = await grep(
								{
									pattern: normalizedPattern,
									path: searchPath,
									glob: globFilter,
									ignoreCase,
									multiline: effectiveMultiline,
									hidden: true,
									gitignore: useGitignore,
									maxCount: nativeMaxCount,
									contextBefore: normalizedContextBefore,
									contextAfter: normalizedContextAfter,
									maxColumns: DEFAULT_MAX_COLUMN,
									mode: effectiveOutputMode,
									maxCountPerFile: nativeMaxCountPerFile,
									signal,
									timeoutMs: SEARCH_GREP_TIMEOUT_MS,
								},
								undefined,
							);
							skippedOversizedCount = result.skippedOversized ?? 0;
						}
					}
				} catch (err) {
					if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
						throw new ToolError(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
					}
					if (err instanceof Error && err.message.includes("Aborted: Timeout")) {
						throw new ToolError(
							`Grep timed out after ${SEARCH_GREP_TIMEOUT_MS / 1000}s; narrow paths or pattern, or scope with \`glob\` first`,
						);
					}
					throw err;
				}
				let virtualResult: GrepResult;
				try {
					virtualResult = await searchVirtualResources(
						virtualResources,
						normalizedPattern,
						ignoreCase,
						effectiveMultiline,
						normalizedContextBefore,
						normalizedContextAfter,
						INTERNAL_TOTAL_CAP,
						signal,
					);
				} catch (err) {
					if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
						throw new ToolError(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
					}
					if (err instanceof SyntaxError) {
						throw new ToolError(`Invalid regex: ${err.message}`);
					}
					throw err;
				}
				result = mergeGrepResults(result, virtualResult, nativeMaxCount);
				if (rangesByAbsPath.size > 0) {
					const filteredMatches: GrepMatch[] = [];
					for (const match of result.matches) {
						const abs = matchAbsolutePath(match.path, searchPath);
						const ranges = rangesByAbsPath.get(abs);
						if (!ranges) {
							// Path has no line-range constraint (e.g. a peer entry without `:N-M`).
							filteredMatches.push(match);
							continue;
						}
						if (!isLineInRanges(match.lineNumber, ranges)) continue;
						// Drop context lines that fall outside the allowed ranges; they would
						// otherwise leak content the caller explicitly excluded.
						const trimBefore = match.contextBefore?.filter(c => isLineInRanges(c.lineNumber, ranges));
						const trimAfter = match.contextAfter?.filter(c => isLineInRanges(c.lineNumber, ranges));
						filteredMatches.push({
							...match,
							contextBefore: trimBefore && trimBefore.length > 0 ? trimBefore : undefined,
							contextAfter: trimAfter && trimAfter.length > 0 ? trimAfter : undefined,
						});
					}
					result = {
						matches: filteredMatches,
						totalMatches: filteredMatches.length,
						filesWithMatches: new Set(filteredMatches.map(match => match.path)).size,
						filesSearched: result.filesSearched,
						limitReached: result.limitReached,
					};
				}
				if (archiveDisplayMap.size > 0) {
					for (const match of result.matches) {
						const abs = matchAbsolutePath(match.path, searchPath);
						const display = archiveDisplayMap.get(abs);
						if (display) match.path = display;
					}
				}

				const formatPath = (filePath: string): string =>
					archiveDisplaySet.has(filePath) || virtualPathSet.has(filePath)
						? filePath
						: formatResultPath(filePath, isDirectory, searchPath, this.session.cwd);

				// Group matches by file in encounter order. Detect per-file overflow
				// BEFORE truncation so the renderer can surface that a hot file was
				// trimmed for diversity.
				const fileOrder: string[] = [];
				const matchesByPath = new Map<string, GrepMatch[]>();
				for (const match of result.matches) {
					if (!matchesByPath.has(match.path)) {
						fileOrder.push(match.path);
						matchesByPath.set(match.path, []);
					}
					matchesByPath.get(match.path)!.push(match);
				}
				let perFileLimitReached = false;
				for (const file of fileOrder) {
					const list = matchesByPath.get(file)!;
					if (list.length > perFileMatchCap) {
						perFileLimitReached = true;
						list.length = perFileMatchCap;
					}
				}
				const totalFiles = fileOrder.length;
				// When native grep stopped at its internal cap, files past the cap were
				// never surfaced — the file total is only a lower bound.
				const totalFilesLabel = result.limitReached ? `${totalFiles}+` : `${totalFiles}`;
				// Single-file scopes can't paginate — there is one file by definition.
				const canPaginate = isMultiScope;
				const skipFiles = canPaginate ? Math.min(normalizedSkip, totalFiles) : 0;
				// A caller with a total match cap is not paginating: the cap bounds the
				// output, and the only consumer that sets one (`pi_grep`) has no `skip`
				// field to follow a "use skip=N" suggestion with. Windowing it to the
				// first 20 files would silently return fewer matches than it asked for
				// while reporting the cap as unreached.
				//
				// The window is cap+1 files, not cap: with one match per file, a cap
				// of N over exactly N files is complete, while over N+1 files it is
				// clipped — and only reading that extra file distinguishes the two.
				// The cap below then does the trimming and records that it bit, so
				// `match_limit_reached` reaches the frame set.
				const fileWindow = this.#totalMatchLimit !== undefined ? this.#totalMatchLimit + 1 : DEFAULT_FILE_LIMIT;
				const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + fileWindow) : fileOrder;
				const fileLimitReached = canPaginate && totalFiles > skipFiles + fileWindow;
				const selectedMatches: GrepMatch[] = [];
				let totalMatchLimitReached = false;
				if (windowFiles.length > 0) {
					const lists = windowFiles.map(file => matchesByPath.get(file) ?? []);
					// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
					const cursors = new Array<number>(lists.length).fill(0);
					let anyAdded = true;
					while (anyAdded) {
						anyAdded = false;
						for (let i = 0; i < lists.length; i++) {
							if (cursors[i] < lists[i].length) {
								selectedMatches.push(lists[i][cursors[i]++]);
								anyAdded = true;
							}
						}
					}
					// Round-robin above interleaves files for diversity, so the cap is
					// applied after selection rather than as a per-list bound: trimming
					// mid-rotation would silently favour whichever files sort first.
					const cap = this.#totalMatchLimit;
					if (cap !== undefined && selectedMatches.length > cap) {
						selectedMatches.length = cap;
						totalMatchLimitReached = true;
					}
				}
				const nextSkip = skipFiles + windowFiles.length;
				const limitMessage = fileLimitReached
					? `Showing files ${skipFiles + 1}-${nextSkip} of ${totalFilesLabel}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`
					: "";
				const { record: recordFile, list: fileList } = createFileRecorder();
				const fileMatchCounts = new Map<string, number>();
				// Detect explicit file targets that exceed the native grep size cap.
				// Native searches only their first NATIVE_GREP_MAX_FILE_BYTES; without
				// this note the caller might miss that matches beyond the window
				// (or "no matches") reflect partial coverage, not the whole file.
				const oversizedNote = await (async (): Promise<string | undefined> => {
					const explicitFileTargets: string[] = [];
					if (exactFilePaths) {
						explicitFileTargets.push(...exactFilePaths);
					} else if (searchablePaths.length > 0 && !isDirectory && !multiTargets) {
						explicitFileTargets.push(searchPath);
					}
					if (explicitFileTargets.length === 0) return undefined;
					const oversized: string[] = [];
					await Promise.all(
						explicitFileTargets.map(async target => {
							try {
								const st = await stat(target);
								if (st.isFile() && st.size > NATIVE_GREP_MAX_FILE_BYTES) {
									oversized.push(path.relative(this.session.cwd, target) || target);
								}
							} catch {
								// Stat failures here are surfaced by other code paths.
							}
						}),
					);
					if (oversized.length === 0) return undefined;
					const limitMb = Math.floor(NATIVE_GREP_MAX_FILE_BYTES / (1024 * 1024));
					return `Searched only the first ${limitMb}MB of large files (matches past the ${limitMb}MB window are not shown; use \`read\` for the rest): ${oversized.join(", ")}`;
				})();
				// Directory/multi-target scopes: native counts files it could not map
				// even a prefix of (rare mmap failures), but cannot name them.
				const oversizedScanNote =
					!oversizedNote && skippedOversizedCount > 0
						? `Skipped ${skippedOversizedCount} unreadable large file(s); target them directly with \`read\``
						: undefined;
				const archiveNote =
					archiveUnreadable.length > 0
						? `Skipped archive entries (search supports text members only): ${archiveUnreadable.join(", ")}`
						: undefined;
				// Suppress entries we already explained via archiveNote — they would otherwise
				// double up (the unreadable selector also failed the scope's existence check).
				const archiveUnreadablePaths = new Set(archiveUnreadable.map(s => s.replace(/ \(.*\)$/, "")));
				const missingPathsForNote = missingPaths.filter(p => !archiveUnreadablePaths.has(p));
				const missingPathsNote =
					missingPathsForNote.length > 0 ? `Skipped missing paths: ${missingPathsForNote.join(", ")}` : undefined;
				const warningNote =
					[missingPathsNote, archiveNote, oversizedNote, oversizedScanNote]
						.filter((s): s is string => Boolean(s))
						.join("\n") || undefined;
				if (selectedMatches.length === 0) {
					const details: GrepToolDetails = {
						scopePath,
						searchPath,
						cwd: this.session.cwd,
						matchCount: 0,
						fileCount: 0,
						files: [],
						truncated: false,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					const skipPastEnd = canPaginate && normalizedSkip > 0 && totalFiles > 0 && skipFiles >= totalFiles;
					const noMatchText = skipPastEnd
						? `No more results (${totalFilesLabel} files total; skip=${normalizedSkip} is past the end)`
						: "No matches found";
					const text = warningNote ? `${noMatchText}\n${warningNote}` : noMatchText;
					// Zero matches is useless regardless of warnings: by the time
					// compaction runs, the follow-up call has already corrected course.
					return toolResult(details).text(text).useless().done();
				}
				const outputLines: string[] = [];
				let linesTruncated = false;
				const matchesByFile = new Map<string, GrepMatch[]>();
				for (const match of selectedMatches) {
					const relativePath = formatPath(match.path);
					recordFile(relativePath);
					if (!matchesByFile.has(relativePath)) {
						matchesByFile.set(relativePath, []);
					}
					matchesByFile.get(relativePath)!.push(match);
				}
				const displayLines: string[] = [];
				const hashContexts = new Map<string, { tag: string }>();
				if (baseDisplayMode.hashLines) {
					for (const relativePath of fileList) {
						if (archiveDisplaySet.has(relativePath) || virtualPathSet.has(relativePath)) continue;
						const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
						if (isImmutableSourcePath(absoluteFilePath, immutableSourcePaths)) continue;
						// Mint a whole-file content tag so any anchor validates while the
						// file is unchanged; over-cap / unreadable files get no tag (and
						// therefore plain, non-editable line output).
						const tag = getEditStore(this.session).recordSnapshotFile(absoluteFilePath);
						if (tag) hashContexts.set(relativePath, { tag });
					}
				}
				const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
					const modelOut: string[] = [];
					const displayOut: string[] = [];
					const fileMatches = matchesByFile.get(relativePath) ?? [];
					const hashContext = hashContexts.get(relativePath);
					const useHashLines = hashContext !== undefined;
					const lineNumberWidth = fileMatches.reduce((width, match) => {
						let nextWidth = Math.max(width, String(match.lineNumber).length);
						for (const ctx of match.contextBefore ?? []) {
							nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
						}
						for (const ctx of match.contextAfter ?? []) {
							nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
						}
						return nextWidth;
					}, 0);
					let lastEmittedLine: number | undefined;
					const gutterPad = " ".repeat(lineNumberWidth + 1);
					for (const match of fileMatches) {
						const pushLine = (lineNumber: number, line: string, isMatch: boolean) => {
							if (lastEmittedLine !== undefined && lineNumber > lastEmittedLine + 1) {
								modelOut.push("...");
								displayOut.push(`${gutterPad}│...`);
							}
							modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
							displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
							lastEmittedLine = lineNumber;
						};
						if (match.contextBefore) {
							for (const ctx of match.contextBefore) {
								pushLine(ctx.lineNumber, ctx.line, false);
							}
						}
						pushLine(match.lineNumber, match.line, true);
						if (match.truncated) linesTruncated = true;
						if (match.contextAfter) {
							for (const ctx of match.contextAfter) {
								pushLine(ctx.lineNumber, ctx.line, false);
							}
						}
						fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
					}
					if (hashContext?.tag) {
						const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
						getEditStore(this.session).recordSeenLinesFromBody(
							absoluteFilePath,
							hashContext.tag,
							modelOut.join("\n"),
						);
					}
					return { model: modelOut, display: displayOut };
				};
				const useGroupedOutput = isDirectory || isMultiScope;
				if (useGroupedOutput) {
					const grouped = formatGroupedFiles(fileList, relativePath => {
						const rendered = renderMatchesForFile(relativePath);
						const hashContext = hashContexts.get(relativePath);
						return {
							modelLines: rendered.model,
							displayLines: rendered.display,
							headerSuffix: hashContext?.tag ? `#${hashContext.tag}` : "",
							skip: rendered.model.length === 0,
						};
					});
					outputLines.push(...grouped.model);
					displayLines.push(...grouped.display);
				} else {
					for (const relativePath of fileList) {
						const rendered = renderMatchesForFile(relativePath);
						if (rendered.model.length === 0) continue;
						if (outputLines.length > 0) {
							outputLines.push("");
							displayLines.push("");
						}
						const hashContext = hashContexts.get(relativePath);
						if (hashContext?.tag) {
							outputLines.push(formatHashlineHeader(relativePath, hashContext.tag));
						}
						outputLines.push(...rendered.model);
						displayLines.push(...rendered.display);
					}
				}
				if (limitMessage) {
					outputLines.push("", limitMessage);
				}
				if (warningNote) {
					outputLines.push("", warningNote);
				}
				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				const output = truncation.content;
				const displayText = displayLines.join("\n");
				const truncated = Boolean(
					fileLimitReached ||
					perFileLimitReached ||
					totalMatchLimitReached ||
					result.limitReached ||
					truncation.truncated ||
					linesTruncated,
				);
				const details: GrepToolDetails = {
					scopePath,
					searchPath,
					cwd: this.session.cwd,
					matchCount: selectedMatches.length,
					fileCount: fileList.length,
					files: fileList,
					fileMatches: fileList.map(path => ({
						path,
						count: fileMatchCounts.get(path) ?? 0,
					})),
					truncated,
					fileLimitReached: fileLimitReached ? fileWindow : undefined,
					perFileLimitReached: totalMatchLimitReached
						? this.#totalMatchLimit
						: perFileLimitReached
							? perFileMatchCap
							: undefined,
					displayContent: displayText,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};
				if (truncation.truncated) details.truncation = truncation;
				if (linesTruncated) details.linesTruncated = true;
				const resultBuilder = toolResult(details)
					.text(output)
					.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}
				return resultBuilder.done();
			} finally {
				await cleanupArchiveScratch();
			}
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GrepRenderArgs {
	pattern: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
/** Line budget for the expanded view. Larger than collapsed so expanding
 * reveals more matches with context, but still bounded so a single hot file
 * whose matches span the whole file can't dump its entire length. */
const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

function searchScopeMeta(details: GrepToolDetails | undefined): string | undefined {
	if (!details?.scopePath) return undefined;
	const label = details.searchPath ? fileHyperlink(details.searchPath, details.scopePath) : details.scopePath;
	return `in ${label}`;
}

function linkUrlLikeSearchHeader(raw: string, styled: string): { line: string; absPath?: string } {
	const resolvedPath = tryResolveInternalUrlSync(raw);
	if (resolvedPath) return { line: fileHyperlink(resolvedPath, styled), absPath: resolvedPath };
	return { line: uriHyperlink(raw, styled) };
}

function parseSearchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

interface RenderedSearchLine {
	raw: string;
	styled: string;
}

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

const URL_HEADER_PREFIX_RE = /^#+\s+/;

function renderSearchDisplayLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
	uiTheme: Theme,
): RenderedSearchLine[] {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	// `classifyGroupedLines` can't resolve internal URLs (TUI-only), so track the
	// resolved URL target here and use it for the body lines that follow.
	let urlFile: string | undefined;
	return lines.map((line, index) => {
		const ctx = contexts[index]!;
		if (ctx.kind === "dir") {
			urlFile = undefined;
			const styled = uiTheme.fg("accent", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		if (ctx.kind === "file") {
			if (ctx.isUrl) {
				const raw = line
					.replace(URL_HEADER_PREFIX_RE, "")
					.trimEnd()
					.replace(/\s+\([^)]*\)\s*$/, "");
				const linked = linkUrlLikeSearchHeader(raw, uiTheme.fg("accent", line));
				urlFile = linked.absPath;
				return { raw: line, styled: linked.line };
			}
			urlFile = undefined;
			// Root-level files keep the bright accent; nested file headers are dimmed.
			const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		const styled = uiTheme.fg("toolOutput", line);
		const lineNumber = parseSearchDisplayLineNumber(line);
		const filePath = ctx.filePath ?? urlFile;
		return {
			raw: line,
			styled: filePath && lineNumber !== undefined ? fileHyperlink(filePath, styled, { line: lineNumber }) : styled,
		};
	});
}

function compactSearchPreviewGroup(group: RenderedSearchLine[]): RenderedSearchLine[] {
	const compact = group.filter(line => isSearchHeaderLine(line.raw) || isSearchMatchLine(line.raw));
	return compact.length > 0 ? compact : group;
}

function countPreviewMatches(lines: readonly RenderedSearchLine[], hasMarkedMatches: boolean): number {
	if (hasMarkedMatches) return lines.reduce((count, line) => count + (isSearchMatchLine(line.raw) ? 1 : 0), 0);
	return lines.reduce((count, line) => count + (!isSearchHeaderLine(line.raw) && line.raw.length > 0 ? 1 : 0), 0);
}

function renderBudgetedSearchGroups(
	groups: RenderedSearchLine[][],
	maxLines: number,
	matchCount: number,
	uiTheme: Theme,
	compact: boolean,
): string[] {
	if (maxLines <= 0) return [];
	const renderedGroups = groups
		.map(group => (compact ? compactSearchPreviewGroup(group) : group))
		.filter(group => group.length > 0);
	if (renderedGroups.length === 0) return [];

	let totalLines = 0;
	let totalMarkedMatches = 0;
	let totalFallbackMatches = 0;
	for (const group of renderedGroups) {
		totalLines += group.length;
		totalMarkedMatches += countPreviewMatches(group, true);
		totalFallbackMatches += countPreviewMatches(group, false);
	}
	const hasMarkedMatches = totalMarkedMatches > 0;
	const needsSummary = totalLines > maxLines;
	const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
	const visibleGroups: RenderedSearchLine[][] = [];
	let visibleLineCount = 0;
	let visibleMatches = 0;
	for (const group of renderedGroups) {
		if (visibleLineCount >= contentBudget) break;
		const available = contentBudget - visibleLineCount;
		const take = Math.min(group.length, available);
		if (take <= 0) break;
		const visibleGroup = group.slice(0, take);
		visibleGroups.push(visibleGroup);
		visibleLineCount += visibleGroup.length;
		visibleMatches += countPreviewMatches(visibleGroup, hasMarkedMatches);
	}

	const totalMatches = hasMarkedMatches ? totalMarkedMatches : Math.max(matchCount, totalFallbackMatches);
	const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
	const hiddenLines = Math.max(totalLines - visibleLineCount, 0);
	const hasSummary = needsSummary && (hiddenMatches > 0 || hiddenLines > 0);
	const lines: string[] = [];
	for (let i = 0; i < visibleGroups.length; i++) {
		const group = visibleGroups[i]!;
		const isLast = !hasSummary && i === visibleGroups.length - 1;
		const prefix = `${uiTheme.fg("dim", getTreeBranch(isLast, uiTheme))} `;
		const continuePrefix = uiTheme.fg("dim", getTreeContinuePrefix(isLast, uiTheme));
		lines.push(`${prefix}${replaceTabs(group[0]!.styled)}`);
		for (let j = 1; j < group.length; j++) {
			lines.push(`${continuePrefix}${replaceTabs(group[j]!.styled)}`);
		}
	}
	if (hasSummary) {
		const hiddenLabel =
			hiddenMatches > 0 ? formatMoreItems(hiddenMatches, "match") : formatMoreItems(hiddenLines, "line");
		lines.push(`${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", hiddenLabel)}`);
	}
	return lines;
}

function grepStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const paths = toPathList(args.path ?? args.paths);
		const meta: string[] = [];
		if (paths.length) meta.push(`in ${paths.join(", ")}`);
		if (args.case === false) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Grep", titleColor: "toolTitle", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 1, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{
					iconOverride: grepStatusIcon(uiTheme),
					title: "Grep",
					titleColor: "toolTitle",
					description,
					meta: [formatCount("item", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const meta = ["0 matches"];
			const scopeMeta = searchScopeMeta(details);
			if (scopeMeta) meta.push(scopeMeta);
			const header = renderStatusLine(
				{ icon: "warning", title: "Grep", titleColor: "toolTitle", description: args?.pattern, meta },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		const scopeMeta = searchScopeMeta(details);
		if (scopeMeta) meta.push(scopeMeta);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: grepStatusIcon(uiTheme) }),
				title: "Grep",
				titleColor: "toolTitle",
				description,
				meta,
			},
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks once over the whole output so a nested directory stack
		// reconstructs correctly across blank-line group boundaries.
		// Header/match display paths are cwd-relative, so resolve them against cwd
		// (falling back to searchPath for legacy results that predate `cwd`); the
		// scoped file's absolute path seeds body lines in single-file searches.
		const renderedLines = renderSearchDisplayLines(
			allLines,
			details?.cwd ?? details?.searchPath,
			details?.searchPath,
			uiTheme,
		);
		const matchGroups = groupLineIndicesByBlank(allLines).map(indices => indices.map(i => renderedLines[i]!));

		const extraLines: string[] = [];
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const budget = Math.max(
					(options.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - extraLines.length,
					0,
				);
				const matchLines = renderBudgetedSearchGroups(matchGroups, budget, matchCount, uiTheme, !options.expanded);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
