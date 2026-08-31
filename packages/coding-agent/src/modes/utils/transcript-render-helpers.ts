/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Component, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJobType } from "../../async";
import type { DaemonSnapshot } from "../../launch/protocol";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressDetails,
	type AsyncResultDetails,
} from "../../session/async-job-delivery";
import {
	type CustomMessage,
	type FileMentionMessage,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "../../session/messages";
import { createIrcMessageCard } from "../../tools/hub";
import { formatStyledArtifactReference } from "../../tools/output-meta";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { renderStatusLine } from "../../tui/status-line";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { ToolActivityContainer } from "../components/tool-activity";
import { TranscriptBlock } from "../components/transcript-container";
import { theme } from "../theme/theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;

function sanitizeAsyncProgressDisplayText(text: string): string {
	return truncateAsyncProgressDisplayLines(shortenEmbeddedPaths(replaceTabs(text)));
}

function truncateAsyncProgressDisplayLines(text: string): string {
	return text
		.split("\n")
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE))
		.join("\n");
}

/**
 * Build the display-only copy of an async progress message. The persisted/model
 * payload remains byte-identical; both transcript surfaces pass this copy to the
 * existing custom-message renderer.
 */
export function buildAsyncProgressDisplayMessage(message: CustomOrHookMessage): CustomOrHookMessage {
	if (message.customType !== ASYNC_PROGRESS_MESSAGE_TYPE || typeof message.content !== "string") return message;
	const content = sanitizeAsyncProgressDisplayText(message.content);
	return content === message.content ? message : { ...message, content };
}

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;
type BackgroundWorkType = AsyncJobType | "process";

function backgroundWorkNoun(type: BackgroundWorkType | undefined): "command" | "task" | "process" | "job" {
	switch (type) {
		case "bash":
			return "command";
		case "task":
			return "task";
		case "process":
			return "process";
		default:
			return "job";
	}
}

/**
 * Render an `async-result` custom message as one terminal background-work row
 * per job, with failure state and Bash exit code when available.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (message as CustomMessage<AsyncResultDetails & Partial<AsyncResultDetails["jobs"][number]>>).details;
	const jobs =
		details?.jobs && details.jobs.length > 0
			? details.jobs
			: [
					{
						jobId: details?.jobId,
						type: details?.type,
						label: details?.label,
						durationMs: details?.durationMs,
						status: details?.status,
						exitCode: details?.exitCode,
						timedOut: details?.timedOut,
					},
				];
	const block = new TranscriptBlock();
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const failed =
			job.status === "failed" || job.timedOut === true || (job.exitCode !== undefined && job.exitCode !== 0);
		const line = [
			failed
				? theme.fg("error", `${theme.status.error} Background ${backgroundWorkNoun(job.type)} failed`)
				: theme.fg("success", `${theme.status.done} Background ${backgroundWorkNoun(job.type)} completed`),
			theme.fg("accent", jobId),
			job.exitCode !== undefined ? theme.fg("dim", `(exit ${job.exitCode})`) : undefined,
			job.timedOut === true && job.exitCode === undefined ? theme.fg("dim", "(timed out)") : undefined,
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return new ToolActivityContainer(block);
}

/** Expandable transcript visualization for bounded progress from background work. */
export class AsyncProgressMessageComponent extends TranscriptBlock {
	#expanded = false;

	constructor(private readonly message: CustomOrHookMessage) {
		super();
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		const details = (this.message as CustomMessage<AsyncProgressDetails>).details;
		for (const job of details?.jobs ?? []) {
			// Hub job ids are the model-supplied process name (arbitrary text): sanitize
			// and bound like the preview lines below before it reaches the header.
			const jobId = truncateToWidth(
				sanitizeAsyncProgressDisplayText(sanitizeText(job.jobId ?? "unknown")),
				TRUNCATE_LENGTHS.TITLE,
			);
			const elapsed = typeof job.elapsedMs === "number" ? formatDuration(job.elapsedMs) : undefined;
			const header = renderStatusLine(
				{
					iconOverride: theme.fg("accent", theme.status.running),
					title: `Background ${backgroundWorkNoun(job.type)} progress ${jobId}`,
					meta: elapsed ? [`(${elapsed})`] : undefined,
				},
				theme,
			);
			this.addChild(new Text(header, 1, 0));
			if (typeof job.suppressedEvents === "number" && job.suppressedEvents > 0) {
				this.addChild(
					new Text(theme.fg("dim", `  … ${job.suppressedEvents} progress events suppressed (rate limit)`), 1, 0),
				);
			}
			// A fitting source-truncated window has no head/tail split: its text is
			// already the complete retained representation - render it verbatim. The
			// marker only belongs between an actual head/tail byte-split pair.
			const preview =
				job.truncated && (job.head !== undefined || job.tail !== undefined)
					? [job.head, "[…progress truncated…]", job.tail].filter(part => part !== undefined).join("\n")
					: (job.text ?? "");
			const outputLines = preview.split("\n").filter(line => line.trim().length > 0);
			const rendered = outputLines.map(line =>
				theme.fg("dim", `  ${shortenEmbeddedPaths(replaceTabs(sanitizeText(line)))}`),
			);
			const visibleLines = capPreviewLines(rendered, theme, {
				max: DEFAULT_TERMINAL_PREVIEW_LINES,
				expanded: this.#expanded,
				prefix: "  ",
			});
			for (const line of visibleLines) {
				this.addChild(new TruncatedText(line, 1, 0));
			}
			if ((job.truncated || (job.suppressedEvents ?? 0) > 0) && job.artifactId) {
				this.addChild(new Text(`  ${formatStyledArtifactReference(job.artifactId, theme)}`, 1, 0));
			}
		}
	}
}

/**
 * Render an `async-progress` custom message (bounded live output from
 * background jobs) as a collapsible transcript block: latest lines behind an
 * "… N earlier lines" marker, expandable with ctrl+o, hidden with the rest of
 * tool activity when `display.hideToolActivity` is enabled.
 */
export function buildAsyncProgressBlock(message: CustomOrHookMessage): ToolActivityContainer {
	return new ToolActivityContainer(new AsyncProgressMessageComponent(message));
}

/**
 * Render a `launch-completion` custom message (terminal supervised-process
 * exits from the launch broker) as a transcript block of one compact
 * "Supervised process ..." row per daemon, matching background-job rows.
 */
export function buildLaunchCompletionBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (message as CustomMessage<{ daemons?: DaemonSnapshot[] }>).details;
	const block = new TranscriptBlock();
	const daemons = details?.daemons ?? [];
	if (daemons.length === 0 && typeof message.content === "string") {
		block.addChild(new Text(theme.fg("dim", `${theme.status.done} ${message.content}`), 1, 0));
	}
	for (const daemon of daemons) {
		const normalizedName = shortenEmbeddedPaths(
			replaceTabs(sanitizeText(daemon.name.replace(/[\r\n]+/g, " "))),
		).trim();
		const displayName = truncateToWidth(normalizedName || "unnamed", TRUNCATE_LENGTHS.TITLE);
		const failed = daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
		const duration =
			daemon.exitedAt !== undefined && daemon.startedAt !== undefined
				? formatDuration(daemon.exitedAt - daemon.startedAt)
				: undefined;
		const line = [
			failed
				? theme.fg("error", `${theme.status.error} Supervised process failed`)
				: theme.fg("success", `${theme.status.done} Supervised process completed`),
			theme.fg("accent", displayName),
			daemon.exitCode !== undefined ? theme.fg("dim", `(exit ${daemon.exitCode})`) : undefined,
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return new ToolActivityContainer(block);
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{
			from?: string;
			to?: string;
			message?: string;
			body?: string;
			replyTo?: string;
			pool?: string;
			mode?: string;
		}>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: message.customType === "irc:workpool"
					? ("workpool" as const)
					: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
			pool: details?.pool,
			mode: details?.mode,
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
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			suffix = file.skippedReason === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
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
 * Whether an assistant turn has visible text, thinking, or image content — i.e.
 * content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Split mixed assistant turns into visible text before tool execution and
 * visible text segments that must render immediately after the preceding tool.
 * Cursor can return intro text, tool calls, progress text, and the final answer
 * in one assistant message; keeping every text block in the leading assistant
 * block buries post-tool text above tool results in the transcript.
 */
export function splitAssistantMessageToolTimeline(message: AssistantAgentMessage): {
	beforeTools: AssistantAgentMessage;
	afterToolCalls: ReadonlyMap<string, AssistantAgentMessage>;
	hasToolCalls: boolean;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	let pendingAfterTool: AssistantAgentMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const displaySegment = (content: AssistantAgentMessage["content"]): AssistantAgentMessage => ({
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	});

	const flushPendingAfterTool = () => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		afterToolCalls.set(lastToolCallId, displaySegment(pendingAfterTool));
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) {
			pendingAfterTool.push(content);
		} else {
			beforeTools.push(content);
		}
	}
	flushPendingAfterTool();

	if (!sawToolCall) {
		return { beforeTools: message, afterToolCalls, hasToolCalls: false };
	}

	return { beforeTools: displaySegment(beforeTools), afterToolCalls, hasToolCalls: true };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export type AssistantErrorPresentation =
	| { kind: "none" }
	| { kind: "full"; text: string; isError: true }
	| { kind: "compact-recovered"; text: string; isError: false };

function sanitizeRecoveredRetryNote(note: string): string {
	const normalized = replaceTabs(note).replace(/\s+/g, " ").trim();
	return truncateToWidth(normalized || "retried", TRUNCATE_LENGTHS.CONTENT);
}

/**
 * Resolve the turn-ending assistant error presentation, if any.
 * Silent and user-interrupt aborts yield no label. Recovered retry attempts
 * render a compact note; attempts superseded by an exhausted budget are hidden
 * while the final terminal error keeps its full presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		return {
			kind: "compact-recovered",
			text: sanitizeRecoveredRetryNote(message.retryRecovery.note),
			isError: false,
		};
	}
	if (message.stopReason === "aborted") {
		if (!shouldRenderAbortReason(message)) return { kind: "none" };
		return { kind: "full", text: resolveAbortLabel(message, retryAttempt), isError: true };
	}
	if (message.stopReason === "error") {
		return { kind: "full", text: message.errorMessage || "Error", isError: true };
	}
	if (message.errorMessage && shouldRenderAbortReason(message)) {
		return { kind: "full", text: message.errorMessage, isError: true };
	}
	return { kind: "none" };
}

/**
 * Whether an assistant turn's `usage` reflects work the operator was billed
 * for. Empty automated turns from providers that emit `usage: 0` collapse to
 * `false`, but any input, output, cache, or premium request keeps the row so
 * cost transparency survives — the live path and the resume/rebuild path
 * agree turn-by-turn.
 */
export function assistantUsageIsBilled(usage: AssistantAgentMessage["usage"]): boolean {
	if (usage.input > 0 || usage.output > 0) return true;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) return true;
	if ((usage.premiumRequests ?? 0) > 0) return true;
	return false;
}
