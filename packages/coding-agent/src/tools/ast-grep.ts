import type { AstGrepToolDetails } from "@oh-my-pi/pi-tui/tools/ast-grep";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type AstFindMatch, astGrep } from "@oh-my-pi/pi-natives";

import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { getEditStore } from "../edit/store";

import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";

import astGrepDescription from "../prompts/tools/ast-grep.md" with { type: "text" };
import { sessionDelegationBias } from "../task/prompt-policy";
import { isScoutSpawnable } from "../task/spawn-policy";

import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { materializeReadUrlToFile, parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { formatMatchLine } from "@oh-my-pi/pi-tui/tools/match-line-format";

import { resolveToolSearchScope } from "./path-utils";
import { toPathList } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRawSelector } from "./read-selector";
import { capParseErrors, formatCodeFrameLine, formatParseErrors } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

const astGrepSchema = type({
	pat: type("string").describe("ast pattern"),
	"path?": type("string").describe(
		'file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"lang?": type("string").describe("language override, e.g. cpp for ambiguous .h files"),
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
	options: {
		patterns: string[];
		commonBasePath: string;
		lang?: string;
		skip: number;
		limit: number;
		signal?: AbortSignal;
	},
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
			lang: options.lang,
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

export class AstGrepTool implements AgentTool<typeof astGrepSchema, AstGrepToolDetails> {
	readonly name = "ast_grep";
	readonly approval = "read" as const;
	readonly label = "AST Grep";
	readonly summary = "Search code with AST patterns (structural grep)";
	get description(): string {
		return prompt.render(astGrepDescription, {
			eagerDelegation: sessionDelegationBias(this.session) === "eager",
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
				sessionId: this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? undefined,
				agentRegistry: this.session.agentRegistry,
				localProtocolOptions: this.session.localProtocolOptions,
				skills: this.session.skills,
				rules: this.session.activeRules,
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
						lang: params.lang,
						commonBasePath: resolvedSearchPath,
						skip,
						limit: DEFAULT_AST_LIMIT,
						signal,
					})
				: await astGrep({
						patterns,
						lang: params.lang,
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
					const tag = getEditStore(this.session).recordSnapshotFile(absolutePath);
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
					getEditStore(this.session).recordSeenLinesFromBody(
						absoluteFilePath,
						hashContext.tag,
						modelOut.join("\n"),
					);
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
