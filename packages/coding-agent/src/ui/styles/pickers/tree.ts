/**
 * The session tree's terminal look (`term.look = "omp.tree"`): a framed
 * panel with the key help, the search field, a divider, then the visible
 * entries drawn with tree guides (`├─`/`└─` at forks, `│` down an open
 * branch), the active path bulleted, labels in brackets; the selected row
 * bold on the selection band behind a `›`. The label editor replaces the
 * rows while open.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, Hit, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import {
	boxBottom,
	boxRow,
	boxRule,
	boxTop,
	definePickerLook,
	type PickerTerm,
	scrollbar,
	scrollWindow,
	sheetHit,
} from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { caretField } from "./common";
import { canonicalKeyId } from "../../../config/keybindings/key-id";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { bindingGlyph, keyGlyph } from "../panels/common";

/** One visible entry. */
export type TreeLookRow = {
	readonly id: string;
	readonly depth: number;
	/** A fork's branch head. */
	readonly branch: boolean;
	/** The last branch of its fork. */
	readonly last: boolean;
	/** Per guide level above the row: whether a `│` runs there (a fork above it with branches still to come). */
	readonly guides: readonly boolean[];
	readonly active: boolean;
	readonly label?: string;
	readonly parts: readonly { readonly t: string; readonly s?: string; readonly strong?: boolean }[];
};

/** The look's term facts. */
export type TreeLookTerm = PickerTerm & {
	readonly look: "omp.tree";
	readonly entries: readonly TreeLookRow[];
	readonly field: { readonly text: string; readonly cursor: number };
	readonly maxRows: number;
	/** The open label editor's line. */
	readonly label?: { readonly text: string; readonly cursor: number };
	/** The filter's tag (` [user]`), empty for the default filter. */
	readonly filterLabel: string;
	/** Entries before filtering. */
	readonly total: number;
};

/** The key help line, in the user's bindings (branch keys only when bound). */
function help(): string {
	const branchKeys = (["app.tree.previousBranch", "app.tree.nextBranch"] as const)
		.map(action => getKeybindings().keysFor(action)[0])
		.filter(key => key !== undefined)
		.map(key => keyGlyph(canonicalKeyId(key)))
		.join("/");
	return [
		`${bindingGlyph("tui.select.confirm", "enter")}: switch.`,
		"⌥↑/⌥↓: previous/next turn.",
		...(branchKeys ? [`${branchKeys}: previous/next branch.`] : []),
		`${bindingGlyph("tui.select.pageUp", "pageUp")}/${bindingGlyph("tui.select.pageDown", "pageDown")} (←/→): page.`,
		"Home/End: first/last item. ⇧⏎: summarize & switch. ⇧L: label. ⌃O: filter. ⌥D/⌥T/⌥U/⌥L/⌥A: filter. Type to search",
	].join(" ");
}

/** Cells a row's entry text keeps at least, however deep the tree. */
const TREE_MIN_CONTENT = 24;

/** A row's guide prefix: `│` under each fork still open above it, `├─`/`└─` at a branch head's own level. */
function guide(row: TreeLookRow): string {
	let out = "";
	for (let level = 0; level < row.depth; level++) {
		if (row.guides[level]) out += "│  ";
		else if (row.branch && level === row.depth - 1) out += row.last ? "└─ " : "├─ ";
		else out += "   ";
	}
	return out;
}

function paintTree(node: UiNode, cx: PaintContext): Block {
	const width = cx.width;
	const theme = cx.theme;
	const props = node.props() as TspPickerProps & { term: TreeLookTerm };
	const term = props.term;
	const inner = Math.max(1, width - 4);
	const head = ["", truncate(theme.style("muted", help()), inner, theme.symbols.ellipsis)];
	head.push(caretField(theme, `${theme.style("muted", "Search:")} `, term.field.text, term.field.cursor, inner));
	const body: string[] = [""];
	const hits: Hit[] = [];
	if (term.label) {
		body.push(truncate(theme.style("muted", "Label (empty to remove):"), inner));
		body.push(caretField(theme, "> ", term.label.text, term.label.cursor, inner));
		const save = bindingGlyph("tui.input.submit", "enter");
		body.push(
			truncate(theme.style("dim", `${save}: save  ${bindingGlyph("tui.select.cancel", "escape")}: cancel`), inner),
		);
	} else if (term.entries.length === 0) {
		const muted = (text: string): string => truncate(theme.style("muted", text), inner, theme.symbols.ellipsis);
		if (term.total === 0) body.push(muted("No entries found"), muted(`(0/0)${term.filterLabel}`));
		else if (term.field.text.length > 0)
			body.push(
				muted(`No entries match search "${term.field.text}"`),
				muted("Press ⌫ to clear the search"),
				muted(`(0/${term.total})${term.filterLabel}`),
			);
		else
			body.push(
				muted(`${term.total} entries hidden by the current filter ${term.filterLabel.trim() || "[default]"}`),
				muted("Press ⌥A to show all, ⌥D for default"),
				muted(`(0/${term.total})${term.filterLabel}`),
			);
	} else {
		const selectedIndex = term.entries.findIndex(row => row.id === props.selected);
		const { start, end } = scrollWindow(term.entries.length, selectedIndex, term.maxRows);
		const overflow = term.entries.length > end - start;
		const rowWidth = overflow ? inner - 1 : inner;
		const bar = overflow ? scrollbar(theme, term.entries.length, start, end - start) : undefined;
		// Deep trees keep a content budget (24 cells or half the row): older guide levels scroll off
		// behind a leading `…`, one offset for the whole window so every row describes one shape.
		const maxLevels = Math.max(1, Math.floor((inner - Math.max(TREE_MIN_CONTENT, Math.floor(inner / 2)) - 4) / 3));
		let deepest = 0;
		for (let i = start; i < end; i++) deepest = Math.max(deepest, term.entries[i]!.depth);
		const windowOffset = Math.max(0, deepest - maxLevels);
		for (let i = start; i < end; i++) {
			const row = term.entries[i]!;
			const selected = row.id === props.selected;
			let marks = row.active ? theme.style("accent", "• ") : "";
			if (row.label) marks += theme.style("warning", `[${row.label}] `);
			let text = "";
			for (const part of row.parts) {
				const tokens = [part.s, part.strong && !selected ? "strong" : undefined].filter(Boolean).join(" ");
				text += tokens ? theme.style(tokens, part.t) : part.t;
			}
			// A selected row is bold whole (after its marks); nested bold would close it early.
			text = marks + (selected ? theme.style("strong", text) : text);
			const lead = selected ? theme.style("accent", "› ") : "  ";
			let prefix = guide(row);
			const hidden = Math.min(windowOffset, row.depth) * 3;
			if (hidden > 0) {
				prefix = prefix.slice(hidden);
				if (prefix.length > 0) prefix = `…${prefix.slice(1)}`;
			}
			let line = `${lead}${theme.style("dim", prefix)}${text}`;
			// The band goes on before the cut so the ellipsis keeps it.
			if (selected) line = theme.style("selectedBg", line);
			line = truncate(line, rowWidth, theme.symbols.ellipsis);
			hits.push({ row: head.length + 2 + body.length, col: 2, width: inner, height: 1, node, item: row.id });
			body.push(bar ? `${padTo(line, rowWidth)}${bar[i - start]}` : line);
		}
	}
	if (!term.label && term.entries.length > 0 && term.filterLabel)
		body.push(truncate(theme.style("muted", term.filterLabel.trim()), inner, theme.symbols.ellipsis));
	body.push("");
	const rows = [
		boxTop(theme, width, "Session Tree"),
		...head.map(row => boxRow(theme, width, row)),
		boxRule(theme, width),
		...body.map(row => boxRow(theme, width, row)),
		boxBottom(theme, width),
	];
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits] };
}

definePickerLook("omp.tree", paintTree);
