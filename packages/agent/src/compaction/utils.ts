/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message, ToolCall } from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";
import { escapeHarmonyControlTokens } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { AgentMessage } from "../types";
import summarizationSystemPrompt from "./prompts/summarization-system.md" with { type: "text" };

/** @deprecated Import these from `@oh-my-pi/snapcompact`. */
export {
	computeFileLists,
	createFileOps,
	type FileOperations,
	isUrlSchemePath,
	upsertFileOperations,
} from "@oh-my-pi/snapcompact";

/** @deprecated Use `upsertFileOperations("", readFiles, modifiedFiles, readSet)` from `@oh-my-pi/snapcompact`. */
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	return snapcompact.upsertFileOperations("", readFiles, modifiedFiles, readSet);
}

/** Error text for a summarization call that hit its output limit (`stopReason: "length"`): partial text is never used. */
export function incompleteOutputError(prefix: string): string {
	return `${prefix}: model output ended incomplete (stopReason: length)`;
}

// Read-tool selector grammar, mirrored from the conservative filesystem splitter in
// packages/coding-agent/src/tools/path-utils.ts (splitPathAndSel). Keep in sync.
// A trailing `:chunk` is a selector only when it is a line-range list
// (`50`, `50-200`, `50+10`, `5-16,960-973`, `..` alias), `raw`, or `conflicts` —
// alone or as a `range:raw` / `raw:range` compound.
const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const READ_SELECTOR_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const READ_RANGE_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const READ_RAW_ONLY_RE = /^raw$/i;
const READ_ALTERNATE_FORM_RE = /^(?:raw|conflicts)$/i;

/**
 * Split a read-tool path into its base path and trailing selector, mirroring the
 * read tool's own splitter. Single source of the grammar in this package: the
 * file-operations list strips selectors via {@link stripReadSelector}, and the
 * supersede-prune pass keys on both parts via `readToolSupersedeKey`.
 */
export function splitReadSelector(path: string): { path: string; sel?: string } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path };
	const candidate = path.slice(colon + 1);
	if (!READ_SELECTOR_RE.test(candidate)) return { path };
	let base = path.slice(0, colon);
	let sel = candidate;
	// Compound trailing selector: `path:1-50:raw` or `path:raw:1-50`.
	const inner = base.lastIndexOf(":");
	if (inner > 0) {
		const innerCandidate = base.slice(inner + 1);
		const innerIsRaw = READ_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = READ_RAW_ONLY_RE.test(candidate);
		const innerIsRange = READ_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = READ_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			base = base.slice(0, inner);
		}
	}
	return { path: base, sel };
}

/**
 * Strip a trailing read-tool selector (`:50-200`, `:raw`, `:1-50:raw`, `:conflicts`, …)
 * so the same file read with different line ranges dedupes to one `<files>` entry
 * and matches its write/edit path when computing Read/Write/RW markers.
 */
export function stripReadSelector(path: string): string {
	return splitReadSelector(path).path;
}

/**
 * Whether a selector from {@link splitReadSelector} shows the file in a form other
 * than its plain lines: verbatim `raw` bytes or the merge `conflicts` view.
 */
export function isAlternateFormReadSelector(sel: string): boolean {
	return sel.split(":").some(part => READ_ALTERNATE_FORM_RE.test(part));
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: snapcompact.FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// Internal URIs (conflict://, artifact://, local://, history://, …) and
		// web URLs are not re-groundable files — keep them out of `<files>`.
		if (snapcompact.isUrlSchemePath(path)) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(stripReadSelector(path));
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate tool results to the same representation used in summarization prompts.
 */
export function truncateToolResultForSummary(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	const truncatedChars = text.length - TOOL_RESULT_MAX_CHARS;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${truncatedChars} more characters truncated]`;
}

const SUMMARY_BOUNDARY_TAG_RE = /<\s*\/?\s*(?:conversation|previous-summary)\s*>/gi;

/** Keep untrusted summary input from closing or impersonating harness-owned boundaries. */
export function escapeSummaryBoundaryTags(text: string): string {
	return text.replace(SUMMARY_BOUNDARY_TAG_RE, tag => `&lt;${tag.slice(1)}`);
}

/**
 * Serialize LLM messages as plain summary input without provider control tokens.
 * `dropThinking` is the summarizer's resolved `classifier-cot-extraction` policy.
 */
export function serializeConversationForSummary(messages: Message[], dialect?: Dialect, dropThinking = false): string {
	const conversation = serializeConversation(messages, dialect, dropThinking);
	const escaped = dialect === "harmony" ? escapeHarmonyControlTokens(conversation) : conversation;
	return escapeSummaryBoundaryTags(escaped);
}

/**
 * Serialize LLM messages to transcript text.
 * Call convertToLlm() first to handle custom message types.
 * `dropThinking` omits assistant reasoning from dialect transcripts: set it from
 * the reader's resolved `classifier-cot-extraction` catalog policy (Claude's
 * classifier refuses inputs that reproduce the model's own reasoning as text,
 * "reasoning_extraction"). Reasoning is ephemeral and low-signal for a summary.
 */
export function serializeConversation(messages: Message[], dialect?: Dialect, dropThinking = false): string {
	// Tool results flagged contextually useless (and their paired calls) are
	// dropped from the serialized text: the source region is discarded after
	// summarization anyway, so excluding them costs nothing and keeps garbage
	// out of the summary input.
	const uselessCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.useless === true && msg.isError !== true) {
			uselessCallIds.add(msg.toolCallId);
		}
	}
	if (dialect) {
		const processed: Message[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content.filter(
					block =>
						(block.type !== "toolCall" || !uselessCallIds.has(block.id)) &&
						(!dropThinking || block.type !== "thinking"),
				);
				if (content.length > 0) processed.push(content.length === msg.content.length ? msg : { ...msg, content });
				continue;
			}
			if (msg.role === "toolResult") {
				if (uselessCallIds.has(msg.toolCallId)) continue;
				const text = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("");
				if (!text) continue;
				processed.push({
					...msg,
					content: [{ type: "text", text: truncateToolResultForSummary(text) }],
				});
				continue;
			}
			processed.push(msg);
		}
		return getDialectDefinition(dialect).renderTranscript(processed);
	}

	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: ToolCall[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					if (uselessCallIds.has(block.id)) continue;
					toolCalls.push(block);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Think]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Tool Call]: ${renderToolCalls(toolCalls)}`);
			}
		} else if (msg.role === "toolResult") {
			if (uselessCallIds.has(msg.toolCallId)) continue;
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			if (content) {
				const text = truncateToolResultForSummary(content);
				parts.push(`[Tool Result]: ${text}`);
			}
		}
	}

	return parts.join("\n\n");
}

/**
 * Render an assistant turn's tool calls as a compact `name(args)` list for the
 * legacy serializer.
 */
function renderToolCalls(calls: ToolCall[]): string {
	return calls
		.map(call => {
			const argsStr = Object.entries(call.arguments as Record<string, unknown>)
				.map(([k, v]) => `${k}=${stringifyJson(v) ?? "null"}`)
				.join(", ");
			return `${call.name}(${argsStr})`;
		})
		.join("; ");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(summarizationSystemPrompt);
