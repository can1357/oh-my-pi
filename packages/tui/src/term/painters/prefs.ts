/**
 * `prefs`: a fullscreen settings window.
 *
 * A rounded frame titled by the page set, the page strip (icons shrink as
 * room runs out), the page's rows under section headings (a section sidebar
 * beside them when the window is wide), the selected row's warning and hint,
 * previews placed by role, and a footer naming the keys. An open row editor
 * (choice menu, text field, multi-select) replaces the rows; editors the
 * page has no control for arrive as `omp.prefs.editor` children and are
 * drawn in their place. While the program searches (`query`), the strip
 * lists the pages with matches first and the rows are the results, under a
 * banner showing the `omp.prefs.search` child's text and caret.
 *
 * Screens that need a different window give the node a `role` and register
 * a role painter; such nodes are theirs to draw and drive (the widget leaves
 * them alone).
 */
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { TspPrefsControl, TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import type { Theme } from "../../theme/contract";
import { sliceCells, spaces, truncate, visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, type Hit, type PaintContext } from "../paint";
import { type WidgetAction, widgetKeys } from "../keymap";
import "../widgets/prefs";
import { nodeState } from "./state";
import {
	isSearching,
	menuOptions,
	PREFS_HOVER,
	PREFS_OPTION_HOVER,
	PREFS_TAB_HOVER,
	type PrefsItem,
	prefsItems,
	prefsProps,
	type PrefsRun,
	prefsRuns,
	type PrefsTerm,
	pageIcon,
	rowValue,
	runAt,
	selectedRow,
} from "./prefs-model";
import { styledText } from "./layout";
import { keyCaps } from "./picker";
import { type TabStripItem, tabBar } from "./tabs";

/** Role of the child previewing the status line (drawn under the Appearance rows). */
export const PREFS_PREVIEW_ROLE = "omp.prefs.preview.status";
/** Role of a child editor drawn in place of the rows (editors without a page control). */
export const PREFS_EDITOR_ROLE = "omp.prefs.editor";
/** A child drawn under an open choice menu (a preview of the highlighted option). */
export const PREFS_MENU_FOOTER_ROLE = "omp.prefs.menu.footer";
/**
 * The search field: an `input` child holding the query as typed and its caret. Tern draws it in
 * the nav's search pill and edits it natively; the terminal draws its caret in the search banner.
 */
export const PREFS_SEARCH_ROLE = "omp.prefs.search";

/** Fallback window height when the parent does not fix one. */
const DEFAULT_HEIGHT = 40;
/** Rows a choice menu lists before it scrolls. */
const MENU_ROWS = 10;
/** Rows a multi-select lists before it scrolls. */
const MULTI_ROWS = 12;
/** Width of a menu's label column. */
const MENU_LABEL_COLUMN = 32;

// ─── Frame ──────────────────────────────────────────────────────────────────

function frameTop(theme: Theme, width: number, title: string): string {
	const box = theme.symbols.box;
	const inner = Math.max(0, width - 2);
	if (!title) return theme.fg("border", box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncate(` ${title} `, Math.max(0, inner - 2));
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		theme.fg("border", box.topLeft + box.horizontal) +
		theme.style("strong", theme.fg("accent", shown)) +
		theme.fg("border", box.horizontal.repeat(fill) + box.topRight)
	);
}

function frameRule(theme: Theme, width: number, left: string, right: string): string {
	return theme.fg("border", left + theme.symbols.box.horizontal.repeat(Math.max(0, width - 2)) + right);
}

/** A content row inside the frame: one column of inset each side. */
function frameRow(theme: Theme, content: string, width: number): string {
	const bar = theme.fg("border", theme.symbols.box.vertical);
	return `${bar} ${width > 4 ? fitTo(content, width - 4) : ""} ${bar}`;
}

/** `text` padded, or cut with an ellipsis, to exactly `width` cells. */
function fitTo(text: string, width: number): string {
	const cells = visibleWidth(text);
	if (cells === width) return text;
	const fitted = cells < width ? text + spaces(width - cells) : truncate(text, width);
	const drift = width - visibleWidth(fitted);
	return drift > 0 ? fitted + spaces(drift) : fitted;
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** `height` rows followed by a scrollbar column when `total` rows overflow them. */
export function scrolled(
	theme: Theme,
	rows: readonly string[],
	total: number,
	offset: number,
	width: number,
	height: number,
	track = "dim",
): string[] {
	const bar = total > height;
	const content = Math.max(0, width - (bar ? 1 : 0));
	let thumbStart = 0;
	let thumbEnd = height;
	if (bar) {
		const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
		const maxOffset = Math.max(0, total - height);
		const at = Math.max(0, Math.min(offset, maxOffset));
		thumbStart = maxOffset === 0 ? 0 : Math.round((at / maxOffset) * (height - size));
		thumbEnd = thumbStart + size;
	}
	const out: string[] = [];
	for (let row = 0; row < height; row++) {
		const cut = truncate(rows[row] ?? "", content);
		if (!bar) {
			out.push(cut);
			continue;
		}
		const glyph = row >= thumbStart && row < thumbEnd ? theme.fg("accent", "█") : theme.fg(track, "│");
		out.push(`${cut}${spaces(content - visibleWidth(cut))}${glyph}`);
	}
	return out;
}

/** First item of a window of `budget` single-row items centered on `selected`. */
export function windowStart(count: number, selected: number, budget: number): number {
	const before = Math.floor(Math.max(0, budget - 1) / 2);
	let start = Math.max(0, selected - before);
	const end = Math.min(count, start + budget);
	start = Math.max(0, Math.min(start, end - budget));
	return start;
}

function singleLine(text: string): string {
	return text
		.replaceAll("\t", "   ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Options as a select list: cursor, label column, muted detail; scrolls past `max` rows. */
export function selectList(
	theme: Theme,
	options: readonly { label: string; detail?: string }[],
	selected: number,
	width: number,
	max: number,
	hover?: number,
	column?: { readonly min: number; readonly max: number },
): { rows: string[]; first: number } {
	if (options.length === 0) return { rows: [theme.fg("muted", "  No items")], first: 0 };
	const budget = Math.max(1, Math.min(options.length, max));
	const cursor = theme.symbols.symbol("nav.cursor") || ">";
	const overflow = options.length > budget;
	const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
	const first = windowStart(options.length, selected, budget);
	let labelColumn = MENU_LABEL_COLUMN;
	if (column) {
		let widest = 0;
		for (const option of options) widest = Math.max(widest, visibleWidth(singleLine(option.label)) + 2);
		labelColumn = Math.max(column.min, Math.min(column.max, widest));
	}
	const rows: string[] = [];
	for (let i = first; i < first + budget && i < options.length; i++) {
		const option = options[i]!;
		const isSelected = i === selected;
		const prefix = isSelected ? `${cursor} ` : spaces(visibleWidth(cursor) + 1);
		const prefixWidth = visibleWidth(prefix);
		const label = singleLine(option.label);
		const detail = option.detail ? singleLine(option.detail) : "";
		let row: string | undefined;
		if (detail && rowWidth > 40) {
			const columnWidth = Math.max(1, Math.min(labelColumn, rowWidth - prefixWidth - 4));
			const shown = truncate(label, Math.max(1, columnWidth - 2), "");
			const gap = spaces(Math.max(1, columnWidth - visibleWidth(shown)));
			const room = rowWidth - (prefixWidth + visibleWidth(shown) + gap.length) - 2;
			if (room > 10) {
				const cut = truncate(detail, room, "");
				row = isSelected
					? theme.fg("accent", `${prefix}${shown}${gap}${cut}`)
					: prefix + shown + theme.fg("muted", gap + cut);
			}
		}
		if (row === undefined) {
			const shown = truncate(label, rowWidth - prefixWidth - 2, "");
			row = isSelected ? theme.fg("accent", `${prefix}${shown}`) : prefix + shown;
		}
		if (hover === i && !isSelected) row = theme.bg("selectedBg", row);
		rows.push(row);
	}
	const out = scrolled(theme, rows, options.length, first, width, rows.length, "muted");
	if (overflow) out.push(theme.fg("muted", truncate("  Type to search", Math.max(1, width - 2), "")));
	return { rows: out, first };
}

/** A form field: label, description, preview, the control, error, hint — blank rows between. */
function formField(
	theme: Theme,
	width: number,
	parts: {
		label: string;
		description?: string;
		preview?: readonly string[];
		control: readonly string[];
		error?: string;
		hint: string;
	},
): { rows: string[]; controlAt: number } {
	const rows: string[] = [];
	rows.push(...wrap(theme.style("strong", theme.fg("accent", parts.label)), width));
	if (parts.description) {
		rows.push("");
		rows.push(...wrap(theme.fg("muted", parts.description), width));
	}
	if (parts.preview) {
		rows.push("");
		rows.push(...wrap(theme.fg("muted", "Preview:"), width));
		rows.push(...parts.preview);
	}
	rows.push("");
	const controlAt = rows.length;
	rows.push(...parts.control);
	rows.push("");
	if (parts.error) rows.push(...wrap(theme.fg("error", truncate(singleLine(parts.error), 100)), width));
	rows.push(...wrap(theme.fg("dim", parts.hint), width));
	return { rows, controlAt };
}

/** A single-line text field: prompt, the text around an inverted caret cell, scrolled to keep the caret shown. */
export function inputLine(text: string, cursor: number, width: number, prompt = "> "): string {
	const room = width - visibleWidth(prompt);
	if (room <= 0) return sliceCells(prompt, 0, width).text;
	const at = Math.max(0, Math.min(cursor, text.length));
	const atEnd = at >= text.length;
	const shown = atEnd ? `${text} ` : text;
	// Keep the caret inside the window: drop leading cells until it fits.
	const graphemes = [...segmentGraphemes(shown)];
	let caret = graphemes.findIndex(g => g.index >= at);
	if (caret < 0) caret = graphemes.length - 1;
	let start = 0;
	const widthOf = (from: number, to: number): number => {
		let cells = 0;
		for (let i = from; i < to; i++) cells += visibleWidth(graphemes[i]!.segment);
		return cells;
	};
	while (start < caret && widthOf(start, caret + 1) > room) start++;
	const before = graphemes
		.slice(start, caret)
		.map(g => g.segment)
		.join("");
	const under = graphemes[caret]?.segment ?? " ";
	const after = graphemes
		.slice(caret + 1)
		.map(g => g.segment)
		.join("");
	const beforeWidth = visibleWidth(before);
	const underWidth = visibleWidth(under);
	const tail = sliceCells(after, 0, Math.max(0, room - beforeWidth - underWidth), true).text;
	const line = `${before}\x1b[7m${under}\x1b[27m${tail}`;
	return prompt + line + spaces(Math.max(0, room - (beforeWidth + underWidth + visibleWidth(tail))));
}

// ─── The settings list ──────────────────────────────────────────────────────

interface ListGeometry {
	rows: string[];
	/** Item id per row (rows of the list area). */
	hit: (string | undefined)[];
	/** Sidebar row → the first row of its section; the sidebar spans columns [0, sidebar). */
	sidebarHit: (string | undefined)[];
	sidebar: number;
}

/** One row of a settings list: what it draws and how. */
export interface SettingRowLook {
	readonly label: string;
	readonly value: string;
	readonly heading?: boolean;
	readonly warning?: boolean;
	readonly changed?: boolean;
	readonly selected: boolean;
	/** Width of the label column (labels padded to it). */
	readonly labelWidth: number;
	readonly width: number;
	/** Outside the active section of a split list: one dim wash. */
	readonly dimmed: boolean;
	/** A heading carrying the section-focus cursor. */
	readonly headingCursor?: boolean;
	readonly hovered: boolean;
}

/** A settings list row: cursor, label (and warning mark) padded to the label column, the value. */
export function settingRow(theme: Theme, row: SettingRowLook): string {
	const cursor = theme.fg("accent", `${theme.symbols.symbol("nav.cursor") || ">"} `);
	if (row.heading) {
		const prefix = row.headingCursor ? cursor : "  ";
		const label = row.dimmed
			? theme.fg("dim", theme.style("underline", row.label))
			: theme.fg("muted", theme.style("strong", theme.style("underline", row.label)));
		return truncate(`${prefix}${label}`, Math.max(0, row.width));
	}
	const prefix = row.selected ? cursor : "  ";
	const warn = theme.symbols.symbol("status.warning");
	const mark = row.warning && warn ? ` ${warn}` : "";
	const plainLabel = row.label + mark;
	const pad = spaces(Math.max(0, row.labelWidth - visibleWidth(plainLabel)));
	const valueRoom = row.width - visibleWidth(prefix) - row.labelWidth - 2 - 2;
	const value = truncate(row.value, valueRoom, "");
	const hovered = row.hovered && !row.selected;
	if (row.dimmed && !row.selected) {
		const text = theme.fg("dim", truncate(`  ${plainLabel}${pad}  ${value}`, Math.max(0, row.width)));
		return hovered ? theme.bg("selectedBg", text) : text;
	}
	const label = row.changed
		? theme.fg("statusLineGitDirty", row.label)
		: row.selected
			? theme.fg("accent", row.label)
			: row.label;
	const valueText = row.changed
		? theme.fg("statusLineGitDirty", value)
		: row.selected
			? theme.fg("accent", value)
			: theme.fg("muted", value);
	const text = truncate(
		`${prefix}${label}${mark ? theme.fg("warning", mark) : ""}${pad}  ${valueText}`,
		Math.max(0, row.width),
	);
	return hovered ? theme.bg("selectedBg", text) : text;
}

function itemRow(
	theme: Theme,
	item: PrefsItem,
	term: PrefsTerm | undefined,
	opts: {
		selected: boolean;
		labelWidth: number;
		width: number;
		dimmed: boolean;
		headingCursor: boolean;
		hovered: boolean;
	},
): string {
	return settingRow(theme, {
		...opts,
		label: item.heading ? item.label : item.row!.label,
		value: item.heading ? "" : rowValue(item.row!, term),
		heading: item.heading,
		warning: !item.heading && item.row!.warning !== undefined && item.row!.warning !== "",
		changed: item.row?.changed === true,
	});
}

function labelColumn(items: readonly PrefsItem[], theme: Theme): number {
	const warn = theme.symbols.symbol("status.warning");
	let widest = 0;
	for (const item of items) {
		if (item.heading) continue;
		const mark = item.row!.warning && warn ? ` ${warn}` : "";
		widest = Math.max(widest, visibleWidth(item.label + mark));
	}
	return Math.min(30, widest);
}

function settingsList(
	theme: Theme,
	props: TspPrefsProps,
	term: PrefsTerm | undefined,
	items: readonly PrefsItem[],
	selectedId: string | undefined,
	width: number,
	maxVisible: number,
	hover: string | undefined,
): ListGeometry {
	const geometry: ListGeometry = { rows: [], hit: [], sidebarHit: [], sidebar: 0 };
	const rows = geometry.rows;
	const searching = isSearching(props);
	if (items.length === 0) {
		rows.push(theme.fg("dim", searching ? "  No matching settings" : "  No settings available"));
		return geometry;
	}
	const runs = prefsRuns(items, props);
	const selected = Math.max(
		0,
		items.findIndex(item => !item.heading && item.id === selectedId),
	);
	const sectionFocus = term?.sectionFocus === true;
	const split =
		!searching && runs.length >= 2
			? splitList(theme, props, term, items, runs, selected, width, maxVisible, hover)
			: null;
	if (split) return split;

	const height = Math.min(maxVisible, items.length);
	const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
	const labelWidth = labelColumn(items, theme);
	const rowWidth = Math.max(0, width - (items.length > height ? 1 : 0));
	const active = runs[runAt(runs, selected)];
	const headingIndex = sectionFocus && active?.name ? active.first - 1 : -1;
	const itemRows: string[] = [];
	for (let i = start; i < start + height; i++) {
		const item = items[i]!;
		itemRows.push(
			itemRow(theme, item, term, {
				selected: i === selected && !sectionFocus,
				labelWidth,
				width: rowWidth,
				dimmed: false,
				headingCursor: i === headingIndex,
				hovered: item.id === hover,
			}),
		);
		geometry.hit.push(item.heading ? undefined : item.id);
	}
	rows.push(...scrolled(theme, itemRows, items.length, start, width, height));
	while (rows.length < maxVisible) rows.push("");
	return geometry;
}

function splitList(
	theme: Theme,
	props: TspPrefsProps,
	term: PrefsTerm | undefined,
	items: readonly PrefsItem[],
	runs: readonly PrefsRun[],
	selected: number,
	width: number,
	maxVisible: number,
	hover: string | undefined,
): ListGeometry | null {
	const names = runs.map(run => run.name || "Other");
	let nameWidth = 0;
	for (const name of names) nameWidth = Math.max(nameWidth, visibleWidth(name));
	const sidebar = term?.sidebar ?? Math.min(22, nameWidth) + 4;
	const paneWidth = width - sidebar - 2;
	if (paneWidth < 60) return null;
	void props;
	const sectionFocus = term?.sectionFocus === true;
	const activeIndex = runAt(runs, selected);
	const active = runs[activeIndex]!;
	const cursor = theme.fg("accent", `${theme.symbols.symbol("nav.cursor") || ">"} `);
	const sideRows = names.map((name, i) => {
		const label = truncate(name, sidebar - 4, "");
		const prefix = sectionFocus && i === activeIndex ? cursor : "  ";
		const styled = i === activeIndex ? theme.fg("accent", theme.style("strong", label)) : theme.fg("muted", label);
		return `${prefix}${styled}${spaces(sidebar - visibleWidth(prefix) - visibleWidth(label))}`;
	});
	const activeStart = active.name ? active.first - 1 : active.first;
	const height = Math.min(maxVisible, items.length);
	const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
	const labelWidth = labelColumn(items, theme);
	const rowWidth = Math.max(0, paneWidth - (items.length > height ? 1 : 0));
	const itemRows: string[] = [];
	const geometry: ListGeometry = { rows: [], hit: [], sidebarHit: [], sidebar };
	for (let r = 0; r < height; r++) {
		const index = start + r;
		const item = items[index];
		if (!item) break;
		itemRows.push(
			itemRow(theme, item, term, {
				selected: index === selected && !sectionFocus,
				labelWidth,
				width: rowWidth,
				dimmed: index < activeStart || index > active.last,
				headingCursor: false,
				hovered: item.id === hover,
			}),
		);
		geometry.hit[r] = item.heading ? undefined : item.id;
	}
	const pane = scrolled(theme, itemRows, items.length, start, paneWidth, height);
	for (let i = 0; i < runs.length; i++) geometry.sidebarHit[i] = items[runs[i]!.first]?.id;
	const separator = theme.fg("dim", "│ ");
	const total = Math.max(maxVisible, sideRows.length);
	for (let i = 0; i < total; i++) {
		geometry.rows.push(truncate((sideRows[i] ?? spaces(sidebar)) + separator + (pane[i] ?? ""), width));
	}
	return geometry;
}

/** The selected row's warning and hint: one blank row, then exactly three. */
export function descriptionRows(
	theme: Theme,
	row: { warning?: string } | undefined,
	width: number,
	hint: string | undefined,
): string[] {
	const out: string[] = [];
	if (row) {
		if (row.warning) {
			const warn = theme.symbols.symbol("status.warning");
			for (const line of wrap(`${warn ? `${warn} ` : ""}${row.warning}`, width - 4))
				out.push(theme.fg("warning", `  ${line}`));
		}
		if (hint) for (const line of wrap(hint, width - 4)) out.push(theme.fg("dim", `  ${line}`));
		if (out.length > 3) {
			out.length = 3;
			out[2] = truncate(`${out[2]}…`, width);
		}
	}
	while (out.length < 3) out.push("");
	return ["", ...out];
}

// ─── Editors ────────────────────────────────────────────────────────────────

interface EditorRows {
	rows: string[];
	/** First row of the option list and the option index it starts at. */
	optionsAt?: number;
	firstOption?: number;
	optionCount?: number;
}

function choiceEditor(
	theme: Theme,
	row: TspPrefsRow,
	option: string | undefined,
	width: number,
	preview: readonly string[] | undefined,
	hover: number | undefined,
): EditorRows {
	const options = menuOptions(row.control);
	const selected = Math.max(
		0,
		options.findIndex(candidate => candidate.value === option),
	);
	const list = selectList(theme, options, selected, width, MENU_ROWS, hover);
	const field = formField(theme, width, {
		label: row.label,
		description: row.hint,
		preview,
		control: list.rows,
		hint: `  ${caps(theme, "select.confirm")} to select · ${caps(theme, "select.cancel")} to go back`,
	});
	return {
		rows: field.rows,
		optionsAt: field.controlAt,
		firstOption: list.first,
		optionCount: Math.min(options.length, MENU_ROWS),
	};
}

function multiEditor(
	theme: Theme,
	row: TspPrefsRow,
	control: Extract<TspPrefsControl, { k: "multi" }>,
	option: string | undefined,
	width: number,
	hover: number | undefined,
): EditorRows {
	const ordered = control.ordered === true;
	const options = control.options.map(candidate => {
		const position = control.values.indexOf(candidate.value);
		const mark =
			position === -1
				? theme.fg("dim", ordered ? " · " : " ○ ")
				: ordered
					? theme.fg("accent", `${String(position + 1).padStart(2)}.`)
					: theme.fg("accent", " ● ");
		return { label: `${mark} ${candidate.label}`, detail: candidate.detail };
	});
	const selected = Math.max(
		0,
		control.options.findIndex(candidate => candidate.value === option),
	);
	const list = selectList(theme, options, selected, width, MULTI_ROWS, hover);
	const back = `${caps(theme, "select.cancel")} to go back`;
	const hint = ordered
		? `  Click to toggle · drag selected items to reorder · ${keyCaps(["left", "right"], theme)} move · 1-9 place · ${back}`
		: `  Click/${caps(theme, "select.confirm")}/${keyCaps(["space"], theme)} to toggle · ${back}`;
	const field = formField(theme, width, { label: row.label, description: row.hint, control: list.rows, hint });
	return {
		rows: field.rows,
		optionsAt: field.controlAt,
		firstOption: list.first,
		optionCount: Math.min(options.length, MULTI_ROWS),
	};
}

function textEditor(
	theme: Theme,
	row: TspPrefsRow,
	draft: string,
	cursor: number | undefined,
	width: number,
	error: string | undefined,
): EditorRows {
	const field = formField(theme, width, {
		label: row.label,
		description: row.hint,
		control: [inputLine(draft, cursor ?? draft.length, width)],
		error,
		hint: `  ${caps(theme, "select.confirm")} to save · ${caps(theme, "select.cancel")} to cancel · Clear field to unset`,
	});
	return { rows: field.rows };
}

// ─── Footer ─────────────────────────────────────────────────────────────────

/** The primary key of a widget action as `theme`'s keycaps (`⎋`, `Esc` in ascii), as the keymap binds it. */
function caps(theme: Theme, action: WidgetAction): string {
	const [key] = widgetKeys(action);
	return key === undefined ? "" : keyCaps([key], theme);
}

function footerHint(
	theme: Theme,
	props: TspPrefsProps,
	term: PrefsTerm | undefined,
	runs: readonly PrefsRun[],
): string {
	if (term?.hint !== undefined) return term.hint;
	const confirm = caps(theme, "select.confirm");
	const cancel = caps(theme, "select.cancel");
	const tab = keyCaps(["tab"], theme);
	const switchTabs = `${keyCaps(["left", "right"], theme)} to switch tabs`;
	const close = `${cancel} to close`;
	if (isSearching(props)) return `${confirm} to change · ${tab} to jump tabs · ${cancel} to exit search`;
	if (term?.body) return `${tab} to switch tabs · ${close}`;
	if (term?.sectionFocus)
		return `${caps(theme, "select.up")}/${caps(theme, "select.down")} to jump sections · ${tab}/${confirm} to settings · ${switchTabs} · ${close}`;
	const nav = runs.length >= 2 ? `${tab} to jump sections · ${switchTabs}` : `${tab} to switch tabs`;
	return `${confirm}/${keyCaps(["space"], theme)} to change · ${nav} · Type to search · ${close}`;
}

// ─── Page strip ─────────────────────────────────────────────────────────────

/** The strip's tabs: every page, or while searching the pages with results first (with counts). */
function stripTabs(props: TspPrefsProps, theme: Theme): TabStripItem[] {
	const tab = (page: TspPrefsProps["pages"][number], suffix = "", short?: string): TabStripItem => {
		const icon = pageIcon(theme, page.icon);
		const label = page.group ?? page.label;
		return { id: page.id, label: `${icon} ${label}${suffix}`, short: short ?? icon };
	};
	if (!isSearching(props)) return props.pages.map(page => tab(page));
	const counts = new Map<string, number>();
	for (const section of props.sections) {
		if (!section.page) continue;
		counts.set(section.page, (counts.get(section.page) ?? 0) + section.rows.length);
	}
	const matched: TabStripItem[] = [];
	for (const [id, count] of counts) {
		const page = props.pages.find(candidate => candidate.id === id);
		if (!page) continue;
		const icon = pageIcon(theme, page.icon);
		matched.push(tab(page, ` (${count})`, `${icon} ${count}`));
	}
	const rest = props.pages.filter(page => !counts.has(page.id)).map(page => ({ ...tab(page), muted: true }));
	return [...matched, ...rest];
}

// ─── The window ─────────────────────────────────────────────────────────────

function searchBanner(theme: Theme, props: TspPrefsProps, cursor: number | undefined, width: number): string {
	let count = 0;
	for (const section of props.sections) count += section.rows.length;
	const icon = theme.symbols.icon("search");
	const countText = count === 1 ? "1 match" : `${count} matches`;
	const prefix = ` ${theme.fg("accent", icon)} `;
	const inputWidth = Math.max(4, width - visibleWidth(prefix) - (visibleWidth(countText) + 1) - 1);
	const query = props.query ?? "";
	const field = inputLine(query, cursor ?? query.length, inputWidth, "");
	return truncate(
		`${prefix}${theme.style("strong", field)} ${theme.fg(count > 0 ? "dim" : "warning", countText)} `,
		width,
	);
}

function paintWindow(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const props = prefsProps(node);
	const term = props.term;
	const width = cx.width;
	const height = Math.max(14, cx.height ?? DEFAULT_HEIGHT);
	const inner = Math.max(1, width - 4);
	const searching = isSearching(props);
	const children = node.children();
	const previewNode = children.find(child => (child.props() as { role?: string }).role === PREFS_PREVIEW_ROLE);
	const editorNode = children.find(child => (child.props() as { role?: string }).role === PREFS_EDITOR_ROLE);
	const searchNode = children.find(child => (child.props() as { role?: string }).role === PREFS_SEARCH_ROLE);

	const strip = tabBar(
		theme,
		stripTabs(props, theme),
		searching ? (term?.page ?? activeSearchPage(props, term, theme)) : props.page,
		inner,
		nodeState(node, PREFS_TAB_HOVER, () => undefined as string | undefined)(),
	);
	const preview = previewNode && !searching ? cx.paint(previewNode, inner).rows : undefined;
	const previewRows = preview ? ["", theme.fg("muted", "Preview:"), ...preview] : [];
	const fixed = 1 + strip.rows.length + 1 + (searching ? 1 : 0) + 3;
	const contentRows = Math.max(7, height - fixed - previewRows.length);
	const maxVisible = Math.max(3, contentRows - 4);

	const items = prefsItems(props, term, theme);
	const runs = searching ? [] : prefsRuns(items, props);
	const selectedId = selectedRow(props, term, items);
	const editing = props.editing ?? null;
	// The whole window first: pointer motion anywhere clears the hover highlights.
	const hits: Hit[] = [{ row: 0, col: 0, width, height, node, item: "window" }];
	const contentTop = 1 + strip.rows.length + 1 + (searching ? 1 : 0);
	let content: string[];
	const optionHover = nodeState(node, PREFS_OPTION_HOVER, () => undefined as number | undefined)();
	const editingRow = editing ? findRow(props, editing.row) : undefined;
	if (editorNode) {
		content = [...cx.paint(editorNode, inner).rows];
		hits.push({ row: contentTop, col: 2, width: inner, height: contentRows, node, item: "editor" });
	} else if (editing && editingRow) {
		const control = editingRow.control;
		let editor: EditorRows;
		if (control.k === "text") {
			editor = textEditor(theme, editingRow, editing.draft ?? "", editing.cursor, inner, term?.error);
		} else if (control.k === "multi") {
			editor = multiEditor(theme, editingRow, control, editing.option, inner, optionHover);
		} else {
			const menuPreview = term?.menuPreview?.rows.includes(editingRow.id)
				? wrap(styledText(theme, term.menuPreview.line), inner)
				: undefined;
			editor = choiceEditor(theme, editingRow, editing.option, inner, menuPreview, optionHover);
		}
		const footerNode =
			control.k === "text" || control.k === "multi"
				? undefined
				: children.find(child => (child.props() as { role?: string }).role === PREFS_MENU_FOOTER_ROLE);
		content = footerNode ? [...editor.rows, "", ...cx.paint(footerNode, inner).rows] : editor.rows;
		hits.push({ row: contentTop, col: 2, width: inner, height: contentRows, node, item: "editor" });
		if (editor.optionsAt !== undefined) {
			const options =
				control.k === "multi"
					? control.options.map(option => option.value)
					: menuOptions(control).map(o => o.value);
			for (let i = 0; i < (editor.optionCount ?? 0); i++) {
				const value = options[(editor.firstOption ?? 0) + i];
				if (value === undefined) continue;
				hits.push({
					row: contentTop + editor.optionsAt + i,
					col: 2,
					width: inner,
					height: 1,
					node,
					item: `opt:${value}`,
				});
			}
		}
	} else if (term?.body && !searching) {
		const body = cx.paint(term.body, inner);
		content = [...body.rows];
		for (const hit of body.hits ?? []) hits.push({ ...hit, row: hit.row + contentTop, col: hit.col + 2 });
	} else {
		const hover = nodeState(node, PREFS_HOVER, () => undefined as string | undefined)();
		const list = settingsList(theme, props, term, items, selectedId, inner, maxVisible, hover);
		content = list.rows;
		hits.push({ row: contentTop, col: 2, width: inner, height: contentRows, node, item: "content" });
		if (list.sidebar > 0) {
			for (let i = 0; i < list.sidebarHit.length; i++) {
				const id = list.sidebarHit[i];
				if (id !== undefined)
					hits.push({ row: contentTop + i, col: 2, width: list.sidebar, height: 1, node, item: `jump:${id}` });
			}
		}
		for (let i = 0; i < list.hit.length; i++) {
			const id = list.hit[i];
			if (id === undefined) continue;
			const left = list.sidebar > 0 ? list.sidebar : 0;
			hits.push({ row: contentTop + i, col: 2 + left, width: inner - left, height: 1, node, item: `row:${id}` });
		}
		if (items.length > 0) {
			const selectedItem = items.find(item => !item.heading && item.id === selectedId);
			const row = selectedItem?.row;
			content.push(...descriptionRows(theme, row, inner, row && (term?.hints?.[row.id] ?? row.hint)));
		}
	}

	const rows: string[] = [frameTop(theme, width, term?.title ?? props.title)];
	for (const line of strip.rows) rows.push(frameRow(theme, line, width));
	for (const zone of strip.zones)
		hits.push({
			row: 1 + zone.row,
			col: 2 + zone.start,
			width: zone.end - zone.start,
			height: 1,
			node,
			item: `tab:${zone.id}`,
		});
	rows.push(frameRule(theme, width, theme.symbols.box.teeRight, theme.symbols.box.teeLeft));
	if (searching) {
		const field = searchNode?.props();
		const cursor = field && "cursor" in field && typeof field.cursor === "number" ? field.cursor : undefined;
		rows.push(frameRow(theme, searchBanner(theme, props, cursor, inner), width));
	}
	for (let i = 0; i < contentRows; i++) rows.push(frameRow(theme, content[i] ?? "", width));
	for (const line of previewRows) rows.push(frameRow(theme, line, width));
	rows.push(frameRule(theme, width, theme.symbols.box.teeRight, theme.symbols.box.teeLeft));
	rows.push(frameRow(theme, theme.fg("dim", footerHint(theme, props, term, runs)), width));
	rows.push(frameRule(theme, width, theme.symbols.box.bottomLeft, theme.symbols.box.bottomRight));
	return { rows, hits };
}

function findRow(props: TspPrefsProps, id: string): TspPrefsRow | undefined {
	for (const section of props.sections) for (const row of section.rows) if (row.id === id) return row;
	return undefined;
}

/** While searching, the strip highlights the page of the selected result. */
function activeSearchPage(props: TspPrefsProps, term: PrefsTerm | undefined, theme: Theme): string | undefined {
	const items = prefsItems(props, term, theme);
	const id = selectedRow(props, term, items);
	return items.find(item => !item.heading && item.id === id)?.page ?? props.page;
}

definePainter("prefs", paintWindow);
