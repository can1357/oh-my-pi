/**
 * The hook selector's terminal look: a framed panel with the heading (and
 * the countdown's seconds), detail lines, the slider track, the options
 * (markers, inline markdown, descriptions; the cursor option on the
 * selection band), a search/count line once the list scrolls or filters,
 * and the key hints. Drawn for the `picker` sheet (`term.look = "omp.hook"`)
 * and for the card variant (role `omp.overlay.hook-select`).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, type Block, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { boxBottom, boxRow, boxTop, definePickerLook, type PickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { bindingGlyph, selectNavGlyphs } from "../panels/common";
import { caretField, inlineMarkdown } from "./common";

/** One visible option. */
export interface HookLookOption {
	readonly label: string;
	readonly description?: string;
	readonly disabled: boolean;
	readonly marker?: { readonly kind: "radio" | "checkbox"; readonly checked: boolean };
}

/** The look's term facts (on the picker or the card). */
export type HookLookTerm = PickerTerm & {
	readonly look: "omp.hook";
	/** The heading (first title line, with the countdown's seconds). */
	readonly title: string;
	readonly details: readonly string[];
	readonly slider?: {
		readonly caption?: string;
		readonly segments: readonly { readonly label: string; readonly detail?: string }[];
		readonly index: number;
	};
	readonly outline: boolean;
	/** The options shown, filtered, in order. */
	readonly options: readonly HookLookOption[];
	/** The cursor's position in `options`. */
	readonly cursor: number;
	/** Options before filtering. */
	readonly total: number;
	readonly maxVisible: number;
	readonly searchable: boolean;
	readonly query: { readonly text: string; readonly cursor: number };
	readonly help?: string;
};

/** Segment colors by position (the status line's chip palette). */
const SEGMENT_COLORS = ["accent", "success", "warning", "error", "mdCode", "mdLink"];
/** Label color on a filled chip. */
const CHIP_TEXT = "\x1b[38;2;0;0;0m";

/** `text` on a background of foreground color `color` (theme backgrounds are their own keys). */
function fillWith(theme: Theme, color: string, text: string): string {
	const probe = theme.style(color, "\u0000");
	const open = probe.slice(0, probe.indexOf("\u0000")).replace("\x1b[38;", "\x1b[48;");
	return open.startsWith("\x1b[48;") ? `${open}${text}\x1b[49m` : theme.style("inverse", text);
}

function sliderRows(theme: Theme, slider: NonNullable<HookLookTerm["slider"]>, width: number): string[] {
	const { segments, index } = slider;
	const symbols = theme.symbols;
	const leftCap = symbols.symbol("sep.powerlineRight");
	const rightCap = symbols.symbol("sep.powerlineLeft");
	const separator = ` ${theme.style("statusLineSep", symbols.symbol("sep.powerlineThin"))} `;
	let track = "";
	segments.forEach((segment, i) => {
		if (i > 0) track += i === index || i - 1 === index ? "  " : separator;
		const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]!;
		track +=
			i === index
				? `${theme.style(color, leftCap)}${fillWith(theme, color, `${CHIP_TEXT}${theme.style("strong", ` ${segment.label} `)}`)}${theme.style(color, rightCap)}`
				: theme.style(color, segment.label);
	});
	const left = theme.style(index > 0 ? "accent" : "dim", "◂");
	const right = theme.style(index < segments.length - 1 ? "accent" : "dim", "▸");
	const caption = slider.caption ? `${theme.style("dim", slider.caption)}  ` : "";
	const rows = wrap(`${caption}${left}  ${track}  ${right}`, width);
	const detail = segments[index]?.detail;
	if (detail) rows.push(...wrap(`  ${theme.style("dim", "↳")} ${theme.style("muted", detail)}`, width));
	return rows;
}

/** The rendered lines of one option (label, then its description). */
function optionLines(
	theme: Theme,
	option: HookLookOption,
	selected: boolean,
	descRows: number | "full",
	width: number,
): string[] {
	const textColor = option.disabled ? "dim" : selected ? "accent" : "text";
	const label = inlineMarkdown(theme, option.label, textColor);
	let prefix: string;
	if (option.marker?.kind === "radio") {
		const color = option.disabled ? "dim" : selected ? "accent" : "dim";
		const marker = theme.symbols.symbol(selected ? "radio.selected" : "radio.unselected");
		prefix = theme.style(color, `${marker} `);
	} else if (option.marker?.kind === "checkbox") {
		const color = option.disabled ? "dim" : selected ? "accent" : option.marker.checked ? "success" : "dim";
		const marker = theme.symbols.symbol(option.marker.checked ? "checkbox.checked" : "checkbox.unchecked");
		prefix = theme.style(color, `${marker} `);
	} else if (selected) {
		prefix = theme.style(option.disabled ? "dim" : "accent", `${theme.symbols.symbol("nav.cursor")} `);
	} else {
		prefix = "  ";
	}
	const lines = [prefix + label];
	if (option.description && descRows !== 0) {
		const color = option.disabled ? "dim" : "muted";
		const description = inlineMarkdown(theme, option.description, color);
		if (descRows === "full") lines.push(`    ${description}`);
		else {
			const body = Math.max(1, width - 2 - 4);
			const wrapped = wrap(description, body);
			const kept = wrapped.slice(0, descRows);
			if (wrapped.length > descRows && descRows > 0)
				kept[descRows - 1] = truncate(wrapped.slice(descRows - 1).join(" "), body, theme.symbols.ellipsis);
			for (const row of kept) lines.push(`    ${row}`);
		}
	}
	return lines;
}

/** Rows a line takes in the list (wrapped inside the list's padding, or the outline keeping indents). */
function lineRows(line: string, width: number, outline: boolean): string[] {
	const normalized = replaceTabs(line);
	const inner = Math.max(1, width - 2);
	if (!outline) return wrap(normalized, inner).length > 0 ? wrap(normalized, inner) : [""];
	const indent = normalized.match(/^ */)![0].slice(0, Math.max(0, inner - 1));
	const body = normalized.slice(normalized.match(/^ */)![0].length);
	const wrapped = wrap(body, Math.max(1, inner - indent.length));
	return (wrapped.length > 0 ? wrapped : [""]).map(row => `${indent}${row}`);
}

/** A centered window of rows around `selected` within `budget` rows. */
function menuWindow(counts: readonly number[], selected: number, budget: number): { start: number; end: number } {
	if (counts.length === 0) return { start: 0, end: 0 };
	const at = Math.max(0, Math.min(selected, counts.length - 1));
	const own = counts[at] ?? 0;
	const before = Math.floor(Math.max(0, budget - Math.min(own, budget)) / 2);
	let start = at;
	let rows = 0;
	while (start > 0 && rows + (counts[start - 1] ?? 0) <= before) rows += counts[--start] ?? 0;
	let used = rows + own;
	let end = at + 1;
	while (end < counts.length && used + (counts[end] ?? 0) <= budget) used += counts[end++] ?? 0;
	while (start > 0 && used + (counts[start - 1] ?? 0) <= budget) used += counts[--start] ?? 0;
	return { start, end };
}

function listRows(theme: Theme, term: HookLookTerm, width: number): { text: string; highlight: boolean }[] {
	const rows: { text: string; highlight: boolean }[] = [];
	const options = term.options;
	const count = (option: HookLookOption, selected: boolean, mode: number | "full"): number =>
		optionLines(theme, option, selected, mode, width).reduce(
			(sum, line) => sum + lineRows(line, width, term.outline).length,
			0,
		);
	const fullRows = options.reduce((sum, option) => sum + count(option, false, "full"), 0);
	// Compact (labels only, the cursor option's description in the rows left) once everything no longer fits.
	const compact = fullRows > term.maxVisible;
	const counts = options.map((option, i) => count(option, i === term.cursor, compact ? 0 : "full"));
	const { start, end } = menuWindow(counts, term.cursor, term.maxVisible);
	let descRows = 0;
	if (compact) {
		let labelRows = 0;
		for (let i = start; i < end; i++) labelRows += count(options[i]!, i === term.cursor, 0);
		descRows = Math.max(0, term.maxVisible - labelRows - 1);
	}
	for (let i = start; i < end; i++) {
		const option = options[i]!;
		const selected = i === term.cursor;
		const mode = compact ? (selected ? descRows : 0) : "full";
		for (const text of optionLines(theme, option, selected, mode, width))
			rows.push({ text, highlight: selected && !option.disabled });
	}
	if (options.length === 0) rows.push({ text: theme.style("dim", "  No matching options"), highlight: false });
	const searching = term.query.text.length > 0;
	if (start > 0 || end < options.length || compact || searching) {
		const shown = options.length === 0 ? 0 : term.cursor + 1;
		const total =
			term.query.text.trim() && options.length !== term.total
				? `${shown}/${options.length} of ${term.total}`
				: `${shown}/${options.length}`;
		rows.push({
			text: term.query.text.trim()
				? `${theme.style("dim", `  (${total})  Search: `)}${caretField(theme, "", term.query.text, term.query.cursor, visibleWidth(term.query.text) + 1)}`
				: theme.style("dim", `  (${total})  Type to search`),
			highlight: false,
		});
	}
	return rows;
}

/** The panel at `width`. */
export function paintHookPanel(theme: Theme, width: number, term: HookLookTerm): string[] {
	const inner = Math.max(1, width - 4);
	const body: string[] = [""];
	for (const line of term.details) body.push(...wrap(theme.style("accent", line), inner));
	body.push("");
	if (term.slider) body.push(...sliderRows(theme, term.slider, inner), "");
	const rows = listRows(theme, term, inner);
	const band = (text: string, highlight: boolean): string => (highlight ? theme.style("selectedBg", text) : text);
	if (term.outline) {
		const rule = theme.style("border", theme.symbols.box.horizontal.repeat(inner));
		const v = theme.style("border", theme.symbols.box.vertical);
		body.push(rule);
		for (const row of rows)
			for (const line of lineRows(row.text, inner, true))
				body.push(`${v}${band(padTo(line, inner - 2), row.highlight)}${v}`);
		body.push(rule);
	} else {
		for (const row of rows)
			for (const line of lineRows(row.text, inner, false)) {
				const padded = ` ${padTo(line, inner - 2)} `;
				body.push(row.highlight ? band(padded, true) : ` ${line}`);
			}
	}
	body.push("");
	const help =
		term.help ??
		`${selectNavGlyphs()} navigate  ${bindingGlyph("tui.select.confirm", "enter")} select  ${bindingGlyph("tui.select.cancel", "escape")} cancel`;
	body.push(...wrap(theme.style("dim", help), inner), "");
	return [boxTop(theme, width, term.title), ...body.map(row => boxRow(theme, width, row)), boxBottom(theme, width)];
}

function paintHook(node: UiNode, cx: PaintContext): Block {
	const term = (node.props() as { term?: HookLookTerm }).term;
	if (!term || cx.width < 4) return { rows: [] };
	return { rows: paintHookPanel(cx.theme, cx.width, term) };
}

definePickerLook("omp.hook", paintHook);
defineRolePainter("card", "omp.overlay.hook-select", paintHook);
