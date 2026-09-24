import type { ApiKeyResolution, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isUsageLimitOutcome } from "@oh-my-pi/pi-ai/error/rate-limit";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";

/** Model slice accepted by the model-form `resolver(model, sessionId)` overload. */
export type ApiKeyResolverModel = Pick<Model<Api>, "provider" | "baseUrl" | "id">;

export interface ApiKeyResolverOptions {
	/** Session id for credential stickiness; read at resolve time by the caller. */
	sessionId?: string;
	/** Provider base URL hint forwarded to the auth-storage cascade. */
	baseUrl?: string;
	/** Provider model id forwarded to model-scoped usage ranking/backoff. */
	modelId?: string;
}

/**
 * Minimal slice of `ModelRegistry` the resolver needs. Typed structurally so
 * narrower registry shells (e.g. the commit pipeline's `CommitModelRegistry`)
 * can build resolvers without depending on the full class.
 */
export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined>;
	/** Available on the full registry; structural shells may only resolve bare keys. */
	getApiKeyWithCredentialForProvider?(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<ApiKeyResolution>;
	authStorage: Pick<AuthStorage, "limits">;
	/**
	 * Build an {@link ApiKeyResolver} implementing the central a/b/c auth-retry
	 * policy: initial → resolve; step (b) → force-refresh same account; step (c)
	 * → rotate to a sibling and re-resolve, unless quota exhaustion has no sibling.
	 *
	 * Two call forms: `resolver(provider, options?)` for provider-scoped keys,
	 * and `resolver(model, sessionId?)` which derives `baseUrl`/`modelId` from
	 * the model. The resolver is stateless (safe to reuse across requests).
	 * Callers that need the initial key for a guard can call
	 * `resolveApiKeyOnce(resolver)`.
	 */
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
}

/**
 * Default implementation of {@link ApiKeyResolverRegistry.resolver}.
 * Also usable standalone for structural registries that don't carry the method.
 */
export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyForProvider" | "authStorage">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId } = options;
	const resolveKey = (forceRefresh: boolean | undefined, signal?: AbortSignal): Promise<ApiKeyResolution> =>
		registry.getApiKeyWithCredentialForProvider
			? registry.getApiKeyWithCredentialForProvider(provider, sessionId, { baseUrl, modelId, forceRefresh, signal })
			: registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId, forceRefresh, signal });
	return async ({ lastChance, error, signal, previousKey }) => {
		if (error === undefined) {
			return resolveKey(undefined);
		}
		if (lastChance) {
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor any retry-after here — if a
			// sibling exists we switch immediately; the precise no-sibling backoff
			// is owned by `markUsageLimitReached` (default + server usage-report
			// reset) and the outer whole-turn retry layer.
			const switched = await registry.authStorage.limits.rotate(provider, sessionId, {
				error,
				modelId,
				signal,
				apiKey: previousKey,
			});
			if (!switched) {
				const status = AIError.status(error);
				const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
				// No sibling for an account-quota failure: stop so the outer
				// whole-turn retry layer can honor the recorded backoff. A hard
				// auth decline can instead mean a peer refreshed the bearer.
				if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
			}
			return resolveKey(undefined);
		}
		return resolveKey(true, signal);
	};
}
