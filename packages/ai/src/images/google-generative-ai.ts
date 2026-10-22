import type { Model } from "@oh-my-pi/pi-catalog/types";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { errorMessage, ImageApiError, imageBaseUrl, modelHeaders, usageFromWire, validateImageInput } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

interface GeminiPart {
	text?: string;
	inlineData?: { data?: string; mimeType?: string };
}

/** One `generateContent` response, or one chunk of its SSE stream. */
export interface GeminiImageResponse {
	candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/** The user turn of a Gemini image request: reference images first, then the prompt. */
export function geminiImageContents(request: ImageGenerationRequest): Array<{ role: "user"; parts: GeminiPart[] }> {
	const inputImages = request.inputImages ?? [];
	for (const image of inputImages) validateImageInput(image);
	const parts: GeminiPart[] = inputImages.map(image => ({ inlineData: image }));
	parts.push({ text: request.prompt });
	return [{ role: "user", parts }];
}

/**
 * Collect images, text and usage from a response or its stream chunks: parts
 * within a response are separate paragraphs, chunks continue the same text,
 * and the last usage report stands.
 */
export function geminiImageResult(responses: Iterable<GeminiImageResponse>): ImageGenerationResult {
	const images: GeneratedImage[] = [];
	let text = "";
	let wireUsage: GeminiImageResponse["usageMetadata"];
	for (const response of responses) {
		const textParts: string[] = [];
		for (const part of response.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []) {
			if (part.text) textParts.push(part.text);
			if (part.inlineData?.data && part.inlineData.mimeType) {
				images.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
			}
		}
		text += textParts.join("\n");
		wireUsage = response.usageMetadata ?? wireUsage;
	}
	text = text.trim();
	const usage = usageFromWire(
		wireUsage
			? { input_tokens: wireUsage.promptTokenCount, output_tokens: wireUsage.candidatesTokenCount }
			: undefined,
	);
	return { images, ...(text ? { text } : {}), usage };
}

export async function generateGoogleImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const imageConfig =
		request.aspectRatio || request.imageSize
			? { aspectRatio: request.aspectRatio, imageSize: request.imageSize }
			: undefined;
	const fetchImpl = options.fetch ?? fetch;
	const body = {
		contents: geminiImageContents(request),
		generationConfig: {
			responseModalities: ["IMAGE"],
			...(imageConfig ? { imageConfig } : {}),
			...(request.count ? { candidateCount: request.count } : {}),
		},
	};
	const response = await withAuth(
		options.apiKey,
		async key => {
			const result = await fetchImpl(
				`${imageBaseUrl(model)}/models/${encodeURIComponent(model.requestModelId ?? model.id)}:generateContent`,
				{
					method: "POST",
					headers: {
						...(await modelHeaders(model, options.signal)),
						"Content-Type": "application/json",
						"x-goog-api-key": key,
					},
					body: JSON.stringify(body),
					signal: options.signal,
				},
			);
			const text = await result.text();
			if (!result.ok) {
				throw new ImageApiError(
					`${model.provider}/${model.id} image request failed (${result.status}): ${errorMessage(text)}`,
					result.status,
					{ headers: result.headers },
				);
			}
			try {
				return JSON.parse(text) as GeminiImageResponse;
			} catch (cause) {
				throw new AIError.ProviderResponseError("Gemini image API returned malformed JSON", {
					provider: model.provider,
					kind: "envelope",
					cause,
				});
			}
		},
		{ signal: options.signal },
	);
	return geminiImageResult([response]);
}
