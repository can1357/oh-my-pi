import type { FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { base64ImageDataFailureReason, isRecord, parseImageMetadata, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ApiKey } from "../auth-retry";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { ImageContent } from "../types";
import type { GeneratedImage, ImageInput } from "./types";

export class ImageApiError extends AIError.ProviderHttpError {
	override readonly name = "ImageApiError";
}

export function emptyUsage(input = 0, output = 0, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export function usageFromWire(value: unknown): Usage {
	if (value === null || typeof value !== "object") return emptyUsage();
	const usage = value as Record<string, unknown>;
	const number = (key: string): number => (typeof usage[key] === "number" ? usage[key] : 0);
	return emptyUsage(
		number("input_tokens") || number("prompt_tokens"),
		number("output_tokens") || number("completion_tokens"),
		number("cost"),
	);
}

export function imageBaseUrl(model: Model): string {
	if (!model.baseUrl) throw new AIError.ValidationError(`Image model ${model.provider}/${model.id} has no base URL`);
	return model.baseUrl.replace(/\/+$/, "");
}

export async function modelHeaders(model: Model, signal?: AbortSignal): Promise<Record<string, string>> {
	return { ...model.headers, ...(await model.resolveHeaders?.(signal)) };
}

export function errorMessage(rawText: string): string {
	try {
		const parsed = JSON.parse(rawText) as { detail?: string; error?: { message?: string } };
		return parsed.detail ?? parsed.error?.message ?? rawText;
	} catch {
		return rawText;
	}
}

async function parseImageApiResponse(model: Model, response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		throw new ImageApiError(
			`${model.provider}/${model.id} image request failed (${response.status}): ${errorMessage(text)}`,
			response.status,
			{ headers: response.headers },
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new AIError.ProviderResponseError("Image API returned malformed JSON", {
			provider: model.provider,
			kind: "envelope",
			cause,
		});
	}
}

/** Request URL, or a builder for routes that depend on the bearer (xAI's `XAI_BASE_URL` rule). */
type ImageRequestUrl = string | ((bearer: string) => string);

export async function postJson(options: {
	model: Model;
	url: ImageRequestUrl;
	body: unknown;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const url = typeof options.url === "string" ? options.url : options.url(key);
			const response = await options.fetch(url, {
				method: "POST",
				headers: {
					...(await modelHeaders(options.model, options.signal)),
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(options.body),
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response);
		},
		{ signal: options.signal },
	);
}

export async function postMultipart(options: {
	model: Model;
	url: ImageRequestUrl;
	body: FormData;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const url = typeof options.url === "string" ? options.url : options.url(key);
			const response = await options.fetch(url, {
				method: "POST",
				headers: {
					...(await modelHeaders(options.model, options.signal)),
					Authorization: `Bearer ${key}`,
					"User-Agent": USER_AGENT,
				},
				body: options.body,
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response);
		},
		{ signal: options.signal },
	);
}

async function imageFromUrl(url: string, fetch: FetchImpl, signal?: AbortSignal): Promise<GeneratedImage> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		const text = await response.text();
		throw new ImageApiError(`Image download failed (${response.status}): ${text}`, response.status, {
			headers: response.headers,
		});
	}
	const mimeType = response.headers.get("content-type")?.split(";")[0];
	if (!mimeType?.startsWith("image/")) {
		throw new AIError.ProviderResponseError(`Image URL returned unsupported content type: ${mimeType ?? "missing"}`, {
			kind: "envelope",
		});
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return { data: bytes.toBase64(), mimeType };
}

export async function decodeImageResponse(
	value: unknown,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; usage: Usage }> {
	if (value === null || typeof value !== "object") {
		throw new AIError.ProviderResponseError("Image API returned a malformed response", { kind: "envelope" });
	}
	const root = value as { data?: unknown; usage?: unknown };
	if (!Array.isArray(root.data)) {
		throw new AIError.ProviderResponseError("Image API response is missing data", { kind: "envelope" });
	}
	const images: GeneratedImage[] = [];
	for (const item of root.data) {
		if (item === null || typeof item !== "object") continue;
		const image = item as { b64_json?: unknown; url?: unknown; media_type?: unknown };
		if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
			const mimeType =
				typeof image.media_type === "string"
					? image.media_type
					: (sniffBase64ImageMimeType(image.b64_json) ?? "image/png");
			images.push({ data: image.b64_json, mimeType });
		} else if (typeof image.url === "string" && image.url.length > 0) {
			images.push(await imageFromUrl(image.url, fetch, signal));
		}
	}
	return { images, usage: usageFromWire(root.usage) };
}

/**
 * Mime type of a base64 image, read from its header only. 64 base64 chars
 * decode to 48 bytes, past every magic number `parseImageMetadata` checks, so
 * multi-MB payloads are never fully decoded just to be labelled.
 */
export function sniffBase64ImageMimeType(base64: string): string | undefined {
	return parseImageMetadata(Buffer.from(base64.slice(0, 64), "base64"))?.mimeType;
}

/**
 * Validate provider-bound image input without changing it. Accepts non-empty standard base64
 * with canonical trailing bits and optional padding, and case-insensitive image MIME syntax
 * (RFC 6838 restricted names). Does not sniff the MIME type, decode image pixels, or enforce
 * provider-specific format support; data-URL transports additionally go through `toDataUrl`.
 *
 * @throws {AIError.ValidationError} If the base64 data or image MIME type is invalid.
 */
export function validateImageInput(image: ImageInput): void {
	if (!isRecord(image) || typeof image.data !== "string") {
		throw new AIError.ValidationError("invalid base64 image data");
	}
	const reason = base64ImageDataFailureReason(image.data);
	if (reason) throw new AIError.ValidationError(reason);
	if (!isImageMimeType(image.mimeType)) throw new AIError.ValidationError("invalid image MIME type");
}

/**
 * Encode validated image input as a base64 data URL.
 *
 * @throws {AIError.ValidationError} If the input is invalid or its MIME type cannot survive a data URL.
 */
export function toDataUrl(image: ImageInput): string {
	validateImageInput(image);
	if (!isDataUrlMimeType(image.mimeType)) {
		throw new AIError.ValidationError("image MIME type containing '#' cannot be sent as a data URL");
	}
	return `data:${image.mimeType};base64,${image.data}`;
}

// RFC 6838 restricted-name.
const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/i;
const IMAGE_DETAILS: Record<string, true> = {
	auto: true,
	low: true,
	high: true,
	original: true,
};

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && IMAGE_MIME_TYPE.test(value);
}

/**
 * Whether a MIME type survives a data URL intact: a raw `#` starts a URL fragment and
 * data-URL consumers leave a `%23` escape undecoded, so no data-URL transport preserves it.
 */
export function isDataUrlMimeType(mimeType: string): boolean {
	return !mimeType.includes("#");
}

function isEmbeddedImageShape(image: unknown): image is ImageContent {
	return (
		isRecord(image) &&
		image.type === "image" &&
		typeof image.data === "string" &&
		isImageMimeType(image.mimeType) &&
		isDataUrlMimeType(image.mimeType) &&
		(image.detail === undefined || (typeof image.detail === "string" && Object.hasOwn(IMAGE_DETAILS, image.detail)))
	);
}

/** Whether a value is an embedded image with valid base64 data, MIME type, and detail. */
export function isEmbeddedImageContent(image: unknown): image is ImageContent {
	return isEmbeddedImageShape(image) && base64ImageDataFailureReason(image.data) === undefined;
}

/** Convert one validated embedded image to a lowercase-MIME inline data URL. */
export function embeddedImageDataUrl(image: unknown): string {
	if (!isEmbeddedImageShape(image)) {
		throw new AIError.ValidationError("Judgment images must contain non-empty base64 data and an image MIME type");
	}
	return toDataUrl({ data: image.data, mimeType: image.mimeType.toLowerCase() });
}

export function resolveOpenAIImageSize(aspectRatio?: string, imageSize?: string): string | undefined {
	if (imageSize) return imageSize;
	switch (aspectRatio) {
		case "1:1":
			return "1024x1024";
		case "2:3":
		case "3:4":
		case "9:16":
			return "1024x1536";
		case "3:2":
		case "4:3":
		case "16:9":
			return "1536x1024";
		default:
			return undefined;
	}
}
