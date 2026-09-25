/**
 * Per-request plumbing shared by every auth-gateway route.
 *
 * A route module (`server.ts` chat/pi-native handlers, `routes/*.ts` for
 * judgments, images, speech, transcription, …) owns only its wire format:
 * parse the body, pick a model, call the pi-ai client, encode the reply.
 * Everything credential-shaped lives here so each route drives the same
 * broker-backed rotation policy and the same usage ledger.
 */
import { $env, extractHttpStatusFromError, logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthApiKeyOptions, AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import { isUsageLimitOutcome } from "../error/rate-limit";
import type { Api, FetchImpl, Model, Usage } from "../types";
import type { ClientUsageIdentity } from "../usage";
import { extractProviderRetryHint } from "../utils/retry-after";
import type { AuthGatewayServerOptions } from "./types";

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
	/** Upstream transport for every provider call; defaults to global `fetch`. Test seam. */
	fetch?: FetchImpl;
}

/**
 * The client's own session key, or `undefined` when it sent none. A blank key
 * counts as none: honouring it would collapse every caller that sends an empty
 * key into one shared credential-sticky, prefix-cache and provider-session
 * bucket.
 */
export function normalizeClientSessionKey(clientKey: string | undefined): string | undefined {
	return clientKey !== undefined && clientKey.trim().length > 0 ? clientKey : undefined;
}

/**
 * Stable identity of the account a request's credential belongs to.
 *
 * `markUsageLimitReached` and the auth-retry resolver switch a session to a
 * sibling credential, so the provider state retained for that session can
 * outlive the account that taught it. OAuth rows expose an account id / email
 * that survives token refresh — fingerprinting the bearer instead would look
 * like a rotation every time a token refreshes and discard the retained
 * lessons for nothing. Key-based rows fall back to a hash of the key, never
 * the key itself: this value is held for the lifetime of the entry.
 */
export function resolveGatewayAccount(
	storage: AuthStorage,
	provider: string,
	sessionId: string,
	apiKey: string,
): string {
	const identity = storage.oauth.identity(provider, sessionId);
	if (identity) {
		return `oauth:${JSON.stringify([
			identity.accountId ?? "",
			identity.email ?? "",
			identity.projectId ?? "",
			identity.orgId ?? "",
		])}`;
	}
	return `key:${Bun.hash(apiKey).toString(36)}`;
}

/**
 * Resolve the credential for one request from broker-backed storage.
 *
 * pi-ai clients never consult `AuthStorage`; the gateway resolves the bearer
 * (an OAuth access token refreshed through the broker when needed) and hands
 * it to the client. Returns the key, or the error classification the route
 * should encode in its own envelope: storage failures map through
 * {@link classifyGatewayError}, a provider without any credential is a 401.
 */
export async function resolveGatewayApiKey(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
): Promise<string | GatewayErrorClassification> {
	let apiKey: string | undefined;
	try {
		apiKey = await storage.keys.get(model.provider, sessionId, modelKeyOptions(model, signal));
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return classified;
	}
	if (apiKey) return apiKey;
	return {
		status: 401,
		type: "authentication_error",
		message: `No credential available for provider ${model.provider}`,
	};
}

/**
 * Hook fired by a pi-ai client when the upstream request fails in a way
 * that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.limits.markReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.limits.invalidateMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so the client can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
/**
 * Default cooldown for Cursor credentials that fail with a non-usage-limit
 * auth error in the gateway path. Cursor 401s are often temporary token
 * expiries; a short cooldown lets the OAuth refresh fix the token while a
 * sibling credential handles traffic. Overridable via
 * `CURSOR_GATEWAY_COOLDOWN_MS` env var.
 */
const CURSOR_GATEWAY_DEFAULT_COOLDOWN_MS = 60_000;

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
): Promise<string | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	const status = extractHttpStatusFromError(error);
	if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
		const retryAfterMs = extractProviderRetryHint(provider, message);
		const { switched, retryAtMs } = await storage.limits.markReached(provider, sessionId, {
			retryAfterMs,
			providerTimed: retryAfterMs !== undefined,
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
		return storage.keys.get(provider, sessionId, modelKeyOptions(model, signal));
	}
	// Cursor auth failures are often temporary token expiries rather than
	// permanently bad credentials. Apply a short cooldown (default 60s) so the
	// OAuth refresh has a chance to fix the token while a sibling credential
	// handles traffic. Only fall through to permanent invalidation when no
	// sibling is available.
	if (provider === "cursor") {
		const rawCooldown = $env.CURSOR_GATEWAY_COOLDOWN_MS;
		const parsedCooldown = rawCooldown !== undefined && rawCooldown !== "" ? Number(rawCooldown) : undefined;
		const cooldownMs =
			parsedCooldown !== undefined && Number.isFinite(parsedCooldown) && parsedCooldown >= 0
				? parsedCooldown
				: CURSOR_GATEWAY_DEFAULT_COOLDOWN_MS;
		const { switched, retryAtMs } = await storage.limits.markReached(provider, sessionId, {
			retryAfterMs: cooldownMs,
			providerTimed: true,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying cursor credential after cooldown block", {
			format,
			provider,
			peer,
			switched,
			cooldownMs,
			retryAtMs,
			error: message,
		});
		if (switched) {
			return storage.keys.get(provider, sessionId, modelKeyOptions(model, signal));
		}
		// No sibling available — fall through to invalidation so the next
		// request re-resolves from scratch after the cooldown expires.
	}
	await storage.limits.invalidateMatching(provider, oldKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	return storage.keys.get(provider, sessionId, modelKeyOptions(model, signal));
}

/** Model-scoped key options: usage ranking by model id, routing to accounts discovery saw serve it. */
function modelKeyOptions(model: Model<Api>, signal: AbortSignal): AuthApiKeyOptions {
	return { modelId: model.id, accountIds: model.accountAccess && Object.keys(model.accountAccess), signal };
}

/**
 * Build the {@link ApiKeyResolver} handed to a pi-ai client for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed. `onResolvedKey` observes every rotation;
 * routes that retain provider session state use it to re-key the account
 * lease, one-shot routes pass `undefined`.
 */
export function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: string,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	onResolvedKey?: (apiKey: string) => void,
): ApiKeyResolver {
	let lastKey = initialKey;
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey;
			return initialKey;
		}
		if (!lastChance) {
			const refreshed = await storage.keys.get(model.provider, sessionId, {
				...modelKeyOptions(model, sig),
				forceRefresh: true,
			});
			lastKey = refreshed ?? lastKey;
			if (refreshed) onResolvedKey?.(refreshed);
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
		);
		lastKey = next ?? lastKey;
		if (next) onResolvedKey?.(next);
		return next;
	};
}

/**
 * Attribute one settled upstream request to the originating client via the
 * broker's observed-usage channel (`AuthStorage.usage.observe`, batched
 * by the remote store). Error/aborted turns still record — the provider
 * billed whatever tokens the partial turn consumed; zero-usage results
 * (pre-flight failures) are skipped. `at` defaults to now.
 */
export function recordGatewayUsage(
	storage: AuthStorage,
	model: Model<Api>,
	client: ClientUsageIdentity,
	usage: Usage,
	at?: number,
): void {
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
	storage.usage.observe({
		provider: model.provider,
		model: model.id,
		at,
		usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		costUsd: usage.cost.total,
		client,
	});
}

/**
 * An `AbortController` that follows the inbound request's abort signal. Routes
 * abort it themselves when the response body is cancelled mid-stream, which
 * `req.signal` alone does not observe.
 */
export function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}
