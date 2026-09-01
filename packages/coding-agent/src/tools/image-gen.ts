import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	type ApiKey,
	type FetchImpl,
	getEnvApiKey,
	getOpenRouterHeaders,
	isOfficialCodexApiUrl,
	type Model,
	withAuth,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
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
	$env,
	isEnoent,
	parseImageMetadata,
	prompt,
	ptree,
	readSseJson,
	Snowflake,
	USER_AGENT,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { isAuthenticated, type ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { resolveXAIHttpCredentials } from "../lib/xai-http";
import imageGenDescription from "../prompts/tools/image-gen.md" with { type: "text" };
import { AUTO_IMAGE_PROVIDER_ORDER, type ImageProvider, isImageProviderId } from "./image-providers";
import { resolveReadPath } from "./path-utils";

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3-pro-image";
const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image";
const DEFAULT_DEEPINFRA_IMAGE_MODEL = "black-forest-labs/FLUX-2-pro";
const DEEPINFRA_IMAGES_URL = "https://api.deepinfra.com/v1/openai/images/generations";
const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const MAX_IMAGE_SIZE = 35 * 1024 * 1024;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_IMAGE_OUTPUT_FORMAT = "webp";
const OPENAI_IMAGE_MIME_TYPE = "image/webp";

const DEFAULT_ANTIGRAVITY_ENDPOINT_PROD = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

export type { ImageProvider } from "./image-providers";
export type ImageProviderPreference = ImageProvider | "auto";

interface ImageApiKey {
	provider: ImageProvider;
	apiKey: ApiKey;
	projectId?: string;
	model?: Model;
}

const COMMON_IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
const XAI_IMAGE_ASPECT_RATIOS = [...COMMON_IMAGE_ASPECT_RATIOS, "3:2", "2:3"] as const;
const COMMON_IMAGE_ASPECT_RATIO_SET = new Set<string>(COMMON_IMAGE_ASPECT_RATIOS);
const IMAGE_PROVIDER_REQUEST_CHOICES = ["auto", ...AUTO_IMAGE_PROVIDER_ORDER] as const;
const IMAGE_PROVIDER_PREFERENCES = new Set<string>(IMAGE_PROVIDER_REQUEST_CHOICES);

const responseModalitySchema = type('"IMAGE" | "TEXT"');

const aspectRatioSchema = type.enumerated(...XAI_IMAGE_ASPECT_RATIOS).describe("aspect ratio");
const imageSizeSchema = type('"1024x1024" | "1536x1024" | "1024x1536"').describe("image size");

const inputImageSchema = type({
	"path?": type("string").describe("input image path"),
	"data?": type("string").describe("base64 image data"),
	"mime_type?": type("string").describe("mime type"),
});

const imageProviderSchema = type
	.enumerated(...IMAGE_PROVIDER_REQUEST_CHOICES)
	.describe("image provider for this request; overrides the providers.imageOrder setting (default: use the setting)");

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
	"provider?": imageProviderSchema,
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

interface OpenRouterImageUrl {
	url: string;
}

interface OpenRouterContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: OpenRouterImageUrl;
}

interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	images?: Array<string | { image_url?: OpenRouterImageUrl }>;
}

interface OpenRouterChoice {
	message?: OpenRouterMessage;
}

interface OpenRouterResponse {
	choices?: OpenRouterChoice[];
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

interface XAIImageReference {
	// OpenAI-compat discriminator. Every code example at
	// docs.x.ai/developers/rest-api-reference/inference/images sends this
	// alongside `url`; the schema text doesn't strictly require it, but
	// matching the documented wire format avoids relying on schema-vs-example.
	readonly type: "image_url";
	readonly url: string;
}

interface XAIImageRequestBase {
	readonly model: string;
	readonly prompt: string;
	readonly aspect_ratio: string;
	readonly resolution: "1k" | "2k";
	readonly n: number;
	readonly response_format: "b64_json" | "url";
}

// xAI image request body. Three shapes:
//   1. text-only generation                  → POST /v1/images/generations
//   2. single-source edit (image field)      → POST /v1/images/edits
//   3. multi-reference edit (images field)   → POST /v1/images/edits
// `image` and `images` are mutually exclusive per docs.x.ai; the discriminated
// union enforces that statically. The runtime cap (XAI_MAX_EDIT_IMAGES) bounds
// the array length, which TypeScript cannot encode without lossy tuple unions.
type XAIImageRequestBody =
	| (XAIImageRequestBase & { readonly image?: never; readonly images?: never })
	| (XAIImageRequestBase & { readonly image: XAIImageReference; readonly images?: never })
	| (XAIImageRequestBase & { readonly images: readonly XAIImageReference[]; readonly image?: never });

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
	provider: ImageProvider;
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

function resolveOpenRouterModel(model: string): string {
	return model.includes("/") ? model : `google/${model}`;
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
	const buffer = await response.bytes();
	return { data: buffer.toBase64(), mimeType: contentType };
}

function collectOpenRouterResponseText(message: OpenRouterMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") {
		const trimmed = message.content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (Array.isArray(message.content)) {
		const texts = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.filter((text): text is string => Boolean(text));
		const combined = texts.join("\n").trim();
		return combined.length > 0 ? combined : undefined;
	}
	return undefined;
}

function extractOpenRouterImageUrls(message: OpenRouterMessage | undefined): string[] {
	const urls: string[] = [];
	if (!message) return urls;
	for (const image of message.images ?? []) {
		if (typeof image === "string") {
			urls.push(image);
			continue;
		}
		if (image.image_url?.url) {
			urls.push(image.image_url.url);
		}
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type === "image_url" && part.image_url?.url) {
				urls.push(part.image_url.url);
			}
		}
	}
	return urls;
}

/**
 * Shared POST for OpenAI-style image endpoints (xAI, DeepInfra): bearer auth,
 * JSON body, and error mapping for both `{error: {message}}` and `{detail}`
 * error envelopes. Returns the raw response text.
 */
async function postImageEndpointRequest(options: {
	label: string;
	url: string;
	body: unknown;
	apiKey: ApiKey;
	fetchImpl: FetchImpl;
	signal: AbortSignal | undefined;
}): Promise<string> {
	return withAuth(
		options.apiKey,
		async key => {
			const resp = await options.fetchImpl(options.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
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
					const parsedErr = JSON.parse(rawText) as { detail?: string; error?: { message?: string } };
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
	const data = JSON.parse(rawText) as { data?: Array<{ b64_json?: string | null; url?: string | null }> };
	const inlineImages: InlineImageData[] = [];
	for (const entry of data.data ?? []) {
		if (entry.b64_json) {
			const bytes = Buffer.from(entry.b64_json, "base64");
			const mimeType = parseImageMetadata(bytes)?.mimeType ?? "image/png";
			inlineImages.push({ data: entry.b64_json, mimeType });
		} else if (entry.url) {
			inlineImages.push(await loadImageFromUrl(entry.url, fetchImpl, signal));
		}
	}
	return inlineImages;
}

/** Standard tool result for an image-endpoint provider (no accompanying response text). */
async function buildImageEndpointResult(
	provider: ImageProvider,
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

/** Configured provider priority set via `providers.imageOrder` (default: none). */
let configuredImageProviderOrder: readonly ImageProvider[] = [];

export function isImageProviderPreference(value: unknown): value is ImageProviderPreference {
	return typeof value === "string" && IMAGE_PROVIDER_PREFERENCES.has(value);
}

/** Set the configured image-provider priority from settings; invalid IDs are dropped. */
export function setImageProviderOrder(providers: readonly string[]): void {
	configuredImageProviderOrder = providers.filter(isImageProviderId);
}
function assertImageAspectRatioSupported(provider: ImageProvider, aspectRatio: ImageGenParams["aspect_ratio"]): void {
	if (!aspectRatio || provider === "xai" || COMMON_IMAGE_ASPECT_RATIO_SET.has(aspectRatio)) {
		return;
	}
	throw new Error(
		`Aspect ratio ${aspectRatio} is only supported by xAI image generation. Set providers.image to xai or use one of ${COMMON_IMAGE_ASPECT_RATIOS.join(", ")}.`,
	);
}

interface ParsedAntigravityCredentials {
	accessToken: string;
	projectId: string;
}

function parseAntigravityCredentials(raw: string): ParsedAntigravityCredentials | null {
	try {
		const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
		if (parsed.token && parsed.projectId) {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// Invalid JSON
	}
	return null;
}

async function findAntigravityCredentials(
	modelRegistry: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	const apiKey = await modelRegistry.getApiKeyForProvider("google-antigravity", sessionId, {
		modelId: DEFAULT_ANTIGRAVITY_MODEL,
	});
	if (!apiKey) return null;

	const parsed = parseAntigravityCredentials(apiKey);
	if (!parsed) return null;

	return {
		provider: "antigravity",
		apiKey: parsed.accessToken,
		projectId: parsed.projectId,
	};
}

async function findXAIImageCredentials(modelRegistry?: ModelRegistry): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		const creds = await resolveXAIHttpCredentials(modelRegistry);
		if (creds) return { provider: "xai", apiKey: creds.apiKey };
		return null;
	}
	const apiKey = $env.XAI_API_KEY;
	if (apiKey) return { provider: "xai", apiKey };
	return null;
}

async function findOpenRouterImageCredentials(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		// AuthStorage.getApiKey already falls back to env keys, so this covers OPENROUTER_API_KEY too.
		const apiKey = await modelRegistry.getApiKeyForProvider("openrouter", sessionId);
		if (apiKey) return { provider: "openrouter", apiKey: modelRegistry.resolver("openrouter", { sessionId }) };
		return null;
	}
	const apiKey = getEnvApiKey("openrouter");
	if (apiKey) return { provider: "openrouter", apiKey };
	return null;
}

async function findDeepInfraImageCredentials(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		// AuthStorage.getApiKey already falls back to env keys, so this covers DEEPINFRA_API_KEY too.
		const apiKey = await modelRegistry.getApiKeyForProvider("deepinfra", sessionId);
		if (apiKey) return { provider: "deepinfra", apiKey: modelRegistry.resolver("deepinfra", { sessionId }) };
		return null;
	}
	const apiKey = getEnvApiKey("deepinfra");
	if (apiKey) return { provider: "deepinfra", apiKey };
	return null;
}

async function findGeminiImageCredentials(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		// AuthStorage.getApiKey already falls back to env keys (GEMINI_API_KEY), so only
		// GOOGLE_API_KEY needs the explicit check below.
		const apiKey = await modelRegistry.getApiKeyForProvider("google", sessionId);
		if (apiKey) return { provider: "gemini", apiKey: modelRegistry.resolver("google", { sessionId }) };
	} else {
		const envKey = getEnvApiKey("google");
		if (envKey) return { provider: "gemini", apiKey: envKey };
	}
	const googleKey = $env.GOOGLE_API_KEY;
	if (googleKey) return { provider: "gemini", apiKey: googleKey };
	return null;
}

async function findOpenAIHostedImageCredentials(
	modelRegistry: ModelRegistry | undefined,
	activeModel: Model | undefined,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (!modelRegistry || !isOpenAIHostedImageModel(activeModel)) return null;
	const apiKey = await modelRegistry.getApiKey(activeModel, sessionId);
	if (!isAuthenticated(apiKey)) return null;
	return {
		provider: getOpenAIHostedImageProvider(activeModel),
		apiKey,
		model: activeModel,
	};
}

// Codex (ChatGPT subscription) chat models that carry OpenAI's hosted
// `image_generation` tool. Priority: newest general model first, then Codex
// variants; any available openai-codex hosted-image model is the last resort.
const CODEX_IMAGE_MODEL_PRIORITY = ["gpt-5.5", "gpt-5.4", "gpt-5.1", "gpt-5", "gpt-5-codex"] as const;

function resolveDefaultCodexImageModel(modelRegistry: ModelRegistry): Model | undefined {
	for (const id of CODEX_IMAGE_MODEL_PRIORITY) {
		const model = modelRegistry.find("openai-codex", id);
		if (model && isOpenAIHostedImageModel(model)) return model;
	}
	return modelRegistry.getAll().find(model => model.provider === "openai-codex" && isOpenAIHostedImageModel(model));
}

/**
 * Codex image credentials — engages OpenAI's hosted `image_generation` tool
 * through a connected ChatGPT account or custom Codex-compatible endpoint,
 * independent of the active chat model. The active-model-is-codex case is
 * already served by {@link findOpenAIHostedImageCredentials}, so it is skipped
 * here to avoid a duplicate resolution.
 */
async function findCodexSubscriptionImageCredentials(
	modelRegistry: ModelRegistry | undefined,
	activeModel: Model | undefined,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (!modelRegistry) return null;
	if (isOpenAIHostedImageModel(activeModel) && getOpenAIHostedImageProvider(activeModel) === "openai-codex") {
		return null;
	}
	const token = await modelRegistry.getApiKeyForProvider("openai-codex", sessionId);
	if (!token) return null;
	const model = resolveDefaultCodexImageModel(modelRegistry);
	if (!model) return null;
	const acceptsOpaqueCredentials = !isOfficialCodexApiUrl(getOpenAIResponsesUrl(model));
	if (!acceptsOpaqueCredentials && !getCodexAccountId(token)) return null;
	const apiKey = await modelRegistry.getApiKey(model, sessionId);
	if (!isAuthenticated(apiKey) || (!acceptsOpaqueCredentials && !getCodexAccountId(apiKey))) return null;
	return { provider: "openai-codex", apiKey, model };
}

function activeImageProvider(model: Model | undefined): Exclude<ImageProviderPreference, "auto"> | null {
	switch (model?.provider) {
		case "openai":
		case "openai-codex":
			return "openai";
		case "google-antigravity":
			return "antigravity";
		case "xai":
		case "xai-oauth":
			return "xai";
		case "openrouter":
			return "openrouter";
		case "deepinfra":
			return "deepinfra";
		case "google":
			return "gemini";
		default:
			return null;
	}
}

function imageProviderOrder(activeModel: Model | undefined, requested?: ImageProviderPreference): ImageProvider[] {
	const providers: ImageProvider[] = [];
	const added = new Set<ImageProvider>();
	const add = (provider: ImageProvider | null): void => {
		if (!provider || added.has(provider)) return;
		added.add(provider);
		providers.push(provider);
	};

	// Per-request provider wins, then the configured priority list, then the
	// active session's provider, then the built-in auto order.
	if (requested !== undefined && requested !== "auto") add(requested);
	for (const provider of configuredImageProviderOrder) add(provider);
	add(activeImageProvider(activeModel));
	for (const provider of AUTO_IMAGE_PROVIDER_ORDER) add(provider);
	return providers;
}

async function findImageApiKey(
	provider: Exclude<ImageProviderPreference, "auto">,
	modelRegistry?: ModelRegistry,
	activeModel?: Model,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	switch (provider) {
		case "openai":
			return findOpenAIHostedImageCredentials(modelRegistry, activeModel, sessionId);
		case "openai-codex":
			return findCodexSubscriptionImageCredentials(modelRegistry, activeModel, sessionId);
		case "antigravity":
			return modelRegistry ? findAntigravityCredentials(modelRegistry, sessionId) : null;
		case "xai":
			return findXAIImageCredentials(modelRegistry);
		case "openrouter":
			return findOpenRouterImageCredentials(modelRegistry, sessionId);
		case "deepinfra":
			return findDeepInfraImageCredentials(modelRegistry, sessionId);
		case "gemini":
			return findGeminiImageCredentials(modelRegistry, sessionId);
	}
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
	provider: ImageProvider,
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

function getOpenAIHostedImageProvider(model: Model): ImageProvider {
	return model.api === "openai-codex-responses" || model.provider === "openai-codex" ? "openai-codex" : "openai";
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
	model: Model,
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
	};

	return {
		model: model.id,
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		...(stream
			? {
					instructions:
						"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.",
				}
			: {}),
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
		const parsed = JSON.parse(rawText) as { error?: { message?: string } };
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

function buildOpenAIImageHeaders(model: Model, apiKey: string, sessionId: string | undefined): Headers {
	const headers = new Headers(model.headers ?? {});
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
	model: Model,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<OpenAIHostedImageResult> {
	const promptText = assemblePrompt(params);
	const stream = model.api === "openai-codex-responses" || model.provider === "openai-codex";
	const requestBody = buildOpenAIHostedImageRequest(model, promptText, params, inputImages, stream);
	const response = await fetchImpl(getOpenAIResponsesUrl(model), {
		method: "POST",
		headers: buildOpenAIImageHeaders(model, apiKey, sessionId),
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

	const data = (await response.json()) as OpenAIHostedImageResponse;
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

// Build the discriminated edit body. Caller must ensure images.length is in
// [1, XAI_MAX_EDIT_IMAGES]; the bound check fires earlier in execute().
function buildXAIEditPayload(base: XAIImageRequestBase, images: readonly InlineImageData[]): XAIImageRequestBody {
	const refs: readonly XAIImageReference[] = images.map(img => ({
		type: "image_url",
		url: toDataUrl(img),
	}));
	const [first, ...rest] = refs;
	if (first === undefined) return base; // unreachable: caller checked images.length > 0
	return rest.length === 0 ? { ...base, image: first } : { ...base, images: refs };
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

export const imageGenTool: CustomTool<typeof imageGenSchema, ImageGenToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	strict: false,
	approval: "write",
	description: prompt.render(imageGenDescription),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			const providerOrder = imageProviderOrder(ctx.model, params.provider);
			const cwd = ctx.sessionManager.getCwd();
			const requestSignal = ptree.combineSignals(signal, IMAGE_TIMEOUT);
			const fetchImpl = ctx.fetch ?? fetch;
			const failures: Array<{ provider: ImageProvider; error: ProviderHttpError }> = [];
			let unsupportedAspectRatioProvider: ImageProvider | undefined;
			let editUnsupportedProvider: ImageProvider | undefined;
			let foundCredentials = false;
			let resolvedImageCache: InlineImageData[] | undefined;

			for (const preferredProvider of providerOrder) {
				const apiKey = await findImageApiKey(preferredProvider, ctx.modelRegistry, ctx.model, sessionId);
				if (!apiKey) continue;
				foundCredentials = true;
				if (!resolvedImageCache) {
					resolvedImageCache = [];
					if (params.input?.length) {
						for (const input of params.input) {
							resolvedImageCache.push(await resolveInputImage(input, cwd));
						}
					}
				}
				const resolvedImages = resolvedImageCache;

				const provider = apiKey.provider;
				try {
					const model =
						provider === "openai" || provider === "openai-codex"
							? (apiKey.model?.id ?? "gpt")
							: provider === "antigravity"
								? DEFAULT_ANTIGRAVITY_MODEL
								: provider === "openrouter"
									? DEFAULT_OPENROUTER_MODEL
									: provider === "xai"
										? DEFAULT_XAI_IMAGE_MODEL
										: provider === "deepinfra"
											? DEFAULT_DEEPINFRA_IMAGE_MODEL
											: DEFAULT_MODEL;
					const resolvedModel = provider === "openrouter" ? resolveOpenRouterModel(model) : model;
					if (
						params.aspect_ratio &&
						provider !== "xai" &&
						!COMMON_IMAGE_ASPECT_RATIO_SET.has(params.aspect_ratio)
					) {
						unsupportedAspectRatioProvider ??= provider;
						continue;
					}
					if (provider === "openai" || provider === "openai-codex") {
						if (!apiKey.model) {
							throw new Error("Missing active GPT model for OpenAI image generation");
						}

						const hostedModel = apiKey.model;
						const hostedKey: ApiKey = ctx.modelRegistry.resolver(hostedModel, sessionId);

						const parsed = await withAuth(
							hostedKey,
							key =>
								generateOpenAIHostedImage(
									key,
									hostedModel,
									params,
									resolvedImages,
									fetchImpl,
									requestSignal,
									sessionId,
								),
							{ signal: requestSignal },
						);

						if (parsed.images.length === 0) {
							const messageText = parsed.responseText ? `\n\n${parsed.responseText}` : "";
							return {
								content: [{ type: "text", text: `No image data returned.${messageText}` }],
								details: {
									provider,
									model,
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
								{ type: "text", text: buildResponseSummary(provider, model, imagePaths, parsed.responseText) },
							],
							details: {
								provider,
								model,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								responseText: parsed.responseText,
								revisedPrompt: parsed.revisedPrompt,
								usage: parsed.usage,
							},
						};
					}

					if (provider === "antigravity") {
						if (!apiKey.projectId) {
							throw new Error("Missing projectId in antigravity credentials");
						}

						const prompt = assemblePrompt(params);
						const antigravityKey: ApiKey = ctx.modelRegistry.resolver("google-antigravity", {
							sessionId,
							modelId: DEFAULT_ANTIGRAVITY_MODEL,
						});

						const response = await withAuth(
							antigravityKey,
							async key => {
								// On a retry the resolver yields the raw stored credential JSON
								// ({ token, projectId }); the initial seed is the already-parsed
								// access token. Tolerate both, falling back to the seed projectId.
								const rotated = parseAntigravityCredentials(key);
								const bearer = rotated?.accessToken ?? key;
								const projectId = rotated?.projectId ?? apiKey.projectId!;
								const requestBody = buildAntigravityRequest(
									prompt,
									model,
									projectId,
									params.aspect_ratio,
									params.image_size,
									resolvedImages,
								);

								let endpoints = [DEFAULT_ANTIGRAVITY_ENDPOINT_PROD, DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX];
								try {
									const mode = settings.get("providers.antigravityEndpoint");
									if (mode === "production") {
										endpoints = [DEFAULT_ANTIGRAVITY_ENDPOINT_PROD];
									} else if (mode === "sandbox") {
										endpoints = [DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX];
									}
								} catch {
									// Ignored
								}

								let resp: Response | undefined;
								let lastError: Error | undefined;

								for (let i = 0; i < endpoints.length; i++) {
									const endpoint = endpoints[i];
									const isLastEndpoint = i === endpoints.length - 1;
									try {
										resp = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
											method: "POST",
											headers: {
												Authorization: `Bearer ${bearer}`,
												"Content-Type": "application/json",
												Accept: "text/event-stream",
												"User-Agent": getAntigravityUserAgent(),
											},
											body: JSON.stringify(requestBody),
											signal: requestSignal,
										});

										if (resp.ok) {
											break;
										}

										const errorText = await resp.text();
										let message = errorText;
										try {
											const parsedErr = JSON.parse(errorText) as { error?: { message?: string } };
											message = parsedErr.error?.message ?? message;
										} catch {
											// Keep raw text.
										}

										lastError = new ProviderHttpError(
											`Antigravity image request failed (${resp.status}): ${message}`,
											resp.status,
											{ headers: resp.headers },
										);

										if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
											if (!isLastEndpoint) {
												continue;
											}
										}
										break;
									} catch (error) {
										lastError = error as Error;
										if (isLastEndpoint) {
											break;
										}
									}
								}

								if (!resp?.ok) {
									throw lastError ?? new Error("Antigravity image generation failed");
								}

								return resp;
							},
							{ signal: requestSignal },
						);

						const parsed = await parseAntigravitySseForImage(response, requestSignal);
						const responseText = parsed.text.length > 0 ? parsed.text.join(" ") : undefined;

						if (parsed.images.length === 0) {
							const messageText = responseText ? `\n\n${responseText}` : "";
							return {
								content: [{ type: "text", text: `No image data returned.${messageText}` }],
								details: {
									provider,
									model,
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
							content: [{ type: "text", text: buildResponseSummary(provider, model, imagePaths, responseText) }],
							details: {
								provider,
								model,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								responseText,
								usage: parsed.usage,
							},
						};
					}

					if (provider === "xai") {
						if (!ctx.modelRegistry) {
							throw new Error("Missing modelRegistry for xAI image generation");
						}
						const xaiCreds = await resolveXAIHttpCredentials(ctx.modelRegistry, resolvedModel);
						if (!xaiCreds) {
							throw new Error(
								"No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.",
							);
						}

						const prompt = assemblePrompt(params);
						const aspectRatio = params.aspect_ratio ?? "1:1";
						const xaiResolution = resolveXAIResolution(params.image_size);

						const isEdit = resolvedImages.length > 0;
						if (isEdit && resolvedImages.length > XAI_MAX_EDIT_IMAGES) {
							throw new Error(
								`xAI image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${resolvedImages.length}.`,
							);
						}

						const xaiBaseBody: XAIImageRequestBase = {
							model: resolvedModel,
							prompt,
							aspect_ratio: aspectRatio,
							resolution: xaiResolution,
							n: 1,
							response_format: "b64_json",
						};
						const xaiBody: XAIImageRequestBody = isEdit
							? buildXAIEditPayload(xaiBaseBody, resolvedImages)
							: xaiBaseBody;
						const xaiEndpoint = isEdit ? "/images/edits" : "/images/generations";

						const xaiKey: ApiKey = ctx.modelRegistry.resolver(xaiCreds.provider, {
							sessionId,
							baseUrl: xaiCreds.baseURL,
						});

						const xaiRawText = await postImageEndpointRequest({
							label: "xAI",
							url: `${xaiCreds.baseURL}${xaiEndpoint}`,
							body: xaiBody,
							apiKey: xaiKey,
							fetchImpl,
							signal: requestSignal,
						});
						const xaiInlineImages = await collectImageEndpointImages(xaiRawText, fetchImpl, requestSignal);
						return buildImageEndpointResult(provider, resolvedModel, xaiInlineImages);
					}

					if (provider === "openrouter") {
						const prompt = assemblePrompt(params);
						const contentParts: OpenRouterContentPart[] = [{ type: "text", text: prompt }];
						for (const image of resolvedImages) {
							contentParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
						}

						const requestBody = {
							model: resolvedModel,
							messages: [{ role: "user" as const, content: contentParts }],
						};

						const rawText = await withAuth(
							apiKey.apiKey,
							async key => {
								const resp = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
									method: "POST",
									headers: {
										"Content-Type": "application/json",
										Authorization: `Bearer ${key}`,
										...getOpenRouterHeaders(),
									},
									body: JSON.stringify(requestBody),
									signal: requestSignal,
								});
								const text = await resp.text();
								if (!resp.ok) {
									let message = text;
									try {
										const parsed = JSON.parse(text) as { error?: { message?: string } };
										message = parsed.error?.message ?? message;
									} catch {
										// Keep raw text.
									}
									throw new ProviderHttpError(
										`OpenRouter image request failed (${resp.status}): ${message}`,
										resp.status,
										{ headers: resp.headers },
									);
								}
								return text;
							},
							{ signal: requestSignal },
						);

						const data = JSON.parse(rawText) as OpenRouterResponse;
						const message = data.choices?.[0]?.message;
						const responseText = collectOpenRouterResponseText(message);
						const imageUrls = extractOpenRouterImageUrls(message);
						const inlineImages: InlineImageData[] = [];
						for (const imageUrl of imageUrls) {
							inlineImages.push(await loadImageFromUrl(imageUrl, fetchImpl, requestSignal));
						}

						if (inlineImages.length === 0) {
							const messageText = responseText ? `\n\n${responseText}` : "";
							return {
								content: [{ type: "text", text: `No image data returned.${messageText}` }],
								details: {
									provider,
									model: resolvedModel,
									imageCount: 0,
									imagePaths: [],
									images: [],
									responseText,
								},
							};
						}

						const imagePaths = await saveImagesToTemp(inlineImages);

						return {
							content: [
								{ type: "text", text: buildResponseSummary(provider, resolvedModel, imagePaths, responseText) },
							],
							details: {
								provider,
								model: resolvedModel,
								imageCount: inlineImages.length,
								imagePaths,
								images: inlineImages,
								responseText,
							},
						};
					}

					if (provider === "deepinfra") {
						// Text-to-image only: images/generations has no reference-image
						// input, so an edit request falls through to an edit-capable
						// provider (openai/openrouter/gemini) later in the order.
						if (resolvedImages.length > 0) {
							editUnsupportedProvider ??= provider;
							continue;
						}

						const prompt = assemblePrompt(params);
						const size = resolveOpenAIImageSize(params.aspect_ratio, params.image_size);
						const requestBody = {
							model: resolvedModel,
							prompt,
							n: 1,
							response_format: "b64_json" as const,
							...(size ? { size } : {}),
						};

						const rawText = await postImageEndpointRequest({
							label: "DeepInfra",
							url: DEEPINFRA_IMAGES_URL,
							body: requestBody,
							apiKey: apiKey.apiKey,
							fetchImpl,
							signal: requestSignal,
						});
						const inlineImages = await collectImageEndpointImages(rawText, fetchImpl, requestSignal);
						return buildImageEndpointResult(provider, resolvedModel, inlineImages);
					}

					const parts = [] as Array<{ text?: string; inlineData?: InlineImageData }>;
					for (const image of resolvedImages) {
						parts.push({ inlineData: image });
					}
					parts.push({ text: assemblePrompt(params) });

					const generationConfig: {
						responseModalities: GeminiResponseModality[];
						imageConfig?: { aspectRatio?: string; imageSize?: string };
					} = {
						responseModalities: ["IMAGE"],
					};

					if (params.aspect_ratio || params.image_size) {
						generationConfig.imageConfig = {
							aspectRatio: params.aspect_ratio,
							imageSize: params.image_size,
						};
					}

					const requestBody = {
						contents: [{ role: "user" as const, parts }],
						generationConfig,
					};

					const rawText = await withAuth(
						apiKey.apiKey,
						async key => {
							const resp = await fetchImpl(
								`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
								{
									method: "POST",
									headers: {
										"Content-Type": "application/json",
										"x-goog-api-key": key,
									},
									body: JSON.stringify(requestBody),
									signal: requestSignal,
								},
							);
							const text = await resp.text();
							if (!resp.ok) {
								let message = text;
								try {
									const parsed = JSON.parse(text) as { error?: { message?: string } };
									message = parsed.error?.message ?? message;
								} catch {
									// Keep raw text.
								}
								throw new ProviderHttpError(
									`Gemini image request failed (${resp.status}): ${message}`,
									resp.status,
									{
										headers: resp.headers,
									},
								);
							}
							return text;
						},
						{ signal: requestSignal },
					);

					const data = JSON.parse(rawText) as GeminiGenerateContentResponse;
					const responseParts = combineParts(data);
					const responseText = collectResponseText(responseParts);
					const inlineImages = collectInlineImages(responseParts);

					if (inlineImages.length === 0) {
						const blocked = data.promptFeedback?.blockReason
							? `Blocked: ${data.promptFeedback.blockReason}`
							: "No image data returned.";
						return {
							content: [{ type: "text", text: `${blocked}${responseText ? `\n\n${responseText}` : ""}` }],
							details: {
								provider,
								model,
								imageCount: 0,
								imagePaths: [],
								images: [],
								responseText,
								promptFeedback: data.promptFeedback,
								usage: data.usageMetadata,
							},
						};
					}

					const imagePaths = await saveImagesToTemp(inlineImages);

					return {
						content: [{ type: "text", text: buildResponseSummary(provider, model, imagePaths, responseText) }],
						details: {
							provider,
							model,
							imageCount: inlineImages.length,
							imagePaths,
							images: inlineImages,
							responseText,
							promptFeedback: data.promptFeedback,
							usage: data.usageMetadata,
						},
					};
				} catch (error) {
					if (!(error instanceof ProviderHttpError) || requestSignal?.aborted) {
						throw error;
					}
					failures.push({ provider, error });
				}
			}

			if (!foundCredentials) {
				throw new Error(
					"No image API credentials found. Connect a Codex (ChatGPT) subscription, use a GPT Responses/Codex model with OpenAI credentials, log in with google-antigravity or xAI Grok OAuth, or set OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, or DEEPINFRA_API_KEY.",
				);
			}

			if (failures.length === 0 && unsupportedAspectRatioProvider) {
				assertImageAspectRatioSupported(unsupportedAspectRatioProvider, params.aspect_ratio);
			}

			if (failures.length === 0 && editUnsupportedProvider) {
				throw new Error(
					`${editUnsupportedProvider} image generation is text-to-image only and cannot edit input images. Configure an edit-capable provider (openai, openai-codex, antigravity, xai, openrouter, gemini) or retry without input images.`,
				);
			}

			throw new AggregateError(
				failures.map(failure => failure.error),
				`Image generation failed for all credentialed providers: ${failures.map(failure => failure.provider).join(", ")}`,
			);
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
