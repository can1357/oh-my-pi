/**
 * The async background jobs of a session, twice: {@link JobsPanel} is the
 * `/jobs` transcript block (ANSI keeps the caller's text report; natively one
 * frame), {@link JobsSheet} the dismissable sheet the native jobs pill opens.
 * The panel draws task jobs as `agent` nodes and the others as a status dot,
 * the one-line label and a live `elapsed`; the sheet lists every job and
 * inspects the selected one (command, cwd, live pids, exit code, output tail).
 */
import type { TspAgentProps, TspSpan } from "@oh-my-pi/pi-wire";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { type Component, Container } from "../tui";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { truncateToWidth } from "../utils";
import { collapseCommand } from "../apps/ps-data";
import {
	ansi,
	card,
	code,
	col,
	compact,
	elapsed,
	item,
	kv,
	node,
	row,
	span,
	stableKey,
	text,
} from "../native/describe";
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

const AGENT_STATUS: Record<JobsPanelJob["status"], TspAgentProps["status"]> = {
	running: "running",
	completed: "done",
	failed: "failed",
	cancelled: "aborted",
};

const DOT: Record<JobsPanelJob["status"], TspSpan> = {
	running: { t: "●", s: "accent", fx: "pulse" },
	completed: { t: "●", s: "success" },
	failed: { t: "●", s: "error" },
	cancelled: { t: "●", s: "dim" },
};

/** Output tail rows the terminal fallback shows under the selected job. */
const FALLBACK_TAIL_LINES = 8;

/** The `/jobs` block: `ansi` renders in the terminal, the snapshot describes the native frame. */
export class JobsPanel extends Container {
	readonly #snapshot: JobsPanelSnapshot;
	readonly #nowMs: number;
	#native: { agent: boolean; node: NativeNode } | undefined;

	constructor(snapshot: JobsPanelSnapshot, nowMs: number, ansi: readonly Component[]) {
		super();
		this.#snapshot = snapshot;
		this.#nowMs = nowMs;
		for (const child of ansi) this.addChild(child);
	}

	override describe(cx: DescribeContext): NativeNode {
		const agent = cx.supports("agent");
		if (this.#native?.agent === agent) return this.#native.node;
		const head: TspSpan[] = [span("Background jobs", "strong")];
		const running = this.#snapshot.running.length;
		if (running > 0) head.push(span(` · ${running} running`, "muted"));
		const described = card({ role: "omp.jobs", head }, describeJobs(this.#snapshot, this.#nowMs, agent));
		this.#native = { agent, node: described };
		return described;
	}
}

/**
 * The jobs pill's sheet: a centred `lg` glass sheet titled Background jobs.
 * A selectable list of every job (running first) sits over the selected
 * job's detail: status and live elapsed (a task job's `agent` node), cwd,
 * live pids, exit code, the full command and a tail-following output pane.
 * It re-reads the session every frame, so the caller re-renders it on a
 * timer while it is open. ↑/↓ select, X cancels the selected running job,
 * Esc or Close dismisses; nothing enters the transcript.
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

	constructor(source: JobsSheetSource) {
		this.#source = source;
	}

	describe(cx: DescribeContext): NativeNode {
		const agent = cx.supports("agent");
		const { jobs, selected } = this.#current();
		const detail = selected && this.#source.inspect(selected.id);
		const now = Date.now();
		// Elapsed nodes tick on their own; list values and the output pane redraw
		// when a job starts, settles or leaves, its process changes, its output
		// grows, or (while one runs) once a second.
		const key = [
			agent,
			jobs.map(job => `${job.id}:${job.status}`).join(","),
			selected?.id,
			detail?.pids.join(" "),
			detail?.exitCode,
			detail?.artifactId,
			jobs.some(job => job.status === "running") ? Math.floor(now / 1000) : "",
		].join("|");
		const output = detail?.output;
		if (this.#native?.key === key && this.#native.output === output) return this.#native.node;
		const actions = [null, actionButton("Close", "close", { keys: "escape" })];
		if (selected?.status === "running") {
			actions.unshift(actionButton("Cancel job", "cancel", { keys: "x", tone: "error" }));
		}
		const described = col(
			compact([
				selectList(
					"jobs",
					jobs.map(job => describeJobItem(job, now)),
					{ selected: selected?.id ?? null, empty: "No background jobs", max: { lines: 6 } },
				),
				selected && describeDetail(selected, detail, now, agent),
				actionBar(actions),
			]),
			{ gap: "md" },
		);
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
			const tail = (detail.output ?? "").trimEnd().split("\n").slice(-FALLBACK_TAIL_LINES);
			for (const line of tail) if (line) lines.push(truncateToWidth(`   ${line}`, width));
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

/** The body the `/jobs` panel draws: running rows, then a Recent section; an empty note when there are none. */
function describeJobs(snapshot: JobsPanelSnapshot, nowMs: number, agent: boolean): NativeChild[] {
	const { running, recent } = snapshot;
	const children: NativeChild[] = [];
	if (running.length === 0 && recent.length === 0) {
		children.push(node("text", { text: "No background jobs", role: "omp.jobs.empty" }, undefined, "empty"));
	}
	for (const job of running) children.push(describeJob(job, nowMs, agent));
	if (recent.length > 0) {
		children.push(
			node(
				"section",
				{ head: [span("Recent", "muted")] },
				recent.map(job => describeJob(job, nowMs, agent)),
				"recent",
			),
		);
	}
	return children;
}

/** A task job as an `agent` node when the terminal draws them, else a one-line dot row. */
function describeJob(job: JobsPanelJob, nowMs: number, agent: boolean): NativeNode {
	const settled = job.status !== "running";
	const age = jobAge(job, nowMs);
	if (agent && job.type === "task") {
		return node(
			"agent",
			{
				name: job.agentId ?? job.id,
				agent: "task",
				task: job.label,
				status: AGENT_STATUS[job.status],
				stats: settled ? { took: age } : { age },
			},
			undefined,
			job.id,
		);
	}
	return node(
		"row",
		{ role: "omp.jobs.row", gap: "sm", align: "center", title: `${job.id} · ${job.type} · ${job.status}` },
		[
			text([DOT[job.status]], { aria: job.status, shrink: 0 }),
			text([span(collapseCommand(job.label))], { wrap: "none", truncate: "end", grow: 1 }),
			text([span(job.type, "dim")], { wrap: "none", shrink: 0 }),
			elapsed(age, settled),
		],
		job.id,
	);
}

/** One sheet list row: status dot and one-line label, then type and age. */
function describeJobItem(job: JobsPanelJob, nowMs: number): NativeNode {
	return item(job.id, {
		label: [DOT[job.status], span(" "), span(collapseCommand(job.label))],
		value: [span(job.type, "dim"), span(` · ${formatDuration(jobAge(job, nowMs))}`, "muted")],
		title: `${job.id} · ${job.type} · ${job.status}`,
	});
}

/** The selected job: status line (or `agent` node), facts, command and output tail. */
function describeDetail(
	job: JobsPanelJob,
	detail: JobsPanelDetail | undefined,
	nowMs: number,
	agent: boolean,
): NativeNode {
	const settled = job.status !== "running";
	const exit = detail?.exitCode;
	const children = compact<NativeChild>([
		agent && job.type === "task"
			? describeJob(job, nowMs, agent)
			: row(
					[
						text(
							[DOT[job.status], span(` ${job.status}`, "strong"), span(` · ${job.type} · ${job.id}`, "muted")],
							{
								wrap: "none",
								truncate: "end",
							},
						),
						elapsed(jobAge(job, nowMs), settled),
					],
					{ gap: "sm", align: "center" },
				),
		detail &&
			kv([
				["Directory", detail.cwd && [span(detail.cwd, "path")]],
				["PID", detail.pids.length > 0 ? [span(detail.pids.join(", "), "num")] : undefined],
				["Exit", exit === undefined ? undefined : [span(String(exit), exit === 0 ? "success" : "error")]],
				["Full output", detail.artifactId && [span(`artifact://${detail.artifactId}`, "mono")]],
			]),
		// The row shows the command on one line; show it whole when that cut or collapsed it.
		detail?.command && detail.command !== collapseCommand(job.label)
			? card(
					{
						head: [span("Command", "muted")],
						variant: "bare",
						collapsible: true,
						collapsed: true,
						preview: { lines: 3 },
					},
					[code(detail.command, { lang: "bash", wrap: true })],
				)
			: undefined,
		detail?.output
			? ansi(detail.output, { follow: !settled, role: "omp.jobs.output", max: { h: "16lines" } })
			: text([span(settled ? "No output" : "No output yet", "dim")]),
	]);
	return node("col", { gap: "sm", role: "omp.jobs.detail" }, children, stableKey(job.id));
}
