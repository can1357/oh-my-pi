/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	invalidateMessageCache,
	registerMessageCacheInvalidator,
} from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	convertMessageToLlm,
} from "@oh-my-pi/pi-agent-core/compaction/messages";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	TextContent,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import userInterjectionTemplate from "../prompts/steering/user-interjection.md" with { type: "text" };
import { formatTitleConversationContext, type TitleConversationTurn } from "../tiny/message-preproc";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@oh-my-pi/pi-agent-core/compaction/messages";

import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";
import { titleTextFromSkillPrompt } from "./skill-title-input";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";
export const BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";
export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

/** Custom message type for the transient Vibe mode directive. */
export const VIBE_MODE_CONTEXT_MESSAGE_TYPE = "vibe-mode-context";

/**
 * Logs provider-error turns so their actual cause is available outside the
 * session transcript. No-op for non-error stop reasons.
 */
export function logProviderTurnError(msg: AssistantMessage): void {
	if (msg.stopReason !== "error") return;
	logger.warn("agent turn ended with provider error", {
		provider: msg.provider,
		model: msg.model,
		errorMessage: msg.errorMessage,
		errorStatus: msg.errorStatus,
		errorId: msg.errorId,
	});
}

const EPHEMERAL_REPLY_MAX_BYTES = 4096;
const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

/**
 * Removes replay-bound provider state before reparenting an assistant message
 * under a different user turn.
 */
export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking" || block.type === "anthropicServerTool") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

/**
 * Collapses degenerate repeated lines and bounds an ephemeral side-channel
 * reply to 4 KiB.
 */
export function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/** Builds the recent user/assistant context supplied to title regeneration. */
export function buildReplanTitleContext(messages: AgentMessage[]): string {
	const turns: TitleConversationTurn[] = [];
	for (let i = messages.length - 1; i >= 0 && turns.length < REPLAN_TITLE_CONTEXT_TURN_LIMIT; i--) {
		const message = messages[i];
		if (!message) continue;
		const turn = titleConversationTurnFromMessage(message);
		if (turn) turns.push(turn);
	}
	turns.reverse();
	return formatTitleConversationContext(turns);
}

/**
 * Compares session messages by provider-replay semantics, ignoring runtime-only
 * fields that do not change a restored request.
 */
export function didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
	if (previousMessages.length !== nextMessages.length) return true;
	return previousMessages.some(
		(message, i) =>
			!Bun.deepEquals(
				normalizeSessionMessageForProviderReplay(message),
				normalizeSessionMessageForProviderReplay(nextMessages[i]),
			),
	);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const text = block.text.trim();
		if (text) parts.push(text);
	}
	return parts.join("\n\n");
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role === "custom") {
		const text = titleTextFromSkillPrompt(message);
		if (!text) return undefined;
		return { role: "user", text };
	}
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

function normalizeProviderReplayValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeProviderReplayValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entryValue]) => [key, normalizeProviderReplayValue(entryValue)]),
		);
	}
	return value;
}

function normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				role: message.role,
				content: normalizeProviderReplayValue(message.content),
				providerPayload: message.providerPayload,
			};
		case "assistant": {
			const isResponsesFamilyMessage =
				message.api === "openai-responses" || message.api === "openai-codex-responses";
			return {
				role: message.role,
				content:
					isResponsesFamilyMessage && Array.isArray(message.content)
						? message.content.flatMap(block => {
								if (block.type === "thinking") {
									return [];
								}
								if (block.type === "toolCall") {
									return [
										{
											type: block.type,
											id: block.id,
											name: block.name,
											arguments: block.arguments,
										},
									];
								}
								if (block.type === "text") {
									return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
								}
								return [normalizeProviderReplayValue(block)];
							})
						: normalizeProviderReplayValue(message.content),
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
			};
		}
		case "toolResult":
			return {
				role: message.role,
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				isError: message.isError,
				content: normalizeProviderReplayValue(message.content),
			};
		case "bashExecution":
			return {
				role: message.role,
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: message.meta
					? {
							truncation: normalizeProviderReplayValue(message.meta.truncation),
							limits: normalizeProviderReplayValue(message.meta.limits),
							diagnostics: message.meta.diagnostics
								? normalizeProviderReplayValue({
										summary: message.meta.diagnostics.summary,
										messages: message.meta.diagnostics.messages,
									})
								: undefined,
						}
					: undefined,
				excludeFromContext: message.excludeFromContext,
			};
		case "pythonExecution":
			return {
				role: message.role,
				code: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: message.meta
					? {
							truncation: normalizeProviderReplayValue(message.meta.truncation),
							limits: normalizeProviderReplayValue(message.meta.limits),
							diagnostics: message.meta.diagnostics
								? normalizeProviderReplayValue({
										summary: message.meta.diagnostics.summary,
										messages: message.meta.diagnostics.messages,
									})
								: undefined,
						}
					: undefined,
				excludeFromContext: message.excludeFromContext,
			};
		case "custom":
		case "hookMessage":
			return {
				role: message.role,
				customType: message.customType,
				content: normalizeProviderReplayValue(message.content),
			};
		case "branchSummary":
			return { role: message.role, summary: message.summary };
		case "compactionSummary":
			return {
				role: message.role,
				summary: message.summary,
				providerPayload: message.providerPayload,
			};
		case "fileMention":
			return {
				role: message.role,
				files: message.files.map(file => ({
					path: file.path,
					content: file.content,
					image: file.image,
				})),
			};
		default:
			return normalizeProviderReplayValue(message);
	}
}

/** Fallback type for extension-injected messages that omit a custom type. */
export const DEFAULT_CUSTOM_MESSAGE_TYPE = "custom-message";

/** Custom message carrying a coding request delegated by the live voice model. */
export const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

/** Content shape accepted for extension-injected messages. */
export type CustomMessageContent = string | (TextContent | ImageContent)[];

/** Public input accepted by `pi.sendMessage` and `AgentSession.sendCustomMessage`. */
export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

/** Custom message payload after applying runtime defaults. */
export type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

/** Custom message type for hidden interrupted-thinking continuity context. */
export const INTERRUPTED_THINKING_MESSAGE_TYPE = "interrupted-thinking";

/** Custom message type for the transient checkpoint-active reminder. */
export const CHECKPOINT_ACTIVE_REMINDER_TYPE = "checkpoint-active-reminder";

/** Metadata persisted with a hidden interrupted-thinking continuity message. */
export interface InterruptedThinkingDetails {
	interruptedAt: number;
	provider: AssistantMessage["provider"];
	model: string;
	blockCount: number;
}

/** Pure helper result for persisting interrupted thinking outside the assistant turn. */
export interface DemotedInterruptedThinking {
	reasoning: string;
	strippedContent: AssistantMessage["content"];
	blockCount: number;
}

/**
 * Demote a trailing run of *incomplete* interrupted-thinking from an assistant
 * message — reasoning that was still streaming when the user aborted.
 *
 * A block joins the run only when it is a non-empty `thinking` block with no
 * `thinkingSignature`. A signed/complete thinking block (Anthropic signature,
 * OpenAI reasoning item id) is safely replayable, so it ends the run and stays
 * in place — as do `redactedThinking` encrypted blobs, text, tool calls,
 * empty-thinking blocks, and trailing empty text placeholders.
 */
export function demoteInterruptedThinking(
	message: Pick<AssistantMessage, "content">,
): DemotedInterruptedThinking | undefined {
	const content = message.content;
	let scanEnd = content.length;
	while (scanEnd > 0) {
		const block = content[scanEnd - 1]!;
		if (block.type !== "text" || block.text.trim().length > 0) {
			break;
		}
		scanEnd--;
	}

	let runStart = scanEnd;
	while (runStart > 0) {
		const block = content[runStart - 1]!;
		if (block.type !== "thinking" || block.thinking.trim().length === 0 || block.thinkingSignature) {
			break;
		}
		runStart--;
	}

	const blockCount = scanEnd - runStart;
	if (blockCount === 0) {
		return undefined;
	}

	const reasoningBlocks: string[] = [];
	for (let index = runStart; index < scanEnd; index++) {
		const block = content[index]!;
		if (block.type === "thinking") {
			reasoningBlocks.push(block.thinking.trim());
		}
	}

	return {
		reasoning: reasoningBlocks.join("\n\n"),
		strippedContent: content.slice(0, runStart),
		blockCount,
	};
}

/**
 * True when the assistant turn at `messages[index]` is immediately followed by
 * its hidden `interrupted-thinking` continuity message — the marker that a
 * trailing thinking run was demoted on user interrupt. The run stays on the
 * persisted/displayed assistant message; this flag tells the LLM path to drop it.
 */
function followedByInterruptedThinking(messages: AgentMessage[], index: number): boolean {
	const next = messages[index + 1];
	return next !== undefined && next.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE;
}

/** Drop an incomplete trailing thinking run from an interrupted assistant in the LLM view. */
function stripDemotedThinkingForLlm(message: AssistantMessage): AssistantMessage {
	const demoted = demoteInterruptedThinking(message);
	return demoted ? { ...message, content: demoted.strippedContent } : message;
}

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

/** A provider-rejection turn carrying nothing but the error flag: stopReason
 *  "error" with no text, thinking, or tool calls — e.g. a request the provider
 *  rejected before any output (an oversized 413 payload). Persisting it writes an
 *  empty assistant turn that replays on reload and re-sends the rejected context;
 *  the error is surfaced live (pinned) instead. A turn that streamed partial text,
 *  reasoning, or tool calls is NOT empty and stays in history. */
export function isEmptyErrorTurn(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	if (message.stopReason !== "error") return false;
	return !message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.trim().length > 0;
			case "thinking":
				return block.thinking.trim().length > 0 || (block.thinkingSignature?.trim().length ?? 0) > 0;
			case "redactedThinking":
				return block.data.trim().length > 0;
			case "toolCall":
				return true;
			case "fallback":
				return false;
			// Unknown/new block kinds count as content: never silently discard a turn.
			default:
				return true;
		}
	});
}

/** Non-whitespace text. Tolerates malformed blocks: transcripts replayed off
 *  disk predate current shapes, and a missing field must not throw. */
function hasText(content: { text?: unknown }): boolean {
	return typeof content.text === "string" && content.text.trim().length > 0;
}

/**
 * A block that is real output from the model.
 *
 * Everything the assistant can emit counts except two: unsigned thinking, which
 * is not provider-authenticated and not actionable, and Anthropic's `fallback`
 * marker, which records that the request was routed elsewhere rather than
 * carrying any output. A native image response often arrives with no text and
 * no tool call at all, so recognising only those would call it nothing.
 */
function isActionableContent(content: AssistantMessage["content"][number] | undefined): boolean {
	switch (content?.type) {
		case "toolCall":
		case "image":
		case "redactedThinking":
		case "anthropicServerTool":
			return true;
		case "text":
			return hasText(content);
		case "thinking":
			return typeof content.thinkingSignature === "string" && content.thinkingSignature.trim().length > 0;
		default:
			return false;
	}
}

/** A `stop`/`toolUse` turn that produced nothing actionable. Any other stop
 *  reason is not an "empty stop": an `error`/`aborted` turn is a failure rather
 *  than an empty completion, and a `length` stop was cut off mid-output. */
export function isEmptyAssistantStop(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	switch (message.stopReason) {
		case "stop":
			return !message.content.some(isActionableContent);
		case "toolUse":
			// An orphaned toolUse stop (no tool_use block) corrupts Anthropic history:
			// a later tool_result has nothing to anchor to. Thinking alone cannot anchor
			// a tool_result, so it does not rescue a toolUse stop here.
			return !message.content.some(
				content => content?.type === "toolCall" || (content?.type === "text" && hasText(content)),
			);
		default:
			return false;
	}
}

/**
 * True when this assistant turn actually produced output, making its model the
 * one that served the run.
 *
 * Attribution asks this from two places that MUST reach the same verdict: the
 * live session, which flips a fallback to "served", and the offline walk
 * replaying a transcript. `error` and `aborted` are both failures — a stalled or
 * dropped stream is finalized as `aborted` with its partial block still
 * attached, so a stop reason alone is not proof.
 *
 * Actionable content is required on top of the empty-stop rule, which only
 * inspects `stop`/`toolUse`. A `length` stop burns the whole output budget
 * without necessarily emitting anything usable, and every other stop reason
 * bypasses that rule entirely.
 */
export function assistantTurnProducedOutput(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	return !isEmptyAssistantStop(message) && message.content.some(isActionableContent);
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

/** True when a persisted or extension-supplied value can be sent as custom-message content. */
export function isCustomMessageContent(content: unknown): content is CustomMessageContent {
	return typeof content === "string" || Array.isArray(content);
}

function normalizeCustomMessageContent(content: unknown): CustomMessageContent {
	return isCustomMessageContent(content) ? content : "";
}

function normalizeCustomMessageType(customType: unknown): string {
	return typeof customType === "string" && customType.length > 0 ? customType : DEFAULT_CUSTOM_MESSAGE_TYPE;
}

function normalizeCustomMessageAttribution(attribution: unknown): MessageAttribution {
	return attribution === "user" ? "user" : "agent";
}

function isCustomMessagePayloadObject<T>(
	payload: unknown,
): payload is Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">> {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

/** Normalizes extension-provided custom message input before it reaches session state or disk. */
export function normalizeCustomMessagePayload<T = unknown>(
	payload: CustomMessagePayload<T> | unknown,
): NormalizedCustomMessagePayload<T> {
	if (typeof payload === "string") {
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content: payload,
			display: true,
			attribution: "agent",
		};
	}
	if (!isCustomMessagePayloadObject<T>(payload)) {
		const content = payload === undefined || payload === null ? "" : String(payload);
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content,
			display: content.length > 0,
			attribution: "agent",
		};
	}
	return {
		customType: normalizeCustomMessageType(payload.customType),
		content: normalizeCustomMessageContent(payload.content),
		display: typeof payload.display === "boolean" ? payload.display : false,
		details: payload.details,
		attribution: normalizeCustomMessageAttribution(payload.attribution),
	};
}

type SteeringUserMessage =
	| (UserMessage & { steering: true })
	| (CustomMessage & {
			customType: typeof COLLAB_PROMPT_MESSAGE_TYPE;
			attribution: "user";
	  });

function isSteeringUserMessage(message: AgentMessage | undefined): message is SteeringUserMessage {
	if (message?.role === "user") return message.steering === true;
	return (
		message?.role === "custom" && message.customType === COLLAB_PROMPT_MESSAGE_TYPE && message.attribution === "user"
	);
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

function wrapSteeringUserMessage(message: SteeringUserMessage): UserMessage {
	const userMessage: UserMessage =
		message.role === "user"
			? userMessageWithoutSteering(message)
			: {
					role: "user",
					content: message.content,
					attribution: "user",
					timestamp: message.timestamp,
				};
	if (typeof message.content === "string") {
		if (message.content.length === 0) return message.role === "user" ? message : userMessage;
		return { ...userMessage, content: renderSteeringEnvelope(message.content) };
	}

	const text = getArrayContentText(message.content);
	if (text.length === 0) return message.role === "user" ? message : userMessage;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: renderSteeringEnvelope(text) }];
	content.push(...getArrayContentImages(message.content));
	return { ...userMessage, content };
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
	const removed = stripImagesFromMessageContent(message);
	// The mutated message keeps its identity across context rebuilds, so drop its
	// cached estimate/convert before the next pass counts/converts the new shape.
	if (removed > 0) invalidateMessageCache(message);
	return removed;
}

function stripImagesFromMessageContent(message: AgentMessage): number {
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
 * Replace every `ImageContent` block in already-converted LLM {@link Message}s
 * with a text placeholder, returning a new array only when something changed.
 *
 * Unlike {@link stripImagesFromMessage} (which mutates persisted `AgentMessage`s
 * in place), this operates on the ephemeral provider-request view produced by
 * {@link convertToLlm}, so history on disk keeps its images while the outbound
 * request is scrubbed. Used to keep image blocks off the wire when the active
 * model has no vision support (or `images.blockImages` is set) — e.g. after
 * switching from a vision model to a text-only one mid-session (#5400).
 *
 * Consecutive placeholder texts collapse into one so a message that was nothing
 * but images does not balloon into a run of identical notes.
 */
export function replaceLlmImagesWithText(messages: Message[], placeholder: string): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "developer" && msg.role !== "toolResult") continue;
		const content = msg.content;
		if (!Array.isArray(content) || !content.some(part => part.type === "image")) continue;
		const replaced: (TextContent | ImageContent)[] = [];
		for (const part of content) {
			if (part.type !== "image") {
				replaced.push(part);
				continue;
			}
			const prev = replaced[replaced.length - 1];
			if (prev?.type === "text" && prev.text === placeholder) continue;
			replaced.push({ type: "text", text: placeholder });
		}
		if (out === undefined) out = messages.slice();
		out[i] = { ...msg, content: replaced } as Message;
	}
	return out ?? messages;
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
	content: CustomMessageContent;
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
	content: CustomMessageContent;
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
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@oh-my-pi/pi-agent-core" {
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
	// Only GitHub Copilot rejects replayed assistant-side native history on a
	// warmed (resumed) session with HTTP 401 — that is the sole reason this strip
	// exists. For every other Responses-family provider (OpenAI, OpenAI-Codex,
	// Azure) the encrypted reasoning and native response items are self-contained
	// and MUST survive rehydration: remote compaction replays them to rebuild
	// faithful native history (user + assistant turns + encrypted reasoning), and
	// same-model live turns reuse them for prompt-cache continuity. Stripping them
	// for all providers is what left resumed sessions compacting tool-call-only
	// history with no reasoning and no assistant prose.
	if (message.provider !== "github-copilot") {
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

	// Strip the assistant-side native replay payload entirely. After rehydration
	// it belongs to a previous live Copilot connection and replaying it on a
	// warmed session causes 401 rejections. User/developer payloads are preserved
	// separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

function customMessageContentToLlmContent(content: CustomMessage["content"]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** True for a `/skill:<name>` prompt the user invoked directly (attribution `user`), as opposed to an agent/autoload injection. */
export function isUserInvokedSkillPrompt(message: CustomMessage): boolean {
	return message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user";
}

/**
 * True for a custom message that initiates a user-attributed turn: a directly
 * invoked `/skill:` prompt or a writable-collab peer's prompt. Agent redirects,
 * reminders, and auto-continues are not turn starts.
 */
export function isUserTurnInitiator(message: CustomMessage): boolean {
	return (
		isUserInvokedSkillPrompt(message) ||
		(message.customType === COLLAB_PROMPT_MESSAGE_TYPE && message.attribution === "user")
	);
}

function convertImageBearingCustomMessage(message: CustomMessage | HookMessage): Message[] | undefined {
	if (!isCustomMessageContent(message.content)) return undefined;
	if (typeof message.content === "string") return undefined;
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const imageBlocks = message.content.filter((content): content is ImageContent => content.type === "image");
	if (imageBlocks.length === 0) return undefined;

	const converted: Message[] = [];
	if (textBlocks.length > 0) {
		converted.push({
			role: "developer",
			content: textBlocks,
			attribution: message.attribution,
			timestamp: message.timestamp,
		});
	}
	converted.push({
		role: "user",
		content: [{ type: "text", text: `Images attached to ${message.customType}.` }, ...imageBlocks],
		attribution: message.attribution,
		timestamp: message.timestamp,
	});
	return converted;
}

/**
 * Per-message conversion result, keyed by message identity. `interruptedNext`
 * records the neighbor state the fragment was built against so an assistant
 * whose following {@link INTERRUPTED_THINKING_MESSAGE_TYPE} marker appears or
 * disappears is recomputed (its LLM view strips the trailing thinking run only
 * while that marker follows).
 *
 * WeakMap (not a symbol tag) is deliberate: `wrapSteeringForModel` and
 * `deobfuscateAgentMessages` spread messages into fresh variants with different
 * content; a symbol-keyed fragment would ride that spread and mis-convert the
 * copy. Identity keying keeps the cache off spread copies.
 */
interface ConvertMemoEntry {
	interruptedNext: boolean;
	fragment: Message[];
}
const convertCache = new WeakMap<AgentMessage, ConvertMemoEntry>();

// Array-level shortcuts over the per-message memo. The live agent mutates one
// `AgentMessage[]` identity across a turn: appending new messages and swapping
// the streaming tail (`context.messages[len-1] = partial → trailing`). Between
// owner invalidations (prune/shake/strip bump `convertGeneration`) and for a
// given array identity, only the last index is ever swapped and the array only
// grows — interior prefix messages are immutable. That invariant lets two
// shortcuts skip the O(N) re-walk:
//   - exact-repeat: same array, same length, same generation, same tail identity
//     → hand back the same outer array.
//   - slice-on-growth: same array, same generation, length grew → copy the
//     unchanged prefix output and reconvert only the neighbor-sensitive boundary
//     message plus the appended suffix.
// The tail-identity guard on exact-repeat catches the streaming snapshot swap
// (partial → trailing is a fresh identity), so a settled tail is never served
// from a stale mid-stream fragment.
interface ConvertArrayMemo {
	generation: number;
	length: number;
	output: Message[];
	tail: AgentMessage | undefined;
	prefixOutputLen: number;
}

let convertGeneration = 0;
const convertArrayCache = new WeakMap<AgentMessage[], ConvertArrayMemo>();

registerMessageCacheInvalidator(message => {
	convertCache.delete(message);
	convertGeneration++;
});

/** Convert one message to its LLM fragment. `interruptedNext` is true only for an
 *  assistant turn immediately followed by its interrupted-thinking marker. */
function convertOne(m: AgentMessage, interruptedNext: boolean): Message[] {
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
		case "custom": {
			if (!isCustomMessageContent(m.content)) return [];
			if (isSteeringUserMessage(m)) {
				const converted = convertMessageToLlm(wrapSteeringUserMessage(m));
				return converted ? [converted] : [];
			}
			if (isUserInvokedSkillPrompt(m)) {
				return [
					{
						role: "user",
						content: customMessageContentToLlmContent(m.content),
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			}
			const split = convertImageBearingCustomMessage(m);
			if (split) return split;
			const converted = convertMessageToLlm(m);
			return converted ? [converted] : [];
		}
		case "hookMessage": {
			if (!isCustomMessageContent(m.content)) return [];
			const split = convertImageBearingCustomMessage(m);
			if (split) return split;
			const converted = convertMessageToLlm(m);
			return converted ? [converted] : [];
		}
		case "assistant": {
			// Persisted/displayed messages retain interrupted thinking. Signed or
			// encrypted blocks replay natively; incomplete unsigned runs are
			// stripped whether or not they were long enough for a continuity note.
			const userInterrupted = m.stopReason === "aborted" && isUserInterruptAbort(m);
			const source = interruptedNext || userInterrupted ? stripDemotedThinkingForLlm(m) : m;
			if (userInterrupted && !interruptedNext && source.content.length === 0) return [];
			const converted = convertMessageToLlm(source);
			return converted ? [converted] : [];
		}
		case "branchSummary":
		case "compactionSummary":
		case "user":
		case "developer":
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
}

/** Cached per-message conversion. Reuses the stored fragment while identity and
 *  `interruptedNext` neighbor state hold; recomputes on a neighbor flip. */
function convertOneCached(m: AgentMessage, interruptedNext: boolean): Message[] {
	const cached = convertCache.get(m);
	if (cached !== undefined && cached.interruptedNext === interruptedNext) return cached.fragment;
	const fragment = convertOne(m, interruptedNext);
	convertCache.set(m, { interruptedNext, fragment });
	return fragment;
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 *
 * Settled history converts once and is reused per message identity: an
 * append-only turn on the same array re-pays only the new suffix, and an
 * unchanged re-convert of the same array hands back the same outer `Message[]`.
 * Owner mutations (prune/shake/strip-images) invalidate the affected message
 * through the shared registry before the next pass.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const len = messages.length;
	const memo = convertArrayCache.get(messages);
	const sameGeneration = memo !== undefined && memo.generation === convertGeneration;
	const tail = len > 0 ? messages[len - 1] : undefined;

	// Exact-repeat: same array, same length, same trailing identity → reuse the
	// outer array. The tail-identity check rejects the streaming snapshot swap
	// (partial → settled trailing keeps array identity/length but mints a fresh
	// tail), so a settled tail never reads a stale mid-stream fragment.
	if (sameGeneration && memo.length === len && tail === memo.tail) {
		return memo.output;
	}

	// Slice-on-growth: same array grew by append. Every interior message is
	// immutable under one array identity, so copy the unchanged prefix output
	// (messages[0 .. lastLen-1)) and reconvert only the old boundary message
	// (neighbor-sensitive: a following interrupted-thinking marker may now exist)
	// plus the appended suffix. The boundary-identity check (old tail still sits
	// at its old index) rejects an in-place interior splice-replace that grew the
	// array while swapping earlier identities, forcing a full rebuild.
	let out: Message[];
	let start: number;
	if (
		sameGeneration &&
		len > memo.length &&
		memo.length > 0 &&
		messages[memo.length - 1] === memo.tail &&
		memo.prefixOutputLen <= memo.output.length
	) {
		out = memo.output.slice(0, memo.prefixOutputLen);
		start = memo.length - 1;
	} else {
		out = [];
		start = 0;
	}

	// Output length contributed by messages[0 .. len-1), captured when the loop
	// reaches the final index so the next growth can reuse this prefix.
	let prefixOutputLen = 0;
	for (let i = start; i < len; i++) {
		if (i === len - 1) prefixOutputLen = out.length;
		const m = messages[i];
		const interruptedNext = m.role === "assistant" && followedByInterruptedThinking(messages, i);
		const fragment = convertOneCached(m, interruptedNext);
		for (const msg of fragment) out.push(msg);
	}
	if (len === 0) prefixOutputLen = 0;

	// Record for the next call's shortcuts. `out` is a fresh array (slice or new),
	// so a prior caller holding the previous memo output never sees it grow.
	convertArrayCache.set(messages, {
		generation: convertGeneration,
		length: len,
		output: out,
		tail,
		prefixOutputLen,
	});
	return out;
}
