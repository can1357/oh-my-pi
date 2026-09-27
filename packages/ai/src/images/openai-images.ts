import type { Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import {
	decodeImageResponse,
	imageBaseUrl,
	postJson,
	postMultipart,
	resolveOpenAIImageSize,
	toDataUrl,
} from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

export const XAI_MAX_EDIT_IMAGES = 3;

export function resolveXAIResolution(imageSize?: string): "1k" | "2k" {
	return !imageSize || imageSize === "1024x1024" ? "1k" : "2k";
}

export async function generateOpenAIImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const size = resolveOpenAIImageSize(request.aspectRatio, request.imageSize);
	const count = request.count ?? 1;
	const isXAI = model.provider === "xai" || model.provider === "xai-oauth";
	const generationBody = isXAI
		? {
				model: model.requestModelId ?? model.id,
				prompt: request.prompt,
				aspect_ratio: request.aspectRatio ?? "1:1",
				resolution: resolveXAIResolution(request.imageSize),
				n: count,
				response_format: "b64_json",
			}
		: {
				model: model.requestModelId ?? model.id,
				prompt: request.prompt,
				n: count,
				response_format: "b64_json",
				...(size ? { size } : {}),
			};
	const references = (request.inputImages ?? []).map(image => ({ type: "image_url", url: toDataUrl(image) }));
	if (isXAI && references.length > XAI_MAX_EDIT_IMAGES) {
		throw new AIError.ValidationError(
			`${model.provider} image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${references.length}`,
		);
	}
	const [firstReference, ...remainingReferences] = references;
	const body = isXAI
		? remainingReferences.length === 0
			? { ...generationBody, image: firstReference }
			: { ...generationBody, images: references }
		: { ...generationBody, input_references: references };
	const baseUrl = imageBaseUrl(model);
	let response: unknown;
	if (references.length === 0) {
		response = await postJson({
			model,
			url: `${baseUrl}/images/generations`,
			body: generationBody,
			apiKey: options.apiKey,
			fetch: fetchImpl,
			signal: options.signal,
		});
	} else {
		try {
			if (model.provider === "openai") {
				const form = new FormData();
				form.set("model", model.requestModelId ?? model.id);
				form.set("prompt", request.prompt);
				form.set("n", String(count));
				form.set("response_format", "b64_json");
				if (size) form.set("size", size);
				for (const image of request.inputImages ?? []) {
					form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
				}
				response = await postMultipart({
					model,
					url: `${baseUrl}/images/edits`,
					body: form,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			} else {
				response = await postJson({
					model,
					url: `${baseUrl}/images/edits`,
					body,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			}
		} catch (error) {
			if (!(error instanceof AIError.ProviderHttpError) || error.status !== 404) throw error;
			response = await postJson({
				model,
				url: `${baseUrl}/images/generations`,
				body,
				apiKey: options.apiKey,
				fetch: fetchImpl,
				signal: options.signal,
			});
		}
	}
	return decodeImageResponse(response, fetchImpl, options.signal);
}
