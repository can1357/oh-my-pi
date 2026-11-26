import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $env, $envExact, logger } from "@oh-my-pi/pi-utils";
import {
	type ApiKeyResolver,
	createOAuthProvenance,
	type ResolvedApiKey,
	refreshReasonFor,
	resolveAfterRotation,
} from "../auth-retry";
import { getEnvApiKey, getEnvApiKeyName } from "../env-api-key";
import * as AIError from "../error";
import { getProviderDefinition } from "../registry";
import { assertProviderEnabled, providerPauseReason } from "../registry/oauth";
import { AUTHENTICATED_SENTINEL, type ProviderDefinition } from "../registry/types";
import type { SessionAffinity } from "./affinity";
import { type CredentialBlocks, providerTypeKey, serviceTierBlockScope } from "./blocks";
import type { CredentialPool } from "./pool";
import type { ApiKeySelection } from "./rank";
import type { CredentialSelector, OAuthResolutionResult } from "./select";
import type {
	ApiKeyCredential,
	AuthApiKeyOptions,
	AuthPeekOptions,
	AuthCredential,
	AuthSource,
	AuthSourceOptions,
	KeysApi,
	LimitsApi,
	OAuthCredential,
	OAuthRequestIdentity,
} from "./types";

type OAuthKeyEncoder = NonNullable<ProviderDefinition["getApiKey"]>;

/** A stored API key chosen for a request, and whether it leaves the request's service tier unserved. */
type StoredApiKeyChoice = { selection: ApiKeySelection; serviceTierUnavailable: boolean };

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires omp-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = $envExact(config);
	return envValue || config;
}

/** Runtime (--api-key) and config (models.yml) key overrides plus the config-value resolver. */
export class KeyOverrides {
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	#configFallbacks: Map<string, string> = new Map();
	#configValueResolver: (config: string) => Promise<string | undefined>;

	constructor(resolver?: (config: string) => Promise<string | undefined>) {
		this.#configValueResolver = resolver ?? defaultConfigValueResolver;
	}

	has(provider: string): boolean {
		return this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider);
	}

	/**
	 * Whether an override replaces OAuth for a session. Any override does for an
	 * unrestricted session. A restricted session skips the runtime key, but a
	 * config key still blocks OAuth: it marks the provider's endpoint (often a
	 * proxy) as taking that key, so the session fails closed instead of sending
	 * a pooled OAuth token there (see `KeyCascade.get`).
	 */
	suppressesOAuth(provider: string, restricted: boolean): boolean {
		return restricted ? this.#configOverrides.has(provider) : this.has(provider);
	}

	runtimeKey(provider: string): string | undefined {
		return this.#runtimeOverrides.get(provider);
	}

	configKey(provider: string): string | undefined {
		return this.#configOverrides.get(provider);
	}

	/** Config value consulted only after stored OAuth/login credentials. */
	fallbackKey(provider: string): string | undefined {
		return this.#configFallbacks.get(provider);
	}

	/** Resolve a config value (env var name, "!command", literal) to the secret. */
	resolve(config: string): Promise<string | undefined> {
		return this.#configValueResolver(config);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntime(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntime(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	/**
	 * Register a per-provider API key sourced from user configuration
	 * (e.g. `models.yml` `providers.<name>.apiKey`). Higher priority than
	 * stored credentials and OAuth tokens — when the user pins a key in
	 * config, that key is what authenticates outbound requests, regardless
	 * of whatever the broker happens to have loaded for that provider.
	 *
	 * Lower priority than {@link KeyOverrides.setRuntime} so a CLI `--api-key`
	 * still wins for the duration of a single invocation.
	 *
	 * `fallback: true` instead ranks the value below stored OAuth and `/login`
	 * credentials (at the env-var tier). Providers that own a `/login` flow use
	 * this so their default key reference (e.g. an unset env-var name, which
	 * resolves to its literal text) cannot shadow the key the user logged in with.
	 */
	setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean }): void {
		if (options?.fallback) {
			this.#configOverrides.delete(provider);
			this.#configFallbacks.set(provider, apiKeyConfig);
		} else {
			this.#configFallbacks.delete(provider);
			this.#configOverrides.set(provider, apiKeyConfig);
		}
	}

	/**
	 * Remove a single config-sourced API key (override or fallback).
	 */
	removeConfig(provider: string): void {
		this.#configOverrides.delete(provider);
		this.#configFallbacks.delete(provider);
	}

	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfig(): void {
		this.#configOverrides.clear();
		this.#configFallbacks.clear();
	}

	/**
	 * Install the host's async config-value resolver. Coding-agent uses this so
	 * every stored/config credential reference shares command caching,
	 * failure backoff, and process hardening even when AuthStorage was created
	 * independently and later attached to a registry.
	 */
	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#configValueResolver = resolver;
	}
}

/** Dependencies of the provider key precedence cascade. */
export interface KeyCascadeDeps {
	pool: CredentialPool;
	overrides: KeyOverrides;
	selector: CredentialSelector;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	/** LimitsApi.rotate, injected to avoid a cascade↔rotation import cycle. */
	rotate: LimitsApi["rotate"];
	sourceLabel?: string;
}

/** The provider auth precedence cascade (runtime → config → OAuth → login key → env → stored key). */
export class KeyCascade implements KeysApi {
	#deps: KeyCascadeDeps;

	constructor(deps: KeyCascadeDeps) {
		this.#deps = deps;
	}

	/**
	 * The request key a provider's `getApiKey` hook builds from a stored OAuth
	 * row, or undefined when the hook rejects the row (an incomplete login).
	 */
	#encodeOAuthKey(getApiKey: OAuthKeyEncoder, credential: OAuthCredential): string | undefined {
		try {
			return getApiKey(credential);
		} catch (error) {
			logger.debug("Stored OAuth credential skipped: provider cannot build its key", { error: String(error) });
			return undefined;
		}
	}

	/**
	 * True when a stored credential is the provider's KDL `empty-fallback`
	 * keyless-mode marker — what an empty paste at an "Optional: paste API key"
	 * login prompt stores (e.g. `lm-studio-local` for lm-studio). The wire layer
	 * never sends these as a bearer (`isDiscoveryBearerApiKey` strips them), so
	 * auth-status surfaces must not count them either; otherwise the model hub
	 * and `/login` report the provider as authenticated while every request
	 * goes out bare (issue #12281). The credential itself stays stored: `/logout`
	 * can still remove it, and availability treats the provider as keyless.
	 */
	isKeylessFallback(provider: string, credential: AuthCredential): boolean {
		if (credential.type !== "api_key") return false;
		const login = authPolicyFor(provider)?.login;
		if (login?.kind !== "api-key") return false;
		const fallback = login.emptyFallback;
		return fallback !== undefined && fallback !== "" && credential.key === fallback;
	}

	/** Stored credentials that carry real auth — keyless-fallback markers excluded. */
	#getAuthBearingCredentials(provider: string): AuthCredential[] {
		return this.#deps.pool.credentials(provider).filter(credential => !this.isKeylessFallback(provider, credential));
	}

	/**
	 * True when the provider has stored credentials but none of them carries
	 * auth — i.e. its only credential is the KDL `empty-fallback` keyless-mode
	 * marker (an empty paste at an optional-key login prompt). Such a provider
	 * is configured-but-keyless: model availability treats it like an
	 * `auth: none` endpoint instead of locking it out (issue #12281).
	 */
	keyless(provider: string): boolean {
		const stored = this.#deps.pool.credentials(provider);
		return stored.length > 0 && stored.every(credential => this.isKeylessFallback(provider, credential));
	}

	/**
	 * Env auth that belongs to this provider, not a cross-provider alias.
	 * A declared OAuth token env list excludes borrowed API-key aliases from
	 * availability and origin, while explicit streams may still use those keys.
	 */
	#hasDedicatedEnvAuth(provider: string): boolean {
		const oauthTokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
		if (oauthTokenEnv) return oauthTokenEnv.some(name => Boolean($env[name]?.trim()));
		return Boolean(getEnvApiKey(provider));
	}

	/**
	 * Classify where a provider's auth comes from, following the same precedence
	 * as {@link KeyCascade.get}: runtime override → config override →
	 * stored OAuth → login-stored api_key → config fallback → env var → stored api_key.
	 * Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link KeyCascade.describe}; `env`
	 * selects dedicated-only, alias-aware, or no environment fallback.
	 */
	source(provider: string, { env = "dedicated" }: AuthSourceOptions = {}): AuthSource | undefined {
		if (providerPauseReason(provider) !== undefined) return undefined;
		if (this.#deps.overrides.runtimeKey(provider) !== undefined) return { kind: "runtime", concrete: true };
		if (this.#deps.overrides.configKey(provider) !== undefined) return { kind: "config", concrete: true };
		const bearing = this.#getAuthBearingCredentials(provider);
		const concrete = bearing.length > 0 || this.#envConcrete(provider);
		if (bearing.some(credential => credential.type === "oauth")) return { kind: "oauth", concrete: true };
		if (bearing.some(credential => credential.type === "api_key" && credential.source === "login")) {
			return { kind: "api_key", concrete: true };
		}
		if (this.#deps.overrides.fallbackKey(provider) !== undefined) return { kind: "config", concrete: true };
		if (
			(env === "dedicated" && this.#hasDedicatedEnvAuth(provider)) ||
			(env === "aliases" && (this.#hasDedicatedEnvAuth(provider) || Boolean(getEnvApiKey(provider))))
		) {
			return { kind: "env", envVar: getEnvApiKeyName(provider), concrete };
		}
		if (bearing.some(credential => credential.type === "api_key")) return { kind: "api_key", concrete: true };
		return undefined;
	}

	/** Check if a provider has a concrete env token, excluding ambient sentinel auth. */
	#envConcrete(provider: string): boolean {
		// Bedrock's bearer is transport-specific rather than an auth-stratum OAuth token.
		if ((provider === "amazon-bedrock" || provider === "bedrock-mantle") && $env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
			return true;
		}
		const oauthTokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
		if (oauthTokenEnv) return oauthTokenEnv.some(name => Boolean($env[name]?.trim()));
		const envApiKey = getEnvApiKey(provider);
		return envApiKey !== undefined && envApiKey !== AUTHENTICATED_SENTINEL;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. GitHub Copilot's peek must preserve
	 * enterprise routing metadata because discovery needs a structured
	 * credential to reach the correct host. With several stored accounts every
	 * peek returns the same one, so credential-scoped discovery caches stay on
	 * one namespace.
	 */
	async peek(provider: string, options?: AuthPeekOptions): Promise<string | undefined> {
		if (providerPauseReason(provider) !== undefined) return undefined;
		const runtimeKey = this.#deps.overrides.runtimeKey(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#deps.overrides.configKey(provider);
		if (configKey !== undefined) {
			return await this.#deps.overrides.resolve(configKey);
		}

		await this.#deps.pool.adoptExternalChanges();

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
		// Peek never refreshes, so only an unexpired OAuth access token is usable
		// unless the caller only needs the account it names.
		const now = Date.now();
		// A provider-owned key encoding (`getApiKey`) is shared with `getOAuthApiKey`, so a peek
		// and a refresh of one row resolve the same key; a row it rejects is skipped, as `get()` does.
		const getApiKey = getProviderDefinition(provider)?.getApiKey;
		const servable = (credential: AuthCredential): credential is OAuthCredential =>
			credential.type === "oauth" && (!getApiKey || this.#encodeOAuthKey(getApiKey, credential) !== undefined);
		const oauthSelection =
			this.#deps.selector.selectByType(
				provider,
				"oauth",
				undefined,
				credential => servable(credential) && Number.isFinite(credential.expires) && credential.expires > now,
			) ??
			(options?.includeExpired
				? this.#deps.selector.selectByType(provider, "oauth", undefined, servable)
				: undefined);
		if (oauthSelection) {
			if (provider === "github-copilot") {
				return JSON.stringify({
					token: oauthSelection.credential.access,
					enterpriseUrl: oauthSelection.credential.enterpriseUrl,
					apiEndpoint: oauthSelection.credential.apiEndpoint,
				});
			}
			if (getApiKey) return this.#encodeOAuthKey(getApiKey, oauthSelection.credential);
			return oauthSelection.credential.access;
		}

		const loginApiKeySelection = this.#deps.selector.selectByType(
			provider,
			"api_key",
			undefined,
			credential =>
				credential.type === "api_key" &&
				credential.source === "login" &&
				!this.isKeylessFallback(provider, credential),
		);
		if (loginApiKeySelection) {
			return this.#deps.overrides.resolve(loginApiKeySelection.credential.key);
		}

		const fallbackKey = this.#deps.overrides.fallbackKey(provider);
		if (fallbackKey !== undefined) return this.#deps.overrides.resolve(fallbackKey);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#deps.selector.selectByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#deps.overrides.resolve(apiKeySelection.credential.key);
		}
		return undefined;
	}

	/**
	 * Resolve a bearer together with the stored row that supplied it, for a request.
	 * Same precedence as {@link KeyCascade.get}, but rejects with
	 * {@link AIError.OAuthRefreshUnavailableError} (transient, retryable) when OAuth
	 * refresh failed with a retryable error and no other permitted source could serve
	 * the request, so request paths retry instead of reporting a missing key.
	 */
	async getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		assertProviderEnabled(provider);
		return this.#resolve(provider, sessionId, options);
	}

	/**
	 * Get API key for a provider.
	 * Priority (first match wins): runtime override, config override, OAuth,
	 * login API key, environment variable, then another stored API key.
	 * A request that names `options.serviceTier` and whose OAuth pool has no
	 * account offering it takes an API key that may ahead of OAuth, so `/fast`
	 * reaches a credential that can serve it: a login key, the environment
	 * variable, then another stored key. A `models.yml` fallback keeps its
	 * place, since its value may be an unresolved placeholder.
	 * A session restricted by `sessions.restrict` resolves only its allowed
	 * OAuth accounts and throws {@link AIError.MissingApiKeyError} when none
	 * can serve or a config key (a models.yml `apiKey`, often for a proxy
	 * `baseUrl`) owns the provider, rather than using any other credential.
	 * A transient OAuth refresh failure resolves `undefined`, so availability
	 * probes move on to their next candidate; request paths use
	 * {@link KeyCascade.getWithCredential}, which surfaces it.
	 */
	async get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		try {
			return (await this.#resolve(provider, sessionId, options))?.apiKey;
		} catch (error) {
			if (!(error instanceof AIError.OAuthRefreshUnavailableError)) throw error;
			logger.debug("API key probe skipped transient OAuth refresh failure", { provider, error: error.message });
			return undefined;
		}
	}

	/** Warm selection metadata during session startup without choosing or pinning an account. */
	async prefetchUsage(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		if (this.source(provider)?.kind !== "oauth") return;
		await this.#deps.selector.prefetchUsage(provider, sessionId, options);
	}

	/**
	 * The stored API key passing `filter`, preferring one that offers the
	 * request's service tier. `serviceTierUnavailable` reports that the key in
	 * hand was refused that tier and no other matching key could take it.
	 */
	async #selectStoredApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter: (credential: ApiKeyCredential) => boolean,
	): Promise<StoredApiKeyChoice | undefined> {
		const offering = await this.#deps.selector.selectServiceTierApiKey(provider, sessionId, options, filter);
		if (offering) return { selection: offering, serviceTierUnavailable: false };
		const selection = await this.#deps.selector.selectApiKey(provider, sessionId, options, filter);
		const tierScope = serviceTierBlockScope(options?.serviceTier, options?.modelId);
		return (
			selection && {
				selection,
				serviceTierUnavailable:
					tierScope !== undefined &&
					this.#deps.blocks.isScopeBlocked(
						provider,
						providerTypeKey(provider, "api_key"),
						selection.index,
						tierScope,
					),
			}
		);
	}

	/** A key with no stored row behind it, flagged while it is refused the request's service tier. */
	#unstoredKey(
		provider: string,
		apiKey: string | undefined,
		options: AuthApiKeyOptions | undefined,
	): ResolvedApiKey | undefined {
		if (apiKey === undefined) return undefined;
		const tierScope = serviceTierBlockScope(options?.serviceTier, options?.modelId);
		return tierScope !== undefined && this.#deps.blocks.isUnstoredKeyRefused(provider, tierScope)
			? { apiKey, serviceTierUnavailable: true }
			: { apiKey };
	}

	/** Pin a chosen stored API key to the session and resolve its bearer. */
	async #useStoredApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		{ selection, serviceTierUnavailable }: StoredApiKeyChoice,
	): Promise<ResolvedApiKey | undefined> {
		if (options?.recordAffinity !== false) {
			this.#deps.affinity.record(provider, sessionId, "api_key", selection.index);
		}
		const credentialId = this.#deps.pool.entries(provider)[selection.index]?.id;
		const apiKey = await this.#deps.overrides.resolve(selection.credential.key);
		if (apiKey === undefined) return undefined;
		return { apiKey, credentialId, ...(serviceTierUnavailable ? { serviceTierUnavailable: true } : {}) };
	}

	/**
	 * An API key to serve a tier-preferring request whose OAuth pool has no
	 * account offering the tier, in the cascade's own order: a `/login` key,
	 * the environment variable, then any other stored key. Each is presumed to
	 * offer the tier until the provider refuses it, which steers the next
	 * request onward and finally back to OAuth.
	 */
	async #resolveServiceTierApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
	): Promise<ResolvedApiKey | undefined> {
		const tierScope = serviceTierBlockScope(options?.serviceTier, options?.modelId);
		if (tierScope === undefined) return undefined;
		const loginKey = await this.#deps.selector.selectServiceTierApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source === "login" && !this.isKeylessFallback(provider, credential),
		);
		if (loginKey) {
			return this.#useStoredApiKey(provider, sessionId, options, {
				selection: loginKey,
				serviceTierUnavailable: false,
			});
		}

		const envKey = getEnvApiKey(provider);
		if (envKey && envKey !== AUTHENTICATED_SENTINEL && !this.#deps.blocks.isUnstoredKeyRefused(provider, tierScope)) {
			// As on the ordinary environment path: the request is not
			// OAuth-authenticated, so the session's OAuth pin must not attribute it.
			if (sessionId) this.#deps.affinity.forget(provider, sessionId);
			return { apiKey: envKey };
		}

		const storedKey = await this.#deps.selector.selectServiceTierApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login" && !this.isKeylessFallback(provider, credential),
		);
		return (
			storedKey &&
			this.#useStoredApiKey(provider, sessionId, options, { selection: storedKey, serviceTierUnavailable: false })
		);
	}

	async #resolve(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		// A provider turned off in its auth rules is reached by no key source:
		// runtime, models.yml, stored, env or broker.
		if (providerPauseReason(provider) !== undefined) return undefined;
		const restricted = this.#deps.affinity.isRestricted(provider, sessionId);
		// Runtime override takes highest priority
		const runtimeKey = restricted ? undefined : this.#deps.overrides.runtimeKey(provider);
		if (runtimeKey) {
			return this.#unstoredKey(provider, runtimeKey, options);
		}

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		if (restricted && this.#deps.overrides.configKey(provider) !== undefined) {
			throw new AIError.MissingApiKeyError(
				provider,
				`No API key for provider: ${provider} (session ${sessionId} is restricted to its OAuth account pool, but models.yml configures an apiKey for this provider, and pooled OAuth tokens are never sent past it)`,
			);
		}
		const configKey = restricted ? undefined : this.#deps.overrides.configKey(provider);
		if (configKey !== undefined) {
			return this.#unstoredKey(provider, await this.#deps.overrides.resolve(configKey), options);
		}

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
		// A transient OAuth refresh failure still lets later sources serve the request; it is
		// rethrown only when none can, so callers retry instead of reporting a missing key.
		let oauthResolved: OAuthResolutionResult | undefined;
		let oauthRefreshFailure: AIError.OAuthRefreshUnavailableError | undefined;
		// A tier-preferring resolve may still hand the request to an API key, so
		// the session pin is recorded once the choice is final.
		const tierPreferring = options?.serviceTier !== undefined;
		const sessionBasis = this.#deps.affinity.get(provider, sessionId);
		try {
			oauthResolved = await this.#deps.selector.resolveOAuth(
				provider,
				sessionId,
				tierPreferring ? { ...options, recordAffinity: false } : options,
			);
		} catch (error) {
			if (!(error instanceof AIError.OAuthRefreshUnavailableError)) throw error;
			oauthRefreshFailure = error;
		}
		if (oauthResolved) {
			const serviceTierUnavailable = oauthResolved.serviceTierOffered === false;
			if (serviceTierUnavailable && !restricted) {
				const tierApiKey = await this.#resolveServiceTierApiKey(provider, sessionId, options);
				if (tierApiKey) return tierApiKey;
			}
			const { credentialId, credential } = oauthResolved;
			if (tierPreferring && options?.recordAffinity !== false && credentialId !== undefined) {
				const index = this.#deps.pool.entries(provider).findIndex(entry => entry.id === credentialId);
				if (index !== -1) this.#deps.affinity.recordSelection(provider, sessionId, "oauth", index, sessionBasis);
			}
			const oauthIdentity: OAuthRequestIdentity = {
				accountId: credential.accountId,
				orgId: credential.orgId,
				region: credential.region,
				inferenceRegion: credential.inferenceRegion,
			};
			return {
				apiKey: oauthResolved.apiKey,
				credentialId,
				...(credentialId !== undefined && credential.access ? { oauthAccess: credential.access } : {}),
				...(credentialId !== undefined ? { oauthIdentity } : {}),
				...(serviceTierUnavailable ? { serviceTierUnavailable: true } : {}),
			};
		}
		if (restricted) {
			if (oauthRefreshFailure) throw oauthRefreshFailure;
			throw new AIError.MissingApiKeyError(
				provider,
				`No API key for provider: ${provider} (session ${sessionId} is restricted to its OAuth account pool and none of those accounts is available)`,
			);
		}
		const loginApiKey = await this.#selectStoredApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source === "login" && !this.isKeylessFallback(provider, credential),
		);
		if (loginApiKey) return this.#useStoredApiKey(provider, sessionId, options, loginApiKey);

		// Past OAuth: the session sticky (if any) is stale — the request authenticates via
		// env/api_key, not OAuth, so clear it now so getOAuthAccountId() correctly
		// suppresses account_uuid for this session.
		if (sessionId) this.#deps.affinity.forget(provider, sessionId);

		const fallbackKey = this.#deps.overrides.fallbackKey(provider);
		if (fallbackKey !== undefined) {
			return this.#unstoredKey(provider, await this.#deps.overrides.resolve(fallbackKey), options);
		}

		const envKey = getEnvApiKey(provider);
		if (envKey) return this.#unstoredKey(provider, envKey, options);
		const storedApiKey = await this.#selectStoredApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (storedApiKey) return this.#useStoredApiKey(provider, sessionId, options, storedApiKey);
		if (oauthRefreshFailure) throw oauthRefreshFailure;
		return undefined;
	}

	/**
	 * Build an {@link ApiKeyResolver} backed by this storage, implementing the
	 * central a/b/c auth-retry policy:
	 *
	 * - initial (`error: undefined`) → resolve the session credential.
	 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential.
	 * - step (c) `lastChance` → rotate to a sibling and re-resolve, unless quota exhaustion has no sibling.
	 *
	 * Used by web-search providers and other consumers that hold a KeyCascade
	 * directly (no ModelRegistry in scope).
	 */
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		// One resolver serves many requests, and they fail out of order, so the
		// token a 401 rejected is looked up from the bearer that request sent.
		const provenance = createOAuthProvenance();
		const resolve = async (extra: AuthApiKeyOptions): Promise<ResolvedApiKey | undefined> => {
			const resolved = await this.getWithCredential(provider, sessionId, { baseUrl, modelId, ...extra });
			provenance.record(resolved);
			return resolved;
		};
		return async ({ lastChance, error, signal, previousKey, serviceTier }) => {
			const rejectedAccessToken = provenance.accessFor(previousKey);
			if (error === undefined) {
				return resolve({ signal, serviceTier });
			}
			if (lastChance) {
				const rotation = await this.#deps.rotate(provider, sessionId, {
					error,
					modelId,
					baseUrl,
					signal,
					apiKey: previousKey,
				});
				return resolveAfterRotation(rotation, error, () => resolve({ signal, serviceTier }));
			}
			return resolve({
				forceRefresh: true,
				refreshReason: refreshReasonFor(error),
				rejectedAccessToken,
				signal,
				serviceTier,
			});
		};
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Mirrors {@link KeyCascade.get} precedence, highest first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey`).
	 *   3. Stored OAuth credential.
	 *   4. API key persisted by a successful `/login`.
	 *   5. Env var — overrides a stored static api_key (e.g. a stale broker copy).
	 *   6. Stored api_key credential.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describe(provider: string, sessionId?: string): string | undefined {
		if (providerPauseReason(provider) !== undefined) return undefined;
		if (this.#deps.overrides.runtimeKey(provider) !== undefined) {
			return "runtime override (--api-key)";
		}
		if (this.#deps.overrides.configKey(provider) !== undefined) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#deps.sourceLabel ?? "local store";
		const stored = this.#deps.pool.entries(provider);
		const session = this.#deps.affinity.get(provider, sessionId);
		const describeStored = (
			type: AuthCredential["type"],
			filter?: (credential: AuthCredential) => boolean,
		): string | undefined => {
			const typed = stored
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.credential.type === type && (filter?.(entry.credential) ?? true));
			if (typed.length === 0) return undefined;
			const sticky = session?.type === type ? typed.find(entry => entry.index === session.index) : undefined;
			const chosen = sticky?.entry ?? typed[0].entry;
			const credential = chosen.credential;
			const identity =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
					: `cred ${chosen.id}`;
			return `${baseLabel} · ${type} #${chosen.id} (${identity})`;
		};

		// Deliberate login credentials win; then an explicit env var; then a stored static api_key.
		const oauthSource = describeStored("oauth");
		if (oauthSource) return oauthSource;
		const loginApiKeySource = describeStored(
			"api_key",
			credential =>
				credential.type === "api_key" &&
				credential.source === "login" &&
				!this.isKeylessFallback(provider, credential),
		);
		if (loginApiKeySource) return loginApiKeySource;
		if (this.#deps.overrides.fallbackKey(provider) !== undefined) return "provider config (fallback)";
		if (getEnvApiKey(provider)) return `env (over ${baseLabel})`;
		const apiKeySource = describeStored(
			"api_key",
			credential => credential.type !== "api_key" || credential.source !== "login",
		);
		if (apiKeySource) return apiKeySource;
		return undefined;
	}

	setRuntime(provider: string, apiKey: string): void {
		this.#deps.overrides.setRuntime(provider, apiKey);
	}

	removeRuntime(provider: string): void {
		this.#deps.overrides.removeRuntime(provider);
	}

	setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean }): void {
		this.#deps.overrides.setConfig(provider, apiKeyConfig, options);
	}

	removeConfig(provider: string): void {
		this.#deps.overrides.removeConfig(provider);
	}

	clearConfig(): void {
		this.#deps.overrides.clearConfig();
	}

	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#deps.overrides.setResolver(resolver);
	}
}
