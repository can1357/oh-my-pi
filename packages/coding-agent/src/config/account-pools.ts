import type { AuthApiKeyOptions, AuthStorage, SessionRestrictionLease } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import type { ModelRegistry } from "./model-registry";

/**
 * Provider id → OAuth identity keys one session may authenticate with; see
 * `AuthStorage.sessions.restrict`. A listed provider uses only those accounts
 * and never an API key; an empty list allows no account.
 */
export type OAuthAccountPools = Readonly<Record<string, readonly string[]>>;

/**
 * Validate the exact-agent `task.agentAccountPools` map (agent name → provider
 * id → identity keys). An absent or empty (`null`) mapping means no pools, and
 * a `null` agent entry clears one inherited from a lower-priority settings
 * layer. Any other malformed level fails settings load: dropping it would
 * silently widen a restricted agent to every account. Both levels are
 * null-prototype maps, so a name such as `__proto__` stays an own entry.
 */
export function validateAgentAccountPools(value: unknown): Record<string, OAuthAccountPools> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new Error(
			`Invalid task.agentAccountPools: expected a map of agent name to provider account pools, got ${Array.isArray(value) ? "an array" : `a ${typeof value}`}.`,
		);
	}
	const pools: Record<string, OAuthAccountPools> = Object.create(null);
	for (const [agentName, providers] of Object.entries(value)) {
		if (providers === null) continue;
		if (!isRecord(providers)) {
			throw new Error(
				`Invalid task.agentAccountPools.${agentName}: expected a map of provider to OAuth identity keys, got ${Array.isArray(providers) ? "an array" : `a ${typeof providers}`}.`,
			);
		}
		const agentPools: Record<string, readonly string[]> = Object.create(null);
		for (const [provider, identityKeys] of Object.entries(providers)) {
			if (
				!Array.isArray(identityKeys) ||
				!identityKeys.every((key): key is string => typeof key === "string" && key.length > 0 && key.trim() === key)
			) {
				throw new Error(
					`Invalid task.agentAccountPools.${agentName}.${provider}: expected a list of OAuth identity keys such as "email:you@example.com|org:<org-id>".`,
				);
			}
			agentPools[provider] = identityKeys;
		}
		pools[agentName] = agentPools;
	}
	return pools;
}

/** Unscoped registry behind each registry {@link SessionAccountPoolScope.registry} returned. */
const scopedRegistryTargets = new WeakMap<ModelRegistry, ModelRegistry>();

/**
 * One agent session's OAuth account pools, enforced at its key lookups.
 *
 * The registry from {@link registry} restricts every provider session id that
 * resolves a pooled provider's key through it before resolving, so requests
 * the session sends under ids it mints on the side (title generation, skill
 * compression, advisors, nested subagents) stay in the pool without each call
 * site opting in. A lookup without a session id resolves under the primary id
 * instead of falling back to the provider's unrestricted credentials.
 *
 * The scope holds the lease of every id it restricted; {@link release} lifts
 * them once the session can no longer resolve keys. A lease lifts only the
 * restriction it installed, so a restriction another session has installed on
 * the same id since, such as a revived session's, stays.
 */
export class SessionAccountPoolScope {
	readonly #authStorage: Pick<AuthStorage, "sessions">;
	readonly #pools: OAuthAccountPools;
	/** Provider id → restriction lease, by restricted provider session id. */
	readonly #leases = new Map<string, Map<string, SessionRestrictionLease>>();
	#primarySessionId: string;

	constructor(authStorage: Pick<AuthStorage, "sessions">, pools: OAuthAccountPools, primarySessionId: string) {
		this.#authStorage = authStorage;
		this.#pools = pools;
		this.#primarySessionId = primarySessionId;
		this.restrict(primarySessionId);
	}

	/** Restrict `sessionId` to the pools, once per id until {@link release}. */
	restrict(sessionId: string): void {
		if (this.#leases.has(sessionId)) return;
		const leases = new Map<string, SessionRestrictionLease>();
		for (const [provider, identityKeys] of Object.entries(this.#pools)) {
			leases.set(provider, this.#authStorage.sessions.restrict(provider, sessionId, identityKeys));
		}
		this.#leases.set(sessionId, leases);
	}

	/** Make `sessionId` the session's primary id: restricted, and the id for lookups that carry none. */
	adopt(sessionId: string): void {
		this.restrict(sessionId);
		this.#primarySessionId = sessionId;
	}

	/** Lift every restriction this scope installed. */
	release(): void {
		for (const [sessionId, leases] of this.#leases) {
			for (const [provider, lease] of leases) {
				this.#authStorage.sessions.unrestrict(provider, sessionId, lease);
			}
		}
		this.#leases.clear();
	}

	/** The session id a key lookup for `provider` resolves under, restricted first when pooled. */
	#sessionIdFor(provider: string, sessionId: string | undefined): string | undefined {
		if (!Object.hasOwn(this.#pools, provider)) return sessionId;
		const scopedSessionId = sessionId ?? this.#primarySessionId;
		this.restrict(scopedSessionId);
		return scopedSessionId;
	}

	/**
	 * `registry` with its key lookups (`getApiKey`, `getApiKeyForProvider`,
	 * `getApiKeyWithCredentialForProvider`, `getApiKeyAndHeaders`, `resolver`,
	 * `turnResolver`) routed through this scope. Every other member is the
	 * unscoped registry's, so model state, discovery, and caches stay shared. A
	 * registry another scope returned is unwrapped first: a nested agent with its
	 * own pools uses them, not its parent's.
	 */
	registry(registry: ModelRegistry): ModelRegistry {
		const target = scopedRegistryTargets.get(registry) ?? registry;
		const getApiKey = (model: Model<Api>, sessionId?: string, options?: { signal?: AbortSignal }) =>
			target.getApiKey(model, this.#sessionIdFor(model.provider, sessionId), options);
		const getApiKeyWithCredentialForProvider = (provider: string, sessionId?: string, options?: AuthApiKeyOptions) =>
			target.getApiKeyWithCredentialForProvider(provider, this.#sessionIdFor(provider, sessionId), options);
		const resolver = ((
			resolverTarget: string | ApiKeyResolverModel,
			optionsOrSessionId?: ApiKeyResolverOptions | string,
		) => {
			const options =
				typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : (optionsOrSessionId ?? {});
			const provider = typeof resolverTarget === "string" ? resolverTarget : resolverTarget.provider;
			return target.settleCommandKeyOnAbort(
				provider,
				createApiKeyResolver({ getApiKeyWithCredentialForProvider, authStorage: target.authStorage }, provider, {
					...options,
					...(typeof resolverTarget === "string"
						? {}
						: { baseUrl: resolverTarget.baseUrl, modelId: resolverTarget.id }),
					sessionId: this.#sessionIdFor(provider, options.sessionId),
				}),
			);
		}) as ModelRegistry["resolver"];
		const scoped: Partial<ModelRegistry> = {
			getApiKey,
			getApiKeyWithCredentialForProvider,
			getApiKeyForProvider: (provider, sessionId, options) =>
				target.getApiKeyForProvider(provider, this.#sessionIdFor(provider, sessionId), options),
			getApiKeyAndHeaders: async model => {
				try {
					const apiKey = await getApiKey(model);
					if (apiKey === undefined) {
						return { ok: false, error: `No API key found for "${model.provider}"` };
					}
					return { ok: true, apiKey, headers: await target.getProviderHeaders(model.provider) };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
			resolver,
			turnResolver: (model, sessionId) => target.failCommandKeyRetryably(model.provider, resolver(model, sessionId)),
		};
		// ModelRegistry keeps its state in #private fields, so every other member
		// runs against the target itself; bound methods are cached per name.
		const bound = new Map<PropertyKey, unknown>();
		const proxy = new Proxy(target, {
			get(object, property) {
				if (Object.hasOwn(scoped, property)) return scoped[property as keyof ModelRegistry];
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== "function") return value;
				let method = bound.get(property);
				if (method === undefined) {
					method = value.bind(object);
					bound.set(property, method);
				}
				return method;
			},
		});
		scopedRegistryTargets.set(proxy, target);
		return proxy;
	}
}
