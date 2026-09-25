import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $env, $envExact } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver, ResolvedApiKey } from "../auth-retry";
import * as AIError from "../error";
import { isUsageLimitOutcome } from "../error/rate-limit";
import { AUTHENTICATED_SENTINEL } from "../registry/types";
import { getEnvApiKey, getEnvApiKeyName } from "../stream";
import type { SessionAffinity } from "./affinity";
import type { CredentialCoordination } from "./coordination";
import type { CredentialPool } from "./pool";
import type { ApiKeySelection } from "./rank";
import type { CredentialSelector } from "./select";
import type { AuthApiKeyOptions, AuthCredential, AuthSource, AuthSourceOptions, KeysApi, LimitsApi } from "./types";

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires pi-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = $envExact(config);
	return envValue || config;
}

/** Runtime (--api-key) and config (models.yml) key overrides plus the config-value resolver. */
export class KeyOverrides {
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	#configValueResolver: (config: string) => Promise<string | undefined>;

	constructor(resolver?: (config: string) => Promise<string | undefined>) {
		this.#configValueResolver = resolver ?? defaultConfigValueResolver;
	}

	has(provider: string): boolean {
		return this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider);
	}

	runtimeKey(provider: string): string | undefined {
		return this.#runtimeOverrides.get(provider);
	}

	configKey(provider: string): string | undefined {
		return this.#configOverrides.get(provider);
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
	 */
	setConfig(provider: string, apiKeyConfig: string): void {
		this.#configOverrides.set(provider, apiKeyConfig);
	}

	/**
	 * Remove a single config-sourced API key override.
	 */
	removeConfig(provider: string): void {
		this.#configOverrides.delete(provider);
	}

	/**
	 * Drop every config-sourced API key. Called by `ModelRegistry` before
	 * re-parsing `models.yml` so removed entries actually disappear.
	 */
	clearConfig(): void {
		this.#configOverrides.clear();
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
	affinity: SessionAffinity;
	/** In-process requestId-keyed quota-probe leases; resolution failure must release them. */
	coordination: CredentialCoordination;
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
	 * stored OAuth → login-stored api_key → env var → stored api_key.
	 * Returns undefined when no auth is configured.
	 *
	 * Compact, structured counterpart to {@link KeyCascade.describe}; `env`
	 * selects dedicated-only, alias-aware, or no environment fallback.
	 */
	source(provider: string, { env = "dedicated" }: AuthSourceOptions = {}): AuthSource | undefined {
		if (this.#deps.overrides.runtimeKey(provider) !== undefined) return { kind: "runtime", concrete: true };
		if (this.#deps.overrides.configKey(provider) !== undefined) return { kind: "config", concrete: true };
		const bearing = this.#getAuthBearingCredentials(provider);
		const concrete = bearing.length > 0 || this.#envConcrete(provider);
		if (bearing.some(credential => credential.type === "oauth")) return { kind: "oauth", concrete: true };
		if (bearing.some(credential => credential.type === "api_key" && credential.source === "login")) {
			return { kind: "api_key", concrete: true };
		}
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
	 * credential to reach the correct host.
	 */
	async peek(provider: string): Promise<string | undefined> {
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
		const oauthSelection = this.#deps.selector.selectByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: oauthSelection.credential.access,
						enterpriseUrl: oauthSelection.credential.enterpriseUrl,
						apiEndpoint: oauthSelection.credential.apiEndpoint,
					});
				}
				return oauthSelection.credential.access;
			}
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

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#deps.selector.selectByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#deps.overrides.resolve(apiKeySelection.credential.key);
		}
		return undefined;
	}

	/** Resolve a bearer together with the stored row that supplied it. */
	async getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		let credentialId: number | undefined;
		const apiKey = await this.get(provider, sessionId, options, id => {
			credentialId = id;
		});
		return apiKey === undefined ? undefined : { apiKey, credentialId };
	}

	/**
	 * Get API key for a provider.
	 * Priority (first match wins): runtime override, config override, OAuth,
	 * login API key, environment variable, then another stored API key.
	 */
	async get(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
		onCredentialId?: (id: number) => void,
	): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.#deps.overrides.runtimeKey(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		const configKey = this.#deps.overrides.configKey(provider);
		if (configKey !== undefined) {
			return this.#deps.overrides.resolve(configKey);
		}

		// Precedence: a deliberate OAuth/login credential wins, then an explicit env var,
		// then a stored static api_key (which may be a stale broker-migrated copy) as a last resort.
		const oauthResolved = await this.#deps.selector.resolveOAuth(provider, sessionId, options);
		if (oauthResolved) {
			if (oauthResolved.credentialId !== undefined) onCredentialId?.(oauthResolved.credentialId);
			return oauthResolved.apiKey;
		}
		const loginApiKeySelection = await this.#deps.selector.selectApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source === "login" && !this.isKeylessFallback(provider, credential),
		);
		if (loginApiKeySelection) {
			const apiKey = await this.#resolveApiKey(
				provider,
				sessionId,
				loginApiKeySelection,
				options?.requestId,
			);
			if (apiKey !== undefined) {
				if (onCredentialId) {
					const credentialId = this.#deps.pool.entries(provider)[loginApiKeySelection.index]?.id;
					if (credentialId !== undefined) onCredentialId(credentialId);
				}
				return apiKey;
			}
		}

		// Past OAuth: the session sticky (if any) is stale — the request authenticates via
		// env/api_key, not OAuth, so clear it now so getOAuthAccountId() correctly
		// suppresses account_uuid for this session.
		if (sessionId) this.#deps.affinity.forget(provider, sessionId);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		const apiKeySelection = await this.#deps.selector.selectApiKey(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (apiKeySelection) {
			const apiKey = await this.#resolveApiKey(provider, sessionId, apiKeySelection, options?.requestId);
			if (apiKey !== undefined) {
				if (onCredentialId) {
					const credentialId = this.#deps.pool.entries(provider)[apiKeySelection.index]?.id;
					if (credentialId !== undefined) onCredentialId(credentialId);
				}
				return apiKey;
			}
		}
		return undefined;
	}

	/**
	 * Resolve a selected stored api_key's key material through the config-value
	 * resolver. The selection may already hold this request's quota-probe lease —
	 * a failed resolve (missing env/command, resolver error) must release it so
	 * a later request is not locked out by a credential that never vendored a
	 * key. Affinity records only on success.
	 */
	async #resolveApiKey(
		provider: string,
		sessionId: string | undefined,
		selection: ApiKeySelection,
		requestId: string | undefined,
	): Promise<string | undefined> {
		try {
			const resolved = await this.#deps.overrides.resolve(selection.credential.key);
			if (resolved === undefined || resolved === "") {
				if (requestId) this.#deps.coordination.clearQuotaProbe(requestId);
				return undefined;
			}
			this.#deps.affinity.record(provider, sessionId, "api_key", selection.index);
			return resolved;
		} catch (error) {
			if (requestId) this.#deps.coordination.clearQuotaProbe(requestId);
			throw error;
		}
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
		return async ({ lastChance, error, signal, previousKey }) => {
			if (error === undefined) {
				return this.getWithCredential(provider, sessionId, {
					baseUrl,
					modelId,
					signal,
				});
			}
			if (lastChance) {
				const switched = await this.#deps.rotate(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
				});
				if (!switched) {
					const status = AIError.status(error);
					const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
					// Preserve no-sibling quota backoff instead of re-resolving an
					// already-blocked fallback. Hard-auth declines still re-resolve
					// because a peer may have refreshed the failed bearer.
					if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
				}
				return this.getWithCredential(provider, sessionId, {
					baseUrl,
					modelId,
					signal,
				});
			}
			return this.getWithCredential(provider, sessionId, {
				baseUrl,
				modelId,
				forceRefresh: true,
				signal,
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

	setConfig(provider: string, apiKeyConfig: string): void {
		this.#deps.overrides.setConfig(provider, apiKeyConfig);
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
