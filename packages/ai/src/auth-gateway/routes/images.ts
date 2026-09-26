import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import { generateImage } from "../../images";
import * as imagesServer from "../../providers/images-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

function isGatewayImageApi(api: string): boolean {
	return (
		api === "openai-images" ||
		api === "openrouter-images" ||
		api === "minimax-images" ||
		api === "google-generative-ai" ||
		api === "google-gemini-cli"
	);
}

async function handleImages(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	kind: imagesServer.ImageRequestKind,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => imagesServer.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown | FormData;
	try {
		body =
			kind === "edits" && req.headers.get("content-type")?.includes("multipart/form-data")
				? await req.formData()
				: await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return imagesServer.formatError(400, "invalid_request_error", `Invalid request body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: imagesServer.ImagesParsedRequest;
	try {
		parsed = await imagesServer.parseRequest(body, kind);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return imagesServer.formatError(400, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return imagesServer.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return imagesServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} requires a hosted image carrier, which the auth gateway cannot resolve`,
		);
	}
	if (!isGatewayImageApi(model.api)) {
		return imagesServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support image generation`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`images\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return imagesServer.formatError(apiKey.status, apiKey.type, apiKey.message);

	logger.info("auth-gateway request", {
		requestId,
		format: "images",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await generateImage(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"images",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		if (result.usage.cost.total === 0) calculateCost(model, result.usage);
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(
			200,
			imagesServer.encodeResponse(result, parsed.modelId),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway image generation failed", { format: "images", error: classified.message, peer });
		return imagesServer.formatError(classified.status, classified.type, classified.message);
	}
}

export function handleImageGenerations(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	return handleImages(bootOpts, req, peer, "generations");
}

export function handleImageEdits(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	return handleImages(bootOpts, req, peer, "edits");
}
