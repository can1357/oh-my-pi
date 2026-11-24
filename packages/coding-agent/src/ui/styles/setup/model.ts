/**
 * Terminal look of the setup model scene (`term.role` `omp.setup.model`):
 * the status line (search hint, discovery, saving, the last error), a blank
 * row, then the model browser (search, list, detail rows) cut to the rows
 * the wizard gives the scene. The browser is drawn from its state (the
 * picker's `term.browser`).
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, pickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ModelBrowserState, ModelBrowserView } from "../../overlays/pickers/model-browser-state";
import { modelBrowserRows } from "../pickers/model-browser";

/** Terminal facts of the scene body. */
export type ModelSceneTerm = {
	readonly role: "omp.setup.model";
	/** The status line over the browser. */
	readonly head: string;
	/** The status line reports a failure. */
	readonly error?: boolean;
	readonly maxLines?: number;
};

/** Rows of the browser around its list: search, blank, blank, two detail rows. */
const BROWSER_CHROME_ROWS = 5;

/** `view` with its list window cut to `rows` rows, still showing the selection. */
function fitWindow(view: ModelBrowserView, rows: number): ModelBrowserView {
	if (rows >= view.maxVisible) return view;
	const lead = view.selected < 0 ? 0 : Math.max(0, view.selected - view.start - rows + 1);
	const start = view.start + lead;
	return { ...view, rows: view.rows.slice(lead, lead + rows), start, maxVisible: rows };
}

defineRolePainter("col", "omp.setup.model", (node, cx): Block => {
	const term = (node.props() as { term?: ModelSceneTerm }).term;
	const picker = node.children()[0];
	if (!term || !picker) return { rows: [] };
	const head = wrap(cx.theme.fg(term.error ? "error" : "muted", term.head), cx.width).map(row => padTo(row, cx.width));
	const browser = (pickerTerm(picker) as { browser?: ModelBrowserState }).browser;
	if (!browser) return { rows: head };
	let view = browser.view(key => cx.theme.symbols.symbol(key));
	// The list gets what the status line (as wrapped here) and the browser's chrome leave.
	if (term.maxLines !== undefined)
		view = fitWindow(view, Math.max(1, term.maxLines - head.length - 1 - BROWSER_CHROME_ROWS));
	const browserRows = modelBrowserRows(cx.theme, view, cx.width);
	// The search row fills the width (the field it stands for does).
	if (browserRows[0] !== undefined) browserRows[0] = padTo(browserRows[0], cx.width);
	const rows = [...head, "", ...browserRows];
	if (term.maxLines === undefined) return { rows };
	// A cut right under the status line drops the blank row that separated it from the browser.
	const max = Math.max(0, term.maxLines);
	return { rows: rows.slice(0, max === head.length + 1 ? head.length : max) };
});

/** The picker is drawn by the scene body (above); on its own it draws the browser. */
definePickerLook("omp.setup.model", (node, cx): Block => {
	const browser = (pickerTerm(node) as { browser?: ModelBrowserState }).browser;
	if (!browser) return { rows: [] };
	return {
		rows: modelBrowserRows(
			cx.theme,
			browser.view(key => cx.theme.symbols.symbol(key)),
			cx.width,
		),
	};
});
