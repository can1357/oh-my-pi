/**
 * `tree`: nested nodes drawn with branch connectors (`├─`, `└─`, `│`). A node
 * with children shows `▾` when open (its children follow) and `▸` when
 * folded.
 */
import type { TspTreeNode, TspTreeProps } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { truncate } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { styledText } from "./layout";

function treeRows(theme: Theme, nodes: readonly TspTreeNode[], indent: string, width: number, rows: string[]): void {
	const symbol = (key: string, fallback: string) => theme.symbols.symbol(key) || fallback;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const last = i === nodes.length - 1;
		const branch = theme.fg("dim", last ? symbol("tree.last", "└─") : symbol("tree.branch", "├─"));
		const kids = node.children ?? [];
		const fold = kids.length > 0 ? `${theme.fg("dim", node.open ? "▾" : "▸")} ` : "";
		const icon = node.icon ? `${theme.symbols.icon(node.icon)} ` : "";
		rows.push(
			truncate(`${indent}${branch} ${fold}${icon}${styledText(theme, node.label)}`, width, theme.symbols.ellipsis),
		);
		if (kids.length > 0 && node.open) {
			const next = `${indent}${last ? "   " : `${theme.fg("dim", symbol("tree.vertical", "│"))}  `}`;
			treeRows(theme, kids, next, width, rows);
		}
	}
}

definePainter("tree", (node, cx): Block => {
	const nodes = (node.props() as TspTreeProps).nodes ?? [];
	if (nodes.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const rows: string[] = [];
	treeRows(cx.theme, nodes, "", cx.width, rows);
	return { rows };
});
