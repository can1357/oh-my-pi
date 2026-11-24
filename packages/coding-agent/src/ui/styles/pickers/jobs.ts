/**
 * The jobs sheet in the terminal (`term.role = "omp.jobs.sheet"`): a heading
 * with the running count, one plain row per job (`>` marks the selected one,
 * `└─` its nesting), then the selected job's caption or command, its facts on
 * one line, its widget and the tail of the output it shows.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { JobWidgetView } from "../../../tools/details/job-widget";
import { jobWidgetRows } from "../tools/jobs/widget";
import { termOf } from "../panels/common";

/** One job row. */
export interface JobsTermRow {
	readonly status: string;
	readonly type: string;
	/** Formatted run time. */
	readonly age: string;
	readonly label: string;
	readonly depth: number;
}

/** The selected job's facts. */
export interface JobsTermDetail {
	/** A task's caption (shown instead of a command). */
	readonly caption?: string;
	readonly command?: string;
	/** `cwd … · pid … · exit … · local://….log`. */
	readonly facts: string;
	readonly widget?: JobWidgetView;
	/** The shown output's text. */
	readonly output?: string;
}

/** The sheet's term facts. */
export type JobsSheetTerm = {
	readonly role: "omp.jobs.sheet";
	readonly running: number;
	readonly rows: readonly JobsTermRow[];
	/** Index of the selected row (-1: none). */
	readonly selected: number;
	readonly detail?: JobsTermDetail;
};

/** Command lines shown before the count of the rest. */
const COMMAND_LINES = 12;
/** Output lines shown from its end. */
const OUTPUT_TAIL_LINES = 8;
/** Detail rows are indented under the list. */
const DETAIL_INDENT = "   ";
/** The widget never draws wider. */
const WIDGET_MAX_WIDTH = 80;

defineRolePainter("col", "omp.jobs.sheet", (node, cx): Block => {
	const term = termOf<JobsSheetTerm>(node);
	const width = cx.width;
	const theme = cx.theme;
	const rows = [truncate(` Background jobs · ${term.running ?? 0} running`, width)];
	const jobs = term.rows ?? [];
	if (jobs.length === 0) {
		rows.push(truncate(" No background jobs", width));
		return { rows };
	}
	jobs.forEach((job, index) => {
		const marker = index === term.selected ? "> " : "  ";
		const nest = job.depth > 0 ? `${"   ".repeat(job.depth - 1)}└─ ` : "";
		rows.push(truncate(`${marker}${nest}${job.status}  ${job.type} ${job.age}  ${job.label}`, width));
	});
	const detail = term.detail;
	if (!detail) return { rows };
	const inner = Math.max(1, width - DETAIL_INDENT.length);
	const indent = (line: string): string => truncate(`${DETAIL_INDENT}${line}`, width);
	if (detail.caption) for (const line of wrap(detail.caption, inner)) rows.push(indent(theme.fg("muted", line)));
	else if (detail.command !== undefined) {
		const lines = replaceTabs(detail.command).split("\n");
		for (const line of lines.slice(0, COMMAND_LINES)) rows.push(indent(line));
		if (lines.length > COMMAND_LINES) rows.push(indent(`… ${lines.length - COMMAND_LINES} more command lines`));
	}
	if (detail.facts) rows.push(indent(detail.facts));
	if (detail.widget)
		for (const line of jobWidgetRows(theme, detail.widget, Math.min(inner, WIDGET_MAX_WIDTH)))
			rows.push(indent(line));
	const output = (detail.output ?? "").replace(/\n+$/, "");
	if (output) for (const line of output.split("\n").slice(-OUTPUT_TAIL_LINES)) rows.push(indent(replaceTabs(line)));
	return { rows };
});
