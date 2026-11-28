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
import { type EditorRow, layoutText, rowOf } from "@oh-my-pi/pi-tui/term/painters/editor";
import { paintPicture } from "@oh-my-pi/pi-tui/term/painters/image";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import {
	padTo,
	replaceTabs,
	sliceCells,
	sliceColumns,
	spaces,
	truncate,
	visibleWidth,
	wrap,
} from "@oh-my-pi/pi-tui/text/width";
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { ChoiceField, FormBlock, FormField, FormSpan } from "../../../tools/html-form/parse";
import { spansText } from "../../../tools/html-form/parse";
import { type FormPart, isFoldCaption } from "../../forms/html-form/layout";
import type { MediaState } from "../../forms/html-form/media";
import { rasterLabel } from "../../transcript/figures/svg";
import { type Active, CANCEL_ENTRY, type HtmlFormModel, isDropdown, OTHER_ROW } from "../../forms/html-form/model";
import { foldPills } from "../../overlays/panels/ask-dialog";
import type { LineState } from "../../overlays/settings/line-edit";
import { defineAskCardLook } from "../panels/ask-dialog";
import { bindingGlyph, boxRows } from "../panels/common";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { actionKey, formatKeyHint, formatKeyHints } from "../../keys/hints";

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
	if (!field) {
		const press = `${enter} ${model.pressed()?.label.toLowerCase() ?? "submit"}`;
		action = model.actions.length > 0 ? `${formatKeyHints(["left", "right"])} choose · ${press}` : press;
	} else if (field.kind === "text") action = `${enter} ${next}`;
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

const NOTE_LAYOUT_LIMIT = 2048;
type NoteDisplayLine = LineState & { readonly omittedBefore: boolean; readonly omittedAfter: boolean };

/** What the column shows: which field is open and where its highlight is. */
interface View {
	readonly active: Active;
	readonly row: number;
	readonly dropdown: number | undefined;
	readonly note: (NoteDisplayLine & { readonly field: number; readonly option: number }) | undefined;
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

/** Crop a styled input around the caret, marking the edges with more text. */
function caretViewport(theme: Theme, line: string, width: number, caretEnd: number, caretWidth: number): string {
	if (width < caretWidth) return theme.style("inverse", " ");
	line = replaceTabs(line);
	const cells = visibleWidth(line);
	if (cells <= width) return line;
	if (width === caretWidth) return sliceColumns(line, caretEnd - caretWidth, caretEnd);
	const left = caretEnd >= width;
	const room = width - Number(left);
	const start = left ? Math.min(cells - room, Math.max(1, caretEnd - Math.max(caretWidth, Math.ceil(room / 2)))) : 0;
	const right = start + room < cells && caretEnd < start + room;
	const leading = left ? theme.fg("dim", "‹") : "";
	const trailing = right ? theme.fg("dim", "›") : "";
	return leading + sliceColumns(line, start, start + room - Number(right)) + trailing;
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
	width?: number,
): string {
	const flat = text.replaceAll("\n", " ");
	const at = Math.max(0, Math.min(cursor, flat.length));
	const grapheme = segmentGraphemes(flat).containing(at);
	const start = grapheme?.index ?? at;
	const ch = grapheme?.segment ?? " ";
	const before = flat.slice(0, start);
	const line =
		selection && selection.to > selection.from
			? `${flat.slice(0, selection.from)}${theme.style("inverse", flat.slice(selection.from, selection.to))}${flat.slice(selection.to)}`
			: `${before}${theme.style("inverse", ch)}${flat.slice(start + ch.length)}${!flat && placeholder ? theme.fg("dim", placeholder) : ""}`;
	if (width === undefined) return line;
	const caretWidth = Math.max(1, visibleWidth(ch));
	return caretViewport(theme, line, width, visibleWidth(before) + caretWidth, caretWidth);
}

/** Paint the caret after wrapping so moving it cannot change word breaks. */
function paintEditorRow(theme: Theme, text: string, row: EditorRow, caret: number | undefined): string {
	const part = text.slice(row.start, row.textEnd);
	if (caret === undefined) return theme.fgResolved("text", part);
	if (caret >= row.textEnd) return theme.fgResolved("text", `${part}▏`);
	const { index, segment } = segmentGraphemes(part).containing(caret - row.start)!;
	return theme.fgResolved(
		"text",
		`${part.slice(0, index)}${theme.style("inverse", segment)}${part.slice(index + segment.length)}`,
	);
}

/** Add an editor, returning the row after its caret for viewport anchoring. */
function appendWrappedEditorRows(
	lines: string[],
	theme: Theme,
	line: LineState,
	width: number,
	layouts: TextareaLayouts,
): number {
	const { text, cursor } = line;
	const indent = Math.min(4, Math.max(0, width - 3));
	const gutter = spaces(indent);
	const rows = textareaRows(layouts, text, editorWrapWidth(width, indent));
	const caretRow = rowOf(rows, cursor);
	const focusEnd = lines.length + caretRow + 1;
	for (let i = 0; i < rows.length; i++) {
		lines.push(gutter + paintEditorRow(theme, text, rows[i]!, i === caretRow ? cursor : undefined));
	}
	return focusEnd;
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
	layouts: TextareaLayouts,
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
			// Chosen only counts once something is typed.
			const on = checked && answer.other.text.trim() !== "";
			const glyph = field.multi ? (on ? "☑" : "☐") : on ? "◉" : "○";
			const label = theme.fg(selected ? "accent" : on ? "muted" : "text", "Other: ");
			const head = `${cursor}${theme.fg(on ? "success" : "dim", glyph)} ${label}`;
			if (editing) {
				const room = width - visibleWidth(head);
				if (room <= 0) lines.push(clip(head, width));
				else {
					const text = caretLine(
						theme,
						answer.other.text,
						answer.other.cursor,
						"type your own",
						model.vim({ kind: "other", field: index })?.selection(),
						room,
					);
					lines.push(head + text);
				}
			} else {
				const text = answer.other.text
					? theme.fg(on ? "muted" : "text", answer.other.text.replaceAll("\n", " "))
					: theme.fg("dim", "type your own");
				lines.push(truncate(head + text, width, "…"));
			}
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
			column.focusEnd = appendWrappedEditorRows(lines, theme, view.note, width, layouts);
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

/** Text columns past the editor gutter, leaving one cell for the caret at row end. */
function editorWrapWidth(width: number, indent = 4): number {
	return Math.max(1, width - indent - 1);
}

/** One paint's textarea layouts by wrap width, then text: a paint builds the column several times. */
type TextareaLayouts = Map<number, Map<string, EditorRow[]>>;

function textareaRows(layouts: TextareaLayouts, text: string, wrap: number): EditorRow[] {
	let byText = layouts.get(wrap);
	if (!byText) layouts.set(wrap, (byText = new Map()));
	let rows = byText.get(text);
	if (!rows) byText.set(text, (rows = layoutText(text, wrap)));
	return rows;
}

function openFieldLines(
	theme: Theme,
	model: HtmlFormModel,
	index: number,
	view: View,
	width: number,
	column: Column,
	layouts: TextareaLayouts,
): void {
	const field = model.field(index);
	const lines = column.lines;
	const error = model.error(index);
	column.focusStart = lines.length;
	if (field.kind === "choice" && !isDropdown(field)) {
		if (field.label.length > 0) lines.push(labelLine(theme, model, field, view, width));
		optionRows(theme, model, index, field, view, width, column, layouts);
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
			const rows = [clip(`    ${theme.fg("muted", `Note for ${label} · ${noteEditHint(model)}`)}`, width)];
			column.focusEnd = lines.length + appendWrappedEditorRows(rows, theme, view.note, width, layouts);
			column.overlay = { at: lines.length, rows };
		} else if (view.dropdown !== undefined) column.overlay = { at: lines.length, rows: [] };
	} else {
		lines.push(labelLine(theme, model, field, view, width));
		const answer = model.answer(index);
		const bar = view.focused ? theme.fg("accent", "│") : theme.fg("dim", "│");
		if (field.multiline) {
			const text = answer.text.text;
			const cursor = answer.text.cursor;
			const room = Math.max(1, width - 4);
			const rows = textareaRows(layouts, text, editorWrapWidth(width));
			const caretRow = rowOf(rows, cursor);
			const shown = Math.max(4, rows.length);
			for (let r = 0; r < shown; r++) {
				const row = rows[r];
				let content = row
					? paintEditorRow(theme, text, row, r === caretRow && view.focused ? cursor : undefined)
					: theme.fgResolved("text", "");
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
			const head = `  ${bar} `;
			const room = width - visibleWidth(head);
			if (room <= 0) lines.push(clip(head, width));
			else {
				let { text, cursor } = answer.text;
				let selection = model.vim({ kind: "text", field: index })?.selection();
				if (field.type === "password") {
					// One bullet per code point: map UTF-16 offsets onto the mask.
					const masked = (offset: number) => Array.from(text.slice(0, offset)).length;
					cursor = masked(cursor);
					if (selection) selection = { from: masked(selection.from), to: masked(selection.to) };
					text = "•".repeat(Array.from(text).length);
				}
				const line = caretLine(theme, text, cursor, field.placeholder || undefined, selection, room);
				lines.push(head + line);
			}
		}
		if (error) lines.push(clip(`    ${theme.fg("error", error)}`, width));
	}
	if (field.kind === "choice" && error)
		for (const row of wrap(theme.fg("error", error), Math.max(1, width - 4))) lines.push(`    ${row}`);
	column.focusEnd = Math.max(column.focusEnd, column.focusStart + 1);
}

// ─── The column ─────────────────────────────────────────────────────────────

function buildColumn(
	cx: PaintContext,
	look: HtmlFormLook,
	view: View,
	width: number,
	layouts: TextareaLayouts,
): Column {
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
				if (block.field === focused) openFieldLines(theme, model, index, view, width, column, layouts);
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
	// Submit, then a form's actions and Cancel in ←/→ order; the one Enter presses is highlighted while focused.
	const pressed = model.pressed();
	const entries = model.actions.length > 0 ? [undefined, ...model.actions, CANCEL_ENTRY] : [undefined];
	const buttons = entries
		.map(entry => {
			const label = entry?.label ?? "Submit";
			return submitFocused && entry === pressed
				? theme.style("strong", theme.fg("accent", `❯ ${label}`))
				: theme.fg("muted", `  ${label}`);
		})
		.join("  ");
	lines.push(truncate(`${buttons}${fix}`, width, "…"));
	if (view.active === "submit") column.focusEnd = lines.length;
	// Apply the note at its overlay position before counting rows. The picker itself needs the viewport height.
	if (column.overlay) {
		const { at, rows } = column.overlay;
		for (let i = 0; i < rows.length; i++) lines[at + i] = rows[i]!;
	}
	return column;
}

/**
 * A raw CR is stripped by the terminal writer and a tab jumps to the next stop; a space keeps
 * each one's caret cell and UTF-16 offset.
 */
const NOTE_CONTROL = /[\r\t]/g;

/** Prepare a caret-relative excerpt once per paint, without changing the draft or its offsets. */
function noteDisplayLine({ text, cursor }: LineState): NoteDisplayLine {
	if (text.length <= NOTE_LAYOUT_LIMIT)
		return { text: text.replace(NOTE_CONTROL, " "), cursor, omittedBefore: false, omittedAfter: false };

	// Keep the excerpt fixed as the caret moves within a page.
	const stride = NOTE_LAYOUT_LIMIT / 2;
	const start = Math.max(0, Math.floor(cursor / stride) * stride - stride / 2);
	const end = Math.min(text.length, start + NOTE_LAYOUT_LIMIT);
	const omittedBefore = start > 0;
	const omittedAfter = end < text.length;
	const sample = text.slice(start, end);
	const at = cursor - start;
	const segments = segmentGraphemes(sample);
	// Drop possibly clipped graphemes; if that would lose the caret, give it a visible cell.
	const from = omittedBefore ? segments.containing(0)!.segment.length : 0;
	const to = omittedAfter ? segments.containing(sample.length - 1)!.index : sample.length;
	if (from >= to || at < from || (omittedAfter && at >= to))
		return { text: "…", cursor: 0, omittedBefore, omittedAfter };

	return { text: sample.slice(from, to).replace(NOTE_CONTROL, " "), cursor: at - from, omittedBefore, omittedAfter };
}

function currentView(model: HtmlFormModel): View {
	const note = model.note();
	return {
		active: model.active(),
		row: model.row(),
		dropdown: model.dropdown(),
		note: note ? { field: note.field, option: note.option, ...noteDisplayLine(note.line) } : undefined,
		focused: model.focused(),
	};
}

/** The tallest column any field could open (each opened as it would be now). */
function tallest(cx: PaintContext, look: HtmlFormLook, width: number, current: View, layouts: TextareaLayouts): number {
	let max = buildColumn(cx, look, current, width, layouts).lines.length;
	const views: View[] = [{ ...current, active: "submit", dropdown: undefined, note: undefined }];
	look.model.fields.forEach((_, index) => {
		const rows = look.model.rows(index);
		views.push({ ...current, active: index, row: rows[0] ?? 0, dropdown: undefined, note: undefined });
	});
	for (const view of views) max = Math.max(max, buildColumn(cx, look, view, width, layouts).lines.length);
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
	const skip = look.skipNotice
		? wrap(theme.fg("warning", `${theme.symbols.symbol("status.warning")} ${flattenLine(look.skipNotice)}`), inner)
		: [];
	const limit = Math.max(1, Math.floor(look.terminalRows * HEIGHT_RATIO) - CHROME_ROWS);
	const layouts: TextareaLayouts = new Map();
	let column = buildColumn(cx, look, view, inner, layouts);
	// The notice takes its rows from the body, so measure the column against what it leaves.
	let rows = Math.min(tallest(cx, look, inner, view, layouts), limit) - skip.length;
	const overflow = column.lines.length > rows;
	if (overflow) {
		column = buildColumn(cx, look, view, inner - 1, layouts);
		rows = Math.min(tallest(cx, look, inner - 1, view, layouts), limit) - skip.length;
	}
	// Up/Down in a textarea step through the rows drawn here.
	model.wrapWidth = editorWrapWidth(overflow ? inner - 1 : inner);
	const lines = column.lines;
	// Only the picker waits for the viewport height; a note's rows were already written in buildColumn.
	if (column.overlay && !view.note && view.dropdown !== undefined && typeof view.active === "number") {
		const at = column.overlay.at;
		const space = Math.max(3, rows - at);
		const field = model.field(view.active) as ChoiceField;
		const picker = dropdownRows(theme, model, view.active, field, view, inner, space);
		picker.forEach((row, i) => {
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
	const omissions = `${view.note?.omittedBefore ? "‹" : ""}${view.note?.omittedAfter ? "›" : ""}`;
	const head = title(look);
	return { rows: boxRows(theme, omissions ? `${omissions} ${head}` : head, content, cx.width) };
}

defineAskCardLook("omp.html-form", paintHtmlForm);
