/**
 * Assistant markdown → Telegram HTML.
 *
 * Block structure (headings, lists, checklists, quotes, tables, fenced code,
 * `<details>`) is rendered into the HTML subset Telegram accepts, then packed
 * into messages of at most {@link TELEGRAM_TEXT_LIMIT} characters with fences
 * reopened across chunks.
 */

import { type Fence, type HtmlLine, packLines, wrapHtml } from "./chunks";
import { escapeHtml, inline } from "./markdown-inline";

const CHECKBOX = /^\[([ xX])\]\s+(.*)$/u;
const FENCE_EDGE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/u;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/u;
const LANGUAGE = /^[\w+#.-]{1,24}$/u;
const QUOTE_BOX: Fence = { open: "<blockquote>", close: "</blockquote>" };
const DETAIL_BOX: Fence = { open: "<blockquote expandable>", close: "</blockquote>" };
const DETAILS = /^\s{0,3}<details(?:\s[^<>]*)?>(.*)$/u;
const DETAILS_END = /^\s{0,3}<\/details>\s*$/u;
const SUMMARY = /<summary>(.*?)<\/summary>/u;
const TABLE_BOX: Fence = { open: "<pre>", close: "</pre>" };
const WRAP_SLACK = 200;

/** Longest text a single Telegram message may carry. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Collapses whitespace and truncates to `width` with an ellipsis. */
export function clip(value: unknown, width: number): string {
	const text = String(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function fencedBlock(
	source: readonly string[],
	start: number,
	edge: RegExpExecArray,
	push: (fence: Fence | null, html: string) => void,
): number {
	const marker = edge[1][0];
	const closing = new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`, "u");
	const box: Fence = {
		open: LANGUAGE.test(edge[2]) ? `<pre><code class="language-${edge[2]}">` : "<pre><code>",
		close: "</code></pre>",
	};
	const body: string[] = [];
	let index = start + 1;
	while (index < source.length && !closing.test(source[index])) {
		body.push(source[index]);
		index += 1;
	}
	if (index < source.length) index += 1;
	if (body.length === 0) push(null, `${box.open}${box.close}`);
	for (const line of body) push(box, escapeHtml(line));
	return index;
}

function tableLines(rows: readonly string[][]): string[] {
	if (rows.length === 0) return [];
	const width = Math.max(...rows.map(row => row.length));
	const columns = Array.from({ length: width }, (_unused, column) =>
		Math.max(1, ...rows.map(row => (row[column] ?? "").length)),
	);
	return rows.map(row =>
		row
			.map((cell, column) => (cell ?? "").padEnd(columns[column]))
			.join("  ")
			.trimEnd(),
	);
}

function tableBlock(
	source: readonly string[],
	start: number,
	push: (fence: Fence | null, html: string) => void,
): number {
	const rows: string[][] = [];
	let index = start;
	while (index < source.length && TABLE_ROW.test(source[index])) {
		rows.push(
			TABLE_ROW.exec(source[index])![1]
				.split("|")
				.map(cell => cell.trim()),
		);
		index += 1;
	}
	if (rows.length > 1) rows.splice(1, 1);
	for (const line of tableLines(rows)) push(TABLE_BOX, escapeHtml(line));
	return index;
}

function blockLines(markdown: unknown): HtmlLine[] {
	const source = String(markdown ?? "")
		.replace(/\r\n?/gu, "\n")
		.split("\n");
	const out: HtmlLine[] = [];
	const push = (fence: Fence | null, html: string) => out.push({ fence, html });
	let quote: Fence | null = null;
	let details: Fence | null = null;
	let index = 0;
	while (index < source.length) {
		const line = source[index];
		if (details !== null) {
			if (DETAILS_END.test(line)) {
				details = null;
				index += 1;
				continue;
			}
			const caption = SUMMARY.exec(line);
			if (caption !== null) {
				push(null, `<b>${inline(caption[1])}</b>`);
				index += 1;
				continue;
			}
			const edge = FENCE_EDGE.exec(line);
			if (edge !== null) {
				index = fencedBlock(source, index, edge, push);
				continue;
			}
			if (line.trim() === "") {
				index += 1;
				continue;
			}
			push(details, inline(line));
			index += 1;
			continue;
		}
		const opened = DETAILS.exec(line);
		if (opened !== null) {
			const caption = SUMMARY.exec(opened[1]);
			if (caption !== null && caption[1].trim() !== "") push(null, `<b>${inline(caption[1])}</b>`);
			details = DETAIL_BOX;
			index += 1;
			continue;
		}
		const quoted = QUOTE.exec(line);
		if (quoted !== null) {
			quote ??= QUOTE_BOX;
			push(quote, inline(quoted[1]));
			index += 1;
			continue;
		}
		quote = null;
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		const edge = FENCE_EDGE.exec(line);
		if (edge !== null) {
			index = fencedBlock(source, index, edge, push);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			push(null, `<b>${inline(heading[1])}</b>`);
			index += 1;
			continue;
		}
		if (RULE.test(line)) {
			push(null, "———");
			index += 1;
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet !== null) {
			const box = CHECKBOX.exec(bullet[1]);
			if (box !== null) push(null, `${box[1].toLowerCase() === "x" ? "☑" : "☐"} ${inline(box[2])}`);
			else push(null, `• ${inline(bullet[1])}`);
			index += 1;
			continue;
		}
		const numbered = NUMBERED.exec(line);
		if (numbered !== null) {
			push(null, `${numbered[1]}. ${inline(numbered[2])}`);
			index += 1;
			continue;
		}
		if (TABLE_ROW.test(line) && index + 1 < source.length && TABLE_SEPARATOR.test(source[index + 1])) {
			index = tableBlock(source, index, push);
			continue;
		}
		push(null, inline(line));
		index += 1;
	}
	return out;
}

/** Renders an assistant answer into HTML messages, each within the text limit. */
export function renderAssistantText(markdown: unknown, options: { limit?: number } = {}): string[] {
	const text = String(markdown ?? "");
	if (text.trim() === "") return [];
	const limit = options.limit ?? TELEGRAM_TEXT_LIMIT;
	const width = Math.max(64, limit - WRAP_SLACK);
	const lines = blockLines(text).flatMap(line =>
		wrapHtml(line.html, width).map(html => ({ fence: line.fence, html })),
	);
	return packLines(lines, limit);
}
