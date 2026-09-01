/**
 * OpenRouter image generation adapter.
 *
 * Targets OpenRouter's dedicated Images API (`POST /api/v1/images`); the legacy
 * `chat/completions` image path is gone. Only the knobs the binding declares
 * are sent; edits ride `input_references` as inline `data:` URLs built from the
 * resolved input images.
 *
 * This API buffers its response, so there is no accepted-job hazard — a non-2xx
 * always maps to {@link ProviderHttpError} and the fallback ladder may continue.
 */

import { type FetchImpl, getOpenRouterHeaders } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import type { ImageBinding, ImageOutputFormat } from "./image-models";
import type { ImageRequestParams } from "./image-targets";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

interface InlineImageData {
	data: string;
	mimeType: string;
}

interface OpenRouterImageOutput {
	b64_json?: string;
	media_type?: string;
}

interface OpenRouterImagesResponse {
	data?: OpenRouterImageOutput[];
	usage?: { cost?: number };
	error?: { message?: string };
}
function outputFormatMimeType(format: ImageOutputFormat | undefined): string | undefined {
	switch (format) {
		case "png":
			return "image/png";
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "svg":
			return "image/svg+xml";
		default:
			return undefined;
	}
}

function inferOpenRouterMimeType(
	data: string,
	requestedFormat: ImageOutputFormat | undefined,
	binding: ImageBinding,
): string {
	const bytes = Buffer.from(data, "base64");
	const detected = parseImageMetadata(bytes)?.mimeType;
	if (detected) return detected;

	const textPrefix = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
	if (textPrefix.startsWith("<svg") || (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))) {
		return "image/svg+xml";
	}

	return (
		outputFormatMimeType(requestedFormat) ??
		outputFormatMimeType(binding.outputFormats?.length === 1 ? binding.outputFormats[0] : undefined) ??
		"image/png"
	);
}

export interface OpenRouterGenerateOptions {
	apiKey: string;
	model: string;
	binding: ImageBinding;
	params: ImageRequestParams;
	inputImages: InlineImageData[];
	fetchImpl: FetchImpl;
	signal?: AbortSignal;
}

export interface OpenRouterGenerateResult {
	images: InlineImageData[];
	costUsd?: number;
}

/** Builds the OpenRouter Images API body from the canonical params and the binding. */
export function buildOpenRouterRequestBody(
	model: string,
	binding: ImageBinding,
	params: ImageRequestParams,
	inputImages: readonly InlineImageData[],
): Record<string, unknown> {
	const body: Record<string, unknown> = { model, prompt: params.prompt };

	if (params.aspectRatio && binding.aspectRatios?.includes(params.aspectRatio)) {
		body.aspect_ratio = params.aspectRatio;
	}
	if (params.resolution && binding.resolutions?.includes(params.resolution)) {
		body.resolution = params.resolution;
	}
	if (params.n !== undefined && params.n > 1 && binding.maxImages > 1) {
		body.n = params.n;
	}
	if (
		params.quality &&
		(binding.qualityValues ? binding.qualityValues.includes(params.quality) : binding.supportsQuality)
	) {
		body.quality = params.quality;
	}
	if (params.outputFormat && binding.outputFormats?.includes(params.outputFormat)) {
		body.output_format = params.outputFormat;
	}
	if (
		params.background &&
		(binding.backgroundValues ? binding.backgroundValues.includes(params.background) : binding.supportsBackground)
	) {
		body.background = params.background;
	}
	if (params.seed !== undefined && binding.supportsSeed) {
		body.seed = params.seed;
	}

	if (inputImages.length > 0) {
		body.input_references = inputImages.map(image => ({
			type: "image_url",
			image_url: { url: `data:${image.mimeType};base64,${image.data}` },
		}));
	}

	return body;
}

export async function generateOpenRouterImage(options: OpenRouterGenerateOptions): Promise<OpenRouterGenerateResult> {
	const { apiKey, model, binding, params, inputImages, fetchImpl, signal } = options;

	const response = await fetchImpl(OPENROUTER_IMAGES_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...getOpenRouterHeaders(),
		},
		body: JSON.stringify(buildOpenRouterRequestBody(model, binding, params, inputImages)),
		signal,
	});

	const rawText = await response.text();
	if (!response.ok) {
		let message = rawText;
		try {
			const parsed = JSON.parse(rawText) as { error?: { message?: string } };
			message = parsed.error?.message ?? message;
		} catch {
			// Keep raw text.
		}
		throw new ProviderHttpError(`OpenRouter image request failed (${response.status}): ${message}`, response.status, {
			headers: response.headers,
		});
	}

	const data = JSON.parse(rawText) as OpenRouterImagesResponse;
	const images: InlineImageData[] = [];
	for (const entry of data.data ?? []) {
		if (!entry.b64_json) continue;
		images.push({
			data: entry.b64_json,
			mimeType: entry.media_type ?? inferOpenRouterMimeType(entry.b64_json, params.outputFormat, binding),
		});
	}

	return {
		images,
		...(data.usage?.cost != null ? { costUsd: data.usage.cost } : {}),
	};
}
