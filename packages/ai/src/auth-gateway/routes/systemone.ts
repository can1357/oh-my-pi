/**
 * TypeSafe System One judgments: `POST /v1/systemone` (TypeSafe's path) and
 * `POST /alpha/decisions` (OpenRouter's Decisions path, same wire).
 *
 * Same bearer auth, model resolution, broker credential lookup, and a/b/c
 * credential rotation as the chat routes, dispatched through
 * {@link TypeSafeJudge} — pi-ai's client for this wire — so 401 rotation and
 * 429/529 backoff match omp's own judgments. A judgment is one JSON
 * round-trip: no stream, no provider session state. TypeSafe reports tokens
 * only, so the cost is priced from the catalog model for the response header
 * and the broker's observed-usage ledger.
 */
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import { isJudgmentApi, TypeSafeJudge } from "../../judgment/typesafe";
import * as systemOne from "../../providers/systemone-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

export async function handleSystemOne(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => systemOne.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return systemOne.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: systemOne.SystemOneParsedRequest;
	try {
		parsed = systemOne.parseRequest(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// TypeSafe answers body validation failures with 422.
		return systemOne.formatError(422, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return systemOne.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (!isJudgmentApi(model.api)) {
		return systemOne.formatError(
			422,
			"invalid_request_error",
			`Model ${parsed.modelId} does not answer System One judgments`,
		);
	}
	const client = resolveClientIdentity(req.headers);
	// Judgments carry no conversation to derive a session from. One sticky
	// session per model keeps credential selection stable across calls and
	// still lets `markUsageLimitReached` hand off to a sibling account.
	const sessionId = deterministicUuid(`systemone\u0000${model.provider}/${model.id}`);

	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if (typeof apiKey !== "string") return systemOne.formatError(apiKey.status, apiKey.type, apiKey.message);

	const judge = new TypeSafeJudge({
		apiKey: buildGatewayApiKeyResolver(
			bootOpts.storage,
			model,
			sessionId,
			apiKey,
			controller.signal,
			"systemone",
			peer,
		),
		api: model.api,
		provider: model.provider,
		model: model.id,
		baseUrl: model.baseUrl,
		fetch: bootOpts.fetch,
	});

	logger.info("auth-gateway request", {
		requestId,
		format: "systemone",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await judge.judge(parsed.request, { signal: controller.signal });
		// Encode before pricing: the body's `cost` means "upstream billed this"
		// (OpenRouter), while the header and ledger carry the catalog estimate
		// when the upstream reported tokens only (TypeSafe).
		const body = systemOne.encodeResponse(result);
		if (result.usage.cost.total === 0) calculateCost(model, result.usage);
		recordGatewayUsage(bootOpts.storage, model, client, result.usage);
		return json(200, body, gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }));
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway judgment failed", { format: "systemone", error: classified.message, peer });
		return systemOne.formatError(classified.status, classified.type, classified.message);
	}
}
