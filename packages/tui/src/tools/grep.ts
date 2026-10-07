import type { Component } from "../tui";
import { Text } from "../components/text";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";
import { getLanguageFromPath } from "../lang-from-path";
import { compact } from "../native/describe";
import type { NativeChild } from "../native/node";
import { footnoteText, inlineErrorView, resultText } from "./native-view";
import { type Theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { toPathList } from "../render/render-utils";
import {
	Ellipsis,
	fileHyperlink,
	getTreeBranch,
	getTreeContinuePrefix,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
	uriHyperlink,
} from "../render";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
} from "../render/render-utils";
import { classifyGroupedLines, describeGroupedOutput, groupLineIndicesByBlank } from "./grouped-file-output";

/** Display metadata for grep tool results. */
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
	/** Filesystem hyperlink targets resolved for internal URL headers at execution time. */
	displayTargets?: Record<string, string>;
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

/** Files a collapsed native grep shows (§7.3). */
const NATIVE_COLLAPSED_FILES = 2;

const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

function searchScopeMeta(details: GrepToolDetails | undefined): string | undefined {
	if (!details?.scopePath) return undefined;
	const label = details.searchPath ? fileHyperlink(details.searchPath, details.scopePath) : details.scopePath;
	return `in ${label}`;
}

function linkUrlLikeSearchHeader(
	raw: string,
	styled: string,
	resolvedPath?: string,
): { line: string; absPath?: string } {
	if (resolvedPath) return { line: fileHyperlink(resolvedPath, styled), absPath: resolvedPath };
	return { line: uriHyperlink(raw, styled) };
}

function parseSearchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

const URL_HEADER_PREFIX_RE = /^#+\s+/;

/**
 * Build a memoized per-line styler for search display output. Classification
 * and URL-target tracking walk the whole output once (nested directory stacks
 * span blank-line groups), but styling and hyperlinking run only for the rows
 * a preview actually shows.
 */
function createSearchLineStyler(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
	uiTheme: Theme,
	displayTargets: Record<string, string> | undefined,
): (index: number) => string {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	// `classifyGroupedLines` can't resolve internal URLs (TUI-only), so track the
	// resolved URL target here and use it for the body lines that follow.
	const urlRaw: (string | undefined)[] = new Array(lines.length);
	const urlFiles: (string | undefined)[] = new Array(lines.length);
	let urlFile: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const ctx = contexts[index]!;
		if (ctx.kind === "dir") {
			urlFile = undefined;
		} else if (ctx.kind === "file") {
			if (ctx.isUrl) {
				const raw = lines[index]!.replace(URL_HEADER_PREFIX_RE, "")
					.trimEnd()
					.replace(/\s+\([^)]*\)\s*$/, "");
				urlRaw[index] = raw;
				urlFile = displayTargets?.[raw];
			} else {
				urlFile = undefined;
			}
		} else {
			urlFiles[index] = urlFile;
		}
	}
	const styledLines: (string | undefined)[] = new Array(lines.length);
	return index => {
		const cached = styledLines[index];
		if (cached !== undefined) return cached;
		const line = lines[index]!;
		const ctx = contexts[index]!;
		let styled: string;
		if (ctx.kind === "dir") {
			const accent = uiTheme.fg("accent", line);
			styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, accent) : accent;
		} else if (ctx.kind === "file") {
			const raw = urlRaw[index];
			if (raw !== undefined) {
				styled = linkUrlLikeSearchHeader(raw, uiTheme.fg("accent", line), displayTargets?.[raw]).line;
			} else {
				// Root-level files keep the bright accent; nested file headers are dimmed.
				const tinted = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
				styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, tinted) : tinted;
			}
		} else {
			const tinted = uiTheme.fg("toolOutput", line);
			const lineNumber = parseSearchDisplayLineNumber(line);
			const filePath = ctx.filePath ?? urlFiles[index];
			styled = filePath && lineNumber !== undefined ? fileHyperlink(filePath, tinted, { line: lineNumber }) : tinted;
		}
		styledLines[index] = styled;
		return styled;
	};
}

function compactSearchPreviewGroup(group: readonly number[], lines: readonly string[]): readonly number[] {
	const compact = group.filter(index => isSearchHeaderLine(lines[index]!) || isSearchMatchLine(lines[index]!));
	return compact.length > 0 ? compact : group;
}

function countPreviewMatches(group: readonly number[], lines: readonly string[], hasMarkedMatches: boolean): number {
	let count = 0;
	for (const index of group) {
		const line = lines[index]!;
		if (hasMarkedMatches ? isSearchMatchLine(line) : !isSearchHeaderLine(line) && line.length > 0) count++;
	}
	return count;
}

function renderBudgetedSearchGroups(
	groups: readonly (readonly number[])[],
	lines: readonly string[],
	styleLine: (index: number) => string,
	maxLines: number,
	matchCount: number,
	uiTheme: Theme,
	compact: boolean,
): string[] {
	if (maxLines <= 0) return [];
	const renderedGroups = groups
		.map(group => (compact ? compactSearchPreviewGroup(group, lines) : group))
		.filter(group => group.length > 0);
	if (renderedGroups.length === 0) return [];

	let totalLines = 0;
	let totalMarkedMatches = 0;
	let totalFallbackMatches = 0;
	for (const group of renderedGroups) {
		totalLines += group.length;
		totalMarkedMatches += countPreviewMatches(group, lines, true);
		totalFallbackMatches += countPreviewMatches(group, lines, false);
	}
	const hasMarkedMatches = totalMarkedMatches > 0;
	const needsSummary = totalLines > maxLines;
	const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
	const visibleGroups: (readonly number[])[] = [];
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
		visibleMatches += countPreviewMatches(visibleGroup, lines, hasMarkedMatches);
	}

	const totalMatches = hasMarkedMatches ? totalMarkedMatches : Math.max(matchCount, totalFallbackMatches);
	const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
	const hiddenLines = Math.max(totalLines - visibleLineCount, 0);
	const hasSummary = needsSummary && (hiddenMatches > 0 || hiddenLines > 0);
	const out: string[] = [];
	for (let i = 0; i < visibleGroups.length; i++) {
		const group = visibleGroups[i]!;
		const isLast = !hasSummary && i === visibleGroups.length - 1;
		const prefix = `${uiTheme.fg("dim", getTreeBranch(isLast, uiTheme))} `;
		const continuePrefix = uiTheme.fg("dim", getTreeContinuePrefix(isLast, uiTheme));
		out.push(`${prefix}${replaceTabs(styleLine(group[0]!))}`);
		for (let j = 1; j < group.length; j++) {
			out.push(`${continuePrefix}${replaceTabs(styleLine(group[j]!))}`);
		}
	}
	if (hasSummary) {
		const hiddenLabel =
			hiddenMatches > 0 ? formatMoreItems(hiddenMatches, "match") : formatMoreItems(hiddenLines, "line");
		out.push(`${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", hiddenLabel)}`);
	}
	return out;
}

function grepStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

/** Render grep calls and results in the transcript. */
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
		const styleLine = createSearchLineStyler(
			allLines,
			details?.cwd ?? details?.searchPath,
			details?.searchPath,
			uiTheme,
			details?.displayTargets,
		);
		const matchGroups = groupLineIndicesByBlank(allLines);

		const extraLines: string[] = [];
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const budget = Math.max(
					(options.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - extraLines.length,
					0,
				);
				const matchLines = renderBudgetedSearchGroups(
					matchGroups,
					allLines,
					styleLine,
					budget,
					matchCount,
					uiTheme,
					!options.expanded,
				);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	describeCall(args: GrepRenderArgs): NativeToolView {
		return { tool: grepNativeHead(args), inline: true };
	},

	/**
	 * Inline (§7.3 grep): `Grep “pattern”  5 matches · 2 files  in src`, then
	 * the matches grouped by file; collapsed shows the first two files.
	 */
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		args?: GrepRenderArgs,
	): NativeToolView {
		const details = result.details;
		if (result.isError || details?.error) {
			return inlineErrorView(grepNativeHead(args), details?.error || resultText(result) || "Unknown error");
		}
		const textContent = details?.displayContent ?? resultText(result);
		const missing = details?.missingPaths ?? [];
		const missingNote = missing.length > 0 ? `skipped missing: ${missing.join(", ")}` : undefined;
		const scope = details?.scopePath ? `in ${details.scopePath}` : undefined;
		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;
		const matchCount = details?.matchCount ?? 0;
		if (
			(!hasDetailedData && (!textContent || textContent === "No matches found")) ||
			(hasDetailedData && matchCount === 0)
		) {
			const foot = footnoteText(compact([missingNote]));
			return {
				tool: grepNativeHead(args, compact(["0 matches", scope])),
				tone: "warning",
				inline: true,
				body: foot ? [foot] : undefined,
			};
		}
		const truncated = Boolean(
			details?.truncated || details?.meta?.truncation || details?.meta?.limits?.columnTruncated,
		);
		const fileCount = details?.fileCount ?? 0;
		const counts = hasDetailedData
			? `${formatCount("match", matchCount)} · ${formatCount("file", fileCount)}`
			: undefined;
		const head = grepNativeHead(args, compact([counts, scope]));
		const hiddenFiles = options.expanded ? 0 : Math.max(0, fileCount - NATIVE_COLLAPSED_FILES);
		const foot = footnoteText(
			compact([hiddenFiles > 0 && formatCount("more file", hiddenFiles), missingNote]),
			details?.meta,
		);
		return {
			tool: truncated ? { ...head, badges: [{ text: "truncated", tone: "warning" }] } : head,
			inline: true,
			body: compact<NativeChild>([
				...describeGroupedOutput(textContent.split("\n"), {
					lang: getLanguageFromPath,
					maxFiles: options.expanded ? undefined : NATIVE_COLLAPSED_FILES,
				}),
				foot,
			]),
			preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<GrepRenderArgs, GrepToolDetails>;

/** Native grep head: the pattern, then the result `meta` or, before a result, the scope/flag arguments. */
function grepNativeHead(args: GrepRenderArgs | undefined, meta?: readonly string[]): NativeToolHead {
	const parts = meta ? [...meta] : [];
	if (!meta && args) {
		const paths = toPathList(args.path ?? args.paths);
		if (paths.length) parts.push(`in ${paths.join(", ")}`);
		if (args.case === false) parts.push("case:insensitive");
		if (args.gitignore === false) parts.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) parts.push(`skip:${args.skip}`);
	}
	return { title: "Grep", target: args?.pattern || "?", targetKind: "pattern", meta: parts };
}
