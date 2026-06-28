/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import { type Component, Text } from "@pk-nerdsaver-ai/pi-tui";
import { formatBytes, formatDuration } from "@pk-nerdsaver-ai/pi-utils";
import { type CustomMessage, type FileMentionMessage, isSilentAbort, resolveAbortLabel } from "../../session/messages";
import { createIrcMessageCard } from "../../tools/irc";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { TranscriptBlock } from "../components/transcript-container";
import { theme } from "../theme/theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): TranscriptBlock {
	const details = (
		message as CustomMessage<{
			jobId?: string;
			type?: "bash" | "task";
			label?: string;
			durationMs?: number;
			jobs?: Array<{ jobId?: string; type?: "bash" | "task"; label?: string; durationMs?: number }>;
		}>
	).details;
	const jobs =
		details?.jobs && details.jobs.length > 0
			? details.jobs
			: [
					{
						jobId: details?.jobId,
						type: details?.type,
						label: details?.label,
						durationMs: details?.durationMs,
					},
				];
	const block = new TranscriptBlock();
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const line = [
			theme.fg("success", `${theme.status.done} Background job completed`),
			theme.fg("dim", typeLabel),
			theme.fg("accent", jobId),
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return block;
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{ from?: string; to?: string; message?: string; body?: string; replyTo?: string }>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
		},
		getExpanded,
		theme,
	);
}

/**
 * Render a `fileMention` message's files as a transcript block of "Read <path>"
 * rows. `indent` sets the left pad: the live chat renders within an outer gutter
 * (0), the transcript viewer renders body rows without one so rows own their pad
 * (1).
 */
export function buildFileMentionBlock(files: FileMentionMessage["files"], indent: number): TranscriptBlock {
	const block = new TranscriptBlock();
	for (const file of files) {
		let suffix: string;
		if (file.skippedReason === "tooLarge") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			suffix = `(skipped: ${size})`;
		} else {
			suffix = file.image
				? "(image)"
				: file.lineCount === undefined
					? "(unknown lines)"
					: `(${file.lineCount} lines)`;
		}
		const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
			"accent",
			file.path,
		)} ${theme.fg("dim", suffix)}`;
		block.addChild(new Text(text, indent, 0));
	}
	return block;
}

/**
 * Whether an assistant turn has visible text or thinking content (after
 * canonicalization) — i.e. content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/**
 * Resolve the inline error label, if any, for a turn-ending assistant message.
 * Silent aborts yield no label. `retryAttempt` tunes the abort label wording.
 */
export function resolveAssistantErrorMessage(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): { hasErrorStop: boolean; errorMessage: string | null } {
	const isAbortedSilently = message.stopReason === "aborted" && isSilentAbort(message);
	const hasErrorStop = !isAbortedSilently && (message.stopReason === "aborted" || message.stopReason === "error");
	const errorMessage = hasErrorStop
		? message.stopReason === "aborted"
			? resolveAbortLabel(message, retryAttempt)
			: message.errorMessage || "Error"
		: null;
	return { hasErrorStop, errorMessage };
}
