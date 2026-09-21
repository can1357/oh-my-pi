import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	type ApiKey,
	type FetchImpl,
	isOfficialCodexApiUrl,
	type Model,
	NO_AUTH_SENTINEL,
	withAuth,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { fetchAntigravityImageModel } from "@oh-my-pi/pi-catalog/discovery/antigravity";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import {
	asRecord,
	isEnoent,
	logger,
	parseImageMetadata,
	prompt,
	ptree,
	readSseJson,
	Snowflake,
	USER_AGENT,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { resolveModelRoleValue, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { isAuthenticated, type ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import imageGenDescription from "../prompts/tools/image-gen.md" with { type: "text" };
import { generateComfyUIImage } from "./comfyui-image";
import { resolveReadPath } from "./path-utils";
const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const MAX_IMAGE_SIZE = 35 * 1024 * 1024;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_IMAGE_OUTPUT_FORMAT = "webp";
const OPENAI_IMAGE_MIME_TYPE = "image/webp";

const DEFAULT_ANTIGRAVITY_ENDPOINT_PROD = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

const responseModalitySchema = type('"IMAGE" | "TEXT"');

const aspectRatioSchema = type('"1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "3:2" | "2:3"').describe("aspect ratio");
const imageSizeSchema = type('"1024x1024" | "1536x1024" | "1024x1536"').describe("image size");

const inputImageSchema = type({
	"path?": type("string").describe("input image path"),
	"data?": type("string").describe("base64 image data"),
	"mime_type?": type("string").describe("mime type"),
});

const imageModelSchema = type("string").describe("image model selector for this request");

export const imageGenSchema = type({
	subject: type("string").describe("main subject"),
	"action?": type("string").describe("what subject is doing"),
	"scene?": type("string").describe("location or environment"),
	"composition?": type("string").describe("camera angle and framing"),
	"lighting?": type("string").describe("lighting setup"),
	"style?": type("string").describe("artistic style"),
	"text?": type("string").describe("text to render"),
	"changes?": type("string[]").describe("edits to make"),
	"aspect_ratio?": aspectRatioSchema,
	"image_size?": imageSizeSchema,
	"input?": inputImageSchema.array().describe("input images"),
	"model?": imageModelSchema,
});
export type ImageGenParams = typeof imageGenSchema.infer;
export type GeminiResponseModality = typeof responseModalitySchema.infer;

/**
 * Assembles a structured prompt from the provided parameters.
 * For generation: builds "subject, action, scene. composition. lighting. camera. style."
 * For edits: appends change instructions and preserve directives.
 */
function assemblePrompt(params: ImageGenParams): string {
	const parts: string[] = [];

	// Core subject line: subject + action + scene
	const subjectParts = [params.subject];
	if (params.action) subjectParts.push(params.action);
	if (params.scene) subjectParts.push(params.scene);
	parts.push(subjectParts.join(", "));

	// Technical details as separate sentences
	if (params.composition) parts.push(params.composition);
	if (params.lighting) parts.push(params.lighting);
	if (params.style) parts.push(params.style);

	// Join with periods for sentence structure
	let prompt = `${parts.map(p => p.replace(/[.!,;:]+$/, "")).join(". ")}.`;

	// Text rendering specs
	if (params.text) {
		prompt += `\n\nText: ${params.text}`;
	}

	// Edit mode: changes and preserve directives
	if (params.changes?.length) {
		prompt += `\n\nChanges:\n${params.changes.map(c => `- ${c}`).join("\n")}`;
	}

	return prompt;
}

interface GeminiInlineData {
	data?: string;
	mimeType?: string;
}

interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
}

interface GeminiSafetyRating {
	category?: string;
	probability?: string;
}

interface GeminiPromptFeedback {
	blockReason?: string;
	safetyRatings?: GeminiSafetyRating[];
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[];
	promptFeedback?: GeminiPromptFeedback;
	usageMetadata?: GeminiUsageMetadata;
}

interface OpenAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

type ImageUsageMetadata = GeminiUsageMetadata | OpenAIResponsesUsage;

type OpenAIImageAction = "edit" | "generate";

interface OpenAIInputTextContent {
	type: "input_text";
	text: string;
}

interface OpenAIInputImageContent {
	type: "input_image";
	detail: "auto";
	image_url: string;
}

type OpenAIInputContent = OpenAIInputTextContent | OpenAIInputImageContent;

interface OpenAIImageGenerationTool {
	type: "image_generation";
	action: OpenAIImageAction;
	output_format: typeof OPENAI_IMAGE_OUTPUT_FORMAT;
	size?: string;
	model?: string;
}

interface OpenAIHostedImageRequest {
	model: string;
	instructions?: string;
	input: Array<{ role: "user"; content: OpenAIInputContent[] }>;
	tools: OpenAIImageGenerationTool[];
	tool_choice: { type: "image_generation" };
	store: false;
	stream?: boolean;
}

interface OpenAIImageGenerationCall {
	id?: string;
	type: "image_generation_call";
	result?: string;
	revised_prompt?: string;
	status?: string;
}

interface OpenAIOutputText {
	type: "output_text" | "refusal";
	text?: string;
	refusal?: string;
}

interface OpenAIOutputMessage {
	id?: string;
	type: "message";
	content?: OpenAIOutputText[];
}

type OpenAIResponseOutput = OpenAIImageGenerationCall | OpenAIOutputMessage;

interface OpenAIHostedImageResponse {
	output?: OpenAIResponseOutput[];
	usage?: OpenAIResponsesUsage;
	error?: { code?: string; message?: string };
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === "number";
}

function isOpenAIResponsesUsage(value: unknown): value is OpenAIResponsesUsage {
	const usage = asRecord(value);
	return (
		usage !== null &&
		isOptionalNumber(usage.input_tokens) &&
		isOptionalNumber(usage.output_tokens) &&
		isOptionalNumber(usage.total_tokens)
	);
}

function isOpenAIOutputText(value: unknown): value is OpenAIOutputText {
	const part = asRecord(value);
	return (
		part !== null &&
		(part.type === "output_text" || part.type === "refusal") &&
		isOptionalString(part.text) &&
		isOptionalString(part.refusal)
	);
}

function isOpenAIResponseOutput(value: unknown): value is OpenAIResponseOutput {
	const output = asRecord(value);
	if (output === null || !isOptionalString(output.id)) return false;
	if (output.type === "image_generation_call") {
		return (
			isOptionalString(output.result) && isOptionalString(output.revised_prompt) && isOptionalString(output.status)
		);
	}
	return (
		output.type === "message" &&
		(output.content === undefined || (Array.isArray(output.content) && output.content.every(isOpenAIOutputText)))
	);
}

function isOpenAIResponseError(value: unknown): value is NonNullable<OpenAIHostedImageResponse["error"]> {
	const error = asRecord(value);
	return error !== null && isOptionalString(error.code) && isOptionalString(error.message);
}

function isOpenAIHostedImageResponse(value: unknown): value is OpenAIHostedImageResponse {
	const response = asRecord(value);
	return (
		response !== null &&
		(response.output === undefined ||
			(Array.isArray(response.output) && response.output.every(isOpenAIResponseOutput))) &&
		(response.usage === undefined || isOpenAIResponsesUsage(response.usage)) &&
		(response.error === undefined || isOpenAIResponseError(response.error))
	);
}

interface OpenAISseEvent {
	type?: string;
	item?: OpenAIResponseOutput;
	response?: OpenAIHostedImageResponse;
	code?: string;
	message?: string;
	error?: { code?: string; message?: string };
}

interface OpenAIHostedImageResult {
	images: InlineImageData[];
	responseText?: string;
	revisedPrompt?: string;
	usage?: OpenAIResponsesUsage;
}

interface AntigravityRequest {
	project: string;
	model: string;
	request: {
		contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: InlineImageData }> }>;
		systemInstruction?: { parts: Array<{ text: string }> };
		generationConfig?: {
			responseModalities?: GeminiResponseModality[];
			imageConfig?: { aspectRatio?: string; imageSize?: string };
			candidateCount?: number;
		};
		safetySettings?: Array<{ category: string; threshold: string }>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface AntigravityResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					inlineData?: { mimeType?: string; data?: string };
				}>;
			};
		}>;
		usageMetadata?: GeminiUsageMetadata;
	};
}

interface ImageGenToolDetails {
	provider: string;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: InlineImageData[];
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	revisedPrompt?: string;
	usage?: ImageUsageMetadata;
}

interface ImageInput {
	path?: string;
	data?: string;
	mime_type?: string;
}

interface InlineImageData {
	data: string;
	mimeType: string;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

async function loadImageFromUrl(
	imageUrl: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<InlineImageData> {
	if (imageUrl.startsWith("data:")) {
		const normalized = normalizeDataUrl(imageUrl.trim());
		if (!normalized.mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType: normalized.mimeType };
	}

	const response = await fetchImpl(imageUrl, { signal });
	if (!response.ok) {
		const rawText = await response.text();
		throw new Error(`Image download failed (${response.status}): ${rawText}`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (!contentType?.startsWith("image/")) {
		throw new Error(`Unsupported image type from URL: ${imageUrl}`);
	}
	// `Response.bytes()` is absent from older undici types; `arrayBuffer`
	// exists in both and yields identical bytes.
	const buffer = new Uint8Array(await response.arrayBuffer());
	return { data: buffer.toBase64(), mimeType: contentType };
}

/**
 * Shared POST for OpenAI-style image endpoints: bearer auth,
 * JSON body, and error mapping for both `{error: {message}}` and `{detail}`
 * error envelopes. Returns the raw response text.
 */
async function postImageEndpointRequest(options: {
	label: string;
	url: string;
	body: unknown;
	apiKey: ApiKey;
	resolveHeaders?: () => Promise<Record<string, string> | undefined>;
	fetchImpl: FetchImpl;
	signal: AbortSignal | undefined;
}): Promise<string> {
	return withAuth(
		options.apiKey,
		async key => {
			const configuredHeaders = await options.resolveHeaders?.();
			const resp = await options.fetchImpl(options.url, {
				method: "POST",
				headers: {
					...configuredHeaders,
					...(key !== NO_AUTH_SENTINEL ? { Authorization: `Bearer ${key}` } : {}),
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(options.body),
				signal: options.signal,
			});
			const rawText = await resp.text();
			if (!resp.ok) {
				let message = rawText;
				try {
					const parsedErr: { detail?: string; error?: { message?: string } } = JSON.parse(rawText);
					message = parsedErr.detail ?? parsedErr.error?.message ?? message;
				} catch {
					// Keep raw text.
				}
				throw new ProviderHttpError(
					`${options.label} image request failed (${resp.status}): ${message}`,
					resp.status,
					{
						headers: resp.headers,
					},
				);
			}
			return rawText;
		},
		{ signal: options.signal },
	);
}

/** Decode an OpenAI-style images response (`{data: [{b64_json, url}]}`) into inline images. */
async function collectImageEndpointImages(
	rawText: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<InlineImageData[]> {
	const data: {
		data?: Array<{ b64_json?: string | null; url?: string | null; media_type?: string | null }>;
	} = JSON.parse(rawText);
	const inlineImages: InlineImageData[] = [];
	for (const entry of data.data ?? []) {
		if (entry.b64_json) {
			const bytes = Buffer.from(entry.b64_json, "base64");
			const mimeType = entry.media_type ?? parseImageMetadata(bytes)?.mimeType ?? "image/png";
			inlineImages.push({ data: entry.b64_json, mimeType });
		} else if (entry.url) {
			inlineImages.push(await loadImageFromUrl(entry.url, fetchImpl, signal));
		}
	}
	return inlineImages;
}

/** Standard tool result for an image-endpoint provider (no accompanying response text). */
async function buildImageEndpointResult(
	provider: string,
	model: string,
	inlineImages: InlineImageData[],
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	if (inlineImages.length === 0) {
		return {
			content: [{ type: "text", text: "No image data returned." }],
			details: {
				provider,
				model,
				imageCount: 0,
				imagePaths: [],
				images: [],
			},
		};
	}
	const imagePaths = await saveImagesToTemp(inlineImages);
	return {
		content: [{ type: "text", text: buildResponseSummary(provider, model, imagePaths, undefined) }],
		details: {
			provider,
			model,
			imageCount: inlineImages.length,
			imagePaths,
			images: inlineImages,
		},
	};
}

interface ParsedAntigravityCredentials {
	accessToken: string;
	projectId: string;
}

function parseAntigravityCredentials(raw: string): ParsedAntigravityCredentials | null {
	try {
		const parsed: { token?: string; projectId?: string } = JSON.parse(raw);
		if (parsed.token && parsed.projectId) {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// Invalid JSON
	}
	return null;
}

function resolveAntigravityEndpoints(): string[] {
	try {
		const mode = settings.get("providers.antigravityEndpoint");
		if (mode === "production") return [DEFAULT_ANTIGRAVITY_ENDPOINT_PROD];
		if (mode === "sandbox") return [DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX];
	} catch {
		// Use the default fallback order when settings are unavailable.
	}
	return [DEFAULT_ANTIGRAVITY_ENDPOINT_PROD, DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX];
}

interface AntigravityImageTarget {
	model: string;
	endpoints: string[];
}

async function resolveAntigravityImageTarget(
	bearer: string,
	fallbackModel: string,
	cache: Map<string, AntigravityImageTarget>,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<AntigravityImageTarget> {
	const cached = cache.get(bearer);
	if (cached) return cached;

	const endpoints = resolveAntigravityEndpoints();
	const advertised = await fetchAntigravityImageModel({
		token: bearer,
		endpoint: endpoints.length === 1 ? endpoints[0] : undefined,
		userAgent: getAntigravityUserAgent(),
		signal,
		fetcher: fetchImpl,
	});
	const target: AntigravityImageTarget = advertised
		? {
				model: advertised.id,
				endpoints: [advertised.endpoint, ...endpoints.filter(endpoint => endpoint !== advertised.endpoint)],
			}
		: { model: fallbackModel, endpoints };
	cache.set(bearer, target);
	return target;
}

const HOSTED_CHAT_MODEL_PRIORITY = ["gpt-5.5", "gpt-5.4", "gpt-5.1", "gpt-5", "gpt-5-codex"];

function resolveHostedImageCarrier(
	modelRegistry: ModelRegistry,
	selectedModel: Model,
	activeModel: Model | undefined,
): Model | undefined {
	if (activeModel?.provider === selectedModel.provider && isOpenAIHostedImageModel(activeModel)) return activeModel;
	for (const id of HOSTED_CHAT_MODEL_PRIORITY) {
		const model = modelRegistry.find(selectedModel.provider, id);
		if (model && isOpenAIHostedImageModel(model)) return model;
	}
	return modelRegistry
		.getAvailable()
		.find(model => model.provider === selectedModel.provider && isOpenAIHostedImageModel(model));
}

async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const buffer = await Bun.file(resolved).bytes();
		if (buffer.length > MAX_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}

		const metadata = parseImageMetadata(buffer);
		const mimeType = metadata?.mimeType;
		if (!mimeType) {
			throw new Error(`Unsupported image type: ${imagePath}`);
		}

		return { data: buffer.toBase64(), mimeType };
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Image file not found: ${imagePath}`);
		throw err;
	}
}

async function resolveInputImage(input: ImageInput, cwd: string): Promise<InlineImageData> {
	if (input.path) {
		return loadImageFromPath(input.path, cwd);
	}

	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		const mimeType = normalized.mimeType ?? input.mime_type;
		if (!mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType };
	}

	throw new Error("input_images entries must include either path or data.");
}

function getExtensionForMime(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	return map[mimeType] ?? "png";
}

async function saveImageToTemp(image: InlineImageData): Promise<string> {
	const ext = getExtensionForMime(image.mimeType);
	const filename = `omp-image-${Snowflake.next()}.${ext}`;
	const filepath = path.join(os.tmpdir(), filename);
	await Bun.write(filepath, Buffer.from(image.data, "base64"));
	return filepath;
}

async function saveImagesToTemp(images: InlineImageData[]): Promise<string[]> {
	return Promise.all(images.map(saveImageToTemp));
}

function buildResponseSummary(
	provider: string,
	model: string,
	imagePaths: string[],
	responseText: string | undefined,
): string {
	const lines = [`Provider: ${provider}`, `Model: ${model}`, `Generated ${imagePaths.length} image(s):`];
	for (const p of imagePaths) {
		lines.push(`  ${p}`);
	}
	if (responseText) {
		lines.push("", responseText.trim());
	}
	return lines.join("\n");
}

function collectResponseText(parts: GeminiPart[]): string | undefined {
	const texts = parts.map(part => part.text).filter((text): text is string => Boolean(text));
	const combined = texts.join("\n").trim();
	return combined.length > 0 ? combined : undefined;
}

function collectInlineImages(parts: GeminiPart[]): InlineImageData[] {
	const images: InlineImageData[] = [];
	for (const part of parts) {
		const data = part.inlineData?.data;
		const mimeType = part.inlineData?.mimeType;
		if (!data || !mimeType) continue;
		images.push({ data, mimeType });
	}
	return images;
}

function isOpenAIHostedImageModel(model: Model | undefined): model is Model {
	if (!model) return false;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
	const modelId = model.id.toLowerCase();
	return modelId.startsWith("gpt-") || modelId === "o3" || modelId.startsWith("o3-");
}

function resolveOpenAIImageSize(aspectRatio: string | undefined, imageSize: string | undefined): string | undefined {
	if (imageSize) return imageSize;
	switch (aspectRatio) {
		case "1:1":
			return "1024x1024";
		case "3:4":
		case "9:16":
			return "1024x1536";
		case "4:3":
		case "16:9":
			return "1536x1024";
		default:
			return undefined;
	}
}

function buildOpenAIHostedImageRequest(
	carrierModel: Model,
	imageModel: Model,
	promptText: string,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	stream: boolean,
): OpenAIHostedImageRequest {
	const content: OpenAIInputContent[] = [{ type: "input_text", text: promptText }];
	for (const image of inputImages) {
		content.push({ type: "input_image", detail: "auto", image_url: toDataUrl(image) });
	}

	const size = resolveOpenAIImageSize(params.aspect_ratio, params.image_size);
	const tool: OpenAIImageGenerationTool = {
		type: "image_generation",
		action: inputImages.length > 0 ? "edit" : "generate",
		output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
		...(size ? { size } : {}),
		...(imageModel.api === "openai-responses" ? { model: imageModel.id } : {}),
	};

	return {
		model: carrierModel.id,
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		...(stream ? { instructions: IMAGE_SYSTEM_INSTRUCTION } : {}),
		...(stream ? { stream: true } : {}),
	};
}

function createOpenAIInlineImage(data: string): InlineImageData {
	const bytes = Buffer.from(data, "base64");
	const mimeType = parseImageMetadata(bytes)?.mimeType ?? OPENAI_IMAGE_MIME_TYPE;
	return { data, mimeType };
}

function collectOpenAIHostedImageResult(response: OpenAIHostedImageResponse): OpenAIHostedImageResult {
	const images: InlineImageData[] = [];
	const textParts: string[] = [];
	let revisedPrompt: string | undefined;

	for (const output of response.output ?? []) {
		if (output.type === "image_generation_call") {
			if (output.result) {
				images.push(createOpenAIInlineImage(output.result));
			}
			if (output.revised_prompt) {
				revisedPrompt = output.revised_prompt;
			}
			continue;
		}

		for (const part of output.content ?? []) {
			if (part.type === "output_text" && part.text) {
				textParts.push(part.text);
			} else if (part.type === "refusal" && part.refusal) {
				textParts.push(part.refusal);
			}
		}
	}

	const responseText = textParts.join("\n").trim();
	return {
		images,
		revisedPrompt,
		responseText: responseText.length > 0 ? responseText : undefined,
		usage: response.usage,
	};
}

function getOpenAIResponseErrorMessage(rawText: string): string {
	try {
		const parsed: { error?: { message?: string } } = JSON.parse(rawText);
		return parsed.error?.message ?? rawText;
	} catch {
		return rawText;
	}
}

function getOpenAIBaseUrl(model: Model): string {
	const fallback =
		model.api === "openai-codex-responses" || model.provider === "openai-codex"
			? CODEX_BASE_URL
			: DEFAULT_OPENAI_BASE_URL;
	return (model.baseUrl || fallback).replace(/\/+$/, "");
}

function getOpenAIResponsesUrl(model: Model): string {
	const baseUrl = getOpenAIBaseUrl(model);
	if (model.api !== "openai-codex-responses" && model.provider !== "openai-codex") {
		return `${baseUrl}/responses`;
	}
	const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(URL_PATHS.RESPONSES.slice(1), baseWithSlash)
		.toString()
		.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

function buildOpenAIImageHeaders(
	model: Model,
	configuredHeaders: Record<string, string> | undefined,
	apiKey: string,
	sessionId: string | undefined,
): Headers {
	const headers = new Headers(configuredHeaders);
	headers.set("Content-Type", "application/json");
	headers.set("Authorization", `Bearer ${apiKey}`);

	if (model.api === "openai-codex-responses" || model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		headers.delete("x-api-key");
		if (accountId) {
			headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
		}
		// Same region gate as the chat transport; the token carries the value.
		applyCodexResidencyHeader(headers, apiKey);
		headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
		headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		headers.set("User-Agent", USER_AGENT);
		if (sessionId) {
			headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
			headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		}
	}

	return headers;
}

async function parseOpenAIHostedImageSse(response: Response, signal?: AbortSignal): Promise<OpenAIHostedImageResult> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const fallbackOutput: OpenAIResponseOutput[] = [];
	let completedResponse: OpenAIHostedImageResponse | undefined;

	for await (const event of readSseJson<OpenAISseEvent>(response.body, signal)) {
		if (event.type === "error") {
			const message = event.error?.message ?? event.message ?? "OpenAI image request failed";
			throw new Error(message);
		}
		if (event.type === "response.failed") {
			const message = event.response?.error?.message ?? "OpenAI image request failed";
			throw new Error(message);
		}
		if (event.type === "response.output_item.done" && event.item) {
			fallbackOutput.push(event.item);
		}
		if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
			completedResponse = event.response;
		}
	}

	return collectOpenAIHostedImageResult(
		completedResponse?.output?.length
			? completedResponse
			: { output: fallbackOutput, usage: completedResponse?.usage },
	);
}

async function generateOpenAIHostedImage(
	apiKey: string,
	carrierModel: Model,
	imageModel: Model,
	configuredHeaders: Record<string, string> | undefined,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<OpenAIHostedImageResult> {
	const promptText = assemblePrompt(params);
	const stream = carrierModel.api === "openai-codex-responses";
	const requestBody = buildOpenAIHostedImageRequest(carrierModel, imageModel, promptText, params, inputImages, stream);
	const response = await fetchImpl(getOpenAIResponsesUrl(carrierModel), {
		method: "POST",
		headers: buildOpenAIImageHeaders(carrierModel, configuredHeaders, apiKey, sessionId),
		body: JSON.stringify(requestBody),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new ProviderHttpError(
			`OpenAI image request failed (${response.status}): ${getOpenAIResponseErrorMessage(errorText)}`,
			response.status,
			{ headers: response.headers },
		);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (stream || contentType.includes("text/event-stream")) {
		return parseOpenAIHostedImageSse(response, signal);
	}

	const data: unknown = await response.json();
	if (!isOpenAIHostedImageResponse(data)) {
		throw new Error("OpenAI image request returned a malformed response");
	}
	if (data.error) {
		throw new Error(data.error.message ?? "OpenAI image request failed");
	}
	if (data.output === undefined) {
		throw new Error("OpenAI image request returned a malformed response");
	}
	return collectOpenAIHostedImageResult(data);
}

function combineParts(response: GeminiGenerateContentResponse): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const candidate of response.candidates ?? []) {
		const candidateParts = candidate.content?.parts ?? [];
		parts.push(...candidateParts);
	}
	return parts;
}

function buildAntigravityRequest(
	prompt: string,
	model: string,
	projectId: string,
	aspectRatio: string | undefined,
	imageSize: string | undefined,
	inputImages: InlineImageData[],
): AntigravityRequest {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of inputImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: prompt });

	const imageConfig = aspectRatio || imageSize ? { aspectRatio: aspectRatio, imageSize: imageSize } : undefined;

	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }] },
			generationConfig: {
				responseModalities: ["IMAGE"],
				imageConfig,
				candidateCount: 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

// xAI image-edit cap per docs.x.ai (POST /v1/images/edits supports up to 3
// source images for multi-reference editing).
const XAI_MAX_EDIT_IMAGES = 3;

// Map the OpenAI-style pixel-size enum (image_size) to xAI's discrete tier.
// "1024x1024" → "1k"; anything wider (1536x... or ...x1536) → "2k". Absent
// image_size defaults to "1k", matching hermes-agent's DEFAULT_RESOLUTION
// (plugins/image_gen/xai/__init__.py:71).
function resolveXAIResolution(imageSize: string | undefined): "1k" | "2k" {
	if (!imageSize || imageSize === "1024x1024") return "1k";
	return "2k";
}

interface AntigravitySseResult {
	images: InlineImageData[];
	text: string[];
	usage?: GeminiUsageMetadata;
}

async function parseAntigravitySseForImage(response: Response, signal?: AbortSignal): Promise<AntigravitySseResult> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const textParts: string[] = [];
	const images: InlineImageData[] = [];
	let usage: GeminiUsageMetadata | undefined;

	for await (const chunk of readSseJson<AntigravityResponseChunk>(response.body, signal)) {
		const responseData = chunk.response;
		if (!responseData) continue;
		if (!responseData.candidates) continue;
		for (const candidate of responseData.candidates) {
			const parts = candidate.content?.parts;
			if (!parts) continue;
			for (const part of parts) {
				if (part.text) {
					textParts.push(part.text);
				}
				const inlineData = part.inlineData;
				if (inlineData?.data && inlineData.mimeType) {
					images.push({ data: inlineData.data, mimeType: inlineData.mimeType });
				}
			}
		}
		if (responseData.usageMetadata) {
			usage = responseData.usageMetadata;
		}
	}

	return { images, text: textParts, usage };
}

function imageBaseUrl(model: Model): string {
	if (!model.baseUrl) throw new Error(`Image model ${model.provider}/${model.id} has no base URL.`);
	return model.baseUrl.replace(/\/+$/, "");
}

function resolveComfyUIImageSize(params: ImageGenParams): { width: number; height: number } | undefined {
	if (params.image_size) {
		const [width, height] = params.image_size.split("x").map(Number);
		return { width, height };
	}
	if (!params.aspect_ratio) return undefined;
	const [horizontal, vertical] = params.aspect_ratio.split(":").map(Number);
	const ratio = horizontal / vertical;
	return {
		width: Math.round((1024 * Math.sqrt(ratio)) / 32) * 32,
		height: Math.round(1024 / Math.sqrt(ratio) / 32) * 32,
	};
}

async function generateOpenAIImages(
	model: Model,
	apiKey: ApiKey,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	modelRegistry: ModelRegistry,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const promptText = assemblePrompt(params);
	const baseUrl = imageBaseUrl(model);
	const size = resolveOpenAIImageSize(params.aspect_ratio, params.image_size);
	const isXAI = model.provider === "xai" || model.provider === "xai-oauth";
	const generationBody = isXAI
		? {
				model: model.id,
				prompt: promptText,
				aspect_ratio: params.aspect_ratio ?? "1:1",
				resolution: resolveXAIResolution(params.image_size),
				n: 1,
				response_format: "b64_json",
			}
		: {
				model: model.id,
				prompt: promptText,
				n: 1,
				response_format: "b64_json",
				...(size ? { size } : {}),
			};
	const references = inputImages.map(image => ({
		type: "image_url",
		url: toDataUrl(image),
	}));
	if (isXAI && references.length > XAI_MAX_EDIT_IMAGES) {
		throw new Error(
			`${model.provider} image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${references.length}.`,
		);
	}
	const [firstReference, ...remainingReferences] = references;
	const editBody = isXAI
		? remainingReferences.length === 0
			? { ...generationBody, image: firstReference }
			: { ...generationBody, images: references }
		: { ...generationBody, input_references: references };
	const resolveHeaders = () => modelRegistry.resolveModelHeaders(model, signal);

	let rawText: string;
	if (inputImages.length === 0) {
		rawText = await postImageEndpointRequest({
			label: `${model.provider}/${model.id}`,
			url: `${baseUrl}/images/generations`,
			body: generationBody,
			apiKey,
			resolveHeaders,
			fetchImpl,
			signal,
		});
	} else {
		try {
			rawText = await postImageEndpointRequest({
				label: `${model.provider}/${model.id}`,
				url: `${baseUrl}/images/edits`,
				body: editBody,
				apiKey,
				resolveHeaders,
				fetchImpl,
				signal,
			});
		} catch (error) {
			if (!(error instanceof ProviderHttpError) || error.status !== 404) throw error;
			rawText = await postImageEndpointRequest({
				label: `${model.provider}/${model.id}`,
				url: `${baseUrl}/images/generations`,
				body: editBody,
				apiKey,
				resolveHeaders,
				fetchImpl,
				signal,
			});
		}
	}
	const images = await collectImageEndpointImages(rawText, fetchImpl, signal);
	return buildImageEndpointResult(model.provider, model.id, images);
}

async function generateOpenRouterImages(
	model: Model,
	apiKey: ApiKey,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	modelRegistry: ModelRegistry,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const inputReferences = inputImages.map(image => ({
		type: "image_url",
		image_url: { url: toDataUrl(image) },
	}));
	const body = {
		model: model.id,
		prompt: assemblePrompt(params),
		n: 1,
		...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
		...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
	};
	const rawText = await postImageEndpointRequest({
		label: `${model.provider}/${model.id}`,
		url: `${imageBaseUrl(model)}/images`,
		body,
		apiKey,
		resolveHeaders: () => modelRegistry.resolveModelHeaders(model, signal),
		fetchImpl,
		signal,
	});
	const images = await collectImageEndpointImages(rawText, fetchImpl, signal);
	return buildImageEndpointResult(model.provider, model.id, images);
}

async function generateGoogleImage(
	model: Model,
	apiKey: ApiKey,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	modelRegistry: ModelRegistry,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = inputImages.map(image => ({
		inlineData: image,
	}));
	parts.push({ text: assemblePrompt(params) });
	const generationConfig: {
		responseModalities: GeminiResponseModality[];
		imageConfig?: { aspectRatio?: string; imageSize?: string };
	} = { responseModalities: ["IMAGE"] };
	if (params.aspect_ratio || params.image_size) {
		generationConfig.imageConfig = {
			aspectRatio: params.aspect_ratio,
			imageSize: params.image_size,
		};
	}
	const requestBody = {
		contents: [{ role: "user", parts }],
		generationConfig,
	};
	const rawText = await withAuth(
		apiKey,
		async key => {
			const configuredHeaders = await modelRegistry.resolveModelHeaders(model, signal);
			const response = await fetchImpl(
				`${imageBaseUrl(model)}/models/${encodeURIComponent(model.id)}:generateContent`,
				{
					method: "POST",
					headers: {
						...configuredHeaders,
						"Content-Type": "application/json",
						"x-goog-api-key": key,
					},
					body: JSON.stringify(requestBody),
					signal,
				},
			);
			const text = await response.text();
			if (!response.ok) {
				throw new ProviderHttpError(
					`${model.provider}/${model.id} image request failed (${response.status}): ${getOpenAIResponseErrorMessage(text)}`,
					response.status,
					{ headers: response.headers },
				);
			}
			return text;
		},
		{ signal },
	);
	const data: GeminiGenerateContentResponse = JSON.parse(rawText);
	const responseParts = combineParts(data);
	const responseText = collectResponseText(responseParts);
	const images = collectInlineImages(responseParts);
	if (images.length === 0) {
		const blocked = data.promptFeedback?.blockReason
			? `Blocked: ${data.promptFeedback.blockReason}`
			: "No image data returned.";
		return {
			content: [{ type: "text", text: `${blocked}${responseText ? `\n\n${responseText}` : ""}` }],
			details: {
				provider: model.provider,
				model: model.id,
				imageCount: 0,
				imagePaths: [],
				images: [],
				responseText,
				promptFeedback: data.promptFeedback,
				usage: data.usageMetadata,
			},
		};
	}
	const imagePaths = await saveImagesToTemp(images);
	return {
		content: [{ type: "text", text: buildResponseSummary(model.provider, model.id, imagePaths, responseText) }],
		details: {
			provider: model.provider,
			model: model.id,
			imageCount: images.length,
			imagePaths,
			images,
			responseText,
			promptFeedback: data.promptFeedback,
			usage: data.usageMetadata,
		},
	};
}

async function generateAntigravityImage(
	model: Model,
	apiKey: ApiKey,
	initialCredentials: ParsedAntigravityCredentials,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const targetCache = new Map<string, AntigravityImageTarget>();
	let usedModel = model.id;
	const response = await withAuth(
		apiKey,
		async key => {
			const credentials = parseAntigravityCredentials(key) ?? initialCredentials;
			const target = await resolveAntigravityImageTarget(
				credentials.accessToken,
				model.id,
				targetCache,
				fetchImpl,
				signal,
			);
			usedModel = target.model;
			const body = buildAntigravityRequest(
				assemblePrompt(params),
				target.model,
				credentials.projectId,
				params.aspect_ratio,
				params.image_size,
				inputImages,
			);
			let lastError: ProviderHttpError | undefined;
			for (let index = 0; index < target.endpoints.length; index++) {
				const endpoint = target.endpoints[index];
				const result = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${credentials.accessToken}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"User-Agent": getAntigravityUserAgent(),
					},
					body: JSON.stringify(body),
					signal,
				});
				if (result.ok) return result;
				const text = await result.text();
				lastError = new ProviderHttpError(
					`${model.provider}/${model.id} image request failed (${result.status}): ${getOpenAIResponseErrorMessage(text)}`,
					result.status,
					{ headers: result.headers },
				);
				const retryable = result.status === 429 || (result.status >= 500 && result.status < 600);
				if (!retryable || index === target.endpoints.length - 1) throw lastError;
			}
			throw lastError ?? new Error(`${model.provider}/${model.id} image request failed.`);
		},
		{ signal },
	);
	const parsed = await parseAntigravitySseForImage(response, signal);
	const responseText = parsed.text.length > 0 ? parsed.text.join(" ") : undefined;
	if (parsed.images.length === 0) {
		return {
			content: [{ type: "text", text: `No image data returned.${responseText ? `\n\n${responseText}` : ""}` }],
			details: {
				provider: model.provider,
				model: usedModel,
				imageCount: 0,
				imagePaths: [],
				images: [],
				responseText,
				usage: parsed.usage,
			},
		};
	}
	const imagePaths = await saveImagesToTemp(parsed.images);
	return {
		content: [{ type: "text", text: buildResponseSummary(model.provider, usedModel, imagePaths, responseText) }],
		details: {
			provider: model.provider,
			model: usedModel,
			imageCount: parsed.images.length,
			imagePaths,
			images: parsed.images,
			responseText,
			usage: parsed.usage,
		},
	};
}

async function generateHostedImage(
	imageModel: Model,
	carrierModel: Model,
	apiKey: ApiKey,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	modelRegistry: ModelRegistry,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const parsed = await withAuth(
		apiKey,
		async key =>
			generateOpenAIHostedImage(
				key,
				carrierModel,
				imageModel,
				await modelRegistry.resolveModelHeaders(carrierModel, signal),
				params,
				inputImages,
				fetchImpl,
				signal,
				sessionId,
			),
		{ signal },
	);
	if (parsed.images.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: `No image data returned.${parsed.responseText ? `\n\n${parsed.responseText}` : ""}`,
				},
			],
			details: {
				provider: imageModel.provider,
				model: imageModel.id,
				imageCount: 0,
				imagePaths: [],
				images: [],
				responseText: parsed.responseText,
				revisedPrompt: parsed.revisedPrompt,
				usage: parsed.usage,
			},
		};
	}
	const imagePaths = await saveImagesToTemp(parsed.images);
	return {
		content: [
			{
				type: "text",
				text: buildResponseSummary(imageModel.provider, imageModel.id, imagePaths, parsed.responseText),
			},
		],
		details: {
			provider: imageModel.provider,
			model: imageModel.id,
			imageCount: parsed.images.length,
			imagePaths,
			images: parsed.images,
			responseText: parsed.responseText,
			revisedPrompt: parsed.revisedPrompt,
			usage: parsed.usage,
		},
	};
}

export const imageGenTool: CustomTool<typeof imageGenSchema, ImageGenToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	strict: false,
	approval: "write",
	description: prompt.render(imageGenDescription),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		let comfyPromptId: string | undefined;
		return untilAborted(signal, async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			let defaultRequestSignal: AbortSignal | undefined;
			const fetchImpl = ctx.fetch ?? fetch;
			const effectiveSettings = ctx.settings ?? settings;
			const pool = roleCandidatePool("image", effectiveSettings, ctx.modelRegistry);
			let candidates: Model[];
			if (params.model) {
				const selected = resolveModelRoleValue(params.model, pool, { settings: effectiveSettings }).model;
				if (!selected)
					throw new Error(`Image model selector did not match an available image model: ${params.model}`);
				candidates = [selected];
			} else {
				candidates = resolveRoleChain("image", effectiveSettings, pool, {
					hoistProvider: ctx.model?.provider,
				}).map(candidate => candidate.model);
			}

			const failures: ProviderHttpError[] = [];
			const skipped: string[] = [];
			let inputImages: InlineImageData[] | undefined;
			for (const model of candidates) {
				const requestSignal =
					model.api === "comfyui" && model.comfyui?.timeoutMs !== undefined
						? signal
						: (defaultRequestSignal ??= ptree.combineSignals(signal, IMAGE_TIMEOUT));
				if (
					model.api !== "openai-images" &&
					model.api !== "openrouter-images" &&
					model.api !== "google-generative-ai" &&
					model.api !== "google-gemini-cli" &&
					model.api !== "openai-responses" &&
					model.api !== "openai-codex-responses" &&
					model.api !== "comfyui"
				) {
					logger.warn("Skipping unsupported image model API", {
						provider: model.provider,
						model: model.id,
						api: model.api,
					});
					skipped.push(`${model.provider}/${model.id} (unsupported ${model.api})`);
					continue;
				}

				const initialKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal: requestSignal });
				const keylessImageTransport =
					model.api === "openai-images" || model.api === "openrouter-images" || model.api === "comfyui";
				if (!isAuthenticated(initialKey) && !(keylessImageTransport && initialKey === NO_AUTH_SENTINEL)) {
					skipped.push(`${model.provider}/${model.id} (credentials unavailable)`);
					continue;
				}
				const antigravityCredentials =
					model.api === "google-gemini-cli" ? parseAntigravityCredentials(initialKey) : null;
				if (model.api === "google-gemini-cli" && !antigravityCredentials) {
					skipped.push(`${model.provider}/${model.id} (invalid credentials)`);
					continue;
				}

				let carrierModel: Model | undefined;
				let carrierKey: ApiKey | undefined;
				if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
					carrierModel = resolveHostedImageCarrier(ctx.modelRegistry, model, ctx.model);
					if (!carrierModel) {
						skipped.push(`${model.provider}/${model.id} (hosted chat carrier unavailable)`);
						continue;
					}
					const resolvedCarrierKey = await ctx.modelRegistry.getApiKey(carrierModel, sessionId, {
						signal: requestSignal,
					});
					if (!isAuthenticated(resolvedCarrierKey)) {
						skipped.push(`${model.provider}/${model.id} (carrier credentials unavailable)`);
						continue;
					}
					if (
						carrierModel.api === "openai-codex-responses" &&
						isOfficialCodexApiUrl(getOpenAIResponsesUrl(carrierModel)) &&
						!getCodexAccountId(resolvedCarrierKey)
					) {
						skipped.push(`${model.provider}/${model.id} (Codex subscription unavailable)`);
						continue;
					}
					carrierKey = ctx.modelRegistry.resolver(carrierModel, sessionId);
				}

				if (!inputImages) {
					inputImages = [];
					for (const input of params.input ?? []) {
						inputImages.push(await resolveInputImage(input, ctx.sessionManager.getCwd()));
					}
				}

				try {
					switch (model.api) {
						case "comfyui": {
							if (!model.comfyui)
								throw new Error(`ComfyUI workflow configuration missing for ${model.provider}/${model.id}`);
							const images = await generateComfyUIImage({
								baseUrl: imageBaseUrl(model),
								config: model.comfyui,
								prompt: assemblePrompt(params),
								inputImages,
								size: resolveComfyUIImageSize(params),
								apiKey: ctx.modelRegistry.resolver(model, sessionId),
								resolveHeaders: () => ctx.modelRegistry.resolveModelHeaders(model, requestSignal),
								fetchImpl,
								signal: requestSignal,
								onQueued: promptId => {
									comfyPromptId = promptId;
								},
							});
							return buildImageEndpointResult(model.provider, model.id, images);
						}
						case "openai-images":
							return await generateOpenAIImages(
								model,
								ctx.modelRegistry.resolver(model, sessionId),
								params,
								inputImages,
								ctx.modelRegistry,
								fetchImpl,
								requestSignal,
							);
						case "openrouter-images":
							return await generateOpenRouterImages(
								model,
								ctx.modelRegistry.resolver(model, sessionId),
								params,
								inputImages,
								ctx.modelRegistry,
								fetchImpl,
								requestSignal,
							);
						case "google-generative-ai":
							return await generateGoogleImage(
								model,
								ctx.modelRegistry.resolver(model, sessionId),
								params,
								inputImages,
								ctx.modelRegistry,
								fetchImpl,
								requestSignal,
							);
						case "google-gemini-cli":
							if (!antigravityCredentials) throw new Error("Antigravity credentials became unavailable.");
							return await generateAntigravityImage(
								model,
								ctx.modelRegistry.resolver(model, sessionId),
								antigravityCredentials,
								params,
								inputImages,
								fetchImpl,
								requestSignal,
							);
						case "openai-responses":
						case "openai-codex-responses":
							if (!carrierModel || !carrierKey) throw new Error("Hosted image carrier became unavailable.");
							return await generateHostedImage(
								model,
								carrierModel,
								carrierKey,
								params,
								inputImages,
								ctx.modelRegistry,
								fetchImpl,
								requestSignal,
								sessionId,
							);
					}
				} catch (error) {
					if (!(error instanceof ProviderHttpError) || requestSignal?.aborted) throw error;
					failures.push(error);
				}
			}

			const attempted = candidates.map(model => `${model.provider}/${model.id}`).join(", ");
			const suffix = skipped.length > 0 ? ` Skipped: ${skipped.join(", ")}.` : "";
			throw new AggregateError(
				failures,
				`Image generation exhausted the resolved image chain${attempted ? `: ${attempted}` : "."}${suffix}`,
			);
		}).catch(error => {
			if (signal?.aborted && comfyPromptId) {
				throw new Error(
					`Stopped waiting for ComfyUI prompt ${comfyPromptId}; the remote render may still be running. Check its history before retrying.`,
					{ cause: error },
				);
			}
			throw error;
		});
	},
};

export async function getImageGenTools(
	_modelRegistry?: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}

export async function getImageGenToolsWithRegistry(
	_modelRegistry: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}
