import { KeyOverrides } from "@oh-my-pi/pi-ai/auth/cascade";
import {
	type ApiKeyResolver,
	type ResolvedApiKey,
	refreshReasonFor,
	resolveAfterRotation,
} from "@oh-my-pi/pi-ai/auth-retry";
import type {
	AuthApiKeyOptions,
	AuthPeekOptions,
	AuthSource,
	AuthSourceOptions,
	KeysApi,
	LimitsApi,
	StoredAuthLocalSources,
	StoredAuthResolution,
	StoredCredentialSummary,
} from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKey, getEnvApiKeyName } from "@oh-my-pi/pi-ai/env-api-key";
import { MissingApiKeyError, OAuthRefreshUnavailableError } from "@oh-my-pi/pi-ai/error";
import {
	AUTHENTICATED_SENTINEL,
	assertProviderEnabled,
	getProviderDefinition,
	providerPauseReason,
} from "@oh-my-pi/pi-ai/registry";
import type { ServiceTier } from "@oh-my-pi/pi-ai/types";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $env, isRecord, logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { AuthDaemonLink } from "./auth-daemon-link";

export interface AuthDaemonKeyAvailability {
	keyless: boolean;
	credentials: readonly StoredCredentialSummary[];
	keylessCredentialIds?: readonly number[];
	activeCredentialId?: number;
}

export interface DaemonKeysOptions {
	link: Pick<AuthDaemonLink, "request">;
	availabilityLookup(provider: string, sessionId?: string): AuthDaemonKeyAvailability | undefined;
	isRestricted(provider: string, sessionId: string | undefined): boolean;
	/** Dispatch only once preceding session and account-policy updates are acknowledged. */
	beforeRequest<T>(run: () => Promise<T>): Promise<T>;
	isServiceTierRefused?(provider: string, serviceTier: ServiceTier, modelId: string): boolean;
	/** Observe a stored selection or a fallback that drops affinity; discovery never pins an account. */
	onServed?(provider: string, sessionId: string | undefined, resolved: ResolvedApiKey, recordAffinity: boolean): void;
	/** Client-side limits adapter; it converts failed bearer provenance to an opaque handle before sending. */
	rotate: LimitsApi["rotate"];
	sourceLabel?: () => string;
}

type LocalKeys = { runtime?: string; configOverride?: string; configFallback?: string; env?: string };
type StoredKey = Extract<StoredAuthResolution, { kind: "stored" }> & { recoveryHandle?: string };
type Recovery = { bearer: string; handle: string; usedForRecovery?: true };

function selectionOptions(options: AuthApiKeyOptions | undefined) {
	if (!options) return undefined;
	const { modelId, accountIds, serviceTier, serviceTierAccounts, recordAffinity } = options;
	return { modelId, accountIds, serviceTier, serviceTierAccounts, recordAffinity };
}

function localSources(keys: LocalKeys, serviceTierRefused?: true): StoredAuthLocalSources {
	return {
		runtime: keys.runtime ? true : undefined,
		configOverride: keys.configOverride !== undefined ? true : undefined,
		configFallback: keys.configFallback !== undefined ? true : undefined,
		env: keys.env ? (keys.env === AUTHENTICATED_SENTINEL ? "ambient" : "bearer") : undefined,
		serviceTierRefused,
	};
}

function storedSource(
	metadata: AuthDaemonKeyAvailability | undefined,
	kind: "oauth" | "login" | "api_key",
	includeStaticMarker = false,
): StoredCredentialSummary | undefined {
	if (!metadata) return undefined;
	let first: StoredCredentialSummary | undefined;
	for (const row of metadata.credentials) {
		if (row.disabled) continue;
		if (row.type === "oauth") {
			if (kind !== "oauth") continue;
		} else {
			if (kind !== (row.source === "login" ? "login" : "api_key")) continue;
			if (!includeStaticMarker && (metadata.keyless || metadata.keylessCredentialIds?.includes(row.id))) continue;
		}
		if (row.id === metadata.activeCredentialId) return row;
		first ??= row;
	}
	return first;
}

/** Match the stock cascade's dedicated env test, including ambient Bedrock/ADC and borrowed OAuth aliases. */
function environmentSource(
	provider: string,
	mode: NonNullable<AuthSourceOptions["env"]>,
	hasStoredKey: boolean,
): AuthSource | undefined {
	if (mode === "none") return undefined;
	const tokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
	const dedicatedOAuth = tokenEnv?.some(name => Boolean($env[name]?.trim())) ?? false;
	const apiKey =
		tokenEnv === undefined || (mode === "aliases" && !dedicatedOAuth) ? getEnvApiKey(provider) : undefined;
	if (!dedicatedOAuth && !apiKey) return undefined;
	const bedrockBearer =
		(provider === "amazon-bedrock" || provider === "bedrock-mantle") &&
		Boolean($env.AWS_BEARER_TOKEN_BEDROCK?.trim());
	const concrete =
		hasStoredKey || bedrockBearer || (tokenEnv !== undefined ? dedicatedOAuth : apiKey !== AUTHENTICATED_SENTINEL);
	return { kind: "env", envVar: getEnvApiKeyName(provider), concrete };
}

function missingRestricted(
	provider: string,
	sessionId: string | undefined,
	configOverride: boolean,
): MissingApiKeyError {
	return new MissingApiKeyError(
		provider,
		`No API key for provider: ${provider} (session ${sessionId} is restricted to its OAuth account pool${
			configOverride
				? ", but models.yml configures an apiKey for this provider, and pooled OAuth tokens are never sent past it"
				: " and none of those accounts is available"
		})`,
	);
}

function invalidResolution(): Error {
	return new Error("Invalid daemon auth resolution");
}

function throwResolutionError(
	provider: string,
	sessionId: string | undefined,
	configOverride: boolean,
	category: unknown,
): never {
	switch (category) {
		case "refresh-unavailable":
			throw new OAuthRefreshUnavailableError(provider, "Daemon refresh temporarily unavailable");
		case "missing-api-key":
			throw sessionId === undefined
				? new MissingApiKeyError(provider)
				: missingRestricted(provider, sessionId, configOverride);
		case "unsupported-provider":
			throw new Error(`Provider ${provider} is not supported by daemon auth`);
		case "selection-failed":
			throw new Error(`Daemon could not resolve an API key for provider: ${provider}`);
		case "invalid-recovery":
			throw new Error(`Daemon rejected the OAuth recovery handle for provider: ${provider}`);
		default:
			throw invalidResolution();
	}
}

/** The structured stock keys carry their selected access token in the request encoding. */
function selectedOAuthAccess(provider: string, apiKey: string): string {
	if (!getProviderDefinition(provider)?.getApiKey && authPolicyFor(provider)?.apiKeyFormat !== "structured") {
		return apiKey;
	}
	let body: unknown;
	try {
		body = JSON.parse(apiKey);
	} catch {
		throw invalidResolution();
	}
	if (!isRecord(body) || typeof body.token !== "string" || !body.token) throw invalidResolution();
	return body.token;
}

/** The daemon selects a stored row; the caller alone owns local key material and config indirection. */
export class DaemonKeys implements KeysApi {
	readonly #options: DaemonKeysOptions;
	readonly #overrides = new KeyOverrides();
	readonly #recovery = new LRUCache<string, LRUCache<string, Recovery>>({ max: 128 });

	constructor(options: DaemonKeysOptions) {
		this.#options = options;
	}

	async get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		if (providerPauseReason(provider) !== undefined) return undefined;
		try {
			return (await this.#resolve(provider, sessionId, options))?.apiKey;
		} catch (error) {
			if (!(error instanceof OAuthRefreshUnavailableError)) throw error;
			logger.debug("API key probe skipped transient OAuth refresh failure", { provider, error: error.message });
			return undefined;
		}
	}

	async getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		assertProviderEnabled(provider);
		return this.#resolve(provider, sessionId, options);
	}

	#resolve(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
	): Promise<ResolvedApiKey | undefined> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		const { serviceTier, modelId } = options ?? {};
		const tierRefused = () =>
			serviceTier && modelId && this.#options.isServiceTierRefused?.(provider, serviceTier, modelId)
				? true
				: undefined;
		if (!this.#options.isRestricted(provider, sessionId)) {
			const runtime = this.#overrides.runtimeKey(provider);
			if (runtime) return this.#resolveLocal(runtime, false, signal, tierRefused());
			const configOverride = this.#overrides.configKey(provider);
			if (configOverride !== undefined) {
				return this.#resolveLocal(configOverride, true, signal, tierRefused()).then(resolved => {
					this.#requireLocalAllowed(provider, sessionId, { configOverride });
					return resolved;
				});
			}
		}
		return this.#dispatch(signal, async () => {
			const keys = this.#callerKeys(provider, sessionId);

			const authRecovery = options?.forceRefresh === true && options.refreshReason === "auth-recovery";
			const rejected = authRecovery ? options?.rejectedAccessToken : undefined;
			const recoveries =
				rejected === undefined ? undefined : this.#recovery.get(JSON.stringify([provider, sessionId]));
			const recovery = rejected === undefined ? undefined : recoveries?.get(rejected);
			const handle = recovery?.usedForRecovery ? undefined : recovery?.handle;
			// The same issued handle can still identify the previous bearer during sibling rotation.
			if (recovery) recovery.usedForRecovery = true;
			const selected = selectionOptions(options);
			const local = localSources(keys, tierRefused());
			let reply = await this.#options.link.request(
				"resolve",
				{
					provider,
					sessionId,
					options: options && {
						...selected,
						// An unnamed rejection must not mint a new grant: the owner may already hold a newer token.
						forceRefresh: authRecovery && handle === undefined ? undefined : options.forceRefresh,
						refreshReason: handle === undefined ? undefined : options.refreshReason,
					},
					local,
					recoveryHandle: handle,
				},
				signal,
			);
			if (handle !== undefined && isRecord(reply) && reply.category === "invalid-recovery") {
				// An evicted handle was rejected before any refresh. Read without forcing a mint.
				reply = await this.#options.link.request(
					"resolve",
					{ provider, sessionId, options: selected, local },
					signal,
				);
			}
			let resolved = await this.#materialize(provider, sessionId, keys, reply, signal);
			if (resolved === undefined && isRecord(reply) && reply.kind === "stored" && reply.fallbackToOAuth === true) {
				// The tier-preferred key referenced caller config that returned no value.
				reply = await this.#options.link.request(
					"resolve",
					{ provider, sessionId, options: selected, local: { ...local, skipTierApiKey: true } },
					signal,
				);
				resolved = await this.#materialize(provider, sessionId, keys, reply, signal);
			}
			const poolFallback =
				isRecord(reply) && reply.kind === "local" && (reply.source === "env" || reply.source === "config-fallback");
			if (resolved && (resolved.credentialId !== undefined || poolFallback)) {
				this.#options.onServed?.(provider, sessionId, resolved, options?.recordAffinity !== false);
			}
			return resolved;
		});
	}

	async peek(provider: string, options?: AuthPeekOptions): Promise<string | undefined> {
		if (providerPauseReason(provider) !== undefined) return undefined;
		const runtime = this.#overrides.runtimeKey(provider);
		if (runtime) return runtime;
		const configOverride = this.#overrides.configKey(provider);
		if (configOverride !== undefined) return this.#overrides.resolve(configOverride);
		return this.#dispatch(undefined, async () => {
			const keys = this.#callerKeys(provider, undefined);
			const reply = await this.#options.link.request("peek", {
				provider,
				options: options && { includeExpired: options.includeExpired },
				local: localSources(keys),
			});
			const resolved = await this.#materialize(provider, undefined, keys, reply);
			if (resolved?.credentialId !== undefined) this.#options.onServed?.(provider, undefined, resolved, false);
			return resolved?.apiKey;
		});
	}

	async prefetchUsage(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<void> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		if (providerPauseReason(provider) !== undefined || this.#overrides.has(provider)) return;
		await this.#dispatch(signal, async () => {
			if (this.#overrides.has(provider)) return;
			const reply = await this.#options.link.request(
				"prefetchUsage",
				{ provider, sessionId, options: selectionOptions(options) },
				signal,
			);
			if (reply === null) return;
			if (isRecord(reply) && reply.kind === "error")
				throwResolutionError(provider, sessionId, false, reply.category);
			throw invalidResolution();
		});
	}

	#dispatch<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
		signal?.throwIfAborted();
		return raceWithSignal(
			this.#options.beforeRequest(() => {
				signal?.throwIfAborted();
				return run();
			}),
			signal,
		);
	}

	#callerKeys(provider: string, sessionId: string | undefined): LocalKeys {
		const configOverride = this.#overrides.configKey(provider);
		if (this.#options.isRestricted(provider, sessionId)) return { configOverride };
		const runtime = this.#overrides.runtimeKey(provider);
		if (runtime || configOverride !== undefined) return { runtime, configOverride };
		return { configFallback: this.#overrides.fallbackKey(provider), env: getEnvApiKey(provider) };
	}

	async #resolveLocal(
		key: string,
		indirect: boolean,
		signal: AbortSignal | undefined,
		serviceTierUnavailable?: true,
	): Promise<ResolvedApiKey | undefined> {
		const apiKey = indirect ? await this.#overrides.resolve(key) : key;
		signal?.throwIfAborted();
		if (apiKey === undefined) return undefined;
		return serviceTierUnavailable ? { apiKey, serviceTierUnavailable } : { apiKey };
	}

	async #materialize(
		provider: string,
		sessionId: string | undefined,
		keys: LocalKeys,
		reply: unknown,
		signal?: AbortSignal,
	): Promise<ResolvedApiKey | undefined> {
		signal?.throwIfAborted();
		if (!isRecord(reply)) throw invalidResolution();
		if (reply.kind === "missing") return undefined;
		if (reply.kind === "error") {
			throwResolutionError(provider, sessionId, keys.configOverride !== undefined, reply.category);
		}
		if (reply.kind === "local") {
			let key: string | undefined;
			let indirect = false;
			switch (reply.source) {
				case "runtime":
					key = keys.runtime;
					break;
				case "config-override":
					key = keys.configOverride;
					indirect = true;
					break;
				case "config-fallback":
					key = keys.configFallback;
					indirect = true;
					break;
				case "env":
					key = keys.env;
					break;
			}
			if (key === undefined) throw invalidResolution();
			this.#requireLocalAllowed(provider, sessionId, keys);
			const resolved = await this.#resolveLocal(
				key,
				indirect,
				signal,
				reply.serviceTierUnavailable === true || undefined,
			);
			this.#requireLocalAllowed(provider, sessionId, keys);
			return resolved;
		}
		if (reply.kind !== "stored" || !isRecord(reply.resolved) || typeof reply.resolved.apiKey !== "string") {
			throw invalidResolution();
		}
		const { resolved, needsResolution, recoveryHandle } = reply as StoredKey;
		if (needsResolution === true) {
			this.#requireLocalAllowed(provider, sessionId, keys);
			const apiKey = await this.#overrides.resolve(resolved.apiKey);
			signal?.throwIfAborted();
			this.#requireLocalAllowed(provider, sessionId, keys);
			return apiKey === undefined ? undefined : { ...resolved, apiKey };
		}
		if (typeof recoveryHandle !== "string") return resolved;
		const oauthAccess = selectedOAuthAccess(provider, resolved.apiKey);
		const scope = JSON.stringify([provider, sessionId]);
		let recoveries = this.#recovery.get(scope);
		if (recoveries === undefined) {
			recoveries = new LRUCache<string, Recovery>({ max: 8 });
			this.#recovery.set(scope, recoveries);
		}
		recoveries.set(oauthAccess, { bearer: resolved.apiKey, handle: recoveryHandle });
		return { ...resolved, oauthAccess };
	}

	/** Forget provenance issued by a replaced daemon lease. */
	clearResolutionHandles(): void {
		this.#recovery.clear();
	}

	/** Look up owner-issued provenance without consuming the handle or exposing the bearer. */
	resolutionHandle(provider: string, sessionId: string | undefined, bearer: string): string | undefined {
		const recoveries = this.#recovery.get(JSON.stringify([provider, sessionId]));
		if (recoveries === undefined) return undefined;
		for (const recovery of recoveries.values()) {
			if (recovery.bearer === bearer) return recovery.handle;
		}
		return undefined;
	}

	#requireLocalAllowed(provider: string, sessionId: string | undefined, keys: LocalKeys): void {
		if (this.#options.isRestricted(provider, sessionId)) {
			throw missingRestricted(provider, sessionId, keys.configOverride !== undefined);
		}
	}

	source(provider: string, { env = "dedicated" }: AuthSourceOptions = {}): AuthSource | undefined {
		if (providerPauseReason(provider) !== undefined) return undefined;
		if (this.#overrides.runtimeKey(provider) !== undefined) return { kind: "runtime", concrete: true };
		if (this.#overrides.configKey(provider) !== undefined) return { kind: "config", concrete: true };
		const metadata = this.#options.availabilityLookup(provider);
		if (storedSource(metadata, "oauth")) return { kind: "oauth", concrete: true };
		if (storedSource(metadata, "login")) return { kind: "api_key", concrete: true };
		if (this.#overrides.fallbackKey(provider) !== undefined) return { kind: "config", concrete: true };
		const storedKey = storedSource(metadata, "api_key");
		return (
			environmentSource(provider, env, storedKey !== undefined) ?? (storedKey && { kind: "api_key", concrete: true })
		);
	}

	keyless(provider: string): boolean {
		return (
			providerPauseReason(provider) === undefined && this.#options.availabilityLookup(provider)?.keyless === true
		);
	}

	describe(provider: string, sessionId?: string): string | undefined {
		if (providerPauseReason(provider) !== undefined) return undefined;
		if (this.#overrides.runtimeKey(provider) !== undefined) return "runtime override (--api-key)";
		if (this.#overrides.configKey(provider) !== undefined) return "config override (models.yml)";
		const base = this.#options.sourceLabel?.() ?? "local store";
		const metadata = this.#options.availabilityLookup(provider, sessionId);
		const oauth = storedSource(metadata, "oauth");
		if (oauth?.type === "oauth") {
			const identity = oauth.email ?? oauth.accountId ?? oauth.projectId ?? `cred ${oauth.id}`;
			return `${base} · oauth #${oauth.id} (${identity})`;
		}
		const login = storedSource(metadata, "login");
		if (login) return `${base} · api_key #${login.id} (cred ${login.id})`;
		if (this.#overrides.fallbackKey(provider) !== undefined) return "provider config (fallback)";
		if (getEnvApiKey(provider)) return `env (over ${base})`;
		const stored = storedSource(metadata, "api_key", true);
		if (stored) return `${base} · api_key #${stored.id} (cred ${stored.id})`;
		return undefined;
	}

	hasOverride(provider: string): boolean {
		return this.#overrides.has(provider);
	}

	suppressesOAuth(provider: string, sessionId?: string): boolean {
		return this.#overrides.suppressesOAuth(provider, this.#options.isRestricted(provider, sessionId));
	}

	setRuntime(provider: string, apiKey: string): void {
		this.#overrides.setRuntime(provider, apiKey);
	}

	removeRuntime(provider: string): void {
		this.#overrides.removeRuntime(provider);
	}

	setConfig(provider: string, config: string, options?: { fallback?: boolean }): void {
		this.#overrides.setConfig(provider, config, options);
	}

	removeConfig(provider: string): void {
		this.#overrides.removeConfig(provider);
	}

	clearConfig(): void {
		this.#overrides.clearConfig();
	}

	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#overrides.setResolver(resolver);
	}

	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, modelId } = options ?? {};
		const served = new LRUCache<string, ResolvedApiKey>({ max: 8 });
		const resolve = async (extra: AuthApiKeyOptions): Promise<ResolvedApiKey | undefined> => {
			const result = await this.getWithCredential(provider, sessionId, { modelId, ...extra });
			if (result) served.set(result.apiKey, result);
			return result;
		};
		return async ({ lastChance, error, signal, previousKey, serviceTier }) => {
			if (error === undefined) return resolve({ signal, serviceTier });
			const previous = previousKey === undefined ? undefined : served.get(previousKey);
			if (lastChance) {
				const rotation = await this.#options.rotate(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
					credentialId: previous?.credentialId,
				});
				return resolveAfterRotation(rotation, error, () => resolve({ signal, serviceTier }));
			}
			return resolve({
				forceRefresh: true,
				refreshReason: refreshReasonFor(error),
				rejectedAccessToken: previous?.oauthAccess,
				signal,
				serviceTier,
			});
		};
	}
}
