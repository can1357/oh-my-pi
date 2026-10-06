import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	appendParseErrorsBulletList,
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatParseErrorsCountLabel,
	PREVIEW_LIMITS,
	toPathList,
} from "../render/render-utils";
import { classifyGroupedLines, describeGroupedOutput, groupLineIndicesByBlank } from "./grouped-file-output";
import { getLanguageFromPath } from "../lang-from-path";
import { code, compact, node, span } from "../native/describe";
import type { NativeChild } from "../native/node";
import { errorText, noteText, resultText, toolHead } from "./native-view";
import type { OutputMeta } from "./output-meta";
import type { NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";

/** Display metadata returned by ast-grep. */
export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter and `*` to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. Display header/match paths are cwd-relative, so
	 * the renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

interface AstGrepRenderArgs {
	pat?: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string[];
	skip?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/** Render AST grep calls and results. */
export const astGrepToolRenderer = {
	inline: true,
	renderCall(args: AstGrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		const scopePaths = toPathList(args.path ?? args.paths);
		if (scopePaths.length) meta.push(`in ${scopePaths.join(", ")}`);
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const description = args.pat ?? "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Grep", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstGrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (matchCount === 0) {
			const description = args?.pat;
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Grep", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (details?.parseErrors?.length) {
				lines.push(uiTheme.fg("warning", "Query may be mis-scoped; narrow `path` before concluding absence"));
				appendParseErrorsBulletList(lines, details.parseErrors, uiTheme, details.parseErrorsTotal);
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const description = args?.pat;
		const header = renderStatusLine(
			{
				...(limitReached
					? { icon: "warning" as const }
					: { iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")) }),
				title: "AST Grep",
				description,
				meta,
			},
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across the blank-line groups the tree list collapses by.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		// Style lazily: the collapsed tree list only renders the first few groups,
		// so a large result never styles/hyperlinks rows nobody sees.
		const styledLines: (string | undefined)[] = new Array(allLines.length);
		const styleLine = (index: number): string => {
			const cached = styledLines[index];
			if (cached !== undefined) return cached;
			const line = allLines[index]!;
			const ctx = contexts[index]!;
			let styled: string;
			if (ctx.kind === "dir") {
				const accent = uiTheme.fg("accent", line);
				styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, accent) : accent;
			} else if (ctx.kind === "file") {
				const tinted = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
				styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, tinted) : tinted;
			} else {
				styled = uiTheme.fg(line.startsWith("  meta:") ? "dim" : "toolOutput", line);
			}
			styledLines[index] = styled;
			return styled;
		};
		const matchGroups = groupLineIndicesByBlank(allLines).filter(indices => {
			const first = allLines[indices[0]!]!;
			return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
		});
		// Line offset at which each group starts. A collapsed tree list stops at the
		// first group that overflows its line budget, so groups starting at or past
		// the budget are never shown — hand it same-length placeholders instead of
		// styling them (renderTreeList only needs their line counts).
		const groupStarts: number[] = [];
		let groupStart = 0;
		for (const group of matchGroups) {
			groupStarts.push(groupStart);
			groupStart += group.length;
		}

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path or increase limit"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}

		return createCachedComponent(
			() => options.expanded,
			width => {
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded: options.expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: COLLAPSED_MATCH_LIMIT,
						itemType: "match",
						renderItem: (group, context) =>
							!options.expanded && groupStarts[context.index]! >= COLLAPSED_MATCH_LIMIT
								? new Array<string>(group.length).fill("")
								: group.map(styleLine),
					},
					uiTheme,
				);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	describeCall(args: AstGrepRenderArgs): NativeToolView {
		const meta: string[] = [];
		const scopePaths = toPathList(args.path ?? args.paths);
		if (scopePaths.length) meta.push(`in ${scopePaths.join(", ")}`);
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
		return { head: toolHead("AST Grep", span(args.pat ?? "?", "code"), ...meta) };
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: AstGrepRenderArgs,
	): NativeToolView {
		const details = result.details;
		const pattern = span(args?.pat ?? "?", "code");
		if (result.isError) {
			return {
				head: toolHead("AST Grep", pattern),
				tone: "error",
				body: [errorText(resultText(result) || "Unknown error")],
			};
		}
		const matchCount = details?.matchCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;
		const parseErrors = details?.parseErrors ?? [];
		const parseNote =
			parseErrors.length > 0
				? node(
						"section",
						{
							head: [span(formatParseErrorsCountLabel(parseErrors, details?.parseErrorsTotal), "warning")],
							collapsible: true,
							collapsed: true,
						},
						[code(parseErrors.join("\n"))],
						"parse-errors",
					)
				: undefined;
		if (matchCount === 0) {
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			return {
				head: toolHead("AST Grep", pattern, ...meta),
				tone: "warning",
				body: compact<NativeChild>([
					noteText("No matches found"),
					parseErrors.length > 0 &&
						noteText("Query may be mis-scoped; narrow `path` before concluding absence", "warning"),
					parseNote,
				]),
			};
		}
		const meta = [formatCount("match", matchCount), formatCount("file", details?.fileCount ?? 0)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		const head = toolHead("AST Grep", pattern, ...meta);
		if (limitReached) head.push(span(" limit reached", "warning"));
		const allLines = (details?.displayContent ?? resultText(result)).split("\n");
		const kept = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
			})
			.flatMap(indices => [...indices.map(index => allLines[index]!), ""]);
		return {
			head,
			body: compact<NativeChild>([
				...describeGroupedOutput(kept, { lang: getLanguageFromPath }),
				limitReached && noteText("limit reached; narrow path or increase limit", "warning"),
				parseNote,
			]),
			preview: { lines: COLLAPSED_MATCH_LIMIT },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstGrepRenderArgs, AstGrepToolDetails>;
