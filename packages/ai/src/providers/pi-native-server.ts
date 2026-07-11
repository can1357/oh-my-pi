/**
 * Pi-native wire format for the auth-gateway.
 *
 * Where the OpenAI / Anthropic / Responses route modules translate foreign
 * wire shapes through pi-ai's canonical {@link Context}, this module accepts
 * the canonical shape *directly* — for clients that already speak pi-ai
 * (containerized omp, the swarm extension, robomp's sidecar auth-gateway).
 * Skipping the wire-format → Context → wire-format round-trip cuts
 * per-request CPU but, more importantly, avoids the quantization that those
 * translations impose on first-class pi-ai fields (service tier, cache
 * markers, thinking budgets, tool-choice variants, …).
 *
 * The streaming wire is {@link AssistantMessageEvent} serialized verbatim and
 * SSE-framed. Same type pi-ai already produces internally; the client feeds
 * each parsed event straight into `AssistantMessageEventStream.push()` with
 * no translation. Including `partial: AssistantMessage` on every delta is
 * O(N²) in turn length on the wire — acceptable for the loopback / sidecar
 * topology this transport is designed for; provider latency dominates the
 * actual cost.
 *
 * Endpoint contract:
 *   POST /v1/pi/stream
 *   body:    { modelId, context, options?, stream? }   // `stream` defaults to true
 *   200 SSE: stream of `AssistantMessageEvent` (terminated by `data: [DONE]`)
 *   200 JSON (stream=false): { message: AssistantMessage }
 *   4xx/5xx: { error: { type, message } }
 */

import type { AuthGatewayStreamControl } from "../auth-gateway/types";
import * as AIError from "../error";
import type { AssistantMessageEventStream, Context, SimpleStreamOptions } from "../types";

export interface PiNativeParsedRequest {
	modelId: string;
	context: Context;
	options: SimpleStreamOptions;
	stream: boolean;
}
/**
 * Subset of {@link SimpleStreamOptions} accepted from the wire. Function-valued
 * fields (`fetch`, `onPayload`, `onResponse`, `onSseEvent`, exec handlers, the
 * provider-session map) and gateway-owned controls (`apiKey`, `signal`) are
 * intentionally absent — those are server-side concerns. Anything outside this
 * allow-list is dropped silently rather than 400ing, so clients can forward
 * `SimpleStreamOptions` from older / newer omp builds without per-version
 * conditionals.
 */
const ALLOWED_OPTION_KEYS: ReadonlySet<keyof SimpleStreamOptions> = new Set([
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"frequencyPenalty",
	"repetitionPenalty",
	"stopSequences",
	"maxTokens",
	"cacheRetention",
	"headers",
	"initiatorOverride",
	"maxRetryDelayMs",
	"metadata",
	"sessionId",
	"promptCacheKey",
	"streamFirstEventTimeoutMs",
	"streamIdleTimeoutMs",
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"toolChoice",
	"serviceTier",
	"kimiApiFormat",
	"syntheticApiFormat",
	"preferWebsockets",
	"openrouterVariant",
	"loopGuard",
] as const satisfies readonly (keyof SimpleStreamOptions)[]);

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

/**
 * Parse a pi-native request body. Validation is intentionally minimal — only
 * the shape the gateway itself reads is checked (`modelId`, `context.messages`
 * array, options is an object). Everything downstream is the canonical pi-ai
 * type surface; mis-shaped values surface as a `502 upstream_error` from
 * `streamSimple` rather than being re-validated here.
 *
 * Accepts both `{ modelId: string }` and `{ model: { id: string } }` so the
 * existing `streamProxy` client (which sends the full Model object) can target
 * the gateway with only a URL swap.
 */
export function parseRequest(body: unknown, _headers?: Headers): PiNativeParsedRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new AIError.ValidationError("Request body must be a JSON object");
	}
	const obj = body as Record<string, unknown>;

	let modelId: string | undefined;
	if (typeof obj.modelId === "string" && obj.modelId.length > 0) {
		modelId = obj.modelId;
	} else if (typeof obj.model === "string" && obj.model.length > 0) {
		modelId = obj.model;
	} else if (typeof obj.model === "object" && obj.model !== null) {
		const m = obj.model as Record<string, unknown>;
		if (typeof m.id === "string" && m.id.length > 0) modelId = m.id;
	}
	if (!modelId) throw new AIError.ValidationError("Missing `modelId` (or `model.id`) field");

	const context = obj.context;
	if (typeof context !== "object" || context === null || Array.isArray(context)) {
		throw new AIError.ValidationError("Missing `context` object");
	}
	const ctxObj = context as Record<string, unknown>;
	if (!Array.isArray(ctxObj.messages)) {
		throw new AIError.ValidationError("`context.messages` must be an array");
	}
	if (ctxObj.systemPrompt !== undefined && !Array.isArray(ctxObj.systemPrompt)) {
		throw new AIError.ValidationError("`context.systemPrompt` must be an array of strings when present");
	}
	if (ctxObj.tools !== undefined && !Array.isArray(ctxObj.tools)) {
		throw new AIError.ValidationError("`context.tools` must be an array when present");
	}

	const options: SimpleStreamOptions = {};
	const rawOpts = obj.options;
	if (typeof rawOpts === "object" && rawOpts !== null && !Array.isArray(rawOpts)) {
		const optsBag = options as Record<string, unknown>;
		for (const [k, v] of Object.entries(rawOpts)) {
			if (v === undefined || v === null) continue;
			if (!ALLOWED_OPTION_KEYS.has(k as keyof SimpleStreamOptions)) continue;
			optsBag[k] = v;
		}
	}

	// `stream` defaults to true — pi-native clients overwhelmingly stream, and
	// matching `streamProxy`'s implicit-stream behavior avoids a one-flag papercut.
	const stream = typeof obj.stream === "boolean" ? obj.stream : true;

	return {
		modelId,
		context: context as Context,
		options,
		stream,
	};
}
// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

const SSE_ENCODER = new TextEncoder();
const SSE_DONE = SSE_ENCODER.encode("data: [DONE]\n\n");

/**
 * Ship every {@link AssistantMessageEvent} verbatim, SSE-framed.
 *
 * No per-event re-shaping: the pi-native client is pi-ai itself, so the
 * canonical event type IS the wire type. Including the rolling
 * `partial: AssistantMessage` on every delta is quadratic in turn length
 * on the wire, but for the loopback / sidecar topology this transport
 * targets (containerized omp → host gateway, robomp slot → omp-auth-gateway
 * sidecar) the bandwidth cost is negligible compared to provider latency —
 * and the client gets to feed the events straight into its existing
 * `AssistantMessageEventStream.push()` plumbing with zero translation.
 */
export function encodeStream(
	events: AssistantMessageEventStream,
	_requestedModelId?: string,
	_options?: SimpleStreamOptions,
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const event of events) {
					if (cancelled) return;
					controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`));
					if (event.type === "done" || event.type === "error") break;
				}
				if (!cancelled) {
					controller.enqueue(SSE_DONE);
					controller.close();
				}
			} catch (err) {
				if (!cancelled) {
					// Best-effort error envelope so the client iterator resolves
					// instead of hanging on the dropped connection. Shape matches the
					// canonical `error` event minus the unrecoverable `error:
					// AssistantMessage` payload (we don't have a usable one here).
					const message = err instanceof Error ? err.message : String(err);
					controller.enqueue(
						SSE_ENCODER.encode(
							`data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: message })}\n\n`,
						),
					);
					controller.enqueue(SSE_DONE);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * Pi-native error envelope:
 *   `{ error: { type, message } }`
 *
 * Mirrors OpenAI's outer shape (which clients/SDKs already parse) without the
 * provider-specific status taxonomy — pi-native callers consume `type`
 * directly.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
