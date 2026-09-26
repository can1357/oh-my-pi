import type { GrepToolDetails } from "@oh-my-pi/pi-tui/tools/grep";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type ArchiveReader,
	type ExtractedArchiveFile,
	openArchive,
	parseArchivePathCandidates,
} from "@oh-my-pi/pi-utils/ar";
import { getEditStore } from "../edit/store";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { sessionResolveContext } from "../internal-urls/context";
import { InternalUrlRouter } from "../internal-urls/router";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import grepDescription from "../prompts/tools/grep.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sessionDelegationBias } from "../task/prompt-policy";
import { isScoutSpawnable } from "../task/spawn-policy";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { resolveToolTier } from "./approval";
import { materializeReadUrlToFile, parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath, resultSnapshotPath } from "./file-recorder";
import { formatGroupedFiles } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { formatMatchLine } from "@oh-my-pi/pi-tui/tools/match-line-format";
import { isFindEnabled } from "./jfind";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isLineInRanges,
	probeLiteralPathExists,
	relativeSearchResultPath,
	resolveReadPath,
	resolveSearchResultPath,
	resolveToolSearchScope,
	splitPathAndSelPreferringLiteral,
} from "./path-utils";
import { type LineRange, parseLineRanges, selectorLineRanges } from "@oh-my-pi/pi-tui/tools/line-ranges";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { toPathList } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRawSelector } from "./read-selector";
import { formatCodeFrameLine } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

import { cfgGrepContextAfter, cfgGrepContextBefore } from "./settings";
import { cfgTaskDisabledAgents } from "../task/settings";

const searchSchema = type({
	pattern: type("string"),
	"path?": "string",
	"case?": "boolean",
	"gitignore?": "boolean",
	"skip?": type("number").or("string.integer.parse").or("null"),
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
	const router = InternalUrlRouter.instance();
	for (const entry of rawEntries) {
		// Internal URLs (single-slash aliases included) use the router's splitter,
		// which peels selector-shaped tails only for schemes declaring line
		// selectors and leaves opaque server-defined URIs intact. Unlike filesystem paths, their
		// verbatim/index display modes (`raw`, `conflicts`) carry no meaning for
		// content search, so we accept them — searching the whole resource — and
		// still honor any embedded line range as a match filter.
		const internalSplit = router.split(entry);
		if (internalSplit.sel !== undefined) {
			// Reject selectors read's parseSel would reject (`:1-1:1-2`, `:conflicts:1-1`)
			// plus read-only tails (`:-10`) instead of silently widening the search or
			// dropping a chunk.
			if (!isReadSelectorGrammar(internalSplit.sel)) {
				throw new ToolError(
					`path entry "${entry}" has an invalid selector ":${internalSplit.sel}" — use ":N-M" line ranges, ":raw"/":conflicts", a range plus ":raw", or percent-encode a literal ":" as %3A`,
				);
			}
			const ranges = selectorLineRanges(internalSplit.sel);
			if (ranges && router.isGlob(internalSplit.path)) {
				throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
			}
			specs.push({ original: entry, clean: internalSplit.path, ranges });
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
			if (hasGlobPathChars(split.path) && (await probeLiteralPathExists(split.path, cwd)) === "missing") {
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

function isImmutableSourcePath(filePath: string, immutableSourcePaths: ReadonlySet<string>): boolean {
	for (const immutablePath of immutableSourcePaths) {
		if (filePath === immutablePath || filePath.startsWith(`${immutablePath}${path.sep}`)) {
			return true;
		}
	}
	return false;
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
		// Substring scan over the raw entries: delimited lists are only split after approval.
		return InternalUrlRouter.instance().readTier(toPathList(a.path ?? a.paths).join("\n"));
	};
	readonly label = "Grep";
	readonly loadMode = "discoverable";
	readonly summary = "Search file contents by regex";
	get description(): string {
		const displayMode = resolveFileDisplayMode(this.session);
		return prompt.render(grepDescription, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
			hasFind: this.session.isToolActive?.("find") ?? isFindEnabled(this.session),
			eagerDelegation: sessionDelegationBias(this.session) === "eager",
			scoutAvailable: isScoutSpawnable(
				cfgTaskDisabledAgents.get(this.session.settings),
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
			const resolveContext = sessionResolveContext(this.session, { signal });
			// Internal URLs resolve inside the native search, bounded by the tier this call was approved at.
			const urlFilesystem = new InternalUrlFilesystem({
				context: resolveContext,
				tier: resolveToolTier(this, params),
			});
			const filesystem = urlFilesystem.shellFilesystem();
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
				const rangesByAbsPath = new Map<string, LineRange[]>();

				if (archiveUnreadable.length > 0 && resolvedPaths.length === archiveUnreadable.length) {
					// All inputs were archive selectors we couldn't materialize; surface the
					// reason instead of a downstream "path not found" from the scope resolver.
					throw new ToolError(
						`Cannot search archive member(s): ${archiveUnreadable.join(", ")}. ` +
							`Read the member with \`read <archive>:<member>\` and inspect the returned text, ` +
							`or pass a UTF-8 text member.`,
					);
				}
				const normalizedContextBefore = this.#contextOverride ?? cfgGrepContextBefore.get(this.session.settings);
				const normalizedContextAfter = this.#contextOverride ?? cfgGrepContextAfter.get(this.session.settings);
				const ignoreCase = !(caseSensitive ?? true);
				const useGitignore = gitignore ?? true;
				const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
				const effectiveMultiline = patternHasNewline;

				const scope = await resolveToolSearchScope({
					rawPaths: resolvedPaths,
					cwd: this.session.cwd,
					internalUrlAction: "search",
					filesystem: urlFilesystem,
					resolveExternalUrl: materializeExternalUrlForSearch,
					trackImmutableSources: true,
					surfaceExactFilePaths: true,
					fanOutFileTargets: true,
					multipathStatHint: " (`path` list entries must each exist relative to cwd)",
				});
				const { searchPath, isDirectory, multiTargets, exactFilePaths, missingPaths, globFilter } = scope;
				const immutableSourcePaths = scope.immutableSourcePaths;
				// Build the per-file line-range filter after URL materialization has run:
				// archive entries are keyed by scratch path, external URL entries by read-cache
				// content path, internal URLs by their URL, and ordinary files by their resolved path.
				const router = InternalUrlRouter.instance();
				for (let idx = 0; idx < pathSpecs.length; idx++) {
					const spec = pathSpecs[idx];
					if (!spec.ranges) continue;
					const resolved = resolvedPaths[idx];
					if (!resolved) continue;
					const materializedExternalPath = materializedExternalPaths.get(spec.clean);
					if (materializedExternalPath) {
						mergeRangesInto(rangesByAbsPath, path.resolve(materializedExternalPath), spec.ranges);
						continue;
					}
					if (resolved === spec.clean && !archiveDisplayMap.has(resolved)) {
						// Non-archive entry; ensure the cleaned path resolves to a regular file.
						const absKey = router.canHandle(resolved)
							? resolved
							: path.resolve(resolveReadPath(resolved, this.session.cwd));
						const stats = await urlFilesystem.stat(absKey).catch(() => null);
						if (!stats) {
							throw new ToolError(`Path not found for line-range selector: ${spec.original}`);
						}
						if (stats.type !== "file") {
							throw new ToolError(`Line-range selector requires a single file: ${spec.original} is a directory`);
						}
						mergeRangesInto(rangesByAbsPath, absKey, spec.ranges);
					} else {
						mergeRangesInto(rangesByAbsPath, path.resolve(resolved), spec.ranges);
					}
				}
				// When the only input was an archive selector, surface that selector instead
				// of the temp scratch path the resolver substituted in.
				const scopePath =
					resolvedPaths.length === 1 && archiveDisplayMap.get(searchPath)
						? (archiveDisplayMap.get(searchPath) as string)
						: scope.scopePath;
				if (missingPaths.length > 0 && missingPaths.length === resolvedPaths.length) {
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
				const isMultiScope = isDirectory || Boolean(exactFilePaths) || Boolean(multiTargets);
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
				// Scope globs are relative to their base path: `dir/*.go` must stay in
				// `dir`. Only a bare glob rooted at cwd (`*.ts`) matches at any depth.
				const cwdRoot = path.resolve(this.session.cwd);
				try {
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
									recursive: path.resolve(target.basePath) === cwdRoot,
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
									filesystem,
								},
								undefined,
							);
							skippedOversizedCount += targetResult.skippedOversized ?? 0;
							limitReached = limitReached || Boolean(targetResult.limitReached);
							totalMatches += targetResult.totalMatches;
							filesSearched += targetResult.filesSearched;
							for (const match of targetResult.matches) {
								const absolute = resolveSearchResultPath(target.basePath, match.path);
								// Overlapping targets (a directory plus a file nested
								// inside it) surface the same physical line twice;
								// keep the first occurrence.
								const matchKey = `${absolute}\0${match.lineNumber}`;
								if (seenMatchKeys.has(matchKey)) {
									totalMatches = Math.max(0, totalMatches - 1);
									continue;
								}
								seenMatchKeys.add(matchKey);
								matches.push({ ...match, path: relativeSearchResultPath(searchPath, absolute) });
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
								recursive: path.resolve(searchPath) === cwdRoot,
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
								filesystem,
							},
							undefined,
						);
						skippedOversizedCount = result.skippedOversized ?? 0;
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
				if (rangesByAbsPath.size > 0) {
					const filteredMatches: GrepMatch[] = [];
					for (const match of result.matches) {
						const abs = resolveSearchResultPath(searchPath, match.path);
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
						const display = archiveDisplayMap.get(resolveSearchResultPath(searchPath, match.path));
						if (display) match.path = display;
					}
				}

				const formatPath = (filePath: string): string =>
					archiveDisplaySet.has(filePath)
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
					} else if (!isDirectory && !multiTargets) {
						explicitFileTargets.push(searchPath);
					}
					if (explicitFileTargets.length === 0) return undefined;
					const oversized: string[] = [];
					await Promise.all(
						explicitFileTargets.map(async target => {
							try {
								const st = await urlFilesystem.stat(target);
								if (st.type === "file" && st.size > NATIVE_GREP_MAX_FILE_BYTES) {
									oversized.push(formatPathRelativeToCwd(target, this.session.cwd));
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
				const hashContexts = new Map<string, { tag: string; path: string }>();
				if (baseDisplayMode.hashLines) {
					for (const relativePath of fileList) {
						if (archiveDisplaySet.has(relativePath)) continue;
						// Immutable schemes get no host file; mutable URLs (`local://`) bind to their backing file.
						const snapshotPath = await resultSnapshotPath(relativePath, this.session.cwd, resolveContext);
						if (snapshotPath === undefined || isImmutableSourcePath(snapshotPath, immutableSourcePaths)) continue;
						// Mint a whole-file content tag so any anchor validates while the
						// file is unchanged; over-cap / unreadable files get no tag (and
						// therefore plain, non-editable line output).
						const tag = getEditStore(this.session).recordSnapshotFile(snapshotPath);
						if (tag) hashContexts.set(relativePath, { tag, path: snapshotPath });
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
						getEditStore(this.session).recordSeenLinesFromBody(
							hashContext.path,
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
				let displayTargets: Record<string, string> | undefined;
				for (const line of displayLines) {
					const header = /^#+\s+([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(line);
					if (!header) continue;
					const target = header[1]!.trimEnd().replace(/\s+\([^)]*\)\s*$/, "");
					const resolved = InternalUrlRouter.instance().locateSync(target);
					if (resolved) (displayTargets ??= {})[target] = resolved;
				}
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
					displayTargets,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};
				if (truncation.truncated) details.truncation = truncation;
				if (linesTruncated) details.linesTruncated = true;
				const resultBuilder = toolResult(details)
					.text(output)
					.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined, columnUnit: "bytes" });
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
