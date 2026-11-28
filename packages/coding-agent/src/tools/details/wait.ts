import { type OutputMeta } from "../output-meta-format";
import { type ConfiguredThinkingLevel } from "../../utils/render-utils";
import type { StructuredSubagentOutput } from "../../task/task-details";
import { type JobWidgetView } from "./job-widget";
import type { IrcDeliveryReceipt } from "../../irc/irc-types";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

/** Coordination details retained by wait and background job operations. */
export type CoordinationOp = "send" | "wait" | "cancel";

/** Background-job row surfaced by `wait`/`cancel` results and `proc://` listings. */
export interface JobSnapshot {
	id: string;
	type: "bash" | "task" | "eval" | "extension";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	/** What the job is for, in the model's words (a process job's `label` is its command line). */
	intent?: string;
	durationMs: number;
	/** Epoch ms for the visible elapsed clock; only a running job in a live wait update carries it. */
	startedAtMs?: number;
	/**
	 * When the run settled (epoch ms); absent while it is still running. Lets a
	 * snapshot tell a result that finished during the call from one recovered
	 * from an earlier, never-delivered completion (#16052).
	 */
	settledAtMs?: number;
	/** Process exit status when the job reports one. */
	exitCode?: number;
	/** Effective task model selector, including an explicit reasoning suffix when configured. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata, independent of the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when the task progress reports an attached live advisor. */
	advisor?: boolean;
	/** The task agent's latest self-estimated completion (0–100); see `AgentProgress.completionPercent`. */
	completionPercent?: number;
	/** The task agent's latest stage in its own words; see `AgentProgress.stage`. */
	stage?: string;
	/** Running task only: assistant requests so far; see `AgentProgress.requests`. */
	requests?: number;
	/** Running task only: cumulative cost in USD; see `AgentProgress.cost`. */
	cost?: number;
	/** Running task only: latest per-turn context size; see `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Running task only: the model's context window; see `AgentProgress.contextWindow`. */
	contextWindow?: number;
	/** The job's live widget, while one is being drawn; frozen at its last state once the job settles. */
	widget?: JobWidgetView;
	resultText?: string;
	errorText?: string;
	/** Source-output metadata retained for per-job warnings and persisted row rendering. */
	meta?: OutputMeta;
	/** Capture error in historical snapshots; new snapshots store source metadata in `meta`. */
	artifactError?: OutputMeta["artifactError"];
	structured?: StructuredSubagentOutput;
	/**
	 * `agent://<id>` handle backing this job's artifacts — the job-row's
	 * registry `agentId` when the manager disambiguated a requested job id
	 * on collision, else the job id itself. See {@link AsyncJob.agentId}.
	 */
	agentUrlId?: string;
	/**
	 * Whether this job's turn published `<agentUrlId>.md`. False where the job
	 * body reported that it wrote none, so `agent://` still holds an earlier
	 * turn's output; undefined where the body does not report it.
	 */
	agentOutputPublished?: boolean;
}

/** Outcome of cancelling one background job. */
export type CancelStatus = "cancelled" | "not_found" | "already_completed";

/** Cancellation outcome and its model-facing explanation. */
export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * a peer message, or a spawn owned by another agent. Surfaced by background
 * snapshots so the displayed picture matches the UI's running-agent
 * count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
	/**
	 * Whether an attached session corroborates the `running` claim. False marks
	 * a ref that says `running` with no turn in flight — either a spawn still
	 * wiring up or a stale registration that an explicit cancellation clears (#8634).
	 */
	live: boolean;
	/**
	 * Acceptance time of the agent's final result, when the registry recorded
	 * one. With `live: false` this is an accepted run the parent may cancel
	 * instead of waiting on (#11079).
	 */
	acceptedAt?: number;
}

/** Details shared by messaging receipts and job/wait results. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: CoordinationOp;
	from?: string;
	to?: string;
	/** Session title of a recipient in another omp instance, shown in place of its pid `to`. */
	toLabel?: string;
	receipts?: IrcDeliveryReceipt[];
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
	/** `wait` was cut short by steering, a peer message, or a completion notice that injects next. */
	interrupted?: boolean;
}
