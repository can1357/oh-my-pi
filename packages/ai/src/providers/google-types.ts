/**
 * Local mirror of the subset of `@google/genai` types this package consumes.
 *
 * Field shapes match Gemini / Vertex AI wire format 1:1. Enum-shaped values are
 * modelled as string literal unions so they pass through `JSON.stringify` and
 * `JSON.parse` unchanged.
 *
 * Keep this file in sync with the actual request/response surface of:
 *   - `POST {generativelanguage,aiplatform}.googleapis.com/.../models/{model}:streamGenerateContent?alt=sse`
 *   - The Cloud Code Assist endpoint used by `google-gemini-cli.ts`
 */
/** Mirror of `@google/genai`'s `FinishReason` string enum. */
export type FinishReason =
	| "FINISH_REASON_UNSPECIFIED"
	| "STOP"
	| "MAX_TOKENS"
	| "SAFETY"
	| "RECITATION"
	| "LANGUAGE"
	| "OTHER"
	| "BLOCKLIST"
	| "PROHIBITED_CONTENT"
	| "SPII"
	| "MALFORMED_FUNCTION_CALL"
	| "IMAGE_SAFETY"
	| "IMAGE_PROHIBITED_CONTENT"
	| "IMAGE_RECITATION"
	| "IMAGE_OTHER"
	| "UNEXPECTED_TOOL_CALL"
	| "NO_IMAGE";

/** Mirror of `@google/genai`'s `FunctionCallingConfigMode` string enum. */
export type FunctionCallingConfigMode = "MODE_UNSPECIFIED" | "AUTO" | "NONE" | "ANY" | "VALIDATED";

/** Mirror of `@google/genai`'s `ThinkingLevel` string enum. */
export type ThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/** Inline base64-encoded data part. */
export interface InlineDataPart {
	mimeType: string;
	data: string;
}

/** Function call emitted by the model. */
export interface FunctionCallPart {
	name?: string;
	args?: Record<string, unknown>;
	id?: string;
}

/** Tool execution result fed back to the model. */
export interface FunctionResponsePart {
	name: string;
	response: Record<string, unknown>;
	parts?: Part[];
	id?: string;
}

/**
 * A single piece of a `Content` message. Mirrors the SDK's union by keeping
 * every optional field — the model and the wire treat shape as discriminator.
 */
export interface Part {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: InlineDataPart;
	fileData?: FileDataPart;
	functionCall?: FunctionCallPart;
	functionResponse?: FunctionResponsePart;
}

/** Remote media reference; the backend fetches `fileUri` server-side. */
export interface FileDataPart {
	fileUri: string;
	mimeType?: string;
}

/** Conversation turn. Roles: `"user"`, `"model"`, optionally absent for system instructions. */
export interface Content {
	role?: string;
	parts?: Part[];
}

/** Thinking/reasoning configuration shared by Gemini 2.x and 3.x models. */
export interface ThinkingConfig {
	includeThoughts?: boolean;
	thinkingBudget?: number;
	thinkingLevel?: ThinkingLevel;
}

/** Function declaration entry inside `tools[].functionDeclarations`. */
export interface FunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	parametersJsonSchema?: Record<string, unknown>;
}

/** Tool group as accepted at the request top level. */
export interface ToolDeclaration {
	functionDeclarations: Record<string, unknown>[];
}

/** Tool selection mode container. */
export interface ToolConfig {
	functionCallingConfig?: {
		mode: FunctionCallingConfigMode;
		allowedFunctionNames?: string[];
	};
}

/**
 * Generation/sampling and request-shape options passed via the SDK's `config`.
 *
 * Fields that the wire format places at the request body root (systemInstruction,
 * tools, toolConfig, safetySettings, cachedContent) live here too — the
 * transformer in `google-shared.ts` lifts them out when serializing.
 */
export interface GenerateContentConfig {
	temperature?: number;
	maxOutputTokens?: number;
	topP?: number;
	topK?: number;
	candidateCount?: number;
	stopSequences?: string[];
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	responseMimeType?: string;
	responseSchema?: Record<string, unknown>;
	responseJsonSchema?: Record<string, unknown>;
	responseModalities?: string[];
	systemInstruction?: Content | { role?: string; parts: { text: string }[] };
	tools?: ToolDeclaration[];
	toolConfig?: ToolConfig;
	safetySettings?: Array<Record<string, unknown>>;
	cachedContent?: string;
	thinkingConfig?: ThinkingConfig;
	/**
	 * Gemini/Vertex serving tier. Serialized to the request body root as
	 * `serviceTier` (camelCase) by the transformer in `google-shared.ts`.
	 */
	serviceTier?: "auto" | "default" | "flex" | "scale" | "priority";
	abortSignal?: AbortSignal;
}

/** Top-level argument to `generateContentStream`. */
export interface GenerateContentParameters {
	model: string;
	contents: Content[];
	config?: GenerateContentConfig;
}

/** Per-stream candidate envelope. */
export interface Candidate {
	content?: Content;
	finishReason?: FinishReason;
	index?: number;
}

/** Cumulative token accounting attached to the trailing chunk. */
export interface UsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
	cachedContentTokenCount?: number;
}

/** Prompt-level safety feedback; `blockReason` is set (with no candidates) when the prompt is blocked. */
export interface PromptFeedback {
	blockReason?: string;
	blockReasonMessage?: string;
	[key: string]: unknown;
}

/** Single SSE chunk's parsed JSON body. */
export interface GenerateContentResponse {
	candidates?: Candidate[];
	usageMetadata?: UsageMetadata;
	modelVersion?: string;
	responseId?: string;
	promptFeedback?: PromptFeedback;
	/** In-band stream failure (quota, internal error) delivered as a final JSON event. */
	error?: { code?: number; message?: string; status?: string };
}
