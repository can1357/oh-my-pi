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
 * - at most `max.lines` rows, a window centred on the selection, with a
 *   scrollbar in the last column while items are hidden (accent thumb, muted
 *   track).
 */
import type { TspText } from "@oh-my-pi/pi-wire";
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
	const overflow = entries.length > visible;
	const rowWidth = Math.max(0, cx.width - (overflow ? 1 : 0));
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
	// Even on a narrow screen leave space for the cursor, gap, a label cell and the end margin.
	const iconColumn = Math.min(widestGlyph, Math.max(0, rowWidth - cursorWidth - 4));
	const column = Math.max(min, Math.min(max, widest));

	const start = overflow ? Math.max(0, Math.min(selected - Math.floor(visible / 2), entries.length - visible)) : 0;
	const end = Math.min(entries.length, start + visible);
	const rows: string[] = [];
	for (let i = start; i < end && rows.length < visible; i++) {
		for (const row of itemRows(cx, entries[i]!, i === selected, rowWidth, column, iconColumn, cursor, term)) {
			if (rows.length >= visible) break;
			rows.push(row);
		}
	}
	if (!overflow) return { rows };

	const thumb = Math.max(1, Math.floor((visible * visible) / entries.length));
	const span = entries.length - visible;
	const at = span > 0 ? Math.round((start / span) * (rows.length - thumb)) : 0;
	return {
		rows: rows.map((row, i) => {
			const pad = " ".repeat(Math.max(0, rowWidth - visibleWidth(row)));
			const bar = i >= at && i < at + thumb ? cx.theme.fg("accent", "█") : cx.theme.fg("muted", "│");
			return `${row}${pad}${bar}`;
		}),
	};
}

defineRolePainter("overlay", "omp.autocomplete", paintPopup);
