/**
 * `proc-read`: a status head (`ⓘ Proc web ready · pid 4123 · up 13.2s`),
 * then for a job its row (`⏹ ⟦bash⟧ build-42 Build assets 2.0s`) over its
 * quoted log, for a service the tail of its output, for the table a branch
 * list of jobs, services and agents (8 collapsed, then `… N more
 * processes`). Pending: `⏳ Proc <id>`; failed: `✘ …` over the error.
 * Every row is cut to the width. Reads {@link ProcReadTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { jobLabel, type ProcJob, type ProcReadTerm, safeText } from "../../tools/proc-read";
import { styleReplayedRow } from "../../transcript/pty-replay";
import { bracketed, expandHint, statusIcon } from "./frame";
import { errorDetail } from "./grouped-output";
import { defineToolLook, isExpanded, toolProps } from "./look";
import { treeRows } from "./search";

/** Rows a quoted log or output tail keeps collapsed / expanded. */
const COLLAPSED_LINES = 3;
const EXPANDED_LINES = 12;
/** Table rows kept collapsed. */
const COLLAPSED_ITEMS = 8;
/** Cells of a quoted log line. */
const LINE_WIDTH = 110;

function stateColor(state: string): string {
	return state === "ready" || state === "running" ? "success" : state === "failed" ? "error" : "warning";
}

function badge(theme: Theme, text: string, color: string): string {
	return theme.fg(color, bracketed(theme, text));
}

function jobRow(cx: PaintContext, job: ProcJob): string {
	const theme = cx.theme;
	const icon = statusIcon(
		cx,
		job.status === "cancelled"
			? "aborted"
			: job.status === "failed"
				? "error"
				: job.status === "running"
					? "running"
					: "success",
	);
	const color = job.status === "failed" ? "error" : job.status === "cancelled" ? "warning" : "accent";
	return `${icon} ${badge(theme, job.type, color)} ${theme.fg("toolOutput", safeText(job.id))} ${theme.fg("dim", safeText(jobLabel(job)))} ${theme.fg("dim", formatDuration(job.durationMs))}`;
}

/** A body quoted under a dim rail: its non-blank lines (3 collapsed, 12 expanded), each cut to 110 cells. */
function quoted(theme: Theme, body: string, expanded: boolean, tone: string): string[] {
	if (!body.trim()) return [];
	const prefix = `  ${theme.fg("dim", theme.symbols.symbol("md.quoteBorder"))} `;
	const source = body.split("\n").filter(line => line.trim());
	const shown = source.slice(0, expanded ? EXPANDED_LINES : COLLAPSED_LINES);
	const hidden = source.length - shown.length;
	let cut = false;
	const rows = shown.map(line => {
		const text = safeText(line.trim());
		const clipped = truncate(text, LINE_WIDTH);
		cut ||= clipped !== text;
		return `${prefix}${theme.fg(tone, clipped)}`;
	});
	if (hidden > 0 || cut) {
		const marker = hidden > 0 ? `… +${hidden} more lines` : "…";
		rows.push(`${prefix}${theme.fg("dim", marker)}${expanded ? "" : ` ${expandHint(theme)}`}`);
	}
	return rows;
}

function header(
	cx: PaintContext,
	term: ProcReadTerm,
	glyph: "pending" | "error" | "info",
	meta: readonly string[] = [],
): string {
	const theme = cx.theme;
	const title = term.id ? `Proc ${safeText(term.id)}` : "Proc jobs & services";
	let out = `${statusIcon(cx, glyph)} ${theme.fg("accent", title)}`;
	if (meta.length > 0) out += ` ${meta.join(theme.fg("dim", theme.symbols.symbol("sep.dot")))}`;
	return out;
}

function paintProcRead(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as unknown as ProcReadTerm;
	const theme = cx.theme;
	const expanded = isExpanded(props);
	let rows: string[];
	if (term.phase === "call") rows = [header(cx, term, "pending")];
	else if (term.phase === "error")
		rows = [header(cx, term, "error"), errorDetail(theme, term.error ?? "Process read failed.")];
	else if (term.job)
		rows = [header(cx, term, "info"), jobRow(cx, term.job), ...quoted(theme, term.log ?? "", expanded, "toolOutput")];
	else if (term.service) {
		const meta = [
			theme.fg(stateColor(term.service.state), term.service.state),
			...term.service.facts.map(fact => theme.fg("dim", fact)),
		];
		const output = term.rows ?? [];
		const limit = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
		const visible = output
			.slice(-limit)
			.map(line => `  ${styleReplayedRow(truncate(safeText(line), LINE_WIDTH), "")}`);
		if (output.length > limit) visible.unshift(theme.fg("dim", `  … ${output.length - limit} earlier lines`));
		rows = [header(cx, term, "info", meta), ...visible];
	} else if (term.table) {
		const { jobs, services, agents } = term.table;
		const counts = [`${jobs.length} jobs`, `${services.length} services`];
		if (agents.length) counts.push(`${agents.length} agents`);
		const items = [
			...jobs.map(job => jobRow(cx, job)),
			...services.map(
				service =>
					`${badge(theme, "service", "accent")} ${theme.fg("toolOutput", safeText(service.name))} ${badge(theme, service.state, stateColor(service.state))} ${service.facts.join(theme.symbols.symbol("sep.dot"))}`,
			),
			...agents.map(
				agent =>
					`${badge(theme, "agent", agent.live ? "accent" : "warning")} ${theme.fg("toolOutput", safeText(agent.id))} ${theme.fg("dim", formatDuration(agent.ageMs))}`,
			),
		];
		const shown = expanded ? items : items.slice(0, COLLAPSED_ITEMS);
		const tree = shown.map(item => [item]);
		if (shown.length < items.length)
			tree.push([theme.fg("muted", `… ${items.length - shown.length} more processes`)]);
		rows = [
			header(
				cx,
				term,
				"info",
				counts.map(count => theme.fg("dim", count)),
			),
			...treeRows(theme, tree, Number.POSITIVE_INFINITY),
			...(items.length ? [] : [theme.fg("dim", "No background jobs or services.")]),
		];
	} else rows = [header(cx, term, "info"), ...quoted(theme, term.text ?? "", expanded, "toolOutput")];
	return {
		rows: rows.flatMap(row => row.split("\n")).map(row => truncate(row, cx.width)),
	};
}

defineToolLook("proc-read", { paint: paintProcRead, margin: true });
