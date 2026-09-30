import { logger } from "@oh-my-pi/pi-utils";
import { embed } from "../../embeddings";
import { classifyGatewayError } from "../../error/gateway";
import * as embeddings from "../../providers/embeddings-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

/** OpenAI-compatible `POST /v1/embeddings` gateway handler. */
export async function handleEmbeddings(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => embeddings.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: embeddings.EmbeddingsParsedRequest;
	try {
		parsed = await embeddings.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof embeddings.EmbeddingsWireError ? error.status : 400;
		return embeddings.formatError(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return embeddings.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (model.api !== "openai-embeddings") {
		return embeddings.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support embeddings`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`embeddings\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") {
		return embeddings.formatError(apiKey.status, apiKey.type, apiKey.message);
	}

	logger.info("auth-gateway request", {
		requestId,
		format: "embeddings",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await embed(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"embeddings",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(
			200,
			embeddings.encodeResponse(result, parsed.modelId),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway embeddings failed", {
			format: "embeddings",
			error: classified.message,
			peer,
		});
		return embeddings.formatError(classified.status, classified.type, classified.message);
	}
}
