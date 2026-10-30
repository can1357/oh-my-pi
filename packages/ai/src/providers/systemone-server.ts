/**
 * Server side of TypeSafe's System One wire format (`POST /v1/systemone`),
 * served by the auth-gateway so TypeSafe SDKs and omp's own `NativeJudge`
 * can point `TYPESAFE_BASE_URL` at the gateway and never hold the real key.
 *
 * Requests are validated only as far as routing needs — the `model` id, the
 * shape of the `questions` map, top-level embedded images, and inline asset
 * maps — and otherwise forwarded to the selected native judgment wire.
 * Validation failures answer `422` like TypeSafe.
 */
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import { isEmbeddedImageContent } from "../images/shared";
import type { JudgmentRequest, JudgmentResult } from "../judgment/types";
import type { JudgmentImageAssets } from "../judgment/wire";
import type { ImageContent } from "../types";

/** Image shape only; the shared embedded-image guard validates data, MIME type, and detail. */
const systemOneImageSchema = type({
	type: "'image'",
	data: "string > 0",
	mimeType: "string > 0",
	"detail?": "unknown",
});

/** Inline JSON assets only: multipart `part` assets need a multipart body this ingress does not parse. */
const systemOneAssetSchema = type({
	"type?": "'image'",
	format: "'png' | 'jpg' | 'jpeg'",
	data_base64: "string > 0",
	"part?": "never",
});

const systemOneAssetsSchema = type({ "[string]": systemOneAssetSchema }).narrow(
	(assets, context) => !Array.isArray(assets) || context.mustBe("an object map"),
);

/**
 * TypeSafe accepts `instructions` and `criteria` as strings or structured
 * JSON (https://docs.typesafe.ai/api); only `type` decides how an answer is
 * read back, so that is all the gateway pins down.
 */
const systemOneRequestSchema = type({
	model: "string > 0",
	state: "string | object",
	questions: type({ "[string]": { type: "'noul' | 'choice' | 'score'", instructions: "string | object" } }),
	"images?": systemOneImageSchema.array(),
	"assets?": systemOneAssetsSchema,
});

export interface SystemOneParsedRequest {
	modelId: string;
	request: JudgmentRequest;
	imageAssets?: JudgmentImageAssets;
}

/** `POST /v1/systemone` response body; `cost` (USD) appears only when the route billed one. */
export interface SystemOneResponseBody {
	model: string;
	answers: JudgmentResult["answers"];
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/**
 * Validate the routing-relevant parts of a System One request body, including
 * top-level embedded images and inline TypeSafe image assets.
 *
 * @throws {AIError.ValidationError} when required routing fields are missing
 * or malformed, supplied image data is invalid, or an asset uses multipart
 * `part`, which this JSON ingress cannot read.
 */
export function parseRequest(body: unknown): SystemOneParsedRequest {
	const parsed = systemOneRequestSchema(body);
	if (parsed instanceof type.errors) throw new AIError.ValidationError(`systemone: ${parsed.summary}`);

	const images: ImageContent[] | undefined = parsed.images?.map((image, index) => {
		if (!isEmbeddedImageContent(image)) {
			throw new AIError.ValidationError(
				`systemone: images[${index}] must contain non-empty base64 data and an image MIME type`,
			);
		}
		return image;
	});
	const imageAssets: JudgmentImageAssets | undefined =
		parsed.assets === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(parsed.assets).map(([reference, asset]) => {
						const image = {
							type: "image",
							data: asset.data_base64,
							mimeType: asset.format === "png" ? "image/png" : "image/jpeg",
						};
						if (!isEmbeddedImageContent(image)) {
							throw new AIError.ValidationError(
								`systemone: assets[${JSON.stringify(reference)}] must contain non-empty base64 data`,
							);
						}
						return [reference, image];
					}),
				);
	const request = {
		state: parsed.state,
		questions: parsed.questions,
		...(images === undefined ? {} : { images }),
	} as JudgmentRequest;
	return {
		modelId: parsed.model,
		request,
		...(imageAssets === undefined ? {} : { imageAssets }),
	};
}

/** Re-encode a judgment result in TypeSafe's response shape. */
export function encodeResponse(result: JudgmentResult): SystemOneResponseBody {
	const usage: SystemOneResponseBody["usage"] = {
		input_tokens: result.usage.input,
		output_tokens: result.usage.output,
	};
	if (result.usage.cost.total > 0) usage.cost = result.usage.cost.total;
	return { model: result.model, answers: result.answers, usage };
}

/** TypeSafe answers errors with a status code and a JSON body; the envelope mirrors the other gateway routes. */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
