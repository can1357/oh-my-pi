/**
 * Rewind's terminal look (the `omp.rewind.bar` row): the transcript
 * selectors' screen (`./transcript-view`) headed `↶ Rewind · pick the point
 * to continue from`, the outlined turn boxed in the accent, then the counter
 * and key hints (after the filter field while filtering).
 *
 * A turn with sibling branches splits the rest of the branch into columns,
 * one per branch (the current path first) under a `⑂ n/m · label` head; the
 * column ←/→ moved into has the accent head.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { expandKeyLabel, keyLabel } from "../../keys/hints";
import { bindingGlyph, selectNavGlyphs, termOf } from "../panels/common";
import { caretField } from "./common";
import { type Lane, type LaneItem, laneRows, transcriptScreen } from "./transcript-view";

/** One branch of a fork, drawn as a column. */
export type RewindLookColumn = {
	/** What the head names the branch by (`current` for the current path). */
	readonly label: string;
	/** The column ←/→ moved into. */
	readonly active: boolean;
	readonly turns: readonly LaneItem[];
};

/** The look's term facts. */
export type RewindLookTerm = {
	/** Turns drawn across the whole width. */
	readonly turns: readonly LaneItem[];
	/** Branches diverging after `turns`, side by side; none when the outlined turn has no siblings. */
	readonly columns: readonly RewindLookColumn[];
	/** Shown instead of the turns (a filter matching nothing). */
	readonly empty?: string;
	readonly counter: { readonly t: string; readonly s: string };
	readonly filter?: { readonly text: string; readonly cursor: number };
	/** What ←/→ move between: user turns, or a fork's branches. */
	readonly sideLabel: string;
	/** Screen rows when the layer allots no height. */
	readonly rows?: number;
};

/** Cells between branch columns. */
const COLUMN_GAP = 2;
/** Narrowest branch column. */
const MIN_COLUMN = 24;

/** Branch columns in `width` cells: a head row per column, a blank row, then the columns side by side. */
function forkRows(cx: PaintContext, columns: readonly RewindLookColumn[], width: number): Lane {
	const theme = cx.theme;
	const count = columns.length;
	const column = Math.max(MIN_COLUMN, Math.floor((width - 1 - COLUMN_GAP * (count - 1)) / count));
	const gap = " ".repeat(COLUMN_GAP);
	const join = (cells: readonly string[]): string => cells.map(cell => truncate(cell, column, "", true)).join(gap);
	const heads = columns.map(
		(branch, index) =>
			` ${theme.style(branch.active ? "accent" : "dim", `${theme.symbols.icon("branch")} ${index + 1}/${count}${theme.symbols.symbol("sep.dot")}${branch.label}`)}`,
	);
	const rows = [join(heads), join(columns.map(() => ""))];
	const lanes = columns.map(branch => laneRows(cx, branch.turns, column, "accent"));
	const height = Math.max(0, ...lanes.map(lane => lane.rows.length));
	for (let row = 0; row < height; row++) rows.push(join(lanes.map(lane => lane.rows[row] ?? "")));
	const active = lanes[columns.findIndex(branch => branch.active)]?.outline;
	return { rows, outline: active && [active[0] + 2, active[1] + 2] };
}

function paintRewind(node: UiNode, cx: PaintContext): Block {
	const term = termOf<RewindLookTerm>(node);
	const theme = cx.theme;
	const width = cx.width;
	if (!term.turns || !term.columns || !term.counter || !term.sideLabel || width < 8) return { rows: [] };
	const counter = theme.style(term.counter.s, term.counter.t);
	const steps = `${selectNavGlyphs(theme)} step  ${keyLabel(theme, "left")}/${keyLabel(theme, "right")} ${term.sideLabel}`;
	const rewind = `${keyLabel(theme, "enter")} rewind`;
	const cancel = bindingGlyph("tui.select.cancel", "escape", theme);
	const hints = term.filter
		? `${steps}  ${rewind}  ${cancel} show all`
		: `${steps}  ${keyLabel(theme, "f")} filter  ${rewind}  ${expandKeyLabel(theme)} expand  ${cancel} cancel`;
	const status = `${counter}  ${theme.style("dim", hints)}`;
	const footer = term.filter
		? `${caretField(theme, ` ${theme.style("accent", "filter:")} `, term.filter.text, term.filter.cursor, width)}  ${status}`
		: ` ${status}`;

	let body: Lane;
	if (term.empty !== undefined) body = { rows: [theme.style("muted", `  ${term.empty}`)] };
	else {
		const lane = laneRows(cx, term.turns, width - 1, "accent");
		const fork = term.columns.length > 0 ? forkRows(cx, term.columns, width - 1) : undefined;
		const offset = lane.rows.length;
		body = {
			rows: fork ? [...lane.rows, ...fork.rows] : lane.rows,
			outline: lane.outline ?? (fork?.outline && [fork.outline[0] + offset, fork.outline[1] + offset]),
		};
	}
	const head = ` ${theme.symbols.icon("rewind")} ${theme.style("strong", "Rewind")}${theme.symbols.symbol("sep.dot")}${theme.style("dim", "pick the point to continue from")}`;
	return transcriptScreen(node, cx, { head, body, footer, rows: term.rows });
}

defineRolePainter("row", "omp.rewind.bar", paintRewind);
