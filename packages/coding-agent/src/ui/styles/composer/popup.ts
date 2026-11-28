/**
 * The composer's completion popup in the terminal (`overlay` with role
 * `omp.autocomplete` → `col omp.select` → `list` of `item`s), drawn under
 * the field as a select list:
 *
 * - the selected row in the accent, the others indented; when any item has a
 *   type glyph, every label starts after the widest glyph and a space;
 * - wider than 40 cells, a description column (muted) after a primary
 *   column sized to the widest label (`term.columns` bounds it), wrapped to
 *   `term.descriptionRows` rows when set, else cut to one;
 * - at most `max.lines` rows, a window over the items' rows centred on the
 *   selection (whole items from the top, the selected one always painted),
 *   with a scrollbar in the last column while rows are hidden (accent thumb,
 *   muted track).
 */
import type {
	TspPickerGroup,
	TspPickerItem,
	TspPickerLevel,
	TspPickerProps,
	TspSpan,
	TspText,
} from "@oh-my-pi/pi-wire";
import { mentionStyle } from "../../../autocomplete/mentions/style";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";

/** Terminal-only layout facts of the popup (its `term` prop). */
export type PopupTerm = {
	/** Bounds of the primary column's width. */
	readonly columns?: readonly [min: number, max: number];
	/** Wrap descriptions to this many rows (one cut row otherwise). */
	readonly descriptionRows?: number;
};

/** Kept apart from the native label, which may already include the fallback glyph. */
export type PopupItemTerm = { readonly glyph?: string; readonly label: string; readonly detail: string };

const PRIMARY_GAP = 2;
const MIN_DESCRIPTION = 10;
const DEFAULT_COLUMN = 32;

function plain(text: TspText | undefined): string {
	if (text === undefined) return "";
	return typeof text === "string" ? text : text.map(span => span.t).join("");
}

interface Entry {
	readonly key: string;
	readonly glyph: string;
	readonly glyphWidth: number;
	readonly label: string;
	readonly detail: string;
}

interface CursorColumn {
	readonly marker: string;
	readonly blank: string;
	readonly width: number;
}

/** The rows of one item at `width`. */
function itemRows(
	cx: PaintContext,
	entry: Entry,
	selected: boolean,
	width: number,
	column: number,
	iconColumn: number,
	cursor: CursorColumn,
	term: PopupTerm,
): string[] {
	const theme = cx.theme;
	let prefix = selected ? cursor.marker : cursor.blank;
	let prefixWidth = cursor.width;
	if (iconColumn > 0) {
		const cell =
			entry.glyphWidth <= iconColumn
				? entry.glyph + " ".repeat(iconColumn - entry.glyphWidth + 1)
				: `${truncate(entry.glyph, iconColumn, "", true)} `;
		prefix += selected ? cell : theme.fg("muted", cell);
		prefixWidth += iconColumn + 1;
	}
	if (entry.detail && width > 40) {
		const effective = Math.max(1, Math.min(column, width - prefixWidth - 4));
		const label = truncate(entry.label, Math.max(1, effective - PRIMARY_GAP), "");
		const labelWidth = visibleWidth(label);
		const spacing = " ".repeat(Math.max(1, effective - labelWidth));
		const start = prefixWidth + labelWidth + spacing.length;
		const room = width - start - 2;
		if (room > MIN_DESCRIPTION) {
			let lines: string[];
			if (term.descriptionRows !== undefined) {
				lines = wrap(entry.detail, room);
				if (lines.length > term.descriptionRows) {
					lines = lines.slice(0, term.descriptionRows);
					const last = lines.length - 1;
					lines[last] = truncate(`${lines[last]} …`, room);
				}
			} else lines = [truncate(entry.detail, room, "")];
			const indent = " ".repeat(start);
			if (selected) {
				return [
					theme.fg("accent", `${prefix}${label}${spacing}${lines[0] ?? ""}`),
					...lines.slice(1).map(line => theme.fg("accent", `${indent}${line}`)),
				];
			}
			return [
				`${prefix}${label}${theme.fg("muted", `${spacing}${lines[0] ?? ""}`)}`,
				...lines.slice(1).map(line => theme.fg("muted", `${indent}${line}`)),
			];
		}
	}
	const label = truncate(entry.label, Math.max(0, width - prefixWidth - 2), "");
	return [selected ? theme.fg("accent", `${prefix}${label}`) : `${prefix}${label}`];
}

function paintPopup(node: UiNode, cx: PaintContext): Block {
	const term = ((node.props() as { term?: PopupTerm }).term ?? {}) as PopupTerm;
	const list = node
		.children()
		.flatMap(child => (child.kind === "list" ? [child] : child.children()))
		.find(child => child.kind === "list");
	if (!list) return EMPTY_BLOCK;
	const listProps = list.props() as { selected?: string; max?: { lines?: number } };
	const entries: Entry[] = list.children().map(item => {
		const p = item.props() as { label?: TspText; detail?: TspText; term?: PopupItemTerm };
		const glyph = p.term?.glyph ?? "";
		return {
			key: item.key() ?? "",
			label: p.term?.label ?? plain(p.label),
			detail: p.term?.detail ?? plain(p.detail),
			glyph,
			glyphWidth: glyph ? visibleWidth(glyph) : 0,
		};
	});
	if (entries.length === 0) return EMPTY_BLOCK;
	const selected = Math.max(
		0,
		entries.findIndex(entry => entry.key === listProps.selected),
	);
	const visible = Math.max(1, listProps.max?.lines ?? 10);
	const [min, max] = term.columns ?? [DEFAULT_COLUMN, DEFAULT_COLUMN];
	let widest = 0;
	let widestGlyph = 0;
	for (const entry of entries) {
		widest = Math.max(widest, visibleWidth(entry.label) + PRIMARY_GAP);
		widestGlyph = Math.max(widestGlyph, entry.glyphWidth);
	}
	const marker = `${cx.theme.symbols.symbol("nav.cursor")} `;
	const cursorWidth = visibleWidth(marker);
	const cursor: CursorColumn = { marker, blank: " ".repeat(cursorWidth), width: cursorWidth };
	const column = Math.max(min, Math.min(max, widest));
	const layout = (width: number): string[][] => {
		// Even on a narrow screen leave space for the cursor, gap, a label cell and the end margin.
		const iconColumn = Math.min(widestGlyph, Math.max(0, width - cursorWidth - 4));
		return entries.map((entry, i) => itemRows(cx, entry, i === selected, width, column, iconColumn, cursor, term));
	};

	// Extra items guarantee overflow. Otherwise try full width first: making room for
	// the scrollbar can change wrapping or hide descriptions, changing the row count.
	const itemsOverflow = entries.length > visible;
	let rowWidth = Math.max(0, cx.width - (itemsOverflow ? 1 : 0));
	let blocks = layout(rowWidth);
	let total = blocks.reduce((sum, block) => sum + block.length, 0);
	if (!itemsOverflow && total > visible) {
		rowWidth = Math.max(0, cx.width - 1);
		blocks = layout(rowWidth);
		total = blocks.reduce((sum, block) => sum + block.length, 0);
	}
	if (total <= visible) return { rows: blocks.flat() };

	// First row of each item, and the item the window opens at: the one holding the row that
	// centres the selection, moved down while the selected item would still be cut off.
	const offsets: number[] = [];
	for (let i = 0, row = 0; i < blocks.length; row += blocks[i]!.length, i++) offsets.push(row);
	const selectedEnd = offsets[selected]! + blocks[selected]!.length;
	const centre = Math.max(0, Math.min(offsets[selected]! - Math.floor(visible / 2), total - visible));
	let first = 0;
	while (first < selected && offsets[first + 1]! <= centre) first++;
	while (first < selected && selectedEnd - offsets[first]! > visible) first++;
	const rows: string[] = [];
	for (let i = first; i < blocks.length && rows.length < visible; i++) {
		for (const row of blocks[i]!) {
			if (rows.length >= visible) break;
			rows.push(row);
		}
	}

	const thumb = Math.max(1, Math.floor((visible * visible) / total));
	const at = Math.round(Math.min(1, offsets[first]! / (total - visible)) * (rows.length - thumb));
	return {
		rows: rows.map((row, i) => {
			const pad = " ".repeat(Math.max(0, rowWidth - visibleWidth(row)));
			const bar = i >= at && i < at + thumb ? cx.theme.fg("accent", "█") : cx.theme.fg("muted", "│");
			return `${row}${pad}${bar}`;
		}),
	};
}

defineRolePainter("overlay", "omp.autocomplete", paintPopup);

/** Terminal-only display data for the modeless unified mention picker (`omp.mention-picker`). */
export type MentionPopupTerm = {
	readonly maxLines: number;
	/** Leading glyph of each row by picker item id, styled in the row's color. */
	readonly glyphs?: Readonly<Record<string, TspSpan>>;
};

function isPickerGroup(entry: string | TspPickerGroup): entry is TspPickerGroup {
	return typeof entry !== "string";
}

/** Badges (in their tones) and chips after a row's label, minus badges its detail already says. */
function mentionTags(item: TspPickerItem, detail: string): TspSpan[] {
	const tags: TspSpan[] = [];
	const detailLower = detail.toLowerCase();
	for (const badge of item.badges ?? []) {
		if (!detailLower.includes(badge.text.toLowerCase())) tags.push({ t: badge.text, s: badge.tone ?? "muted" });
	}
	for (const chip of item.chips ?? []) tags.push({ t: chip.text, s: chip.on ? "accent" : "muted" });
	return tags;
}

/** The plain text of a row's tags, as {@link mentionTags} lays them out. */
function tagText(tags: readonly TspSpan[]): string {
	return tags.map(tag => tag.t).join(" ");
}

function factText(item: TspPickerItem, colId: string): string {
	const val = item.facts?.[colId];
	if (val === undefined) return "";
	return typeof val === "number" ? String(val) : plain(val);
}

/**
 * `layout="tiles"` (the bare `@` categories): one strip of `<glyph> Label (count)` tiles with the lit
 * one on the selection background, and under it the lit tile's short name and description. When the
 * strip overflows, tiles fall back to their short name (the first column's fact), then to the glyph.
 */
function paintMentionTiles(
	props: TspPickerProps & { term?: MentionPopupTerm },
	items: readonly TspPickerItem[],
	cx: PaintContext,
	indent: string,
): Block {
	const lit = items.find(item => item.id === props.selected) ?? items[0];
	if (!lit) return EMPTY_BLOCK;
	const [shortCol, countCol] = (props.columns ?? []).map(col => col.id);
	const shortOf = (item: TspPickerItem) => (shortCol ? factText(item, shortCol) : "");
	const tile = (item: TspPickerItem, caption: string, count: string): string => {
		const glyph = props.term?.glyphs?.[item.id] ?? { t: "·" };
		const isLit = item === lit;
		let body = ` ${cx.theme.style(glyph.s ?? "muted", glyph.t)}`;
		if (caption) body += ` ${cx.theme.style(isLit ? "accent strong" : "dim", caption)}`;
		if (count) body += ` ${cx.theme.fg("dim", `(${count})`)}`;
		body += " ";
		return isLit ? cx.theme.bg("selectedBg", body) : body;
	};
	const room = cx.width - visibleWidth(indent);
	const forms: readonly ((item: TspPickerItem) => string)[] = [
		item => tile(item, plain(item.label), countCol ? factText(item, countCol) : ""),
		item => tile(item, shortOf(item), ""),
		item => tile(item, "", ""),
	];
	let strip = "";
	for (const form of forms) {
		strip = items.map(form).join("");
		if (visibleWidth(strip) <= room) break;
	}
	const short = shortOf(lit);
	const about = `${short ? `${cx.theme.style("accent strong", short)}  ` : ""}${cx.theme.fg("muted", plain(lit.detail))}`;
	return {
		rows: [truncate(`${indent}${strip}`, cx.width, ""), truncate(`${indent}${about}`, cx.width, "…")],
	};
}

function renderLevelFooter(cx: PaintContext, level: TspPickerLevel, width: number): string {
	const steps = level.steps
		.map(step =>
			step.id === level.value ? cx.theme.fg("accent", `[${step.label}]`) : cx.theme.fg("muted", step.label),
		)
		.join(" ");
	const line = `  ${cx.theme.fg("muted", `${level.label}:`)} ${steps}  ${cx.theme.fg("dim", "⇧←/→")}`;
	return truncate(line, width, "");
}

function paintMentionPopup(node: UiNode, cx: PaintContext): Block {
	// Role painter is registered solely on `picker` nodes.
	const props = node.props() as TspPickerProps & { term?: MentionPopupTerm };
	const items = props.items ?? [];
	if (items.length === 0) return EMPTY_BLOCK;
	const marker = `${cx.theme.symbols.symbol("nav.cursor")} `;
	const blank = " ".repeat(visibleWidth(marker));
	if (props.layout === "tiles") return paintMentionTiles(props, items, cx, blank);
	const order = props.order ?? items.map(item => item.id);
	const selectedId = props.selected ?? undefined;
	const level = props.level ?? undefined;
	const term = props.term ?? { maxLines: 10 };

	const byId = new Map<string, TspPickerItem>();
	for (const item of items) byId.set(item.id, item);

	const rows: string[] = [];
	const listBudget = Math.max(3, term.maxLines - (level ? 1 : 0));

	const colGap = 2;
	const colIds = (props.columns ?? []).map(col => col.id);
	const contentWidth = Math.max(16, Math.min(cx.width - 1, 108));

	// Measure aligned column widths across all visible items so every column lines up vertically.
	let widestGlyph = 1;
	let widestLabel = 0;
	let widestDetail = 0;
	let widestTags = 0;
	const factWidths: number[] = colIds.map(() => 0);

	const glyphOf = (item: TspPickerItem): TspSpan =>
		term.glyphs?.[item.id] ?? { t: item.dot ? "●" : "·", ...(item.dot ? { s: item.dot } : {}) };
	for (const item of items) {
		widestGlyph = Math.max(widestGlyph, visibleWidth(glyphOf(item).t));
		widestLabel = Math.max(widestLabel, visibleWidth(plain(item.label)));
		const detail = plain(item.detail);
		widestDetail = Math.max(widestDetail, visibleWidth(detail));
		widestTags = Math.max(widestTags, visibleWidth(tagText(mentionTags(item, detail))));
		for (let i = 0; i < colIds.length; i++) {
			factWidths[i] = Math.max(factWidths[i]!, visibleWidth(factText(item, colIds[i]!)));
		}
	}

	const prefixWidth = visibleWidth(marker) + widestGlyph + 1;
	const activeFacts = colIds
		.map((id, i) => ({ id, width: Math.min(14, factWidths[i]!) }))
		.filter(col => col.width > 0);
	const factsTotal = activeFacts.reduce((sum, col) => sum + colGap + col.width, 0);
	const tagsCol = widestTags > 0 ? Math.min(18, widestTags) : 0;
	const tagsTotal = tagsCol > 0 ? colGap + tagsCol : 0;

	const availForMain = Math.max(10, contentWidth - prefixWidth - factsTotal - tagsTotal);
	const labelCol = Math.min(30, Math.max(10, Math.min(widestLabel, Math.floor(availForMain * 0.55))));
	const remainingForDetail = availForMain - labelCol - colGap;
	const detailCol = widestDetail > 0 && remainingForDetail >= 8 ? Math.min(48, widestDetail, remainingForDetail) : 0;

	type PaintedEntry = { readonly line: string; readonly isSelected: boolean; readonly isHeader: boolean };
	const painted: PaintedEntry[] = [];

	for (const entry of order) {
		if (isPickerGroup(entry)) {
			// A category head: `<glyph> Files (5)`, the glyph in the category's color.
			const style = mentionStyle(entry.group);
			const icon = style && cx.theme.symbols.symbol(style.symbol);
			const lead = style && icon ? `${cx.theme.fg(style.color, icon)} ` : "";
			const head = entry.count === undefined ? plain(entry.label) : `${plain(entry.label)} (${entry.count})`;
			const line = `${blank}${lead}${cx.theme.fg("dim", head)}`;
			painted.push({ line: truncate(line, contentWidth, ""), isSelected: false, isHeader: true });
			continue;
		}
		const item = byId.get(entry);
		if (!item) continue;
		const isSelected = item.id === selectedId;
		const glyph = glyphOf(item);
		const label = plain(item.label);
		const detail = plain(item.detail);
		const tags = mentionTags(item, detail);
		// The selected row keeps its glyph and tag colors; its marker, label, detail and facts take the accent.
		const rest = isSelected ? "accent" : "muted";

		const glyphPad = " ".repeat(Math.max(1, widestGlyph - visibleWidth(glyph.t) + 1));
		const labelStr = truncate(label, labelCol, "…");
		const hasRightCols = detailCol > 0 || tagsCol > 0 || activeFacts.length > 0;
		const labelCell = hasRightCols
			? `${labelStr}${" ".repeat(Math.max(0, labelCol - visibleWidth(labelStr)))}`
			: labelStr;

		const trailingCols: string[] = [];
		if (detailCol > 0) {
			const d = truncate(detail, detailCol, "…");
			trailingCols.push(`${cx.theme.fg(rest, d)}${" ".repeat(Math.max(0, detailCol - visibleWidth(d)))}`);
		}
		if (tagsCol > 0) {
			const t = truncate(tags.map(tag => cx.theme.style(tag.s, tag.t)).join(" "), tagsCol, "…");
			trailingCols.push(`${t}${" ".repeat(Math.max(0, tagsCol - visibleWidth(t)))}`);
		}
		for (const col of activeFacts) {
			const f = truncate(factText(item, col.id), col.width, "");
			trailingCols.push(`${" ".repeat(Math.max(0, col.width - visibleWidth(f)))}${cx.theme.fg(rest, f)}`);
		}

		const tail =
			trailingCols.length > 0 ? `${" ".repeat(colGap)}${trailingCols.join(" ".repeat(colGap))}`.trimEnd() : "";
		const lead = isSelected ? cx.theme.fg("accent", marker) : blank;
		const name = isSelected ? cx.theme.fg("accent", labelCell) : labelCell;
		const line = `${lead}${cx.theme.style(glyph.s ?? "muted", glyph.t)}${glyphPad}${name}${tail}`;
		painted.push({ line: truncate(line, contentWidth, ""), isSelected, isHeader: false });
	}

	// Window around the selected row, keeping its group header visible when right above it.
	let selectedIdx = painted.findIndex(entry => entry.isSelected);
	if (selectedIdx < 0) selectedIdx = 0;
	const total = painted.length;
	let start = 0;
	if (total > listBudget) {
		start = Math.max(0, Math.min(selectedIdx - Math.floor(listBudget / 2), total - listBudget));
		if (start > 0 && painted[start - 1]?.isHeader && selectedIdx === start) start--;
	}
	const slice = painted.slice(start, start + listBudget);
	const needsBar = total > listBudget;
	const thumb = needsBar ? Math.max(1, Math.floor((listBudget * listBudget) / total)) : 0;
	const at = needsBar ? Math.round((start / Math.max(1, total - listBudget)) * (slice.length - thumb)) : 0;

	for (let i = 0; i < slice.length; i++) {
		const line = slice[i]!.line;
		if (!needsBar) {
			rows.push(line);
		} else {
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
			const bar = i >= at && i < at + thumb ? cx.theme.fg("accent", "█") : cx.theme.fg("muted", "│");
			rows.push(`${line}${pad}${bar}`);
		}
	}

	if (level) {
		rows.push(renderLevelFooter(cx, level, cx.width));
	}

	return { rows };
}

defineRolePainter("picker", "omp.mention-picker", paintMentionPopup);
