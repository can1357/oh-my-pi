import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import * as rerankWire from "../../providers/rerank-server";
import { rerank } from "../../rerank";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

/** OpenRouter-compatible `POST /v1/rerank` gateway handler. */
export async function handleRerank(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => rerankWire.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: rerankWire.RerankParsedRequest;
	try {
		parsed = await rerankWire.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof rerankWire.RerankWireError ? error.status : 400;
		return rerankWire.formatError(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return rerankWire.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== "openrouter-rerank") {
		return rerankWire.formatError(400, "invalid_request_error", `Model ${parsed.modelId} does not support reranking`);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`rerank\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return rerankWire.formatError(apiKey.status, apiKey.type, apiKey.message);

	logger.info("auth-gateway request", {
		requestId,
		format: "rerank",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await rerank(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"rerank",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(
			200,
			rerankWire.encodeResponse(
				result,
				parsed.modelId,
				parsed.originalDocuments,
				parsed.request.returnDocuments ?? false,
			),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway rerank failed", { format: "rerank", error: classified.message, peer });
		return rerankWire.formatError(classified.status, classified.type, classified.message);
	}
}
