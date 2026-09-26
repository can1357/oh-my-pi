import type { FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { parseImageMetadata, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ApiKey } from "../auth-retry";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { GeneratedImage } from "./types";

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

export async function postJson(options: {
	model: Model;
	url: string;
	body: unknown;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const response = await options.fetch(options.url, {
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
	url: string;
	body: FormData;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const response = await options.fetch(options.url, {
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

export async function imageFromUrl(url: string, fetch: FetchImpl, signal?: AbortSignal): Promise<GeneratedImage> {
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
			const bytes = Buffer.from(image.b64_json, "base64");
			const mimeType =
				typeof image.media_type === "string"
					? image.media_type
					: (parseImageMetadata(bytes)?.mimeType ?? "image/png");
			images.push({ data: image.b64_json, mimeType });
		} else if (typeof image.url === "string" && image.url.length > 0) {
			images.push(await imageFromUrl(image.url, fetch, signal));
		}
	}
	return { images, usage: usageFromWire(root.usage) };
}

export function toDataUrl(image: GeneratedImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

export function resolveOpenAIImageSize(aspectRatio?: string, imageSize?: string): string | undefined {
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
