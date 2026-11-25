/**
 * The `autoresearch` look (init/log/run_experiment, update_notes): a call is
 * its header (`log_experiment keep faster parse`, the argument cut to 100
 * characters); a run is `PASS 3.2s ms=12.50ms` in its tone over the output's
 * tail (five lines collapsed, all plus the full-output path expanded); a
 * running benchmark `Running 3s...`; a logged experiment one paragraph of
 * status, description and metrics. Other results paint their text.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { AutoresearchTerm } from "../../tools/autoresearch";
import { defineToolLook, toolProps } from "./look";

/** Characters of a header argument shown. */
const ARG_CHARS = 100;
/** Output lines a collapsed run shows (its tail). */
const COLLAPSED_TAIL = 5;

function outputRows(cx: PaintContext, output: string, tail?: number): string[] {
	const lines = output.split("\n");
	const shown = tail !== undefined && lines.length > tail ? lines.slice(-tail) : lines;
	return shown.flatMap(line => wrap(cx.theme.fg("dim", replaceTabs(line)), cx.width));
}

function paintAutoresearch(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as AutoresearchTerm | undefined;
	const theme = cx.theme;
	const rows: string[] = [];
	if (term?.head) {
		let head = "";
		term.head.forEach((span, i) => {
			const text = i === term.head!.length - 1 && i > 0 ? truncate(span.t, ARG_CHARS) : span.t;
			head += span.s ? theme.style(span.s, text) : text;
		});
		rows.push(...wrap(head, cx.width));
	}
	if (term?.run) {
		const run = term.run;
		rows.push(...wrap(theme.style(run.tone, `${run.status}${run.facts ? ` ${run.facts}` : ""}`), cx.width));
		const expanded = props.collapsed === false;
		if (run.output) rows.push(...outputRows(cx, run.output, expanded ? undefined : COLLAPSED_TAIL));
		if (expanded && run.fullOutputPath)
			rows.push(...wrap(theme.fg("warning", `Full output: ${run.fullOutputPath}`), cx.width));
		return { rows };
	}
	if (term?.running) {
		rows.push(...wrap(theme.fg("warning", `Running ${term.running.elapsed}...`), cx.width));
		if (term.running.output) rows.push(...outputRows(cx, term.running.output));
		return { rows };
	}
	if (term?.logged) {
		const logged = term.logged;
		let text = `${theme.style(logged.tone, logged.status)} ${theme.fg("muted", truncate(logged.description, ARG_CHARS))}`;
		if (logged.metric) text += ` ${theme.fg("accent", logged.metric)}`;
		if (logged.baseline) text += ` ${theme.fg("dim", `baseline ${logged.baseline}`)}`;
		if (logged.confidence) text += ` ${theme.fg("dim", `conf ${logged.confidence}`)}`;
		if (logged.deviations) text += ` ${theme.fg("warning", `deviations:${logged.deviations}`)}`;
		rows.push(...wrap(text, cx.width));
		return { rows };
	}
	for (const child of node.children()) rows.push(...cx.paint(child, cx.width).rows);
	return { rows };
}

const look = { paint: paintAutoresearch, margin: true };
defineToolLook("autoresearch", look);
// Results without a view (an empty init) still paint through this look.
for (const tool of ["init_experiment", "log_experiment", "run_experiment", "update_notes"]) defineToolLook(tool, look);
