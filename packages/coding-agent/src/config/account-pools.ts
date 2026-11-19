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

/** Named top-level session pools from `auth.sessionAccountPools`. */
export type SessionAccountPools = Readonly<Record<string, OAuthAccountPools>>;

function valueKind(value: unknown): string {
	return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Validate and copy one provider → OAuth identity-key map without prototype setters. */
function validateOAuthAccountPools(value: unknown, settingPath: string): OAuthAccountPools {
	if (!isRecord(value)) {
		throw new Error(
			`Invalid ${settingPath}: expected a map of provider to OAuth identity keys, got ${valueKind(value)}.`,
		);
	}
	const pools: Record<string, readonly string[]> = Object.create(null);
	for (const [provider, identityKeys] of Object.entries(value)) {
		if (provider.length === 0 || provider.trim() !== provider) {
			throw new Error(`Invalid ${settingPath}: provider ids must be non-empty without surrounding whitespace.`);
		}
		if (
			!Array.isArray(identityKeys) ||
			!identityKeys.every((key): key is string => typeof key === "string" && key.length > 0 && key.trim() === key)
		) {
			throw new Error(
				`Invalid ${settingPath}.${provider}: expected a list of OAuth identity keys such as "email:you@example.com|org:<org-id>".`,
			);
		}
		pools[provider] = identityKeys;
	}
	return pools;
}

/**
 * Validate and copy named top-level session pools. Invalid entries fail closed
 * rather than silently widening a session to every OAuth account.
 */
export function validateSessionAccountPools(value: unknown): SessionAccountPools {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new Error(
			`Invalid auth.sessionAccountPools: expected a map of pool name to provider account pools, got ${valueKind(value)}.`,
		);
	}
	const namedPools: Record<string, OAuthAccountPools> = Object.create(null);
	for (const [name, providers] of Object.entries(value)) {
		if (name.length === 0 || name.trim() !== name) {
			throw new Error(
				"Invalid auth.sessionAccountPools: pool names must be non-empty without surrounding whitespace.",
			);
		}
		namedPools[name] = validateOAuthAccountPools(providers, `auth.sessionAccountPools.${name}`);
	}
	return namedPools;
}

/** Resolve one explicitly selected named pool. */
export function resolveSessionAccountPool(value: unknown, name: string): OAuthAccountPools | undefined {
	const namedPools = validateSessionAccountPools(value);
	return Object.hasOwn(namedPools, name) ? namedPools[name] : undefined;
}

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
			`Invalid task.agentAccountPools: expected a map of agent name to provider account pools, got ${valueKind(value)}.`,
		);
	}
	const pools: Record<string, OAuthAccountPools> = Object.create(null);
	for (const [agentName, providers] of Object.entries(value)) {
		if (providers === null) continue;
		pools[agentName] = validateOAuthAccountPools(providers, `task.agentAccountPools.${agentName}`);
	}
	return pools;
}

/** Unscoped registry behind each registry {@link SessionAccountPoolScope.registry} returned. */
const scopedRegistryTargets = new WeakMap<ModelRegistry, ModelRegistry>();

export interface SessionAccountPoolScopeOptions {
	/** Treat providers absent from the pool map as deny-all instead of unrestricted. */
	denyUnlistedProviders?: boolean;
}

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
	readonly #pools: Record<string, string[]>;
	/** Logical session id → provider id → identities added through `/login`. */
	readonly #additions = new Map<string, Map<string, string[]>>();
	/** Logical session id → provider id → hard-pinned identity. */
	readonly #pins = new Map<string, Map<string, string>>();
	/** Provider session id → logical session id that owns it. */
	readonly #owners = new Map<string, string>();
	readonly #denyUnlistedProviders: boolean;
	/** Provider id → restriction lease, by restricted provider session id. */
	readonly #leases = new Map<string, Map<string, SessionRestrictionLease>>();
	#primarySessionId: string;

	constructor(
		authStorage: Pick<AuthStorage, "sessions">,
		pools: OAuthAccountPools,
		primarySessionId: string,
		options: SessionAccountPoolScopeOptions = {},
	) {
		this.#authStorage = authStorage;
		this.#pools = Object.create(null);
		for (const [provider, identityKeys] of Object.entries(pools)) {
			this.#pools[provider] = [...identityKeys];
		}
		this.#denyUnlistedProviders = options.denyUnlistedProviders ?? false;
		this.#primarySessionId = primarySessionId;
		this.#owners.set(primarySessionId, primarySessionId);
		this.restrict(primarySessionId);
	}

	/** Restrict `sessionId` to the pools, once per id until {@link release}. */
	restrict(sessionId: string): void {
		if (this.#leases.has(sessionId)) return;
		if (!this.#owners.has(sessionId)) this.#owners.set(sessionId, this.#primarySessionId);
		const owner = this.#owner(sessionId);
		const leases = new Map<string, SessionRestrictionLease>();
		for (const provider of Object.keys(this.#pools)) {
			leases.set(
				provider,
				this.#authStorage.sessions.restrict(provider, sessionId, this.#identities(provider, owner)),
			);
		}
		for (const provider of this.#additions.get(owner)?.keys() ?? []) {
			if (!leases.has(provider)) {
				leases.set(
					provider,
					this.#authStorage.sessions.restrict(provider, sessionId, this.#identities(provider, owner)),
				);
			}
		}
		this.#leases.set(sessionId, leases);
	}

	/** Restrict one provider for `sessionId`, including deny-all for an unlisted provider in exclusive mode. */
	restrictProvider(sessionId: string, provider: string): void {
		this.restrict(sessionId);
		const leases = this.#leases.get(sessionId);
		if (!leases || leases.has(provider)) return;
		const owner = this.#owner(sessionId);
		const scoped =
			Object.hasOwn(this.#pools, provider) ||
			this.#additions.get(owner)?.has(provider) === true ||
			this.#pins.get(owner)?.has(provider) === true;
		if (!scoped && !this.#denyUnlistedProviders) return;
		leases.set(provider, this.#authStorage.sessions.restrict(provider, sessionId, this.#identities(provider, owner)));
	}

	/** Add an explicitly logged-in OAuth identity to one logical session without changing its saved pool. */
	allow(provider: string, identityKey: string, sessionId = this.#primarySessionId): boolean {
		const owner = this.#owner(sessionId);
		if (this.#allows(owner, provider, identityKey)) return false;
		let providers = this.#additions.get(owner);
		if (!providers) {
			providers = new Map();
			this.#additions.set(owner, providers);
		}
		const current = providers.get(provider) ?? [];
		providers.set(provider, [...current, identityKey]);
		this.#refreshProvider(owner, provider);
		return true;
	}

	/** Whether an identity belongs to one logical session's saved pool or `/login` additions. */
	allows(provider: string, identityKey: string, sessionId = this.#primarySessionId): boolean {
		return this.#allows(this.#owner(sessionId), provider, identityKey);
	}

	/** Hard-pin one selectable identity for one logical session and every provider id it owns. */
	pin(provider: string, identityKey: string, sessionId = this.#primarySessionId): boolean {
		const owner = this.#owner(sessionId);
		if (!this.#allows(owner, provider, identityKey)) return false;
		let providers = this.#pins.get(owner);
		if (!providers) {
			providers = new Map();
			this.#pins.set(owner, providers);
		}
		if (providers.get(provider) === identityKey) return true;
		providers.set(provider, identityKey);
		this.#refreshProvider(owner, provider);
		return true;
	}

	#owner(sessionId: string): string {
		return this.#owners.get(sessionId) ?? sessionId;
	}

	#allows(owner: string, provider: string, identityKey: string): boolean {
		return (
			this.#pools[provider]?.includes(identityKey) === true ||
			this.#additions.get(owner)?.get(provider)?.includes(identityKey) === true
		);
	}

	#identities(provider: string, owner: string): readonly string[] {
		const pinned = this.#pins.get(owner)?.get(provider);
		if (pinned) return [pinned];
		const pool = this.#pools[provider] ?? [];
		const additions = this.#additions.get(owner)?.get(provider);
		if (!additions || additions.length === 0) return pool;
		if (pool.length === 0) return additions;
		return [...pool, ...additions];
	}

	#refreshProvider(owner: string, provider: string): void {
		const identityKeys = this.#identities(provider, owner);
		for (const [sessionId, leases] of this.#leases) {
			if (this.#owner(sessionId) !== owner) continue;
			const previous = leases.get(provider);
			const lease = this.#authStorage.sessions.restrict(provider, sessionId, identityKeys);
			if (previous) this.#authStorage.sessions.unrestrict(provider, sessionId, previous);
			leases.set(provider, lease);
		}
	}

	/** Whether this scope permits a stored OAuth credential for `provider`. */
	permits(provider: string, sessionId: string, credentialId: number): boolean {
		this.restrictProvider(sessionId, provider);
		return this.#authStorage.sessions.permits(provider, sessionId, credentialId);
	}

	/** Make `sessionId` the logical session's primary id without inheriting the previous session's additions or pins. */
	adopt(sessionId: string): void {
		this.#primarySessionId = sessionId;
		this.#owners.set(sessionId, sessionId);
		this.restrict(sessionId);
	}

	/** Lift every restriction this scope installed. */
	release(): void {
		for (const [sessionId, leases] of this.#leases) {
			for (const [provider, lease] of leases) {
				this.#authStorage.sessions.unrestrict(provider, sessionId, lease);
			}
		}
		this.#leases.clear();
		this.#owners.clear();
		this.#additions.clear();
		this.#pins.clear();
	}

	/** The session id a key lookup for `provider` resolves under, restricted first when pooled. */
	#sessionIdFor(provider: string, sessionId: string | undefined): string | undefined {
		const scopedSessionId = sessionId ?? this.#primarySessionId;
		if (!this.#owners.has(scopedSessionId)) this.#owners.set(scopedSessionId, this.#primarySessionId);
		const owner = this.#owner(scopedSessionId);
		const scoped =
			Object.hasOwn(this.#pools, provider) ||
			this.#additions.get(owner)?.has(provider) === true ||
			this.#pins.get(owner)?.has(provider) === true;
		if (!scoped && !this.#denyUnlistedProviders) return sessionId;
		this.restrictProvider(scopedSessionId, provider);
		return scopedSessionId;
	}

	/**
	 * `registry` with its key lookups (`getApiKey`, `getApiKeyForProvider`,
	 * `getApiKeyWithCredentialForProvider`, `getApiKeyAndHeaders`, `resolver`)
	 * routed through this scope. Every other member is the unscoped registry's,
	 * so model state, discovery, and caches stay shared. A registry another
	 * scope returned is unwrapped first: a nested agent with its own pools uses
	 * them, not its parent's.
	 */
	registry(registry: ModelRegistry): ModelRegistry {
		const target = scopedRegistryTargets.get(registry) ?? registry;
		const getApiKey = (model: Model<Api>, sessionId?: string, options?: { signal?: AbortSignal }) =>
			target.getApiKey(model, this.#sessionIdFor(model.provider, sessionId), options);
		const getApiKeyWithCredentialForProvider = (provider: string, sessionId?: string, options?: AuthApiKeyOptions) =>
			target.getApiKeyWithCredentialForProvider(provider, this.#sessionIdFor(provider, sessionId), options);
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
			resolver: ((
				resolverTarget: string | ApiKeyResolverModel,
				optionsOrSessionId?: ApiKeyResolverOptions | string,
			) => {
				const options =
					typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : (optionsOrSessionId ?? {});
				const provider = typeof resolverTarget === "string" ? resolverTarget : resolverTarget.provider;
				return createApiKeyResolver(
					{ getApiKeyWithCredentialForProvider, authStorage: target.authStorage },
					provider,
					{
						...options,
						...(typeof resolverTarget === "string"
							? {}
							: { baseUrl: resolverTarget.baseUrl, modelId: resolverTarget.id }),
						sessionId: this.#sessionIdFor(provider, options.sessionId),
					},
				);
			}) as ModelRegistry["resolver"],
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
