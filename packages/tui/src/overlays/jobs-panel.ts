/**
 * `/jobs` output: the async background jobs of a session. ANSI keeps the
 * caller's text report; natively it is one frame whose rows are `agent`
 * nodes for task jobs and a status dot, the label and a live `elapsed` for
 * the others (running first, recent below a hairline).
 */
import type { TspAgentProps, TspSpan } from "@oh-my-pi/pi-wire";
import { type Component, Container } from "../tui";
import { card, elapsed, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";

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
		const { running, recent } = this.#snapshot;
		const children: NativeChild[] = [];
		if (running.length === 0 && recent.length === 0) {
			children.push(node("text", { text: "No background jobs", role: "omp.jobs.empty" }, undefined, "empty"));
		}
		for (const job of running) children.push(this.#describeJob(job, agent));
		if (recent.length > 0) {
			children.push(
				node(
					"section",
					{ head: [span("Recent", "muted")] },
					recent.map(job => this.#describeJob(job, agent)),
					"recent",
				),
			);
		}
		const head: TspSpan[] = [span("Background jobs", "strong")];
		if (running.length > 0) head.push(span(` · ${running.length} running`, "muted"));
		const described = card({ role: "omp.jobs", head }, children);
		this.#native = { agent, node: described };
		return described;
	}

	#describeJob(job: JobsPanelJob, agent: boolean): NativeNode {
		const settled = job.status !== "running";
		const age = Math.max(0, (job.endTime ?? this.#nowMs) - job.startTime);
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
}
