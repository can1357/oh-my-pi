import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type { ImageGenerationRequest, ImageGenerationResult } from "../images/types";

const imageJsonRequestSchema = type({
	model: "string > 0",
	prompt: "string > 0",
	"n?": "unknown",
	"size?": "unknown",
	"image_size?": "unknown",
	"aspect_ratio?": "unknown",
	"response_format?": "unknown",
	"stream?": "unknown",
	"input_references?": "unknown",
	"images?": "unknown",
	"image?": "unknown",
});

export type ImageRequestKind = "generations" | "edits";

export interface ImagesParsedRequest {
	modelId: string;
	request: ImageGenerationRequest;
}

export interface ImagesResponseBody {
	created: number;
	data: Array<{ b64_json: string; revised_prompt?: string }>;
	usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number };
}

function validation(message: string): never {
	throw new AIError.ValidationError(`images: ${message}`);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length === 0) validation(`${field} must be a non-empty string`);
	return value;
}

function optionalCount(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) validation("n must be a positive integer");
	return value;
}

function decodeInputReference(value: unknown): { data: string; mimeType: string } {
	let raw: unknown = value;
	if (value !== null && typeof value === "object") {
		raw = "url" in value ? value.url : undefined;
		const imageUrl = "image_url" in value ? value.image_url : undefined;
		if (raw === undefined && imageUrl !== null && typeof imageUrl === "object" && "url" in imageUrl) {
			raw = imageUrl.url;
		}
	}
	if (typeof raw !== "string" || raw.length === 0) validation("input image must be base64 or a data URL");
	const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
	if (match) return { data: match[2] ?? "", mimeType: match[1] ?? "image/png" };
	if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { data: raw, mimeType: "image/png" };
	validation("input image URLs are not supported; send a data URL or base64 bytes");
}

function parseJson(body: unknown, kind: ImageRequestKind): ImagesParsedRequest {
	const parsed = imageJsonRequestSchema(body);
	if (parsed instanceof type.errors) validation(parsed.summary);
	if (parsed.stream === true) validation("streaming image responses are not supported");
	if (parsed.response_format !== undefined && parsed.response_format !== "b64_json") {
		validation('response_format must be "b64_json"; URL responses are not supported');
	}
	const input = parsed.input_references ?? parsed.images ?? parsed.image;
	const values = input === undefined ? [] : Array.isArray(input) ? input : [input];
	if (kind === "edits" && values.length === 0) validation("image edit requires at least one input image");
	const aspectRatio = optionalString(parsed.aspect_ratio, "aspect_ratio");
	const imageSize = optionalString(
		parsed.image_size ?? parsed.size,
		parsed.image_size === undefined ? "size" : "image_size",
	);
	const count = optionalCount(parsed.n);
	return {
		modelId: parsed.model,
		request: {
			prompt: parsed.prompt,
			...(values.length > 0 ? { inputImages: values.map(decodeInputReference) } : {}),
			...(aspectRatio ? { aspectRatio } : {}),
			...(imageSize ? { imageSize } : {}),
			...(count ? { count } : {}),
		},
	};
}

async function parseMultipart(form: FormData): Promise<ImagesParsedRequest> {
	const model = form.get("model");
	const prompt = form.get("prompt");
	if (typeof model !== "string" || model.length === 0) validation("model must be a non-empty string");
	if (typeof prompt !== "string" || prompt.length === 0) validation("prompt must be a non-empty string");
	const responseFormat = form.get("response_format");
	if (responseFormat !== null && responseFormat !== "b64_json") {
		validation('response_format must be "b64_json"; URL responses are not supported');
	}
	const stream = form.get("stream");
	if (stream === "true") validation("streaming image responses are not supported");
	const entries = [...form.getAll("image"), ...form.getAll("image[]")];
	if (entries.length === 0) validation("image edit requires at least one image file");
	const inputImages: Array<{ data: string; mimeType: string }> = [];
	for (const entry of entries) {
		if (typeof entry === "string") validation("image must be a file part");
		const bytes = new Uint8Array(await entry.arrayBuffer());
		inputImages.push({ data: bytes.toBase64(), mimeType: entry.type || "image/png" });
	}
	const nValue = form.get("n");
	let count: number | undefined;
	if (nValue !== null) {
		if (typeof nValue !== "string" || !/^\d+$/.test(nValue)) validation("n must be a positive integer");
		count = optionalCount(Number(nValue));
	}
	const size = form.get("size");
	if (size !== null && typeof size !== "string") validation("size must be a string");
	return {
		modelId: model,
		request: {
			prompt,
			inputImages,
			...(size ? { imageSize: size } : {}),
			...(count ? { count } : {}),
		},
	};
}

export async function parseRequest(body: unknown | FormData, kind: ImageRequestKind): Promise<ImagesParsedRequest> {
	if (body instanceof FormData) {
		if (kind !== "edits") validation("multipart requests are supported only for image edits");
		return parseMultipart(body);
	}
	return parseJson(body, kind);
}

export function encodeResponse(result: ImageGenerationResult, _requestedModelId: string): ImagesResponseBody {
	return {
		created: Math.floor(Date.now() / 1000),
		data: result.images.map(image => ({ b64_json: image.data })),
		usage: {
			prompt_tokens: result.usage.input,
			completion_tokens: result.usage.output,
			total_tokens: result.usage.totalTokens,
			cost: result.usage.cost.total,
		},
	};
}

export function formatError(status: number, errorType: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, type: errorType, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
