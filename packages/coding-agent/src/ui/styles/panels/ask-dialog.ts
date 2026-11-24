/**
 * The ask card in the terminal (`omp.ask.card`): a box titled `Ask` (the
 * countdown, how many questions are answered) holding every question in one
 * scrolling column — the open one whole (header, mark and question capped at
 * four rows, its answer rows with descriptions, previews and notes), the rest
 * folded to their question over a row of option chips — then the skip
 * notice. Collapsed (alt+h) it is one line naming the question.
 *
 * The box height is the tallest column's (any question open), at most 70% of
 * the terminal and never below ten rows; the column scrolls inside it,
 * following the highlighted row.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type Painter } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { AskDialogModel, AskFoldSummary, AskRow } from "../../overlays/panels/ask-dialog";
import { foldPills, inlineCodeSpans, inlineText } from "../../overlays/panels/ask-dialog";
import { bindingGlyph, boxRows, termOf } from "./common";

const DIALOG_HEIGHT_RATIO = 0.7;
const MIN_DIALOG_ROWS = 10;
const PANEL_CHROME_ROWS = 2;
const MIN_BODY_ROWS = 5;
/** Rows an ask leaves to the composer and status line under it. */
const RESERVED_ROWS = 8;
const OPEN_INDENT = "  ";
const MAX_HEADER_ROWS = 4;
const MAX_DESC_ROWS = 2;

/** Markdown text as rows in one text color. */
function markdownRows(theme: Theme, text: string, width: number, style: string): string[] {
	return renderMarkdown(text, Math.max(1, width), { theme, textStyle: style }).map(row => row.replace(/ +$/, ""));
}

/** A preview: fenced code highlighted, the rest markdown. */
function previewRows(theme: Theme, preview: string, width: number): string[] {
	const out: string[] = [];
	let fence: string | undefined;
	let lang: string | undefined;
	let code: string[] = [];
	let prose: string[] = [];
	const flushProse = () => {
		if (prose.length > 0) out.push(...markdownRows(theme, prose.join("\n"), width, "muted"));
		prose = [];
	};
	for (const line of replaceTabs(preview).split("\n")) {
		const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence !== undefined) {
			if (match && match[2]!.startsWith(fence[0]!) && match[2]!.length >= fence.length && match[3]!.trim() === "") {
				for (const row of highlightCode(code.join("\n"), lang, theme)) out.push(...wrap(row, Math.max(1, width)));
				fence = undefined;
				code = [];
				continue;
			}
			code.push(line);
			continue;
		}
		if (match) {
			flushProse();
			fence = match[2]!;
			lang = match[3]!.trim().split(/\s+/, 1)[0] || undefined;
			continue;
		}
		prose.push(line);
	}
	if (fence !== undefined)
		for (const row of highlightCode(code.join("\n"), lang, theme)) out.push(...wrap(row, width));
	else flushProse();
	return out;
}

function chipsLine(theme: Theme, summary: AskFoldSummary): string {
	const note = (text: string | undefined) => (text ? theme.fg("dim", `  ✎ ${truncate(text, 60, "…")}`) : "");
	if (summary.kind === "answer") return `${theme.fg("muted", summary.text.replace(/\s+/g, " "))}${note(summary.note)}`;
	const { shown, hidden } = foldPills(summary.pills);
	const chips = shown.map(pill =>
		pill.chosen
			? theme.bg("toolSuccessBg", theme.fg("success", ` ✓ ${pill.cut} `))
			: theme.bg("selectedBg", theme.fg("muted", ` ${pill.cut} `)),
	);
	if (hidden > 0) chips.push(theme.bg("selectedBg", theme.fg("dim", ` +${hidden} `)));
	return `${chips.join(" ")}${shown.some(pill => pill.chosen) ? note(summary.note) : ""}`;
}

function foldedLines(theme: Theme, model: AskDialogModel, index: number, width: number): string[] {
	const mark = model.answered(index) ? theme.fg("success", "✓") : theme.fg("dim", "○");
	const inner = Math.max(1, width - 2);
	const text = inlineCodeSpans(model.foldQuestion(index))
		.map(part => part.t)
		.join("");
	const lines = wrap(theme.fg("text", text), inner).map((line, i) => `${i === 0 ? `${mark} ` : "  "}${line}`);
	const summary = chipsLine(theme, model.foldSummary(index));
	if (summary) lines.push(`  ${truncate(summary, inner, "…")}`);
	return lines;
}

/** An option description's rows at `width` (before the {@link MAX_DESC_ROWS} cut). */
function descriptionRows(theme: Theme, description: string, width: number): string[] {
	return wrap(markdownRows(theme, description, 1_000_000, "muted").join(" "), Math.max(1, width - 6));
}

function rowLines(theme: Theme, model: AskDialogModel, row: AskRow, selected: boolean, width: number): string[] {
	const question = model.questions[model.current]!;
	const state = model.states[model.current]!;
	const option = row.kind === "option" ? question.options[row.optionIndex ?? -1] : undefined;
	const checked =
		option !== undefined ? state.selected.has(option.label) : row.kind === "other" && state.customInput !== undefined;
	const color = selected ? "accent" : checked ? "toolOutput" : "text";
	const glyph = question.multi ? (checked ? "☑" : "☐") : checked ? "◉" : "○";
	const marker = `${theme.fg(checked ? "success" : "dim", glyph)} `;
	const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
	const noteMarker = state.note && state.noteRowKey === row.key ? theme.fg("success", "  ✎ note") : "";
	const labelWidth = Math.max(1, width - 4 - visibleWidth(noteMarker));
	const label = markdownRows(theme, row.label, labelWidth, color);
	const lines = [`${cursor}${marker}${label[0] ?? ""}${noteMarker}`];
	for (const line of label.slice(1)) lines.push(`    ${line}`);
	if (option?.description?.trim()) {
		const described = descriptionRows(theme, option.description.trim(), width);
		for (const line of model.expanded ? described : described.slice(0, MAX_DESC_ROWS)) {
			lines.push(`      ${truncate(line, Math.max(1, width - 6), "…")}`);
		}
	}
	if (option?.preview?.trim()) {
		for (const line of previewRows(theme, option.preview, Math.max(1, width - 8))) {
			lines.push(`      ${theme.fg("border", "│")} ${line}`);
		}
	}
	if (row.kind === "other" && state.customInput !== undefined) {
		lines.push(theme.fg("muted", `      ${truncate(inlineText(state.customInput), Math.max(1, width - 6), "…")}`));
	}
	return lines;
}

function openLines(theme: Theme, model: AskDialogModel, width: number): { lines: string[]; starts: number[] } {
	const index = model.current;
	const question = model.questions[index]!;
	const state = model.states[index]!;
	const textWidth = Math.max(1, width - OPEN_INDENT.length);
	const lines: string[] = [];
	const header = question.header?.trim();
	if (header) lines.push(`${OPEN_INDENT}${theme.fg("muted", truncate(replaceTabs(header), textWidth, "…"))}`);
	const mark = model.answered(index) ? theme.fg("success", "✓") : theme.fg("accent", "○");
	let title = markdownRows(theme, question.question.replace(/\r\n?/g, "\n"), textWidth, "text");
	// Ctrl+O has something to reveal only when the header or a description is cut at this width.
	model.revealable =
		title.length > MAX_HEADER_ROWS ||
		question.options.some(option => {
			const description = option.description?.trim();
			return !!description && descriptionRows(theme, description, width).length > MAX_DESC_ROWS;
		});
	if (!model.expanded && title.length > MAX_HEADER_ROWS) {
		title = [
			...title.slice(0, MAX_HEADER_ROWS - 1),
			truncate(title.slice(MAX_HEADER_ROWS - 1).join(" "), textWidth, "…"),
		];
	}
	if (title.length === 0) title = [""];
	title.forEach((line, i) => lines.push(`${i === 0 ? `${mark} ` : OPEN_INDENT}${line}`));
	const starts: number[] = [];
	model.rows(question).forEach((row, i) => {
		starts.push(lines.length);
		lines.push(...rowLines(theme, model, row, i === state.cursor, width));
	});
	starts.push(lines.length);
	return { lines, starts };
}

function column(
	theme: Theme,
	model: AskDialogModel,
	width: number,
): { lines: string[]; starts: number[]; openStart: number } {
	const lines: string[] = [];
	let starts: number[] = [];
	let openStart = 0;
	model.questions.forEach((_, index) => {
		if (lines.length > 0) lines.push("");
		if (index !== model.current) {
			lines.push(...foldedLines(theme, model, index, width));
			return;
		}
		openStart = lines.length;
		const block = openLines(theme, model, width);
		starts = block.starts.map(start => openStart + start);
		lines.push(...block.lines);
	});
	return { lines, starts, openStart };
}

/** The box height: the tallest column, clamped to the terminal. */
function dialogHeight(theme: Theme, model: AskDialogModel, width: number, terminalRows: number): number {
	const max = Math.max(
		PANEL_CHROME_ROWS + MIN_BODY_ROWS,
		Math.min(Math.floor(terminalRows * DIALOG_HEIGHT_RATIO), terminalRows - RESERVED_ROWS),
	);
	let folded = 0;
	let opening = 0;
	const open = model.open;
	model.questions.forEach((_, index) => {
		const fold = foldedLines(theme, model, index, width).length;
		folded += fold;
		model.open = index;
		opening = Math.max(opening, openLines(theme, model, width).lines.length - fold);
	});
	model.open = open;
	const body = folded + opening + Math.max(0, model.questions.length - 1);
	return Math.min(Math.max(MIN_DIALOG_ROWS, PANEL_CHROME_ROWS + Math.max(MIN_BODY_ROWS, body)), max);
}

function title(model: AskDialogModel): string {
	const head = model.remaining === undefined ? "Ask" : `Ask (${model.remaining}s)`;
	const total = model.questions.length;
	if (total < 2) return head;
	const answered = model.questions.filter((_, index) => model.answered(index)).length;
	return `${head} · ${answered} of ${total} answered`;
}

const looks = new Map<string, Painter>();

/**
 * Register another card drawn on the `omp.ask.card` role (an HTML form uses
 * the ask card's native roles): a card whose `term.look` is `look` paints
 * with `painter`.
 */
export function defineAskCardLook(look: string, painter: Painter): void {
	looks.set(look, painter);
}

defineRolePainter("col", "omp.ask.card", (node: UiNode, cx): Block => {
	const theme = cx.theme;
	const term = termOf<{ model: AskDialogModel; look: string }>(node);
	const look = term.look === undefined ? undefined : looks.get(term.look);
	if (look) return look(node, cx);
	const model = term.model;
	if (!model || cx.width < 6) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	if (model.hidden) {
		const label = theme.fg(
			"accent",
			`${model.remaining === undefined ? "Ask" : `Ask (${model.remaining}s)`} hidden:`,
		);
		const more = model.questions.length > 1 ? theme.fg("dim", ` (+${model.questions.length - 1} more)`) : "";
		const show = `${bindingGlyph("app.ask.hide", "alt+h")}/${bindingGlyph("tui.select.confirm", "enter")}`;
		const hint = theme.fg("dim", ` · ${show} show · ${bindingGlyph("tui.select.cancel", "escape")} composer`);
		const room = Math.max(1, cx.width - visibleWidth(label) - visibleWidth(more) - visibleWidth(hint) - 1);
		const summary = truncate(inlineText(model.questions[model.current]?.question ?? ""), room, "…");
		return { rows: [truncate(`${label} ${theme.fg("muted", summary)}${more}${hint}`, cx.width, "…")] };
	}
	const terminalRows = model.options.terminalRows?.() ?? 40;
	const skip = model.options.skipNotice?.();
	const total = dialogHeight(theme, model, inner, terminalRows);
	const bodyRows = Math.max(MIN_BODY_ROWS, total - PANEL_CHROME_ROWS - (skip ? 1 : 0));
	let layout = column(theme, model, inner);
	let overflow = layout.lines.length > bodyRows;
	if (overflow) layout = column(theme, model, inner - 1);
	overflow = layout.lines.length > bodyRows;
	const { lines, starts, openStart } = layout;
	const cursor = model.states[model.current]?.cursor ?? 0;
	const cursorStart = starts[cursor] ?? openStart;
	const cursorEnd = starts[cursor + 1] ?? lines.length;
	const maxOffset = Math.max(0, lines.length - bodyRows);
	// The body moves as little as it can from where it was drawn last.
	const top = cursorEnd - openStart <= bodyRows ? openStart : cursorStart;
	let offset = Math.max(0, Math.min(model.scrollOffset, maxOffset));
	if (top < offset) offset = top;
	else if (cursorEnd > offset + bodyRows)
		offset = cursorEnd - cursorStart > bodyRows ? cursorStart : cursorEnd - bodyRows;
	if (model.pageOffset !== undefined) offset += model.pageOffset * Math.max(1, bodyRows - 1);
	offset = Math.max(0, Math.min(offset, maxOffset));
	model.scrollOffset = offset;
	const content: string[] = [];
	const thumb = overflow ? Math.max(1, Math.floor((bodyRows * bodyRows) / lines.length)) : 0;
	const at = overflow ? Math.round((offset / Math.max(1, maxOffset)) * (bodyRows - thumb)) : 0;
	for (let i = 0; i < bodyRows; i++) {
		const line = lines[offset + i] ?? "";
		if (!overflow) content.push(line);
		else {
			const bar = i >= at && i < at + thumb ? theme.fg("accent", "█") : theme.fg("muted", "│");
			content.push(`${padTo(truncate(line, inner - 1, ""), inner - 1)}${bar}`);
		}
	}
	if (skip) content.push(theme.fg("warning", truncate(`⚠ ${skip}`, inner, "…")));
	return { rows: boxRows(theme, title(model), content, cx.width) };
});
