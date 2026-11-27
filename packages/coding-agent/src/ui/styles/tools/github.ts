/**
 * The `github` look. A call is one line (`⢿ GitHub Search Issues query`). A
 * result of one line (or none) stays inline under the head; longer output
 * is a card of muted lines (ten collapsed, then `… N more lines`). A run
 * watch is a card listing each run, its jobs (status glyph, name, duration
 * on the right) and, collapsed, the job's current/failed step summary, or,
 * expanded, every step with its status and duration; failed jobs' log tails
 * follow in a `failed logs` section (the last ten lines collapsed, or why
 * the tail is missing on one row).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { GithubState, GithubTerm, GithubTermFailedLog, GithubTermJob } from "../../tools/github";
import { expandHint, type FrameSection, frameBlock, frameInner, isActive, moreLinesHint, spinnerGlyph } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Subject characters a call shows. */
const SUBJECT_CHARS = 80;
/** Output lines a collapsed card shows. */
const COLLAPSED_LINES = 10;

const STATE_TEXT: Readonly<Record<GithubState, string>> = {
	success: "success",
	running: "warning",
	failure: "error",
	pending: "muted",
};

function stateGlyph(theme: Theme, state: GithubState): string {
	switch (state) {
		case "success":
			return theme.fg("success", theme.symbols.symbol("status.success"));
		case "running":
			return theme.fg("accent", theme.symbols.symbol("status.running"));
		case "failure":
			return theme.fg("error", theme.symbols.symbol("status.error"));
		default:
			return theme.fg("muted", theme.symbols.symbol("status.pending"));
	}
}

function jobLines(theme: Theme, job: GithubTermJob, inner: number, expanded: boolean): string[] {
	const tone = STATE_TEXT[job.state];
	const glyph = stateGlyph(theme, job.state);
	let head = `${glyph} ${theme.fg(tone, job.name)}`;
	if (job.duration) {
		const duration = theme.fg(tone, job.duration);
		const gap = inner - visibleWidth(head) - visibleWidth(duration);
		head = gap >= 1 ? `${head}${" ".repeat(gap)}${duration}` : `${head} ${duration}`;
	}
	const lines = [truncate(head, inner)];
	if (!expanded) {
		if (!job.summary) return lines;
		const lead = `  ${theme.fg("dim", "↳")} ${glyph} `;
		const hint = job.steps.length > 1 ? ` ${expandHint(theme)}` : "";
		const room = Math.max(0, inner - visibleWidth(lead) - visibleWidth(hint));
		lines.push(truncate(`${lead}${theme.fg(tone, truncate(job.summary, room))}${hint}`, inner));
		return lines;
	}
	for (const step of job.steps) {
		const stepTone = STATE_TEXT[step.state];
		const lead = `    ${stateGlyph(theme, step.state)} #${step.number} `;
		let tail = `  ${theme.fg(stepTone, step.status)}`;
		if (step.duration) tail += `  ${theme.fg("muted", step.duration)}`;
		const room = Math.max(0, inner - visibleWidth(lead) - visibleWidth(tail));
		lines.push(truncate(`${lead}${theme.fg(stepTone, truncate(step.name, room))}${tail}`, inner));
	}
	return lines;
}

function failedLogLines(
	theme: Theme,
	logs: readonly GithubTermFailedLog[],
	inner: number,
	expanded: boolean,
): string[] {
	const lines: string[] = [];
	const glyph = theme.fg("error", theme.symbols.symbol("status.error"));
	for (const log of logs) {
		lines.push(truncate(`${glyph} ${theme.fg("error", log.jobName)}  ${theme.fg("muted", log.context)}`, inner));
		if (!log.tail) {
			lines.push(theme.fg("dim", truncate(`  ${log.unavailable ?? ""}`, Math.max(8, inner))));
			continue;
		}
		const shown = expanded ? log.tail.length : Math.min(COLLAPSED_LINES, log.tail.length);
		for (const line of log.tail.slice(-shown))
			lines.push(theme.fg("dim", `  ${truncate(line, Math.max(8, inner - 2))}`));
		const hidden = log.tail.length - shown;
		if (hidden > 0) lines.push(`  ${theme.fg("dim", `… ${hidden} more log lines `)}${expandHint(theme)}`);
	}
	return lines;
}

function paintGithub(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as GithubTerm | undefined;
	if (!term) return { rows: [] };
	const theme = cx.theme;
	const expanded = props.collapsed === false;
	const running = props.status === "running";
	const failed = term.error !== undefined;
	const title = theme.fg(failed && !running ? "error" : "accent", term.title);
	if (!term.result) {
		const glyph = isActive(props) ? spinnerGlyph(cx) : theme.fg("muted", theme.symbols.symbol("status.pending"));
		let head = `${glyph} ${title}`;
		if (term.subject)
			head += term.watch
				? `  ${term.branch ? replaceTabs(term.subject) : theme.fg("muted", term.subject)}`
				: ` ${theme.fg("dim", truncate(replaceTabs(term.subject), SUBJECT_CHARS))}`;
		const rows = wrap(head, cx.width);
		if (term.watch) rows.push(...wrap(theme.fg("dim", term.waitText ?? "waiting for workflow data..."), cx.width));
		return { rows };
	}
	const glyph =
		running && term.runs
			? spinnerGlyph(cx)
			: failed
				? theme.fg("error", theme.symbols.symbol("status.error"))
				: props.tone === "warning"
					? theme.fg("warning", theme.symbols.symbol("status.warning"))
					: theme.fg("accent", theme.symbols.symbol(term.icon ?? "tool.gh"));
	const inner = frameInner(cx.width);
	const border = failed ? "error" : "borderMuted";
	const head = `${glyph} ${title}${term.subject ? ` ${theme.fg("dim", replaceTabs(term.subject))}` : ""}`;
	if (term.runs) {
		const lines: string[] = [];
		for (const run of term.runs) {
			lines.push(truncate(`${theme.fg("accent", run.name)}  ${theme.fg("muted", `#${run.id}`)}`, inner));
			for (const job of run.jobs) lines.push(...jobLines(theme, job, inner, expanded));
		}
		const sections: FrameSection[] = [{ lines }];
		if (term.failedLogs?.length)
			sections.push({ label: "failed logs", lines: failedLogLines(theme, term.failedLogs, inner, expanded) });
		return frameBlock(theme, cx.width, { head, sections, border });
	}
	const lines = term.lines ?? [];
	if (lines.length <= 1 && !term.subject) {
		const rows = wrap(`${glyph} ${title}`, cx.width);
		const line =
			lines[0] !== undefined ? theme.fg("muted", replaceTabs(lines[0])) : theme.fg("dim", term.empty ?? "");
		rows.push(...wrap(line, cx.width));
		return { rows };
	}
	const color = failed ? "error" : "muted";
	const hidden = expanded ? 0 : Math.max(0, lines.length - COLLAPSED_LINES);
	const body = lines.slice(0, lines.length - hidden).map(line => truncate(theme.fg(color, replaceTabs(line)), inner));
	if (hidden > 0) body.push(moreLinesHint(theme, hidden));
	return frameBlock(theme, cx.width, {
		head,
		sections: [{ lines: body.length > 0 ? body : [theme.fg("dim", term.empty ?? "")] }],
		border,
	});
}

defineToolLook("github", { paint: paintGithub, margin: true });
