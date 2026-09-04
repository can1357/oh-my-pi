import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import * as natives from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatGroupedPaths, hasFsCode, isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { splitMemoryGlobPattern } from "../internal-urls/memory-protocol";
import type { Theme } from "../modes/theme/theme";
import globDescription from "../prompts/tools/glob.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import { sessionDelegationBias } from "../task/prompt-policy";
import { isScoutSpawnable } from "../task/spawn-policy";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isSshUrl,
	normalizePathLikeInput,
	parseFindPattern,
	partitionExistingPaths,
	resolveExplicitFindPatterns,
	resolveToCwd,
	toPathList,
} from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = type({
	"path?": type("string").describe(
		'glob, file, or directory to search — a single path or a semicolon-delimited list ("src/**/*.ts; test/**/*.ts"). Omitted -> searches the workspace root (".")',
	),
	"hidden?": type("boolean").describe("include hidden files"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"limit?": type("number").describe("max results"),
});

export type GlobToolInput = typeof findSchema.infer;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_GLOB_TIMEOUT_MS = 5000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface GlobToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: GlobOperations;
	/** Remap slash-only paths to the session cwd before root-search validation. */
	rootPathAlias?: boolean;
	/** Native glob binding. Override only in tests. */
	nativeGlob?: typeof natives.glob;
	/** Filesystem stat used before native scans. Override only in tests. */
	stat?: typeof fs.promises.stat;
	/** Native and user-facing scan timeout. Override only in tests. */
	timeoutMs?: number;
}

interface GlobTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}

interface NativePreparedTarget {
	target: GlobTarget;
	result?: Array<{ path: string; mtime: number }>;
}

export class GlobTool implements AgentTool<typeof findSchema, GlobToolDetails> {
	readonly name = "glob";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Glob";
	get description(): string {
		return prompt.render(globDescription, {
			eagerDelegation: sessionDelegationBias(this.session) === "eager",
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = findSchema;

	readonly examples: readonly ToolExample<typeof findSchema.infer>[] = [
		{
			caption: "Glob files",
			call: { path: "src/**/*.ts" },
		},
		{
			caption: "Multiple targets — semicolon-delimited list",
			call: { path: "src/**/*.ts; test/**/*.ts" },
		},
		{
			caption: "Glob gitignored files like .env",
			call: { path: ".env*", gitignore: false },
		},
		{
			caption: "Glob directories matching a name (returns both files and dirs; directories are suffixed with `/`)",
			call: { path: "**/tests" },
		},
	];
	readonly strict = true;

	readonly #customOps?: GlobOperations;
	readonly #rootPathAlias: boolean;
	readonly #nativeGlob: typeof natives.glob;
	readonly #stat: typeof fs.promises.stat;
	readonly #timeoutMs: number;

	constructor(
		private readonly session: ToolSession,
		options?: GlobToolOptions,
	) {
		this.#customOps = options?.operations;
		this.#rootPathAlias = options?.rootPathAlias === true;
		this.#nativeGlob = options?.nativeGlob ?? natives.glob;
		this.#stat = options?.stat ?? fs.promises.stat;
		this.#timeoutMs = options?.timeoutMs ?? DEFAULT_GLOB_TIMEOUT_MS;
		if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
			throw new TypeError("Glob timeout must be a positive number");
		}
	}

	async execute(
		_toolCallId: string,
		params: typeof findSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GlobToolDetails>> {
		const { path: pathInput, limit, hidden, gitignore } = params;

		throwIfAborted(signal);
		// Preparation still rejects immediately on caller abort. Once every
		// filesystem stat has settled, detach this proxy before launching native
		// scans so execute can drain each worker through the real caller signal.
		// Custom operations have no signal API and keep immediate abort coverage
		// for their entire execution.
		const preparationController = !this.#customOps?.glob && signal ? new AbortController() : undefined;
		const abortPreparation = (): void => preparationController?.abort();
		if (preparationController && signal) {
			signal.addEventListener("abort", abortPreparation, { once: true });
		}
		const immediateAbortSignal = this.#customOps?.glob ? signal : preparationController?.signal;
		const execution = untilAborted(immediateAbortSignal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const scopedPaths = toPathList(pathInput);
			const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const rawPatternInputs = this.#customOps
				? effectivePaths
				: await expandDelimitedPathEntries(effectivePaths, this.session.cwd, { splitter: parseFindPattern });
			const rawPatterns = rawPatternInputs.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			const aliasResolvedPatterns = this.#rootPathAlias
				? rawPatterns.map(pattern => (/^\/+$/.test(pattern) ? "." : pattern))
				: rawPatterns;
			if (aliasResolvedPatterns.some(pattern => /^\/+$/.test(pattern))) {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}
			const internalRouter = InternalUrlRouter.instance();
			const normalizedPatterns: string[] = [];
			for (const rawPattern of aliasResolvedPatterns) {
				if (!internalRouter.canHandle(rawPattern)) {
					normalizedPatterns.push(rawPattern);
					continue;
				}
				if (isSshUrl(rawPattern)) {
					throw new ToolError(
						`find cannot operate on a remote ssh:// path: ${rawPattern}. ssh:// has no local file to glob; use \`read ${rawPattern}\` to list or inspect the remote path.`,
					);
				}
				if (hasGlobPathChars(rawPattern)) {
					if (!/^memory:\/\//i.test(rawPattern)) {
						throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPattern}`);
					}
					const memoryGlob = splitMemoryGlobPattern(rawPattern);
					const resource = await internalRouter.resolve(memoryGlob.baseUrl, {
						cwd: this.session.cwd,
						settings: this.session.settings,
						signal,
						sessionFile: this.session.getSessionFile() ?? undefined,
						localProtocolOptions: this.session.localProtocolOptions,
						skills: this.session.skills,
						rules: this.session.activeRules,
						pathOnly: true,
					});
					if (!resource.sourcePath) {
						throw new ToolError(`Cannot find internal URL without a backing file: ${memoryGlob.baseUrl}`);
					}
					normalizedPatterns.push(
						path.join(resource.sourcePath.replace(/[*?[{]/g, "[$&]"), memoryGlob.globPattern),
					);
					continue;
				}
				const resource = await internalRouter.resolve(rawPattern, {
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					sessionFile: this.session.getSessionFile() ?? undefined,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
					rules: this.session.activeRules,
					pathOnly: true,
				});
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot find internal URL without a backing file: ${rawPattern}`);
				}
				normalizedPatterns.push(resource.sourcePath);
			}
			if (normalizedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`path` must contain non-empty globs or paths");
			}

			// Tolerate missing entries in a multi-path call: skip ones whose base
			// directory is gone, and only error if every entry is missing. Single
			// missing path keeps the original ENOENT semantics — the user explicitly
			// asked about that one path, so silent empty results would be misleading.
			let missingPaths: string[] = [];
			let effectivePatterns = normalizedPatterns;
			if (normalizedPatterns.length > 1 && !this.#customOps) {
				const partition = await partitionExistingPaths(normalizedPatterns, this.session.cwd, parseFindPattern);
				if (partition.valid.length === 0) {
					throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
				}
				effectivePatterns = partition.valid;
				missingPaths = partition.missing;
			}

			const multiPattern = await resolveExplicitFindPatterns(effectivePatterns, this.session.cwd);
			const isSingle = !multiPattern;
			const targets: GlobTarget[] = multiPattern
				? multiPattern.targets.map(target => ({
						searchPath: resolveToCwd(target.basePath, this.session.cwd),
						globPattern: target.globPattern,
						hasGlob: target.hasGlob,
					}))
				: [
						(() => {
							const parsed = parseFindPattern(effectivePatterns[0] ?? ".");
							return {
								searchPath: resolveToCwd(parsed.basePath, this.session.cwd),
								globPattern: parsed.globPattern,
								hasGlob: parsed.hasGlob,
							};
						})(),
					];
			const scopePath = multiPattern?.scopePath ?? formatScopePath(targets[0].searchPath);

			for (const target of targets) {
				if (target.searchPath === "/") {
					throw new ToolError("Searching from root directory '/' is not allowed");
				}
			}

			const requestedLimit = limit ?? DEFAULT_LIMIT;
			if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
			const includeHidden = hidden ?? true;
			const useGitignore = gitignore ?? true;
			const timeoutMs = this.#timeoutMs;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, base: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(base, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};

			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (
				files: string[],
				opts?: { notice?: string; forceTruncated?: boolean; timedOut?: boolean },
			): AgentToolResult<GlobToolDetails> => {
				const notice = opts?.notice;
				const forceTruncated = opts?.forceTruncated ?? false;
				if (files.length === 0) {
					const details: GlobToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: forceTruncated,
						cwd: this.session.cwd,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					// A timed-out empty result is an incomplete scan, not a verified
					// absence — never emit the definitive "No files found" claim next
					// to a timeout notice (the two statements contradict each other).
					const parts = opts?.timedOut ? [] : ["No files found matching pattern"];
					if (notice) parts.push(notice);
					if (missingPathsNote) parts.push(missingPathsNote);
					// Zero results is useless regardless of notices: the follow-up
					// call has already corrected course by the time compaction runs.
					return toolResult(details).text(parts.join("\n")).useless().done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = formatGroupedPaths(limited);
				const trailingNotes: string[] = [];
				if (notice) trailingNotes.push(notice);
				if (missingPathsNote) trailingNotes.push(missingPathsNote);
				const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: GlobToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(forceTruncated || limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					cwd: this.session.cwd,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			// Walk each user path as its own root and run the globs concurrently.
			// Collapsing multiple paths to a shared base would force the walker to
			// traverse and stat every unrelated sibling under that ancestor; per-path
			// roots keep each scan bounded to exactly what the user asked for.
			if (this.#customOps?.glob) {
				const customOps = this.#customOps;
				const perTarget = await Promise.all(
					targets.map(async target => {
						if (!(await customOps.exists(target.searchPath))) {
							if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
							return [] as string[];
						}
						if (!target.hasGlob && customOps.stat) {
							const stat = await customOps.stat(target.searchPath);
							if (stat.isFile()) return [formatScopePath(target.searchPath)];
						}
						const results = await customOps.glob(target.globPattern, target.searchPath, {
							ignore: ["**/node_modules/**", "**/.git/**"],
							limit: effectiveLimit,
						});
						return results.map(matchPath => formatMatchPath(matchPath, target.searchPath));
					}),
				);
				const seen = new Set<string>();
				const merged: string[] = [];
				for (const group of perTarget) {
					for (const entry of group) {
						if (seen.has(entry)) continue;
						seen.add(entry);
						merged.push(entry);
					}
				}
				return buildResult(merged);
			}

			const preparedTargets: NativePreparedTarget[] = await Promise.all(
				targets.map(async target => {
					throwIfAborted(signal);
					let stat: fs.Stats;
					try {
						stat = await this.#stat(target.searchPath);
					} catch (err) {
						// ENAMETOOLONG can never name a real target; surface a clean
						// "Path not found" instead of leaking the raw errno (issue #7597).
						if (isEnoent(err) || hasFsCode(err, "ENAMETOOLONG")) {
							if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
							return { target, result: [] };
						}
						throw err;
					}
					if (!target.hasGlob && stat.isFile()) {
						return {
							target,
							result: [{ path: formatScopePath(target.searchPath), mtime: stat.mtimeMs }],
						};
					}
					if (!stat.isDirectory()) {
						if (isSingle) throw new ToolError(`Path is not a directory: ${target.searchPath}`);
						return { target, result: [] };
					}
					return { target };
				}),
			);
			const nativeScanPending = preparedTargets.some(prepared => prepared.result === undefined);
			if (nativeScanPending && preparationController && signal) {
				signal.removeEventListener("abort", abortPreparation);
			}
			throwIfAborted(signal);

			const onUpdateMatches: string[] = [];
			const onUpdateMtimes: number[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: GlobToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const streamed = new Set<string>();
			const makeOnMatch =
				(base: string) =>
				(err: Error | null, match: natives.GlobMatch | null): void => {
					if (err || combinedSignal.aborted || !match?.path) return;
					const relativePath = formatMatchPath(match.path, base, match.fileType);
					if (streamed.has(relativePath)) return;
					streamed.add(relativePath);
					onUpdateMatches.push(relativePath);
					onUpdateMtimes.push(match.mtime ?? 0);
					emitUpdate();
				};

			let timedOut = false;
			const runTarget = async (prepared: NativePreparedTarget): Promise<Array<{ path: string; mtime: number }>> => {
				if (prepared.result) return prepared.result;
				const { target } = prepared;
				try {
					const result = await this.#nativeGlob(
						{
							pattern: target.globPattern,
							path: target.searchPath,
							hidden: includeHidden,
							maxResults: effectiveLimit,
							sortByMtime: true,
							gitignore: useGitignore,
							// parseFindPattern explicitly prepends "**/" when the user's
							// pattern begins with a glob (so `*.ts` becomes `**/*.ts`).
							// Anything that arrives here without "**/" was scoped to a
							// single directory by the user (e.g. `dir/*`); disable the
							// native auto-recursion so `dir/*` does not silently match
							// `dir/sub/nested.ts`.
							recursive: false,
							signal: combinedSignal,
							timeoutMs,
						},
						makeOnMatch(target.searchPath),
					);
					throwIfAborted(signal);
					const out: Array<{ path: string; mtime: number }> = [];
					for (const match of result.matches) {
						if (!match.path) continue;
						out.push({
							path: formatMatchPath(match.path, target.searchPath, match.fileType),
							mtime: match.mtime ?? 0,
						});
					}
					return out;
				} catch (error) {
					const nativeAbort =
						error instanceof Error &&
						(error.name === "AbortError" || error.name === "TimeoutError" || error.message.includes("Aborted:"));
					if (nativeAbort) {
						if (
							!signal?.aborted &&
							(timeoutSignal.aborted || (error instanceof Error && error.message.includes("Aborted: Timeout")))
						) {
							timedOut = true;
							return [];
						}
						throw new ToolAbortError();
					}
					throw error;
				}
			};

			const settledTargets = await Promise.allSettled(preparedTargets.map(runTarget));
			const perTarget = settledTargets.map(result => {
				if (result.status === "rejected") throw result.reason;
				return result.value;
			});

			if (timedOut) {
				// Drain the partial matches accumulated during streaming and return them
				// instead of throwing — empty results after a multi-second wait force the
				// caller to retry blind, which is the worst possible outcome.
				const partial = onUpdateMatches.map((entry, index) => ({ p: entry, m: onUpdateMtimes[index] ?? 0 }));
				partial.sort((a, b) => b.m - a.m);
				const sortedPaths = partial.map(entry => entry.p);
				const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
				// Walk cost tracks directory-tree size, not pattern specificity: a
				// mtime-ranked scan cannot early-exit, so a "narrow" pattern over a
				// huge tree still times out. Say so instead of implying the pattern
				// was too broad.
				const notice =
					sortedPaths.length > 0
						? `glob timed out after ${seconds}s; returning ${sortedPaths.length} partial matches — results are incomplete, scope to a deeper directory instead of retrying blindly`
						: `Glob timed out after ${seconds}s before finding any matches — the scan is incomplete, NOT proof of absence. The walk is bounded by directory size, not pattern width; scope the search to a deeper directory (e.g. \`sub/dir/*.ext\` instead of \`*.ext\` at a huge root).`;
				return buildResult(sortedPaths, { notice, forceTruncated: true, timedOut: true });
			}

			// Merge per-target results: native glob already ranks each target's own
			// matches by mtime and caps them at the limit, so a global mtime re-sort
			// plus dedup yields the correct top-N across all roots.
			const seen = new Set<string>();
			const merged: Array<{ path: string; mtime: number }> = [];
			for (const group of perTarget) {
				for (const entry of group) {
					if (seen.has(entry.path)) continue;
					seen.add(entry.path);
					merged.push(entry);
				}
			}
			merged.sort((a, b) => b.mtime - a.mtime);
			return buildResult(merged.map(entry => entry.path));
		});
		return execution.finally(() => {
			signal?.removeEventListener("abort", abortPreparation);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCount("file", lines.length)],
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
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? "No matches before timeout (scan incomplete)" : "No files found";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: truncated ? ["0 files", uiTheme.fg("warning", "timed out")] : ["0 files"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
