/**
 * The history search's terminal look (`term.look = "omp.history"`): a framed
 * sheet with the query field, the prompts (whole prompt on one row, query
 * words marked, age flush right; the selected row bold on the selection
 * band) and the key hints, set apart by blank rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, Hit, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import {
	boxBottom,
	boxRow,
	boxTop,
	definePickerLook,
	type PickerTerm,
	pickerEntries,
	pickerPage,
	pointer,
	scrollbar,
	scrollWindow,
	sheetHit,
} from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { bindingGlyph, selectNavGlyphs } from "../panels/common";
import { caretField, highlightRanges, keyHintRows, tokenHits } from "./common";

/** The look's term facts. */
export type HistoryLookTerm = PickerTerm & {
	readonly look: "omp.history";
	readonly title: string;
	readonly field: { readonly text: string; readonly cursor: number };
	/** Each result's whole prompt on one line, by item id. */
	readonly prompts: Readonly<Record<string, string>>;
	/** The words the results were searched for. */
	readonly tokens: readonly string[];
	/** Whether the results answer a query (the empty copy says so). */
	readonly searched: boolean;
};

/** The key hints, in the user's bindings. */
function hints(): (readonly [string, string])[] {
	return [
		[selectNavGlyphs(), "navigate"],
		[bindingGlyph("tui.select.confirm", "enter"), "select"],
		["⌦", "delete at end"],
		[bindingGlyph("tui.select.cancel", "escape"), "cancel"],
	];
}

function paintHistory(node: UiNode, cx: PaintContext): Block {
	const width = cx.width;
	const theme = cx.theme;
	const props = node.props() as TspPickerProps & { term: HistoryLookTerm };
	const term = props.term;
	const inner = Math.max(0, width - 4);
	const body: string[] = ["", caretField(theme, "> ", term.field.text, term.field.cursor, inner), ""];
	const hits: Hit[] = [];
	const entries = pickerEntries(props);
	if (entries.length === 0) {
		const message = term.searched ? "No matching history" : "No history yet";
		body.push(theme.style("muted", `  ${theme.symbols.symbol("status.info")} ${message}`));
	} else {
		const visible = pickerPage(node);
		const selectedIndex = entries.findIndex(entry => entry.kind === "item" && entry.item.id === props.selected);
		const { start, end } = scrollWindow(entries.length, selectedIndex, visible);
		const overflow = entries.length > visible;
		const rowWidth = overflow ? inner - 1 : inner;
		const bar = overflow ? scrollbar(theme, entries.length, start, end - start) : undefined;
		const gutter = 2;
		for (let i = start; i < end; i++) {
			const entry = entries[i]!;
			if (entry.kind !== "item") continue;
			const item = entry.item;
			const selected = item.id === props.selected;
			const time = String(item.facts?.when ?? "");
			const timeWidth = visibleWidth(time);
			const showTime = rowWidth >= gutter + 12 + timeWidth;
			const budget = Math.max(4, rowWidth - gutter - (showTime ? timeWidth + 1 : 0));
			const prompt = truncate(term.prompts[item.id] ?? "", budget, theme.symbols.ellipsis);
			const marked = highlightRanges(theme, prompt, tokenHits(prompt, term.tokens));
			const lead = selected ? theme.style("accent", pointer(theme, true)) : pointer(theme, false);
			let line = lead + (selected ? theme.style("strong", marked) : marked);
			if (showTime) {
				line = `${truncate(line, rowWidth - timeWidth - 1, theme.symbols.ellipsis, true)} ${theme.style("dim", time)}`;
			}
			line = selected ? theme.style("selectedBg", truncate(line, rowWidth, "", true)) : truncate(line, rowWidth);
			hits.push({ row: body.length + 1, col: 2, width: inner, height: 1, node, item: item.id });
			body.push(bar ? `${padTo(line, rowWidth)}${bar[i - start]}` : line);
		}
	}
	body.push("", ...keyHintRows(theme, hints(), inner), "");
	const rows = [
		boxTop(theme, width, term.title),
		...body.map(row => boxRow(theme, width, row)),
		boxBottom(theme, width),
	];
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits] };
}

definePickerLook("omp.history", paintHistory);
