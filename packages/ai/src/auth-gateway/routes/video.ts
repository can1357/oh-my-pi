import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import * as videoServer from "../../providers/video-server";
import { downloadVideo, pollVideo, submitVideo } from "../../video";
import type { VideoJob } from "../../video/types";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

interface ResolvedVideoRequest {
	model: Model<Api>;
	upstreamId: string;
	sessionId: string;
	apiKey: string;
	controller: AbortController;
}

function aborted(): Response {
	return videoServer.formatError(499, "request_aborted", "client closed request");
}

async function resolveVideoJob(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	gatewayId: string,
): Promise<ResolvedVideoRequest | Response> {
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let identity: videoServer.GatewayJobIdentity;
	try {
		identity = videoServer.decodeGatewayJobId(gatewayId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(400, "invalid_request_error", message);
	}
	const model = bootOpts.resolveModel(`${identity.provider}/${identity.modelId}`);
	if (!model) {
		return videoServer.formatError(
			404,
			"invalid_request_error",
			`Unknown model: ${identity.provider}/${identity.modelId}`,
		);
	}
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${model.id} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	return { model, upstreamId: identity.upstreamId, sessionId, apiKey, controller };
}

function videoOptions(bootOpts: AuthGatewayBootOptions, resolved: ResolvedVideoRequest, peer: string) {
	return {
		apiKey: buildGatewayApiKeyResolver(
			bootOpts.storage,
			resolved.model,
			resolved.sessionId,
			resolved.apiKey,
			resolved.controller.signal,
			"video",
			peer,
		),
		fetch: bootOpts.fetch,
		signal: resolved.controller.signal,
	};
}

function logVideoRequest(
	requestId: string,
	operation: "submit" | "poll" | "content",
	model: ResolvedVideoRequest["model"],
	peer: string,
): void {
	logger.info("auth-gateway request", {
		requestId,
		format: `video-${operation}`,
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: operation === "content",
		peer,
	});
}

function recordCompletedUsage(
	bootOpts: AuthGatewayBootOptions,
	resolved: ResolvedVideoRequest,
	req: Request,
	job: VideoJob,
): void {
	if (job.status !== "completed" || job.usage === undefined) return;
	bootOpts.storage.usage.observe({
		provider: resolved.model.provider,
		model: resolved.model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		costUsd: job.usage.cost.total,
		client: resolveClientIdentity(req.headers),
	});
}

/** OpenRouter-compatible `POST /v1/videos` asynchronous video submit handler. */
export async function handleVideoSubmit(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let parsed: videoServer.VideoParsedRequest;
	try {
		parsed = videoServer.parseRequest(await req.json());
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(400, "invalid_request_error", message);
	}
	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return videoServer.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	logger.info("auth-gateway request", {
		requestId,
		format: "video-submit",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});
	try {
		const job = await submitVideo(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"video",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		const gatewayId = videoServer.encodeGatewayJobId({
			provider: model.provider,
			modelId: model.id,
			upstreamId: job.id,
		});
		return json(
			202,
			videoServer.encodeSubmitResponse(job, req, gatewayId),
			gatewayResponseHeaders(model, { requestId, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video submit failed", { format: "video-submit", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/** OpenRouter-compatible `GET /v1/videos/:id` asynchronous video poll handler. */
export async function handleVideoPoll(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	gatewayId: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "poll", resolved.model, peer);
	try {
		const job = await pollVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		recordCompletedUsage(bootOpts, resolved, req, job);
		return json(
			200,
			videoServer.encodePollResponse(job, req, gatewayId),
			gatewayResponseHeaders(resolved.model, {
				requestId,
				...(job.usage !== undefined && { costUsd: job.usage.cost.total }),
				startedAt,
			}),
		);
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video poll failed", { format: "video-poll", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/** OpenRouter-compatible `GET /v1/videos/:id/content` streaming video content handler. */
export async function handleVideoContent(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	gatewayId: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "content", resolved.model, peer);
	try {
		const content = await downloadVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		const headers = new Headers(gatewayResponseHeaders(resolved.model, { requestId, startedAt }));
		headers.set("Content-Type", content.contentType);
		headers.set("X-Content-Type-Options", "nosniff");
		if (content.contentLength !== undefined) headers.set("Content-Length", String(content.contentLength));
		return new Response(content.body, { status: 200, headers });
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video content failed", { format: "video-content", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}
