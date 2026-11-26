/**
 * Terminal look of the HTML form dialog (`omp.ask.card`, look
 * `omp.html-form`): a box titled `Ask · N of M answered` (or the form's
 * title; the countdown in parentheses) holding one column — every group in
 * order, the open field's group whole (legend, text, the open field's
 * controls, its other fields folded), the rest folded to their answers —
 * then the Submit row. An open dropdown or an option note draws over the
 * rows under its field.
 *
 * The box is as tall as the tallest column any field could open (at most
 * 70% of the terminal); a longer column scrolls with a bar, keeping the
 * highlighted row in view and moving as little as it can. Collapsed (alt+h)
 * the card is one line.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { layoutText, rowOf } from "@oh-my-pi/pi-tui/term/painters/editor";
import { paintPicture } from "@oh-my-pi/pi-tui/term/painters/image";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, sliceCells, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ChoiceField, FormBlock, FormField, FormSpan } from "../../../tools/html-form/parse";
import { spansText } from "../../../tools/html-form/parse";
import { type FormPart, isFoldCaption } from "../../forms/html-form/layout";
import type { MediaState } from "../../forms/html-form/media";
import { rasterLabel } from "../../transcript/figures/svg";
import { type Active, type HtmlFormModel, isDropdown, OTHER_ROW } from "../../forms/html-form/model";
import { foldPills } from "../../overlays/panels/ask-dialog";
import { defineAskCardLook } from "../panels/ask-dialog";
import { bindingGlyph, boxRows } from "../panels/common";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { actionKey, formatKeyHint } from "../../keys/hints";

/** Terminal facts of the dialog card. */
export type HtmlFormLook = {
	readonly look: "omp.html-form";
	readonly model: HtmlFormModel;
	/** Box title in place of "Ask · N of M answered". */
	readonly title?: string;
	readonly terminalRows: number;
	readonly media?: ReadonlyMap<string, MediaState>;
	readonly skipNotice?: string;
	/** Time left before the draft is sent (ms). */
	readonly remaining?: number;
};

const HEIGHT_RATIO = 0.7;
const CHROME_ROWS = 2;

/** The open note's key hints; a note on an unchosen option is kept but not submitted. */
export function noteEditHint(model: HtmlFormModel): string {
	const note = model.note();
	const chosen = note !== undefined && model.answer(note.field).checked.has(note.option);
	return `enter save · blank removes · esc keep${chosen ? "" : " · sent only if chosen"}`;
}

/**
 * The form's keys on one line, which the composer under it shows while the form holds them: the
 * highlighted row's keys, moving, the composer and hiding, jumping questions; the open note's or
 * dropdown's keys while one is open.
 */
export function htmlFormKeyHints(model: HtmlFormModel): string {
	if (model.note()) return noteEditHint(model);
	const hide = actionKey("app.ask.hide");
	const cancel = actionKey("tui.select.cancel");
	const active = model.active();
	const field = active === "submit" ? undefined : model.field(active);
	const dropdown = field !== undefined && isDropdown(field);
	const option = field?.kind === "choice" && (dropdown || model.row() !== OTHER_ROW);
	// A dropdown keeps the text keys for its type-ahead.
	const [noteKey] = getKeybindings()
		.keysFor("app.ask.note")
		.filter(key => !dropdown || (key.length !== 1 && !/^shift\+.$/.test(key)));
	const note = option && noteKey ? ` · ${formatKeyHint(noteKey)} note` : "";
	const enter = formatKeyHint("enter");
	const upDown = `${actionKey("tui.select.up")}/${actionKey("tui.select.down")}`;
	if (model.dropdown() !== undefined) return `${upDown} highlight · ${enter} choose${note} · ${cancel} close`;
	const next = model.sole ? "submit" : "next";
	let action: string;
	if (!field) action = `${enter} submit`;
	else if (field.kind === "text") action = `${enter} ${next}`;
	else if (dropdown)
		action = `${formatKeyHint("space")} open · ${formatKeyHint("left")}/${formatKeyHint("right")} change · ${enter} ${next}`;
	else if (!option) action = `type your own · ${enter} ${next}`;
	else if (field.multi) action = `${formatKeyHint("space")} toggle · ${enter} ${next}`;
	else action = `${enter} ${model.sole ? "submit" : "choose"}`;
	const hints = [`${action}${note}`, `${upDown} move`];
	if (field) hints.push(`${formatKeyHint("tab")} next field`);
	hints.push(`${cancel} composer${hide ? ` · ${hide} hide` : ""}`);
	if (model.layout.groups.length > 1) {
		const keys =
			field?.kind === "text" || dropdown
				? `${actionKey("tui.select.pageUp")}/${actionKey("tui.select.pageDown")}`
				: `${formatKeyHint("left")}/${formatKeyHint("right")}`;
		hints.push(`${keys} question`);
	}
	return hints.join(" · ");
}
const DROPDOWN_RIGHT_MARGIN = 2;
/** A text block of at most this many rows right before a field is its caption: no blank row parts them. */
const CAPTION_MAX_ROWS = 4;

/** What the column shows: which field is open and where its highlight is. */
interface View {
	readonly active: Active;
	readonly row: number;
	readonly dropdown: number | undefined;
	readonly note:
		| { readonly field: number; readonly option: number; readonly text: string; readonly cursor: number }
		| undefined;
	readonly focused: boolean;
}

/** A column of rows, the highlighted row's range, and overlays to draw over it. */
interface Column {
	readonly lines: string[];
	/** First row of the open group. */
	groupStart: number;
	focusStart: number;
	focusEnd: number;
	overlay?: { readonly at: number; readonly rows: string[] };
}

/** `row` cut to `width` cells, its ellipsis in the style the cut text had. */
function clip(row: string, width: number): string {
	if (visibleWidth(row) <= width) return row;
	const head = sliceCells(row, 0, Math.max(0, width - 1)).text;
	// The ellipsis takes the cell it replaces: that cell's styles around it.
	const cell = sliceCells(row, Math.max(0, width - 1), 1).text;
	return `${head}${cell.replace(/(^|m)[^\x1b]+/, "$1…")}`;
}

function styled(theme: Theme, spans: readonly FormSpan[], base: string): string {
	return spans
		.map(span => {
			if (span.style === "code") return theme.fg("mdCode", span.text);
			if (span.style === "strong") return theme.style("strong", theme.fg(base, span.text));
			if (span.style === "em") return theme.style("em", theme.fg(base, span.text));
			if (span.style === "mark") return theme.style("inverse", theme.fg(base, span.text));
			return theme.fg(base, span.text);
		})
		.join("");
}

/**
 * A one-line box: the text with its caret (an inverted cell), or a Vim Visual `selection` inverted
 * instead. A line break Vim put in the box (`o`, a linewise put) shows as a space.
 */
function caretLine(
	theme: Theme,
	text: string,
	cursor: number,
	placeholder?: string,
	selection?: { readonly from: number; readonly to: number } | null,
): string {
	const flat = text.replaceAll("\n", " ");
	if (selection && selection.to > selection.from)
		return `${flat.slice(0, selection.from)}${theme.style("inverse", flat.slice(selection.from, selection.to))}${flat.slice(selection.to)}`;
	const at = Math.max(0, Math.min(cursor, flat.length));
	if (at >= flat.length) {
		const caret = theme.style("inverse", " ");
		return `${flat}${caret}${!flat && placeholder ? theme.fg("dim", placeholder) : ""}`;
	}
	const ch = String.fromCodePoint(flat.codePointAt(at)!);
	return `${flat.slice(0, at)}${theme.style("inverse", ch)}${flat.slice(at + ch.length)}`;
}

// ─── Content blocks ─────────────────────────────────────────────────────────

function blockLines(cx: PaintContext, block: FormBlock, width: number, media: MediaState | undefined): string[] {
	const theme = cx.theme;
	switch (block.kind) {
		case "text":
			return block.heading
				? wrap(theme.style("strong", styled(theme, block.spans, "text")), width)
				: wrap(styled(theme, block.spans, "muted"), width);
		case "list":
			return block.items.flatMap((item, index) => {
				const bullet = block.ordered ? `${index + 1}. ` : "• ";
				const rows = wrap(styled(theme, item, "muted"), Math.max(1, width - bullet.length));
				return rows.map((row, i) => `${i === 0 ? theme.fg("accent", bullet) : " ".repeat(bullet.length)}${row}`);
			});
		case "pre":
			return block.text
				.replaceAll("\t", "   ")
				.split("\n")
				.map(line => `  ${truncate(theme.fg("mdCodeBlock", line), Math.max(1, width - 2), "…")}`);
		case "table": {
			const cols = Math.max(0, ...block.rows.map(row => row.length));
			const widths = Array.from({ length: cols }, (_, j) =>
				Math.max(0, ...block.rows.map(row => visibleWidth(spansText(row[j] ?? [])))),
			);
			const line = (row: readonly FormSpan[][], head: boolean): string =>
				truncate(
					row
						.map((cell, j) => {
							const pad = j === cols - 1 ? "" : " ".repeat(widths[j]! - visibleWidth(spansText(cell)) + 2);
							const text = styled(theme, cell, head ? "text" : "muted");
							return `${head ? theme.style("strong", text) : text}${pad}`;
						})
						.join(""),
					width,
					"…",
				);
			const out: string[] = [];
			block.rows.forEach((row, r) => {
				out.push(line(row, r < block.headerRows));
				if (r === block.headerRows - 1) out.push(theme.fg("dim", "─".repeat(width)));
			});
			return out;
		}
		case "image":
		case "svg": {
			// An svg draws from its raster: loading until it is ready, its source type if it does not draw.
			if (media?.kind === "ready" && block.kind === "svg" && media.raster)
				return [
					...paintPicture(media.raster, { ...cx, width }, theme.fg("muted", rasterLabel("svg", media.raster)))
						.rows,
				];
			if (media?.kind === "ready" && (block.kind === "image" || media.raster === null))
				return [
					theme.fg(
						"muted",
						truncate(`[Image: ${block.kind === "svg" ? "svg" : block.alt} [${media.mime}]]`, width, "…"),
					),
				];
			const status = media?.kind === "failed" ? `couldn't load: ${media.message}` : "loading…";
			return [clip(theme.fg("dim", `▣ ${block.alt} — ${status}`), width)];
		}
		default:
			return [];
	}
}

// ─── Folded fields ──────────────────────────────────────────────────────────

function foldLines(theme: Theme, model: HtmlFormModel, index: number, width: number): string[] {
	const field = model.field(index);
	const error = model.error(index);
	const mark = error
		? theme.fg("error", "!")
		: model.answered(index)
			? theme.fg("success", "✓")
			: theme.fg("dim", "○");
	const inner = Math.max(1, width - 2);
	const lines = wrap(theme.fg("text", model.question(index)), inner).map(
		(line, i) => `${i === 0 ? `${mark} ` : "  "}${line}`,
	);
	const answer = model.answer(index);
	if (field.kind === "text") {
		const text = field.type === "password" ? "•".repeat([...answer.text.text].length) : flattenLine(answer.text.text);
		const shown = text ? theme.fg("muted", text) : theme.fg("dim", field.placeholder || "type your answer");
		lines.push(`  ${truncate(shown, inner, "…")}`);
	} else {
		const { pills, note } = model.foldChoice(index);
		const { shown, hidden } = foldPills(pills);
		const chips = shown.map(pill =>
			pill.chosen
				? theme.bg("toolSuccessBg", theme.fg("success", ` ✓ ${pill.cut} `))
				: theme.bg("selectedBg", theme.fg("muted", ` ${pill.cut} `)),
		);
		if (hidden > 0) chips.push(theme.bg("selectedBg", theme.fg("dim", ` +${hidden} `)));
		// The note on the answer follows its chips.
		const noted = note && shown.some(pill => pill.chosen) ? theme.fg("dim", `  ✎ ${truncate(note, 60, "…")}`) : "";
		lines.push(`  ${truncate(`${chips.join(" ")}${noted}`, inner, "…")}`);
	}
	if (error) for (const row of wrap(theme.fg("error", error), inner)) lines.push(`  ${row}`);
	return lines;
}

// ─── The open field ─────────────────────────────────────────────────────────

function labelLine(theme: Theme, model: HtmlFormModel, field: FormField, view: View, width: number): string {
	const pointer = view.focused ? theme.fg("accent", "❯ ") : "  ";
	let label = styled(theme, field.label, view.focused ? "accent" : "text");
	if (field.required) label += theme.fg("error", " *");
	if (field.kind === "text" && field.type === "number" && (field.min !== undefined || field.max !== undefined)) {
		const range =
			field.min !== undefined && field.max !== undefined
				? `${field.min}–${field.max}`
				: field.min !== undefined
					? `≥ ${field.min}`
					: `≤ ${field.max}`;
		label += theme.fg("dim", `  ${range}`);
	}
	return truncate(`${pointer}${label}`, width, "…");
}

function optionRows(
	theme: Theme,
	model: HtmlFormModel,
	index: number,
	field: ChoiceField,
	view: View,
	width: number,
	column: Column,
): void {
	const answer = model.answer(index);
	const rows = model.rows(index);
	const lines = column.lines;
	for (const row of rows) {
		const selected = view.focused && view.row === row;
		if (selected) column.focusStart = lines.length;
		const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
		if (row === OTHER_ROW) {
			const checked = answer.otherChosen;
			const editing = view.row === OTHER_ROW && view.active === index;
			const text = editing
				? caretLine(
						theme,
						answer.other.text,
						answer.other.cursor,
						"type your own",
						model.vim({ kind: "other", field: index })?.selection(),
					)
				: answer.other.text
					? theme.fg(
							checked && answer.other.text.trim() ? "muted" : "text",
							answer.other.text.replaceAll("\n", " "),
						)
					: theme.fg("dim", "type your own");
			// Chosen only counts once something is typed.
			const on = checked && answer.other.text.trim() !== "";
			const glyph = field.multi ? (on ? "☑" : "☐") : on ? "◉" : "○";
			const label = theme.fg(selected ? "accent" : on ? "muted" : "text", "Other: ");
			const line = `${cursor}${theme.fg(on ? "success" : "dim", glyph)} ${label}${text}`;
			// The field being typed in cuts like an editor: its ellipsis keeps the text's style.
			lines.push(editing ? clip(line, width) : truncate(line, width, "…"));
		} else {
			const option = field.options[row]!;
			const checked = answer.checked.has(row);
			const glyph = field.multi ? (checked ? "☑" : "☐") : checked ? "◉" : "○";
			// A submitted note, or a draft on an unchosen option.
			const marker = !answer.notes.has(row)
				? ""
				: checked
					? theme.fg("success", "  ✎ note")
					: theme.fg("dim", "  ✎ draft");
			// Long labels wrap under themselves.
			const color = selected ? "accent" : checked ? "muted" : "text";
			const flat = option.label.map(span => ({ text: span.text.replaceAll("\n", " "), style: span.style }));
			const wrapped = wrap(styled(theme, flat, color), Math.max(1, width - 4 - visibleWidth(marker)));
			wrapped.forEach((part, i) => {
				const head = i === 0 ? `${cursor}${theme.fg(checked ? "success" : "dim", glyph)} ` : "    ";
				lines.push(truncate(`${head}${part}${i === wrapped.length - 1 ? marker : ""}`, width, "…"));
			});
		}
		if (selected) column.focusEnd = lines.length;
		if (view.note && view.note.field === index && view.note.option === row) {
			const label = flattenLine(spansText(field.options[row]!.label));
			lines.push(clip(`    ${theme.fg("muted", `Note for ${label} · ${noteEditHint(model)}`)}`, width));
			lines.push(
				`    ${theme.fgResolved("text", `${view.note.text.slice(0, view.note.cursor)}▏${view.note.text.slice(view.note.cursor)}`)}`,
			);
			column.focusEnd = lines.length;
		}
	}
}

function dropdownRows(
	theme: Theme,
	model: HtmlFormModel,
	index: number,
	field: ChoiceField,
	view: View,
	width: number,
	space: number,
): string[] {
	const chosen = [...model.answer(index).checked][0];
	const answer = model.answer(index);
	const labelOf = (i: number): string => flattenLine(spansText(field.options[i]!.label));
	const markerOf = (i: number): string =>
		answer.notes.has(i) ? (answer.checked.has(i) ? "  ✎ note" : "  ✎ draft") : "";
	const natural = Math.max(...field.options.map((_, i) => visibleWidth(labelOf(i)) + visibleWidth(markerOf(i))));
	const boxWidth = Math.min(natural + 8, Math.max(8, width - 2 - DROPDOWN_RIGHT_MARGIN));
	const inside = boxWidth - 4;
	const count = field.options.length;
	const visible = Math.max(1, Math.min(count, space - 2));
	const highlight = view.dropdown ?? 0;
	let start = Math.max(0, Math.min(highlight - visible + 1, count - visible));
	if (highlight < start) start = highlight;
	const up = start > 0;
	const down = start + visible < count;
	const edge = (left: string, arrow: string, right: string): string =>
		theme.fg(
			"accent",
			`${left}${arrow ? `─${arrow}${"─".repeat(Math.max(0, boxWidth - 4))}` : "─".repeat(Math.max(0, boxWidth - 2))}${right}`,
		);
	const out = [`  ${edge("╭", up ? "↑" : "", "╮")}`];
	for (let i = start; i < start + visible; i++) {
		const selected = i === highlight;
		const pointer = selected ? "❯ " : "  ";
		const tick = i === chosen ? theme.fg("success", "✓") : " ";
		const room = Math.max(1, inside - 4);
		const marker = markerOf(i);
		const text = truncate(labelOf(i), Math.max(1, room - visibleWidth(marker)), "…");
		const body = `${theme.fg(selected ? "accent" : field.options[i]!.disabled ? "dim" : "text", `${pointer}${text}`)}${theme.fg(answer.checked.has(i) ? "success" : "dim", marker)}${" ".repeat(Math.max(0, room - visibleWidth(text) - visibleWidth(marker)))}`;
		out.push(`  ${theme.fg("accent", "│ ")}${body} ${tick}${theme.fg("accent", " │")}`);
	}
	out.push(`  ${edge("╰", down ? "↓" : "", "╯")}`);
	return out;
}

/** Cells a textarea's rows wrap at in a column `width` wide: past its bar, a cell short for the caret after a full row. */
function textareaWrap(width: number): number {
	return Math.max(1, width - 5);
}

function openFieldLines(
	theme: Theme,
	model: HtmlFormModel,
	index: number,
	view: View,
	width: number,
	column: Column,
): void {
	const field = model.field(index);
	const lines = column.lines;
	const error = model.error(index);
	column.focusStart = lines.length;
	if (field.kind === "choice" && !isDropdown(field)) {
		if (field.label.length > 0) lines.push(labelLine(theme, model, field, view, width));
		optionRows(theme, model, index, field, view, width, column);
	} else if (field.kind === "choice") {
		lines.push(labelLine(theme, model, field, view, width));
		const chosen = [...model.answer(index).checked][0] ?? 0;
		const bar = view.focused ? theme.fg("accent", "│") : theme.fg("dim", "│");
		const counter = `  ${chosen + 1}/${field.options.length}`;
		const room = Math.max(1, width - 4 - 4 - counter.length);
		const shown = truncate(flattenLine(spansText(field.options[chosen]!.label)), room, "…");
		const value = `${theme.fg("accent", "‹ ")}${theme.fg("accent", shown)}${theme.fg("accent", " ›")}${theme.fg("dim", counter)}`;
		lines.push(truncate(`  ${bar} ${value}`, width, "…"));
		column.focusEnd = lines.length;
		if (view.note && view.note.field === index) {
			const label = flattenLine(spansText(field.options[view.note.option]!.label));
			column.overlay = {
				at: lines.length,
				rows: [
					clip(`    ${theme.fg("muted", `Note for ${label} · ${noteEditHint(model)}`)}`, width),
					`    ${theme.fgResolved("text", `${view.note.text.slice(0, view.note.cursor)}▏${view.note.text.slice(view.note.cursor)}`)}`,
				],
			};
		} else if (view.dropdown !== undefined) column.overlay = { at: lines.length, rows: [] };
	} else {
		lines.push(labelLine(theme, model, field, view, width));
		const answer = model.answer(index);
		const bar = view.focused ? theme.fg("accent", "│") : theme.fg("dim", "│");
		if (field.multiline) {
			const text = answer.text.text;
			const cursor = answer.text.cursor;
			const room = Math.max(1, width - 4);
			const rows = layoutText(text, textareaWrap(width));
			const caretRow = rowOf(rows, cursor);
			const shown = Math.max(4, rows.length);
			for (let r = 0; r < shown; r++) {
				const row = rows[r];
				const part = row ? text.slice(row.start, row.textEnd) : "";
				let content = theme.fgResolved("text", part);
				// The caret: a bar after the row's text, else the character under it inverted.
				if (row && r === caretRow && view.focused) {
					const at = cursor - row.start;
					if (cursor >= row.textEnd) content = theme.fgResolved("text", `${part}▏`);
					else {
						const ch = String.fromCodePoint(part.codePointAt(at)!);
						content = theme.fgResolved(
							"text",
							`${part.slice(0, at)}${theme.style("inverse", ch)}${part.slice(at + ch.length)}`,
						);
					}
				}
				if (r === 0 && text === "") {
					// The placeholder sits at the right edge, a cell in from it; it goes when it does not fit.
					const placeholder = field.placeholder ?? "";
					const gap = room - 1 - visibleWidth(placeholder);
					content = theme.fgResolved("text", `▏${gap >= 1 ? `${" ".repeat(gap)}${placeholder}` : ""}`);
				}
				lines.push(truncate(`  ${bar} ${content}`, width, "…"));
				// A textarea taller than the box scrolls to the caret's row.
				if (r === caretRow) column.focusEnd = lines.length;
			}
		} else {
			const secret = field.type === "password";
			const text = secret ? "•".repeat([...answer.text.text].length) : answer.text.text;
			const line = caretLine(
				theme,
				text,
				secret ? 0 : answer.text.cursor,
				field.placeholder || undefined,
				model.vim({ kind: "text", field: index })?.selection(),
			);
			lines.push(clip(`  ${bar} ${line}`, width));
		}
		if (error) lines.push(clip(`    ${theme.fg("error", error)}`, width));
	}
	if (field.kind === "choice" && error)
		for (const row of wrap(theme.fg("error", error), Math.max(1, width - 4))) lines.push(`    ${row}`);
	column.focusEnd = Math.max(column.focusEnd, column.focusStart + 1);
}

// ─── The column ─────────────────────────────────────────────────────────────

function buildColumn(cx: PaintContext, look: HtmlFormLook, view: View, width: number): Column {
	const theme = cx.theme;
	const model = look.model;
	const { intro, groups } = model.layout;
	const column: Column = { lines: [], groupStart: 0, focusStart: 0, focusEnd: 0 };
	const lines = column.lines;
	const focused = typeof view.active === "number" ? model.field(view.active) : undefined;
	/** A blank row under the rows before the next ones (none when `tight`). */
	const part = (tight = false): void => {
		if (lines.length > 0 && !tight) lines.push("");
	};
	const emitParts = (parts: readonly FormPart[]): void => {
		for (const { section: s, start, end } of parts) {
			const section = model.form.sections[s]!;
			// A title keeps the block after it under it; a short text block right before a field, that field.
			let keep: "title" | "caption" | undefined;
			if (start === 0 && section.title.length > 0) {
				part();
				lines.push(...wrap(theme.style("strong", styled(theme, section.title, "text")), width));
				keep = "title";
			}
			for (let at = start; at < end; at++) {
				const block = section.blocks[at]!;
				if (block.kind !== "field") {
					if (isFoldCaption(section.blocks, at, focused, field => model.questions.get(field))) continue;
					const rows = blockLines(cx, block, width, look.media?.get(`c${s}.${at}`));
					part(keep === "title");
					lines.push(...rows);
					keep = block.kind === "text" && rows.length <= CAPTION_MAX_ROWS ? "caption" : undefined;
					continue;
				}
				part(keep !== undefined);
				keep = undefined;
				const index = model.form.fields.indexOf(block.field);
				if (block.field === focused) openFieldLines(theme, model, index, view, width, column);
				else lines.push(...foldLines(theme, model, index, width));
			}
		}
	};
	emitParts(intro);
	for (const group of groups) {
		if (typeof view.active !== "number" || !group.fields.includes(view.active)) {
			for (const index of group.fields) {
				part();
				lines.push(...foldLines(theme, model, index, width));
			}
			continue;
		}
		const before = lines.length;
		emitParts(group.parts);
		// The first group's head is the intro's too.
		column.groupStart = group.index === 0 || before === 0 ? 0 : before + 1;
	}
	lines.push("");
	const errors = model.errorCount();
	const submitFocused = view.active === "submit" && view.focused;
	if (view.active === "submit") column.groupStart = column.focusStart = lines.length;
	const fix = errors > 0 ? theme.fg("error", `  ${errors} flagged`) : "";
	lines.push(
		truncate(
			submitFocused
				? `${theme.style("strong", theme.fg("accent", "❯ Submit"))}${fix}`
				: `${theme.fg("muted", "  Submit")}${fix}`,
			width,
			"…",
		),
	);
	if (view.active === "submit") column.focusEnd = lines.length;
	return column;
}

function currentView(model: HtmlFormModel): View {
	const note = model.note();
	return {
		active: model.active(),
		row: model.row(),
		dropdown: model.dropdown(),
		note: note
			? { field: note.field, option: note.option, text: note.line.text, cursor: note.line.cursor }
			: undefined,
		focused: model.focused(),
	};
}

/** The tallest column any field could open (each opened as it would be now). */
function tallest(cx: PaintContext, look: HtmlFormLook, width: number, current: View): number {
	let max = buildColumn(cx, look, current, width).lines.length;
	const views: View[] = [{ ...current, active: "submit", dropdown: undefined, note: undefined }];
	look.model.fields.forEach((_, index) => {
		const rows = look.model.rows(index);
		views.push({ ...current, active: index, row: rows[0] ?? 0, dropdown: undefined, note: undefined });
	});
	for (const view of views) max = Math.max(max, buildColumn(cx, look, view, width).lines.length);
	return max;
}

function title(look: HtmlFormLook): string {
	const progress = look.model.progress();
	const head = `${look.title ?? "Ask"}${progress ? ` · ${progress}` : ""}`;
	return look.remaining === undefined ? head : `${head} (${Math.ceil(look.remaining / 1000)}s)`;
}

function paintHtmlForm(node: UiNode, cx: PaintContext): Block {
	const look = (node.props() as { term?: HtmlFormLook }).term;
	if (!look || cx.width < 8) return { rows: [] };
	const theme = cx.theme;
	const model = look.model;
	if (model.hidden()) {
		const total = model.fields.length;
		const head = theme.fg("accent", `${title(look)} hidden:`);
		const active = model.active();
		const question = active === "submit" ? model.question(0) : model.question(active);
		const more = total > 1 ? ` (+${total - 1} more)` : "";
		const show = `${bindingGlyph("app.ask.hide", "alt+h")}/${bindingGlyph("tui.select.confirm", "enter")}`;
		const hint = theme.fg("dim", ` · ${show} show · ${bindingGlyph("tui.select.cancel", "escape")} composer`);
		const room = Math.max(1, cx.width - visibleWidth(head) - 1 - visibleWidth(hint));
		return {
			rows: [
				truncate(
					`${head} ${theme.fg("muted", truncate(`${flattenLine(question)}${more}`, room, "…"))}${hint}`,
					cx.width,
					"…",
				),
			],
		};
	}
	const inner = cx.width - 4;
	const view = currentView(model);
	const skip = look.skipNotice ? wrap(theme.fg("warning", `⚠ ${flattenLine(look.skipNotice)}`), inner) : [];
	const limit = Math.max(1, Math.floor(look.terminalRows * HEIGHT_RATIO) - CHROME_ROWS);
	let column = buildColumn(cx, look, view, inner);
	let body = Math.min(tallest(cx, look, inner, view), limit);
	const overflow = column.lines.length > body;
	if (overflow) {
		column = buildColumn(cx, look, view, inner - 1);
		body = Math.min(tallest(cx, look, inner - 1, view), limit);
	}
	// Up/Down in a textarea step through the rows drawn here.
	model.wrapWidth = textareaWrap(overflow ? inner - 1 : inner);
	const rows = body - skip.length;
	const lines = column.lines;
	if (column.overlay) {
		const at = column.overlay.at;
		const space = Math.max(3, rows - at);
		const overlay =
			!view.note && view.dropdown !== undefined && typeof view.active === "number"
				? dropdownRows(theme, model, view.active, model.field(view.active) as ChoiceField, view, inner, space)
				: column.overlay.rows;
		overlay.forEach((row, i) => {
			lines[at + i] = row;
		});
	}
	const maxOffset = Math.max(0, lines.length - rows);
	// The open group from its top when it fits with the highlight; else the highlighted row on top
	// (a note under it: the note on the bottom).
	let offset =
		column.focusEnd - column.groupStart <= rows
			? column.groupStart
			: column.focusEnd - column.focusStart <= 1 && model.scrollAnchor() === "top"
				? column.focusStart
				: column.focusEnd - rows;
	offset = Math.max(0, Math.min(offset, maxOffset));
	const content: string[] = [];
	const scrolls = lines.length > rows;
	const thumb = scrolls ? Math.max(1, Math.floor((rows * rows) / lines.length)) : 0;
	const thumbAt = scrolls ? Math.round((offset / Math.max(1, maxOffset)) * (rows - thumb)) : 0;
	for (let i = 0; i < rows; i++) {
		const line = lines[offset + i] ?? "";
		if (!scrolls) content.push(line);
		else {
			const bar = i >= thumbAt && i < thumbAt + thumb ? theme.fg("accent", "█") : theme.fg("muted", "│");
			content.push(`${padTo(truncate(line, inner - 1, ""), inner - 1)}${bar}`);
		}
	}
	content.push(...skip);
	return { rows: boxRows(theme, title(look), content, cx.width) };
}

defineAskCardLook("omp.html-form", paintHtmlForm);
