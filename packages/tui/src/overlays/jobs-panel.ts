/**
 * The async background jobs of a session as {@link JobsSheet}: the dismissable
 * sheet the native jobs pill and `/jobs` open. A master–detail split lists
 * every job (running first) beside the selected one's status, command, facts
 * (cwd, live pids, exit code, artifact) and live output.
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Component } from "../tui";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { truncateToWidth } from "../utils";
import { collapseCommand } from "../apps/ps-data";
import { ansi, code, col, compact, item, node, row, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";

/** One async job as the session snapshots it. */
export interface JobsPanelJob {
	readonly id: string;
	readonly type: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	readonly startTime: number;
	readonly endTime?: number;
	/** Registry id of the subagent a task job runs. */
	readonly agentId?: string;
}

/** Running and recently settled jobs. */
export interface JobsPanelSnapshot {
	readonly running: readonly JobsPanelJob[];
	readonly recent: readonly JobsPanelJob[];
}

/** What the sheet shows about the selected job beyond its row. */
export interface JobsPanelDetail {
	/** Full command line of a job that runs a process (rows show the cut label). */
	readonly command?: string;
	readonly cwd?: string;
	/** Live pids the job's command spawned. */
	readonly pids: readonly number[];
	readonly exitCode?: number;
	/** Output tail while running; the final text once settled. */
	readonly output?: string;
	/** Artifact holding the full output when `output` is cut. */
	readonly artifactId?: string;
}

/** The session behind a {@link JobsSheet}. */
export interface JobsSheetSource {
	/** Current jobs; runs once per frame. */
	load(): JobsPanelSnapshot;
	/** The selected job's detail; runs once per frame, undefined once the job is gone. */
	inspect(id: string): JobsPanelDetail | undefined;
	/** Cancel a running job. */
	cancel(id: string): void;
	/** Dismiss the sheet. */
	close(): void;
}

/** A job's status as the sheet names it. */
const STATUS_LABEL: Record<JobsPanelJob["status"], string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

/** A job's status color: the list row's icon and the detail's status pill. */
const STATUS_TONE: Record<JobsPanelJob["status"], TspTone> = {
	running: "pending",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

/** The status pill's lead glyph; a running job's pulses. */
const STATUS_GLYPH: Record<JobsPanelJob["status"], TspSpan> = {
	running: { t: "●", fx: "pulse" },
	completed: { t: "✓" },
	failed: { t: "✕" },
	cancelled: { t: "⊘" },
};

/** The list row's icon per job type (Tern icon names); other types read as a generic job. */
const TYPE_ICON: Record<string, string> = { bash: "bash", task: "agent" };

/** Output tail rows the terminal fallback shows under the selected job. */
const FALLBACK_TAIL_LINES = 8;

/**
 * The jobs pill's sheet: a centred `lg` glass sheet titled Background jobs.
 * A master–detail split (it stacks in a narrow pane): the selectable job list,
 * grouped Running / Recent, beside the selected job's detail — a status pill
 * with live elapsed and Cancel job, its command or task, facts (agent, cwd,
 * live pids, exit code, artifact) and a tail-following output pane. With no
 * jobs it shows an empty state. It re-reads the session every frame, so the
 * caller re-renders it on a timer while it is open. ↑/↓ select, X cancels the
 * selected running job, Esc or Close dismisses; nothing enters the transcript.
 */
export class JobsSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.jobs",
		size: "lg",
		anchor: "center",
		head: "Background jobs",
	} as const;
	readonly #source: JobsSheetSource;
	#selectedId: string | undefined;
	#native: { key: string; output: string | undefined; node: NativeNode } | undefined;
	/** Fallback output tail, reused while the selected job's output is unchanged. */
	#tail: { id: string; output: string; lines: readonly string[] } | undefined;

	constructor(source: JobsSheetSource) {
		this.#source = source;
	}

	describe(_cx: DescribeContext): NativeNode {
		const { jobs, selected } = this.#current();
		const detail = selected && this.#source.inspect(selected.id);
		const now = Date.now();
		// Elapsed nodes tick on their own; list values and the output pane redraw
		// when a job starts, settles or leaves, its process changes, its output
		// grows, or (while one runs) once a second.
		const key = [
			jobs.map(job => `${job.id}:${job.status}`).join(","),
			selected?.id,
			detail?.pids.join(" "),
			detail?.exitCode,
			detail?.artifactId,
			jobs.some(job => job.status === "running") ? Math.floor(now / 1000) : "",
		].join("|");
		const output = detail?.output;
		if (this.#native?.key === key && this.#native.output === output) return this.#native.node;
		const close = actionButton("Close", "close", { keys: "escape" });
		const described = selected
			? col([
					node(
						"row",
						{ role: "omp.jobs.split" },
						[
							node("col", { role: "omp.jobs.master" }, [describeJobList(jobs, selected, now)], "master"),
							describeDetail(selected, detail, now),
						],
						"split",
					),
					actionBar([describeSummary(jobs), null, close]),
				])
			: col([describeEmpty(), actionBar([null, close])]);
		this.#native = { key, output, node: described };
		return described;
	}

	/** Rows for a terminal without the native surface: one per job, then the selected job's facts and output tail. */
	render(width: number): readonly string[] {
		const { jobs, selected } = this.#current();
		const now = Date.now();
		const running = jobs.filter(job => job.status === "running").length;
		const lines = [truncateToWidth(` Background jobs · ${running} running`, width)];
		if (jobs.length === 0) lines.push(" No background jobs");
		for (const job of jobs) {
			const cursor = job === selected ? ">" : " ";
			const age = formatDuration(jobAge(job, now));
			lines.push(
				truncateToWidth(`${cursor} ${job.status}  ${job.type} ${age}  ${collapseCommand(job.label)}`, width),
			);
		}
		const detail = selected && this.#source.inspect(selected.id);
		if (detail) {
			const facts = compact([
				detail.cwd && `cwd ${detail.cwd}`,
				detail.pids.length > 0 && `pid ${detail.pids.join(", ")}`,
				detail.exitCode !== undefined && `exit ${detail.exitCode}`,
				detail.artifactId && `artifact://${detail.artifactId}`,
			]);
			if (facts.length > 0) lines.push(truncateToWidth(`   ${facts.join(" · ")}`, width));
			for (const line of this.#tailLines(selected.id, detail.output ?? "")) {
				if (line) lines.push(truncateToWidth(`   ${line}`, width));
			}
		}
		return lines;
	}

	invalidate(): void {
		this.#native = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#source.close();
		else if (matchesSelectUp(data)) this.#move(-1);
		else if (matchesSelectDown(data)) this.#move(1);
		else if (matchesKey(data, "x")) this.#cancelSelected();
	}

	/** Clicks select a row; Close and Cancel job run what Esc and X run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") this.#selectedId = event.item;
		else if (event.type === "action" && event.act === "close") this.#source.close();
		else if (event.type === "action" && event.act === "cancel") this.#cancelSelected();
	}

	/** Every job, running first, and the selected one (the first when the selection left). */
	#current(): { jobs: readonly JobsPanelJob[]; selected: JobsPanelJob | undefined } {
		const { running, recent } = this.#source.load();
		const jobs = [...running, ...recent];
		const selected = jobs.find(job => job.id === this.#selectedId) ?? jobs[0];
		this.#selectedId = selected?.id;
		return { jobs, selected };
	}

	#tailLines(id: string, output: string): readonly string[] {
		const cached = this.#tail;
		if (cached?.id === id && cached.output === output) return cached.lines;
		const lines = tailLines(output, FALLBACK_TAIL_LINES);
		this.#tail = { id, output, lines };
		return lines;
	}

	#move(delta: number): void {
		const { jobs, selected } = this.#current();
		if (!selected) return;
		const index = Math.max(0, Math.min(jobs.length - 1, jobs.indexOf(selected) + delta));
		this.#selectedId = jobs[index]?.id;
	}

	#cancelSelected(): void {
		const { selected } = this.#current();
		if (selected?.status === "running") this.#source.cancel(selected.id);
	}
}

/** How long a job ran, or has been running. */
function jobAge(job: JobsPanelJob, nowMs: number): number {
	return Math.max(0, (job.endTime ?? nowMs) - job.startTime);
}

/**
 * The last `count` pieces of `text.trimEnd().split("\n")`, found by scanning
 * back from the end so a long running output is never split as a whole.
 */
function tailLines(text: string, count: number): string[] {
	const trimmed = text.trimEnd();
	const lines: string[] = [];
	let end = trimmed.length;
	while (lines.length < count) {
		const newline = end > 0 ? trimmed.lastIndexOf("\n", end - 1) : -1;
		lines.push(trimmed.slice(newline + 1, end));
		if (newline < 0) break;
		end = newline;
	}
	return lines.reverse();
}

/**
 * The master list: Running, then Recent, each under a quiet group label (a
 * plain text child: no row behavior, so ↑/↓ and clicks pass it by).
 */
function describeJobList(jobs: readonly JobsPanelJob[], selected: JobsPanelJob, nowMs: number): NativeNode {
	const rows: NativeChild[] = [];
	for (const [label, group] of [
		["Running", jobs.filter(job => job.status === "running")],
		["Recent", jobs.filter(job => job.status !== "running")],
	] as const) {
		if (group.length === 0) continue;
		rows.push(node("text", { role: "omp.jobs.group", text: label, wrap: "none" }, undefined, `group-${label}`));
		for (const job of group) rows.push(describeJobItem(job, nowMs));
	}
	return selectList("jobs", rows, { selected: selected.id, max: { lines: 12 } });
}

/**
 * One list row: the type icon tinted by status, the one-line label (a process
 * job's command in mono, a task's work in prose) and how long it ran.
 */
function describeJobItem(job: JobsPanelJob, nowMs: number): NativeNode {
	const status = STATUS_LABEL[job.status];
	const age = formatDuration(jobAge(job, nowMs));
	return item(job.id, {
		label: [job.type === "task" ? span(job.label) : span(collapseCommand(job.label), "mono")],
		value: [span(age, "mono")],
		icon: TYPE_ICON[job.type] ?? "job",
		tone: STATUS_TONE[job.status],
		title: `${job.label}\n${status} · ${job.type} · ${job.id}`,
		aria: `${job.label}, ${status.toLowerCase()}, ${age}`,
	});
}

/** The footer's at-a-glance count. */
function describeSummary(jobs: readonly JobsPanelJob[]): NativeNode {
	const running = jobs.filter(job => job.status === "running").length;
	const parts = compact([
		running > 0 && `${running} running`,
		jobs.length > running && `${jobs.length - running} recent`,
	]);
	return node("text", { role: "omp.jobs.summary", text: parts.join(" · "), wrap: "none" }, undefined, "summary");
}

/** No jobs: what the sheet is for, in place of the split. */
function describeEmpty(): NativeNode {
	return node(
		"col",
		{ role: "omp.jobs.empty", align: "center" },
		[
			node("icon", { name: "jobs" }),
			text("No background jobs", { role: "omp.jobs.empty.title" }),
			text("Commands and subagent tasks started in the background show up here while they run.", {
				role: "omp.jobs.empty.note",
				wrap: "word",
			}),
		],
		"empty",
	);
}

/**
 * The selected job: a status line (pill, live elapsed, type · id, Cancel job),
 * its task or full command, facts and the output pane (or its empty state).
 */
function describeDetail(job: JobsPanelJob, detail: JobsPanelDetail | undefined, nowMs: number): NativeNode {
	const settled = job.status !== "running";
	const exit = detail?.exitCode;
	const age = Math.round(jobAge(job, nowMs));
	const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
	const pids = detail?.pids ?? [];
	const facts = compact([
		job.agentId ? { k: "Agent", v: [span(job.agentId, "mono")] } : undefined,
		detail?.cwd ? { k: "Directory", v: [span(detail.cwd, "path")] } : undefined,
		pids.length > 0 && { k: pids.length > 1 ? "PIDs" : "PID", v: [span(pids.join(", "), "num")] },
		exit !== undefined && { k: "Exit code", v: [span(String(exit), exit === 0 ? "success" : "error")] },
		detail?.artifactId ? { k: "Full output", v: [span(`artifact://${detail.artifactId}`, "mono")] } : undefined,
	]);
	const children = compact<NativeChild>([
		row(
			compact<NativeChild>([
				text([STATUS_GLYPH[job.status], span(` ${STATUS_LABEL[job.status]}`)], {
					role: "omp.jobs.state",
					tone: STATUS_TONE[job.status],
					wrap: "none",
				}),
				node("elapsed", {
					age,
					...(settled ? { stopped: age } : {}),
					format: "short",
					role: "omp.jobs.age",
					title: settled ? "Ran for" : "Running for",
				}),
				text([span(`${job.type} · ${job.id}`, "mono")], { role: "omp.jobs.id", wrap: "none", truncate: "end" }),
				node("spacer", { grow: 1 }),
				!settled && actionButton("Cancel job", "cancel", { keys: "x", tone: "error" }),
			]),
			{ role: "omp.jobs.status", gap: "sm", align: "center" },
		),
		command
			? code(command, { lang: "bash", wrap: true, preview: { lines: 4 }, role: "omp.jobs.command" })
			: text(job.label, { role: "omp.jobs.title", wrap: "word" }),
		facts.length > 0 && node("kv", { items: facts, role: "omp.jobs.facts" }),
		node(
			"col",
			{ role: "omp.jobs.out", gap: "sm" },
			[
				text("Output", { role: "omp.jobs.label" }),
				detail?.output
					? ansi(detail.output, { follow: !settled, role: "omp.jobs.output", max: { h: "16lines" } })
					: text(settled ? "No output" : "No output yet", { role: "omp.jobs.nooutput" }),
			],
			"out",
		),
	]);
	return node("col", { role: "omp.jobs.detail" }, children, stableKey(job.id));
}
