/**
 * ArkType schemas for the OpenAI Responses API request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/responses.
 *
 * Unsupported / opaque controls (background/include/metadata/prompt/…) are
 * accepted as `"unknown"` optional so we silently ignore rather than 400.
 * Real clients (codex, openai-python, llm-git) routinely send these and a 400
 * is a worse outcome than dropping them on the floor.
 */

import { type } from "arktype";
import type {
	EasyInputMessage,
	ResponseCreateParams,
	ResponseFunctionToolCall,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	Tool as ResponsesTool,
} from "./openai-responses-wire";

// ─── Input content blocks ───────────────────────────────────────────────────

const inputTextSchema = type({
	type: "'input_text'",
	text: "string",
});

const plainTextSchema = type({
	type: "'text'",
	text: "string",
});

const inputImageBlockSchema = type({
	type: "'input_image'",
	"detail?": "'auto' | 'low' | 'high'",
	"image_url?": "string",
	"file_id?": "string",
}).narrow((v, ctx) => {
	return (
		typeof v.image_url === "string" ||
		typeof v.file_id === "string" ||
		ctx.mustBe("at least one of `image_url` or `file_id` for input_image")
	);
});

const inputFileBlockSchema = type({
	type: "'input_file'",
	"file_id?": "string",
	"filename?": "string",
	"file_data?": "string",
});

const outputTextSchema = type({
	type: "'output_text'",
	text: "string",
});

const outputRefusalSchema = type({
	type: "'refusal'",
	refusal: "string",
});

const summaryTextSchema = type({
	type: "'summary_text'",
	text: "string",
});

const reasoningTextSchema = type({
	type: "'reasoning_text'",
	text: "string",
});

const inputContentBlockSchema = inputTextSchema.or(plainTextSchema).or(inputImageBlockSchema).or(inputFileBlockSchema);

const outputContentBlockSchema = outputTextSchema.or(plainTextSchema).or(outputRefusalSchema);

// ─── Input items ────────────────────────────────────────────────────────────

const userMessageItemSchema = type({
	"type?": "'message'",
	role: "'user' | 'developer'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const systemMessageItemSchema = type({
	"type?": "'message'",
	role: "'system'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const assistantMessageItemSchema = type({
	"type?": "'message'",
	"id?": "string",
	role: "'assistant'",
	"content?": type("string").or(outputContentBlockSchema.array()),
	"status?": "'in_progress' | 'completed' | 'incomplete'",
	"phase?": "'commentary' | 'final_answer' | null",
});

const reasoningItemSchema = type({
	type: "'reasoning'",
	"id?": "string",
	"summary?": summaryTextSchema.array(),
	"content?": reasoningTextSchema.array(),
});

const functionCallItemSchema = type({
	type: "'function_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",
	"arguments?": "string",
});

const functionCallOutputItemSchema = type({
	type: "'function_call_output'",
	call_id: "string >= 1",
	// Codex CLI replays multimodal tool results in array form (text + refusal).
	"output?": type("string").or(outputContentBlockSchema.array()),
});

const customToolCallItemSchema = type({
	type: "'custom_tool_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",
	// Raw input string — NOT JSON.stringified. apply_patch flow streams a
	// freeform body and reading it as JSON would corrupt it.
	input: "string",
});

const customToolCallOutputItemSchema = type({
	type: "'custom_tool_call_output'",
	call_id: "string >= 1",
	output: "string",
});

/**
 * Direct mapping to standard types.
 */
export const inputItemSchema = userMessageItemSchema
	.or(systemMessageItemSchema)
	.or(assistantMessageItemSchema)
	.or(reasoningItemSchema)
	.or(functionCallItemSchema)
	.or(functionCallOutputItemSchema)
	.or(customToolCallItemSchema)
	.or(customToolCallOutputItemSchema)
	// Tolerated but not bridged (file_search_call, web_search_call, …).
	.or(type({ type: "string" }));

// Variant types alias the canonical SDK union members so the walker can
// narrow them cleanly. The convenience "message" shape (no `type` field) maps
// to EasyInputMessage; the explicit form maps to ResponseInputItem.Message.
export type OpenAIResponsesUserItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesSystemItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesAssistantItem = EasyInputMessage | ResponseOutputMessage;
export type OpenAIResponsesReasoningItem = ResponseReasoningItem;
export type OpenAIResponsesFunctionCallItem = ResponseFunctionToolCall;
export type OpenAIResponsesFunctionCallOutputItem = ResponseInputItem.FunctionCallOutput;

/** Inferred shape of the custom tool call input item (no canonical SDK alias). */
export type OpenAIResponsesCustomToolCallItem = typeof customToolCallItemSchema.infer;
export type OpenAIResponsesCustomToolCallOutputItem = typeof customToolCallOutputItemSchema.infer;
export type OpenAIResponsesInputImageBlock = typeof inputImageBlockSchema.infer;
export type OpenAIResponsesInputFileBlock = typeof inputFileBlockSchema.infer;
export type OpenAIResponsesOutputRefusalBlock = typeof outputRefusalSchema.infer;

// ─── Tools ──────────────────────────────────────────────────────────────────

export const toolSchema = type({
	type: "'function'",
	name: "string >= 1",
	"description?": "string",
	"parameters?": type({ "[string]": "unknown" }),
	"strict?": "boolean",
});

// Built-in / hosted tool entries (web_search_preview, file_search, …) — accepted
// but skipped by the walker.
const builtinToolSchema = type({
	type: "string",
});

// ─── Tool choice ────────────────────────────────────────────────────────────

const hostedToolType = type(
	"'web_search_preview' | 'file_search' | 'computer_use_preview' | 'code_interpreter' | 'image_generation' | 'mcp'",
);

const allowedToolEntrySchema = type({
	type: "string",
	"name?": "string",
});

export const toolChoiceSchema = type("'auto' | 'none' | 'required'")
	.or(
		type({
			type: "'function'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: "'custom'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: hostedToolType,
		}),
	)
	.or(
		type({
			type: "'allowed_tools'",
			mode: "'auto' | 'required'",
			tools: allowedToolEntrySchema.array(),
		}),
	);

// ─── Reasoning config ───────────────────────────────────────────────────────

export const reasoningConfigSchema = type({
	"effort?": "string",
	// `none` maps to hideThinkingSummary; auto/concise/detailed mean "show
	// summary". pi-ai has no per-level plumbing for the latter — walker logs
	// once and treats them as default.
	"summary?": "'auto' | 'concise' | 'detailed' | 'none'",
});

// ─── Stop ───────────────────────────────────────────────────────────────────

export const stopSchema = type("string | string[] | null");

// ─── Top-level request ──────────────────────────────────────────────────────

export const openaiResponsesRequestSchema = type({
	model: "string >= 1",
	"input?": type("string").or(inputItemSchema.array()),
	"instructions?": "string | null",
	"tools?": toolSchema.or(builtinToolSchema).array(),
	"tool_choice?": toolChoiceSchema,
	"max_output_tokens?": "number",
	"temperature?": "number",
	"top_p?": "number",
	"stop?": stopSchema,
	"stream?": "boolean",
	"reasoning?": reasoningConfigSchema,
	"store?": "boolean",
	"previous_response_id?": "string",
	"parallel_tool_calls?": "boolean",
	"prompt_cache_key?": "string",
	"metadata?": "unknown",
	"user?": "string",
	"service_tier?": "string",
	"presence_penalty?": "number",
	"frequency_penalty?": "number",
	// Accepted-but-ignored: include `reasoning.encrypted_content` is the canonical
	// way to request reasoning replay — silently accept and drop.
	"background?": "unknown",
	"include?": "unknown",
	"prompt?": "unknown",
	"safety_identifier?": "unknown",
	"text?": "unknown",
	"top_logprobs?": "unknown",
	"truncation?": "unknown",
});

/**
 * Public types are sourced from the OpenAI SDK so the gateway stays in
 * lock-step with the canonical API surface; the schemas above are runtime
 * validators for the subset we actually accept.
 */
export type OpenAIResponsesRequest = ResponseCreateParams;
export type OpenAIResponsesInputItem = ResponseInputItem;
export type OpenAIResponsesTool = ResponsesTool;
export type OpenAIResponsesToolChoice = NonNullable<ResponseCreateParams["tool_choice"]>;
export type OpenAIResponsesInputContent = ResponseInputContent;
export type OpenAIResponsesOutputContent = ResponseOutputMessage["content"][number];
