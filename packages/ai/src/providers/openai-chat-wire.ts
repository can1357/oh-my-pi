/**
 * OpenAI Chat Completions API wire types.
 *
 * Vendored from openai-node v6.42.0 (Apache-2.0), trimmed to the streaming
 * wire surface pi-ai speaks. Field names, optionality, and union membership
 * mirror the SDK exactly; names are identical to the SDK exports so call
 * sites only swap import paths. Nested SDK namespaces (e.g.
 * `ChatCompletionChunk.Choice.Delta`) are flattened into prefixed interface
 * names (`ChatCompletionChunkChoiceDelta`).
 *
 * Fields marked "deprecated by OpenAI" reflect the upstream API contract;
 * they are kept because compatible providers still emit them on the wire.
 */

// ─── Shared types (openai/resources/shared) ─────────────────────────────────

export type ChatModel =
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.4-nano"
	| "gpt-5.4-mini-2026-03-17"
	| "gpt-5.4-nano-2026-03-17"
	| "gpt-5.3-chat-latest"
	| "gpt-5.2"
	| "gpt-5.2-2025-12-11"
	| "gpt-5.2-chat-latest"
	| "gpt-5.2-pro"
	| "gpt-5.2-pro-2025-12-11"
	| "gpt-5.1"
	| "gpt-5.1-2025-11-13"
	| "gpt-5.1-codex"
	| "gpt-5.1-mini"
	| "gpt-5.1-chat-latest"
	| "gpt-5"
	| "gpt-5-mini"
	| "gpt-5-nano"
	| "gpt-5-2025-08-07"
	| "gpt-5-mini-2025-08-07"
	| "gpt-5-nano-2025-08-07"
	| "gpt-5-chat-latest"
	| "gpt-4.1"
	| "gpt-4.1-mini"
	| "gpt-4.1-nano"
	| "gpt-4.1-2025-04-14"
	| "gpt-4.1-mini-2025-04-14"
	| "gpt-4.1-nano-2025-04-14"
	| "o4-mini"
	| "o4-mini-2025-04-16"
	| "o3"
	| "o3-2025-04-16"
	| "o3-mini"
	| "o3-mini-2025-01-31"
	| "o1"
	| "o1-2024-12-17"
	| "o1-preview"
	| "o1-preview-2024-09-12"
	| "o1-mini"
	| "o1-mini-2024-09-12"
	| "gpt-4o"
	| "gpt-4o-2024-11-20"
	| "gpt-4o-2024-08-06"
	| "gpt-4o-2024-05-13"
	| "gpt-4o-audio-preview"
	| "gpt-4o-audio-preview-2024-10-01"
	| "gpt-4o-audio-preview-2024-12-17"
	| "gpt-4o-audio-preview-2025-06-03"
	| "gpt-4o-mini-audio-preview"
	| "gpt-4o-mini-audio-preview-2024-12-17"
	| "gpt-4o-search-preview"
	| "gpt-4o-mini-search-preview"
	| "gpt-4o-search-preview-2025-03-11"
	| "gpt-4o-mini-search-preview-2025-03-11"
	| "chatgpt-4o-latest"
	| "codex-mini-latest"
	| "gpt-4o-mini"
	| "gpt-4o-mini-2024-07-18"
	| "gpt-4-turbo"
	| "gpt-4-turbo-2024-04-09"
	| "gpt-4-0125-preview"
	| "gpt-4-turbo-preview"
	| "gpt-4-1106-preview"
	| "gpt-4-vision-preview"
	| "gpt-4"
	| "gpt-4-0314"
	| "gpt-4-0613"
	| "gpt-4-32k"
	| "gpt-4-32k-0314"
	| "gpt-4-32k-0613"
	| "gpt-3.5-turbo"
	| "gpt-3.5-turbo-16k"
	| "gpt-3.5-turbo-0301"
	| "gpt-3.5-turbo-0613"
	| "gpt-3.5-turbo-1106"
	| "gpt-3.5-turbo-0125"
	| "gpt-3.5-turbo-16k-0613";

export interface FunctionDefinition {
	/** Function name: a-z, A-Z, 0-9, underscores and dashes, max length 64. */
	name: string;
	/** What the function does; used by the model to choose when/how to call it. */
	description?: string;
	/** Parameters as a JSON Schema object. Omitting defines an empty parameter list. */
	parameters?: FunctionParameters;
	/** Enable strict schema adherence (Structured Outputs subset of JSON Schema). */
	strict?: boolean | null;
}

/** Function parameters described as a JSON Schema object. */
export type FunctionParameters = {
	[key: string]: unknown;
};

/** Up to 16 key-value string pairs attached to an object. Keys ≤64 chars, values ≤512. */
export type Metadata = {
	[key: string]: string;
};

/** Constrains effort on reasoning for reasoning models. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

/** JSON object response format (older JSON mode). */
export interface ResponseFormatJSONObject {
	/** Always `json_object`. */
	type: "json_object";
}

/** JSON Schema response format (Structured Outputs). */
export interface ResponseFormatJSONSchema {
	/** Structured Outputs configuration options, including a JSON Schema. */
	json_schema: ResponseFormatJSONSchemaJSONSchema;
	/** Always `json_schema`. */
	type: "json_schema";
}

/** SDK `ResponseFormatJSONSchema.JSONSchema`. */
export interface ResponseFormatJSONSchemaJSONSchema {
	/** Response format name: a-z, A-Z, 0-9, underscores and dashes, max length 64. */
	name: string;
	/** What the response format is for. */
	description?: string;
	/** The schema for the response format, as a JSON Schema object. */
	schema?: {
		[key: string]: unknown;
	};
	/** Enable strict schema adherence when generating the output. */
	strict?: boolean | null;
}

/** Default text response format. */
export interface ResponseFormatText {
	/** Always `text`. */
	type: "text";
}

// ─── Usage (openai/resources/completions) ───────────────────────────────────

/** Usage statistics for the completion request. */
export interface CompletionUsage {
	/** Number of tokens in the generated completion. */
	completion_tokens: number;
	/** Number of tokens in the prompt. */
	prompt_tokens: number;
	/** Total number of tokens used in the request (prompt + completion). */
	total_tokens: number;
	/** Breakdown of tokens used in a completion. */
	completion_tokens_details?: CompletionUsageCompletionTokensDetails;
	/** Breakdown of tokens used in the prompt. */
	prompt_tokens_details?: CompletionUsagePromptTokensDetails;
}

/** SDK `CompletionUsage.CompletionTokensDetails`. */
export interface CompletionUsageCompletionTokensDetails {
	/** Predicted Outputs: prediction tokens that appeared in the completion. */
	accepted_prediction_tokens?: number;
	/** Audio input tokens generated by the model. */
	audio_tokens?: number;
	/** Tokens generated by the model for reasoning. */
	reasoning_tokens?: number;
	/** Predicted Outputs: prediction tokens that did not appear in the completion (still billed). */
	rejected_prediction_tokens?: number;
}

/** SDK `CompletionUsage.PromptTokensDetails`. */
export interface CompletionUsagePromptTokensDetails {
	/** Audio input tokens present in the prompt. */
	audio_tokens?: number;
	/** Cached tokens present in the prompt. */
	cached_tokens?: number;
}

// ─── Content parts ───────────────────────────────────────────────────────────

/** Text content part. */
export interface ChatCompletionContentPartText {
	/** The text content. */
	text: string;
	/** Always `text`. */
	type: "text";
	/** Explicit OpenAI prompt-cache breakpoint. */
	prompt_cache_breakpoint?: { mode: "explicit" };
}

/** Image content part. */
export interface ChatCompletionContentPartImage {
	image_url: ChatCompletionContentPartImageImageURL;
	/** Always `image_url`. */
	type: "image_url";
	/** Explicit OpenAI prompt-cache breakpoint. */
	prompt_cache_breakpoint?: { mode: "explicit" };
}

/** SDK `ChatCompletionContentPartImage.ImageURL`. */
export interface ChatCompletionContentPartImageImageURL {
	/** Either a URL of the image or the base64 encoded image data. */
	url: string;
	/** Detail level of the image. */
	detail?: "auto" | "low" | "high";
}

/** Audio content part (gpt-4o-audio). */
export interface ChatCompletionContentPartInputAudio {
	input_audio: ChatCompletionContentPartInputAudioInputAudio;
	/** Always `input_audio`. */
	type: "input_audio";
	/** Explicit OpenAI prompt-cache breakpoint. */
	prompt_cache_breakpoint?: { mode: "explicit" };
}

/** SDK `ChatCompletionContentPartInputAudio.InputAudio`. */
export interface ChatCompletionContentPartInputAudioInputAudio {
	/** Base64 encoded audio data. */
	data: string;
	/** Format of the encoded audio data. */
	format: "wav" | "mp3";
}

/** File content part. SDK `ChatCompletionContentPart.File`. */
export interface ChatCompletionContentPartFile {
	file: ChatCompletionContentPartFileFile;
	/** Always `file`. */
	type: "file";
	/** Explicit OpenAI prompt-cache breakpoint. */
	prompt_cache_breakpoint?: { mode: "explicit" };
}

/** SDK `ChatCompletionContentPart.File.File`. */
export interface ChatCompletionContentPartFileFile {
	/** Base64 encoded file data, used when passing the file to the model as a string. */
	file_data?: string;
	/** The ID of an uploaded file to use as input. */
	file_id?: string;
	/** The name of the file, used when passing the file to the model as a string. */
	filename?: string;
}

/** Assistant refusal content part. */
export interface ChatCompletionContentPartRefusal {
	/** The refusal message generated by the model. */
	refusal: string;
	/** Always `refusal`. */
	type: "refusal";
	/** Explicit OpenAI prompt-cache breakpoint. */
	prompt_cache_breakpoint?: { mode: "explicit" };
}

/** User-message content part union. */
export type ChatCompletionContentPart =
	| ChatCompletionContentPartText
	| ChatCompletionContentPartImage
	| ChatCompletionContentPartInputAudio
	| ChatCompletionContentPartFile;

// ─── Tool calls ──────────────────────────────────────────────────────────────

/** A call to a function tool created by the model. */
export interface ChatCompletionMessageFunctionToolCall {
	/** The ID of the tool call. */
	id: string;
	/** The function that the model called. */
	function: ChatCompletionMessageFunctionToolCallFunction;
	/** Always `function`. */
	type: "function";
}

/** SDK `ChatCompletionMessageFunctionToolCall.Function`. */
export interface ChatCompletionMessageFunctionToolCallFunction {
	/** JSON-encoded arguments; the model may emit invalid JSON, validate before use. */
	arguments: string;
	/** The name of the function to call. */
	name: string;
}

/** A call to a custom tool created by the model. */
export interface ChatCompletionMessageCustomToolCall {
	/** The ID of the tool call. */
	id: string;
	/** The custom tool that the model called. */
	custom: ChatCompletionMessageCustomToolCallCustom;
	/** Always `custom`. */
	type: "custom";
}

/** SDK `ChatCompletionMessageCustomToolCall.Custom`. */
export interface ChatCompletionMessageCustomToolCallCustom {
	/** The input for the custom tool call generated by the model. */
	input: string;
	/** The name of the custom tool to call. */
	name: string;
}

/** Tool call union. */
export type ChatCompletionMessageToolCall = ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall;

// ─── Message params ──────────────────────────────────────────────────────────

/** Developer-provided instructions (o1 and newer replace `system`). */
export interface ChatCompletionDeveloperMessageParam {
	/** The contents of the developer message. */
	content: string | Array<ChatCompletionContentPartText>;
	/** Always `developer`. */
	role: "developer";
	/** Optional participant name. */
	name?: string;
}

/** System message. */
export interface ChatCompletionSystemMessageParam {
	/** The contents of the system message. */
	content: string | Array<ChatCompletionContentPartText>;
	/** Always `system`. */
	role: "system";
	/** Optional participant name. */
	name?: string;
}

/** User message. */
export interface ChatCompletionUserMessageParam {
	/** The contents of the user message. */
	content: string | Array<ChatCompletionContentPart>;
	/** Always `user`. */
	role: "user";
	/** Optional participant name. */
	name?: string;
}

/** Assistant (model) message. */
export interface ChatCompletionAssistantMessageParam {
	/** Always `assistant`. */
	role: "assistant";
	/** Data about a previous audio response from the model. */
	audio?: ChatCompletionAssistantMessageParamAudio | null;
	/** Message contents. Required unless `tool_calls` or `function_call` is specified. */
	content?: string | Array<ChatCompletionContentPartText | ChatCompletionContentPartRefusal> | null;
	/** Deprecated by OpenAI; replaced by `tool_calls`. */
	function_call?: ChatCompletionAssistantMessageParamFunctionCall | null;
	/** Optional participant name. */
	name?: string;
	/** The refusal message by the assistant. */
	refusal?: string | null;
	/** The tool calls generated by the model, such as function calls. */
	tool_calls?: Array<ChatCompletionMessageToolCall>;
}

/** SDK `ChatCompletionAssistantMessageParam.Audio`. */
export interface ChatCompletionAssistantMessageParamAudio {
	/** Unique identifier for a previous audio response from the model. */
	id: string;
}

/** SDK `ChatCompletionAssistantMessageParam.FunctionCall`. */
export interface ChatCompletionAssistantMessageParamFunctionCall {
	/** JSON-encoded arguments; the model may emit invalid JSON, validate before use. */
	arguments: string;
	/** The name of the function to call. */
	name: string;
}

/** Tool result message. */
export interface ChatCompletionToolMessageParam {
	/** The contents of the tool message. */
	content: string | Array<ChatCompletionContentPartText>;
	/** Always `tool`. */
	role: "tool";
	/** Tool call that this message is responding to. */
	tool_call_id: string;
}

/** Legacy `function` role message (pre-tools API). Deprecated by OpenAI. */
export interface ChatCompletionFunctionMessageParam {
	/** The contents of the function message. */
	content: string | null;
	/** The name of the function to call. */
	name: string;
	/** Always `function`. */
	role: "function";
}

/** Message union. */
export type ChatCompletionMessageParam =
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
	| ChatCompletionToolMessageParam
	| ChatCompletionFunctionMessageParam;

// ─── Tools ───────────────────────────────────────────────────────────────────

/** A function tool that can be used to generate a response. */
export interface ChatCompletionFunctionTool {
	function: FunctionDefinition;
	/** Always `function`. */
	type: "function";
}

/** A custom tool that processes input using a specified format. */
export interface ChatCompletionCustomTool {
	/** Properties of the custom tool. */
	custom: ChatCompletionCustomToolCustom;
	/** Always `custom`. */
	type: "custom";
}

/** SDK `ChatCompletionCustomTool.Custom`. */
export interface ChatCompletionCustomToolCustom {
	/** The name of the custom tool, used to identify it in tool calls. */
	name: string;
	/** Optional description of the custom tool. */
	description?: string;
	/** The input format for the custom tool. Default is unconstrained text. */
	format?: ChatCompletionCustomToolCustomText | ChatCompletionCustomToolCustomGrammar;
}

/** SDK `ChatCompletionCustomTool.Custom.Text`. */
export interface ChatCompletionCustomToolCustomText {
	/** Unconstrained text format. Always `text`. */
	type: "text";
}

/** SDK `ChatCompletionCustomTool.Custom.Grammar`. */
export interface ChatCompletionCustomToolCustomGrammar {
	/** Your chosen grammar. */
	grammar: ChatCompletionCustomToolCustomGrammarGrammar;
	/** Grammar format. Always `grammar`. */
	type: "grammar";
}

/** SDK `ChatCompletionCustomTool.Custom.Grammar.Grammar`. */
export interface ChatCompletionCustomToolCustomGrammarGrammar {
	/** The grammar definition. */
	definition: string;
	/** The syntax of the grammar definition. One of `lark` or `regex`. */
	syntax: "lark" | "regex";
}

/** Tool union. */
export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;

// ─── Tool choice ─────────────────────────────────────────────────────────────

/** Constrains the tools available to the model to a pre-defined set. */
export interface ChatCompletionAllowedTools {
	/** `auto` lets the model pick from the allowed tools; `required` forces a call. */
	mode: "auto" | "required";
	/** Tool definitions the model is allowed to call. */
	tools: Array<{
		[key: string]: unknown;
	}>;
}

/** Constrains the tools available to the model to a pre-defined set. */
export interface ChatCompletionAllowedToolChoice {
	/** Constrains the tools available to the model to a pre-defined set. */
	allowed_tools: ChatCompletionAllowedTools;
	/** Always `allowed_tools`. */
	type: "allowed_tools";
}

/** Forces the model to call a specific function. */
export interface ChatCompletionNamedToolChoice {
	function: ChatCompletionNamedToolChoiceFunction;
	/** For function calling, the type is always `function`. */
	type: "function";
}

/** SDK `ChatCompletionNamedToolChoice.Function`. */
export interface ChatCompletionNamedToolChoiceFunction {
	/** The name of the function to call. */
	name: string;
}

/** Forces the model to call a specific custom tool. */
export interface ChatCompletionNamedToolChoiceCustom {
	custom: ChatCompletionNamedToolChoiceCustomCustom;
	/** For custom tool calling, the type is always `custom`. */
	type: "custom";
}

/** SDK `ChatCompletionNamedToolChoiceCustom.Custom`. */
export interface ChatCompletionNamedToolChoiceCustomCustom {
	/** The name of the custom tool to call. */
	name: string;
}

/** Controls which (if any) tool is called by the model. */
export type ChatCompletionToolChoiceOption =
	| "none"
	| "auto"
	| "required"
	| ChatCompletionAllowedToolChoice
	| ChatCompletionNamedToolChoice
	| ChatCompletionNamedToolChoiceCustom;

// ─── Token logprobs ──────────────────────────────────────────────────────────

export interface ChatCompletionTokenLogprob {
	/** The token. */
	token: string;
	/** UTF-8 bytes representation of the token; `null` when unavailable. */
	bytes: Array<number> | null;
	/** Log probability of this token; `-9999.0` when outside the top 20. */
	logprob: number;
	/** Most likely tokens and their log probability at this position. */
	top_logprobs: Array<ChatCompletionTokenLogprobTopLogprob>;
}

/** SDK `ChatCompletionTokenLogprob.TopLogprob`. */
export interface ChatCompletionTokenLogprobTopLogprob {
	/** The token. */
	token: string;
	/** UTF-8 bytes representation of the token; `null` when unavailable. */
	bytes: Array<number> | null;
	/** Log probability of this token; `-9999.0` when outside the top 20. */
	logprob: number;
}

// ─── Streaming chunk ─────────────────────────────────────────────────────────

/** A streamed chunk of a chat completion response. */
export interface ChatCompletionChunk {
	/** Unique identifier for the chat completion. Each chunk has the same ID. */
	id: string;
	/** Choices; can exceed one when `n > 1`, or be empty on the final usage chunk. */
	choices: Array<ChatCompletionChunkChoice>;
	/** Unix timestamp (seconds) of when the chat completion was created. */
	created: number;
	/** The model to generate the completion. */
	model: string;
	/** Always `chat.completion.chunk`. */
	object: "chat.completion.chunk";
	/** Moderation results, present on the moderation chunk when requested. */
	moderation?: ChatCompletionChunkModeration | null;
	/** Processing type actually used for serving the request. */
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	/** Deprecated by OpenAI: backend configuration fingerprint, pairs with `seed`. */
	system_fingerprint?: string;
	/** Only with `stream_options: {"include_usage": true}`; null except on the last chunk. */
	usage?: CompletionUsage | null;
}

/** SDK-style namespace mirror so `ChatCompletionChunk.Choice` call sites keep working. */
export declare namespace ChatCompletionChunk {
	export type Choice = ChatCompletionChunkChoice;
	export type Moderation = ChatCompletionChunkModeration;
}

/** SDK `ChatCompletionChunk.Choice`. */
export interface ChatCompletionChunkChoice {
	/** A chat completion delta generated by streamed model responses. */
	delta: ChatCompletionChunkChoiceDelta;
	/** Why the model stopped generating tokens; null while streaming. */
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
	/** The index of the choice in the list of choices. */
	index: number;
	/** Log probability information for the choice. */
	logprobs?: ChatCompletionChunkChoiceLogprobs | null;
}

/** SDK `ChatCompletionChunk.Choice.Delta`. */
export interface ChatCompletionChunkChoiceDelta {
	/** The contents of the chunk message. */
	content?: string | null;
	/** Deprecated by OpenAI; replaced by `tool_calls`. */
	function_call?: ChatCompletionChunkChoiceDeltaFunctionCall;
	/** The refusal message generated by the model. */
	refusal?: string | null;
	/** The role of the author of this message. */
	role?: "developer" | "system" | "user" | "assistant" | "tool";
	tool_calls?: Array<ChatCompletionChunkChoiceDeltaToolCall>;
}

/** SDK `ChatCompletionChunk.Choice.Delta.FunctionCall`. */
export interface ChatCompletionChunkChoiceDeltaFunctionCall {
	/** JSON-encoded arguments; the model may emit invalid JSON, validate before use. */
	arguments?: string;
	/** The name of the function to call. */
	name?: string;
}

/** SDK `ChatCompletionChunk.Choice.Delta.ToolCall`. */
export interface ChatCompletionChunkChoiceDeltaToolCall {
	index: number;
	/** The ID of the tool call. */
	id?: string;
	function?: ChatCompletionChunkChoiceDeltaToolCallFunction;
	/** Always `function`. */
	type?: "function";
}

/** SDK `ChatCompletionChunk.Choice.Delta.ToolCall.Function`. */
export interface ChatCompletionChunkChoiceDeltaToolCallFunction {
	/** JSON-encoded arguments; the model may emit invalid JSON, validate before use. */
	arguments?: string;
	/** The name of the function to call. */
	name?: string;
}

/** SDK `ChatCompletionChunk.Choice.Logprobs`. */
export interface ChatCompletionChunkChoiceLogprobs {
	/** Message content tokens with log probability information. */
	content: Array<ChatCompletionTokenLogprob> | null;
	/** Message refusal tokens with log probability information. */
	refusal: Array<ChatCompletionTokenLogprob> | null;
}

/** SDK `ChatCompletionChunk.Moderation`. */
export interface ChatCompletionChunkModeration {
	/** Moderation for the request input. */
	input: ChatCompletionChunkModerationResults | ChatCompletionChunkModerationError;
	/** Moderation for the generated output. */
	output: ChatCompletionChunkModerationResults | ChatCompletionChunkModerationError;
}

/** SDK `ChatCompletionChunk.Moderation.ModerationResults`. */
export interface ChatCompletionChunkModerationResults {
	/** The moderation model used to generate the results. */
	model: string;
	/** A list of moderation results. */
	results: Array<ChatCompletionChunkModerationResult>;
	/** Always `moderation_results`. */
	type: "moderation_results";
}

/** SDK `ChatCompletionChunk.Moderation.ModerationResults.Result`. */
export interface ChatCompletionChunkModerationResult {
	/** Moderation categories to booleans; true when flagged under the category. */
	categories: {
		[key: string]: boolean;
	};
	/** Input modalities reflected by the score for each category. */
	category_applied_input_types: {
		[key: string]: Array<"text" | "image">;
	};
	/** A dictionary of moderation categories to scores. */
	category_scores: {
		[key: string]: number;
	};
	/** Whether the content was flagged by any category. */
	flagged: boolean;
	/** The moderation model that produced this result. */
	model: string;
	/** Always `moderation_result`. */
	type: "moderation_result";
}

/** SDK `ChatCompletionChunk.Moderation.Error`. */
export interface ChatCompletionChunkModerationError {
	/** The error code. */
	code: string;
	/** The error message. */
	message: string;
	/** Always `error`. */
	type: "error";
}

// ─── Create params ───────────────────────────────────────────────────────────

/** Audio output parameters; required with `modalities: ["audio"]`. */
export interface ChatCompletionAudioParam {
	/** Output audio format. */
	format: "wav" | "aac" | "mp3" | "flac" | "opus" | "pcm16";
	/** Built-in voice name or a custom voice object. */
	voice:
		| string
		| "alloy"
		| "ash"
		| "ballad"
		| "coral"
		| "echo"
		| "sage"
		| "shimmer"
		| "verse"
		| "marin"
		| "cedar"
		| ChatCompletionAudioParamID;
}

/** SDK `ChatCompletionAudioParam.ID`: custom voice reference. */
export interface ChatCompletionAudioParamID {
	/** The custom voice ID, e.g. `voice_1234`. */
	id: string;
}

/** Forces the model to call a specific function via `{"name": "my_function"}`. */
export interface ChatCompletionFunctionCallOption {
	/** The name of the function to call. */
	name: string;
}

/** Static predicted output content, e.g. a text file being regenerated. */
export interface ChatCompletionPredictionContent {
	/** Content matched when generating a model response to speed it up. */
	content: string | Array<ChatCompletionContentPartText>;
	/** Always `content`. */
	type: "content";
}

/** Options for streaming response. Only set with `stream: true`. */
export interface ChatCompletionStreamOptions {
	/** Pad delta events with an `obfuscation` field to normalize payload sizes. */
	include_obfuscation?: boolean;
	/** Stream a final usage chunk before `data: [DONE]`. */
	include_usage?: boolean;
}

/** SDK `ChatCompletionCreateParams.Function`. Deprecated by OpenAI in favor of tools. */
export interface ChatCompletionCreateParamsFunction {
	/** Function name: a-z, A-Z, 0-9, underscores and dashes, max length 64. */
	name: string;
	/** What the function does; used by the model to choose when/how to call it. */
	description?: string;
	/** Parameters as a JSON Schema object. Omitting defines an empty parameter list. */
	parameters?: FunctionParameters;
}

/** SDK `ChatCompletionCreateParams.Moderation`. */
export interface ChatCompletionCreateParamsModeration {
	/** Moderation model for moderated completions, e.g. 'omni-moderation-latest'. */
	model: string;
}

/** SDK `ChatCompletionCreateParams.WebSearchOptions`. */
export interface ChatCompletionCreateParamsWebSearchOptions {
	/** Context window space to use for the search; `medium` is the default. */
	search_context_size?: "low" | "medium" | "high";
	/** Approximate location parameters for the search. */
	user_location?: ChatCompletionCreateParamsWebSearchOptionsUserLocation | null;
}

/** SDK `ChatCompletionCreateParams.WebSearchOptions.UserLocation`. */
export interface ChatCompletionCreateParamsWebSearchOptionsUserLocation {
	/** Approximate location parameters for the search. */
	approximate: ChatCompletionCreateParamsWebSearchOptionsUserLocationApproximate;
	/** Always `approximate`. */
	type: "approximate";
}

/** SDK `ChatCompletionCreateParams.WebSearchOptions.UserLocation.Approximate`. */
export interface ChatCompletionCreateParamsWebSearchOptionsUserLocationApproximate {
	/** Free text input for the city of the user, e.g. `San Francisco`. */
	city?: string;
	/** Two-letter ISO country code of the user, e.g. `US`. */
	country?: string;
	/** Free text input for the region of the user, e.g. `California`. */
	region?: string;
	/** IANA timezone of the user, e.g. `America/Los_Angeles`. */
	timezone?: string;
}

export interface ChatCompletionCreateParamsBase {
	/** Messages comprising the conversation so far. */
	messages: Array<ChatCompletionMessageParam>;
	/** Model ID used to generate the response, like `gpt-4o` or `o3`. */
	model: (string & {}) | ChatModel;
	/** Audio output parameters; required with `modalities: ["audio"]`. */
	audio?: ChatCompletionAudioParam | null;
	/** Number between -2.0 and 2.0; positive values penalize token frequency. */
	frequency_penalty?: number | null;
	/** Deprecated by OpenAI in favor of `tool_choice`. */
	function_call?: "none" | "auto" | ChatCompletionFunctionCallOption;
	/** Deprecated by OpenAI in favor of `tools`. */
	functions?: Array<ChatCompletionCreateParamsFunction>;
	/** Map of token IDs to bias values from -100 to 100. */
	logit_bias?: {
		[key: string]: number;
	} | null;
	/** Whether to return log probabilities of the output tokens. */
	logprobs?: boolean | null;
	/** Upper bound for generated tokens, including visible output and reasoning tokens. */
	max_completion_tokens?: number | null;
	/** Deprecated by OpenAI in favor of `max_completion_tokens`. */
	max_tokens?: number | null;
	/** Up to 16 key-value string pairs attached to the object. */
	metadata?: Metadata | null;
	/** Output types the model should generate, e.g. `["text"]` or `["text", "audio"]`. */
	modalities?: Array<"text" | "audio"> | null;
	/** Configuration for running moderation on request input and generated output. */
	moderation?: ChatCompletionCreateParamsModeration | null;
	/** How many chat completion choices to generate for each input message. */
	n?: number | null;
	/** Whether to enable parallel function calling during tool use. */
	parallel_tool_calls?: boolean;
	/** Static predicted output content, e.g. a text file being regenerated. */
	prediction?: ChatCompletionPredictionContent | null;
	/** Number between -2.0 and 2.0; positive values penalize tokens already present. */
	presence_penalty?: number | null;
	/** Cache-bucketing key for similar requests; replaces the `user` field. */
	prompt_cache_key?: string;
	/** Retention policy for the prompt cache; `24h` enables extended caching. */
	prompt_cache_retention?: "in_memory" | "24h" | null;
	/** Explicit prompt-cache mode and minimum lifetime for GPT-5.6+ models. */
	prompt_cache_options?: { mode: "implicit" | "explicit"; ttl?: "30m" };
	/** Constrains effort on reasoning for reasoning models. */
	reasoning_effort?: ReasoningEffort | null;
	/** Output format: text, JSON mode, or Structured Outputs JSON schema. */
	response_format?: ResponseFormatText | ResponseFormatJSONSchema | ResponseFormatJSONObject;
	/** Stable end-user identifier used for usage-policy enforcement. */
	safety_identifier?: string;
	/** Deprecated by OpenAI (Beta): best-effort deterministic sampling seed. */
	seed?: number | null;
	/** Processing type used for serving the request. */
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	/** Up to 4 sequences where the API will stop generating further tokens. */
	stop?: string | null | Array<string>;
	/** Whether to store the output for model distillation or evals. */
	store?: boolean | null;
	/** Whether to stream the response as server-sent events. */
	stream?: boolean | null;
	/** Options for streaming response. Only set with `stream: true`. */
	stream_options?: ChatCompletionStreamOptions | null;
	/** Sampling temperature between 0 and 2. */
	temperature?: number | null;
	/** Controls which (if any) tool is called by the model. */
	tool_choice?: ChatCompletionToolChoiceOption;
	/** A list of tools the model may call. */
	tools?: Array<ChatCompletionTool>;
	/** 0-20: number of most likely tokens to return at each position; needs `logprobs`. */
	top_logprobs?: number | null;
	/** Nucleus sampling: consider only tokens within `top_p` probability mass. */
	top_p?: number | null;
	/** Deprecated by OpenAI; replaced by `safety_identifier` and `prompt_cache_key`. */
	user?: string;
	/** Constrains the verbosity of the model's response. */
	verbosity?: "low" | "medium" | "high" | null;
	/** Web search tool configuration. */
	web_search_options?: ChatCompletionCreateParamsWebSearchOptions;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
	/** Non-streaming request. */
	stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
	/** Streaming request: response arrives as server-sent events. */
	stream: true;
}

export type ChatCompletionCreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;
