import type { Component } from "../tui";
import { Text } from "../components/text";
import { replaceTabs } from "../utils";
import type { Theme } from "../theme/theme";
import { Ellipsis, fileHyperlink, renderStatusLine, truncateToWidth } from "../render";
import { framedToolCard } from "../render/tool-card";
import {
	appendParseErrorsBulletList,
	formatCount,
	formatErrorDetail,
	formatMoreItems,
	formatParseErrorsCountLabel,
	PREVIEW_LIMITS,
} from "../render/render-utils";
import { classifyGroupedLines, groupLineIndicesByBlank } from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";
import { code, compact, diff, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { diffStatsMeta, displayPath, errorText, fileDiffSection, noteText, resultText, statsText } from "./native-view";
import { getLanguageFromPath } from "../lang-from-path";

/** Display metadata returned by ast-edit. */
export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter (no model-only hashline anchors). The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during the edit. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at edit time. Display header paths are cwd-relative, so the
	 * renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/**
 * Flatten change groups (line indices, styled on demand) into frame body
 * lines. Groups are separated by a blank line and carry no tree guides — the
 * frame border is the container, so nested `├─ │` gutters would just be
 * noise. Collapsed mode always shows at least the first group, then fills up
 * to `budget` lines before summarizing the rest as `… N more changes`.
 */
function buildChangeBody(
	groups: readonly (readonly number[])[],
	styleLine: (index: number) => string,
	expanded: boolean,
	budget: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	let shown = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const separator = shown > 0 ? 1 : 0;
		const remainingAfter = groups.length - (i + 1);
		const reserved = !expanded && remainingAfter > 0 ? 1 : 0;
		// Always emit the first group; budget only gates subsequent ones.
		if (!expanded && shown > 0 && lines.length + separator + group.length + reserved > budget) break;
		if (separator) lines.push("");
		for (const index of group) lines.push(styleLine(index));
		shown++;
	}
	const remaining = groups.length - shown;
	if (!expanded && remaining > 0) lines.push(theme.fg("muted", formatMoreItems(remaining, "change")));
	return lines;
}

/** One-line header preview of an AST pattern. `renderStatusLine` only flattens
 * CR/LF, so a multi-line tab-indented pattern would otherwise punch raw tabs
 * into the status line; collapse all whitespace runs to single spaces. */
function patternPreview(pat: string | undefined): string | undefined {
	const collapsed = pat?.replace(/\s+/g, " ").trim();
	return collapsed || undefined;
}

const AST_EDIT_HEADER_RE = /^(#+)\s+(.*)$/;
const AST_EDIT_CHANGE_LINE_RE = /^([+\- ])\s*(\d+)(?:│|[:|])(.*)$/;
const AST_EDIT_HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;

/** One file's proposed rewrite: its unified diff text and change counts. */
interface AstEditFileDiff {
	path: string;
	lines: string[];
	added: number;
	removed: number;
	lastOld?: number;
}

/**
 * Parse ast-edit display content (`# dir/`, `## file (N replacements)`,
 * `-12│old` / `+12│new`) into one unified diff per file.
 */
function parseAstEditChanges(lines: readonly string[]): AstEditFileDiff[] {
	const files: AstEditFileDiff[] = [];
	const dirs: string[] = [];
	let file: AstEditFileDiff | undefined;
	const flush = () => {
		if (file && file.lines.length > 0) files.push(file);
		file = undefined;
	};
	for (const line of lines) {
		const header = AST_EDIT_HEADER_RE.exec(line);
		if (header) {
			flush();
			const depth = header[1]!.length;
			const rest = header[2]!.trimEnd().replace(AST_EDIT_HEADER_SUFFIX_RE, "");
			dirs.length = depth - 1;
			if (rest.endsWith("/")) {
				dirs[depth - 1] = rest.slice(0, -1);
				continue;
			}
			const prefix = dirs.filter(Boolean).join("/");
			file = { path: prefix ? `${prefix}/${rest}` : rest, lines: [], added: 0, removed: 0 };
			continue;
		}
		if (!file || line.trim().length === 0) continue;
		const change = AST_EDIT_CHANGE_LINE_RE.exec(line);
		if (!change) continue;
		const lineNumber = Number.parseInt(change[2]!, 10);
		if (file.lastOld === undefined || lineNumber > file.lastOld + 1 || lineNumber < file.lastOld) {
			file.lines.push(`@@ -${lineNumber} +${lineNumber} @@`);
		}
		file.lastOld = lineNumber;
		if (change[1] === "+") file.added++;
		else if (change[1] === "-") file.removed++;
		file.lines.push(`${change[1]}${change[3]}`);
	}
	flush();
	return files;
}

/** A file's proposed rewrite as a `diff`: highlighted by the path's language, no path header. */
function astEditDiff(file: AstEditFileDiff): NativeNode {
	return diff(file.lines.join("\n"), { lang: getLanguageFromPath(file.path) });
}

/** The single rewrite pattern (`target:"pattern"`), or the rewrite count, for the head. */
function astEditPatternHead(args: AstEditRenderArgs | undefined): Pick<NativeToolHead, "target" | "targetKind"> {
	const rewriteCount = args?.ops?.length ?? 0;
	if (rewriteCount === 1) {
		const pattern = patternPreview(args?.ops?.[0]?.pat);
		return pattern ? { target: pattern, targetKind: "pattern" } : {};
	}
	return rewriteCount > 1 ? { target: `${rewriteCount} rewrites`, targetKind: "text" } : {};
}

/** Scope facts for the final quiet line: `in src · searched 12 files · limit reached; narrow path`. */
function astEditScopeStats(details: AstEditToolDetails | undefined): NativeNode | undefined {
	const parts: string[] = [];
	if (details?.scopePath) parts.push(`in ${details.scopePath}`);
	if (details?.filesSearched) parts.push(`searched ${formatCount("file", details.filesSearched)}`);
	if (details?.limitReached) parts.push("limit reached; narrow path");
	return statsText(parts);
}

/** Render AST edit calls and results. */
export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push(`${rewriteCount} rewrites`);

		const description =
			rewriteCount === 1 ? patternPreview(args.ops?.[0]?.pat) : rewriteCount ? `${rewriteCount} rewrites` : "?";
		const header = renderStatusLine({ icon: "pending", title: "AST Edit", description, meta }, uiTheme);
		// Pending call has no body yet — a lone status line is sleeker than an empty frame.
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			const header = renderStatusLine({ icon: "error", title: "AST Edit" }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: formatErrorDetail(errorText, uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (totalReplacements === 0) {
			const rewriteCount = args?.ops?.length ?? 0;
			const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;
			const meta = ["0 replacements"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Edit", description, meta }, uiTheme);
			// The "0 replacements" count already rides on the status line; only parse
			// errors are worth a body, so frame solely when there are some.
			const bodyLines: string[] = [];
			appendParseErrorsBulletList(bodyLines, details?.parseErrors, uiTheme, details?.parseErrorsTotal);
			if (bodyLines.length === 0) return new Text(header, 0, 0);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: bodyLines }],
				phase: "warning",
				borderColor: "borderMuted",
			}));
		}

		const summaryParts = [formatCount("replacement", totalReplacements), formatCount("file", filesTouched)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const rewriteCount = args?.ops?.length ?? 0;
		const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across the blank-line groups the tree list collapses by.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		// Style lazily: collapsed bodies show only the first groups.
		const styledLines: (string | undefined)[] = Array.from({ length: allLines.length }, () => undefined);
		const styleLine = (index: number): string => {
			const cached = styledLines[index];
			if (cached !== undefined) return cached;
			const ctx = contexts[index]!;
			// Swap the inner code-frame gutter `│` for a space so it does not nest a
			// second vertical bar inside the frame border.
			const display = replaceTabs(allLines[index]!.replace("│", " "));
			let styled: string;
			if (ctx.kind === "dir") {
				const accent = uiTheme.fg("accent", display);
				styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, accent) : accent;
			} else if (ctx.kind === "file") {
				const tinted = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", display);
				styled = ctx.headerPath ? fileHyperlink(ctx.headerPath, tinted) : tinted;
			} else if (display.startsWith("+")) {
				styled = uiTheme.fg("toolDiffAdded", display);
			} else if (display.startsWith("-")) {
				styled = uiTheme.fg("toolDiffRemoved", display);
			} else {
				styled = uiTheme.fg("toolOutput", display);
			}
			styledLines[index] = styled;
			return styled;
		};
		const changeGroups = groupLineIndicesByBlank(allLines).filter(indices => {
			const first = allLines[indices[0]!]!;
			return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
		});

		const badge = { label: "proposed", color: "warning" as const };
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Edit", description, badge, meta },
			uiTheme,
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}
		// The body is spinner-invariant: rebuild it only on expansion/width change.
		let bodyMemo: { expanded: boolean; width: number; lines: readonly string[] } | undefined;
		return framedToolCard(
			uiTheme,
			({ contentWidth }) => {
				const expanded = Boolean(options.expanded);
				if (bodyMemo === undefined || bodyMemo.expanded !== expanded || bodyMemo.width !== contentWidth) {
					const changeLines = buildChangeBody(changeGroups, styleLine, expanded, COLLAPSED_CHANGE_LIMIT, uiTheme);
					const lines = [...changeLines, ...extraLines].map(l => truncateToWidth(l, contentWidth, Ellipsis.Omit));
					while (lines.length > 0 && lines[0].trim() === "") lines.shift();
					bodyMemo = { expanded, width: contentWidth, lines };
				}
				const bodyLines = bodyMemo.lines;
				return {
					header,
					sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
					phase: options.isPartial ? "partial" : "success",
					borderColor: "borderMuted",
				};
			},
			{ onInvalidate: () => (bodyMemo = undefined) },
		);
	},
	describeCall(args: AstEditRenderArgs): NativeToolView {
		return {
			tool: {
				title: "AST Edit",
				...astEditPatternHead(args),
				meta: args.paths?.length ? [`in ${args.paths.map(displayPath).join(", ")}`] : undefined,
			},
		};
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: AstEditRenderArgs,
	): NativeToolView {
		const details = result.details;
		const patternHead = astEditPatternHead(args);
		if (result.isError) {
			return {
				tool: { title: "AST Edit", ...patternHead },
				tone: "error",
				body: [errorText(resultText(result) || "Unknown error")],
			};
		}
		const parseErrors = details?.parseErrors ?? [];
		const parseNote: NativeChild | undefined =
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
		const totalReplacements = details?.totalReplacements ?? 0;
		if (totalReplacements === 0) {
			return {
				tool: { title: "AST Edit", ...patternHead, meta: ["0 replacements"] },
				tone: "warning",
				body: compact<NativeChild>([parseNote, astEditScopeStats(details)]),
			};
		}
		const limitReached = details?.limitReached ?? false;
		const allLines = (details?.displayContent ?? resultText(result)).split("\n");
		const kept = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.flatMap(indices => indices.map(index => allLines[index]!));
		const files = parseAstEditChanges(kept);
		const fileCount = Math.max(details?.filesTouched ?? 0, files.length);
		let added = 0;
		let removed = 0;
		for (const file of files) {
			added += file.added;
			removed += file.removed;
		}
		// Same shape as edit: one file heads the call by path with a bare diff;
		// several head it as `N files` with one borderless section per file.
		const single = fileCount === 1 && files.length === 1 ? files[0] : undefined;
		const changes: NativeChild[] = single
			? [astEditDiff(single)]
			: files.map(file => fileDiffSection(file, [astEditDiff(file)], { role: "omp.tool.ast_edit.file" }));
		// The head names the files, so a single rewrite's pattern moves to a quiet context line.
		const pattern = args?.ops?.length === 1 ? patternPreview(args.ops[0]?.pat) : undefined;
		return {
			tool: {
				title: "AST Edit",
				target: single ? displayPath(single.path) : formatCount("file", fileCount),
				targetKind: single ? "path" : "text",
				meta: compact([diffStatsMeta(added, removed), formatCount("replacement", totalReplacements)]),
				badges: details?.applied ? undefined : [{ text: "proposed", tone: "warning" }],
			},
			tone: limitReached ? "warning" : undefined,
			body: compact<NativeChild>([
				pattern !== undefined &&
					text([span(pattern, "code")], { lines: 1, truncate: "end", role: "omp.tool.context" }),
				...(changes.length > 0 ? changes : [noteText(kept.join("\n"))]),
				parseNote,
				astEditScopeStats(details),
			]),
			preview: { lines: COLLAPSED_CHANGE_LIMIT },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstEditRenderArgs, AstEditToolDetails>;
