import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type AstFindMatch, astGrep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { recordFileSnapshot, recordSeenLinesFromBody } from "../edit/file-snapshot-store";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import astGrepDescription from "../prompts/tools/ast-grep.md" with { type: "text" };
import { isScoutSpawnable } from "../task/spawn-policy";
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { materializeReadUrlToFile, parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { classifyGroupedLines, formatGroupedFiles, groupLineIndicesByBlank } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import type { OutputMeta } from "./output-meta";
import { resolveToolSearchScope, toPathList } from "./path-utils";
import { isRawSelector } from "./read-selector";
import {
	appendParseErrorsBulletList,
	capParseErrors,
	createCachedComponent,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatParseErrors,
	formatParseErrorsCountLabel,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astGrepSchema = type({
	pat: type("string").describe("ast pattern"),
	"path?": type("string").describe(
		'file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"skip?": type("number").describe("matches to skip"),
});

function compareAstFindMatch(left: AstFindMatch, right: AstFindMatch): number {
	const pathCmp = left.path.localeCompare(right.path);
	if (pathCmp !== 0) return pathCmp;
	if (left.startLine !== right.startLine) return left.startLine - right.startLine;
	if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
	if (left.endLine !== right.endLine) return left.endLine - right.endLine;
	if (left.endColumn !== right.endColumn) return left.endColumn - right.endColumn;
	if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
	return left.byteEnd - right.byteEnd;
}

function retainAstFindMatch(matches: AstFindMatch[], capacity: number, candidate: AstFindMatch): void {
	if (matches.length < capacity) {
		matches.push(candidate);
		return;
	}
	let worstIndex = 0;
	for (let index = 1; index < matches.length; index++) {
		if (compareAstFindMatch(matches[index]!, matches[worstIndex]!) > 0) {
			worstIndex = index;
		}
	}
	if (compareAstFindMatch(candidate, matches[worstIndex]!) < 0) {
		matches[worstIndex] = candidate;
	}
}

async function runMultiTargetAstGrep(
	targets: Array<{ basePath: string; glob?: string }>,
	options: { patterns: string[]; commonBasePath: string; skip: number; limit: number; signal?: AbortSignal },
): Promise<{
	matches: AstFindMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
}> {
	const retainedMatches: AstFindMatch[] = [];
	const retainedCapacity = options.skip + options.limit + 1;
	const parseErrors: string[] = [];
	let totalMatches = 0;
	let filesWithMatches = 0;
	let filesSearched = 0;
	let limitReached = false;
	for (const target of targets) {
		const targetResult = await astGrep({
			patterns: options.patterns,
			path: target.basePath,
			glob: target.glob,
			offset: 0,
			limit: options.skip + options.limit + 1,
			includeMeta: true,
			signal: options.signal,
		});
		totalMatches += targetResult.totalMatches;
		filesWithMatches += targetResult.filesWithMatches;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors);
		for (const match of targetResult.matches) {
			const absolute = path.resolve(target.basePath, match.path);
			const rebased = path.relative(options.commonBasePath, absolute).replace(/\\/g, "/");
			retainAstFindMatch(retainedMatches, retainedCapacity, { ...match, path: rebased });
		}
	}
	retainedMatches.sort(compareAstFindMatch);
	const visible = retainedMatches.slice(options.skip);
	const paged = visible.slice(0, options.limit);
	return {
		matches: paged,
		totalMatches,
		filesWithMatches,
		filesSearched,
		limitReached: limitReached || visible.length > options.limit,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

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

export class AstGrepTool implements AgentTool<typeof astGrepSchema, AstGrepToolDetails> {
	readonly name = "ast_grep";
	readonly approval = "read" as const;
	readonly label = "AST Grep";
	readonly summary = "Search code with AST patterns (structural grep)";
	get description(): string {
		return prompt.render(astGrepDescription, {
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = astGrepSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof astGrepSchema.inferIn>[] = [
		{
			caption: "Search TypeScript files under src",
			call: { pat: "console.log($$$)", path: "src/**/*.ts" },
		},
		{
			caption: "Named imports from a specific package",
			call: { pat: 'import { $$$IMPORTS } from "react"', path: "src/**/*.ts" },
		},
		{
			caption: "Arrow functions assigned to a const",
			call: { pat: "const $NAME = ($$$ARGS) => $BODY", path: "src/utils/**/*.ts" },
		},
		{
			caption: "Method call on any object, ignoring method name with `$_`",
			call: { pat: "logger.$_($$$ARGS)", path: "src/**/*.ts" },
		},
		{
			caption: "Loosest existence check for a symbol in one file",
			call: { pat: "processItems", path: "src/worker.ts" },
		},
	];
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof astGrepSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstGrepToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstGrepToolDetails>> {
		return untilAborted(signal, async () => {
			const pattern = params.pat.trim();
			if (pattern.length === 0) {
				throw new ToolError("`pat` must be a non-empty pattern");
			}
			const patterns = [pattern];
			const skip = params.skip === undefined ? 0 : Math.floor(params.skip);
			if (!Number.isFinite(skip) || skip < 0) {
				throw new ToolError("skip must be a non-negative number");
			}
			const scopedPaths = toPathList(params.path);
			const rawPaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const scope = await resolveToolSearchScope({
				rawPaths,
				cwd: this.session.cwd,
				internalUrlAction: "search",
				settings: this.session.settings,
				signal,
				sessionFile: this.session.getSessionFile() ?? undefined,
				localProtocolOptions: this.session.localProtocolOptions,
				skills: this.session.skills,
				resolveExternalUrl: async rawPath => {
					const target = parseReadUrlTarget(rawPath);
					if (!target) return undefined;
					const materialized = await materializeReadUrlToFile(
						this.session,
						{ path: target.path, raw: isRawSelector(target.sel) },
						signal,
					);
					return { sourcePath: materialized.path, immutable: true };
				},
			});
			const { searchPath: resolvedSearchPath, scopePath, isDirectory, multiTargets, globFilter } = scope;

			const DEFAULT_AST_LIMIT = 50;
			const result = multiTargets
				? await runMultiTargetAstGrep(multiTargets, {
						patterns,
						commonBasePath: resolvedSearchPath,
						skip,
						limit: DEFAULT_AST_LIMIT,
						signal,
					})
				: await astGrep({
						patterns,
						path: resolvedSearchPath,
						glob: globFilter,
						offset: skip,
						includeMeta: true,
						signal,
					});

			const normalizedParseErrors = (result.parseErrors ?? []).map(error => {
				const parseError = error.match(/^.+: (.+: parse error \(syntax tree contains error nodes\))$/);
				return parseError?.[1] ?? error;
			});
			const { errors: cappedParseErrors, total: parseErrorsTotal } = capParseErrors(normalizedParseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			const matchesByFile = new Map<string, AstFindMatch[]>();
			for (const match of result.matches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}

			const baseDetails: AstGrepToolDetails = {
				matchCount: result.totalMatches,
				fileCount: result.filesWithMatches,
				filesSearched: result.filesSearched,
				limitReached: result.limitReached,
				...(cappedParseErrors.length > 0 ? { parseErrors: cappedParseErrors, parseErrorsTotal } : {}),
				scopePath,
				searchPath: resolvedSearchPath,
				cwd: this.session.cwd,
				files: fileList,
				fileMatches: [],
			};

			if (result.matches.length === 0) {
				const noMatchMessage = cappedParseErrors.length
					? "No matches found. Parse issues mean the query may be mis-scoped; narrow `path` before concluding absence."
					: "No matches found";
				const parseMessage = cappedParseErrors.length
					? `\n${formatParseErrors(cappedParseErrors, parseErrorsTotal).join("\n")}`
					: "";
				// Zero matches is useless even with parse issues: the follow-up
				// call has already corrected course by the time compaction runs.
				return toolResult(baseDetails).text(`${noMatchMessage}${parseMessage}`).useless().done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const hashContexts = new Map<string, { tag: string }>();
			if (useHashLines) {
				for (const relativePath of fileList) {
					const absolutePath = path.resolve(this.session.cwd, relativePath);
					// Whole-file content tag: any anchor validates while the file is
					// unchanged; over-cap / unreadable files get no tag (plain output).
					const tag = await recordFileSnapshot(this.session, absolutePath);
					if (tag) hashContexts.set(relativePath, { tag });
				}
			}
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const hashContext = hashContexts.get(relativePath);
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					const lineCount = match.text.split("\n").length;
					const endLine = match.startLine + lineCount - 1;
					return Math.max(width, String(match.startLine).length, String(endLine).length);
				}, 0);
				for (const match of fileMatches) {
					const matchLines = match.text.split("\n");
					for (let index = 0; index < matchLines.length; index++) {
						const lineNumber = match.startLine + index;
						const isMatch = index === 0;
						const line = matchLines[index] ?? "";
						modelOut.push(
							formatMatchLine(lineNumber, line, isMatch, { useHashLines: hashContext !== undefined }),
						);
						displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
					}
					if (match.metaVariables && Object.keys(match.metaVariables).length > 0) {
						const serializedMeta = Object.entries(match.metaVariables)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, value]) => `${key}=${value}`)
							.join(", ");
						modelOut.push(`  meta: ${serializedMeta}`);
						displayOut.push(`  meta: ${serializedMeta}`);
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
				if (hashContext?.tag) {
					const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
					recordSeenLinesFromBody(this.session, absoluteFilePath, hashContext.tag, modelOut.join("\n"));
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
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

			const details: AstGrepToolDetails = {
				...baseDetails,
				fileMatches: fileList.map(filePath => ({
					path: filePath,
					count: fileMatchCounts.get(filePath) ?? 0,
				})),
				displayContent: displayLines.join("\n"),
			};
			if (result.limitReached) {
				outputLines.push("", "Result limit reached; narrow path or increase limit.");
			}
			if (cappedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(cappedParseErrors, parseErrorsTotal));
			}

			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstGrepRenderArgs {
	pat?: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string[];
	skip?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

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
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", line);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (line.startsWith("  meta:")) return uiTheme.fg("dim", line);
			return uiTheme.fg("toolOutput", line);
		});
		const matchGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.map(index => styledLines[index]!));

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
						renderItem: group => group,
					},
					uiTheme,
				);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
