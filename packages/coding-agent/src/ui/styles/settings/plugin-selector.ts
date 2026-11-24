/**
 * The plugin selector's terminal look (picker `term.look: "plugins"`): a
 * rounded "Plugins" frame around a select list — the label with version,
 * install state and scope, the description beside it, a scrollbar and the
 * search status once the list overflows; the row under the pointer banded.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, PICKER_HOVER, pickerState, pickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import { selectList } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

/** Rows the selector lists before it scrolls. */
export const PLUGIN_SELECTOR_ROWS = 20;

function paint(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const width = cx.width;
	const props = node.props() as TspPickerProps;
	const labels = pickerTerm(node).labels ?? {};
	const items = props.items ?? [];
	const hoverId = pickerState<string | undefined>(node, PICKER_HOVER, () => undefined)();
	const options = items.map(item => {
		const look = labels[item.id];
		return { label: look?.label ?? String(item.label), detail: look?.detail };
	});
	const selected = Math.max(
		0,
		items.findIndex(item => item.id === props.selected),
	);
	const hover = items.findIndex(item => item.id === hoverId);
	const body = Math.max(1, width - 4);
	const list = selectList(
		theme,
		options,
		selected,
		body,
		Math.min(items.length, PLUGIN_SELECTOR_ROWS),
		hover >= 0 ? hover : undefined,
	);
	const box = theme.symbols.box;
	const border = (text: string): string => theme.fg("border", text);
	const inner = Math.max(0, width - 2);
	const shown = truncate(" Plugins ", Math.max(0, inner - 2));
	const rows = [
		border(box.topLeft + box.horizontal) +
			theme.style("strong", theme.fg("accent", shown)) +
			border(box.horizontal.repeat(Math.max(0, inner - 1 - visibleWidth(shown))) + box.topRight),
	];
	list.rows.forEach((line, index) => {
		const item = items[list.first + index];
		const styled =
			item?.disabled && index < Math.min(items.length, PLUGIN_SELECTOR_ROWS) ? theme.fg("muted", line) : line;
		const cut = truncate(styled, body);
		rows.push(`${border(box.vertical)} ${cut}${spaces(body - visibleWidth(cut))} ${border(box.vertical)}`);
	});
	rows.push(border(box.bottomLeft + box.horizontal.repeat(inner) + box.bottomRight));
	const hits = items
		.slice(list.first, list.first + Math.min(items.length, PLUGIN_SELECTOR_ROWS))
		.map((item, index) => ({
			row: 1 + index,
			col: 0,
			width,
			height: 1,
			node,
			item: item.id,
		}));
	return { rows, hits: [{ row: 0, col: 0, width, height: rows.length, node }, ...hits] };
}

definePickerLook("plugins", paint);
