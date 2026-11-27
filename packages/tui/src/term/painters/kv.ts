/**
 * `kv`: key/value facts. `grid` (default) aligns values in a column after
 * the widest key and wraps each value beside its key; `inline` flows
 * `key value` pairs separated by ` · `, wrapping between pairs. Text: one
 * line per pair in a grid (key and value runs side by side), the whole flow
 * inline.
 */
import type { TspKvProps } from "@oh-my-pi/pi-wire";
import { visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import {
	lazyText,
	mapWrappedText,
	offsetRenderedText,
	type RenderedText,
	type RenderedTextRow,
	type RenderedTextSpan,
	withSpans,
} from "../text-layout";
import { styledText } from "./layout";

/** Keys never take more than this share of the row in a grid. */
const MAX_KEY_SHARE = 0.4;

/**
 * The text of a grid pair: `key` wrapped into `keyRows` beside `value` in
 * `valueRows` from column `valueColumn`, as one line `key value` when each
 * is a single line; else each side's own lines, the key's first.
 */
function pairText(
	key: string,
	keyRows: readonly string[],
	value: string,
	valueRows: readonly string[],
	valueColumn: number,
	count: number,
): RenderedText {
	const keys = mapWrappedText(key, keyRows);
	const values = mapWrappedText(value, valueRows).map(row => offsetRenderedText(row, valueColumn));
	const keyLine = keys[0]?.line;
	const valueLine = values[0]?.line;
	const single =
		keyLine && valueLine && keys.every(row => row?.line === keyLine) && values.every(row => row?.line === valueLine);
	const out: (RenderedTextRow | undefined)[] = [];
	if (!single) {
		for (let r = 0; r < count; r++) out.push(values[r] ?? keys[r]);
		return out;
	}
	const line = { text: `${keyLine.text} ${valueLine.text}` };
	const base = keyLine.text.length + 1;
	for (let r = 0; r < count; r++) {
		const spans: RenderedTextSpan[] = [];
		const keyRow = keys[r];
		const valueRow = values[r];
		if (keyRow)
			for (const span of keyRow.spans ?? [keyRow])
				spans.push({ start: span.start, end: span.end, column: span.column });
		if (valueRow)
			for (const span of valueRow.spans ?? [valueRow])
				spans.push({ start: base + span.start, end: base + span.end, column: span.column });
		out.push(withSpans(line, spans));
	}
	return out;
}

definePainter("kv", (node, cx): Block => {
	const props = node.props() as TspKvProps;
	const items = props.items ?? [];
	if (items.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const width = cx.width;
	const keyOf = (k: TspKvProps["items"][number]["k"]) =>
		typeof k === "string" ? theme.style("muted", k) : styledText(theme, k);
	if (props.layout === "inline") {
		const flow = items.map(item => `${keyOf(item.k)} ${styledText(theme, item.v)}`).join(theme.style("dim", " · "));
		const rows = wrap(flow, width);
		return { rows, text: lazyText(() => mapWrappedText(flow, rows)) };
	}
	const keys = items.map(item => keyOf(item.k));
	const keyWidth = Math.min(
		Math.max(...keys.map(key => visibleWidth(key))),
		Math.max(1, Math.floor(width * MAX_KEY_SHARE)),
	);
	const valueWidth = width - keyWidth - 2;
	/** The rows, and with `text` the text of each. */
	const draw = (text?: (RenderedTextRow | undefined)[]): string[] => {
		const rows: string[] = [];
		for (let i = 0; i < items.length; i++) {
			const keyRows = wrap(keys[i]!, keyWidth);
			const value = styledText(theme, items[i]!.v);
			if (valueWidth < 1) {
				const valueRows = wrap(value, width);
				rows.push(...keyRows, ...valueRows);
				if (text) text.push(...mapWrappedText(keys[i]!, keyRows), ...mapWrappedText(value, valueRows));
				continue;
			}
			const valueRows = value === "" ? [] : wrap(value, valueWidth);
			const count = Math.max(keyRows.length, valueRows.length, 1);
			for (let r = 0; r < count; r++) {
				const key = keyRows[r] ?? "";
				const cell = valueRows[r];
				rows.push(cell === undefined ? key : `${key}${" ".repeat(keyWidth - visibleWidth(key) + 2)}${cell}`);
			}
			if (text) text.push(...pairText(keys[i]!, keyRows, value, valueRows, keyWidth + 2, count));
		}
		return rows;
	};
	return {
		rows: draw(),
		text: lazyText(() => {
			const text: (RenderedTextRow | undefined)[] = [];
			draw(text);
			return text;
		}),
	};
});
