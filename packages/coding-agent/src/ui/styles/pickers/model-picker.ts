/**
 * The model switcher's terminal look (`term.look = "omp.model-picker"`): a
 * framed sheet titled "Switch Model" (red frame and "Switch Task Model" in
 * task mode) over a status row (what a pick does, or the catalog error, then
 * the highlighted model's thinking level in its color), the model list
 * (`styles/pickers/model-browser`), and the mode's key hints.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Hit, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, type PickerTerm, sheetHit } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ModelBrowserState } from "../../overlays/pickers/model-browser-state";
import { MODEL_LIST_TOP, modelBrowserRows } from "./model-browser";

/** The switcher's term facts. */
export type ModelPickerLookTerm = PickerTerm & {
	readonly look: "omp.model-picker";
	readonly browser: ModelBrowserState;
	readonly heading: string;
	/** Frame and title color (task mode: `error`); absent: the border and accent colors. */
	readonly tone?: string;
	/** The status row: its text and color. */
	readonly status: { readonly text: string; readonly tone: string };
	/** The thinking level after the status: its label and color, or frozen. */
	readonly thinking?: { readonly label: string; readonly color: string } | "frozen";
	readonly footer: string;
};

/** `╭─ title ───╮` in `tone` (default: border frame, bold accent title). */
export function frameTop(theme: Theme, width: number, title: string, tone?: string): string {
	const box = theme.symbols.box;
	const inner = Math.max(0, width - 2);
	const shown = truncate(` ${title} `, Math.max(0, inner - 2), theme.symbols.ellipsis);
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return `${theme.style(tone ?? "border", `${box.topLeft}${box.horizontal}`)}${theme.style(`strong ${tone ?? "accent"}`, shown)}${theme.style(tone ?? "border", `${box.horizontal.repeat(fill)}${box.topRight}`)}`;
}

/** `│ content │`: content cut with an ellipsis and padded to `width - 4`. */
export function frameRow(theme: Theme, width: number, content: string, tone?: string): string {
	const v = theme.style(tone ?? "border", theme.symbols.box.vertical);
	const inner = width - 4;
	return `${v} ${inner > 0 ? padTo(truncate(content, inner, theme.symbols.ellipsis), inner) : ""} ${v}`;
}

/** `╰───╯` in `tone`. */
export function frameBottom(theme: Theme, width: number, tone?: string): string {
	const box = theme.symbols.box;
	return theme.style(
		tone ?? "border",
		`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`,
	);
}

function paintModelPicker(node: UiNode, cx: PaintContext) {
	const theme = cx.theme;
	const width = cx.width;
	// The look is selected by `term.look`, which only `ModelPicker` sets with these facts.
	const props = node.props() as { term: ModelPickerLookTerm };
	const term = props.term;
	const view = term.browser.view(key => theme.symbols.symbol(key));
	let status = theme.style(term.status.tone, ` ${term.status.text}`);
	if (term.thinking === "frozen") status += theme.style("dim", " · no thinking");
	else if (term.thinking)
		status += `${theme.style("muted", " · thinking ")}${theme.fg(term.thinking.color, term.thinking.label)}`;
	const rows = [frameTop(theme, width, term.heading, term.tone), frameRow(theme, width, status, term.tone)];
	const body = modelBrowserRows(theme, view, Math.max(1, width - 4));
	for (const line of body) rows.push(frameRow(theme, width, line, term.tone));
	rows.push(frameRow(theme, width, theme.style("dim", term.footer), term.tone), frameBottom(theme, width, term.tone));
	const hits: Hit[] = [sheetHit(node, width, rows.length)];
	const top = 2 + MODEL_LIST_TOP;
	view.rows.forEach((row, i) => {
		if (row) hits.push({ row: top + i, col: 0, width, height: 1, node, item: row.selector });
	});
	return { rows, hits };
}

definePickerLook("omp.model-picker", paintModelPicker);
