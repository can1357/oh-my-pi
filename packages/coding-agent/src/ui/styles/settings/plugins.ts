/**
 * Plugin settings panels (`card` roles `omp.overlay.plugin-settings` and
 * `….field`): a rounded frame titled by the card's `head`, its body drawn
 * from the panel blocks the view puts in `term.blocks` (the terminal look of
 * the list, detail and editor panels, whose native children describe the
 * same content semantically).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { descriptionRows, inputLine, scrolled, selectList, settingRow } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { padTo, spaces, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";

/** A row of a panel's settings list. */
export interface PanelSetting {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly description?: string;
}

/** One piece of a panel body, top to bottom. */
export type PanelBlock =
	| { readonly k: "gap" }
	/** Text wrapped to the width. */
	| { readonly k: "text"; readonly spans: readonly TspSpan[] }
	/** A select list (cursor, label column, muted detail). */
	| {
			readonly k: "select";
			readonly options: readonly { readonly label: readonly TspSpan[]; readonly detail?: readonly TspSpan[] }[];
			readonly selected: number;
			readonly max: number;
			readonly column?: { readonly min: number; readonly max: number };
			/** Options exceed `max` and typing filters: the search status row follows. */
			readonly search?: string;
	  }
	/** A type-to-search settings list with its description area, search status and key hint. */
	| {
			readonly k: "settings";
			readonly rows: readonly PanelSetting[];
			/** Rows before filtering (empty: the empty text). */
			readonly total: number;
			readonly selected: number;
			readonly maxVisible: number;
			readonly query: string;
	  }
	/** A single-line text field. */
	| { readonly k: "input"; readonly text: string; readonly cursor: number; readonly mask?: boolean }
	/** A child node painted in place (an open editor panel), padded to `height` rows. */
	| { readonly k: "node"; readonly node: UiNode; readonly height?: number };

/** Terminal facts of a panel card. */
export interface PanelTerm {
	readonly blocks?: readonly PanelBlock[];
}

/** The settings list hint: what its keys do. */
const SETTINGS_HINT = "  ⏎/␣ to change · Type to search · ⎋ to cancel";

function settingsBlock(theme: Theme, block: Extract<PanelBlock, { k: "settings" }>, width: number): string[] {
	const lines: string[] = [];
	const stable = block.maxVisible + 4 + 1 + 2;
	if (block.total === 0) {
		lines.push(theme.fg("dim", "  No settings available"));
	} else if (block.rows.length === 0) {
		lines.push(theme.fg("dim", truncate(`  Search: ${block.query}`, width, "")));
		lines.push(theme.fg("dim", "  No matching settings"));
		lines.push("");
		lines.push(truncate(theme.fg("dim", "  ⌫ to edit search · ⎋ to cancel"), width));
	} else {
		const height = Math.min(block.maxVisible, block.rows.length);
		const start = Math.max(0, Math.min(block.selected - Math.floor(height / 2), block.rows.length - height));
		let labelWidth = 0;
		for (const row of block.rows) labelWidth = Math.max(labelWidth, visibleWidth(row.label));
		labelWidth = Math.min(30, labelWidth);
		const rowWidth = Math.max(0, width - (block.rows.length > height ? 1 : 0));
		const rows: string[] = [];
		for (let i = start; i < start + height; i++) {
			const row = block.rows[i]!;
			rows.push(
				settingRow(theme, {
					label: row.label,
					value: row.value,
					selected: i === block.selected,
					labelWidth,
					width: rowWidth,
					dimmed: false,
					hovered: false,
				}),
			);
		}
		lines.push(...scrolled(theme, rows, block.rows.length, start, width, height));
		while (lines.length < block.maxVisible) lines.push("");
		const selected = block.rows[block.selected];
		const description = selected?.description;
		lines.push(...descriptionRows(theme, selected ? {} : undefined, width, description));
		const query = block.query.replace(/\s+/g, " ").trim();
		lines.push(theme.fg("dim", truncate(query ? `  Search: ${query}` : "  Type to search", width, "")));
		lines.push("");
		lines.push(truncate(theme.fg("dim", SETTINGS_HINT), width));
	}
	while (lines.length < stable) lines.push("");
	return lines;
}

function blockRows(theme: Theme, block: PanelBlock, width: number, cx: PaintContext): string[] {
	switch (block.k) {
		case "gap":
			return [""];
		case "text":
			return wrap(styledText(theme, block.spans), width);
		case "select": {
			const options = block.options.map(option => ({
				label: styledText(theme, option.label),
				detail: option.detail && styledText(theme, option.detail),
			}));
			const list = selectList(theme, options, block.selected, width, block.max, undefined, block.column);
			return list.rows;
		}
		case "settings":
			return settingsBlock(theme, block, width);
		case "input": {
			const text = block.mask ? "•".repeat([...block.text].length) : block.text;
			return [
				inputLine(text, block.mask ? Array.from(block.text.slice(0, block.cursor)).length : block.cursor, width),
			];
		}
		case "node": {
			const rows = [...cx.paint(block.node, width).rows];
			while (block.height !== undefined && rows.length < block.height) rows.push("");
			return rows;
		}
	}
}

function panel(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const width = cx.width;
	const props = node.props() as { head?: string; term?: PanelTerm };
	const box = theme.symbols.box;
	const border = (text: string): string => theme.fg("border", text);
	const inner = Math.max(0, width - 2);
	const title = props.head ?? "";
	let top: string;
	if (title) {
		const shown = truncate(` ${title} `, Math.max(0, inner - 2));
		top =
			border(box.topLeft + box.horizontal) +
			theme.style("strong", theme.fg("accent", shown)) +
			border(box.horizontal.repeat(Math.max(0, inner - 1 - visibleWidth(shown))) + box.topRight);
	} else top = border(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const rows = [top];
	const body = Math.max(1, width - 4);
	for (const block of props.term?.blocks ?? [])
		for (const line of blockRows(theme, block, body, cx))
			rows.push(`${border(box.vertical)} ${width > 4 ? fit(line, body) : ""} ${border(box.vertical)}`);
	rows.push(border(box.bottomLeft + box.horizontal.repeat(inner) + box.bottomRight));
	if (width < 4) return { rows: rows.map(row => truncate(row, width, "")) };
	return { rows };
}

/** Padded, or cut with an ellipsis, to exactly `width` cells. */
function fit(text: string, width: number): string {
	const cells = visibleWidth(text);
	if (cells === width) return text;
	if (cells < width) return text + spaces(width - cells);
	return padTo(truncate(text, width), width);
}

defineRolePainter("card", "omp.overlay.plugin-settings", panel);
defineRolePainter("card", "omp.overlay.plugin-settings.field", panel);
