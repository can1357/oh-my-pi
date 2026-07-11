/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	convertMessageToLlm,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction/messages";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	TextContent,
	UserMessage,
} from "@pk-nerdsaver-ai/pi-ai";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import userInterjectionTemplate from "../prompts/steering/user-interjection.md" with { type: "text" };

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction/messages";

import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";
export const BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";

/** Details persisted on a `/tan` background-dispatch breadcrumb. */
export interface BackgroundTanDispatchDetails {
	jobId: string;
	work: string;
	/** Forked clone session file, named `<agentId>.jsonl`; the Agent Hub reads its transcript. */
	sessionFile: string;
}

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
	/** Internal: compact label shown for a queued custom message. Optional —
	 *  non-streaming skill prompts never set it. Stripped from persisted
	 *  `details` by `SessionManager.appendCustomMessageEntry` via the
	 *  `INTERNAL_DETAILS_FIELDS` allowlist below. */
	__queueChipText?: string;
}

/** Sentinel value for `AssistantMessage.errorMessage` indicating that the abort
 *  was an *expected internal transition* (plan-mode → execution compaction)
 *  and must NOT surface as a red "Operation aborted" line. Distinct from
 *  `undefined` (default) so user-cancel aborts with no errorMessage still
 *  render normally. Persists through SessionManager so history replay
 *  branches identically.
 *
 *  Consumers: `AgentSession.#handleAgentEvent` (stamper) writes this value;
 *  `EventController.#handleMessageEnd`, `AssistantMessageComponent`,
 *  `ui-helpers.addMessageToChat` (renderers), `AgentHubOverlayComponent
 *  #buildTranscriptLines`, `runPrintMode`, and `AcpAgent#replayAssistantMessage`
 *  (fallback error emission) read it via `isSilentAbort`. */
export const SILENT_ABORT_MARKER = "__omp.silent_abort__";

/** Type-guard for silent aborts. Renderers MUST call this helper so structured
 *  `errorId` and legacy persisted marker messages stay in lockstep. */
export function isSilentAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return AIError.is(message.errorId, AIError.Flag.SilentAbort) || message.errorMessage === SILENT_ABORT_MARKER;
}

/** Reason threaded through `AbortController.abort(reason)` when the user aborts
 *  the turn with Esc (see `AgentSession.abort`). The agent keeps it on the
 *  aborted assistant message's `errorMessage` so queued follow-ups/tool-result
 *  placeholders can distinguish a deliberate interrupt from a bare lifecycle
 *  abort, but interactive renderers suppress this redundant transcript line. */
export const USER_INTERRUPT_LABEL = "Interrupted by user";

export function isUserInterruptAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return AIError.is(message.errorId, AIError.Flag.UserInterrupt) || message.errorMessage === USER_INTERRUPT_LABEL;
}

export function shouldRenderAbortReason(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return !isSilentAbort(message) && !isUserInterruptAbort(message);
}

/** Sentinel `errorMessage` the agent stamps on any abort that carried no custom
 *  reason (bare `abort()`). Renderers treat it as "no specific reason given". */
export const GENERIC_ABORT_SENTINEL = "Request was aborted";

/** Resolve the operator-facing label for an aborted assistant turn. A custom
 *  abort reason threaded onto `errorMessage` is returned verbatim; aborts with
 *  no threaded reason fall back to the retry-aware generic label. Call
 *  `shouldRenderAbortReason` before rendering when user interrupts should stay
 *  visually quiet. */
export function resolveAbortLabel(
	message: Pick<AssistantMessage, "errorId" | "errorMessage">,
	retryAttempt = 0,
): string {
	const genericAbort =
		AIError.is(message.errorId, AIError.Flag.Abort) ||
		!message.errorMessage ||
		message.errorMessage === GENERIC_ABORT_SENTINEL ||
		isSilentAbort(message);
	if (!genericAbort) {
		return message.errorMessage!;
	}
	if (retryAttempt > 0) {
		return `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`;
	}
	return "Operation aborted";
}

/** Extract the optional `__queueChipText` field from a CustomMessage's
 *  `details` blob. Safe over `unknown`; returns undefined when the field is
 *  absent or non-string. */
export function readQueueChipText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __queueChipText?: unknown }).__queueChipText;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Explicit allowlist of `details` field names that are AgentSession-internal
 *  transient bookkeeping and MUST be removed before SessionManager persists
 *  the CustomMessageEntry to disk. Scoped intentionally narrow: only fields
 *  declared here are stripped. Adding a new entry is a deliberate, reviewed
 *  change — unrelated future payload fields are never silently dropped. */
export const INTERNAL_DETAILS_FIELDS = ["__queueChipText"] as const;

/** Return a `details` copy with every key in `INTERNAL_DETAILS_FIELDS`
 *  removed. Returns the input unchanged when there is nothing to strip
 *  (null/non-object, or no listed fields present) so callers don't pay a
 *  clone cost on the common path. */
export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

function isSteeringUserMessage(message: AgentMessage | undefined): message is UserMessage & { steering: true } {
	return message?.role === "user" && message.steering === true;
}

function userMessageWithoutSteering(message: UserMessage): UserMessage {
	const { steering, ...rest } = message;
	void steering;
	return rest;
}

function renderSteeringEnvelope(message: string): string {
	return prompt.render(userInterjectionTemplate, { message });
}

function getArrayContentText(content: (TextContent | ImageContent)[]): string {
	let firstText: string | undefined;
	let textParts: string[] | undefined;
	for (const part of content) {
		if (part.type !== "text") continue;
		if (firstText === undefined) {
			firstText = part.text;
			continue;
		}
		if (textParts === undefined) {
			textParts = [firstText];
		}
		textParts.push(part.text);
	}
	return textParts === undefined ? (firstText ?? "") : textParts.join("\n");
}

function getArrayContentImages(content: (TextContent | ImageContent)[]): ImageContent[] {
	let images: ImageContent[] | undefined;
	for (const part of content) {
		if (part.type !== "image") continue;
		if (images === undefined) images = [];
		images.push(part);
	}
	return images ?? [];
}

function wrapSteeringUserMessage(message: UserMessage): UserMessage {
	if (typeof message.content === "string") {
		if (message.content.length === 0) return message;
		return { ...userMessageWithoutSteering(message), content: renderSteeringEnvelope(message.content) };
	}

	const text = getArrayContentText(message.content);
	if (text.length === 0) return message;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: renderSteeringEnvelope(text) }];
	content.push(...getArrayContentImages(message.content));
	return { ...userMessageWithoutSteering(message), content };
}

export function wrapSteeringForModel(messages: AgentMessage[]): AgentMessage[] {
	// Wrap EVERY steering message, not just a trailing run. The wire bytes of a
	// steering message must be a pure function of the message itself, independent
	// of its position in the array. When only the trailing steer was wrapped, the
	// same persisted message was sent enveloped while it was the tail and raw once
	// the assistant's reply buried it — rewriting already-cached prefix bytes and
	// busting the provider prompt cache from that message onward on the next turn.
	let wrappedMessages: AgentMessage[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!isSteeringUserMessage(message)) continue;
		const wrappedMessage = wrapSteeringUserMessage(message);
		if (wrappedMessage === message) continue;
		if (wrappedMessages === undefined) {
			wrappedMessages = messages.slice();
		}
		wrappedMessages[i] = wrappedMessage;
	}
	return wrappedMessages ?? messages;
}

/** Result of filtering image blocks out of a `(TextContent | ImageContent)[]` array. */
interface StripContentResult {
	content: (TextContent | ImageContent)[];
	removed: number;
}

function stripImagesFromArrayContent(content: (TextContent | ImageContent)[]): StripContentResult {
	let removed = 0;
	const kept: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image") {
			removed++;
		} else {
			kept.push(part);
		}
	}
	if (removed === 0) {
		return { content, removed };
	}
	// Avoid emitting an empty `content` array — providers reject zero-block user/tool
	// messages and the LLM still needs to see *something* where the image used to be.
	if (kept.length === 0) {
		kept.push({ type: "text", text: "[image removed]" });
	}
	return { content: kept, removed };
}

/**
 * Strip image content blocks from `message` in place. Returns the count of
 * images removed across `content` (every role that carries `ImageContent`) and
 * any tool-result `details.images` payload. Callers MUST rewrite session
 * entries (`SessionManager.rewriteEntries`) and replay them through
 * `Agent.replaceMessages` afterwards so persisted state and provider-side
 * caches stay aligned with the mutated tree — `stripImagesFromMessage` is a
 * pure local mutation and intentionally does neither.
 */
export function stripImagesFromMessage(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			if (typeof message.content === "string") return 0;
			const { content, removed } = stripImagesFromArrayContent(message.content);
			if (removed > 0) {
				// All four roles type `content` as `string | (TextContent | ImageContent)[]`;
				// TypeScript can't narrow the assignment across the union, so cast once.
				(message as { content: typeof content }).content = content;
			}
			return removed;
		}
		case "toolResult": {
			let removed = 0;
			const { content, removed: contentRemoved } = stripImagesFromArrayContent(message.content);
			if (contentRemoved > 0) {
				message.content = content;
				removed += contentRemoved;
			}
			const details = message.details as { images?: unknown } | null | undefined;
			if (details && Array.isArray(details.images)) {
				const original = details.images as unknown[];
				const kept: unknown[] = [];
				for (const candidate of original) {
					const looksLikeImageBlock =
						!!candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "image";
					if (looksLikeImageBlock) {
						removed++;
					} else {
						kept.push(candidate);
					}
				}
				if (kept.length !== original.length) {
					details.images = kept;
				}
			}
			return removed;
		}
		case "fileMention": {
			let removed = 0;
			for (const file of message.files) {
				if (file.image) {
					file.image = undefined;
					removed++;
				}
			}
			return removed;
		}
		default:
			return 0;
	}
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as eval's Python backend.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@pk-nerdsaver-ai/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}

		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely.
	// After rehydration it belongs to a previous live provider connection and
	// replaying it on a warmed session causes 401 rejections from GitHub Copilot.
	// User/developer payloads are preserved separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((m): Message[] => {
		switch (m.role) {
			case "bashExecution":
				if (m.excludeFromContext) {
					return [];
				}
				return [
					{
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			case "pythonExecution":
				if (m.excludeFromContext) {
					return [];
				}
				return [
					{
						role: "user",
						content: [{ type: "text", text: pythonExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			case "fileMention": {
				// One `fileMention` can mix `@notes.md` (text) and `@screenshot.png` (image)
				// in the same turn (`generateFileMentionMessages` packs every `@…` into a
				// single message). Splitting by image presence keeps text-only mentions on
				// the higher-priority `developer` slot while routing image attachments
				// through `user`, the only Responses content slot that legitimately accepts
				// `input_image` (Codex chatgpt.com /codex/responses rejects everything else
				// with `Invalid value: 'input_image'`, #3443).
				const wrap = (file: FileMentionMessage["files"][number]): string => {
					const inner = file.content ? `\n${file.content}\n` : "\n";
					return `<file path="${file.path}">${inner}</file>`;
				};
				const textFiles = m.files.filter(file => !file.image);
				const imageFiles = m.files.filter(file => file.image);
				const out: Message[] = [];
				if (textFiles.length > 0) {
					out.push({
						role: "developer",
						content: [{ type: "text" as const, text: textFiles.map(wrap).join("\n") }],
						attribution: "user",
						timestamp: m.timestamp,
					});
				}
				if (imageFiles.length > 0) {
					const content: (TextContent | ImageContent)[] = [
						{ type: "text" as const, text: imageFiles.map(wrap).join("\n") },
					];
					for (const file of imageFiles) {
						if (file.image) content.push(file.image);
					}
					out.push({
						role: "user",
						content,
						attribution: "user",
						timestamp: m.timestamp,
					});
				}
				return out;
			}
			case "custom":
			case "hookMessage":
			case "branchSummary":
			case "compactionSummary":
			case "user":
			case "developer":
			case "assistant":
			case "toolResult": {
				// Core roles share one transformer with agent-core —
				// duplicating them here is how snapcompact frames once
				// silently fell off the provider request.
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			default:
				m satisfies never;
				return [];
		}
	});
}
