import type { Model } from "@oh-my-pi/pi-catalog/types";
import { geminiImageConfig } from "./gemini-image-config";
import { decodeImageResponse, imageBaseUrl, postJson, toDataUrl } from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

export async function generateOpenRouterImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const inputReferences = (request.inputImages ?? []).map(image => ({
		type: "image_url",
		image_url: { url: toDataUrl(image) },
	}));
	const geminiConfig = model.identity.class === "gemini" ? geminiImageConfig(request) : undefined;
	const aspectRatio = geminiConfig?.aspectRatio ?? request.aspectRatio;
	const imageSize = geminiConfig?.imageSize ?? request.imageSize;
	const body = {
		model: model.requestModelId ?? model.id,
		prompt: request.prompt,
		n: request.count ?? 1,
		response_format: "b64_json",
		...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
		...(imageSize ? { [geminiConfig ? "resolution" : "image_size"]: imageSize } : {}),
		...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
	};
	const response = await postJson({
		model,
		url: `${imageBaseUrl(model)}/images`,
		body,
		apiKey: options.apiKey,
		fetch: fetchImpl,
		signal: options.signal,
	});
	return decodeImageResponse(response, fetchImpl, options.signal);
}
