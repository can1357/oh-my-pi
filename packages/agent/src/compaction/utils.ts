/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message, ToolCall } from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";
import { escapeHarmonyControlTokens } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { formatGroupedPaths, prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import fileOperationsTemplate from "./prompts/file-operations.md" with { type: "text" };
import summarizationSystemPrompt from "./prompts/summarization-system.md" with { type: "text" };

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
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
 * A real filesystem path never contains a `scheme://` URL. Tool-call paths that
 * do — `conflict://1`, `artifact://3`, `local://ctx.md`, `history://…`,
 * `issue://12`, `https://…`, and the tolerated `file.ts:conflict://1` prefix
 * form — are session-scoped or remote resources, not files the post-compaction
 * agent can re-ground on. Keep them out of the `<files>` summary.
 */
const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Whether `path` references a `scheme://` URL (internal URI or web URL) rather
 * than a filesystem path that belongs in the compaction `<files>` summary.
 */
export function isUrlSchemePath(path: string): boolean {
	return URL_SCHEME_RE.test(path);
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
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
		if (isUrlSchemePath(path)) continue;

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

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// Drop any `scheme://` URLs (e.g. legacy `conflict://`/`artifact://` entries
	// rehydrated straight into `fileOps` from a pre-fix compaction summary) — only
	// real files belong in `<files>`. New tool-call scans are already filtered.
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter(f => !isUrlSchemePath(f)));
	const readOnly = [...fileOps.read].filter(f => !isUrlSchemePath(f) && !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as one `<files>` tag: a grouped, prefix-folded
 * directory tree (find-tool shape — `# dir/` headers, bare basenames) with a
 * ` (Read)` / ` (Write)` / ` (RW)` marker per file instead of separate
 * read/modified lists. `readSet` is the cumulative read set (`fileOps.read`),
 * used to tell modified files that were also read (RW) from blind writes.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
	// Legacy <read-files>/<modified-files> tags are still stripped so summaries
	// written before the combined <files> tag self-heal on the next compaction.
	return summary
		.replace(/<files>[\s\S]*?<\/files>\s*/g, "")
		.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
		.trimEnd();
}
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), path => ` (${mode.get(path)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		files += `\n[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`;
	}
	return prompt.render(fileOperationsTemplate, { files });
}

export function upsertFileOperations(
	summary: string,
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
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
 */
export function serializeConversationForSummary(messages: Message[], dialect?: Dialect): string {
	const conversation = serializeConversation(messages, dialect);
	const escaped = dialect === "harmony" ? escapeHarmonyControlTokens(conversation) : conversation;
	return escapeSummaryBoundaryTags(escaped);
}

/**
 * Serialize LLM messages to transcript text.
 * Call convertToLlm() first to handle custom message types.
 */
export function serializeConversation(messages: Message[], dialect?: Dialect): string {
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
		// Claude's classifier refuses inputs that reproduce the model's own
		// reasoning as text ("reasoning_extraction"), and the anthropic dialect
		// otherwise renders thinking verbatim inside <thinking> tags. Reasoning is
		// ephemeral and low-signal for a summary, so drop it from Anthropic-target
		// summary input. Other dialects (e.g. Harmony) carry reasoning natively in
		// their transcript format and keep it.
		const dropThinking = dialect === "anthropic";
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
