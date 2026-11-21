import type { NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "../index";
import { Markdown, Text } from "../index";
import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	formatAge,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	sanitizeDisplayLines,
	truncateToWidth,
	clipCollapsed,
} from "../render/render-utils";
import { renderStatusLine, renderTreeList, urlHyperlink } from "../render";
import { framedToolCard } from "../render/tool-card";
import { getSearchProviderLabel, type SearchResponse } from "./web-search-types";
import { compact, md, node, span, text } from "../native/describe";
import type { NativeChild } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorText, noteText, resultText } from "./native-view";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/** Most excerpt lines shown under a source when the provider returned no synthesized answer. */
const EXCERPT_LINES = PREVIEW_LIMITS.COLLAPSED_LINES;

/**
 * A source's page excerpt as display lines: control characters and tabs removed,
 * whitespace runs collapsed, lines without a letter or digit (blank lines, code
 * fences, rules) dropped, capped at {@link EXCERPT_LINES}. Callers truncate to width.
 */
function excerptLines(snippet: unknown): string[] {
	if (typeof snippet !== "string") return [];
	const lines: string[] = [];
	for (const raw of sanitizeDisplayLines(snippet)) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (!/[\p{L}\p{N}]/u.test(line)) continue;
		lines.push(line);
		if (lines.length === EXCERPT_LINES) break;
	}
	return lines;
}

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const lines = contentText.split("\n").filter(line => line.trim());
	const maxLines = expanded ? lines.length : 6;
	const displayLines = lines.slice(0, maxLines).map(line => clipCollapsed(line.trim(), 110, expanded));
	const remaining = lines.length - displayLines.length;

	const headerIcon = formatStatusIcon("warning", theme);
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let text = `${headerIcon} ${theme.fg("dim", "Response")}${expandHint}`;

	if (displayLines.length === 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "No response data")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < displayLines.length; i++) {
		const isLast = i === displayLines.length - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", displayLines[i])}`;
	}

	if (!expanded && remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line"))}`;
	}

	return new Text(text, 0, 0);
}

/** Search response and optional failure shown in the transcript. */
export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Render a web search failure as a framed error panel, matching the success layout. */
function renderSearchErrorPanel(message: string, providerLabel: string | undefined, theme: Theme): Component {
	const header = renderStatusLine({ icon: "error", title: "Web Search", description: providerLabel }, theme);
	const body = theme.fg("error", `Error: ${replaceTabs(message)}`);
	return framedToolCard(theme, () => ({
		header,
		phase: "error",
		sections: [{ content: [body] }],
	}));
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	// Handle error case as a framed panel, matching the success layout.
	if (details?.error) {
		const errorProvider = details.response?.provider;
		const errorProviderLabel =
			errorProvider && errorProvider !== "none" ? getSearchProviderLabel(errorProvider) : undefined;
		return renderSearchErrorPanel(details.error, errorProviderLabel, theme);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const response = details?.response;
	if (!response) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	// Without a synthesized answer the result text is the model-facing numbered listing of
	// these same sources: show each source's excerpt under it instead of rendering that text.
	const answerText = typeof response.answer === "string" ? response.answer.trim() : "";
	const excerpts = answerText ? undefined : sources.map(src => excerptLines(src.snippet));
	const fallbackLines =
		!answerText && sourceCount === 0 ? sanitizeDisplayLines(rawText).filter(line => line.trim()) : [];

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;
	const success = sourceCount > 0;
	const header = renderStatusLine(
		success
			? {
					iconOverride: theme.styledSymbol("tool.webSearch", "accent"),
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				}
			: {
					icon: "warning",
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				},
		theme,
	);

	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const metaLines: string[] = [`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerInfo)}`];
	if (response.usage) {
		const usageParts: string[] = [];
		if (response.usage.inputTokens !== undefined) usageParts.push(`in ${response.usage.inputTokens}`);
		if (response.usage.outputTokens !== undefined) usageParts.push(`out ${response.usage.outputTokens}`);
		if (response.usage.totalTokens !== undefined) usageParts.push(`total ${response.usage.totalTokens}`);
		if (response.usage.searchRequests !== undefined) usageParts.push(`search ${response.usage.searchRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}

	const answerMarkdown = answerText ? new Markdown(answerText, 0, 0, getMarkdownTheme()) : undefined;

	return framedToolCard(theme, ({ width, contentWidth }) => {
		// Read mutable state at render time
		const { expanded } = options;

		// Answer lines: full markdown when expanded, capped markdown preview when collapsed.
		const renderedAnswer = answerMarkdown ? answerMarkdown.render(contentWidth) : [];
		let answerLines: readonly string[] | undefined;
		if (excerpts && sourceCount > 0) {
			// No answer: the excerpts under each source stand in for it.
			answerLines = undefined;
		} else if (fallbackLines.length > 0) {
			const shown = expanded ? fallbackLines : fallbackLines.slice(0, PREVIEW_LIMITS.OUTPUT_COLLAPSED);
			answerLines = shown.map(line => theme.fg("dim", truncateToWidth(line, contentWidth)));
			if (shown.length < fallbackLines.length) {
				answerLines = [
					...answerLines,
					theme.fg("muted", formatMoreItems(fallbackLines.length - shown.length, "line")),
				];
			}
		} else if (renderedAnswer.length === 0) {
			answerLines = [theme.fg("muted", "No answer text returned")];
		} else if (args?.maxAnswerLines !== undefined && !expanded) {
			// CLI compact mode (`omp q`) caps the answer; the TUI passes no cap and shows it in full.
			// `renderedAnswer` is the Markdown component's shared cache — slice copies before appending.
			const capped = renderedAnswer.slice(0, args.maxAnswerLines);
			const remaining = renderedAnswer.length - capped.length;
			if (remaining > 0) {
				capped.push(theme.fg("muted", formatMoreItems(remaining, "line")));
			}
			answerLines = capped;
		} else {
			answerLines = renderedAnswer;
		}

		const sourceTree = renderTreeList(
			{
				items: sources,
				expanded,
				maxCollapsed: MAX_COLLAPSED_ITEMS,
				itemType: "source",
				renderItem: (src, { index }) => {
					const titleText =
						typeof src.title === "string" && src.title.trim()
							? src.title
							: typeof src.url === "string" && src.url.trim()
								? src.url
								: "Untitled";
					const url = typeof src.url === "string" ? src.url : "";
					const domain = url ? getDomain(url) : "";
					const age =
						formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
					const metaParts: string[] = [];
					if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
					if (age) metaParts.push(theme.fg("muted", age));
					const metaSep = theme.fg("dim", theme.sep.dot);
					const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
					// One line per source: the title links to its URL, followed by domain · age.
					// Reserve room for the box borders, the tree branch, and the meta suffix.
					const lineBudget = Math.max(24, width - 6);
					const titleBudget = Math.max(12, lineBudget - Bun.stringWidth(metaSuffix));
					const title = theme.fg("accent", truncateToWidth(titleText, titleBudget));
					const linkedTitle = url ? urlHyperlink(url, title) : title;
					const excerpt = excerpts?.[index] ?? [];
					const excerptShown = expanded ? excerpt : excerpt.slice(0, 1);
					return [
						`${linkedTitle}${metaSuffix}`,
						...excerptShown.map(line => theme.fg("dim", truncateToWidth(line, lineBudget))),
					];
				},
			},
			theme,
		);

		return {
			header,
			phase: sourceCount > 0 ? "success" : "warning",
			sections: [
				...(queryPreview
					? [
							{
								content: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
							},
						]
					: []),
				...(answerLines ? [{ label: theme.fg("toolTitle", "Answer"), content: answerLines }] : []),
				{
					label: theme.fg("toolTitle", "Sources"),
					content: sourceTree.length > 0 ? sourceTree : [theme.fg("muted", "No sources returned")],
				},
				{ label: theme.fg("toolTitle", "Metadata"), content: metaLines },
			],
		};
	});
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

type SearchRenderArgs = { query?: string; [key: string]: unknown };

const SEARCH_TITLE = "Web search";

function searchHead(query: string | undefined, meta?: string, badge?: { text: string; title?: string }) {
	return {
		title: SEARCH_TITLE,
		target: query ? plainText(query) : undefined,
		targetKind: "query" as const,
		meta: meta ? [meta] : undefined,
		badges: badge ? [badge] : undefined,
	};
}

/**
 * One cited source (role `omp.tool.source`): domain-initial mark, linked title, muted `domain · age`,
 * then the page excerpt (role `omp.tool.excerpt`) when the search has no synthesized answer to read
 * instead. Tern draws each as a card in the `omp.tool.sources` grid and shows excerpts only while
 * the tool is unfolded.
 */
function sourceRow(src: SearchResponse["sources"][number], index: number, excerpt: boolean): NativeChild {
	const url = typeof src.url === "string" ? src.url : "";
	const title = typeof src.title === "string" && src.title.trim() ? src.title : url.trim() ? url : "Untitled";
	const domain = url ? getDomain(url) : "";
	const age =
		formatAge(src.ageSeconds).replace(/ ago$/, "") ||
		(typeof src.publishedDate === "string" ? src.publishedDate : "");
	const meta = [domain, age].filter(Boolean).join(" · ");
	const initial = (domain.replace(/^www\./, "")[0] ?? "?").toUpperCase();
	// The host clamps the excerpt to its card's width, so its lines go whole.
	const lines = excerpt ? excerptLines(src.snippet) : [];
	return node(
		"row",
		{ gap: "sm", align: "baseline", role: "omp.tool.source", href: url || undefined },
		compact([
			node("badge", { text: initial, title: domain || undefined }),
			text([span(plainText(title), "link", url ? { href: url } : undefined)], { lines: 2, truncate: "end" }),
			meta ? text([span(plainText(meta), "muted")], { lines: 1 }) : undefined,
			lines.length > 0
				? text([span(lines.join("\n"), "muted")], { role: "omp.tool.excerpt", wrap: "word", lines: EXCERPT_LINES })
				: undefined,
		]),
		`${index}:${url}`,
	);
}

function describeSearchResult(
	result: ToolRenderResult<SearchRenderDetails>,
	args: SearchRenderArgs | undefined,
): NativeToolView {
	const details = result.details;
	const argQuery = typeof args?.query === "string" ? args.query : undefined;
	if (details?.error) {
		const provider = details.response?.provider;
		const label = provider && provider !== "none" ? getSearchProviderLabel(provider) : undefined;
		return {
			tool: searchHead(argQuery, label),
			tone: "error",
			body: [errorText(plainText(details.error).trim() || "Web search failed")],
		};
	}

	const rawText = resultText(result).trim();
	const response = details?.response;
	if (!response) {
		return {
			tool: searchHead(argQuery),
			tone: "warning",
			body: [noteText(rawText || "No response data")],
		};
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(entry => typeof entry === "string")
		: [];
	const providerLabel = response.provider !== "none" ? getSearchProviderLabel(response.provider) : "None";
	const query = argQuery || searchQueries[0];
	const answer = typeof response.answer === "string" ? response.answer.trim() : "";

	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const usage = response.usage;
	const usageParts: string[] = [];
	if (usage?.inputTokens !== undefined) usageParts.push(`in ${usage.inputTokens}`);
	if (usage?.outputTokens !== undefined) usageParts.push(`out ${usage.outputTokens}`);
	if (usage?.totalTokens !== undefined) usageParts.push(`total ${usage.totalTokens}`);
	if (usage?.searchRequests !== undefined) usageParts.push(`search ${usage.searchRequests}`);
	const tooltip = plainText([providerInfo, usageParts.join(" · ")].filter(Boolean).join("\n"));
	const badge = response.model ? { text: plainText(response.model), title: tooltip } : undefined;

	// No synthesized answer: the result text is the model-facing numbered listing of these sources,
	// so each source carries its excerpt instead of that text being rendered.
	const sourceGrid =
		sources.length > 0
			? node(
					"col",
					{ role: "omp.tool.sources" },
					sources.map((src, i) => sourceRow(src, i, !answer)),
					"sources",
				)
			: noteText("No sources returned");
	return {
		tool: searchHead(query, `${providerLabel} · ${formatCount("source", sources.length)}`, badge),
		tone: sources.length > 0 ? undefined : "warning",
		body: answer
			? [{ ...md(plainText(answer), { title: tooltip }), key: "answer" }, sourceGrid]
			: sources.length > 0
				? [sourceGrid]
				: [noteText(rawText || "No answer text returned"), sourceGrid],
	};
}

const searchResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render web search queries, answers, and cited sources. */
export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	describeCall(args: SearchRenderArgs): NativeToolView {
		return { tool: searchHead(typeof args.query === "string" ? args.query : undefined), inline: true };
	},
	describeResult(
		result: ToolRenderResult<SearchRenderDetails>,
		_options: RenderResultOptions,
		args?: SearchRenderArgs,
	): NativeToolView | undefined {
		return searchResultMemo.get(result, [args?.query ?? ""], () => describeSearchResult(result, args));
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<{ query?: string; [key: string]: unknown }, SearchRenderDetails>;
