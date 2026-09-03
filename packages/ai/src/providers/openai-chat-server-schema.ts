/**
 * ArkType schemas for the OpenAI chat-completions request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/chat — only
 * the shapes the gateway translation layer understands. Unknown fields on
 * permissive objects are accepted-and-stripped (via `"+": "delete"`) so the
 * official OpenAI SDK — which sends a growing pile of non-strict defaults (e.g.
 * `stream_options.include_obfuscation`) — does not trip 400s on shapes we simply ignore.
 */

import { type } from "@oh-my-pi/omptype";
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParams,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from "./openai-chat-wire";

// ─── User-message content parts ─────────────────────────────────────────────

export const textPartSchema = type({
	type: "'text'",
	text: "string",
});

/**
 * OpenAI documents `image_url` as either `{ url: string, detail?: ... }` or —
 * older clients — a bare string. Accept both shapes; downstream we extract a
 * URL. `detail` is accepted for forward-compat but currently dropped (pi-ai's
 * `ImageContent` has no detail field — TODO: plumb through if/when added).
 */
export const imagePartSchema = type({
	type: "'image_url'",
	image_url: type("string").or({
		url: "string",
		"detail?": "'auto' | 'low' | 'high'",
	}),
});

/** OpenAI audio input block (gpt-4o-audio). Accepted; currently dropped downstream. */
export const inputAudioPartSchema = type({
	type: "'input_audio'",
	input_audio: {
		data: "string",
		format: "'wav' | 'mp3'",
	},
});

/** OpenAI file input block (file_search / vision-document). Accepted; currently dropped downstream. */
export const filePartSchema = type({
	type: "'file'",
	file: {
		"file_id?": "string",
		"filename?": "string",
		"file_data?": "string",
	},
});

/** Replayed assistant refusal block. Accepted; currently dropped downstream. */
export const refusalPartSchema = type({
	type: "'refusal'",
	refusal: "string",
});

/**
 * Forward-compat catch-all for unknown content-part types. Matches every other
 * `{ type: string, ... }` object so a new OpenAI block kind does not 400 the
 * whole request; the walker ignores parts whose `type` it does not know.
 */
export const unknownPartSchema = type({ type: "string" });

export const userContentPartSchema = textPartSchema
	.or(imagePartSchema)
	.or(inputAudioPartSchema)
	.or(filePartSchema)
	.or(refusalPartSchema)
	.or(unknownPartSchema);

// ─── Tool calls / tools ─────────────────────────────────────────────────────

export const toolCallSchema = type({
	id: "string",
	"type?": "'function'",
	function: {
		name: "string",
		arguments: "string",
	},
});

export const toolSchema = type({
	type: "'function'",
	function: {
		name: "string >= 1",
		"description?": "string",
		"parameters?": type({ "[string]": "unknown" }),
		/** OpenAI structured-output strict mode. Accepted, not enforced upstream. */
		"strict?": "boolean",
	},
});

// ─── Tool choice ────────────────────────────────────────────────────────────

export const toolChoiceSchema = type("'auto' | 'none' | 'required'")
	.or({
		type: "'function'",
		function: { name: "string >= 1" },
	})
	.or({
		type: "'tool'",
		name: "string >= 1",
	});

// ─── Messages ───────────────────────────────────────────────────────────────

const baseContent = type("string").or(userContentPartSchema.array());
const assistantContent = baseContent.or("null");

export const systemMessageSchema = type({
	role: "'system'",
	content: baseContent,
});

export const developerMessageSchema = type({
	role: "'developer'",
	content: baseContent,
});

export const userMessageSchema = type({
	role: "'user'",
	content: baseContent,
});

export const assistantMessageSchema = type({
	role: "'assistant'",
	"content?": assistantContent,
	"tool_calls?": toolCallSchema.array(),
	// DeepSeek-style reasoning channel. The gateway emits it on the way out
	// (encodeResponse/encodeStream); accept it back so thinking-mode
	// continuations replay the model's actual reasoning instead of a
	// synthesized placeholder.
	"reasoning_content?": "string | null",
});

export const toolMessageSchema = type({
	role: "'tool'",
	"content?": baseContent,
	"tool_call_id?": "string",
	// OpenAI's wire spec omits `name` on `role:"tool"`, but in practice the
	// official Python SDK and several wrappers do send it. Accept it so we can
	// honour it downstream (Google's `functionResponse.name` is required and
	// non-empty); empty strings are coerced to undefined so the back-resolve
	// path runs.
	"name?": type("string").pipe(v => (v && v.length > 0 ? v : undefined)),
});

/**
 * Legacy `function` role (pre-tools API). Translated to a `tool` role
 * canonical message in the walker so downstream providers see one shape.
 */
export const functionMessageSchema = type({
	role: "'function'",
	name: "string",
	content: "string | null",
});

export const messageSchema = systemMessageSchema
	.or(developerMessageSchema)
	.or(userMessageSchema)
	.or(assistantMessageSchema)
	.or(toolMessageSchema)
	.or(functionMessageSchema);

// ─── Stream options ─────────────────────────────────────────────────────────

/**
 * Permissive: the official OpenAI SDK sets `include_obfuscation: false` by
 * default. We only consume `include_usage`, so unknown keys are silently
 * stripped rather than 400'd.
 */
export const streamOptionsSchema = type({
	"+": "delete",
	"include_usage?": "boolean",
});

// ─── Stop sequences ─────────────────────────────────────────────────────────

// OpenAI rejects > 4 stop strings; mirror that at the gateway.
export const stopSchema = type("string").or("string[] <= 4");

// ─── Top-level request ──────────────────────────────────────────────────────

export const openaiChatRequestSchema = type({
	model: "string >= 1",
	messages: messageSchema.array(),
	"tools?": toolSchema.array(),
	"tool_choice?": toolChoiceSchema,
	"max_tokens?": "number",
	"max_completion_tokens?": "number",
	"temperature?": "number",
	"top_p?": "number",
	"stop?": stopSchema,
	"stream?": "boolean",
	"stream_options?": streamOptionsSchema,

	// ── Typed first-class passthroughs (now consumed by the walker) ────────
	"response_format?": "unknown",
	"seed?": "number",
	"presence_penalty?": "number",
	"frequency_penalty?": "number",
	"logit_bias?": type({ "[string]": "number" }),
	"user?": "string",
	"reasoning_effort?": "'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'",
	"parallel_tool_calls?": "boolean",
	"service_tier?": "'auto' | 'default' | 'flex' | 'scale' | 'priority'",
	"metadata?": type({ "[string]": "unknown" }),

	// ── Accept-and-ignore passthroughs ─────────────────────────────────────
	// Forward acceptance only: validating these would 400 on shapes the
	// gateway has no opinion on. The downstream provider does the real check.
	"logprobs?": "unknown",
	"top_logprobs?": "unknown",
	"prediction?": "unknown",
	"modalities?": "unknown",
	"audio?": "unknown",
	"store?": "unknown",
	"prompt_cache_key?": "unknown",
	"safety_identifier?": "unknown",
	"n?": "unknown",
	"web_search_options?": "unknown",
});

/**
 * Public types are sourced from the OpenAI SDK so the gateway stays in
 * lock-step with the canonical API surface; the schemas above are runtime
 * validators for the subset we actually accept.
 */
export type OpenAIChatRequest = ChatCompletionCreateParams;
export type OpenAIChatMessage = ChatCompletionMessageParam;
export type OpenAIChatToolCall = ChatCompletionMessageToolCall;
export type OpenAIChatTool = ChatCompletionTool;
export type OpenAIChatToolChoice = ChatCompletionToolChoiceOption;
export type OpenAIChatContentPart = ChatCompletionContentPart;
