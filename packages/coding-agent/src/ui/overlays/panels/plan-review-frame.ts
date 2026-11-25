/**
 * The plan review's terminal face at a size: a rounded box titled "Plan
 * Review" holding the Contents beside the scrolled plan (each section's
 * Markdown, its notes as callouts under their rows), then the prompt, the
 * model slider and the options, then the key hints, the note editor or the
 * note chooser. Also where clicks land (option, Contents and body rows).
 */
import { markdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeStatusText } from "../../../modes/view-model/chrome/shared";
import { keyGlyph } from "../../styles/panels/common";
import type { PlanAnnotation, PlanReviewModel } from "./plan-review-model";
import { stripInlineMarkdown } from "../../../plan-mode/plan-toc";
import type { Keybinding } from "../../../config/keybindings/app-keybindings";
import { actionKeyId } from "../../keys/hints";

/** What a note is on. */
export type AnnotationTarget =
	| { readonly kind: "section" }
	| { readonly kind: "line"; readonly row: number; readonly context: string; readonly contextTruncated?: boolean }
	| { readonly kind: "quote"; readonly quote: string; readonly at: number };

/** The plan row under a body row (a callout keeps its owner's). */
export interface BodyAnchor {
	readonly sectionIndex: number;
	readonly row: number;
	readonly context: string;
	readonly contextTruncated: boolean;
}

/** A rendered row's text as notes quote it. */
export interface LineContext {
	readonly text: string;
	readonly truncated: boolean;
}

/** The face at one size. */
export interface PlanFrame {
	readonly rows: string[];
	/** Rows the plan (and the Contents) get. */
	readonly regionRows: number;
	readonly maxOffset: number;
	readonly body: {
		readonly lines: readonly string[];
		readonly anchors: readonly BodyAnchor[];
		/** First body line of each section. */
		readonly offsets: readonly number[];
	};
	/** Frame row → option index / Contents position; rows of the plan. */
	readonly optionRows: ReadonlyMap<number, number>;
	readonly tocRows: ReadonlyMap<number, number>;
	readonly bodyRows: ReadonlySet<number>;
	/** Clicks left of this column on a Contents row go to the Contents. */
	readonly sidebarClickCols: number;
}

const TITLE = "Plan Review";
const MIN_BODY_ROWS = 3;
const MAX_EDITOR_ROWS = 6;
const CONTEXT_WIDTH = 120;
const SIDEBAR_MIN_WIDTH = 64;
const SIDEBAR_MIN_BODY = 40;
const QUOTE_MARKERS = /^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*/;
/** Segment colors by position (the status line's chip palette). */
const SEGMENT_COLORS = ["accent", "success", "warning", "error", "mdCode", "mdLink"];
const CHIP_TEXT = "\x1b[38;2;0;0;0m";

// ─── Section text ───────────────────────────────────────────────────────────

const kRendered = Symbol("omp.planReview.sectionRows");

interface ThemeWithRows {
	[kRendered]?: Map<string, string[]>;
}

/** A section's Markdown rows at `width` (a blank row closes a section that ends in a blank line). */
export function sectionRows(raw: string, width: number, theme: Theme): string[] {
	const holder = theme as Theme & ThemeWithRows;
	holder[kRendered] ??= new Map();
	const cache = holder[kRendered];
	const look = markdownLook();
	const key = `${width}\u0000${look.colorful}\u0000${look.mermaid}\u0000${raw}`;
	let rows = cache.get(key);
	if (!rows) {
		rows = renderMarkdown(raw, width, { theme, paddingX: 1 });
		if (rows.length > 0 && /\n[ \t]*\n\s*$/.test(raw)) rows.push("");
		if (cache.size > 512) cache.clear();
		cache.set(key, rows);
	}
	return rows;
}

function contextsOf(rows: readonly string[]): LineContext[] {
	return rows.map(line => {
		const text = sanitizeStatusText(line);
		return {
			text: truncate(text, CONTEXT_WIDTH, "…") || "(blank line)",
			truncated: visibleWidth(text) > CONTEXT_WIDTH,
		};
	});
}

/** A section's row contexts at the width notes are anchored at. */
export function lineContexts(raw: string, theme: Theme): LineContext[] {
	return contextsOf(sectionRows(raw, CONTEXT_WIDTH, theme));
}

function normalizeContext(context: LineContext): string {
	const text = sanitizeStatusText(context.text).replace(/\s+/g, " ").trim();
	return context.truncated && text.endsWith("…") ? text.slice(0, -1) : text;
}

/** The row of `contexts` nearest `row` whose text matches `context` (either containing the other), or -1. */
export function resolveLineRow(row: number, context: LineContext, contexts: readonly LineContext[]): number {
	if (contexts.length === 0) return -1;
	const want = normalizeContext(context);
	if (!want) return -1;
	const target = Math.max(0, Math.floor(row));
	let best = -1;
	contexts.forEach((candidate, i) => {
		const text = normalizeContext(candidate);
		if (text !== want && !text.includes(want) && !want.includes(text)) return;
		if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i;
	});
	return best;
}

/** The occurrence of `quote` in `text` nearest `around`, or -1. */
export function nearestOccurrence(text: string, quote: string, around: number): number {
	if (!quote) return -1;
	let best = -1;
	for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
		if (best < 0 || Math.abs(at - around) < Math.abs(best - around)) best = at;
		if (at > around) break;
	}
	return best;
}

/** The section holding `offset` (`starts` ascending). */
export function sectionAt(starts: readonly number[], offset: number): number {
	let index = 0;
	for (let i = 1; i < starts.length && starts[i]! <= offset; i++) index = i;
	return index;
}

/** A quote on one line. */
export function quoteLine(quote: string): string {
	return quote.replace(/\s+/g, " ").trim();
}

/** What a note is on, as the chooser lists it. */
export function annotationWhere(target: AnnotationTarget): string {
	if (target.kind === "line") return `line ${target.context}`;
	return target.kind === "quote" ? `“${quoteLine(target.quote)}”` : "section";
}

/** The row showing the start of `quote` (its first line, Markdown markers dropped); 0 when none does. */
export function quoteRow(contexts: readonly LineContext[], quote: string): number {
	const first = quote.split("\n").find(line => line.trim() !== "") ?? "";
	const probe = normalizeContext({
		text: stripInlineMarkdown(first.replace(QUOTE_MARKERS, "")).slice(0, 40),
		truncated: false,
	});
	if (!probe) return 0;
	return Math.max(
		0,
		contexts.findIndex(context => normalizeContext(context).includes(probe)),
	);
}

// ─── Body ───────────────────────────────────────────────────────────────────

function callout(theme: Theme, annotation: PlanAnnotation, width: number): string[] {
	const bar = theme.fg("warning", "▎ ");
	const rows: string[] = [];
	if (annotation.target.kind === "quote") {
		const quote = `“${replaceTabs(sanitizeText(quoteLine(annotation.target.quote)))}”`;
		rows.push(`${bar}${theme.fg("muted", truncate(quote, Math.max(0, width - 2), "…"))}`);
	}
	annotation.note.split(/\r?\n/).forEach((line, i) => {
		const lead = `${bar}${theme.fg("dim", i === 0 ? "note: " : "      ")}`;
		const shown = truncate(replaceTabs(sanitizeText(line)), Math.max(0, width - 8), "…");
		rows.push(truncate(`${lead}${theme.fg("accent", shown)}`, width, "…"));
	});
	return rows;
}

function buildBody(model: PlanReviewModel, width: number, theme: Theme): PlanFrame["body"] {
	const lines: string[] = [];
	const anchors: BodyAnchor[] = [];
	const offsets: number[] = [];
	model.sections.forEach((section, sectionIndex) => {
		offsets.push(lines.length);
		const rows = sectionRows(section.raw, width, theme);
		const contexts = contextsOf(rows);
		const notes = new Map<number, PlanAnnotation[]>();
		for (const annotation of section.annotations) {
			const target = annotation.target;
			const row =
				target.kind === "section"
					? 0
					: target.kind === "quote"
						? quoteRow(contexts, target.quote)
						: resolveLineRow(
								target.row,
								{ text: target.context, truncated: target.contextTruncated === true },
								contexts,
							);
			if (row < 0) continue;
			const list = notes.get(row);
			if (list) list.push(annotation);
			else notes.set(row, [annotation]);
		}
		rows.forEach((line, row) => {
			const anchor = { sectionIndex, row, context: contexts[row]!.text, contextTruncated: contexts[row]!.truncated };
			lines.push(line);
			anchors.push(anchor);
			for (const annotation of notes.get(row) ?? []) {
				for (const note of callout(theme, annotation, width)) {
					lines.push(note);
					anchors.push(anchor);
				}
			}
		});
	});
	return { lines, anchors, offsets };
}

// ─── Chrome ─────────────────────────────────────────────────────────────────

function sidebarWidthFor(width: number): number {
	return Math.max(18, Math.min(30, Math.round(width * 0.24)));
}

/** The body's width beside a sidebar `sidebar` wide (`│ sidebar │ body │`). */
function splitBodyWidth(width: number, sidebar: number): number {
	return Math.max(0, width - sidebar - 7);
}

function sliderRows(model: PlanReviewModel, theme: Theme): string[] {
	const slider = model.slider;
	if (!slider) return [];
	const index = model.sliderIndex;
	let track = "";
	slider.segments.forEach((segment, i) => {
		if (i > 0) track += i === index || i - 1 === index ? "  " : ` ${theme.fg("statusLineSep", "┆")} `;
		const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]!;
		if (i !== index) {
			track += theme.fg(color, segment.label);
			return;
		}
		const probe = theme.fg(color, "\u0000");
		const open = probe.slice(0, probe.indexOf("\u0000")).replace("\x1b[38;", "\x1b[48;");
		track += `${theme.fg(color, "◀")}${open}${CHIP_TEXT}${theme.style("strong", ` ${segment.label} `)}\x1b[49m${theme.fg(color, "▶")}`;
	});
	const left = theme.fg(index > 0 ? "accent" : "dim", "◂");
	const right = theme.fg(index < slider.segments.length - 1 ? "accent" : "dim", "▸");
	const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
	const rows = [`${caption}${left}  ${track}  ${right}`];
	const detail = slider.segments[index]?.detail;
	if (detail) rows.push(`  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`);
	return rows;
}

function optionRows(model: PlanReviewModel, theme: Theme): string[] {
	const active = model.focus === "actions";
	return model.entries().map((entry, i) => {
		const { label, meta } = model.entryLabel(entry);
		const selected = i === model.selected;
		const disabled = model.isDisabled(i);
		const cursor = selected ? theme.fg(active ? "accent" : "dim", `${theme.symbols.symbol("nav.cursor")} `) : "  ";
		let text = disabled
			? theme.fg("dim", label)
			: selected && active
				? theme.style("strong", theme.fg("accent", label))
				: theme.fg("text", label);
		if (meta) text += ` ${theme.fg("dim", `(${meta})`)}`;
		if (!disabled && i === model.hovered) text = theme.bg("selectedBg", ` ${text} `);
		return cursor + text;
	});
}

const HINT_KEYS: Readonly<Record<string, string>> = { pageUp: "PgUp", pageDown: "PgDn" };

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

function keys(...ids: string[]): string {
	return ids
		.map(boundId)
		.map(id => HINT_KEYS[id] ?? keyGlyph(id))
		.join("/");
}

function helpText(model: PlanReviewModel): string {
	const parts: string[] = [];
	if (model.focus === "actions") {
		parts.push(`${keys("up", "down")} select`, `${keys("confirm")} confirm`);
		if (model.slider) parts.push(`${keys("left", "right")} model`);
	} else if (model.focus === "toc") {
		parts.push(
			`${keys("up", "down")} section`,
			`${keys("confirm")} open`,
			"a annotate",
			"e edit",
			"d delete",
			"u undo",
		);
	} else {
		parts.push(
			`${keys("up", "down")} scroll`,
			`${keys("shift")} faster`,
			keys("pageUp", "pageDown"),
			`${keys("g", "shift+g")} ends`,
			"a annotate",
			"e edit",
			"u undo",
		);
	}
	if (model.callbacks.onCopyPlan) parts.push("c copy");
	parts.push(`${keys("tab")} regions`);
	if (model.externalEditorLabel && model.focus !== "toc") parts.push(`${model.externalEditorLabel} editor`);
	parts.push(model.helpText ?? `${keys(model.cancelKey)} cancel`);
	return parts.join(" · ");
}

/** The note draft's rows (`> ` gutter, the caret drawn as `▏`), cut to the rows it may take. */
function editorRows(model: PlanReviewModel, width: number, rows: number, theme: Theme): string[] {
	const { text, cursor } = model.draft;
	const room = Math.max(1, width - 2);
	const out: { line: string; caret: number }[] = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		const pieces = line === "" ? [""] : wrap(line, room);
		let consumed = 0;
		for (const piece of pieces) {
			const start = offset + line.indexOf(piece, consumed);
			const end = start + piece.length;
			out.push({ line: piece, caret: cursor >= start && cursor <= end ? cursor - start : -1 });
			consumed = end - offset;
		}
		offset += line.length + 1;
	}
	let caretRow = out.findIndex(entry => entry.caret >= 0);
	if (caretRow < 0) caretRow = out.length - 1;
	const start = Math.max(0, Math.min(caretRow - rows + 1, out.length - rows));
	return out.slice(start, start + rows).map((entry, i) => {
		const gutter = start + i === 0 ? "> " : "  ";
		let line = entry.line;
		if (start + i === caretRow) {
			const at = Math.max(0, entry.caret);
			line = `${line.slice(0, at)}▏${line.slice(at)}`;
		}
		return `${gutter}${theme.fgResolved("text", line)}`;
	});
}

function footerRows(
	model: PlanReviewModel,
	inner: number,
	maxChooserRows: number,
	rows: number,
	theme: Theme,
): string[] {
	const chooser = model.chooser;
	if (chooser) {
		if (maxChooserRows <= 0) return [];
		const limit = Number.isFinite(maxChooserRows)
			? Math.max(0, Math.floor(maxChooserRows) - 2)
			: chooser.entries.length;
		const start =
			limit >= chooser.entries.length
				? 0
				: Math.max(0, Math.min(chooser.selected - Math.floor(limit / 2), chooser.entries.length - limit));
		const lines = [theme.style("strong", theme.fg("accent", "Edit annotation"))];
		for (let i = start; i < Math.min(chooser.entries.length, start + limit); i++) {
			const ref = chooser.entries[i]!;
			const section = model.sections[ref.sectionIndex];
			const annotation = section?.annotations[ref.annotationIndex];
			if (!section || !annotation) continue;
			const marker = i === chooser.selected ? theme.fg("accent", "› ") : "  ";
			const label = `${marker}${sanitizeStatusText(section.title || "Plan preamble")} · ${annotationWhere(annotation.target)} · ${sanitizeStatusText(annotation.note)}`;
			lines.push(truncate(label, inner, "…"));
		}
		if (maxChooserRows >= 2)
			lines.push(
				theme.fg("dim", `${keys("up", "down")} choose · ${keys("confirm")} edit · ${keys(model.cancelKey)} cancel`),
			);
		return lines.slice(0, Math.max(0, Math.floor(maxChooserRows)));
	}
	if (model.annotating) {
		const target = model.target;
		const title = sanitizeStatusText((target && model.sections[target.sectionIndex]?.title) || "Plan preamble");
		const location =
			target?.row === null || !target
				? `‹${title}›`
				: `‹${title}› · ${truncate(target.context, Math.max(1, inner - 16), "…")}`;
		const caption = truncate(`${theme.fg("dim", "Annotate")} ${theme.fg("accent", location)}`, inner, "…");
		const hints = [`${keys("enter")} save`, `${keys("shift+enter")} newline`, `${keys(model.cancelKey)} cancel`];
		if (model.editing) hints.push("empty deletes");
		if (model.externalEditorLabel) hints.push(`${model.externalEditorLabel} editor`);
		const editorMax = Math.max(1, Math.min(MAX_EDITOR_ROWS, rows - 12));
		return [caption, ...editorRows(model, inner, editorMax, theme), theme.fg("dim", hints.join(" · "))];
	}
	return [theme.fg("dim", helpText(model))];
}

function tocEntry(model: PlanReviewModel, pos: number, cursor: number, width: number, theme: Theme): string {
	const section = model.sections[model.toc[pos]!]!;
	const highlighted = pos === cursor;
	const selected = highlighted && model.focus === "toc";
	const glow = highlighted && !selected;
	const indent = " ".repeat(Math.max(0, section.level - model.tocBaseLevel));
	const mark = section.annotations.length > 0 ? " ✎" : "";
	const title = truncate(
		section.title || "(untitled)",
		Math.max(0, width - 1 - indent.length - visibleWidth(mark)),
		"…",
	);
	const line = `${selected ? "›" : glow ? "▎" : " "}${indent}${title}${mark}`;
	if (selected) return theme.bg("selectedBg", theme.style("strong", width > 0 ? padTo(line, width) : ""));
	return theme.fg(glow ? "accent" : "muted", line);
}

// ─── Frame ──────────────────────────────────────────────────────────────────

/** The review's terminal face at `width` × `height`. */
export function planFrame(model: PlanReviewModel, width: number, height: number, theme: Theme): PlanFrame {
	const box = theme.symbols.box;
	const edge = (text: string) => theme.fg("border", text);
	const sidebarShown =
		model.toc.length >= 2 &&
		width >= SIDEBAR_MIN_WIDTH &&
		splitBodyWidth(width, sidebarWidthFor(width)) >= SIDEBAR_MIN_BODY;
	const sidebarWidth = sidebarShown ? sidebarWidthFor(width) : 0;
	const inner = Math.max(1, width - 4);
	const bodyWidth = sidebarShown ? splitBodyWidth(width, sidebarWidth) : inner;

	const committed = model.committed;
	const slider = committed ? [] : sliderRows(model, theme);
	const options = committed
		? [
				theme.style(
					"strong",
					theme.fg("accent", model.committedLabel ? `${model.committedLabel} — submitting…` : "Submitting…"),
				),
			]
		: optionRows(model, theme);
	const prompt = model.promptTitle ? [theme.style("strong", theme.fg("accent", model.promptTitle))] : [];
	const baseChrome = 4 + prompt.length + slider.length + options.length;
	const footer = committed
		? [theme.fg("dim", "Applying your selection — this can take a moment while context is prepared.")]
		: footerRows(
				model,
				inner,
				model.chooser ? Math.max(0, height - baseChrome - MIN_BODY_ROWS) : Number.POSITIVE_INFINITY,
				height,
				theme,
			);
	const chrome = baseChrome + footer.length;
	const regionRows = model.chooser ? Math.max(0, height - chrome) : Math.max(MIN_BODY_ROWS, height - chrome);

	const body = buildBody(model, bodyWidth, theme);
	const total = body.lines.length;
	const maxOffset = Math.max(0, total - regionRows);
	const offset = maxOffset > 0 ? Math.round(model.progress * maxOffset) : 0;
	const scrollbar = regionRows > 0 && bodyWidth > 0 && total > regionRows;
	const contentWidth = Math.max(0, bodyWidth - (scrollbar ? 1 : 0));
	let thumbStart = 0;
	let thumbEnd = 0;
	if (scrollbar) {
		const size = Math.max(1, Math.min(Math.floor((regionRows * regionRows) / total), regionRows));
		thumbStart = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * (regionRows - size));
		thumbEnd = thumbStart + size;
	}
	const bodyLine = (row: number): string => {
		const source = truncate(replaceTabs(body.lines[offset + row] ?? ""), contentWidth, "");
		if (!scrollbar) return source;
		const bar = row >= thumbStart && row < thumbEnd ? theme.fg("accent", "█") : theme.fg("dim", "│");
		return `${padTo(source, contentWidth)}${bar}`;
	};

	const rows: string[] = [];
	const optionRowsMap = new Map<number, number>();
	const tocRows = new Map<number, number>();
	const bodyRows = new Set<number>();
	const titleCut = (room: number) => truncate(` ${TITLE} `, Math.max(0, room), "…");
	const row = (content: string) =>
		`${edge(box.vertical)} ${width > 4 ? padTo(truncate(content, width - 4, "…"), width - 4) : ""} ${edge(box.vertical)}`;
	const divider = edge(`${box.teeRight}${box.horizontal.repeat(Math.max(0, width - 2))}${box.teeLeft}`);
	if (sidebarShown) {
		const leftLen = sidebarWidth + 2;
		const rightLen = Math.max(0, width - 2 - (sidebarWidth + 3));
		const shown = titleCut(leftLen - 1);
		rows.push(
			`${edge(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", shown))}${edge(`${box.horizontal.repeat(Math.max(0, leftLen - 1 - visibleWidth(shown)))}${box.teeDown}${box.horizontal.repeat(rightLen)}${box.topRight}`)}`,
		);
		const cursor = model.focus === "toc" ? model.tocCursor : model.scrolledTocPos(body.offsets, maxOffset);
		const count = model.toc.length;
		const start =
			count > regionRows ? Math.max(0, Math.min(cursor - Math.floor(regionRows / 2), count - regionRows)) : 0;
		for (let i = 0; i < regionRows; i++) {
			const pos = start + i;
			const entry = pos < count ? tocEntry(model, pos, cursor, sidebarWidth, theme) : "";
			if (pos < count) tocRows.set(rows.length, pos);
			bodyRows.add(rows.length);
			rows.push(
				`${edge(box.vertical)} ${padTo(entry, sidebarWidth)} ${edge(box.vertical)} ${bodyWidth > 0 ? padTo(bodyLine(i), bodyWidth) : ""} ${edge(box.vertical)}`,
			);
		}
		rows.push(
			edge(
				`${box.teeRight}${box.horizontal.repeat(leftLen)}${box.teeUp}${box.horizontal.repeat(rightLen)}${box.teeLeft}`,
			),
		);
	} else {
		const shown = titleCut(width - 4);
		rows.push(
			`${edge(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", shown))}${edge(`${box.horizontal.repeat(Math.max(0, width - 3 - visibleWidth(shown)))}${box.topRight}`)}`,
		);
		for (let i = 0; i < regionRows; i++) {
			bodyRows.add(rows.length);
			rows.push(row(bodyLine(i)));
		}
		rows.push(divider);
	}
	for (const line of [...prompt, ...slider]) rows.push(row(line));
	options.forEach((line, i) => {
		if (!committed) optionRowsMap.set(rows.length, i);
		rows.push(row(line));
	});
	rows.push(divider);
	for (const line of footer) rows.push(row(line));
	rows.push(edge(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	return {
		rows,
		regionRows,
		maxOffset,
		body,
		optionRows: optionRowsMap,
		tocRows,
		bodyRows,
		sidebarClickCols: sidebarShown ? sidebarWidth + 3 : 0,
	};
}
