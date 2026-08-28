/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses, Gemini v1beta) and dispatches through pi-ai's
 * `streamSimple()` — which handles credential injection, anthropic-beta
 * headers, codex websocket transport, and all the per-provider intricacies.
 * The gateway is pure protocol translation: foreign wire → omp Context →
 * pi-ai stream() → omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   GET  /v1/routes                        → list registered virtual routes
 *   GET  /v1/routes/:id                    → one registered virtual route
 *   PUT  /v1/routes/:id                    → register or replace a virtual route
 *   DELETE /v1/routes/:id                    → unregister a virtual route
 *   GET  /v1/executions/:id                → redacted decision traces for one execution
 *   GET  /v1/health/routes                 → virtual route ids, generations, and targets (no credentials)
 *   GET  /v1/credentials                   → stored credential ids, providers, and types (no secrets)
 *   POST /v1/credentials/:id/disable       → disable a stored credential
 *   POST /v1/credentials/:id/pin           → pin a session to an OAuth credential
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/grok/chat/completions         → OpenAI chat-completions (xAI alias)
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/messages/count_tokens         → Anthropic Messages count_tokens
 *   POST /v1/realtime                      → 501 not available on this gateway
 *   POST /v1/audio/speech                  → 501 not available on this gateway
 *   POST /v1/images/generations            → OpenAI Images generations
 *   POST /v1/responses                     → OpenAI Responses in/out
 *   POST /backend-api/codex/responses      → OpenAI Responses (Codex alias)
 *   POST /backend-api/responses            → OpenAI Responses (Codex alias)
 *   POST /v1beta/models/generateContent    → Gemini v1beta generateContent
 *   POST /v1beta/models/streamGenerateContent → Gemini v1beta streamGenerateContent
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { extractHttpStatusFromError, extractRetryHint, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import { isUsageLimitOutcome } from "../error/rate-limit";
import { handleCountTokens } from "../providers/anthropic-count-tokens-server";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as geminiV1beta from "../providers/gemini-v1beta-server";
import * as openaiChat from "../providers/openai-chat-server";
import { handleImageGeneration } from "../providers/openai-images-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types";
import type { ClientUsageIdentity } from "../usage";
import { deterministicUuid } from "../utils/deterministic-id";
import { parseBind } from "../utils/parse-bind";
import { candidateAllowed } from "./affinity";
import {
	type RouteDecisionTrace,
	RouteDecisionTraceLog,
	type RouteSkipReason,
	redactedDecisionSummary,
} from "./decision-trace";
import { type GatewayHooks, runHook } from "./hooks";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	isAuthorized,
	json,
	resolveClientIdentity,
	resolvePeer,
	resolvePromptCacheKey,
	withCors,
} from "./http";
import { PromptCacheAffinityStore } from "./prompt-cache-store";
import { ProviderHealthBook } from "./provider-health";
import { decideAttempt, type ExecutionState } from "./route-conductor";
import { parseRouteDefinition } from "./route-definitions";
import { type CompiledRoute, type RouteDefinition, RouteRegistry } from "./route-graph";
import {
	commitGateObservesDownstreamSse,
	observeSseCommit,
	StreamCommitGate,
	type StreamCommitState,
} from "./stream-commit-gate";
import type {
	AuthGatewayParsedRequestOptions,
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
	/**
	 * Wave A compiled-route shim. Constructed by {@link startAuthGateway} when omitted.
	 * When supplied, it remains the registry object; {@link routes} are still registered onto it.
	 */
	routeRegistry?: RouteRegistry;
	/**
	 * Optional virtual route definitions registered at boot.
	 * Applied onto {@link routeRegistry} even when that object is caller-supplied.
	 * An empty list is a no-op.
	 */
	routes?: readonly RouteDefinition[];
	/** Bounded redacted decision log. Constructed by {@link startAuthGateway} when omitted. */
	decisionTraces?: RouteDecisionTraceLog;
	/** Optional request lifecycle hooks. Missing hooks are a no-op. */
	hooks?: GatewayHooks;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

export const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/grok/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/codex/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/responses": { module: openaiResponses, label: "openai-responses" },
	"/v1beta/models/generateContent": { module: geminiV1beta, label: "gemini-v1beta" },
	"/v1beta/models/streamGenerateContent": { module: geminiV1beta, label: "gemini-v1beta" },
};

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...(opts.headers ?? {}), ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	applyParsedGatewayOptions(opts, options);
	return opts;
}

/**
 * Copy first-class parsed gateway fields onto {@link SimpleStreamOptions}.
 * Previously these were debug-logged and dropped; providers that honour them
 * (Responses continuation, parallel tool calls, …) must be able to read them.
 */
export function applyParsedGatewayOptions(opts: SimpleStreamOptions, options: AuthGatewayParsedRequestOptions): void {
	if (options.parallelToolCalls !== undefined) opts.parallelToolCalls = options.parallelToolCalls;
	if (options.previousResponseId !== undefined) opts.previousResponseId = options.previousResponseId;
	if (options.seed !== undefined) opts.seed = options.seed;
	if (options.logitBias !== undefined) opts.logitBias = options.logitBias;
	if (options.user !== undefined) opts.user = options.user;
	if (options.responseFormat !== undefined) opts.responseFormat = options.responseFormat;
}

/**
 * Hook fired by {@link streamSimple} when the upstream request fails in a
 * way that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.markUsageLimitReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.invalidateCredentialMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so streamSimple can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
	requestId: string,
): Promise<string | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	const status = extractHttpStatusFromError(error);
	if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await storage.markUsageLimitReached(provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!switched) return undefined;
		return storage.getApiKey(provider, sessionId, { modelId: model.id, signal, requestId });
	}
	await storage.invalidateCredentialMatching(provider, oldKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	return storage.getApiKey(provider, sessionId, { modelId: model.id, signal, requestId });
}

/**
 * Build the {@link ApiKeyResolver} handed to `streamSimple` for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed.
 */
function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: string,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	requestId: string,
): ApiKeyResolver {
	let lastKey = initialKey;
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey;
			return initialKey;
		}
		if (!lastChance) {
			const refreshed = await storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
				requestId,
			});
			lastKey = refreshed ?? lastKey;
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			sessionId,
			model.provider,
			lastKey,
			error,
			sig,
			format,
			peer,
			requestId,
		);
		lastKey = next ?? lastKey;
		return next;
	};
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

type FormatErrorFn = (status: number, type: string, message: string) => Response;

type AttemptPrep = { type: "key"; apiKey: string } | { type: "retry" } | { type: "respond"; response: Response };

function unknownModelResponse(formatError: FormatErrorFn, modelId: string): Response {
	return formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
}

function conductorExecutionState(
	compiled: CompiledRoute,
	attemptedTargets: ReadonlySet<string>,
	attemptedCredentials: ReadonlySet<number>,
	retryCount: number,
	fallbackCount: number,
	currentTarget: string,
	siblingsExhausted: boolean,
	commitState: StreamCommitState,
): ExecutionState {
	return {
		routeId: compiled.id,
		generation: compiled.generation,
		attemptedTargets,
		attemptedCredentials,
		retryCount,
		fallbackCount,
		committed: commitState !== "probing",
		currentTarget,
		siblingsExhausted,
	};
}

function dispatchTargetId(
	compiled: CompiledRoute,
	state: ExecutionState,
	commitState: StreamCommitState,
	cacheStore: PromptCacheAffinityStore,
	fingerprint: string,
): string | undefined {
	const hit = cacheStore.lookup(fingerprint);
	const action = decideAttempt({
		route: compiled,
		state,
		commitState,
		preferredTargetId: hit?.model,
	});
	return action.type === "dispatch" ? action.targetModelId : undefined;
}

/**
 * Attribute one settled upstream request to the originating client via the
 * broker's observed-usage channel (`AuthStorage.recordObservedUsage`, batched
 * by the remote store). Error/aborted turns still record — the provider
 * billed whatever tokens the partial turn consumed; zero-usage messages
 * (pre-flight failures) are skipped.
 */
function recordGatewayUsage(
	storage: AuthStorage,
	model: Model<Api>,
	client: ClientUsageIdentity,
	message: AssistantMessage,
): void {
	if (!messageHasBillableUsage(message)) return;
	const usage = message.usage;
	storage.recordObservedUsage({
		provider: model.provider,
		model: model.id,
		at: message.timestamp || Date.now(),
		usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		costUsd: usage.cost.total,
		client,
	});
}

function messageHasBillableUsage(message: AssistantMessage): boolean {
	const usage = message.usage;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
}

const STREAM_PRELUDE_MAX_BYTES = 4 * 1024 * 1024;

type SseRead = { done: boolean; value?: Uint8Array };

type HeldSse =
	| { type: "forward"; stream: ReadableStream<Uint8Array> }
	| { type: "failed"; error: unknown; message?: AssistantMessage };

function attachCommitGateSseObserver(
	streamOpts: SimpleStreamOptions,
	commitGate: StreamCommitGate,
	routeLabel: string,
): void {
	const previousSse = streamOpts.onSseEvent;
	streamOpts.onSseEvent = (event, sseModel) => {
		const raw = event.raw;
		let bytes = 0;
		for (const line of raw) bytes += line.length + 1;
		commitGate.classifyAndObserve(event.event ?? "", bytes);
		// Consume the observation: a terminal event that ended the stream
		// before commit is the pre-commit-failure signal the failover loop
		// routes on; surface it instead of discarding the gate state.
		if (commitGate.state === "terminated") {
			logger.debug("auth-gateway stream terminated pre-commit", {
				route: routeLabel,
				event: event.event ?? "",
			});
		}
		previousSse?.(event, sseModel);
	};
}

function concatSsePrelude(
	prelude: Uint8Array[],
	reader: { read(): Promise<SseRead>; cancel(reason?: unknown): Promise<void> },
	pending: Promise<SseRead> | undefined,
): ReadableStream<Uint8Array> {
	let pendingRead = pending;
	let preludeOffset = 0;
	return new ReadableStream({
		async pull(controller) {
			if (preludeOffset < prelude.length) {
				const chunk = prelude[preludeOffset];
				preludeOffset += 1;
				if (chunk) controller.enqueue(chunk);
				return;
			}
			const read = pendingRead ?? reader.read();
			pendingRead = undefined;
			const { done, value } = await read;
			if (done || value === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * Buffer encoded SSE until the commit gate leaves probing or the upstream
 * attempt settles. Callers must not return HTTP 200 while still probing.
 */
async function holdSseUntilCommit(
	sseStream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
	settled: Promise<AssistantMessage>,
): Promise<HeldSse> {
	const reader = sseStream.getReader();
	const prelude: Uint8Array[] = [];
	let preludeBytes = 0;
	let pendingRead: Promise<SseRead> | undefined;
	let settleOutcome: { ok: true; message: AssistantMessage } | { ok: false; error: unknown } | undefined;
	const watchSettled = settled.then(
		message => {
			settleOutcome = { ok: true, message };
		},
		(error: unknown) => {
			settleOutcome = { ok: false, error };
		},
	);

	const forward = (): HeldSse => ({
		type: "forward",
		stream: concatSsePrelude(prelude, reader, pendingRead),
	});

	const failedFromOutcome = (): HeldSse => {
		if (!settleOutcome) return { type: "failed", error: "Upstream request failed" };
		if (!settleOutcome.ok) return { type: "failed", error: settleOutcome.error };
		return {
			type: "failed",
			error: settleOutcome.message.errorMessage ?? settleOutcome.message,
			message: settleOutcome.message,
		};
	};

	try {
		while (true) {
			if (gate.state === "committed") return forward();
			if (preludeBytes >= STREAM_PRELUDE_MAX_BYTES) {
				if (gate.state === "probing") gate.classifyAndObserve("", STREAM_PRELUDE_MAX_BYTES);
				return forward();
			}
			if (settleOutcome) {
				if (!settleOutcome.ok) return failedFromOutcome();
				const reason = settleOutcome.message.stopReason;
				if (reason === "error" || reason === "aborted") return failedFromOutcome();
				return forward();
			}
			pendingRead ??= reader.read();
			const raced = await Promise.race([
				pendingRead.then(r => ({ source: "read" as const, r })),
				watchSettled.then(() => ({ source: "settled" as const })),
			]);
			if (raced.source === "settled") continue;
			pendingRead = undefined;
			const { done, value } = raced.r;
			if (done || value === undefined) {
				await watchSettled;
				continue;
			}
			prelude.push(value);
			preludeBytes += value.byteLength;
		}
	} catch (error) {
		return { type: "failed", error };
	}
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

// (handlePassthrough removed — see note above.)

function releaseTurnOnStreamEnd(
	stream: ReadableStream<Uint8Array>,
	storage: AuthStorage,
	requestId: string,
	commitGate?: StreamCommitGate,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		if (commitGate && (commitGate.state === "committed" || commitGate.state === "terminated")) {
			storage.settleQuotaProbeSuccess(requestId);
		}
		storage.releaseTurnReservation(requestId);
	};
	return new ReadableStream({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				release();
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			release();
			return reader.cancel(reason);
		},
	});
}

function targetSkipReason(
	compiled: CompiledRoute,
	health: ProviderHealthBook,
	targetId: string,
	model: Model<Api>,
): RouteSkipReason | undefined {
	if (
		compiled.portability !== undefined &&
		!candidateAllowed(
			compiled.portability,
			{ id: targetId, provider: model.provider },
			compiled.affinity ?? "preferred",
		)
	) {
		return "state_incompatible";
	}
	if (health.state(model.provider, model.id) === "open") {
		return "circuit_open";
	}
	return undefined;
}

function recordProviderHealthFailure(
	health: ProviderHealthBook,
	model: Model<Api>,
	classified: GatewayErrorClassification,
): void {
	if (classified.owner === "provider") {
		health.recordFailure(model.provider, model.id, "provider");
	}
}

function rememberPromptCacheHit(
	cacheStore: PromptCacheAffinityStore,
	body: unknown,
	requestId: string,
	model: Model<Api>,
	sessionId: string,
): void {
	cacheStore.remember(resolvePromptCacheKey(body) ?? requestId, {
		provider: model.provider,
		model: model.id,
		accountId: sessionId,
	});
}

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	health: ProviderHealthBook,
	cacheStore: PromptCacheAffinityStore,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}
	const compiled = (bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel)).resolve(modelId);
	if (!compiled) {
		return unknownModelResponse(route.module.formatError, modelId);
	}
	const firstTarget = compiled.targets[0];
	if (firstTarget === undefined) {
		return unknownModelResponse(route.module.formatError, modelId);
	}
	let currentTarget = firstTarget;
	const initialModel = bootOpts.resolveModel(currentTarget);
	if (!initialModel) {
		return unknownModelResponse(route.module.formatError, currentTarget);
	}
	let model: Model<Api> = initialModel;
	const client = resolveClientIdentity(req.headers);

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	await runHook(bootOpts.hooks?.beforeRequest, {
		requestId,
		routeId: compiled.id,
		generation: compiled.generation,
	});
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...(parsed.options.headers ?? {}) };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const supportsOpenAIImageFileReferences =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	if (
		route.label === "openai-responses" &&
		!supportsOpenAIImageFileReferences &&
		parsed.context.messages.some(
			message =>
				message.role === "toolResult" &&
				message.content.some(
					block => block.type === "image" && block.providerFile?.provider === "openai" && block.providerFile.id,
				),
		)
	) {
		return route.module.formatError(
			400,
			"invalid_request_error",
			"OpenAI image file IDs in tool outputs require a Responses-compatible upstream model",
		);
	}

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const sessionId = parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.promptCacheKey ??= sessionId;

	const traces = bootOpts.decisionTraces ?? new RouteDecisionTraceLog();
	const commitGate = new StreamCommitGate();
	const formatError = route.module.formatError;
	const fingerprint = resolvePromptCacheKey(body, req.headers) ?? requestId;
	const attemptedTargets = new Set<string>();
	const attemptedCredentials = new Set<number>();
	let retryCount = 0;
	let fallbackCount = 0;
	let pendingFallback: string | undefined;
	let lastClassified: GatewayErrorClassification | undefined;
	let siblingsExhausted = false;
	const attemptCap = compiled.targets.length + 1;

	const stateNow = (): ExecutionState =>
		conductorExecutionState(
			compiled,
			attemptedTargets,
			attemptedCredentials,
			retryCount,
			fallbackCount,
			currentTarget,
			siblingsExhausted,
			commitGate.state,
		);

	const classifiedError = (classified: GatewayErrorClassification): Response =>
		formatError(classified.status, classified.type, classified.message);

	const considerFallback = (classified: GatewayErrorClassification): boolean => {
		lastClassified = classified;
		recordProviderHealthFailure(health, model, classified);
		if (commitGate.state === "committed") return false;
		const action = decideAttempt({
			route: compiled,
			state: conductorExecutionState(
				compiled,
				attemptedTargets,
				attemptedCredentials,
				retryCount,
				fallbackCount,
				currentTarget,
				siblingsExhausted,
				"probing",
			),
			classification: classified,
			commitState: "probing",
		});
		if (action.type === "sibling_credential") {
			siblingsExhausted = true;
			pendingFallback = currentTarget;
			retryCount += 1;
			return true;
		}
		if (action.type === "fallback_target") {
			pendingFallback = action.targetModelId;
			fallbackCount += 1;
			retryCount += 1;
			return true;
		}
		return false;
	};

	const bindCurrentTarget = (targetId: string): Response | undefined | "skipped" => {
		currentTarget = targetId;
		const resolved = bootOpts.resolveModel(currentTarget);
		if (!resolved) {
			return lastClassified
				? classifiedError(lastClassified)
				: formatError(502, "upstream_error", "Upstream request failed");
		}
		model = resolved;
		const skip = targetSkipReason(compiled, health, currentTarget, model);
		if (skip !== undefined) {
			attemptedTargets.add(currentTarget);
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: skip,
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return "skipped";
		}
		attemptedTargets.add(currentTarget);
		return undefined;
	};

	const pickTarget = (): Response | undefined => {
		for (;;) {
			let targetId: string | undefined;
			if (pendingFallback !== undefined) {
				targetId = pendingFallback;
				pendingFallback = undefined;
			} else {
				targetId = dispatchTargetId(compiled, stateNow(), commitGate.state, cacheStore, fingerprint);
			}
			if (targetId === undefined) {
				if (lastClassified) return classifiedError(lastClassified);
				if (attemptedTargets.size > 0) {
					return formatError(502, "upstream_error", "Upstream request failed");
				}
				return unknownModelResponse(formatError, modelId);
			}
			const bound = bindCurrentTarget(targetId);
			if (bound === "skipped") {
				if (lastClassified) {
					const action = decideAttempt({
						route: compiled,
						state: conductorExecutionState(
							compiled,
							attemptedTargets,
							attemptedCredentials,
							retryCount,
							fallbackCount,
							currentTarget,
							siblingsExhausted,
							"probing",
						),
						classification: lastClassified,
						commitState: "probing",
					});
					if (action.type === "fallback_target") {
						pendingFallback = action.targetModelId;
					}
				}
				continue;
			}
			return bound;
		}
	};

	const resolveCredential = async (): Promise<AttemptPrep> => {
		let apiKey: string | undefined;
		try {
			apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
				requestId,
			});
		} catch (error) {
			if (controller.signal.aborted) return { type: "respond", response: clientClosedResponse(route) };
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			if (considerFallback(classified)) return { type: "retry" };
			return { type: "respond", response: classifiedError(classified) };
		}
		if (controller.signal.aborted) return { type: "respond", response: clientClosedResponse(route) };
		if (!apiKey) {
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_unavailable",
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return {
				type: "respond",
				response: formatError(
					401,
					"authentication_error",
					`No credential available for provider ${model.provider}`,
				),
			};
		}
		const activeCredentialId = bootOpts.storage
			.listOAuthAccounts(model.provider, sessionId)
			.find(account => account.active)?.credentialId;
		if (activeCredentialId !== undefined) attemptedCredentials.add(activeCredentialId);
		const dispatched = traces.record({
			requestId,
			routeId: compiled.id,
			generation: compiled.generation,
			selectedTarget: currentTarget,
			disposition: "dispatched",
		});
		logger.debug("auth-gateway route decision", redactedDecisionSummary(dispatched));
		return { type: "key", apiKey };
	};

	const buildAttemptStreamOpts = (apiKey: string): SimpleStreamOptions => {
		const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
		streamOpts.apiKey = buildGatewayApiKeyResolver(
			bootOpts.storage,
			model,
			sessionId,
			apiKey,
			controller.signal,
			route.label,
			peer,
			requestId,
		);
		// openai-responses wraps the downstream body in observeSseCommit. Feeding
		// onSseEvent as well double-counts prelude bytes and trips the 4 MiB cap at ~2 MiB.
		if (!commitGateObservesDownstreamSse(route.label)) {
			attachCommitGateSseObserver(streamOpts, commitGate, route.label);
		}
		return streamOpts;
	};

	if (!parsed.stream) {
		try {
			for (let attempt = 0; attempt < attemptCap; attempt++) {
				if (controller.signal.aborted) return clientClosedResponse(route);
				const picked = pickTarget();
				if (picked) return picked;
				const cred = await resolveCredential();
				if (cred.type === "retry") {
					bootOpts.storage.releaseTurnReservation(requestId);
					continue;
				}
				if (cred.type === "respond") return cred.response;
				const streamOpts = buildAttemptStreamOpts(cred.apiKey);
				logger.info("auth-gateway request", {
					requestId,
					format: route.label,
					model: parsed.modelId,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
					stream: parsed.stream,
					peer,
				});
				try {
					const message = await completeSimple(model, parsed.context, streamOpts);
					recordGatewayUsage(bootOpts.storage, model, client, message);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage =
							message.errorMessage ??
							(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
						logger.warn("auth-gateway non-streaming failed", {
							format: route.label,
							reason: message.stopReason,
							error: errorMessage,
							peer,
						});
						if (message.stopReason === "aborted") {
							return formatError(499, "request_aborted", errorMessage);
						}
						const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
						recordProviderHealthFailure(health, model, classified);
						if (messageHasBillableUsage(message)) {
							return formatError(classified.status, classified.type, errorMessage);
						}
						if (considerFallback(classified)) {
							bootOpts.storage.releaseTurnReservation(requestId);
							continue;
						}
						return formatError(classified.status, classified.type, errorMessage);
					}
					bootOpts.storage.settleQuotaProbeSuccess(requestId);
					rememberPromptCacheHit(cacheStore, body, requestId, model, sessionId);
					await runHook(bootOpts.hooks?.afterRequest, {
						requestId,
						routeId: compiled.id,
						generation: compiled.generation,
						ok: true,
					});
					return json(
						200,
						route.module.encodeResponse(message, parsed.modelId),
						gatewayResponseHeaders(model, { requestId, message, startedAt }),
					);
				} catch (error) {
					if (controller.signal.aborted) return clientClosedResponse(route);
					const classified = classifyGatewayError(error);
					logger.warn("auth-gateway non-streaming aborted", {
						format: route.label,
						error: classified.message,
						peer,
					});
					if (considerFallback(classified)) {
						bootOpts.storage.releaseTurnReservation(requestId);
						continue;
					}
					return classifiedError(classified);
				}
			}
			if (lastClassified) return classifiedError(lastClassified);
			return formatError(502, "upstream_error", "Upstream request failed");
		} finally {
			bootOpts.storage.releaseTurnReservation(requestId);
		}
	}

	for (let attempt = 0; attempt < attemptCap; attempt++) {
		if (controller.signal.aborted) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return clientClosedResponse(route);
		}
		const picked = pickTarget();
		if (picked) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return picked;
		}
		const cred = await resolveCredential();
		if (cred.type === "retry") {
			bootOpts.storage.releaseTurnReservation(requestId);
			continue;
		}
		if (cred.type === "respond") {
			bootOpts.storage.releaseTurnReservation(requestId);
			return cred.response;
		}
		const streamOpts = buildAttemptStreamOpts(cred.apiKey);
		logger.info("auth-gateway request", {
			requestId,
			format: route.label,
			model: parsed.modelId,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			stream: parsed.stream,
			peer,
		});
		let events: AssistantMessageEventStream;
		try {
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
			if (considerFallback(classified)) {
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		const settled = events.result();
		void settled.then(message => recordGatewayUsage(bootOpts.storage, model, client, message)).catch(() => {});
		let sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		if (route.label === "openai-responses") {
			sseStream = observeSseCommit(sseStream, commitGate);
		}
		const held = await holdSseUntilCommit(sseStream, commitGate, settled);
		if (held.type === "failed") {
			if (held.message && messageHasBillableUsage(held.message)) {
				const errorMessage =
					held.message.errorMessage ??
					(held.message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (held.message.stopReason === "aborted") {
					bootOpts.storage.releaseTurnReservation(requestId);
					return formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(held.message.errorClassificationMessage ?? errorMessage);
				recordProviderHealthFailure(health, model, classified);
				bootOpts.storage.releaseTurnReservation(requestId);
				return formatError(classified.status, classified.type, errorMessage);
			}
			const classified = classifyGatewayError(
				held.message?.errorClassificationMessage ?? held.message?.errorMessage ?? held.error,
			);
			logger.warn("auth-gateway stream attempt failed before commit", {
				format: route.label,
				error: classified.message,
				peer,
			});
			if (considerFallback(classified)) {
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (controller.signal.aborted) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return clientClosedResponse(route);
		}
		sseStream = releaseTurnOnStreamEnd(held.stream, bootOpts.storage, requestId, commitGate);
		rememberPromptCacheHit(cacheStore, body, requestId, model, sessionId);
		await runHook(bootOpts.hooks?.afterRequest, {
			requestId,
			routeId: compiled.id,
			generation: compiled.generation,
			ok: true,
		});
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				// Disable proxy buffering (nginx and ingress controllers honor this).
				// Without it the SSE stream gets held until the buffer flushes, which
				// stalls the long-thinking-budget calls we exist to support.
				"X-Accel-Buffering": "no",
			},
		});
	}
	bootOpts.storage.releaseTurnReservation(requestId);
	if (lastClassified) return classifiedError(lastClassified);
	return formatError(502, "upstream_error", "Upstream request failed");
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	health: ProviderHealthBook,
	cacheStore: PromptCacheAffinityStore,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const compiled = (bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel)).resolve(parsed.modelId);
	if (!compiled) {
		return unknownModelResponse(piNative.formatError, parsed.modelId);
	}
	const firstTarget = compiled.targets[0];
	if (firstTarget === undefined) {
		return unknownModelResponse(piNative.formatError, parsed.modelId);
	}
	let currentTarget = firstTarget;
	const initialModel = bootOpts.resolveModel(currentTarget);
	if (!initialModel) {
		return unknownModelResponse(piNative.formatError, currentTarget);
	}
	let model: Model<Api> = initialModel;
	const client = resolveClientIdentity(req.headers);
	// Pi-native already parsed `streamOpts.sessionId` (when set by the
	// client); fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const sessionId = parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= sessionId;

	const traces = bootOpts.decisionTraces ?? new RouteDecisionTraceLog();
	const commitGate = new StreamCommitGate();
	const formatError = piNative.formatError;
	const fingerprint = resolvePromptCacheKey(body, req.headers) ?? requestId;
	const attemptedTargets = new Set<string>();
	const attemptedCredentials = new Set<number>();
	let retryCount = 0;
	let fallbackCount = 0;
	let pendingFallback: string | undefined;
	let lastClassified: GatewayErrorClassification | undefined;
	let siblingsExhausted = false;
	const attemptCap = compiled.targets.length + 1;

	const stateNow = (): ExecutionState =>
		conductorExecutionState(
			compiled,
			attemptedTargets,
			attemptedCredentials,
			retryCount,
			fallbackCount,
			currentTarget,
			siblingsExhausted,
			commitGate.state,
		);

	const classifiedError = (classified: GatewayErrorClassification): Response =>
		formatError(classified.status, classified.type, classified.message);

	const considerFallback = (classified: GatewayErrorClassification): boolean => {
		lastClassified = classified;
		recordProviderHealthFailure(health, model, classified);
		if (commitGate.state === "committed") return false;
		const action = decideAttempt({
			route: compiled,
			state: conductorExecutionState(
				compiled,
				attemptedTargets,
				attemptedCredentials,
				retryCount,
				fallbackCount,
				currentTarget,
				siblingsExhausted,
				"probing",
			),
			classification: classified,
			commitState: "probing",
		});
		if (action.type === "sibling_credential") {
			siblingsExhausted = true;
			pendingFallback = currentTarget;
			retryCount += 1;
			return true;
		}
		if (action.type === "fallback_target") {
			pendingFallback = action.targetModelId;
			fallbackCount += 1;
			retryCount += 1;
			return true;
		}
		return false;
	};

	const bindCurrentTarget = (targetId: string): Response | undefined | "skipped" => {
		currentTarget = targetId;
		const resolved = bootOpts.resolveModel(currentTarget);
		if (!resolved) {
			return lastClassified
				? classifiedError(lastClassified)
				: formatError(502, "upstream_error", "Upstream request failed");
		}
		model = resolved;
		const skip = targetSkipReason(compiled, health, currentTarget, model);
		if (skip !== undefined) {
			attemptedTargets.add(currentTarget);
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: skip,
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return "skipped";
		}
		attemptedTargets.add(currentTarget);
		return undefined;
	};

	const pickTarget = (): Response | undefined => {
		for (;;) {
			let targetId: string | undefined;
			if (pendingFallback !== undefined) {
				targetId = pendingFallback;
				pendingFallback = undefined;
			} else {
				targetId = dispatchTargetId(compiled, stateNow(), commitGate.state, cacheStore, fingerprint);
			}
			if (targetId === undefined) {
				if (lastClassified) return classifiedError(lastClassified);
				if (attemptedTargets.size > 0) {
					return formatError(502, "upstream_error", "Upstream request failed");
				}
				return unknownModelResponse(formatError, parsed.modelId);
			}
			const bound = bindCurrentTarget(targetId);
			if (bound === "skipped") {
				if (lastClassified) {
					const action = decideAttempt({
						route: compiled,
						state: conductorExecutionState(
							compiled,
							attemptedTargets,
							attemptedCredentials,
							retryCount,
							fallbackCount,
							currentTarget,
							siblingsExhausted,
							"probing",
						),
						classification: lastClassified,
						commitState: "probing",
					});
					if (action.type === "fallback_target") {
						pendingFallback = action.targetModelId;
					}
				}
				continue;
			}
			return bound;
		}
	};

	const resolveCredential = async (): Promise<AttemptPrep> => {
		let apiKey: string | undefined;
		try {
			apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
				requestId,
			});
		} catch (error) {
			if (controller.signal.aborted) return { type: "respond", response: aborted() };
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			if (considerFallback(classified)) return { type: "retry" };
			return { type: "respond", response: classifiedError(classified) };
		}
		if (controller.signal.aborted) return { type: "respond", response: aborted() };
		if (!apiKey) {
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_unavailable",
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return {
				type: "respond",
				response: formatError(
					401,
					"authentication_error",
					`No credential available for provider ${model.provider}`,
				),
			};
		}
		const activeCredentialId = bootOpts.storage
			.listOAuthAccounts(model.provider, sessionId)
			.find(account => account.active)?.credentialId;
		if (activeCredentialId !== undefined) attemptedCredentials.add(activeCredentialId);
		const dispatched = traces.record({
			requestId,
			routeId: compiled.id,
			generation: compiled.generation,
			selectedTarget: currentTarget,
			disposition: "dispatched",
		});
		logger.debug("auth-gateway route decision", redactedDecisionSummary(dispatched));
		return { type: "key", apiKey };
	};

	const buildAttemptStreamOpts = (apiKey: string): SimpleStreamOptions => {
		// Build the SimpleStreamOptions actually handed to `streamSimple`. We
		// trust the client's options (already allow-listed by `parseRequest`) and
		// only inject server-controlled fields. The codex sampling strip mirrors
		// `buildStreamOptions` — Codex rejects every one with a 400 (#3117).
		const streamOpts: SimpleStreamOptions = { ...parsed.options, apiKey, signal: controller.signal };
		streamOpts.apiKey = buildGatewayApiKeyResolver(
			bootOpts.storage,
			model,
			sessionId,
			apiKey,
			controller.signal,
			"pi-native",
			peer,
			requestId,
		);
		if (model.api === "openai-codex-responses") {
			delete streamOpts.temperature;
			delete streamOpts.topP;
			delete streamOpts.topK;
			delete streamOpts.minP;
			delete streamOpts.stopSequences;
			delete streamOpts.presencePenalty;
			delete streamOpts.frequencyPenalty;
			delete streamOpts.repetitionPenalty;
		}
		// Merge gateway-captured passthrough headers under the client's own
		// headers — the client's values win when they collide.
		const captured = captureRequestHeaders(req.headers);
		streamOpts.headers = { ...captured, ...(streamOpts.headers ?? {}) };
		streamOpts.sessionId ??= sessionId;
		if (!commitGateObservesDownstreamSse("pi-native")) {
			attachCommitGateSseObserver(streamOpts, commitGate, "pi-native");
		}
		return streamOpts;
	};

	if (!parsed.stream) {
		try {
			for (let attempt = 0; attempt < attemptCap; attempt++) {
				if (controller.signal.aborted) return aborted();
				const picked = pickTarget();
				if (picked) return picked;
				const cred = await resolveCredential();
				if (cred.type === "retry") {
					bootOpts.storage.releaseTurnReservation(requestId);
					continue;
				}
				if (cred.type === "respond") return cred.response;
				const streamOpts = buildAttemptStreamOpts(cred.apiKey);
				logger.info("auth-gateway request", {
					requestId,
					format: "pi-native",
					model: parsed.modelId,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
					stream: parsed.stream,
					peer,
				});
				try {
					const message = await completeSimple(model, parsed.context, streamOpts);
					recordGatewayUsage(bootOpts.storage, model, client, message);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage =
							message.errorMessage ??
							(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
						logger.warn("auth-gateway non-streaming failed", {
							format: "pi-native",
							reason: message.stopReason,
							error: errorMessage,
							peer,
						});
						if (message.stopReason === "aborted") {
							return formatError(499, "request_aborted", errorMessage);
						}
						const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
						recordProviderHealthFailure(health, model, classified);
						if (messageHasBillableUsage(message)) {
							return formatError(classified.status, classified.type, errorMessage);
						}
						if (considerFallback(classified)) {
							bootOpts.storage.releaseTurnReservation(requestId);
							continue;
						}
						return formatError(classified.status, classified.type, errorMessage);
					}
					bootOpts.storage.settleQuotaProbeSuccess(requestId);
					rememberPromptCacheHit(cacheStore, body, requestId, model, sessionId);
					return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
				} catch (error) {
					if (controller.signal.aborted) return aborted();
					const classified = classifyGatewayError(error);
					logger.warn("auth-gateway non-streaming aborted", {
						format: "pi-native",
						error: classified.message,
						peer,
					});
					if (considerFallback(classified)) {
						bootOpts.storage.releaseTurnReservation(requestId);
						continue;
					}
					return classifiedError(classified);
				}
			}
			if (lastClassified) return classifiedError(lastClassified);
			return formatError(502, "upstream_error", "Upstream request failed");
		} finally {
			bootOpts.storage.releaseTurnReservation(requestId);
		}
	}

	for (let attempt = 0; attempt < attemptCap; attempt++) {
		if (controller.signal.aborted) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return aborted();
		}
		const picked = pickTarget();
		if (picked) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return picked;
		}
		const cred = await resolveCredential();
		if (cred.type === "retry") {
			bootOpts.storage.releaseTurnReservation(requestId);
			continue;
		}
		if (cred.type === "respond") {
			bootOpts.storage.releaseTurnReservation(requestId);
			return cred.response;
		}
		const streamOpts = buildAttemptStreamOpts(cred.apiKey);
		logger.info("auth-gateway request", {
			requestId,
			format: "pi-native",
			model: parsed.modelId,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			stream: parsed.stream,
			peer,
		});
		let events: AssistantMessageEventStream;
		try {
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
			if (considerFallback(classified)) {
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		const settled = events.result();
		void settled.then(message => recordGatewayUsage(bootOpts.storage, model, client, message)).catch(() => {});
		let sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		const held = await holdSseUntilCommit(sseStream, commitGate, settled);
		if (held.type === "failed") {
			if (held.message && messageHasBillableUsage(held.message)) {
				const errorMessage =
					held.message.errorMessage ??
					(held.message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (held.message.stopReason === "aborted") {
					bootOpts.storage.releaseTurnReservation(requestId);
					return formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(held.message.errorClassificationMessage ?? errorMessage);
				recordProviderHealthFailure(health, model, classified);
				bootOpts.storage.releaseTurnReservation(requestId);
				return formatError(classified.status, classified.type, errorMessage);
			}
			const classified = classifyGatewayError(
				held.message?.errorClassificationMessage ?? held.message?.errorMessage ?? held.error,
			);
			logger.warn("auth-gateway stream attempt failed before commit", {
				format: "pi-native",
				error: classified.message,
				peer,
			});
			if (considerFallback(classified)) {
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (controller.signal.aborted) {
			bootOpts.storage.releaseTurnReservation(requestId);
			return aborted();
		}
		sseStream = releaseTurnOnStreamEnd(held.stream, bootOpts.storage, requestId, commitGate);
		rememberPromptCacheHit(cacheStore, body, requestId, model, sessionId);
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	}
	bootOpts.storage.releaseTurnReservation(requestId);
	if (lastClassified) return classifiedError(lastClassified);
	return formatError(502, "upstream_error", "Upstream request failed");
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

/**
 * Row shape for `GET /v1/models`. Beyond the OpenAI-standard `id`/`object`/
 * `owned_by`, rows advertise the catalog metadata OpenAI-compatible clients
 * (omp's own proxy discovery, Zed's openai_compatible provider, ...) read to
 * size and capability-gate discovered models: `context_length`,
 * `max_output_tokens`, `input_modalities`, and `supports_tools` (only emitted
 * when the catalog explicitly reports `false`; absent means usable).
 */
interface ModelListRow {
	id: string;
	object: "model";
	owned_by: string;
	api: Api;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const seen = new Set<string>();
	const data: ModelListRow[] = [];
	for (const model of opts.listModels?.() ?? []) {
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const row: ModelListRow = {
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
			display_name: model.name,
			input_modalities: model.input,
		};
		if (model.contextWindow != null) row.context_length = model.contextWindow;
		if (model.maxTokens != null) row.max_output_tokens = model.maxTokens;
		if (model.supportsTools === false) row.supports_tools = false;
		data.push(row);
	}
	return json(200, { object: "list", data });
}

interface RouteListRow {
	id: string;
	generation: number;
	targets: readonly string[];
	fallbacks: CompiledRoute["fallbacks"];
}

function handleRoutesList(registry: RouteRegistry): Response {
	const data: RouteListRow[] = [];
	for (const route of registry.list()) {
		data.push({
			id: route.id,
			generation: route.generation,
			targets: route.targets,
			fallbacks: route.fallbacks,
		});
	}
	return json(200, { object: "list", generation: registry.generation, data });
}

function handleRouteGet(registry: RouteRegistry, id: string): Response {
	const route = registry.get(id);
	if (!route) {
		return json(404, { error: `Unknown route: ${id}` });
	}
	const row: RouteListRow = {
		id: route.id,
		generation: route.generation,
		targets: route.targets,
		fallbacks: route.fallbacks,
	};
	return json(200, row);
}

async function handleRoutePut(registry: RouteRegistry, id: string, req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}

	try {
		if (isRecord(body) && Object.hasOwn(body, "id")) {
			if (body.id !== id) {
				throw new AIError.ValidationError(`Route definition id must equal path id "${id}"`);
			}
		} else if (isRecord(body)) {
			body = { ...body, id };
		}
		const definition = parseRouteDefinition(body);
		registry.register(definition);
	} catch (error) {
		if (error instanceof AIError.ValidationError) {
			return json(400, { error: error.message });
		}
		throw error;
	}
	return handleRouteGet(registry, id);
}

function handleRouteDelete(registry: RouteRegistry, id: string): Response {
	if (!registry.unregister(id)) {
		return json(404, { error: `Unknown route: ${id}` });
	}
	return new Response(null, { status: 204 });
}

function handleExecutionTraces(traces: RouteDecisionTraceLog, id: string): Response {
	const recorded = traces.get(id);
	if (recorded.length === 0) {
		return json(404, { error: `Unknown execution: ${id}` });
	}
	const data: RouteDecisionTrace[] = [];
	for (const trace of recorded) {
		const row: RouteDecisionTrace = {
			requestId: trace.requestId,
			routeId: trace.routeId,
			generation: trace.generation,
			selectedTarget: trace.selectedTarget,
			disposition: trace.disposition,
			recordedAtMs: trace.recordedAtMs,
		};
		if (trace.reason !== undefined) row.reason = trace.reason;
		data.push(row);
	}
	return json(200, { object: "list", data });
}

interface HealthRouteRow {
	id: string;
	generation: number;
	targets: readonly string[];
}

function handleHealthRoutes(registry: RouteRegistry): Response {
	const data: HealthRouteRow[] = [];
	for (const route of registry.list()) {
		data.push({
			id: route.id,
			generation: route.generation,
			targets: route.targets,
		});
	}
	return json(200, { object: "list", generation: registry.generation, data });
}

interface CredentialListRow {
	id: number;
	provider: string;
	type: "api_key" | "oauth";
}

function handleCredentialsList(storage: AuthStorage): Response {
	const data: CredentialListRow[] = [];
	for (const entry of storage.exportSnapshot().credentials) {
		data.push({
			id: entry.id,
			provider: entry.provider,
			type: entry.credential.type,
		});
	}
	return json(200, { object: "list", data });
}

function handleCredentialDisable(storage: AuthStorage, id: string): Response {
	if (!storage.disableCredentialById(Number(id), "gateway")) {
		return json(404, { error: `No credential with id=${id}` });
	}
	return json(200, { ok: true });
}

async function handleCredentialPin(storage: AuthStorage, id: string, req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}
	if (!isRecord(body) || typeof body.provider !== "string" || typeof body.sessionId !== "string") {
		return json(400, { error: "provider and sessionId are required" });
	}
	if (body.provider.length === 0 || body.sessionId.length === 0) {
		return json(400, { error: "provider and sessionId are required" });
	}
	if (!storage.pinSessionOAuthAccount(body.provider, body.sessionId, Number(id))) {
		return json(404, { error: `No credential with id=${id}` });
	}
	return json(200, { ok: true });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const registry = opts.routeRegistry ?? new RouteRegistry(opts.resolveModel);
	for (const def of opts.routes ?? []) registry.register(def);
	const traces = opts.decisionTraces ?? new RouteDecisionTraceLog();
	const health = new ProviderHealthBook();
	const cacheStore = new PromptCacheAffinityStore();
	const boot: AuthGatewayBootOptions = {
		...opts,
		routeRegistry: registry,
		decisionTraces: traces,
	};
	const bind = parseBind(boot.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(boot.bearerTokens);
	const version = boot.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(boot.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(boot.storage, req.signal), req);
				}
				if (req.method === "GET" && pathname === "/v1/credentials") {
					return withCors(handleCredentialsList(boot.storage), req);
				}
				const credentialAction = /^\/v1\/credentials\/([^/]+)\/(disable|pin)$/.exec(pathname);
				if (req.method === "POST" && credentialAction) {
					const credentialId = credentialAction[1]!;
					if (credentialAction[2] === "disable") {
						return withCors(handleCredentialDisable(boot.storage, credentialId), req);
					}
					return withCors(await handleCredentialPin(boot.storage, credentialId, req), req);
				}

				if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
					return withCors(await handleCountTokens(req, boot.resolveModel), req);
				}
				if (req.method === "POST" && (pathname === "/v1/realtime" || pathname === "/v1/audio/speech")) {
					return withCors(json(501, { error: "not available on this gateway" }), req);
				}
				if (req.method === "POST" && pathname === "/v1/images/generations") {
					return withCors(await handleImageGeneration(req), req);
				}
				// Provider-format dispatch.
				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return withCors(await handleFormatEndpoint(formatRoute, boot, req, peer, health, cacheStore), req);
				}

				// Pi-native fast path. Same auth + provider plumbing as the
				// foreign-wire routes, just without the wire-format translation.
				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(boot, req, peer, health, cacheStore), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(boot), req);
				}

				// Virtual routes — registered ids only, not catalog models.
				if (req.method === "GET" && pathname === "/v1/routes") {
					return withCors(handleRoutesList(registry), req);
				}
				if (req.method === "GET" && pathname.startsWith("/v1/routes/")) {
					const id = pathname.slice("/v1/routes/".length);
					if (id.length === 0) {
						return withCors(handleRoutesList(registry), req);
					}
					return withCors(handleRouteGet(registry, id), req);
				}
				if (req.method === "PUT" && pathname.startsWith("/v1/routes/")) {
					const id = pathname.slice("/v1/routes/".length);
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: PUT ${pathname}` }), req);
					}
					return withCors(await handleRoutePut(registry, id, req), req);
				}
				if (req.method === "DELETE" && pathname.startsWith("/v1/routes/")) {
					const id = pathname.slice("/v1/routes/".length);
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: DELETE ${pathname}` }), req);
					}
					return withCors(handleRouteDelete(registry, id), req);
				}
				if (req.method === "GET" && pathname === "/v1/health/routes") {
					return withCors(handleHealthRoutes(registry), req);
				}
				if (req.method === "GET" && pathname.startsWith("/v1/executions/")) {
					const id = pathname.slice("/v1/executions/".length);
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: GET ${pathname}` }), req);
					}
					return withCors(handleExecutionTraces(traces, id), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			server.stop(true);
		},
	};
}
