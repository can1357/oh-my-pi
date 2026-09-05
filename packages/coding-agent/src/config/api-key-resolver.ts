import { type Api, type ApiKeyResolver, type AuthStorage, isUsageLimitOutcome, type Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";

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
	authStorage: Pick<AuthStorage, "rotateSessionCredential">;
	/**
	 * Advance a list-form config apiKey (`models.yml`
	 * `providers.<name>.apiKey`) to its next element. Optional so narrower
	 * registry shells without key lists keep stored-only rotation.
	 */
	cycleProviderApiKey?(provider: string): boolean;
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
 * Process-wide per-provider locks serializing the failure-recovery compound
 * (advance the config key list, then re-resolve) below. Owned here:
 * {@link ApiKeyResolverRegistry} is structural, so a registry shell may
 * resolve asynchronously — back-to-back failures would otherwise both advance
 * and then both re-resolve the same final key, skipping a sibling without
 * ever trying it. The initial (`error === undefined`) resolve bypasses the
 * lock: only failure recovery mutates the cursor, so steady-state requests
 * stay concurrent.
 */
const providerCycleLocks = new Map<string, Promise<void>>();

function serializeProviderCycle<T>(provider: string, task: () => Promise<T>): Promise<T> {
	const prior = providerCycleLocks.get(provider) ?? Promise.resolve();
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	const chained = prior.then(() => gate);
	providerCycleLocks.set(provider, chained);
	return prior.then(task).finally(() => {
		release();
		if (providerCycleLocks.get(provider) === chained) providerCycleLocks.delete(provider);
	});
}

/**
 * Default implementation of {@link ApiKeyResolverRegistry.resolver}.
 * Also usable standalone for structural registries that don't carry the method.
 */
export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyForProvider" | "authStorage" | "cycleProviderApiKey">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId } = options;
	return async ({ lastChance, error, signal, previousKey }) => {
		if (error === undefined) {
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId });
		}
		if (lastChance) {
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor any retry-after here — if a
			// sibling exists we switch immediately; the precise no-sibling backoff
			// is owned by `markUsageLimitReached` (default + server usage-report
			// reset) and the outer whole-turn retry layer.
			const switched = await registry.authStorage.rotateSessionCredential(provider, sessionId, {
				error,
				modelId,
				signal,
				apiKey: previousKey,
			});
			if (!switched) {
				const status = AIError.status(error);
				const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
				// No sibling for an account-quota failure: stop so the outer
				// whole-turn retry layer can honor the recorded backoff — unless
				// a config key list has a usable sibling, which takes over
				// immediately instead of waiting out the blocked key. A hard
				// auth decline can instead mean a peer refreshed the bearer.
				if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
					return serializeProviderCycle(provider, async () => {
						if (registry.cycleProviderApiKey?.(provider) ?? false) {
							return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId });
						}
						return undefined;
					});
				}
			}
			// A pinned config key list shadows the stored pool, so rotating
			// stored rows alone never changes the effective key — advance the
			// list (no-op without one) so the re-resolve hands out the next
			// sibling. One attempt per sibling is enforced downstream by the
			// already-attempted key set.
			return serializeProviderCycle(provider, async () => {
				registry.cycleProviderApiKey?.(provider);
				return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId });
			});
		}
	// A failed list key is dead for this operation while a force-refreshed
	// single key may have been re-minted, so advance past the failure before
	// re-resolving (no-op without a list). The central loop still caps the
	// operation: one refresh-same plus one lastChance rotation.
	return serializeProviderCycle(provider, async () => {
		registry.cycleProviderApiKey?.(provider);
		return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
	});
	};
}
