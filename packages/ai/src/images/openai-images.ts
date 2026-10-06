import type { Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { resolveXaiBaseUrl } from "../providers/xai-base-url";
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
	const wireModelId = model.requestModelId ?? model.id;
	const isGptImage = model.identity.family === "gpt-image";
	const isXAI = model.provider === "xai" || model.provider === "xai-oauth";
	const generationBody = isXAI
		? {
				model: wireModelId,
				prompt: request.prompt,
				aspect_ratio: request.aspectRatio ?? "1:1",
				resolution: resolveXAIResolution(request.imageSize),
				n: count,
				...(isGptImage ? {} : { response_format: "b64_json" }),
			}
		: {
				model: wireModelId,
				prompt: request.prompt,
				n: count,
				...(isGptImage ? {} : { response_format: "b64_json" }),
				...(size ? { size } : {}),
			};
	const inputImages = request.inputImages ?? [];
	if (isXAI && inputImages.length > XAI_MAX_EDIT_IMAGES) {
		throw new AIError.ValidationError(
			`${model.provider} image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${inputImages.length}`,
		);
	}
	const baseUrl = imageBaseUrl(model);
	// xAI resolves the endpoint per bearer: XAI_BASE_URL never receives an xai-oauth OAuth access token.
	const endpoint = (path: string) =>
		isXAI
			? (bearer: string) => `${resolveXaiBaseUrl(model.provider, baseUrl, bearer) ?? baseUrl}${path}`
			: `${baseUrl}${path}`;
	let response: unknown;
	if (inputImages.length === 0) {
		response = await postJson({
			model,
			url: endpoint("/images/generations"),
			body: generationBody,
			apiKey: options.apiKey,
			fetch: fetchImpl,
			signal: options.signal,
		});
	} else {
		// Data URLs copy every multi-MB reference, so only the JSON routes build
		// them; OpenAI's multipart edit sends raw bytes and needs them only for
		// the 404 fallback.
		const buildEditBody = (): Record<string, unknown> => {
			const references = inputImages.map(image => ({ type: "image_url", url: toDataUrl(image) }));
			if (!isXAI) return { ...generationBody, input_references: references };
			return references.length === 1
				? { ...generationBody, image: references[0] }
				: { ...generationBody, images: references };
		};
		let editBody: Record<string, unknown> | undefined;
		try {
			if (model.provider === "openai") {
				const form = new FormData();
				form.set("model", wireModelId);
				form.set("prompt", request.prompt);
				form.set("n", String(count));
				if (!isGptImage) form.set("response_format", "b64_json");
				if (size) form.set("size", size);
				for (const image of inputImages) {
					form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
				}
				response = await postMultipart({
					model,
					url: endpoint("/images/edits"),
					body: form,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			} else {
				editBody = buildEditBody();
				response = await postJson({
					model,
					url: endpoint("/images/edits"),
					body: editBody,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			}
		} catch (error) {
			if (!(error instanceof AIError.ProviderHttpError) || error.status !== 404) throw error;
			response = await postJson({
				model,
				url: endpoint("/images/generations"),
				body: editBody ?? buildEditBody(),
				apiKey: options.apiKey,
				fetch: fetchImpl,
				signal: options.signal,
			});
		}
	}
	return decodeImageResponse(response, fetchImpl, options.signal);
}
