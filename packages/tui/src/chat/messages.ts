import type { AssistantMessage, ImageContent, MessageAttribution, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import type { OutputMeta } from "../tools/output-meta";
import type { BranchSummaryMessage, CompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";

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
export { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "@oh-my-pi/pi-wire";
export type { BranchSummaryMessage, CompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";

export const BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";

export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

/** Custom message type for the transient Vibe mode directive. */
export const VIBE_MODE_CONTEXT_MESSAGE_TYPE = "vibe-mode-context";

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

/** Details persisted on a `/tan` background-dispatch breadcrumb. */
export interface BackgroundTanDispatchDetails {
	jobId: string;
	work: string;
	/** Forked clone session file, named `<agentId>.jsonl`; the Agent Hub reads its transcript. */
	sessionFile: string;
}

export interface SkillPromptSkill {
	name: string;
	path: string;
	lineCount: number;
}

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	/** The draft as submitted with its `/skill:<name>` token in place. A leading
	 *  token renders as a skill callout, a mid-prompt token as an inline chip in
	 *  a plain user bubble. Absent on sessions recorded before chips existed. */
	prompt?: string;
	lineCount: number;
	/** Every skill this prompt loaded, in draft order. Absent on sessions
	 *  recorded before multi-skill prompts; consumers fall back to
	 *  `name`/`path`/`lineCount`. */
	skills?: SkillPromptSkill[];
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
	/** Images extracted from terminal graphics in the command's stdout. */
	images?: ImageContent[];
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
	/** If true, this message is excluded from LLM context ($ prefix) */
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

export type AdvisorSeverity = "nit" | "concern" | "blocker";

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/** Custom message type for supervised process completions. */
export const LAUNCH_COMPLETION_MESSAGE_TYPE = "launch-completion";
