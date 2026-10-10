import { type Api, IMAGE_GENERATION_APIS, type ImageGenerationApi, type Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { generateAntigravityImage } from "./google-antigravity";
import { generateGoogleImage } from "./google-generative-ai";
import { generateOpenAIImage } from "./openai-images";
import { generateHostedImage } from "./openai-hosted";
import { generateOpenRouterImage } from "./openrouter-images";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

export * from "./google-antigravity";
export * from "./google-generative-ai";
export * from "./openai-hosted";
export * from "./openai-images";
export * from "./openrouter-images";
export * from "./types";

export type { ImageGenerationApi } from "@oh-my-pi/pi-catalog/types";

/** Whether a catalog API generates images through one of the pi-ai image clients. */
export function isImageGenerationApi(api: Api): api is ImageGenerationApi {
	return (IMAGE_GENERATION_APIS as readonly Api[]).includes(api);
}

/** Whether this model accepts an explicit image background preference. */
export function supportsImageBackground(model: Model<Api>): boolean {
	switch (model.api) {
		case "openai-responses":
		case "openai-codex-responses":
			return true;
		case "openai-images":
			return model.provider !== "xai" && model.provider !== "xai-oauth";
		default:
			return false;
	}
}

/** Generate (or edit, when `request.inputImages` is set) images through the transport selected by the model's `api`. */
export async function generateImage(
	model: Model<Api>,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	if (request.background && request.background !== "auto" && !supportsImageBackground(model)) {
		throw new AIError.ValidationError(
			`Image model ${model.provider}/${model.id} does not support ${request.background} backgrounds`,
		);
	}
	switch (model.api) {
		case "openai-images":
			return generateOpenAIImage(model, request, options);
		case "openrouter-images":
			return generateOpenRouterImage(model, request, options);
		case "google-generative-ai":
			return generateGoogleImage(model, request, options);
		case "google-gemini-cli":
			return generateAntigravityImage(model, request, options);
		case "openai-responses":
		case "openai-codex-responses":
			return generateHostedImage(model, request, options);
		default:
			throw new AIError.ValidationError(`Image generation does not support model API ${model.api}`);
	}
}
