/**
 * ArkType schemas for the OpenAI Responses API request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/responses.
 *
 * Unsupported / opaque controls (background/include/metadata/prompt/…) are
 * accepted as `"unknown"` optional so we silently ignore rather than 400.
 * Real clients (codex, openai-python, llm-git) routinely send these and a 400
 * is a worse outcome than dropping them on the floor.
 */

import { type } from "@oh-my-pi/omptype";
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
	"detail?": "'auto' | 'low' | 'high' | 'original' | null",
	"image_url?": "string | null",
	"file_id?": "string | null",
}).narrow((v, ctx) => {
	return (
		(typeof v.image_url === "string" && v.image_url.length > 0) ||
		(typeof v.file_id === "string" && v.file_id.length > 0) ||
		ctx.mustBe("at least one of `image_url` or `file_id` for input_image")
	);
});

const inputFileBlockSchema = type({
	type: "'input_file'",
	"detail?": "'low' | 'high'",
	"file_id?": "string | null",
	"filename?": "string | null",
	"file_data?": "string | null",
	"file_url?": "string | null",
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

// The Responses API defines multimodal function output arrays in terms of
// input text and image content. Keep output text/refusal blocks for
// compatibility with older Codex clients.
const functionCallOutputContentBlockSchema = inputTextSchema
	.or(plainTextSchema)
	.or(inputImageBlockSchema)
	.or(outputTextSchema)
	.or(outputRefusalSchema);

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
	// Function outputs may carry text or image input blocks.
	"output?": type("string").or(functionCallOutputContentBlockSchema.array()),
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
	output: type("string").or(functionCallOutputContentBlockSchema.array()),
});

const computerSafetyCheckSchema = type({
	id: "string >= 1",
	"code?": "string | null",
	"message?": "string | null",
});

// Desktop coordinates cross the native boundary as i32 and must be
// nonnegative; scroll deltas are signed i32. Out-of-range numbers fail
// closed here instead of truncating downstream.
const computerCoordinate = type("0 <= number.integer <= 2147483647");
const computerScrollDelta = type("-2147483648 <= number.integer <= 2147483647");

const computerClickActionSchema = type({
	type: "'click'",
	button: "'left' | 'right' | 'wheel' | 'back' | 'forward'",
	x: computerCoordinate,
	y: computerCoordinate,
	"keys?": "string[] | null",
});

const computerDoubleClickActionSchema = type({
	type: "'double_click'",
	x: computerCoordinate,
	y: computerCoordinate,
	keys: "string[] | null",
});

const computerDragActionSchema = type({
	type: "'drag'",
	path: type({ x: computerCoordinate, y: computerCoordinate }).array(),
	"keys?": "string[] | null",
});

const computerKeypressActionSchema = type({ type: "'keypress'", keys: "string[]" });
const computerMoveActionSchema = type({
	type: "'move'",
	x: computerCoordinate,
	y: computerCoordinate,
	"keys?": "string[] | null",
});
const computerScreenshotActionSchema = type({ type: "'screenshot'" });
const computerScrollActionSchema = type({
	type: "'scroll'",
	x: computerCoordinate,
	y: computerCoordinate,
	scroll_x: computerScrollDelta,
	scroll_y: computerScrollDelta,
	"keys?": "string[] | null",
});
const computerTypeActionSchema = type({ type: "'type'", text: "string" });
const computerWaitActionSchema = type({ type: "'wait'" });

const computerActionSchema = computerClickActionSchema
	.or(computerDoubleClickActionSchema)
	.or(computerDragActionSchema)
	.or(computerKeypressActionSchema)
	.or(computerMoveActionSchema)
	.or(computerScreenshotActionSchema)
	.or(computerScrollActionSchema)
	.or(computerTypeActionSchema)
	.or(computerWaitActionSchema);

const computerCallItemSchema = type({
	type: "'computer_call'",
	id: "string >= 1",
	call_id: "string >= 1",
	"action?": computerActionSchema,
	"actions?": computerActionSchema.array(),
	pending_safety_checks: computerSafetyCheckSchema.array(),
	status: "'in_progress' | 'completed' | 'incomplete'",
}).narrow((v, ctx) => v.action !== undefined || v.actions !== undefined || ctx.mustBe("`action` or `actions`"));

const computerScreenshotImageUrlSchema = type({
	type: "'computer_screenshot'",
	image_url: "string",
});

const computerScreenshotFileIdSchema = type({
	type: "'computer_screenshot'",
	file_id: "string",
});

const computerCallOutputItemSchema = type({
	type: "'computer_call_output'",
	"id?": "string | null",
	call_id: "string >= 1",
	output: computerScreenshotImageUrlSchema.or(computerScreenshotFileIdSchema),
	"acknowledged_safety_checks?": computerSafetyCheckSchema.array().or(type("null")),
	"status?": "'in_progress' | 'completed' | 'incomplete' | 'failed' | null",
});

const BRIDGED_INPUT_ITEM_TYPES: Record<string, true> = {
	message: true,
	reasoning: true,
	function_call: true,
	function_call_output: true,
	custom_tool_call: true,
	custom_tool_call_output: true,
	computer_call: true,
	computer_call_output: true,
};

const unbridgedInputItemSchema = type({ type: "string" }).narrow((value, ctx) =>
	value.type in BRIDGED_INPUT_ITEM_TYPES ? ctx.mustBe("a valid bridged Responses input item") : true,
);

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
	.or(computerCallItemSchema)
	.or(computerCallOutputItemSchema)
	// Tolerated but not bridged (file_search_call, web_search_call, …).
	.or(unbridgedInputItemSchema);

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
export type OpenAIResponsesComputerCallItem = typeof computerCallItemSchema.infer;
export type OpenAIResponsesComputerCallOutputItem = typeof computerCallOutputItemSchema.infer;
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

const computerToolSchema = type({ type: "'computer'" });

const BRIDGED_TOOL_TYPES: Record<string, true> = { function: true, computer: true };

// Built-in / hosted tool entries (web_search_preview, file_search, …) — accepted
// but skipped by the walker.
const builtinToolSchema = type({ type: "string" }).narrow((value, ctx) =>
	value.type in BRIDGED_TOOL_TYPES ? ctx.mustBe("a valid bridged Responses tool") : true,
);

// ─── Tool choice ────────────────────────────────────────────────────────────

const hostedToolType = type(
	"'web_search_preview' | 'file_search' | 'computer' | 'computer_use_preview' | 'code_interpreter' | 'image_generation' | 'mcp'",
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
	"tools?": toolSchema.or(computerToolSchema).or(builtinToolSchema).array(),
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
	// `reasoning.encrypted_content` and computer screenshot refs must survive
	// the gateway bridge so the resolved Responses transport can request them.
	"background?": "unknown",
	"include?": "string[] | null",
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
