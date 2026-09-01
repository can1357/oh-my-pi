import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ApiKey, type FetchImpl, getEnvApiKey, type Model, resolveApiKeyOnce, withAuth } from "@oh-my-pi/pi-ai";
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
	formatBytes,
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
import imageGenRequestPrompt from "../prompts/tools/image-gen-request.md" with { type: "text" };
import imageGenSystemInstruction from "../prompts/tools/image-gen-system.md" with { type: "text" };
import { generateFalImage } from "./image-fal";
import { imageGenToolRenderer } from "./image-gen-renderer";
import { IMAGE_MODEL_CATALOG, type ImageResolution } from "./image-models";
import { generateOpenRouterImage } from "./image-openrouter";
import { AUTO_IMAGE_PROVIDER_ORDER, type ImageProvider, isImageProviderId } from "./image-providers";
import { assertBindingSupports, type ImageRequestParams, type ImageTarget, resolveImageTargets } from "./image-targets";
import { resolveReadPath } from "./path-utils";

const DEEPINFRA_IMAGES_URL = "https://api.deepinfra.com/v1/openai/images/generations";
const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
const MAX_IMAGE_SIZE = 35 * 1024 * 1024;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_IMAGE_OUTPUT_FORMAT = "webp";
const OPENAI_IMAGE_MIME_TYPE = "image/webp";

const DEFAULT_ANTIGRAVITY_ENDPOINT_PROD = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export type { ImageProvider } from "./image-providers";
export type ImageProviderPreference = ImageProvider | "auto";

interface ImageApiKey {
	provider: ImageProvider;
	apiKey: ApiKey;
	projectId?: string;
	model?: Model;
}

const IMAGE_PROVIDER_REQUEST_CHOICES = ["auto", ...AUTO_IMAGE_PROVIDER_ORDER] as const;
const IMAGE_PROVIDER_PREFERENCES = new Set<string>(IMAGE_PROVIDER_REQUEST_CHOICES);

const responseModalitySchema = type('"IMAGE" | "TEXT"');

const aspectRatioSchema = type
	.enumerated(
		"auto",
		"1:1",
		"16:9",
		"9:16",
		"4:3",
		"3:4",
		"3:2",
		"2:3",
		"4:5",
		"5:4",
		"21:9",
		"9:21",
		"2:1",
		"1:2",
		"20:9",
		"19.5:9",
		"9:20",
		"9:19.5",
	)
	.describe("aspect ratio");

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
	"model?": type("string").describe(
		"image model: catalog alias, or fal:<endpoint-id> / openrouter:<model-id> (default: providers.imageModel or auto)",
	),
	"aspect_ratio?": aspectRatioSchema,
	"resolution?": type.enumerated("512", "1K", "2K", "4K").describe("output resolution tier"),
	"n?": type("1 <= number <= 10").describe(
		"number of images in this single result; set 2+ to render one TUI ImageGrid when the provider binding supports it",
	),
	"quality?": type.enumerated("auto", "low", "medium", "high").describe("quality tier"),
	"output_format?": type.enumerated("png", "jpeg", "webp", "svg").describe("output format"),
	"background?": type.enumerated("auto", "transparent", "opaque").describe("background handling"),
	"seed?": type("number.integer >= 0").describe("deterministic seed"),
	"input?": inputImageSchema.array().describe("input images"),
	"provider?": imageProviderSchema,
});
export type ImageGenParams = typeof imageGenSchema.infer;
export type GeminiResponseModality = typeof responseModalitySchema.infer;

/**
 * Removes punctuation that would otherwise duplicate the separators in the request template.
 */
function normalizePromptPart(value: string): string {
	return value.replace(/[.!,;:]+$/, "");
}

/**
 * Renders the structured image request prompt from the provided parameters.
 */
function assemblePrompt(params: ImageGenParams): string {
	return prompt
		.render(imageGenRequestPrompt, {
			subject: normalizePromptPart(params.subject),
			action: params.action ? normalizePromptPart(params.action) : undefined,
			scene: params.scene ? normalizePromptPart(params.scene) : undefined,
			composition: params.composition ? normalizePromptPart(params.composition) : undefined,
			lighting: params.lighting ? normalizePromptPart(params.lighting) : undefined,
			style: params.style ? normalizePromptPart(params.style) : undefined,
			text: params.text,
			changes: params.changes?.length ? params.changes : undefined,
		})
		.trim();
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
	model: string;
	action: OpenAIImageAction;
	output_format: typeof OPENAI_IMAGE_OUTPUT_FORMAT;
	size?: string;
	quality?: ImageGenParams["quality"];
	background?: ImageGenParams["background"];
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
	/** Catalog alias that produced this result (raw `fal:`/`openrouter:` refs use the raw id). */
	entryId?: string;
	/** Cost in USD, surfaced only when the provider reports it (OpenRouter). */
	costUsd?: number;
	/** Per-image display metadata (dimensions + disk size) for the TUI renderer. */
	imageStats?: Array<{
		path: string;
		width?: number;
		height?: number;
		sizeBytes: number;
		mimeType: string;
	}>;
}

interface SavedImage {
	path: string;
	image: InlineImageData;
	bytes: Uint8Array;
}

/** Computes per-image display metadata from the bytes already written to disk. */
function computeImageStats(savedImages: readonly SavedImage[]): NonNullable<ImageGenToolDetails["imageStats"]> {
	return savedImages.map(({ path: imagePath, image, bytes }) => {
		const meta = parseImageMetadata(bytes);
		return {
			path: imagePath,
			width: meta?.width,
			height: meta?.height,
			sizeBytes: bytes.byteLength,
			mimeType: image.mimeType,
		};
	});
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
function assertBase64ImageSize(data: string, label: string): void {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const decodedBytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
	if (decodedBytes > MAX_IMAGE_SIZE) {
		throw new Error(`${label} exceeds the ${formatBytes(MAX_IMAGE_SIZE)} limit.`);
	}
}

async function readResponseBytesWithinLimit(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	const cancelOnAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancelOnAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			}
			const { done, value } = await reader.read();
			if (done) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
				}
				break;
			}
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// Preserve the size error even if the source cannot be cancelled.
				}
				throw new Error(`Image download exceeds the ${formatBytes(maxBytes)} limit.`);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (signal?.aborted) {
			try {
				await reader.cancel();
			} catch {
				// Preserve the abort reason even if the source cannot be cancelled.
			}
			throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelOnAbort);
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
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
		assertBase64ImageSize(normalized.data, "Image data");
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
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_SIZE) {
		throw new Error(`Image download exceeds the ${formatBytes(MAX_IMAGE_SIZE)} limit.`);
	}
	const buffer = await readResponseBytesWithinLimit(response, MAX_IMAGE_SIZE, signal);
	return { data: buffer.toBase64(), mimeType: contentType };
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
	entryId?: string,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	if (inlineImages.length === 0) {
		return {
			content: [{ type: "text", text: "No image data returned." }],
			details: {
				provider,
				model,
				entryId,
				imageCount: 0,
				imagePaths: [],
				images: [],
			},
		};
	}
	const { imagePaths, imageStats } = await saveImagesToTemp(inlineImages);
	return {
		content: [{ type: "text", text: buildResponseSummary(provider, model, imageStats, undefined) }],
		details: {
			provider,
			model,
			entryId,
			imageCount: inlineImages.length,
			imagePaths,
			images: inlineImages,
			imageStats,
		},
	};
}
let configuredImageProviderOrder: readonly ImageProvider[] = [];

export function isImageProviderPreference(value: unknown): value is ImageProviderPreference {
	return typeof value === "string" && IMAGE_PROVIDER_PREFERENCES.has(value);
}

/** Set the configured image-provider priority from settings; invalid IDs are dropped. */
export function setImageProviderOrder(providers: readonly string[]): void {
	configuredImageProviderOrder = providers.filter(isImageProviderId);
}

/** Default image model from `providers.imageModel` (empty = auto). */
let defaultImageModel: string | undefined;

export function setDefaultImageModel(model: string | undefined): void {
	defaultImageModel = model;
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
	model: string,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	const apiKey = await modelRegistry.getApiKeyForProvider("google-antigravity", sessionId, {
		modelId: model,
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

async function findFalImageCredentials(modelRegistry?: ModelRegistry, sessionId?: string): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		// FAL queue jobs can be accepted and billed before a later status/result
		// request fails. Admit one concrete key for the complete job lifecycle;
		// never hand the adapter a rotating resolver.
		const apiKey = await modelRegistry.getApiKeyForProvider("fal", sessionId);
		if (apiKey) return { provider: "fal", apiKey };
		return null;
	}
	const apiKey = getEnvApiKey("fal");
	if (apiKey) return { provider: "fal", apiKey };
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
	if (!modelRegistry) return null;
	const model =
		activeModel && isOpenAIHostedImageModel(activeModel) && getOpenAIHostedImageProvider(activeModel) === "openai"
			? activeModel
			: typeof modelRegistry.getAll === "function"
				? modelRegistry
						.getAll()
						.find(
							candidate =>
								candidate.provider === "openai" &&
								isOpenAIHostedImageModel(candidate) &&
								getOpenAIHostedImageProvider(candidate) === "openai",
						)
				: undefined;
	if (!model) return null;
	const apiKey = await modelRegistry.getApiKey(model, sessionId);
	if (!isAuthenticated(apiKey)) return null;
	return {
		provider: "openai",
		apiKey,
		model,
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
 * Codex subscription (ChatGPT OAuth) image credentials — engages OpenAI's hosted
 * `image_generation` tool through a CONNECTED Codex account, independent of the
 * active chat model. This is what lets image generation run on a ChatGPT
 * subscription (no metered OPENAI_API_KEY) even when the active model is, e.g.,
 * Claude.
 */
async function findCodexSubscriptionImageCredentials(
	modelRegistry: ModelRegistry | undefined,
	_activeModel: Model | undefined,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (!modelRegistry) return null;

	// A Codex subscription credential is an OAuth JWT with an account claim.
	// API keys stored under this provider can use the ChatGPT backend only when
	// they resolve to a concrete hosted-image model and expose that claim.
	const token = await modelRegistry.getApiKeyForProvider("openai-codex", sessionId);
	if (!token || !getCodexAccountId(token)) return null;
	const model = resolveDefaultCodexImageModel(modelRegistry);
	if (!model) return null;
	const apiKey = await modelRegistry.getApiKey(model, sessionId);
	if (!isAuthenticated(apiKey) || !getCodexAccountId(apiKey)) return null;
	return { provider: "openai-codex", apiKey, model };
}

function activeImageProvider(model: Model | undefined): Exclude<ImageProviderPreference, "auto"> | null {
	switch (model?.provider) {
		case "openai":
			return "openai";
		case "openai-codex":
			return "openai-codex";
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
	target: ImageTarget,
	modelRegistry?: ModelRegistry,
	activeModel?: Model,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	const provider = target.binding.provider;
	switch (provider) {
		case "openai":
			return findOpenAIHostedImageCredentials(modelRegistry, activeModel, sessionId);
		case "openai-codex":
			return findCodexSubscriptionImageCredentials(modelRegistry, activeModel, sessionId);
		case "antigravity":
			return modelRegistry ? findAntigravityCredentials(modelRegistry, target.endpoint, sessionId) : null;
		case "xai":
			return findXAIImageCredentials(modelRegistry);
		case "openrouter":
			return findOpenRouterImageCredentials(modelRegistry, sessionId);
		case "deepinfra":
			return findDeepInfraImageCredentials(modelRegistry, sessionId);
		case "gemini":
			return findGeminiImageCredentials(modelRegistry, sessionId);
		case "fal":
			return findFalImageCredentials(modelRegistry, sessionId);
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
		assertBase64ImageSize(normalized.data, "Input image data");
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
		"image/svg+xml": "svg",
	};
	return map[mimeType] ?? "png";
}

async function saveImageToTemp(image: InlineImageData): Promise<SavedImage> {
	const ext = getExtensionForMime(image.mimeType);
	const filename = `omp-image-${Snowflake.next()}.${ext}`;
	const filepath = path.join(os.tmpdir(), filename);
	const bytes = Buffer.from(image.data, "base64");
	await Bun.write(filepath, bytes);
	return { path: filepath, image, bytes };
}

async function saveImagesToTemp(images: InlineImageData[]): Promise<{
	imagePaths: string[];
	imageStats: NonNullable<ImageGenToolDetails["imageStats"]>;
}> {
	const savedImages = await Promise.all(images.map(saveImageToTemp));
	return {
		imagePaths: savedImages.map(saved => saved.path),
		imageStats: computeImageStats(savedImages),
	};
}

function formatUsd(value: number): string {
	// Sub-dollar amounts keep up to six significant decimals; larger amounts two.
	return value >= 1 ? value.toFixed(2) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function buildResponseSummary(
	provider: ImageProvider,
	model: string,
	imageStats: NonNullable<ImageGenToolDetails["imageStats"]>,
	responseText: string | undefined,
	costUsd?: number,
): string {
	const lines = [`Provider: ${provider}`, `Model: ${model}`, `Generated ${imageStats.length} image(s):`];
	for (const stat of imageStats) {
		const dims = stat.width && stat.height ? ` (${stat.width}x${stat.height}, ${formatBytes(stat.sizeBytes)})` : "";
		lines.push(`  ${stat.path}${dims}`);
	}
	if (costUsd != null) {
		lines.push(`Cost: $${formatUsd(costUsd)}`);
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

function resolveOpenAIImageSize(aspectRatio: string | undefined): string | undefined {
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
	imageModel: string,
	promptText: string,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	stream: boolean,
): OpenAIHostedImageRequest {
	const content: OpenAIInputContent[] = [{ type: "input_text", text: promptText }];
	for (const image of inputImages) {
		content.push({ type: "input_image", detail: "auto", image_url: toDataUrl(image) });
	}

	const size = resolveOpenAIImageSize(params.aspect_ratio);
	const tool: OpenAIImageGenerationTool = {
		type: "image_generation",
		model: imageModel,
		action: inputImages.length > 0 ? "edit" : "generate",
		output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
		...(size ? { size } : {}),
		...(params.quality ? { quality: params.quality } : {}),
		...(params.background ? { background: params.background } : {}),
	};

	return {
		model: model.id,
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		...(stream
			? {
					instructions: imageGenSystemInstruction.trim(),
					stream: true,
				}
			: {}),
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
	imageModel: string,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<OpenAIHostedImageResult> {
	const promptText = assemblePrompt(params);
	const stream = model.api === "openai-codex-responses" || model.provider === "openai-codex";
	const requestBody = buildOpenAIHostedImageRequest(model, imageModel, promptText, params, inputImages, stream);
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
	resolution: ImageResolution | undefined,
	inputImages: InlineImageData[],
): AntigravityRequest {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of inputImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: prompt });

	const imageConfig = aspectRatio || resolution ? { aspectRatio: aspectRatio, imageSize: resolution } : undefined;

	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: imageGenSystemInstruction.trim() }] },
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

// Map the canonical resolution tier to xAI's discrete wire tier: "512"/"1K" →
// "1k"; "2K"/"4K" → "2k". Absent defaults to "1k".
function resolveXAIResolution(resolution: ImageResolution | undefined): "1k" | "2k" {
	if (!resolution || resolution === "512" || resolution === "1K") return "1k";
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
	mergeCallAndResult: imageGenToolRenderer.mergeCallAndResult,
	renderCall: imageGenToolRenderer.renderCall,
	renderResult: imageGenToolRenderer.renderResult,
	strict: false,
	approval: "write",
	description: prompt.render(imageGenDescription, {
		models: IMAGE_MODEL_CATALOG.map(entry => ({ id: entry.id, summary: entry.summary })),
	}),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			const cwd = ctx.sessionManager.getCwd();
			const requestSignal = ptree.combineSignals(signal, IMAGE_TIMEOUT);
			const fetchImpl = ctx.fetch ?? fetch;
			const failures: Array<{ provider: ImageProvider; error: ProviderHttpError }> = [];

			let foundCredentials = false;
			let editUnsupportedProvider: ImageProvider | undefined;
			let resolvedImageCache: InlineImageData[] | undefined;

			const requestParams: ImageRequestParams = {
				prompt: assemblePrompt(params),
				aspectRatio: params.aspect_ratio,
				resolution: params.resolution,
				n: params.n,
				quality: params.quality,
				outputFormat: params.output_format,
				background: params.background,
				seed: params.seed,
			};

			const targets = await resolveImageTargets(
				{
					requestedModel: params.model,
					requestedProvider: params.provider,
					defaultModel: defaultImageModel,
					providerOrder: imageProviderOrder(ctx.model, params.provider),
					hasInputImages: Boolean(params.input?.length),
				},
				fetchImpl,
				requestSignal,
			);

			for (const target of targets) {
				const apiKey = await findImageApiKey(target, ctx.modelRegistry, ctx.model, sessionId);
				if (!apiKey) continue;
				foundCredentials = true;
				const provider = target.binding.provider;
				if (target.action === "unsupported-edit") {
					editUnsupportedProvider ??= provider;
					continue;
				}
				// Fail closed before any file read or HTTP call: an unsupported knob
				// escapes the loop (never a ProviderHttpError).
				assertBindingSupports(target.binding, requestParams, params.input?.length ?? 0, target.entryId);
				if (!resolvedImageCache) {
					resolvedImageCache = [];
					if (params.input?.length) {
						for (const input of params.input) {
							resolvedImageCache.push(await resolveInputImage(input, cwd));
						}
					}
				}
				const resolvedImages = resolvedImageCache;

				try {
					const model =
						provider === "openai" || provider === "openai-codex"
							? (apiKey.model?.id ?? target.endpoint)
							: target.endpoint;
					const resolvedModel = model;
					// Surface which backend actually serves this request for every provider,
					// not just FAL — the args tree shows the requested model, but not the
					// concrete binding chosen by the credential/order fallback.
					onUpdate?.({
						content: [{ type: "text", text: `Generating image via ${provider} (${resolvedModel})…` }],
					});
					if (provider === "openai" || provider === "openai-codex") {
						// The hosted Responses image tool is shared by the openai and
						// openai-codex bindings; the actual backend is the credential's provider.
						const hostedProvider = apiKey.provider as ImageProvider;
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
									target.entryId,
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
									provider: hostedProvider,
									model,
									entryId: target.entryId,
									imageCount: 0,
									imagePaths: [],
									images: [],
									responseText: parsed.responseText,
									revisedPrompt: parsed.revisedPrompt,
									usage: parsed.usage,
								},
							};
						}

						const { imagePaths, imageStats } = await saveImagesToTemp(parsed.images);

						return {
							content: [
								{
									type: "text",
									text: buildResponseSummary(hostedProvider, model, imageStats, parsed.responseText),
								},
							],
							details: {
								provider: hostedProvider,
								model,
								entryId: target.entryId,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								imageStats,
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
							modelId: model,
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
									params.resolution,
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
									entryId: target.entryId,
									imageCount: 0,
									imagePaths: [],
									images: [],
									responseText,
									usage: parsed.usage,
								},
							};
						}

						const { imagePaths, imageStats } = await saveImagesToTemp(parsed.images);

						return {
							content: [
								{
									type: "text",
									text: buildResponseSummary(provider, model, imageStats, responseText),
								},
							],
							details: {
								provider,
								model,
								entryId: target.entryId,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								imageStats,
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
						const xaiResolution = resolveXAIResolution(params.resolution);

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

						const xaiRawText = await withAuth(
							xaiKey,
							async key => {
								const resp = await fetchImpl(`${xaiCreds.baseURL}${xaiEndpoint}`, {
									method: "POST",
									headers: {
										Authorization: `Bearer ${key}`,
										"Content-Type": "application/json",
										"User-Agent": USER_AGENT,
									},
									body: JSON.stringify(xaiBody),
									signal: requestSignal,
								});
								const rawText = await resp.text();
								if (!resp.ok) {
									let message = rawText;
									try {
										const parsedErr = JSON.parse(rawText) as { error?: { message?: string } };
										message = parsedErr.error?.message ?? message;
									} catch {
										// Keep raw text.
									}
									throw new ProviderHttpError(
										`xAI image request failed (${resp.status}): ${message}`,
										resp.status,
										{
											headers: resp.headers,
										},
									);
								}
								return rawText;
							},
							{ signal: requestSignal },
						);

						const xaiData = JSON.parse(xaiRawText) as {
							data?: Array<{ b64_json?: string; url?: string }>;
						};
						const xaiInlineImages: InlineImageData[] = [];
						for (const entry of xaiData.data ?? []) {
							if (entry.b64_json) {
								const bytes = Buffer.from(entry.b64_json, "base64");
								const mimeType = parseImageMetadata(bytes)?.mimeType ?? "image/png";
								xaiInlineImages.push({ data: entry.b64_json, mimeType });
							} else if (entry.url) {
								xaiInlineImages.push(await loadImageFromUrl(entry.url, fetchImpl, requestSignal));
							}
						}

						if (xaiInlineImages.length === 0) {
							return {
								content: [{ type: "text", text: "No image data returned." }],
								details: {
									provider,
									model: resolvedModel,
									entryId: target.entryId,
									imageCount: 0,
									imagePaths: [],
									images: [],
								},
							};
						}

						const { imagePaths: xaiImagePaths, imageStats: xaiImageStats } =
							await saveImagesToTemp(xaiInlineImages);

						return {
							content: [
								{
									type: "text",
									text: buildResponseSummary(provider, resolvedModel, xaiImageStats, undefined),
								},
							],
							details: {
								provider,
								model: resolvedModel,
								entryId: target.entryId,
								imageCount: xaiInlineImages.length,
								imagePaths: xaiImagePaths,
								images: xaiInlineImages,
								imageStats: xaiImageStats,
							},
						};
					}

					if (provider === "openrouter") {
						const parsed = await withAuth(
							apiKey.apiKey,
							key =>
								generateOpenRouterImage({
									apiKey: key,
									model: resolvedModel,
									binding: target.binding,
									params: requestParams,
									inputImages: resolvedImages,
									fetchImpl,
									signal: requestSignal,
								}),
							{ signal: requestSignal },
						);

						if (parsed.images.length === 0) {
							return {
								content: [{ type: "text", text: "No image data returned." }],
								details: {
									provider,
									model: resolvedModel,
									entryId: target.entryId,
									imageCount: 0,
									imagePaths: [],
									images: [],
									costUsd: parsed.costUsd,
								},
							};
						}
						const { imagePaths, imageStats } = await saveImagesToTemp(parsed.images);

						return {
							content: [
								{
									type: "text",
									text: buildResponseSummary(provider, resolvedModel, imageStats, undefined, parsed.costUsd),
								},
							],
							details: {
								provider,
								model: resolvedModel,
								entryId: target.entryId,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								imageStats,
								costUsd: parsed.costUsd,
							},
						};
					}
					if (provider === "fal") {
						const falApiKey = await resolveApiKeyOnce(apiKey.apiKey, requestSignal);
						if (!falApiKey) {
							throw new Error("Missing FAL API key");
						}
						const parsed = await generateFalImage({
							apiKey: falApiKey,
							endpoint: target.endpoint,
							binding: target.binding,
							params: requestParams,
							inputImages: resolvedImages,
							fetchImpl,
							signal: requestSignal,
							onUpdate: progress =>
								onUpdate?.({
									content: [
										{
											type: "text",
											text: `Generating image via ${provider} (${resolvedModel})… ${progress}`,
										},
									],
								}),
							download: url => loadImageFromUrl(url, fetchImpl, requestSignal),
						});
						const { imagePaths, imageStats } = await saveImagesToTemp(parsed.images);
						return {
							content: [
								{
									type: "text",
									text: buildResponseSummary(provider, resolvedModel, imageStats, undefined),
								},
							],
							details: {
								provider,
								model: resolvedModel,
								entryId: target.entryId,
								imageCount: parsed.images.length,
								imagePaths,
								images: parsed.images,
								imageStats,
							},
						};
					}

					if (provider === "deepinfra") {
						// Text-to-image only: images/generations has no reference-image
						// input, so an edit request falls through to an edit-capable
						// provider (openai/openrouter/gemini) later in the order.
						if (resolvedImages.length > 0) {
							continue;
						}

						const prompt = assemblePrompt(params);
						const size = resolveOpenAIImageSize(params.aspect_ratio);
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
						return buildImageEndpointResult(provider, resolvedModel, inlineImages, target.entryId);
					}

					if (provider !== "gemini") {
						throw new Error(`Unhandled image provider: ${provider}`);
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

					if (params.aspect_ratio || params.resolution) {
						generationConfig.imageConfig = {
							aspectRatio: params.aspect_ratio,
							imageSize: params.resolution,
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
								entryId: target.entryId,
								imageCount: 0,
								imagePaths: [],
								images: [],
								responseText,
								promptFeedback: data.promptFeedback,
								usage: data.usageMetadata,
							},
						};
					}

					const { imagePaths, imageStats } = await saveImagesToTemp(inlineImages);

					return {
						content: [
							{
								type: "text",
								text: buildResponseSummary(provider, model, imageStats, responseText),
							},
						],
						details: {
							provider,
							model,
							entryId: target.entryId,
							imageCount: inlineImages.length,
							imagePaths,
							images: inlineImages,
							imageStats,
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
					"No image API credentials found. Connect a Codex (ChatGPT) subscription, use a GPT Responses/Codex model with OpenAI credentials, log in with google-antigravity or xAI Grok OAuth, or set OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, FAL_KEY, or DEEPINFRA_API_KEY.",
				);
			}

			if (failures.length === 0 && editUnsupportedProvider) {
				throw new Error(
					`${editUnsupportedProvider} image generation is text-to-image only and cannot edit input images. Configure an edit-capable provider (openai, openai-codex, antigravity, xai, openrouter, gemini) or retry without input images.`,
				);
			}

			if (failures.length === 0) {
				throw new Error("Image generation failed: no credentialed provider completed the request.");
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
