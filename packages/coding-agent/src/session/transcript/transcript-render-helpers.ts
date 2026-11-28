import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { flattenLine, normalizeLineEndings, shortenHomeIn } from "@oh-my-pi/pi-tui/text/sanitize";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { previewLine, TRUNCATE_LENGTHS } from "../../utils/render-utils";
import { replaceTabs } from "../../utils/text-width";
import { resolveAbortLabel, shouldRenderAbortReason } from "./messages";
import { canonicalizeMessage } from "./thinking-display";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

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
	| { kind: "compact-recovered"; text: string; outcome: string; detail: string; isError: false };

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
		const { note, recovery, supersededBy } = message.retryRecovery;
		const model = recovery === "model" ? supersededBy : undefined;
		const savedNote = flattenLine(sanitizeText(note));
		const outcome = model
			? flattenLine(sanitizeText(`recovered on ${model.provider}/${model.model}`))
			: savedNote || "retried";
		const error = message.errorMessage
			? replaceTabs(shortenHomeIn(sanitizeText(normalizeLineEndings(message.errorMessage)))).trim()
			: "";
		const detail = error || (model ? savedNote : "");
		const separator = " — ";
		const remaining = TRUNCATE_LENGTHS.CONTENT - Bun.stringWidth(outcome) - Bun.stringWidth(separator);
		// Keep the reason visible even when the route itself needs truncation.
		const reasonWidth = remaining > 0 ? Math.min(remaining, TRUNCATE_LENGTHS.SHORT) : TRUNCATE_LENGTHS.SHORT;
		const reason = detail && detail !== outcome ? previewLine(detail, reasonWidth) : "";
		return {
			kind: "compact-recovered",
			text: previewLine(reason ? `${reason}${separator}${outcome}` : outcome, TRUNCATE_LENGTHS.CONTENT),
			outcome,
			detail,
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
