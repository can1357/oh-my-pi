import { getSupportedEfforts, mapEffortToGoogleThinkingLevel } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { mapGoogleUsage } from "../providers/google-shared";
import type { UsageMetadata } from "../providers/google-types";
import { emptyUsage, errorMessage, ImageApiError, imageBaseUrl, modelHeaders, validateImageInput } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

interface GeminiPart {
	text?: string;
	inlineData?: { data?: string; mimeType?: string };
}

/** One `generateContent` response, or one chunk of its SSE stream. */
export interface GeminiImageResponse {
	candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
	usageMetadata?: UsageMetadata;
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
	const usage = wireUsage ? mapGoogleUsage(wireUsage) : emptyUsage();
	// `totalTokenCount` is optional on the wire, and mapGoogleUsage reports 0 without it.
	if (wireUsage && !wireUsage.totalTokenCount) {
		usage.totalTokens =
			(wireUsage.promptTokenCount ?? 0) +
			(wireUsage.candidatesTokenCount ?? 0) +
			(wireUsage.thoughtsTokenCount ?? 0);
	}
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
	// Gemini 3.x image models take chat's `thinkingLevel`; an effort off the model's ladder is omitted.
	const thinkingLevel =
		request.reasoning !== undefined &&
		model.thinking?.mode === "google-level" &&
		getSupportedEfforts(model).includes(request.reasoning)
			? mapEffortToGoogleThinkingLevel(request.reasoning, model)
			: undefined;
	const fetchImpl = options.fetch ?? fetch;
	const body = {
		contents: geminiImageContents(request),
		generationConfig: {
			responseModalities: ["IMAGE"],
			...(imageConfig ? { imageConfig } : {}),
			...(request.count ? { candidateCount: request.count } : {}),
			...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
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
