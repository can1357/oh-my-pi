/**
 * `wait`: the call as `⏳ Wait`; a wait cut short as `ⓘ Wait interrupted by
 * message`; nothing to show as `⚠ Wait` over the reason.
 *
 * A job snapshot while collapsed is a short completion log: one row per
 * settled job (`✘ id failed · exit 2 · 900ms  label`, a failure's first
 * error line under it), then the running jobs whose live widget draws its
 * tile, then `N still running`; with nothing settled yet the head line
 * `ⓘ waiting on 5 jobs` leads. Expanded it is the head line over a tree of
 * every job (status, exit, `⟦type⟧`, id, label, duration, output preview;
 * widgets drawn whole). Agents outside job control follow as their own tree.
 * Spinners turn while the result streams (`term.spinning`).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { shimmerTiers } from "@oh-my-pi/pi-tui/term/painters/shimmer";
import { shimmerText } from "@oh-my-pi/pi-tui/text/shimmer";
import { replaceTabs, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { jobDisplayLabel } from "../../../async/job-label";
import type { AgentActivitySnapshot, JobSnapshot } from "../../../tools/details/wait";
import { formatArtifactErrorNotice, stripOutputNotice } from "../../../tools/output-meta-format";
import { FEED_MODEL_BADGE_WIDTH, isFeedModelBadgeEnabled } from "../../../utils/render-utils";
import { feedModel } from "../../tools/agent-common";
import { jobTile, sortJobs, type WaitTerm, waitTitle } from "../../tools/wait";
import { styledModelBadge } from "./agent-common";
import { spinnerGlyph, statusIcon, statusLine } from "./frame";
import { jobTileRows } from "./jobs/widget";
import { defineToolLook, toolProps } from "./look";

/** Items a collapsed list shows. */
const COLLAPSED_ITEMS = 8;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

const STATUS_ICON = {
	completed: "success",
	failed: "error",
	cancelled: "aborted",
	running: "running",
} as const;
const STATUS_COLOR: Record<JobSnapshot["status"], string> = {
	completed: "success",
	failed: "error",
	cancelled: "warning",
	running: "accent",
};

interface WaitPaint {
	readonly cx: PaintContext;
	readonly theme: Theme;
	readonly width: number;
	readonly expanded: boolean;
	/** Spinners turn (the result still streams). */
	readonly live: boolean;
}

/** A job's status glyph: a running one spins while live, else `⟳`. */
function jobIcon(paint: WaitPaint, status: JobSnapshot["status"], spins: boolean): string {
	if (status === "running")
		return spins ? spinnerGlyph(paint.cx) : paint.theme.fg("accent", paint.theme.symbols.symbol("status.running"));
	return statusIcon(paint.cx, STATUS_ICON[status]);
}

function badge(theme: Theme, label: string, color: string): string {
	return theme.fg(
		color,
		`${theme.symbols.symbol("format.bracketLeft")}${label}${theme.symbols.symbol("format.bracketRight")}`,
	);
}

function sep(theme: Theme): string {
	return theme.symbols.symbol("sep.dot");
}

/** A running task's own stage, else what the job is for, else its label. */
function rowLabel(job: JobSnapshot): string {
	if (job.type === "task" && job.status === "running" && job.stage?.trim()) return job.stage;
	return jobDisplayLabel(job);
}

function oneLine(text: string): string {
	return replaceTabs(text).replace(/\s+/g, " ");
}

/** A task result's inner `<output>`/`<preview>` body instead of its envelope. */
function unwrapTaskResult(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

/** Pretty JSON flattened onto one line so a one-line preview shows more than `{`. */
function flattenStructured(text: string): string {
	if (text[0] !== "{" && text[0] !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

/** A job's output preview rows (its error in the error color). */
function previewRows(paint: WaitPaint, job: JobSnapshot, rootMeta: WaitTermJobs["meta"], width: number): string[] {
	const artifactError = job.meta?.artifactError ?? job.artifactError;
	const previewError = artifactError ?? (rootMeta?.source?.type !== "report" ? rootMeta?.artifactError : undefined);
	const previewMeta = job.meta ?? (previewError ? { artifactError: previewError } : undefined);
	const preview = flattenStructured(
		unwrapTaskResult(stripOutputNotice(job.errorText?.trim() || job.resultText?.trim() || "", previewMeta).trim()),
	);
	if (!preview) return [];
	const lines = preview
		.split("\n")
		.filter(line => line.trim())
		.slice(0, paint.expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED);
	const color = job.errorText ? "error" : "dim";
	return lines.map(line => `  ${paint.theme.fg(color, truncate(line.trim(), Math.min(PREVIEW_LINE_WIDTH, width)))}`);
}

type WaitTermJobs = Extract<WaitTerm, { kind: "jobs" }>;

/** A job's tree item (rows without the branch). */
function jobItem(paint: WaitPaint, job: JobSnapshot, term: WaitTermJobs, rowWidth: number): string[] {
	const { theme, expanded } = paint;
	const rows: string[] = [];
	const running = job.status === "running";
	const live = running && paint.live;
	const exit =
		job.exitCode === undefined
			? ""
			: `${sep(theme)}${theme.fg(job.exitCode === 0 ? "muted" : "error", `exit ${job.exitCode}`)}`;
	const icon = `${jobIcon(paint, job.status, live)}${exit}`;
	const type = badge(theme, job.type, STATUS_COLOR[job.status]);
	const completion =
		running && job.completionPercent !== undefined
			? `${sep(theme)}${theme.fg("accent", `${job.completionPercent}%`)}`
			: "";
	const duration = `${completion}${sep(theme)}${theme.fg("dim", formatDuration(job.durationMs))}`;
	const prefix = `${icon} ${type} `;
	const continuation = Math.max(0, rowWidth - 2);
	if (job.widget?.state === "live") {
		const meta = [
			running && job.completionPercent !== undefined ? theme.fg("accent", `${job.completionPercent}%`) : undefined,
			theme.fg("dim", formatDuration(job.durationMs)),
		]
			.filter(Boolean)
			.join(" ");
		rows.push(...jobTileRows(theme, jobTile(job, live), rowWidth, { lead: prefix, meta, full: expanded }));
	} else {
		const id = truncate(oneLine(job.id), Math.max(0, rowWidth - visibleWidth(`${icon} ${type} ${duration}`)));
		const label = rowLabel(job);
		const labelLines = (label || "(no label)").split(/\r?\n/);
		const maxLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
		const shown = labelLines.slice(0, maxLines).map(line => truncate(replaceTabs(line), LABEL_MAX_WIDTH));
		if (labelLines.length > maxLines && shown.length > 0) shown[shown.length - 1] = `${shown[shown.length - 1]} …`;
		// A live row's id shimmers; a still one reads plain.
		const head = live
			? shimmerText(id, paint.cx.now(true), "classic", shimmerTiers(theme))
			: theme.fg("toolOutput", id);
		// A task's resolved model leads its id (`task.showResolvedModelBadge`), in the room the id and duration leave.
		const model =
			job.type === "task" && isFeedModelBadgeEnabled()
				? feedModel(job.resolvedModelIdentity ?? job.resolvedModel, job.resolvedThinkingLevel, job.advisor)
				: undefined;
		const modelBadge = model
			? styledModelBadge(
					theme,
					model,
					Math.min(FEED_MODEL_BADGE_WIDTH, rowWidth - visibleWidth(`${prefix}${id}${duration}`) - 1),
				)
			: "";
		let row = `${prefix}${modelBadge ? `${modelBadge} ` : ""}${head}`;
		const distinct = label.trim() !== job.id;
		const inline = distinct && visibleWidth(`${row} ${shown[0] ?? ""}${duration}`) <= rowWidth;
		if (inline) row += ` ${theme.fg("toolOutput", shown[0] ?? "")}`;
		row += duration;
		rows.push(truncate(row, rowWidth, ""));
		for (let i = distinct && !inline ? 0 : 1; i < shown.length; i++)
			rows.push(`  ${theme.fg("toolOutput", truncate(shown[i]!, continuation))}`);
	}
	const artifactError = job.meta?.artifactError ?? job.artifactError;
	if (artifactError) rows.push(theme.fg("warning", truncate(formatArtifactErrorNotice(artifactError), rowWidth)));
	rows.push(...previewRows(paint, job, term.meta, continuation));
	return rows;
}

function agentItem(paint: WaitPaint, agent: AgentActivitySnapshot, rowWidth: number): string[] {
	const theme = paint.theme;
	const icon = agent.live ? jobIcon(paint, "running", paint.live) : statusIcon(paint.cx, "warning");
	const tag = agent.live ? badge(theme, "agent", "accent") : badge(theme, "agent · no turn", "warning");
	const id = truncate(oneLine(agent.id), Math.max(0, rowWidth - visibleWidth(`${icon}  ${tag}`)));
	const gist = agent.activity
		? ` ${theme.fg("toolOutput", truncate(replaceTabs(agent.activity), LABEL_MAX_WIDTH))}`
		: "";
	const parent = agent.parentId ? theme.fg("dim", ` ← ${agent.parentId}`) : "";
	const age = theme.fg("dim", formatDuration(agent.ageMs));
	return [truncate(`${icon} ${theme.fg("muted", id)} ${tag}${gist} ${age}${parent}`, rowWidth, "")];
}

/** Items as `├─`/`└─` branches (continuation rows under `│`), at most eight while collapsed then `… N more`. */
function treeRows<T>(
	paint: WaitPaint,
	items: readonly T[],
	noun: string,
	item: (entry: T, rowWidth: number) => string[],
): string[] {
	const theme = paint.theme;
	const shown = paint.expanded ? items : items.slice(0, COLLAPSED_ITEMS);
	const hidden = items.length - shown.length;
	const entries = shown.map(entry => item(entry, Math.max(0, paint.width - 3)));
	if (hidden > 0) entries.push([theme.fg("muted", `… ${hidden} more ${hidden === 1 ? noun : `${noun}s`}`)]);
	const rows: string[] = [];
	entries.forEach((lines, index) => {
		const last = index === entries.length - 1;
		lines.forEach((line, i) => {
			const branch = i === 0 ? (last ? "└─ " : "├─ ") : last ? "   " : "│  ";
			rows.push(`${theme.fg("dim", branch)}${line}`);
		});
	});
	return rows;
}

/** The collapsed completion log. */
function compactRows(paint: WaitPaint, term: WaitTermJobs, sorted: readonly JobSnapshot[]): string[] {
	const { theme, width } = paint;
	const rows: string[] = [];
	const indent = " ".repeat(visibleWidth(statusIcon(paint.cx, "success")) + 1);
	const settled = sorted.filter(job => job.status !== "running");
	const widgetJobs = sorted.filter(job => job.status === "running" && job.widget?.state === "live");
	const running = sorted.length - settled.length;
	const live = running > 0 && paint.live;
	for (const job of settled.slice(0, COLLAPSED_ITEMS)) {
		const icon = jobIcon(paint, job.status, false);
		const word = job.status === "completed" ? "done" : job.status;
		const exit =
			job.exitCode !== undefined && job.exitCode !== 0
				? `${sep(theme)}${theme.fg("error", `exit ${job.exitCode}`)}`
				: "";
		// The outcome is reserved first; a long id gives way.
		const outcome = ` ${theme.fg(STATUS_COLOR[job.status], word)}${exit}${sep(theme)}${theme.fg("dim", formatDuration(job.durationMs))}`;
		const id = truncate(oneLine(job.id), Math.max(1, width - visibleWidth(`${icon} `) - visibleWidth(outcome)));
		let row = `${icon} ${theme.fg("accent", id)}${outcome}`;
		const label = replaceTabs(rowLabel(job).split(/\r?\n/)[0] ?? "").trim();
		const budget = width - visibleWidth(row) - 2;
		if (label && label !== job.id && budget >= 8) row += `  ${theme.fg("muted", truncate(label, budget))}`;
		rows.push(row);
		const reason =
			job.status === "failed"
				? stripOutputNotice(job.errorText ?? "", job.meta)
						.split(/\r?\n/)
						.find(part => part.trim())
						?.trim()
				: undefined;
		if (reason)
			rows.push(`${indent}${theme.fg("error", truncate(replaceTabs(reason), Math.max(1, width - indent.length)))}`);
		const artifactError = job.meta?.artifactError ?? job.artifactError;
		if (artifactError) rows.push(theme.fg("warning", truncate(formatArtifactErrorNotice(artifactError), width)));
	}
	const hiddenSettled = settled.length - COLLAPSED_ITEMS;
	if (hiddenSettled > 0) rows.push(`${indent}${theme.fg("dim", `… ${hiddenSettled} more settled`)}`);
	const shownWidgets = widgetJobs.slice(0, COLLAPSED_ITEMS);
	for (const job of shownWidgets) {
		const meta = [
			job.completionPercent !== undefined ? theme.fg("accent", `${job.completionPercent}%`) : undefined,
			theme.fg("dim", formatDuration(job.durationMs)),
		]
			.filter(Boolean)
			.join(" ");
		const lead = `${jobIcon(paint, "running", live)} ${badge(theme, job.type, STATUS_COLOR[job.status])} `;
		rows.push(...jobTileRows(theme, jobTile(job, live), width, { lead, meta, full: false }));
	}
	const quiet = running - shownWidgets.length;
	if (quiet > 0 && (settled.length > 0 || shownWidgets.length < widgetJobs.length))
		rows.push(`${indent}${theme.fg("dim", `${quiet} still running`)}`);
	return rows;
}

function jobsRows(paint: WaitPaint, term: WaitTermJobs): string[] {
	const { theme, cx } = paint;
	const { jobs, agents } = term;
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;
	const meta: string[] = [];
	if (counts.completed > 0) meta.push(theme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(theme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(theme.fg("warning", `${counts.cancelled} cancelled`));
	if (agents.length > 0 && jobs.length > 0)
		meta.push(theme.fg("accent", `${agents.length} agent${agents.length === 1 ? "" : "s"}`));
	const glyph = statusIcon(
		cx,
		counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success",
	);
	const header = statusLine(theme, { glyph, title: waitTitle(jobs, agents), meta });
	const rootMeta = term.meta;
	// A root capture failure shows only when no row owns it (or the report itself failed).
	const aggregate =
		rootMeta?.artifactError &&
		(rootMeta.source?.type === "report" ||
			!jobs.some(job => (job.meta?.artifactError ?? job.artifactError) === rootMeta.artifactError))
			? rootMeta.artifactError
			: undefined;
	const sorted = sortJobs(jobs);
	const compact = !paint.expanded && jobs.length > 0;
	const items = compact
		? compactRows(paint, term, sorted)
		: treeRows(paint, sorted, "job", (job, rowWidth) => jobItem(paint, job, term, rowWidth));
	const agentRows =
		agents.length === 0
			? []
			: treeRows(paint, agents, "agent", (agent, rowWidth) => agentItem(paint, agent, rowWidth));
	const rows = compact && sorted.some(job => job.status !== "running") ? [] : [header];
	if (aggregate) rows.push(theme.fg("warning", formatArtifactErrorNotice(aggregate)));
	rows.push(...items, ...agentRows);
	return rows.map(row => truncate(row, paint.width));
}

function paintWait(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const theme = cx.theme;
	const term = props.term ?? {};
	const wait = term.wait as WaitTerm | undefined;
	const width = cx.width;
	const line = (glyph: string, meta?: string[]): string =>
		truncate(statusLine(theme, { glyph, title: "Wait", meta }), width);
	if (!wait) return { rows: [line(statusIcon(cx, "pending"))] };
	if (wait.kind === "interrupted") return { rows: [line(statusIcon(cx, "info"), ["interrupted by message"])] };
	if (wait.kind === "empty")
		return {
			rows: [
				line(statusIcon(cx, "warning")),
				truncate(`${statusIcon(cx, "warning")} ${theme.fg("muted", replaceTabs(wait.text))}`, width),
			],
		};
	const paint: WaitPaint = {
		cx,
		theme,
		width,
		expanded: term.expanded === true,
		live: term.spinning === true && !cx.reduceMotion,
	};
	return { rows: jobsRows(paint, wait) };
}

defineToolLook("wait", { paint: paintWait, margin: true, animated: true });
