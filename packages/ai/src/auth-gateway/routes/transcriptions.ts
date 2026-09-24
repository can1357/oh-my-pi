import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import * as transcriptions from "../../providers/transcriptions-server";
import { isCloudTranscriptionApi, transcribeAudio } from "../../transcription";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

/** OpenAI-compatible `POST /v1/audio/transcriptions` gateway handler. */
export async function handleTranscriptions(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => transcriptions.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: transcriptions.TranscriptionParsedRequest;
	try {
		parsed = await transcriptions.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof transcriptions.TranscriptionWireError ? error.status : 400;
		return transcriptions.formatError(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return transcriptions.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (!isCloudTranscriptionApi(model.api)) {
		const detail =
			model.api === "local-inference"
				? `Model ${parsed.modelId} runs on-device only and cannot be served by the auth gateway`
				: `Model ${parsed.modelId} does not support audio transcription`;
		return transcriptions.formatError(400, "invalid_request_error", detail);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`transcriptions\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") {
		return transcriptions.formatError(apiKey.status, apiKey.type, apiKey.message);
	}

	logger.info("auth-gateway request", {
		requestId,
		format: "transcriptions",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await transcribeAudio(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"transcriptions",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(
			200,
			transcriptions.encodeResponse(result),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway transcription failed", {
			format: "transcriptions",
			error: classified.message,
			peer,
		});
		return transcriptions.formatError(classified.status, classified.type, classified.message);
	}
}
