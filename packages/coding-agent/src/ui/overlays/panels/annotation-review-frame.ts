/**
 * The annotation review's terminal face: a rounded box titled "Code Review"
 * (or "Annotate Text") holding the file rail beside the current file's
 * header and its scrolled lines (notes as callouts above their line, file
 * and whole-text notes on top), then the review mode and the actions, then
 * the key hints, the note editor or the note chooser.
 */
import { padTo, replaceTabs, sliceColumns, truncate, visibleWidth, wrap, wrapChars } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ReviewDiffFile } from "../../../extensibility/custom-commands/bundled/annotate/annotation-types";
import { keyGlyph } from "../../styles/panels/common";
import {
	type AnnotationReviewModel,
	DISCARD_ANNOTATIONS_ACTION,
	fileLabel,
	isSourceRow,
	type TextNote,
	type DiffNote,
} from "./annotation-review-model";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Keybinding } from "../../../config/keybindings/app-keybindings";
import { actionKeyId } from "../../keys/hints";

/** The face at one width. */
export interface AnnotationFrame {
	readonly rows: string[];
	/** Rows the lines get. */
	readonly bodyRows: number;
	readonly maxOffset: number;
	/** The scroll this face shows (the stored one, clamped and following the cursor). */
	readonly offset: number;
	/** First body row of each source line. */
	readonly rowBySource: readonly number[];
}

const MIN_BODY_ROWS = 3;
const MAX_EDITOR_ROWS = 6;
const GUTTER = 2;
const RAIL_MIN_WIDTH = 64;
const RAIL_MIN_BODY = 40;
const HINT_KEYS: Readonly<Record<string, string>> = { pageUp: "PgUp", pageDown: "PgDn" };

/** Status text on one line: controls blanked, spaces collapsed. */
export function statusText(text: string): string {
	return sanitizeText(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function railWidth(width: number): number {
	return Math.max(18, Math.min(32, Math.round(width * 0.28)));
}

/** Whether the file rail fits a face `width` wide. */
export function canShowRail(width: number): boolean {
	return width >= RAIL_MIN_WIDTH && width - railWidth(width) - 7 >= RAIL_MIN_BODY;
}

/** List keys hinted by the user's selector bindings (`confirm` is the select-confirm key). */
const SELECT_HINTS: Readonly<Record<string, readonly [Keybinding, string]>> = {
	up: ["tui.select.up", "up"],
	down: ["tui.select.down", "down"],
	pageUp: ["tui.select.pageUp", "pageUp"],
	pageDown: ["tui.select.pageDown", "pageDown"],
	confirm: ["tui.select.confirm", "enter"],
};

function boundId(id: string): string {
	const select = SELECT_HINTS[id];
	return select ? actionKeyId(select[0], select[1]) : id;
}

function key(id: string): string {
	const bound = boundId(id);
	return HINT_KEYS[bound] ?? keyGlyph(bound);
}

/** `text` padded or cut to exactly `width` cells. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return padTo(truncate(text, width, "…"), width);
}

function callout(theme: Theme, note: string, width: number, label = "note"): string[] {
	const bar = theme.fg("warning", "▎ ");
	const tag = theme.fg("dim", `${label}: `);
	const continuation = `${bar}${" ".repeat(visibleWidth(tag))}`;
	return note.split(/\r?\n/).map((line, index) => {
		const prefix = index === 0 ? `${bar}${tag}` : continuation;
		const content = truncate(replaceTabs(sanitizeText(line)), Math.max(0, width - visibleWidth(prefix)), "…");
		return truncate(`${prefix}${theme.fg("accent", content)}`, width, "…");
	});
}

interface Body {
	readonly lines: string[];
	readonly rowBySource: number[];
}

function diffBody(model: AnnotationReviewModel, width: number, cursor: number, theme: Theme): Body {
	const file = model.currentFile();
	if (!file) return { lines: [theme.fg("dim", "No reviewable files")], rowBySource: [] };
	const lines: string[] = [];
	const rowBySource: number[] = [];
	const notes = model.notes.filter(entry => entry.fileIndex === model.fileIndex);
	// File notes describe the whole change: above everything.
	for (const entry of notes) {
		if (entry.annotation.scope === "file") lines.push(...callout(theme, entry.annotation.note, width, "file note"));
	}
	if (file.isBinary) {
		lines.push(theme.fg("dim", "Binary diff; no annotatable source rows"));
		return { lines, rowBySource };
	}
	if (file.rows.length === 0) {
		lines.push(theme.fg("dim", "No diff hunks; this may be a rename-only change"));
		return { lines, rowBySource };
	}
	const nav = theme.symbols.symbol("nav.cursor");
	let sourceIndex = 0;
	for (const row of file.rows) {
		if (!isSourceRow(row)) {
			lines.push(
				truncate(theme.fg(row.kind === "hunk" ? "accent" : "dim", replaceTabs(sanitizeText(row.raw))), width, "…"),
			);
			continue;
		}
		// A line's notes sit just above it.
		for (const entry of notes) {
			if (entry.sourceIndex === sourceIndex && entry.annotation.scope === "line")
				lines.push(...callout(theme, entry.annotation.note, width));
		}
		rowBySource[sourceIndex] = lines.length;
		const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
		const number = row.kind === "removed" ? row.oldLine : (row.newLine ?? row.oldLine);
		const prefix = `${marker}${String(number ?? "").padStart(4)} `;
		const color =
			row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : "toolDiffContext";
		const pieces = wrapChars(replaceTabs(sanitizeText(row.content)), Math.max(1, width - GUTTER - prefix.length));
		const selected = model.focus === "diff" && sourceIndex === cursor;
		(pieces.length > 0 ? pieces : [""]).forEach((piece, i) => {
			const gutter = selected && i === 0 ? fit(`${nav} `, GUTTER) : " ".repeat(GUTTER);
			const lead = i === 0 ? theme.fg(color, prefix) : " ".repeat(prefix.length);
			const line = `${gutter}${lead}${theme.fg(color, piece)}`;
			lines.push(truncate(selected ? theme.bg("selectedBg", fit(line, width)) : line, width, "…"));
		});
		sourceIndex++;
	}
	return { lines, rowBySource };
}

function textBody(model: AnnotationReviewModel, width: number, cursor: number, theme: Theme): Body {
	const lines: string[] = [];
	const rowBySource: number[] = [];
	const textWidth = Math.max(1, width - GUTTER);
	const nav = theme.symbols.symbol("nav.cursor");
	for (const entry of model.textNotes) {
		if (entry.annotation.scope === "text") lines.push(...callout(theme, entry.annotation.note, width, "text note"));
	}
	model.textLines.forEach((source, sourceIndex) => {
		for (const entry of model.textNotes) {
			if (entry.annotation.scope === "line" && entry.sourceIndex === sourceIndex)
				lines.push(...callout(theme, entry.annotation.note, width));
		}
		rowBySource[sourceIndex] = lines.length;
		const pieces = wrapChars(replaceTabs(sanitizeText(source)), textWidth);
		const selected = model.focus === "diff" && sourceIndex === cursor;
		(pieces.length > 0 ? pieces : [""]).forEach((piece, i) => {
			const gutter = selected && i === 0 ? fit(`${nav} `, GUTTER) : " ".repeat(GUTTER);
			const line = fit(`${gutter}${piece}`, width);
			lines.push(selected ? theme.bg("selectedBg", line) : line);
		});
	});
	return { lines, rowBySource };
}

/** The source line resting at the top of the view (or its last line after paging to the end). */
function viewportSource(
	rowBySource: readonly number[],
	top: number,
	rows: number,
	toEnd: boolean,
	max: number,
): number {
	const bottom = top + Math.max(0, rows - 1);
	let topSource = 0;
	let lastVisible = 0;
	for (let index = 1; index < rowBySource.length; index++) {
		const row = rowBySource[index];
		if (row === undefined || row > bottom) break;
		lastVisible = index;
		if (row <= top) topSource = index;
	}
	return toEnd && top >= max ? lastVisible : topSource;
}

function header(model: AnnotationReviewModel, width: number, theme: Theme): string {
	if (model.textSource) {
		const count = model.textNotes.length;
		const suffix = count ? theme.fg("dim", `  ✎${count}`) : "";
		return truncate(`${theme.style("strong", statusText(model.textSource.label))}${suffix}`, width, "…");
	}
	const file = model.currentFile();
	if (!file) return theme.fg("dim", "No reviewable files");
	const count = model.noteCount(model.fileIndex);
	const suffix = `  +${file.linesAdded}/-${file.linesRemoved}${count ? `  ✎${count}` : ""}`;
	return truncate(`${theme.style("strong", statusText(fileLabel(file)))}${theme.fg("dim", suffix)}`, width, "…");
}

function railRows(model: AnnotationReviewModel, rows: number, width: number, theme: Theme): string[] {
	const start = Math.max(0, Math.min(model.fileIndex - Math.floor(rows / 2), Math.max(0, model.files.length - rows)));
	return Array.from({ length: rows }, (_, row) => {
		const index = start + row;
		const file = model.files[index];
		if (!file) return "";
		const selected = index === model.fileIndex;
		const count = model.noteCount(index);
		const badge =
			theme.fg("dim", ` +${file.linesAdded}/-${file.linesRemoved}`) +
			(count ? theme.fg("warning", ` ✎${count}`) : "");
		const label = truncate(statusText(fileLabel(file)), Math.max(0, width - visibleWidth(badge) - 2), "…");
		const focused = model.focus === "files";
		const line = fit(`${selected ? (focused ? "› " : "▎ ") : "  "}${label}${badge}`, width);
		return selected && focused
			? theme.bg("selectedBg", theme.style("strong", line))
			: theme.fg(selected ? "accent" : "muted", line);
	});
}

function actionRows(model: AnnotationReviewModel, theme: Theme): string[] {
	const confirmation = model.refreshConfirmationCopy;
	if (confirmation) {
		return model.actions.map((_, index) =>
			index === 0
				? theme.style("strong", confirmation.question)
				: index === 1
					? theme.fg("dim", `${key("y")} ${confirmation.accept} · ${key(model.cancelKey)}/n keep draft`)
					: "",
		);
	}
	const nav = theme.symbols.symbol("nav.cursor");
	return model.actions.map((action, index) => {
		const label = action === DISCARD_ANNOTATIONS_ACTION && model.discardArmed ? "Confirm: discard all notes" : action;
		const selected = index === model.actionIndex;
		const text = model.actionDisabled(index)
			? theme.fg("dim", label)
			: selected && model.focus === "actions"
				? theme.style("strong", theme.fg("accent", label))
				: theme.fg("text", label);
		return `${selected ? `${nav} ` : "  "}${text}`;
	});
}

function noteLocation(model: AnnotationReviewModel, index: number): string {
	if (model.textSource) {
		const entry: TextNote | undefined = model.textNotes[index];
		if (!entry) return "";
		const label = statusText(model.textSource.label);
		return entry.annotation.scope === "text" ? `${label} · text` : `${label} · line ${entry.annotation.line}`;
	}
	const entry: DiffNote | undefined = model.notes[index];
	if (!entry) return "";
	const file = fileLabel(model.files[entry.fileIndex] as ReviewDiffFile);
	const annotation = entry.annotation;
	return annotation.scope === "file"
		? `${file} · file`
		: `${file} · ${annotation.oldLine ?? "-"}/${annotation.newLine ?? "-"}`;
}

function chooserRows(model: AnnotationReviewModel, width: number, maxRows: number, theme: Theme): string[] {
	const chooser = model.chooser!;
	if (maxRows <= 0) return [];
	const nav = theme.symbols.symbol("nav.cursor");
	const entry = (index: number, position: number): string => {
		const notes = model.textSource ? model.textNotes : model.notes;
		const annotation = notes[index]?.annotation;
		if (!annotation) return "";
		const marker = position === chooser.selected ? `${nav} ` : "  ";
		const note = statusText(annotation.note.split(/\r?\n/, 1)[0] ?? "");
		return fit(`${marker}${noteLocation(model, index)} · ${note}`, width);
	};
	const available = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : Number.POSITIVE_INFINITY;
	if (available === 1) {
		const index = chooser.entries[chooser.selected];
		return index === undefined ? [] : [entry(index, chooser.selected)];
	}
	const limit = Number.isFinite(available) ? Math.max(1, available - 2) : chooser.entries.length;
	const start =
		limit >= chooser.entries.length
			? 0
			: Math.max(0, Math.min(chooser.selected - Math.floor(limit / 2), chooser.entries.length - limit));
	const options = chooser.entries.slice(start, start + limit).map((index, i) => entry(index, start + i));
	const keys = `${key("up")}/${key("down")} choose · ${key("confirm")} edit · ${key(model.cancelKey)} cancel`;
	const lines =
		available === 2
			? [theme.fg("dim", `Edit annotation · ${keys}`), ...options.slice(0, 1)]
			: [theme.fg("dim", `Edit annotation · ${keys}`), ...options, theme.fg("dim", keys)];
	return Number.isFinite(available) ? lines.slice(0, available) : lines;
}

/** What the open note does and where it lands. */
export function noteCaption(model: AnnotationReviewModel): { action: string; location: string } {
	let location: string;
	let action: string;
	const editing = model.editingIndex !== undefined;
	if (model.textSource) {
		const label = statusText(model.textSource.label);
		location = model.scope === "text" ? `${label} · text` : `${label} · line ${model.sourceIndex + 1}`;
		action = editing ? "Edit annotation" : model.scope === "text" ? "Annotate text" : "Annotate line";
	} else {
		const file = model.currentFile();
		const source = model.currentSourceRows()[model.sourceIndex];
		location =
			model.scope === "file"
				? file
					? `${fileLabel(file)} · file`
					: "file"
				: source && file
					? `${fileLabel(file)} · ${source.oldLine ?? "-"}/${source.newLine ?? "-"}`
					: "diff row";
		action = editing ? "Edit annotation" : model.scope === "file" ? "Annotate file" : "Annotate line";
	}
	return { action, location: statusText(location) };
}

/** The note draft's rows: a `> ` gutter, the caret drawn as the cursor glyph. */
function editorRows(model: AnnotationReviewModel, width: number, rows: number, theme: Theme): string[] {
	const caret = theme.symbols.symbol("nav.cursor");
	const { text, cursor } = model.draft;
	const room = Math.max(1, width - 2);
	const out: { line: string; caret: number }[] = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		const pieces = wrapChars(line, room);
		let start = offset;
		for (const piece of pieces.length > 0 ? pieces : [""]) {
			const end = start + piece.length;
			out.push({ line: piece, caret: cursor >= start && cursor <= end ? cursor - start : -1 });
			start = end;
		}
		offset += line.length + 1;
	}
	let caretRow = out.findIndex(entry => entry.caret >= 0);
	if (caretRow < 0) caretRow = out.length - 1;
	const first = Math.max(0, Math.min(caretRow - rows + 1, out.length - rows));
	return out.slice(first, first + rows).map((entry, i) => {
		let line = entry.line;
		if (first + i === caretRow) line = `${line.slice(0, entry.caret)}${caret}${line.slice(entry.caret)}`;
		return `${first + i === 0 ? "> " : "  "}${line}`;
	});
}

function helpText(model: AnnotationReviewModel): string {
	const upDown = `${key("up")}/${key("down")}`;
	const focus =
		model.focus === "files"
			? `${upDown} file · ${key("confirm")} diff · a/${key("shift+a")} file note · e edit note`
			: model.focus === "diff"
				? `${upDown} line · ${key("shift")} faster · ${key("pageUp")}/${key("pageDown")} · g/${key("shift+g")} ends · a line note · ${key("shift+a")} ${model.textSource ? "text" : "file"} note · e edit note`
				: `${upDown} select · ${key("confirm")} confirm`;
	const refresh = model.callbacks.onRefresh ? (model.refreshing ? "Refreshing…" : `${key("r")} refresh`) : undefined;
	const editor = model.callbacks.onExternalEditor ? `${key(model.externalEditorKey)} editor` : undefined;
	return [refresh, focus, "u undo", `${key("tab")} regions`, editor, `${key(model.cancelKey)} cancel`]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
}

function footerRows(model: AnnotationReviewModel, width: number, chooserRowsMax: number, height: number, theme: Theme) {
	if (model.chooser) return chooserRows(model, width, chooserRowsMax, theme);
	if (model.annotating) {
		const { action, location } = noteCaption(model);
		const caption = truncate(`${theme.fg("dim", action)} ${theme.fg("accent", location)}`, width, "…");
		const hints = [
			`${key("enter")} save`,
			`${key("shift+enter")} newline`,
			`${key(model.cancelKey)} close, keep note`,
			`${key(model.externalEditorKey)} editor`,
		];
		const editorMax = Math.max(1, Math.min(MAX_EDITOR_ROWS, height - 12));
		return [caption, ...editorRows(model, width, editorMax, theme), theme.fg("dim", hints.join(" · "))];
	}
	return [model.warning ? theme.fg("warning", statusText(model.warning)) : theme.fg("dim", helpText(model))];
}

/** The focused file's full path over the rows from its rail entry down, when the rail cuts it. */
function revealPath(
	model: AnnotationReviewModel,
	rows: string[],
	width: number,
	sidebar: number,
	bodyRows: number,
	theme: Theme,
): void {
	const file = model.currentFile();
	if (!file || model.focus !== "files" || model.annotating || model.chooser) return;
	const column = 4;
	const room = Math.max(0, width - column - 1);
	const label = replaceTabs(statusText(fileLabel(file)));
	if (room === 0 || !label) return;
	const count = model.noteCount(model.fileIndex);
	const badge = ` +${file.linesAdded}/-${file.linesRemoved}${count ? ` ✎${count}` : ""}`;
	if (visibleWidth(label) <= Math.max(0, sidebar - visibleWidth(badge) - 2)) return;
	const railRows = bodyRows + 1;
	const start = Math.max(
		0,
		Math.min(model.fileIndex - Math.floor(railRows / 2), Math.max(0, model.files.length - railRows)),
	);
	const selected = 1 + model.fileIndex - start;
	if (selected < 1 || selected > railRows) return;
	let lines = wrap(label, room);
	if (lines.length > railRows) {
		lines = lines.slice(-railRows);
		lines[0] = truncate(`…${lines[0] ?? ""}`, room, "");
	}
	const top = Math.max(1, Math.min(selected, railRows - lines.length + 1));
	const span = Math.min(room, Math.max(0, ...lines.map(visibleWidth)) + 1);
	lines.forEach((line, i) => {
		const base = rows[top + i];
		if (base === undefined || span <= 0) return;
		const shown = theme.bg("selectedBg", theme.style("strong", fit(line, span)));
		rows[top + i] = `${sliceColumns(base, 0, column)}${shown}${sliceColumns(base, column + span, width)}`;
	});
}

/** The review's terminal face at `width` × the terminal's `height`. */
export function annotationFrame(
	model: AnnotationReviewModel,
	width: number,
	height: number,
	theme: Theme,
): AnnotationFrame {
	const box = theme.symbols.box;
	const edge = (text: string) => theme.fg("border", text);
	const rail = !model.textSource && canShowRail(width);
	const sidebar = rail ? railWidth(width) : 0;
	const inner = Math.max(1, width - 4);
	const bodyWidth = rail ? Math.max(0, width - sidebar - 7) : inner;
	const actionCount = model.actions.length;
	const chooserBase = height - (actionCount + 7);
	const footer = footerRows(
		model,
		inner,
		model.chooser
			? Math.max(0, Math.min(chooserBase, Math.max(3, chooserBase - MIN_BODY_ROWS)))
			: Number.POSITIVE_INFINITY,
		height,
		theme,
	);
	const available = height - (actionCount + footer.length + 7);
	const bodyRows = model.chooser ? Math.max(0, available) : Math.max(MIN_BODY_ROWS, available);
	const contentWidth = Math.max(1, bodyWidth - 1);

	// Lay out once to place the view, then again with the cursor the view settles on.
	const build = (cursor: number) =>
		model.textSource ? textBody(model, contentWidth, cursor, theme) : diffBody(model, contentWidth, cursor, theme);
	let body = build(model.sourceIndex);
	const total = body.lines.length;
	const maxOffset = Math.max(0, total - bodyRows);
	let offset = Math.max(0, Math.min(model.offset, maxOffset));
	if (model.viewportDriven) {
		if (!model.annotating && !model.chooser && body.rowBySource.length > 0) {
			const cursor = viewportSource(body.rowBySource, offset, bodyRows, model.viewportTowardEnd, maxOffset);
			if (cursor !== model.sourceIndex) body = build(cursor);
		}
	} else {
		const row = body.rowBySource[model.sourceIndex];
		if (row !== undefined) {
			if (row < offset) offset = row;
			else if (row >= offset + bodyRows) offset = row - bodyRows + 1;
		}
		offset = Math.max(0, Math.min(offset, maxOffset));
	}
	const scrollbar = bodyRows > 0 && total > bodyRows;
	const shownWidth = Math.max(0, bodyWidth - (scrollbar ? 1 : 0));
	let thumbStart = 0;
	let thumbEnd = 0;
	if (scrollbar) {
		const size = Math.max(1, Math.min(Math.floor((bodyRows * bodyRows) / total), bodyRows));
		thumbStart = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * (bodyRows - size));
		thumbEnd = thumbStart + size;
	}
	const bodyLine = (row: number): string => {
		const source = truncate(replaceTabs(body.lines[offset + row] ?? ""), shownWidth, "");
		if (!scrollbar) return source;
		const bar = row >= thumbStart && row < thumbEnd ? theme.fg("accent", "█") : theme.fg("dim", "│");
		return `${padTo(source, shownWidth)}${bar}`;
	};

	const title = model.textSource ? "Annotate Text" : "Code Review";
	const row = (content: string) =>
		`${edge(box.vertical)} ${width > 4 ? padTo(truncate(content, width - 4, "…"), width - 4) : ""} ${edge(box.vertical)}`;
	const divider = edge(`${box.teeRight}${box.horizontal.repeat(Math.max(0, width - 2))}${box.teeLeft}`);
	const rows: string[] = [];
	if (rail) {
		const leftLen = sidebar + 2;
		const rightLen = Math.max(0, width - 2 - (sidebar + 3));
		const shown = truncate(` ${title} `, Math.max(0, leftLen - 1), "…");
		rows.push(
			`${edge(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", shown))}${edge(`${box.horizontal.repeat(Math.max(0, leftLen - 1 - visibleWidth(shown)))}${box.teeDown}${box.horizontal.repeat(rightLen)}${box.topRight}`)}`,
		);
		const files = railRows(model, bodyRows + 1, sidebar, theme);
		const split = (left: string, right: string) =>
			`${edge(box.vertical)} ${padTo(left, sidebar)} ${edge(box.vertical)} ${bodyWidth > 0 ? padTo(right, bodyWidth) : ""} ${edge(box.vertical)}`;
		rows.push(split(files[0] ?? "", header(model, bodyWidth, theme)));
		for (let i = 0; i < bodyRows; i++) rows.push(split(files[i + 1] ?? "", bodyLine(i)));
		rows.push(
			edge(
				`${box.teeRight}${box.horizontal.repeat(leftLen)}${box.teeUp}${box.horizontal.repeat(rightLen)}${box.teeLeft}`,
			),
		);
	} else {
		const shown = truncate(` ${title} `, Math.max(0, width - 4), "…");
		rows.push(
			`${edge(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", shown))}${edge(`${box.horizontal.repeat(Math.max(0, width - 3 - visibleWidth(shown)))}${box.topRight}`)}`,
		);
		rows.push(row(header(model, inner, theme)));
		for (let i = 0; i < bodyRows; i++) rows.push(row(bodyLine(i)));
		rows.push(divider);
	}
	rows.push(row(theme.style("strong", theme.fg("accent", statusText(model.mode)))));
	for (const action of actionRows(model, theme)) rows.push(row(action));
	rows.push(divider);
	for (const line of footer) rows.push(row(line));
	rows.push(edge(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	if (rail) revealPath(model, rows, width, sidebar, bodyRows, theme);
	return { rows, bodyRows, maxOffset, offset, rowBySource: body.rowBySource };
}
