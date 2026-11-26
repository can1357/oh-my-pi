import { logger } from "@oh-my-pi/pi-utils";
import type { ApiKey } from "../../auth-retry";
import { classifyGatewayError } from "../../error/gateway";
import { ValidationError } from "../../error/validation";
import type { Api, FetchImpl, Model, Usage } from "../../types";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	gatewayRequestLogFields,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { codedErrorResponse, gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

/** What one request/response gateway route supplies to {@link handleUnaryGatewayRoute}. */
export interface UnaryGatewayRoute<Parsed extends { modelId: string }, Result extends { usage: Usage }> {
	/** Request-log `format`, session-id namespace and credential-resolver label. */
	format: string;
	/** Noun of the failure log line: `auth-gateway <failure> failed`. */
	failure: string;
	parse(req: Request): Promise<Parsed>;
	/** HTTP status of a parse failure: the wire error's own, else 400. */
	parseErrorStatus(error: unknown): number;
	/** Why `model` cannot serve this route, or `undefined` when it can. */
	unsupported(model: Model<Api>, modelId: string): string | undefined;
	call(
		model: Model<Api>,
		parsed: Parsed,
		options: { apiKey: ApiKey; fetch?: FetchImpl; signal: AbortSignal },
	): Promise<Result>;
	encode(result: Result, parsed: Parsed): unknown;
}

/**
 * Serve one non-streaming gateway request: parse, resolve the model and its
 * credential, call upstream, record usage, encode. A client abort observed at
 * any step answers 499.
 */
export async function handleUnaryGatewayRoute<Parsed extends { modelId: string }, Result extends { usage: Usage }>(
	route: UnaryGatewayRoute<Parsed, Result>,
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => codedErrorResponse(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: Parsed;
	try {
		parsed = await route.parse(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return codedErrorResponse(route.parseErrorStatus(error), "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return codedErrorResponse(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	const unsupported = route.unsupported(model, parsed.modelId);
	if (unsupported !== undefined) return codedErrorResponse(400, "invalid_request_error", unsupported);

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`${route.format}\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return codedErrorResponse(apiKey.status, apiKey.type, apiKey.message);

	logger.info("auth-gateway request", {
		requestId,
		format: route.format,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
		...gatewayRequestLogFields(bootOpts, apiKey),
	});

	try {
		const result = await route.call(model, parsed, {
			apiKey: buildGatewayApiKeyResolver(bootOpts, model, sessionId, apiKey, controller.signal, route.format, peer),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(
			200,
			route.encode(result, parsed),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		// Adapter validation is a client error: the wire schema admits values the
		// adapter cannot serve, and the classifier would bill them as a 502.
		if (error instanceof ValidationError) {
			return codedErrorResponse(400, "invalid_request_error", error.message);
		}
		const classified = classifyGatewayError(error);
		logger.warn(`auth-gateway ${route.failure} failed`, {
			format: route.format,
			error: classified.message,
			peer,
		});
		return codedErrorResponse(classified.status, classified.type, classified.message);
	}
}
