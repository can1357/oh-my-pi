/**
 * The `web_search` look. A pending call is one line (`⏳ Web Search: query`).
 * A response is a card (`╭─── ⌕ Web Search: Anthropic 8 sources ───╮`) with
 * the query, the answer as markdown (clamped to `maxAnswerLines` while
 * collapsed), the sources as a branch list (`├─ Title (domain) · 1d ago`)
 * and the provider metadata, on the status background. A plain-text result
 * is a `⚠ Response` tree of its lines (six while collapsed).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { WebSearchTerm, WebSearchTermSource } from "../../tools/web-search";
import { webLink } from "./file-common";
import { expandHint, type FrameSection, frameInner, frameRows } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Query characters a pending call shows. */
const QUERY_CHARS = 80;
/** Response lines listed while collapsed. */
const COLLAPSED_LINES = 6;
/** Fewest cells a source title is cut to. */
const MIN_TITLE = 12;

function sourceLine(cx: PaintContext, source: WebSearchTermSource, last: boolean, inner: number): string {
	const theme = cx.theme;
	const domain = ` (${source.domain})`;
	const age = source.age ? ` · ${source.age} ago` : "";
	const room = Math.max(MIN_TITLE, inner - 2 - visibleWidth(domain) - visibleWidth(age));
	let line = `${theme.fg("dim", theme.symbols.symbol(last ? "tree.last" : "tree.branch"))} ${webLink(cx, theme.fg("accent", truncate(source.title, room)), source.url)} ${theme.fg("dim", domain.slice(1))}`;
	if (source.age) line += `${theme.fg("dim", " · ")}${theme.fg("muted", `${source.age} ago`)}`;
	return line;
}

function paintCall(cx: PaintContext, term: WebSearchTerm): Block {
	const theme = cx.theme;
	let head = `${theme.fg("muted", theme.symbols.symbol("status.pending"))} ${theme.fg("accent", "Web Search")}`;
	if (term.query) head += `: ${theme.fg("muted", truncate(replaceTabs(term.query), QUERY_CHARS))}`;
	return { rows: wrap(head, cx.width) };
}

function paintLines(cx: PaintContext, lines: readonly string[], expanded: boolean): Block {
	const theme = cx.theme;
	const hidden = expanded ? 0 : Math.max(0, lines.length - COLLAPSED_LINES);
	let head = `${theme.fg("warning", theme.symbols.symbol("status.warning"))} ${theme.fg("dim", "Response")}`;
	if (hidden > 0) head += expandHint(theme);
	const rows = wrap(head, cx.width);
	const item = (last: boolean, text: string) =>
		wrap(` ${theme.fg("dim", theme.symbols.symbol(last ? "tree.last" : "tree.branch"))} ${text}`, cx.width);
	if (lines.length === 0)
		return {
			rows: [...rows, ...item(true, theme.fg("muted", "No response data"))],
		};
	const shown = lines.slice(0, lines.length - hidden);
	shown.forEach((line, i) => {
		rows.push(...item(hidden === 0 && i === shown.length - 1, theme.fg("dim", replaceTabs(line.trimEnd()))));
	});
	if (hidden > 0) rows.push(...item(true, theme.fg("muted", `${theme.symbols.ellipsis} ${hidden} more lines`)));
	return { rows };
}

function paintWebSearch(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "web_search" }) as WebSearchTerm;
	const theme = cx.theme;
	const expanded = props.collapsed === false;
	if (!term.result) return paintCall(cx, term);
	if (term.lines) return paintLines(cx, term.lines, expanded);
	const tone = term.error !== undefined ? "error" : props.tone === "warning" ? "warning" : "success";
	const glyph =
		tone === "error"
			? theme.fg("error", theme.symbols.symbol("status.error"))
			: tone === "warning"
				? theme.fg("warning", theme.symbols.symbol("status.warning"))
				: theme.fg("accent", theme.symbols.symbol("tool.webSearch"));
	let head = `${glyph} ${theme.fg("accent", "Web Search")}: ${theme.fg("muted", term.provider ?? "")}`;
	if (term.sourceCount !== undefined) head += ` ${theme.fg("dim", `${term.sourceCount} sources`)}`;
	const inner = frameInner(cx.width);
	const sections: FrameSection[] = [];
	if (term.error !== undefined) sections.push({ lines: [theme.fg("error", `Error: ${term.error}`)] });
	else {
		sections.push({
			lines: [`${theme.fg("muted", "Query:")} ${replaceTabs(term.query ?? "")}`],
		});
		let answer: string[];
		if (term.answer) {
			answer = renderMarkdown(term.answer, Math.max(1, inner), { theme }).map(row => row.trimEnd());
			const max = term.maxAnswerLines;
			if (!expanded && max !== undefined && answer.length > max) {
				const hidden = answer.length - max;
				answer = [...answer.slice(0, max), theme.fg("muted", `${theme.symbols.ellipsis} ${hidden} more lines`)];
			}
		} else answer = (term.fallback ?? "").split("\n").map(line => theme.fg("dim", replaceTabs(line)));
		sections.push({ label: "Answer", lines: answer });
		const sources = term.sources ?? [];
		sections.push({
			label: "Sources",
			lines:
				sources.length > 0
					? sources.map((source, i) => sourceLine(cx, source, i === sources.length - 1, inner))
					: [theme.fg("muted", "No sources returned")],
		});
		const meta: string[] = [];
		if (term.providerLine) meta.push(`${theme.fg("muted", "Provider:")} ${term.providerLine}`);
		if (term.usage) meta.push(`${theme.fg("muted", "Usage:")} ${term.usage}`);
		if (meta.length > 0) sections.push({ label: "Metadata", lines: meta });
	}
	const border = tone === "success" ? "dim" : tone;
	const bg = tone === "error" ? "toolErrorBg" : tone === "warning" ? "toolPendingBg" : "toolSuccessBg";
	return { rows: frameRows(theme, cx.width, { head, sections, border, bg }) };
}

defineToolLook("web_search", { paint: paintWebSearch, margin: true });
