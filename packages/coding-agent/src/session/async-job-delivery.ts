/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups, and the rows a finished `/tan` leaves instead
 * ({@link buildTanResultMessages}).
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { Usage } from "@oh-my-pi/pi-ai";
import { type AsyncJob, type AsyncJobType, agentProgress } from "../async/job-manager";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import tanResultTemplate from "../prompts/system/tan-result.md" with { type: "text" };
import { isPersistedUsage, type StructuredSubagentOutput, sumAiuUnreportedTurns } from "../task/task-details";
import { escapeHarnessTags } from "./harness-tags";
import {
	type CustomMessage,
	type NormalizedCustomMessagePayload,
	TAN_RESULT_MESSAGE_TYPE,
	type TanResultDetails,
} from "./messages";
import type { EvalConsumedJob } from "../tools/details/eval";
import type { OutputMeta } from "../tools/output-meta-format";
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-result";
import { truncateMiddle } from "../tools/streaming-output";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
/**
 * Tail share of the preview when the link points at a raw capture: tools append
 * notices (wall time, exit code, timeout) after the captured stream.
 */
export const ASYNC_PREVIEW_TAIL_CHARS = 1_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	status?: AsyncJob["status"];
	agentId?: string;
	label?: string;
	durationMs?: number;
	/** Source capture metadata belongs to this job, not to the enclosing delivery report. */
	meta?: OutputMeta;
	/** Full structured payload (source/mode/status/data/error), when the job used an output schema. */
	schema?: StructuredSubagentOutput;
	/** Child model usage, retained for parent-session accounting. */
	usage?: Usage;
	/** Child turns whose expected billing frame was missing. */
	aiuUnreportedTurns?: number;
	/** Billing of the background jobs an auto-backgrounded eval cell consumed with `wait()`. */
	consumedJobs?: EvalConsumedJob[];
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	meta?: OutputMeta;
};

/**
 * Compact, size-capped JSON block for the delivery text, used only for
 * schema-invalid/error results (valid results point to `agent://<jobId>`
 * instead, since the sidecar's `<output>` block already carries the full
 * JSON — no need to duplicate it here).
 */
export function renderStructuredJson(structured: StructuredSubagentOutput): string | undefined {
	if (!Object.hasOwn(structured, "data")) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(structured.data, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	return truncateMiddle(serialized, { maxBytes: ASYNC_PREVIEW_MAX_CHARS }).content;
}

/**
 * Headline for the delivery's "Structured output:" line. `unavailable` means
 * no payload was ever validated (the run failed before yielding, or the
 * schema itself was unusable) — never a schema verdict, so it must not read
 * as "schema unavailable"/"schema invalid".
 */
export function structuredStatusLabel(status: StructuredSubagentOutput["status"]): string {
	return status === "unavailable" ? "unavailable" : `schema ${status}`;
}

/**
 * Which agent handles a result for task job `jobId` names. A task job's id can
 * differ from its agent id (a messaged agent's next turn, vibe turns, workpool
 * batches, /tan) while its output and transcript stay under the agent id.
 * `agent://` answers for this job only when it completed without reporting that
 * it wrote no output; otherwise only `history://` resolves to its turn.
 * `undefined`: the job id already is the agent id, or this is not a task job.
 */
export function taskAgentHandles(
	jobId: string,
	job: Pick<AsyncJob, "type" | "status" | "agentOutputPublished"> | undefined,
	agentUrlId: string | undefined,
): "agent" | "history" | undefined {
	if (job?.type !== "task" || !agentUrlId || agentUrlId === jobId) return undefined;
	return job.status === "completed" && job.agentOutputPublished !== false ? "agent" : "history";
}

/** Longest command a completion header quotes before eliding its middle. */
const COMMAND_IDENTITY_MAX_CHARS = 400;

/**
 * A bash command on one line, middle elided past the cap so commands differing only at the end stay distinct.
 * Names the job in the notices that report on it: its completion and its `notify` matches.
 */
export function commandIdentity(command: string): string {
	const oneLine = command.trim().replace(/\r\n|\r|\n/g, "\\n");
	if (oneLine.length <= COMMAND_IDENTITY_MAX_CHARS) return oneLine;
	const keep = COMMAND_IDENTITY_MAX_CHARS / 2;
	return `${oneLine.slice(0, keep)}…${oneLine.slice(-keep)}`;
}

/**
 * The rows a finished `/tan` job (`request`: the user's work it ran) leaves in
 * its owner's session, which never ran that work: a breadcrumb the user sees,
 * kept out of the model's context, and a hidden record linking the clone's
 * output. Neither asks the owner to act, and the record carries no report
 * body, so the owner neither resumes the tangent nor follows its next steps.
 */
export function buildTanResultMessages(
	jobId: string,
	job: AsyncJob,
	request: string,
): {
	breadcrumb: NormalizedCustomMessagePayload<TanResultDetails>;
	record: NormalizedCustomMessagePayload<TanResultDetails>;
} {
	const agentId = job.agentId ?? jobId;
	const failed = job.status === "failed";
	const details: TanResultDetails = {
		jobId,
		agentId,
		work: request,
		failed,
		durationMs: Math.max(0, (job.endTime ?? Date.now()) - job.startTime),
	};
	const record = prompt.render(tanResultTemplate, {
		agentId,
		request: escapeHarnessTags(request),
		failed,
		showAgentUrl: taskAgentHandles(jobId, job, agentId) !== "history",
	});
	return {
		breadcrumb: {
			customType: TAN_RESULT_MESSAGE_TYPE,
			content: request,
			display: true,
			excludeFromContext: true,
			attribution: "agent",
			details,
		},
		record: { customType: TAN_RESULT_MESSAGE_TYPE, content: record, display: false, attribution: "agent", details },
	};
}

/**
 * Child billing a settled background job carries into the session that consumes its result: a task
 * job's own usage and missing-frame count, or the billing of the jobs an eval job's cells consumed
 * (the job's call had already returned when they were consumed, so no earlier result holds them).
 */
export function backgroundTaskBilling(job: Pick<AsyncJob, "id" | "type" | "latestDetails" | "agentId"> | undefined): {
	usage?: Usage;
	aiuUnreportedTurns?: number;
	consumedJobs?: EvalConsumedJob[];
} {
	if (job?.type === "eval") {
		const rows = job.latestDetails?.consumedJobs;
		if (!Array.isArray(rows)) return {};
		const consumedJobs = rows.filter((row): row is EvalConsumedJob => isRecord(row) && typeof row.jobId === "string");
		return consumedJobs.length > 0 ? { consumedJobs } : {};
	}
	if (job?.type !== "task") return {};
	const progress = agentProgress(job.latestDetails, job.agentId ?? job.id);
	if (!progress) return {};
	const aiuUnreportedTurns = sumAiuUnreportedTurns([progress]);
	return {
		...(isPersistedUsage(progress.usage) ? { usage: progress.usage } : {}),
		...(aiuUnreportedTurns > 0 ? { aiuUnreportedTurns } : {}),
	};
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const structured = entry.job?.structured;
		const hasStructuredData = structured ? Object.hasOwn(structured, "data") : false;
		const structuredJson = structured && structured.status !== "valid" ? renderStructuredJson(structured) : undefined;
		// The job manager disambiguates a requested job id when it collides
		// with another live job (e.g. a task job reusing a vibe turn's job
		// id), suffixing `jobId` — but the task's artifacts are still
		// written under its own agent id (`AsyncJob.agentId`). Build the
		// advertised `agent://` URL from that, or the delivery would point
		// at an id with no backing `<id>.md`/`.json` on disk.
		const agentUrlId = entry.job?.agentId ?? entry.jobId;
		const handles = taskAgentHandles(entry.jobId, entry.job, agentUrlId);
		// Job output (a command's output, or a task's `<task-result>` around a
		// subagent's output), a subagent's payload and its validation error are
		// text the job controls: it must not close the `<system-notice>` it renders
		// into or open a forged harness block. Neither may the label naming it.
		// A bash job is named by its whole command: its label truncates the tail, so parallel jobs
		// that share a prefix would otherwise read the same in the notice that delivers them.
		const command = entry.job?.type === "bash" ? entry.job.process?.command : undefined;
		const headerLabel = command === undefined ? entry.job?.label : commandIdentity(command);
		return {
			jobId: entry.jobId,
			agentUrlId,
			showAgentUrl: handles === "agent",
			showHistoryUrl: handles === "history",
			result: escapeHarnessTags(entry.result),
			type: entry.job?.type,
			status: entry.job?.status,
			agentId: entry.job?.agentId,
			label: entry.job?.label,
			headerLabel: headerLabel ? escapeHarnessTags(headerLabel) : undefined,
			namedByCommand: command !== undefined,
			...backgroundTaskBilling(entry.job),
			durationMs: entry.durationMs,
			meta: entry.job?.latestDetails?.meta,
			structured,
			structuredJson: structuredJson === undefined ? undefined : escapeHarnessTags(structuredJson),
			hasStructuredData,
			schemaStatus: structured?.status,
			schemaStatusLabel: structured ? structuredStatusLabel(structured.status) : undefined,
			schemaError: structured?.error === undefined ? undefined : escapeHarnessTags(structured.error),
			schemaValid: structured?.status === "valid",
		};
	});
	const details: AsyncResultDetails = {
		meta: { source: { type: "report", value: "background job delivery" } },
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			status: job.status,
			agentId: job.agentId,
			label: job.label,
			durationMs: job.durationMs,
			...(job.usage ? { usage: job.usage } : {}),
			...(job.aiuUnreportedTurns !== undefined ? { aiuUnreportedTurns: job.aiuUnreportedTurns } : {}),
			...(job.consumedJobs ? { consumedJobs: job.consumedJobs } : {}),
			...(job.meta ? { meta: job.meta } : {}),
			...(job.structured ? { schema: job.structured } : {}),
		})),
	};
	const text = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	const images = entries.flatMap(entry => entry.job?.latestDetails?.images ?? []);
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
