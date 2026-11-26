/**
 * `kv`: key/value facts. `grid` (default) aligns values in a column after
 * the widest key and wraps each value beside its key; `inline` flows
 * `key value` pairs separated by ` · `, wrapping between pairs.
 */
import type { TspKvProps } from "@oh-my-pi/pi-wire";
import { visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { styledText } from "./layout";

/** Keys never take more than this share of the row in a grid. */
const MAX_KEY_SHARE = 0.4;

definePainter("kv", (node, cx): Block => {
	const props = node.props() as TspKvProps;
	const items = props.items ?? [];
	if (items.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const keyOf = (k: TspKvProps["items"][number]["k"]) =>
		typeof k === "string" ? theme.style("muted", k) : styledText(theme, k);
	if (props.layout === "inline") {
		const pairs = items.map(item => `${keyOf(item.k)} ${styledText(theme, item.v)}`);
		return { rows: wrap(pairs.join(theme.style("dim", " · ")), cx.width) };
	}
	const keys = items.map(item => keyOf(item.k));
	const keyWidth = Math.min(
		Math.max(...keys.map(key => visibleWidth(key))),
		Math.max(1, Math.floor(cx.width * MAX_KEY_SHARE)),
	);
	const valueWidth = cx.width - keyWidth - 2;
	const rows: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const keyRows = wrap(keys[i]!, keyWidth);
		const value = styledText(theme, items[i]!.v);
		if (valueWidth < 1) {
			rows.push(...keyRows, ...wrap(value, cx.width));
			continue;
		}
		const valueRows = value === "" ? [] : wrap(value, valueWidth);
		const count = Math.max(keyRows.length, valueRows.length, 1);
		for (let r = 0; r < count; r++) {
			const key = keyRows[r] ?? "";
			const cell = valueRows[r];
			rows.push(cell === undefined ? key : `${key}${" ".repeat(keyWidth - visibleWidth(key) + 2)}${cell}`);
		}
	}
	return { rows };
});
