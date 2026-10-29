/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type Component, Container } from "../tui";
import { formatBytes, formatCount, formatDuration } from "@oh-my-pi/pi-utils";
import { span } from "../native/describe";
import type { JobSnapshot } from "../tools/wait";
import type { DaemonSnapshot } from "../tools/daemon";
import { type CustomMessage, type FileMentionMessage, resolveAbortLabel, shouldRenderAbortReason } from "./messages";
import { createIrcMessageCard } from "../tools/wait";
import { formatArtifactErrorNotice, type OutputMeta } from "../tools/output-meta";
import type { OutputArtifactError } from "../tools/streaming-output";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../render/render-utils";
import { canonicalizeMessage } from "./thinking-display";
import { ToolActivityContainer } from "../chrome/tool-activity";
import { CustomMessageComponent } from "./custom-message";
import type { MessageRenderer } from "./extension-types";
import { type TranscriptBlock } from "../chrome/transcript-container";
import { TranscriptStatusBlock, type TranscriptStatusRow } from "../chrome/transcript-status";
import { theme } from "../theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (
		message as CustomMessage<{
			jobId?: string;
			type?: JobSnapshot["type"];
			label?: string;
			durationMs?: number;
			jobs?: Array<{
				jobId?: string;
				type?: JobSnapshot["type"];
				label?: string;
				durationMs?: number;
				meta?: OutputMeta;
			}>;
			meta?: OutputMeta;
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
	const rows: TranscriptStatusRow[] = [];
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const type = job.type ?? "job";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		rows.push({
			parts: [
				{ text: `${theme.status.done} Background job completed`, color: "success" },
				{ text: `[${type}]`, color: "dim" },
				{ text: jobId, color: "accent" },
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
			native: {
				tone: "success",
				message: [span("Background job completed"), ...facts([type, jobId, duration])],
			},
		});
		if (job.meta?.artifactError) rows.push(artifactErrorRow(job.meta.artifactError));
	}
	if (details?.meta?.artifactError) rows.push(artifactErrorRow(details.meta.artifactError));
	return new ToolActivityContainer(new TranscriptStatusBlock(rows));
}

/** A transcript component that can expand/collapse; both card shapes implement it. */
type ExpandableComponent = Component & { setExpanded(expanded: boolean): void };

/**
 * The built-in completion block, wrapped so `display.hideToolActivity` keeps
 * working while a renderer is registered.
 *
 * The fallback has to be mounted INSIDE a `CustomMessageComponent` (that is
 * what hosts an extension renderer), and `FramedMessageComponent` re-invokes
 * its renderer callback on every expand or theme change. One wrapper instance
 * is therefore reused for the whole card: it owns the visibility flag and
 * re-applies it to the block it wraps, the same way `TodoReminder` forwards
 * the preference to its notice.
 */
class AsyncResultFallback extends Container implements ExpandableComponent {
	#visible = true;

	constructor(message: CustomOrHookMessage) {
		super();
		this.addChild(buildAsyncResultBlock(message));
	}

	setToolActivityVisible(visible: boolean): void {
		this.#visible = visible;
		for (const child of this.children) {
			const activity = child as Partial<{ setToolActivityVisible(on: boolean): void }>;
			if (typeof activity.setToolActivityVisible === "function") activity.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(on: boolean): void }>;
			if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
		}
	}

	override render(width: number): readonly string[] {
		return this.#visible ? super.render(width) : [];
	}
}

/**
 * A `CustomMessageComponent` that also honors `display.hideToolActivity`.
 *
 * Only TOP-LEVEL transcript children receive `setToolActivityVisible`, and the
 * frame — not the transcript — mounts the fallback card, so the frame relays
 * the preference to the block it owns. Without this a registered renderer that
 * declines or throws would show completion rows to users who hid tool
 * activity: the card would behave differently depending on whether an
 * extension is loaded.
 */
class AsyncResultCard extends CustomMessageComponent implements ExpandableComponent {
	readonly #fallback: AsyncResultFallback;

	constructor(message: CustomOrHookMessage, renderer: MessageRenderer) {
		const fallback = new AsyncResultFallback(message);
		super(message as CustomMessage<unknown>, (delegate, options, rendererTheme) => {
			try {
				return renderer(delegate, options, rendererTheme) ?? fallback;
			} catch {
				return fallback;
			}
		});
		this.#fallback = fallback;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#fallback.setToolActivityVisible(visible);
	}
}

/**
 * Build the `async-result` transcript card, letting a registered
 * `registerMessageRenderer("async-result", …)` renderer OWN it (#14131).
 *
 * Both transcript surfaces — the live `UiHelpers.addMessageToChat` and the
 * replayed `ChatTranscriptBuilder.#appendCustomMessage` — must dispatch
 * identically, or a replayed transcript renders differently from the live one.
 * Keeping the decision here is what stops the two from drifting apart again,
 * which is how the built-in branch came to shadow registered renderers.
 *
 * The built-in completion block stays the fallback in all three cases:
 * no renderer registered, a renderer that declines (returns `undefined`), and
 * a renderer that THROWS. The throw case matters: `FramedMessageComponent`
 * swallows renderer exceptions and falls through to the generic frame, so
 * without this guard a broken extension renderer would replace the useful
 * "Background job completed" row with the raw `<system-notice>` body.
 *
 * Returns a component both transcript surfaces can expand/collapse.
 */
export function buildAsyncResultComponent(
	message: CustomOrHookMessage,
	renderer: MessageRenderer | undefined,
): ExpandableComponent {
	if (!renderer) return buildAsyncResultBlock(message);
	return new AsyncResultCard(message, renderer);
}

/** The warning row under a background job whose output artifact could not be saved. */
function artifactErrorRow(error: OutputArtifactError): TranscriptStatusRow {
	const notice = formatArtifactErrorNotice(error);
	return { parts: [{ text: notice, color: "warning" }], native: { tone: "warning", message: [span(notice)] } };
}

/**
 * Native notice spans for a row's trailing facts (kind, id, duration): each
 * after a dim ` · `, absent ones skipped.
 */
function facts(values: readonly (string | undefined)[]): TspSpan[] {
	return values.flatMap(value => (value ? [span(" · ", "dim"), span(value, "dim")] : []));
}

/**
 * Render a `launch-completion` custom message (terminal supervised-process
 * exits from the launch broker) as a transcript block of one compact
 * "Supervised process ..." row per daemon, matching background-job rows.
 */
export function buildLaunchCompletionBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (message as CustomMessage<{ daemons?: DaemonSnapshot[] }>).details;
	const rows: TranscriptStatusRow[] = [];
	const daemons = details?.daemons ?? [];
	if (daemons.length === 0 && typeof message.content === "string") {
		rows.push({
			parts: [{ text: `${theme.status.done} ${message.content}`, color: "dim" }],
			native: { tone: "success", message: [span(message.content)] },
		});
	}
	for (const daemon of daemons) {
		const failed = daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
		const label = failed ? "Supervised process failed" : "Supervised process completed";
		const exit = daemon.exitCode !== undefined ? `exit ${daemon.exitCode}` : undefined;
		const duration =
			daemon.exitedAt !== undefined && daemon.startedAt !== undefined
				? formatDuration(daemon.exitedAt - daemon.startedAt)
				: undefined;
		rows.push({
			parts: [
				failed
					? { text: `${theme.status.error} ${label}`, color: "error" }
					: { text: `${theme.status.done} ${label}`, color: "success" },
				{ text: daemon.name, color: "accent" },
				exit ? { text: `(${exit})`, color: "dim" } : undefined,
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
			native: {
				tone: failed ? "error" : "success",
				message: [span(label), span(" "), span(daemon.name, "mono"), ...facts([exit, duration])],
			},
		});
	}
	return new ToolActivityContainer(new TranscriptStatusBlock(rows));
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
	const rows: TranscriptStatusRow[] = [];
	for (const file of files) {
		let detail: string;
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			detail = file.skippedReason === "binary" ? `skipped: binary, ${size}` : `skipped: ${size}`;
		} else {
			detail = file.image
				? "image"
				: file.lineCount === undefined
					? "unknown lines"
					: formatCount("line", file.lineCount);
		}
		rows.push({
			parts: [
				{ text: theme.tree.last, color: "dim" },
				{ text: "Read", color: "muted" },
				{ text: file.path, color: "accent" },
				{ text: `(${detail})`, color: "dim" },
			],
			indent,
			native: {
				tone: "info",
				icon: "read",
				message: [span("Read"), span(" "), span(file.path, "path"), ...facts([detail])],
			},
		});
	}
	return new TranscriptStatusBlock(rows);
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
	/** Index in `message.content` of each after-tool segment's first block, by tool-call id. */
	contentOffsets: ReadonlyMap<string, number>;
	hasToolCalls: boolean;
	lastToolCallId?: string;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	const contentOffsets = new Map<string, number>();
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

	for (let index = 0; index < message.content.length; index++) {
		const content = message.content[index]!;
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			contentOffsets.set(content.id, index + 1);
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
		return { beforeTools: message, afterToolCalls, contentOffsets, hasToolCalls: false };
	}

	return {
		beforeTools: displaySegment(beforeTools),
		afterToolCalls,
		contentOffsets,
		hasToolCalls: true,
		lastToolCallId,
	};
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
