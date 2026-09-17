/**
 * Autonomous-mode durable task surfaces for the planning root.
 *
 * In `fusion.mode === "autonomous"` each delegated spawn becomes a durable
 * `native_task` job (see task/index.ts). The inline dispatch awaits its own
 * job, so the tool result is the handoff; this module covers the cases the
 * inline path cannot see: jobs settled by an external runner, recovered
 * leases, or jobs paused/cancelled out of band. Terminal states the planner
 * has not yet observed are returned as handoff messages for injection into
 * the next planning turn.
 *
 * Also backs the `/fusion jobs|pause|resume|stop` controls, scoped to the
 * calling session's `native_task` jobs via `payload.parentSessionId`.
 */

import { DurableRunner } from "../operational/runner";
import type { OperationalStore } from "../operational/store";
import type { DurableJob, JsonValue } from "../operational/types";
import type { CustomMessage } from "./messages";

const HANDOFF_CUSTOM_TYPE = "autonomous-task-update";
const SESSION_JOB_LIST_LIMIT = 1_000;
const HANDOFF_DETAIL_LIMIT = 600;

function payloadField(job: DurableJob, key: string): string | undefined {
	const payload = job.payload;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = (payload as Record<string, JsonValue>)[key];
	return typeof value === "string" ? value : undefined;
}

function resultField(job: DurableJob, key: string): string | undefined {
	const result = job.result;
	if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
	const value = (result as Record<string, JsonValue>)[key];
	return typeof value === "string" ? value : undefined;
}

/** Native-task jobs owned by the given session, in creation order. */
export function sessionNativeTasks(store: OperationalStore, sessionId: string | null | undefined): DurableJob[] {
	if (!sessionId) return [];
	return store
		.listJobs({ type: "native_task", limit: SESSION_JOB_LIST_LIMIT })
		.filter(job => payloadField(job, "parentSessionId") === sessionId);
}

function jobLabel(job: DurableJob): string {
	return payloadField(job, "agentId") ?? job.id;
}

/** One-line status summary for `/fusion jobs` and control verb reports. */
export function formatNativeTaskJobLine(job: DurableJob): string {
	const label = jobLabel(job);
	const detail = job.error ?? resultField(job, "mergeSummary");
	return `- ${job.id} (${label}): ${job.status}${detail ? ` — ${detail.slice(0, 120)}` : ""}`;
}

function truncateDetail(text: string): string {
	return text.length > HANDOFF_DETAIL_LIMIT ? `${text.slice(0, HANDOFF_DETAIL_LIMIT)}…` : text;
}

/**
 * Handoff text for one terminal job. Includes what the planner needs to
 * replan: which agent finished, its terminal status, and the merge/error
 * evidence (never the full worker output).
 */
export function formatAutonomousTaskHandoff(job: DurableJob): string {
	const label = jobLabel(job);
	const lines = [
		`[Autonomous task update] Delegated worker "${label}" (durable job ${job.id}) finished with status "${job.status}".`,
	];
	const mergeSummary = resultField(job, "mergeSummary");
	const error = job.error ?? resultField(job, "output");
	if (job.status === "completed" && mergeSummary) {
		lines.push(`Integration: ${truncateDetail(mergeSummary)}`);
	} else if (error) {
		lines.push(`Detail: ${truncateDetail(error)}`);
	}
	if (job.status === "failed" || job.status === "cancelled") {
		lines.push("Inspect the job's retained checkpoint/artifacts before deciding whether to retry or re-plan.");
	}
	lines.push("Fold this handoff into the plan: continue remaining tasks, adjust scope, or run verification.");
	return lines.join("\n");
}

/**
 * Collect planner handoffs for this session's terminal `native_task` jobs not
 * yet in `reported`. Pure with respect to the session: the caller owns the
 * reported set and applies `reportedIds` after successfully queueing the
 * messages.
 */
export function collectAutonomousTaskHandoffs(options: {
	store: OperationalStore;
	sessionId: string | null | undefined;
	reported: ReadonlySet<string>;
}): { messages: CustomMessage[]; reportedIds: string[] } {
	const { store, sessionId, reported } = options;
	const messages: CustomMessage[] = [];
	const reportedIds: string[] = [];
	for (const job of sessionNativeTasks(store, sessionId)) {
		if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") continue;
		if (reported.has(job.id)) continue;
		reportedIds.push(job.id);
		messages.push({
			role: "custom",
			customType: HANDOFF_CUSTOM_TYPE,
			content: formatAutonomousTaskHandoff(job),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}
	return { messages, reportedIds };
}

export type SessionJobControlAction = "pause" | "resume" | "cancel";

export interface SessionJobControlResult {
	readonly changed: DurableJob[];
	readonly failures: readonly string[];
}

/**
 * Apply a control transition to this session's `native_task` jobs.
 *
 * Uses a control-only DurableRunner so transitions follow the runner's
 * semantics exactly: pausing or cancelling a running job flips its durable
 * state, after which the owning worker's next heartbeat/checkpoint write
 * fails and aborts the executor — the fencing contract, not a local flag.
 */
export function controlSessionNativeTasks(options: {
	store: OperationalStore;
	sessionId: string | null | undefined;
	action: SessionJobControlAction;
	jobId?: string;
	workerId?: string;
}): SessionJobControlResult {
	const { store, sessionId, action, jobId } = options;
	const requested = jobId?.trim();
	const jobs = sessionNativeTasks(store, sessionId);
	const targets = requested
		? jobs.filter(job => job.id === requested || payloadField(job, "agentId") === requested)
		: jobs.filter(job => {
				if (action === "resume") return job.status === "paused" || job.status === "failed";
				if (action === "pause") return job.status === "queued" || job.status === "running";
				return job.status === "queued" || job.status === "running" || job.status === "paused";
			});
	if (targets.length === 0) {
		const reason = requested ? `no native task job "${requested}" owned by this session` : "no eligible jobs";
		return { changed: [], failures: [reason] };
	}

	const runner = new DurableRunner({
		store,
		workerId: options.workerId ?? `fusion-control-${sessionId ?? "session"}`,
		executor: () => Promise.reject(new Error("control-only runner does not execute jobs")),
	});
	const changed: DurableJob[] = [];
	const failures: string[] = [];
	for (const job of targets) {
		try {
			changed.push(
				action === "pause"
					? runner.pause(job.id)
					: action === "resume"
						? runner.resume(job.id)
						: runner.cancel(job.id),
			);
		} catch (error) {
			failures.push(`${jobLabel(job)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	runner.dispose();
	return { changed, failures };
}
