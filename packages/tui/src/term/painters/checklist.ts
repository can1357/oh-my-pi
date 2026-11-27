/**
 * `checklist`: a phased todo list.
 *
 * - `full`: each phase as `I. Foundation  1/3` (accent, bold; numbered only
 *   when there are several phases) over its items on `├─`/`└─` branches
 *   (indented under the phase title); a folded phase is its dim title row.
 *   An item is its box and text in the status color: done `☑` struck
 *   (success), active `☐` (accent), dropped `☐` struck (error), blocked
 *   `☐` (warning), pending `☐` (dim); a note hangs under it. Long items wrap
 *   beneath their text, the branch guide continuing.
 * - `hud`: one row, `☑ 4/13` and the active item.
 * - `reminder`: the open items, each on a row, after the note.
 */
import type { TspChecklistItem, TspChecklistPhase, TspChecklistProps, TspSpan } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { truncate, visibleWidth, wrap } from "../../text/width";
import { definePainter, EMPTY_BLOCK } from "../paint";
import { styledText } from "./layout";

const ROMAN: readonly [number, string][] = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** `n` (1-based) as a roman numeral. */
export function romanNumeral(n: number): string {
	let out = "";
	let rest = n;
	for (const [value, symbol] of ROMAN) {
		while (rest >= value) {
			out += symbol;
			rest -= value;
		}
	}
	return out;
}

/** Whether an item counts as closed (done or dropped). */
export function isClosedItem(item: TspChecklistItem): boolean {
	return item.status === "done" || item.status === "dropped";
}

/** `  closed/total`, dim. */
export function phaseProgress(theme: Theme, phase: TspChecklistPhase): string {
	return theme.fg("dim", `  ${phase.items.filter(isClosedItem).length}/${phase.items.length}`);
}

/** A phase's title row: `I. Name  1/3`, accent bold (dim bold when folded). */
export function phaseTitleRow(
	theme: Theme,
	phase: TspChecklistPhase,
	index: number | undefined,
	folded: boolean,
): string {
	const name = `${index === undefined ? "" : `${romanNumeral(index + 1)}. `}${styledText(theme, phase.title)}`;
	return `${theme.fg(folded ? "dim" : "accent", theme.style("strong", name))}${phaseProgress(theme, phase)}`;
}

const STATUS_COLOR: Record<TspChecklistItem["status"], string> = {
	done: "success",
	active: "accent",
	dropped: "error",
	blocked: "warning",
	pending: "dim",
};

/**
 * An item's box and text in its status color. `struck` is how many leading
 * characters of a done item carry the strike (all when undefined).
 */
export function checklistItemText(theme: Theme, item: TspChecklistItem, struck?: number): string {
	const box = theme.symbols.symbol(item.status === "done" ? "checkbox.checked" : "checkbox.unchecked");
	const text = styledText(theme, item.text);
	let content = text;
	if (item.status === "dropped") content = theme.style("strike", text);
	else if (item.status === "done") {
		const chars = [...text];
		const count = struck === undefined ? chars.length : Math.min(struck, chars.length);
		content =
			count <= 0 ? text : `${theme.style("strike", chars.slice(0, count).join(""))}${chars.slice(count).join("")}`;
	}
	return theme.fg(STATUS_COLOR[item.status], `${box} ${content}`);
}

/**
 * `line` (a tree row: guides, a dim branch, a space, then content) wrapped to
 * `width`, continuation rows hanging under the content behind the guide.
 */
export function wrapBranchRow(theme: Theme, guides: string, branch: string, content: string, width: number): string[] {
	const tree = theme.symbols;
	const lead = `${guides}${theme.fg("dim", branch)} `;
	const leadWidth = visibleWidth(lead);
	const guide =
		branch === tree.symbol("tree.last")
			? " ".repeat(visibleWidth(branch))
			: `${theme.fg("dim", tree.symbol("tree.vertical"))}${" ".repeat(Math.max(0, visibleWidth(branch) - 1))}`;
	if (width <= leadWidth) return wrap(`${lead}${content}`, width);
	return wrap(content, width - leadWidth).map((row, index) => `${index === 0 ? lead : `${guides}${guide} `}${row}`);
}

/** Item rows of a phase on branches, the last on `└─`. */
export function branchRows(theme: Theme, lines: readonly string[], guides: string, width: number): string[] {
	const rows: string[] = [];
	lines.forEach((line, index) => {
		const branch = theme.symbols.symbol(index === lines.length - 1 ? "tree.last" : "tree.branch");
		rows.push(...wrapBranchRow(theme, guides, branch, line, width));
	});
	return rows;
}

function itemLines(theme: Theme, item: TspChecklistItem): string[] {
	const lines = [checklistItemText(theme, item)];
	if (item.note !== undefined)
		lines.push(theme.fg(item.status === "blocked" ? "warning" : "muted", `  ${styledText(theme, item.note)}`));
	return lines;
}

function fullRows(theme: Theme, phases: readonly TspChecklistPhase[], width: number): string[] {
	const multi = phases.length > 1;
	const rows: string[] = [];
	phases.forEach((phase, index) => {
		if (multi) rows.push(...wrap(phaseTitleRow(theme, phase, index, phase.collapsed === true), width));
		if (multi && phase.collapsed) return;
		rows.push(
			...branchRows(
				theme,
				phase.items.flatMap(item => itemLines(theme, item)),
				multi ? "  " : "",
				width,
			),
		);
	});
	return rows;
}

function hudRow(theme: Theme, phases: readonly TspChecklistPhase[], width: number): string {
	const items = phases.flatMap(phase => phase.items);
	const closed = items.filter(isClosedItem).length;
	const active = items.find(item => item.status === "active");
	let row = `${theme.fg("accent", theme.symbols.symbol("checkbox.checked"))} ${theme.fg("dim", `${closed}/${items.length}`)}`;
	if (active) row += ` ${theme.fg("accent", styledText(theme, active.text))}`;
	return truncate(row, width);
}

function reminderRows(theme: Theme, props: TspChecklistProps, width: number): string[] {
	const rows: string[] = [];
	if (props.note !== undefined)
		rows.push(...wrap(theme.fg("warning", styledText(theme, props.note as TspSpan[] | string)), width));
	const open = props.phases.flatMap(phase => phase.items).filter(item => !isClosedItem(item));
	rows.push(
		...branchRows(
			theme,
			open.map(item => checklistItemText(theme, item)),
			"",
			width,
		),
	);
	return rows;
}

definePainter("checklist", (node, cx) => {
	const props = node.props() as TspChecklistProps;
	const phases = (props.phases ?? []).filter(phase => phase.items.length > 0);
	if (cx.width <= 0 || phases.length === 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	switch (props.mode) {
		case "hud":
			return { rows: [hudRow(theme, phases, cx.width)] };
		case "reminder":
			return { rows: reminderRows(theme, props, cx.width) };
		default:
			return { rows: fullRows(theme, phases, cx.width) };
	}
});
