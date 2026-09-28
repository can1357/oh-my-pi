import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import * as speechWire from "../../providers/speech-server";
import { isSpeechApi, synthesizeSpeech } from "../../speech";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, resolveClientIdentity } from "../http";

export async function handleSpeech(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => speechWire.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return speechWire.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: speechWire.SpeechParsedRequest;
	try {
		parsed = speechWire.parseRequest(body, req.headers);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return speechWire.formatError(400, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return speechWire.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (!isSpeechApi(model.api)) {
		const route =
			model.kind === "image"
				? "/v1/images/generations"
				: model.kind === "stt"
					? "/v1/audio/transcriptions"
					: model.kind === "judge"
						? "/v1/systemone"
						: undefined;
		const message = route
			? `Model ${parsed.modelId} does not synthesize speech; use POST ${route}`
			: `Model ${parsed.modelId} does not synthesize speech`;
		return speechWire.formatError(400, "invalid_request_error", message);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`speech\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return speechWire.formatError(apiKey.status, apiKey.type, apiKey.message);

	logger.info("auth-gateway request", {
		requestId,
		format: "speech",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await synthesizeSpeech(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"speech",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		const response = speechWire.encodeResponse(result, parsed.modelId);
		const responseHeaders = gatewayResponseHeaders(model, {
			requestId,
			costUsd: result.usage.cost.total,
			startedAt,
		});
		for (const name in responseHeaders) response.headers.set(name, responseHeaders[name]);
		return response;
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway speech failed", { format: "speech", error: classified.message, peer });
		return speechWire.formatError(classified.status, classified.type, classified.message);
	}
}
