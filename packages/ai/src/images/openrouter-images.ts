import type { Model } from "@oh-my-pi/pi-catalog/types";
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
	const body = {
		model: model.requestModelId ?? model.id,
		prompt: request.prompt,
		n: request.count ?? 1,
		response_format: "b64_json",
		...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
		...(request.imageSize ? { image_size: request.imageSize } : {}),
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
