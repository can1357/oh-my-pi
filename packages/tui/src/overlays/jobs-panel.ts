/**
 * The async background jobs of a session, twice: {@link JobsPanel} is the
 * `/jobs` transcript block (ANSI keeps the caller's text report; natively one
 * frame), {@link JobsSheet} the dismissable sheet the native jobs pill opens.
 * Both draw task jobs as `agent` nodes and the others as a status dot, the
 * label and a live `elapsed` (running first, recent in their own section).
 */
import type { TspAgentProps, TspSpan } from "@oh-my-pi/pi-wire";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { type Component, Container } from "../tui";
import { matchesSelectCancel } from "../keybinding-matchers";
import { truncateToWidth } from "../utils";
import { card, col, elapsed, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";

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
 * The jobs pill's sheet: a centred `md` glass sheet titled Background jobs
 * that re-reads the session's jobs on every frame, so rows start, settle and
 * move to Recent while it is open. Esc or Close dismisses it; nothing enters
 * the transcript.
 */
export class JobsSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.jobs",
		size: "md",
		anchor: "center",
		head: "Background jobs",
	} as const;
	readonly #load: () => JobsPanelSnapshot;
	readonly #onClose: () => void;
	#native: { key: string; node: NativeNode } | undefined;

	/** `load` returns the current jobs; it runs once per frame. */
	constructor(load: () => JobsPanelSnapshot, onClose: () => void) {
		this.#load = load;
		this.#onClose = onClose;
	}

	describe(cx: DescribeContext): NativeNode {
		const agent = cx.supports("agent");
		const snapshot = this.#load();
		// Elapsed nodes tick on their own; only a job starting, settling or leaving redraws.
		const key = `${agent}|${jobsKey(snapshot.running)}|${jobsKey(snapshot.recent)}`;
		if (this.#native?.key === key) return this.#native.node;
		const close = actionButton("Close", "close", { keys: "escape" });
		const described = col([...describeJobs(snapshot, Date.now(), agent), actionBar([null, close])], {
			gap: "md",
		});
		this.#native = { key, node: described };
		return described;
	}

	/** Rows for a terminal without the native surface: status, label, type and age per job. */
	render(width: number): readonly string[] {
		const { running, recent } = this.#load();
		const now = Date.now();
		const line = (job: JobsPanelJob): string => {
			const age = formatDuration(Math.max(0, (job.endTime ?? now) - job.startTime));
			return truncateToWidth(` ${job.status}  ${job.label}  ${job.type} ${age}`, width);
		};
		const lines = [truncateToWidth(` Background jobs · ${running.length} running`, width)];
		if (running.length === 0 && recent.length === 0) lines.push(" No background jobs");
		lines.push(...running.map(line));
		if (recent.length > 0) lines.push(" Recent", ...recent.map(line));
		return lines;
	}

	invalidate(): void {
		this.#native = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#onClose();
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#onClose();
	}
}

/** Identity of a job list as drawn: ids and statuses in order. */
function jobsKey(jobs: readonly JobsPanelJob[]): string {
	return jobs.map(job => `${job.id}:${job.status}`).join(",");
}

/** The body both views share: running rows, then a Recent section; an empty note when there are none. */
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

/** A task job as an `agent` node when the terminal draws them, else a dot row. */
function describeJob(job: JobsPanelJob, nowMs: number, agent: boolean): NativeNode {
	const settled = job.status !== "running";
	const age = Math.max(0, (job.endTime ?? nowMs) - job.startTime);
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
			text([DOT[job.status]], { aria: job.status }),
			text([span(job.label)], { truncate: "end", grow: 1 }),
			text([span(job.type, "dim")]),
			elapsed(age, settled),
		],
		job.id,
	);
}
