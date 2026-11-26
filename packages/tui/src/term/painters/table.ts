/**
 * `table`: a header row, a rule, then one row per record. Columns take their
 * natural width; when the row is too narrow the lowest-priority columns hide
 * first, then the widest shrink (cells cut per their `truncate`). Spare
 * cells go to `grow` columns.
 */
import type { TspTableColumn, TspTableProps } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { align, truncate, truncateMiddle, truncateStart, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { styledText } from "./layout";

const GAP = 2;
/** Narrowest a shrinking column gets. */
const MIN_COLUMN = 3;

function fit(theme: Theme, text: string, width: number, column: TspTableColumn): string {
	const cut =
		visibleWidth(text) <= width
			? text
			: column.truncate === "start"
				? truncateStart(text, width, theme.symbols.ellipsis)
				: column.truncate === "middle"
					? truncateMiddle(text, width, theme.symbols.ellipsis)
					: truncate(text, width, theme.symbols.ellipsis);
	return align(cut, width, column.align === "end" ? "right" : column.align === "center" ? "center" : "left");
}

definePainter("table", (node, cx): Block => {
	const props = node.props() as TspTableProps;
	const theme = cx.theme;
	const records = props.rows ?? [];
	let columns = [...(props.cols ?? [])];
	if (columns.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const heads = new Map(columns.map(c => [c.id, theme.style("muted strong", styledText(theme, c.head))]));
	const cells = records.map(record => new Map(columns.map(c => [c.id, styledText(theme, record.cells[c.id])])));
	const natural = new Map(
		columns.map(c => [
			c.id,
			Math.max(visibleWidth(heads.get(c.id)!), ...cells.map(row => visibleWidth(row.get(c.id)!))),
		]),
	);
	const total = (cols: readonly TspTableColumn[]) =>
		cols.reduce((sum, c) => sum + natural.get(c.id)!, 0) + GAP * Math.max(0, cols.length - 1);
	// Hide the lowest priorities while even their minimum widths overflow.
	const minimum = (cols: readonly TspTableColumn[]) =>
		cols.reduce((sum, c) => sum + Math.min(MIN_COLUMN, natural.get(c.id)!), 0) + GAP * Math.max(0, cols.length - 1);
	while (columns.length > 1 && minimum(columns) > cx.width) {
		let drop = columns.length - 1;
		for (let i = columns.length - 1; i >= 0; i--)
			if ((columns[i]!.priority ?? 0) < (columns[drop]!.priority ?? 0)) drop = i;
		columns = columns.filter((_, i) => i !== drop);
	}
	const widths = new Map(columns.map(c => [c.id, natural.get(c.id)!]));
	let excess = total(columns) - cx.width;
	while (excess > 0) {
		let widest: TspTableColumn | undefined;
		for (const c of columns)
			if (widths.get(c.id)! > MIN_COLUMN && (!widest || widths.get(c.id)! > widths.get(widest.id)!)) widest = c;
		if (!widest) break;
		widths.set(widest.id, widths.get(widest.id)! - 1);
		excess--;
	}
	if (excess < 0) {
		const grows = columns.filter(c => (c.grow ?? 0) > 0);
		const growTotal = grows.reduce((sum, c) => sum + (c.grow ?? 0), 0);
		let spare = -excess;
		for (let i = 0; i < grows.length; i++) {
			const share = i === grows.length - 1 ? spare : Math.floor((-excess * (grows[i]!.grow ?? 0)) / growTotal);
			widths.set(grows[i]!.id, widths.get(grows[i]!.id)! + share);
			spare -= share;
		}
	}
	const line = (pick: (c: TspTableColumn) => string) =>
		truncate(
			columns
				.map(c => fit(theme, pick(c), widths.get(c.id)!, c))
				.join(" ".repeat(GAP))
				.trimEnd(),
			cx.width,
			"",
		);
	const ruleWidth = Math.min(
		cx.width,
		columns.reduce((sum, c) => sum + widths.get(c.id)!, 0) + GAP * (columns.length - 1),
	);
	const rows = [line(c => heads.get(c.id)!), theme.fg("border", theme.symbols.box.horizontal.repeat(ruleWidth))];
	for (const row of cells) rows.push(line(c => row.get(c.id)!));
	return { rows };
});
