/**
 * Anthropic Messages API wire types.
 *
 * Hand-maintained against https://docs.anthropic.com/en/api/messages so pi-ai
 * does not depend on `@anthropic-ai/sdk` for type information. Only the shapes
 * this package actually reads or writes are modeled; fields we never touch are
 * intentionally omitted. Names mirror the SDK so call sites read the same.
 *
 * Unlike the SDK, beta fields pi-ai uses (`speed`, `context_management`,
 * `output_config.effort`/`task_budget`, `thinking.display`, cache-control
 * `scope`, tool `strict`/`eager_input_streaming`, mid-conversation `system`
 * role) are first-class here instead of being patched in via casts.
 */
import type { ProviderInputTransformation, TokenTaskBudget } from "../types";
import { isRecord } from "../utils";

// ─── Cache control ──────────────────────────────────────────────────────────

/** Beta enabling preserved-thinking block controls and transformation reports. */
export const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/** Ephemeral prefix-cache breakpoint marker. */
export type CacheControlEphemeral = {
	type: "ephemeral";
	ttl?: "1h" | "5m";
	/** Claude Code prompt-caching-scope beta: shares the breakpoint across sessions. */
	scope?: "global";
};

// ─── Content blocks (request) ───────────────────────────────────────────────

export type Base64ImageSource = {
	type: "base64";
	media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	data: string;
};

export type URLImageSource = { type: "url"; url: string };

export type FileImageSource = { type: "file"; file_id: string };

export type ImageSource = Base64ImageSource | URLImageSource | FileImageSource;

export type TextBlockParam = {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral | null;
};

export type ImageBlockParam = {
	type: "image";
	source: ImageSource;
	cache_control?: CacheControlEphemeral | null;
};

export type ToolUseBlockParam = {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
	cache_control?: CacheControlEphemeral | null;
};

export type ToolResultBlockParam = {
	type: "tool_result";
	tool_use_id: string;
	content?: string | Array<TextBlockParam | ImageBlockParam>;
	is_error?: boolean;
	cache_control?: CacheControlEphemeral | null;
};

/** Anthropic-executed server tool call replayed inside an assistant turn. */
export type ServerToolUseBlockParam = {
	type: "server_tool_use";
	id: string;
	name: string;
	input?: Record<string, unknown> | null;
	[key: string]: unknown;
};

/** Web-search server-tool call whose matching result is replayable by omp. */
export type WebSearchServerToolUseBlockParam = ServerToolUseBlockParam & { name: "web_search" };

/** Tool-search server-tool call whose matching result is replayable by omp. */
export type ToolSearchServerToolUseBlockParam = ServerToolUseBlockParam & {
	name: "tool_search_tool_regex" | "tool_search_tool_bm25";
};

/** Native web-search result replayed inside an assistant turn. */
export type WebSearchToolResultBlockParam = {
	type: "web_search_tool_result";
	tool_use_id: string;
	content: unknown;
	[key: string]: unknown;
};

/** Native tool-search result replayed inside an assistant turn. */
export type ToolSearchToolResultBlockParam = {
	type: "tool_search_tool_result";
	tool_use_id: string;
	content: unknown;
	[key: string]: unknown;
};

export type ToolChangeReferenceParam = {
	type: "tool_reference";
	name: string;
};

export type ToolAdditionBlockParam = {
	type: "tool_addition";
	tool: ToolChangeReferenceParam;
};

export type ToolRemovalBlockParam = {
	type: "tool_removal";
	tool: ToolChangeReferenceParam;
};

/** Anthropic server-tool history variants omp can replay atomically. */
export type AnthropicServerToolHistoryBlockParam =
	| WebSearchServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchServerToolUseBlockParam
	| ToolSearchToolResultBlockParam;

/** True when a block is complete Anthropic server-tool history omp can replay. */
export function isAnthropicServerToolHistoryBlock(block: {
	type: string;
	name?: unknown;
	id?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
}): block is AnthropicServerToolHistoryBlockParam {
	if (block.type === "server_tool_use") {
		const supportedName =
			block.name === "web_search" ||
			block.name === "tool_search_tool_regex" ||
			block.name === "tool_search_tool_bm25";
		return supportedName && typeof block.id === "string" && block.id.length > 0;
	}
	if (block.type === "web_search_tool_result" || block.type === "tool_search_tool_result") {
		return typeof block.tool_use_id === "string" && block.tool_use_id.length > 0 && Object.hasOwn(block, "content");
	}
	return false;
}

export type ThinkingBlockParam = {
	type: "thinking";
	thinking: string;
	signature: string;
};

export type RedactedThinkingBlockParam = {
	type: "redacted_thinking";
	data: string;
};

/**
 * Server-side fallback beta boundary marker (server-side-fallback-2026-06-01).
 * Emitted by the API mid-stream when a classifier block on the requested
 * model is retried on a fallback model. Only the official Anthropic
 * endpoint accepts this block on replay — cross-provider hops MUST strip it.
 */
export type FallbackBlockParam = {
	type: "fallback";
	from: { model: string };
	to: { model: string };
};

export type ContentBlockParam =
	| TextBlockParam
	| ImageBlockParam
	| ToolUseBlockParam
	| ToolResultBlockParam
	| ServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchToolResultBlockParam
	| ToolAdditionBlockParam
	| ToolRemovalBlockParam
	| ThinkingBlockParam
	| RedactedThinkingBlockParam
	| FallbackBlockParam;

/**
 * A single conversation turn.
 *
 * `system` is the Opus 4.8+ mid-conversation system role
 * (`mid-conversation-system-2026-04-07` beta); the public API otherwise only
 * accepts `user` / `assistant`.
 */
export type MessageParam = {
	role: "user" | "assistant" | "system";
	content: string | ContentBlockParam[];
	/** Turn-scoped system-message lifetime. */
	clear_at?: "never" | "next_user_message";
	/** Per-message effort override. */
	output_config?: OutputConfig;
};

// ─── Tools ──────────────────────────────────────────────────────────────────

export type ToolInputSchema = {
	type: "object";
	properties?: unknown | null;
	required?: string[] | null;
	[k: string]: unknown;
};

export type Tool = {
	name: string;
	description?: string;
	input_schema: ToolInputSchema;
	cache_control?: CacheControlEphemeral | null;
	/** Structured-outputs beta: enforce the schema as a strict grammar. */
	strict?: boolean;
	/** Fine-grained tool streaming beta: stream tool input as it is generated. */
	eager_input_streaming?: boolean;
	/** Withhold this tool until a later `tool_addition` block references it. */
	defer_loading?: boolean;
};

export type ToolChoiceAuto = { type: "auto"; disable_parallel_tool_use?: boolean };
export type ToolChoiceAny = { type: "any"; disable_parallel_tool_use?: boolean };
export type ToolChoiceTool = { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
export type ToolChoiceNone = { type: "none" };

export type ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | ToolChoiceNone;

// ─── Request ────────────────────────────────────────────────────────────────

export type Metadata = { user_id?: string | null };

export type ThinkingBlockBinding = {
	prefix_mismatch_behavior: "drop_block" | "error";
};

export type ThinkingConfigEnabled = {
	type: "enabled";
	budget_tokens: number;
	/** Opus 4.7+ reasoning display mode. */
	display?: "summarized" | "omitted";
	/** Preserved-thinking prefix mismatch policy. */
	block_binding?: ThinkingBlockBinding;
};

export type ThinkingConfigDisabled = { type: "disabled" };

export type ThinkingConfigAdaptive = {
	type: "adaptive";
	/** Opus 4.7+ reasoning display mode. */
	display?: "summarized" | "omitted";
	/** Preserved-thinking prefix mismatch policy. */
	block_binding?: ThinkingBlockBinding;
};

export type ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled | ThinkingConfigAdaptive;

export type OutputConfig = {
	/** Adaptive-thinking effort level (effort beta). */
	effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** Task-budgets beta. */
	task_budget?: TokenTaskBudget | null;
};

/**
 * Per-attempt override entry in `MessageCreateParams.fallbacks`
 * (server-side-fallback-2026-06-01 beta). Every field except `model`
 * mirrors a top-level control the beta allows re-specifying per attempt.
 */
export type FallbackParam = {
	model: string;
	max_tokens?: number;
	thinking?: ThinkingConfigParam;
	output_config?: OutputConfig;
	speed?: "fast";
};

/** Claude Code context-management beta payload. */
export type ContextManagement = {
	edits: Array<{ type: "clear_thinking_20251015"; keep: "all" }>;
};

export type MessageCreateParams = {
	model: string;
	messages: MessageParam[];
	max_tokens: number;
	system?: string | TextBlockParam[];
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: Tool[];
	tool_choice?: ToolChoice;
	metadata?: Metadata;
	thinking?: ThinkingConfigParam;
	output_config?: OutputConfig;
	/** Fast-mode beta: realization of priority service tier. */
	speed?: "fast";
	/** Claude Code context-management beta. */
	context_management?: ContextManagement;
	/** Google Cloud rawPredict carries Anthropic beta names in the body. */
	anthropic_beta?: string[];
	/**
	 * Server-side fallback beta chain — up to three fallback models the API
	 * retries when a classifier blocks the primary. Required companion beta
	 * header: `server-side-fallback-2026-06-01`.
	 */
	fallbacks?: FallbackParam[];
};

export type MessageCreateParamsStreaming = MessageCreateParams & { stream: true };

// ─── Response / usage ───────────────────────────────────────────────────────

export type StopReason =
	| "end_turn"
	| "max_tokens"
	| "stop_sequence"
	| "tool_use"
	| "pause_turn"
	| "refusal"
	| "sensitive"
	| "model_context_window_exceeded";

export type CacheCreation = {
	ephemeral_5m_input_tokens?: number | null;
	ephemeral_1h_input_tokens?: number | null;
};

export type ServerToolUsage = {
	web_search_requests?: number | null;
	web_fetch_requests?: number | null;
};

/**
 * Per-attempt token accounting inside a multi-run turn
 * (server-side-fallback-2026-06-01). Populated whenever a fallback chain
 * ran, including sticky-served turns with no `fallback` content block.
 * A `fallback_message` entry is the definitive "served by fallback" signal.
 */
export type UsageIteration = {
	type?: "message" | "fallback_message" | string;
	model?: string | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

export type Usage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: CacheCreation | null;
	server_tool_use?: ServerToolUsage | null;
	iterations?: UsageIteration[] | null;
};

/** The `message` envelope carried by `message_start`. */
export type InputTransformation = {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
};

/** Parse Anthropic's forward-compatible input transformation list. */
export function parseAnthropicInputTransformations(value: unknown): ProviderInputTransformation[] {
	if (!Array.isArray(value)) return [];
	const transformations: ProviderInputTransformation[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.type !== "string") continue;
		transformations.push({ ...entry, type: entry.type });
	}
	return transformations;
}

export type ResponseMessage = {
	id: string;
	type?: "message";
	role?: "assistant";
	model?: string;
	content?: unknown[];
	stop_reason?: StopReason | null;
	stop_sequence?: string | null;
	input_transformations?: InputTransformation[];
	usage: Usage;
};

// ─── Stream events ──────────────────────────────────────────────────────────

/** `content_block` payload carried by `content_block_start`. */
export type ResponseContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature?: string }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> | null }
	| ServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchToolResultBlockParam
	| { type: "fallback"; from: { model: string }; to: { model: string } };

export type ContentBlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "input_json_delta"; partial_json: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "signature_delta"; signature: string };

export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
};

export type MessageDelta = {
	stop_reason?: StopReason | null;
	stop_sequence?: string | null;
	stop_details?: StopDetails | null;
	input_transformations?: InputTransformation[];
};

export type RawMessageStartEvent = { type: "message_start"; message: ResponseMessage };
export type RawContentBlockStartEvent = {
	type: "content_block_start";
	index: number;
	content_block: ResponseContentBlock;
};
export type RawContentBlockDeltaEvent = { type: "content_block_delta"; index: number; delta: ContentBlockDelta };
export type RawContentBlockStopEvent = { type: "content_block_stop"; index: number };
export type RawMessageDeltaEvent = { type: "message_delta"; delta: MessageDelta; usage: Usage };
export type RawMessageStopEvent = { type: "message_stop" };

export type RawMessageStreamEvent =
	| RawMessageStartEvent
	| RawContentBlockStartEvent
	| RawContentBlockDeltaEvent
	| RawContentBlockStopEvent
	| RawMessageDeltaEvent
	| RawMessageStopEvent;
