/**
 * The provider picker's terminal look (`term.look = "omp.oauth"`): a framed
 * list of providers, each `name ● logged in (source)` (a spinner while the
 * credential is checked), unavailable ones dim, the hovered row banded; the
 * search line (`Type to search` / `Search: query` with its caret), the empty
 * copy and the last activation's warning under it.
 */
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, Hit, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import {
	boxBottom,
	boxRow,
	boxTop,
	definePickerLook,
	PICKER_HOVER,
	type PickerTerm,
	pickerEntries,
	pickerState,
	pointer,
	scrollbar,
	scrollWindow,
	sheetHit,
} from "@oh-my-pi/pi-tui/term/painters/picker";
import { spinnerFrame } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { padTo, truncate } from "@oh-my-pi/pi-tui/text/width";

/** A provider's credential state as the row shows it. */
export type OAuthRowStatus = "checking" | "invalid" | "valid" | "none";

/** The look's term facts. */
export type OAuthLookTerm = PickerTerm & {
	readonly look: "omp.oauth";
	readonly title: string;
	readonly maxRows: number;
	readonly statuses: Readonly<Record<string, OAuthRowStatus>>;
	/** Credential origin tags by provider id (`login`, `env: VAR`, …). */
	readonly sources: Readonly<Record<string, string>>;
	readonly unavailable: readonly string[];
	/** The search line: `null` shows `Type to search`, a line shows the query and caret; absent: no line. */
	readonly searchLine?: { readonly text: string; readonly cursor: number } | null;
	/** The empty copy when no provider shows. */
	readonly empty?: string;
	/** Why the last activation did not pick (a warning under a blank row). */
	readonly status?: string;
};

/** The query with an inverse caret cell (a space at the end). */
function caretLine(text: string, cursor: number, invert: (s: string) => string): string {
	const at = Math.max(0, Math.min(cursor, text.length));
	const segment = segmentGraphemes(text.slice(at)).containing(0)?.segment;
	return `${text.slice(0, at)}${invert(segment ?? " ")}${segment ? text.slice(at + segment.length) : ""}`;
}

function paintOAuth(node: UiNode, cx: PaintContext): Block {
	const width = cx.width;
	const theme = cx.theme;
	const props = node.props() as TspPickerProps & { term: OAuthLookTerm };
	const term = props.term;
	const inner = Math.max(0, width - 4);
	const body: string[] = [];
	const hits: Hit[] = [];
	const entries = pickerEntries(props).filter(entry => entry.kind === "item");
	const unavailable = new Set(term.unavailable);
	const hover = pickerState<string | null>(node, PICKER_HOVER, () => null)();
	const selectedIndex = entries.findIndex(entry => entry.kind === "item" && entry.item.id === props.selected);
	const { start, end } = scrollWindow(entries.length, selectedIndex, term.maxRows);
	const overflow = entries.length > end - start;
	const rowWidth = overflow ? inner - 1 : inner;
	const bar = overflow ? scrollbar(theme, entries.length, start, end - start) : undefined;
	for (let i = start; i < end; i++) {
		const entry = entries[i]!;
		if (entry.kind !== "item") continue;
		const id = entry.item.id;
		const name = typeof entry.item.label === "string" ? entry.item.label : entry.item.label.map(s => s.t).join("");
		const available = !unavailable.has(id);
		const source = term.sources[id] ? theme.style("muted", ` (${term.sources[id]})`) : "";
		let state = "";
		switch (term.statuses[id]) {
			case "checking":
				state = theme.style("warning", ` ${spinnerFrame(cx)} checking`) + source;
				break;
			case "invalid":
				state = theme.style("error", ` ${theme.symbols.symbol("status.error")} invalid`) + source;
				break;
			case "valid":
				state = theme.style("success", ` ${theme.symbols.symbol("status.enabled")} logged in`) + source;
				break;
		}
		let line: string;
		if (id === props.selected) {
			line = theme.style("accent", pointer(theme, true)) + theme.style(available ? "accent" : "dim", name) + state;
		} else {
			line = (available ? `  ${name}` : theme.style("dim", `  ${name}`)) + state;
			if (id === hover) line = theme.style("selectedBg", line);
		}
		line = truncate(line, rowWidth, theme.symbols.ellipsis);
		hits.push({ row: body.length + 1, col: 2, width: inner, height: 1, node, item: id });
		body.push(bar ? `${padTo(line, rowWidth)}${bar[i - start]}` : line);
	}
	if (term.searchLine !== undefined) {
		const line =
			term.searchLine === null
				? theme.style("muted", "Type to search")
				: theme.style("muted", "Search: ") +
					caretLine(term.searchLine.text, term.searchLine.cursor, s => theme.style("inverse", s));
		body.push(truncate(line, inner, theme.symbols.ellipsis));
	}
	if (term.empty) body.push(truncate(theme.style("muted", term.empty), inner, theme.symbols.ellipsis));
	if (term.status) body.push("", truncate(theme.style("warning", term.status), inner, theme.symbols.ellipsis));
	const rows = [
		boxTop(theme, width, term.title),
		...body.map(row => boxRow(theme, width, row)),
		boxBottom(theme, width),
	];
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits] };
}

definePickerLook("omp.oauth", paintOAuth);
