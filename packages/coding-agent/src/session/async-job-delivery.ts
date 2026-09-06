/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */

import { formatDuration, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobCompletionLeftover, AsyncJobProgressDelivery, AsyncJobType } from "../async";
import type { ProgressReminder } from "../async/progress-batcher";
import chattyProgressGuidanceTemplate from "../prompts/system/chatty-progress-guidance.md" with { type: "text" };
import asyncProgressTemplate from "../prompts/tools/async-progress.md" with { type: "text" };
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { StructuredSubagentOutput } from "../task/types";
import type { CustomMessage } from "./messages";
import { truncateMiddle } from "./streaming-output";
import {
	buildLineSnappedPreview,
	buildProgressPreview,
	flattenPreviewText,
	mergeProgressPreviews,
} from "./progress-preview";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";
export const ASYNC_PROGRESS_MESSAGE_TYPE = "async-progress";
/** Separate queue kind whose idle flush starts a follow-up turn. Messages retain the shared progress custom type. */
export const ASYNC_PROGRESS_WAKE_QUEUE_KIND = "async-progress-wake";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
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
	/**
	 * Present when the job's live output already reached the agent: the
	 * completion points at the artifact, inlines the never-delivered leftover,
	 * and includes terminal-only/post-processed result text when provenance
	 * shows it was not part of progress.
	 */
	progressSummary?: AsyncResultProgressSummary;
}

export interface AsyncResultProgressSummary {
	artifactId: string;
	leftover?: AsyncJobCompletionLeftover;
}

export interface AsyncProgressEntry {
	jobId: string;
	text: string;
	job: AsyncJob | undefined;
	source?: AsyncProgressSource;
	seq: number;
	elapsedMs: number;
	epoch: number;
	delivery: AsyncJobProgressDelivery;
	artifactId?: string;
	sourceTruncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
}

export type AsyncProgressSourceType = "bash" | "task" | "process";

export interface AsyncProgressSource {
	id: string;
	type: AsyncProgressSourceType;
	label: string;
	startedAt: number;
}

type AsyncProgressIdentity = Pick<AsyncProgressEntry, "jobId" | "source">;

/** Stable typed identity shared by queue folding, batch grouping, and completion promotion. */
export function asyncProgressSourceKey(entry: AsyncProgressIdentity): string {
	return entry.source ? `${entry.source.type}:${entry.source.id}` : `job:${entry.jobId}`;
}

/** Coalesce key for enqueue-time folding: one bounded queue entry per source per delivery generation. */
export function asyncProgressCoalesceKey(entry: AsyncProgressEntry): string {
	return `${entry.epoch}:${asyncProgressSourceKey(entry)}`;
}

/**
 * Fold a newly delivered progress entry into the queued entry for the same
 * typed source, retaining one bounded head/tail window. Ambient progress
 * enqueues every batcher window (~2 s) indefinitely while the owner is idle;
 * without folding, both the queue and the batch message built from it grow without
 * limit. A fold that drops middle content counts as one suppressed event so
 * the rendered marker reflects the coalescing.
 */
export function mergeAsyncProgressEntries(
	queued: AsyncProgressEntry,
	incoming: AsyncProgressEntry,
): AsyncProgressEntry {
	let text: string;
	let sourceTruncated = queued.sourceTruncated === true || incoming.sourceTruncated === true;
	let foldedEvents = 0;
	if (queued.text.length === 0 || incoming.text.length === 0) {
		text = queued.text.length === 0 ? incoming.text : queued.text;
	} else {
		// Build the merge previews without propagating upstream `sourceTruncated`
		// markers: the flag is tracked separately above, and threading it through
		// would mark the merged preview truncated even when the combined text
		// fully fits the budget, inflating fold counts with phantom events.
		const preview = mergeProgressPreviews(buildProgressPreview(queued.text), buildProgressPreview(incoming.text));
		text = flattenPreviewText(preview);
		if (preview.truncated) {
			// This merge genuinely dropped bytes; surface it as one folded event.
			sourceTruncated = true;
			foldedEvents = 1;
		}
	}
	const suppressedEvents = (queued.suppressedEvents ?? 0) + (incoming.suppressedEvents ?? 0) + foldedEvents;
	return {
		...incoming,
		text,
		sourceTruncated: sourceTruncated || undefined,
		suppressedEvents: suppressedEvents || undefined,
		artifactId: incoming.artifactId ?? queued.artifactId,
		reminder: queued.reminder ?? incoming.reminder,
	};
}

type AsyncProgressJobDetails = {
	jobId: string;
	type?: AsyncProgressSourceType;
	label?: string;
	elapsedMs: number;
	text?: string;
	hasOutput: boolean;
	head?: string;
	tail?: string;
	artifactId?: string;
	truncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
};

export type AsyncProgressDetails = {
	jobs: AsyncProgressJobDetails[];
};

/** Build one progress message, preserving every rate-limit-permitted event and grouping entries by typed source. */
export function buildAsyncProgressBatchMessage(
	entries: AsyncProgressEntry[],
): CustomMessage<AsyncProgressDetails> | null {
	if (entries.length === 0) return null;
	const entriesBySource = new Map<string, AsyncProgressEntry[]>();
	for (const entry of entries) {
		const sourceKey = asyncProgressSourceKey(entry);
		const queued = entriesBySource.get(sourceKey);
		if (queued) {
			queued.push(entry);
			continue;
		}
		entriesBySource.set(sourceKey, [entry]);
	}

	const jobs = Array.from(entriesBySource.values()).map(jobEntries => {
		const latest = jobEntries.at(-1)!;
		const type = latest.job?.type;
		const fullText = jobEntries
			.map(entry => sanitizeText(entry.text))
			.filter(Boolean)
			.join("\n");
		const hasOutput = fullText.length > 0;
		const suppressedEvents = jobEntries.reduce((total, entry) => total + (entry.suppressedEvents ?? 0), 0);
		const sourceTruncated = suppressedEvents > 0 || jobEntries.some(entry => entry.sourceTruncated);
		const preview = buildLineSnappedPreview(fullText, sourceTruncated);
		const truncated = hasOutput && preview.truncated;
		const artifactId = [...jobEntries].reverse().find(entry => entry.artifactId)?.artifactId;
		const reminder = jobEntries.find(entry => entry.reminder !== undefined)?.reminder;
		return {
			jobId: latest.jobId,
			type: latest.source?.type ?? (type === "eval" ? undefined : type),
			label: latest.source?.label ?? latest.job?.label,
			elapsedMs: latest.elapsedMs,
			text: hasOutput ? preview.text : undefined,
			hasOutput,
			head: preview.head,
			tail: preview.tail,
			artifactId,
			truncated,
			suppressedEvents: suppressedEvents || undefined,
			reminder,
		};
	});
	const chattyJobs = jobs.filter(
		job => job.reminder === "chatty-monitor" && (job.type === "bash" || job.type === "process"),
	);
	const chattyGuidance =
		chattyJobs.length === 0
			? undefined
			: prompt
					.render(chattyProgressGuidanceTemplate, {
						bash: chattyJobs.some(job => job.type === "bash"),
						hub: chattyJobs.some(job => job.type === "process"),
					})
					.trim();
	return {
		role: "custom",
		customType: ASYNC_PROGRESS_MESSAGE_TYPE,
		content: prompt.render(asyncProgressTemplate, {
			wake: entries.some(entry => entry.delivery === "wake"),
			multiple: jobs.length > 1,
			jobs: jobs.map(job => ({ ...job, elapsed: formatDuration(job.elapsedMs) })),
			chattyGuidance,
		}),
		display: true,
		attribution: "agent",
		details: { jobs },
		timestamp: Date.now(),
	};
}

export type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
	/** Full structured payload (source/mode/status/data/error), when the job used an output schema. */
	schema?: StructuredSubagentOutput;
	status?: AsyncJob["status"];
	exitCode?: number;
	timedOut?: boolean;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
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

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const structured = entry.job?.structured;
		const hasStructuredData = structured ? Object.hasOwn(structured, "data") : false;
		const structuredJson = structured && structured.status !== "valid" ? renderStructuredJson(structured) : undefined;
		const rawExitCode = entry.job?.latestDetails?.exitCode;
		const exitCode = typeof rawExitCode === "number" ? rawExitCode : undefined;
		const timedOut = entry.job?.latestDetails?.timedOut === true;
		const status = entry.job?.status;
		const leftover = entry.progressSummary?.leftover;
		return {
			jobId: entry.jobId,
			// The job manager disambiguates a requested job id when it collides
			// with another live job (e.g. a task job reusing a vibe turn's job
			// id), suffixing `jobId` — but the task's artifacts are still
			// written under its own agent id (`AsyncJob.agentId`). Build the
			// advertised `agent://` URL from that, or the delivery would point
			// at an id with no backing `<id>.md`/`.json` on disk.
			agentUrlId: entry.job?.agentId ?? entry.jobId,
			result: entry.result,
			type: entry.job?.type,
			label: entry.job?.label,
			durationMs: entry.durationMs,
			structured,
			structuredJson,
			hasStructuredData,
			schemaStatus: structured?.status,
			schemaError: structured?.error,
			schemaValid: structured?.status === "valid",
			status,
			timedOut,
			bash: entry.job?.type === "bash",
			exitCode,
			failed: status === "failed" || timedOut || (exitCode !== undefined && exitCode !== 0),
			hasExitCode: exitCode !== undefined,
			progressSummarized: entry.progressSummary !== undefined,
			// Preserve tabs in the model-facing completion payload. Transcript
			// renderers normalize tabs at the TUI boundary.
			terminalText: entry.progressSummary && entry.result ? sanitizeText(entry.result) : undefined,
			artifactId: entry.progressSummary?.artifactId,
			leftoverText: leftover?.text ? sanitizeText(leftover.text) : undefined,
			leftoverTruncated: leftover?.truncated === true,
			leftoverHead: leftover?.head ? sanitizeText(leftover.head) : undefined,
			leftoverTail: leftover?.tail ? sanitizeText(leftover.tail) : undefined,
			leftoverSuppressed: leftover?.suppressedEvents,
			hasLeftover: Boolean(leftover?.text || leftover?.head || leftover?.tail),
		};
	});
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
			...(job.structured ? { schema: job.structured } : {}),
			status: job.status,
			exitCode: job.exitCode,
			timedOut: job.timedOut,
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
