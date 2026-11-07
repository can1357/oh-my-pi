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
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { renderImageMarkedText } from "./image-marked-text";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
/**
 * Tail share of the preview when the link points at a raw capture: tools append
 * notices (wall time, exit code, timeout) after the captured stream.
 */
export const ASYNC_PREVIEW_TAIL_CHARS = 1_000;

/** The inline preview of a result too long to deliver whole. */
export function asyncResultPreview(text: string): string {
	return `${text.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
}

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
	 * Set when the result is too long to deliver whole and its text is rendered at build time
	 * (a backgrounded `ask` answer, numbered against the answers delivered with it). Saves the
	 * rendered full text and returns its artifact id, or undefined when nothing was saved.
	 */
	spill?: (fullText: string) => string | undefined;
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
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	meta?: OutputMeta;
	/**
	 * How many leading content images are images a person pasted into backgrounded `ask`
	 * answers. They are numbered across the delivery (`[Image #N]` is the Nth of them), so
	 * `attachment://N` resolves to them; images other jobs produced follow and are not attachments.
	 */
	answerImageCount?: number;
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

/** A bash command on one line, middle elided past the cap so commands differing only at the end stay distinct. */
function commandIdentity(command: string): string {
	const oneLine = command.trim().replace(/\r\n|\r|\n/g, "\\n");
	if (oneLine.length <= COMMAND_IDENTITY_MAX_CHARS) return oneLine;
	const keep = COMMAND_IDENTITY_MAX_CHARS / 2;
	return `${oneLine.slice(0, keep)}…${oneLine.slice(-keep)}`;
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	// Each backgrounded `ask` answer numbers its pasted images from 1. In one delivery
	// the answers share one message, so render each answer again with its markers raised
	// past the images of the answers before it: `[Image #N]` then names one image of the
	// whole delivery. Only runs the answer reported as markers move; file names, code spans and
	// the person's own text stay as written, unless they read exactly like one of the composer's
	// live tokens. An answer too long to deliver whole is cut to the usual preview, and its saved
	// file holds the renumbered full text.
	const answerImages: ImageContent[] = [];
	const otherImages: ImageContent[] = [];
	const results = entries.map(entry => {
		const images = entry.job?.latestDetails?.images ?? [];
		if (entry.job?.type !== "ask") {
			otherImages.push(...images);
			return entry.result;
		}
		const marked = entry.job.latestDetails?.imageMarkedText;
		const text = marked ? renderImageMarkedText(marked, answerImages.length) : entry.result;
		answerImages.push(...images);
		if (!marked || !entry.spill) return text;
		const artifactId = entry.spill(text);
		const preview = asyncResultPreview(text);
		return artifactId ? `${preview}\nFull output: artifact://${artifactId}` : preview;
	});
	const jobs = entries.map((entry, index) => {
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
			result: escapeHarnessTags(results[index]!),
			type: entry.job?.type,
			status: entry.job?.status,
			agentId: entry.job?.agentId,
			label: entry.job?.label,
			headerLabel: headerLabel ? escapeHarnessTags(headerLabel) : undefined,
			namedByCommand: command !== undefined,
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
			...(job.meta ? { meta: job.meta } : {}),
			...(job.structured ? { schema: job.structured } : {}),
		})),
		...(answerImages.length > 0 ? { answerImageCount: answerImages.length } : {}),
	};
	const text = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	// Answer images lead, in marker order, so `[Image #N]` is also the Nth image the model sees here.
	const images = [...answerImages, ...otherImages];
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
