import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";
import { parseImageMetadata, USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { emptyUsage, imageBaseUrl, imageFromUrl, modelHeaders, toDataUrl } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

interface MinimaxBaseResp {
	status_code?: number;
	status_msg?: string;
}

interface MinimaxImageResponse {
	data?: { image_base64?: string[]; image_urls?: string[] };
	base_resp?: MinimaxBaseResp;
}

/** Documented i2i input limit (JPG/PNG). */
const MINIMAX_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * MiniMax reports application errors with HTTP 200 and a non-zero
 * `base_resp.status_code`. Translating to ProviderHttpError is load-bearing:
 * only that class lets the caller's provider loop fall through to the next
 * candidate and engage credential refresh/sibling rotation.
 */
function minimaxEnvelopeError(model: Model, baseResp: MinimaxBaseResp): AIError.ProviderHttpError {
	const statusCode = baseResp.status_code ?? 0;
	const status =
		statusCode === 1002 ? 429 : statusCode === 1004 || statusCode === 2049 ? 401 : statusCode === 1008 ? 402 : 502;
	return new AIError.ProviderHttpError(
		`${model.provider}/${model.id} image request failed (status_code ${statusCode}): ${baseResp.status_msg ?? "unknown error"}`,
		status,
	);
}

function parseMinimaxEnvelope(model: Model, value: unknown): MinimaxImageResponse {
	if (typeof value !== "object" || value === null) {
		throw new AIError.ProviderResponseError("MiniMax image API returned malformed envelope", {
			provider: model.provider,
			kind: "envelope",
		});
	}
	const parsed = value as MinimaxImageResponse;
	const baseResp = parsed.base_resp;
	if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
		throw minimaxEnvelopeError(model, baseResp);
	}
	return parsed;
}

/**
 * MiniMax i2i accepts exactly one character reference image under 10 MB.
 * The limits throw ProviderHttpError so a provider loop can fall through to
 * an edit-capable sibling instead of failing the whole request.
 */
function singleReference(model: Model, request: ImageGenerationRequest): GeneratedImage | undefined {
	const references = request.inputImages ?? [];
	if (references.length > 1) {
		throw new AIError.ProviderHttpError(
			`${model.provider}/${model.id} image edits accept a single reference image; got ${references.length}.`,
			400,
		);
	}
	const reference = references[0];
	if (reference && (reference.data.length * 3) / 4 > MINIMAX_MAX_REFERENCE_BYTES) {
		throw new AIError.ProviderHttpError(
			`${model.provider}/${model.id} reference images must be under 10 MB (JPG/PNG).`,
			400,
		);
	}
	return reference;
}

function buildMinimaxRequestBody(
	model: Model,
	request: ImageGenerationRequest,
	reference: GeneratedImage | undefined,
): Record<string, unknown> {
	return {
		model: model.requestModelId ?? model.id,
		prompt: request.prompt,
		response_format: "base64",
		n: request.count ?? 1,
		// aspect_ratio wins server-side over width/height, so it is only sent
		// when explicit pixel dimensions are absent; an image_size without an
		// aspect_ratio maps to width/height directly.
		...(request.aspectRatio === undefined && request.imageSize
			? {
					width: Number(request.imageSize.split("x")[0]),
					height: Number(request.imageSize.split("x")[1]),
				}
			: { aspect_ratio: request.aspectRatio ?? "1:1" }),
		...(reference ? { subject_reference: [{ type: "character", image_file: toDataUrl(reference) }] } : {}),
	};
}

async function collectMinimaxImages(
	model: Model,
	parsed: MinimaxImageResponse,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<GeneratedImage[]> {
	const images: GeneratedImage[] = [];
	for (const entry of parsed.data?.image_base64 ?? []) {
		const bytes = Buffer.from(entry, "base64");
		images.push({ data: entry, mimeType: parseImageMetadata(bytes)?.mimeType ?? "image/jpeg" });
	}
	if (images.length === 0) {
		for (const imageUrl of parsed.data?.image_urls ?? []) {
			images.push(await imageFromUrl(imageUrl, fetch, signal));
		}
	}
	if (images.length === 0) {
		throw new AIError.ProviderResponseError(`${model.provider}/${model.id} image response carried no images`, {
			provider: model.provider,
			kind: "envelope",
		});
	}
	return images;
}

/** Generate (or edit with one reference image) through the MiniMax image_generation endpoint. */
export async function generateMinimaxImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const reference = singleReference(model, request);
	const body = buildMinimaxRequestBody(model, request, reference);
	// MiniMax reports application errors with HTTP 200 and a non-zero
	// base_resp.status_code, so the envelope is validated inside the withAuth
	// callback — the translated 401/429 engage central refresh + sibling retry.
	const envelope = await withAuth(
		options.apiKey,
		async key => {
			const response = await fetchImpl(`${imageBaseUrl(model)}/image_generation`, {
				method: "POST",
				headers: {
					...(await modelHeaders(model, options.signal)),
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				throw new AIError.ProviderHttpError(
					`${model.provider}/${model.id} image request failed (${response.status}): ${text}`,
					response.status,
					{ headers: response.headers },
				);
			}
			try {
				return parseMinimaxEnvelope(model, JSON.parse(text) as unknown);
			} catch (cause) {
				if (cause instanceof AIError.ProviderHttpError) throw cause;
				throw new AIError.ProviderResponseError("MiniMax image API returned malformed JSON", {
					provider: model.provider,
					kind: "envelope",
					cause,
				});
			}
		},
		{ signal: options.signal },
	);
	return { images: await collectMinimaxImages(model, envelope, fetchImpl, options.signal), usage: emptyUsage() };
}
