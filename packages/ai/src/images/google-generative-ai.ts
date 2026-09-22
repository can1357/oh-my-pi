import type { Model } from "@oh-my-pi/pi-catalog/types";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { errorMessage, ImageApiError, imageBaseUrl, modelHeaders, usageFromWire } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

interface GeminiPart {
	text?: string;
	inlineData?: { data?: string; mimeType?: string };
}

interface GeminiResponse {
	candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

export async function generateGoogleImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const parts: Array<{ text?: string; inlineData?: GeneratedImage }> = (request.inputImages ?? []).map(image => ({
		inlineData: image,
	}));
	parts.push({ text: request.prompt });
	const imageConfig =
		request.aspectRatio || request.imageSize
			? { aspectRatio: request.aspectRatio, imageSize: request.imageSize }
			: undefined;
	const body = {
		contents: [{ role: "user", parts }],
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
				return JSON.parse(text) as GeminiResponse;
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
	const responseParts = response.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? [];
	const images: GeneratedImage[] = [];
	const textParts: string[] = [];
	for (const part of responseParts) {
		if (part.text) textParts.push(part.text);
		if (part.inlineData?.data && part.inlineData.mimeType) {
			images.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
		}
	}
	const text = textParts.join("\n").trim();
	const wireUsage = response.usageMetadata;
	const usage = usageFromWire(
		wireUsage
			? { input_tokens: wireUsage.promptTokenCount, output_tokens: wireUsage.candidatesTokenCount }
			: undefined,
	);
	return { images, ...(text ? { text } : {}), usage };
}
