import {
	type ApiKeyResolution,
	type ApiKeyResolver,
	createOAuthProvenance,
	markAfterRemint,
	markAfterSiblingWait,
	resolvedCredentialGeneration,
} from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isUsageLimitOutcome } from "@oh-my-pi/pi-ai/error/rate-limit";
import type { AuthApiKeyOptions, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
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

/** Registry-only recovery state; never forwarded to the durable credential store. */
export interface ApiKeyResolverRequestOptions extends AuthApiKeyOptions {
	invalidateOtherCommandConfigs?: boolean;
}

/**
 * Minimal slice of `ModelRegistry` the resolver needs. Typed structurally so
 * narrower registry shells (e.g. the commit pipeline's `CommitModelRegistry`)
 * can build resolvers without depending on the full class.
 */
export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
	/** Resolve the bearer and durable credential row identity, when available. */
	getApiKeyWithCredentialForProvider(
		provider: string,
		sessionId?: string,
		options?: ApiKeyResolverRequestOptions,
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
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyWithCredentialForProvider" | "authStorage">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId } = options;
	// One resolver serves many requests, and they fail out of order, so the
	// token a 401 rejected is looked up from the bearer that request sent.
	const provenance = createOAuthProvenance();
	const resolveKey = async (
		forceRefresh: boolean | undefined,
		recovery?: Pick<
			ApiKeyResolverRequestOptions,
			| "signal"
			| "refreshReason"
			| "rejectedAccessToken"
			| "rejectedCredentialGeneration"
			| "invalidateOtherCommandConfigs"
		>,
	): Promise<ApiKeyResolution> => {
		const resolved = await registry.getApiKeyWithCredentialForProvider(provider, sessionId, {
			baseUrl,
			modelId,
			forceRefresh,
			...recovery,
		});
		provenance.record(resolved);
		return resolved;
	};
	return async ({ lastChance, error, signal, previousKey, previousGeneration }) => {
		const rejectedAccessToken = provenance.accessFor(previousKey);
		if (error === undefined) {
			return resolveKey(undefined);
		}
		const verdict = AIError.credentialRejectionVerdict(error);
		const credentialRefused = AIError.isCredentialRejection(verdict);
		if (lastChance) {
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor the failed account's retry-after
			// here — if a sibling exists we switch immediately, and `rotate` itself
			// sleeps out a sibling block that clears within seconds. Longer
			// no-sibling backoff is owned by `markUsageLimitReached` (default +
			// server usage-report reset) and the outer whole-turn retry layer.
			const rotation = await registry.authStorage.limits.rotate(provider, sessionId, {
				error,
				modelId,
				signal,
				apiKey: previousKey,
			});
			if (!rotation.switched) {
				const status = AIError.status(error);
				const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
				// No sibling for an account-quota failure: stop so the outer
				// whole-turn retry layer can honor the recorded backoff. A hard
				// auth decline can instead mean a peer refreshed the bearer.
				if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
			}
			// Record the exhausted attempt without spending a mint it cannot use.
			const resolved = await resolveKey(undefined, {
				invalidateOtherCommandConfigs: credentialRefused,
				rejectedCredentialGeneration: credentialRefused ? previousGeneration : undefined,
			});
			return rotation.afterSiblingWait ? markAfterSiblingWait(resolved) : resolved;
		}
		// Step (b): the credential itself may be the problem, so re-mint it and
		// let the driver try once more. A 401 whose own structured error class
		// says it is NOT an authentication failure is the one case that skips
		// the re-mint: refreshing cannot help, and a `!command` credential's
		// re-mint is a call to its issuer.
		const resolved = await resolveKey(verdict !== "not-credential", {
			signal,
			refreshReason: AIError.status(error) === 401 ? "auth-recovery" : undefined,
			rejectedAccessToken,
			// The generation of the credential this request sent. A `!command`
			// credential's re-mint reads it to tell a refusal of the mint it has
			// cached from a refusal of an older one, which that mint answers.
			rejectedCredentialGeneration: credentialRefused ? previousGeneration : undefined,
		});
		// A credential was actually minted for this refusal — the slot's
		// generation advanced past the one the request sent. The retry is worth
		// making even when the mint handed back the same bytes: what the request
		// has not tried is a credential minted after that refusal, and the bytes
		// do not say whether the issuer renewed it. An explicit refusal can also
		// retry a command-backed resolution without a prior generation. Static
		// keys get no same-byte exemption: invalidating caches did not mint them.
		const generation = resolvedCredentialGeneration(resolved);
		const minted = previousGeneration !== undefined && (generation ?? previousGeneration) > previousGeneration;
		return minted || (generation !== undefined && AIError.statesCredentialRejection(verdict))
			? markAfterRemint(resolved)
			: resolved;
	};
}
