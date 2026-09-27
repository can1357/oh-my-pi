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
import type { RenderResultOptions, ToolRenderer } from "./renderer";

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
 * Flatten pre-styled change groups into frame body lines. Groups are separated
 * by a blank line and carry no tree guides — the frame border is the container,
 * so nested `├─ │` gutters would just be noise. Collapsed mode always shows at
 * least the first group, then fills up to `budget` lines before summarizing the
 * rest as `… N more changes`.
 */
function buildChangeBody(groups: string[][], expanded: boolean, budget: number, theme: Theme): string[] {
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
		lines.push(...group);
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
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			// Swap the inner code-frame gutter `│` for a space so it does not nest a
			// second vertical bar inside the frame border.
			const display = replaceTabs(line.replace("│", " "));
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (display.startsWith("+")) return uiTheme.fg("toolDiffAdded", display);
			if (display.startsWith("-")) return uiTheme.fg("toolDiffRemoved", display);
			return uiTheme.fg("toolOutput", display);
		});
		const changeGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.map(index => styledLines[index]!));

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
		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const changeLines = buildChangeBody(changeGroups, Boolean(options.expanded), COLLAPSED_CHANGE_LIMIT, uiTheme);
			const bodyLines = [...changeLines, ...extraLines].map(l => truncateToWidth(l, contentWidth, Ellipsis.Omit));
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: options.isPartial ? "partial" : "success",
				borderColor: "borderMuted",
			};
		});
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstEditRenderArgs, AstEditToolDetails>;
