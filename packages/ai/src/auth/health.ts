import type { Provider } from "../types";
import { resolveUsedFraction } from "../usage";
import type {
	CredentialRankingContext,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageReport,
} from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import { credentialBlockScopesForRequest, providerTypeKey } from "./blocks";
import type { CredentialBlocks } from "./blocks";
import type { KeyCascade, KeyOverrides } from "./cascade";
import type { AccountPolicies } from "./policy";
import type { CredentialPool, StoredCredential } from "./pool";
import type { OAuthRefresher } from "./refresh";
import type { AuthCredentialStore } from "./store";
import type {
	CheckCredentialsOptions,
	CompletionProbeCredential,
	CredentialHealthResult,
	HealthApi,
	ModelUsageAccountHealth,
	ModelUsageHealth,
	ModelUsageHealthOptions,
} from "./types";
import { buildRefreshableOauthCredential, mergeRefreshedUsageCredential } from "./usage";
import type { UsageService } from "./usage";
import { REMOTE_REFRESH_SENTINEL } from "./types";
import { oauthUsageRequest, usageCacheIdentity, usageRequest } from "./usage-cache";
import type { UsageRequestDescriptor } from "./usage-cache";
import { isUsageLimitExhausted, reserveUsageLimits, usageReportMetadataValue } from "./usage-report";

/** Dependencies for model pool health and stored credential probes. */
export interface CredentialHealthDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	keys: KeyCascade;
	policies: AccountPolicies;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	refresher: OAuthRefresher;
	overrides: KeyOverrides;
	strategies: RankingStrategyResolver;
}

/** Model-level pool health and per-credential auth probes. */
export class CredentialHealth implements HealthApi {
	#deps: CredentialHealthDeps;

	constructor(deps: CredentialHealthDeps) {
		this.#deps = deps;
	}

	/**
	 * Translate a refreshed {@link UsageCredential} into the public
	 * {@link CompletionProbeCredential} shape. Returns `null` when the
	 * credential lacks any usable bearer bytes (e.g. an API-key row with an
	 * empty key, or an OAuth row that never had an `access` token written).
	 */
	#buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
		if (credential.type === "api_key") {
			return credential.apiKey ? { type: "api_key", apiKey: credential.apiKey } : null;
		}
		if (!credential.accessToken) return null;
		return {
			type: "oauth",
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	/**
	 * Inspect the credential pool that {@link getApiKey} would use for one model
	 * without advancing round-robin state or changing session stickiness.
	 *
	 * Pool aggregation is deliberately conservative: one healthy sibling makes
	 * the model healthy, while any unknown sibling prevents a depleted/reserve
	 * conclusion. Static runtime/config/env credentials return unknown because
	 * they bypass the managed account pool.
	 */
	async model(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		options.signal?.throwIfAborted();
		const origin = this.#deps.keys.source(provider);
		const strategy = this.#deps.strategies(provider);
		const usageProvider = this.#deps.usage.providerFor(provider);
		const canFetchOAuthUsage = usageProvider !== undefined || this.#deps.store.getUsageReport !== undefined;
		if (
			!origin ||
			(origin.kind !== "oauth" && origin.kind !== "api_key") ||
			(strategy === undefined && (origin.kind !== "oauth" || !canFetchOAuthUsage))
		) {
			return { state: "unknown", accounts: [] };
		}

		const stored = this.#deps.pool.entries(provider).map((entry, index) => ({
			entry,
			index,
		}));
		const oauthPool = stored.filter(({ entry }) => entry.credential.type === "oauth");
		const apiKeyPool = stored.filter(({ entry }) => entry.credential.type === "api_key");
		const loginApiKeyPool = apiKeyPool.filter(
			({ entry }) => entry.credential.type === "api_key" && entry.credential.source === "login",
		);
		const pool = origin.kind === "oauth" ? oauthPool : loginApiKeyPool;
		if (pool.length === 0) return { state: "unknown", accounts: [] };
		const sessionCredential = this.#deps.affinity.get(provider, options.sessionId);
		const selectedCredentialId =
			sessionCredential?.type === origin.kind
				? this.#deps.pool.entries(provider)[sessionCredential.index]?.id
				: undefined;

		const rankingContext: CredentialRankingContext = {
			modelId: options.modelId,
		};
		const planGate = strategy?.planGate?.(rankingContext);
		const planEligibilityByCredential = new Map<number, boolean | undefined>();
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const reserveFraction = Number.isFinite(options.reserveFraction)
			? Math.max(0, Math.min(1, options.reserveFraction))
			: this.#deps.policies.defaultReservePct / 100;

		const resolveReserveFraction = (entry: StoredCredential): number => {
			const policy = this.#deps.policies.forCredential(provider, entry.credential);
			const configured = policy?.reservePct;
			return configured === undefined || !Number.isFinite(configured)
				? reserveFraction
				: Math.max(0, Math.min(1, configured / 100));
		};
		const nowMs = Date.now();
		let accounts = await Promise.all(
			pool.map(async ({ entry, index }): Promise<ModelUsageAccountHealth> => {
				const credentialType = entry.credential.type;
				const providerKey = providerTypeKey(provider, credentialType);
				let blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScopes);
				// A block under a scope the strategy can vouch for must still fetch
				// a probe report, or it outlives the recovery that report would
				// prove: no report means no reconciliation, so the credential idles
				// until the clock runs out even after quota is restored.
				if (blockedUntil !== undefined && !this.#deps.blocks.canHeal(provider, providerKey, index, blockScopes)) {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}

				let report: UsageReport | null;
				try {
					report = await raceSignal(
						this.#deps.usage.report(provider, entry.credential, {
							baseUrl: options.baseUrl,
							timeoutMs: this.#deps.usage.requestTimeoutMs,
							signal: options.signal,
						}),
						options.signal,
						"usage fetch aborted",
					);
				} catch (error) {
					if (options.signal?.aborted) throw error;
					report = null;
				}
				if (planGate) {
					planEligibilityByCredential.set(entry.id, planGate(report));
				}

				if (this.#deps.blocks.supportsHealing(provider)) {
					blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScopes);
				}
				if (blockedUntil !== undefined) {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}
				if (!report) return { credentialId: entry.id, credentialType, state: "unknown" };

				const limits = reserveUsageLimits(strategy, report, rankingContext);
				if (limits.length === 0) return { credentialId: entry.id, credentialType, state: "unknown" };

				const currentLimits = limits.filter(limit => {
					const resetsAt = limit.window?.resetsAt;
					return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
				});
				if (currentLimits.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const activeExhausted = currentLimits.filter(limit => isUsageLimitExhausted(limit));
				if (activeExhausted.length > 0) {
					const futureResets = activeExhausted
						.map(limit => limit.window?.resetsAt)
						.filter((resetsAt): resetsAt is number => resetsAt !== undefined && resetsAt > nowMs);
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: futureResets.length > 0 ? Math.min(...futureResets) : undefined,
					};
				}

				const usedFractions = currentLimits
					.map(resolveUsedFraction)
					.filter((fraction): fraction is number => fraction !== undefined);
				if (usedFractions.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const remainingFraction = Math.max(0, 1 - Math.max(...usedFractions));
				return {
					credentialId: entry.id,
					credentialType,
					state: remainingFraction <= resolveReserveFraction(entry) ? "reserve" : "healthy",
					remainingFraction,
				};
			}),
		);
		if (planGate) {
			accounts = accounts.filter(account => planEligibilityByCredential.get(account.credentialId) !== false);
		}
		if (selectedCredentialId !== undefined) {
			const selectedAccount = accounts.find(account => account.credentialId === selectedCredentialId);
			if (selectedAccount) selectedAccount.selected = true;
		}

		if (accounts.some(account => account.state === "healthy")) return { state: "healthy", accounts };
		if (accounts.some(account => account.state === "unknown")) return { state: "unknown", accounts };
		if (accounts.some(account => account.state === "reserve")) return { state: "reserve", accounts };
		return { state: "depleted", accounts };
	}
	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link UsageService.reports} (OAuth refresh-on-expiry,
	 * then `UsageProvider.fetchUsage`) but does NOT swallow errors — every
	 * credential gets either `ok: true`, `ok: false` with `reason`, or
	 * `ok: null` when no probe is configured for the provider.
	 *
	 * Iterates sequentially to avoid synchronized N-account fan-out that
	 * upstream `/usage` rate limiters (per source IP) treat as a burst.
	 *
	 * Only inspects active rows from {@link AuthCredentialStore.listAuthCredentials};
	 * soft-disabled rows are already known-bad and don't need a network probe.
	 * Environment-variable API keys are not enumerated — the caller's intent
	 * here is "which of my stored credentials is broken".
	 *
	 * Pass {@link CheckCredentialsOptions.completionProbe} to additionally
	 * exercise each credential against the provider's chat-completion endpoint
	 * (strict mode). The result lands on
	 * {@link CredentialHealthResult.completion}; the usage `ok` field is
	 * unchanged so callers can tell the two signals apart.
	 */
	async check(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const stored = this.#deps.store.listAuthCredentials();

		const timeoutMs = options?.timeoutMs ?? this.#deps.usage.requestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#deps.usage.fetch,
			logger: this.#deps.usage.logger,
		};

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			let initialRequest: UsageRequestDescriptor;
			if (cred.type === "api_key") {
				// Stored keys may be references (env var name, "!command") — probe
				// with the resolved secret, not the reference string, so both the
				// usage probe and the completion probe exercise the real bytes.
				const apiKey = await this.#deps.overrides.resolve(cred.key);
				if (!apiKey) {
					base.reason = "api key reference could not be resolved";
					results.push(base);
					continue;
				}
				initialRequest = usageRequest(row.provider as Provider, { type: "api_key", apiKey }, baseUrl);
			} else {
				initialRequest = oauthUsageRequest(row.provider as Provider, cred, baseUrl);
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const probeSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: usageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request). The
			// refreshed bytes feed BOTH the usage probe and the optional
			// completion probe; we do it up-front so it runs even when no
			// `UsageProvider` is registered for this provider.
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#deps.refresher.refresh(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#deps.usage.persistRefreshedCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
							row.id,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: usageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						refreshError = `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}

			if (refreshError) {
				base.ok = false;
				base.reason = refreshError;
				// Refresh failed → the access token is unusable. Skip both probes;
				// they would only re-surface the same upstream failure.
				results.push(base);
				continue;
			}

			const providerImpl = this.#deps.usage.providerFor(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = usageReportMetadataValue(report, "accountId");
						const email = usageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = error instanceof Error ? error.message : String(error);
				}
			}

			if (completionProbe) {
				const probeCred = this.#buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeoutSignal = AbortSignal.timeout(completionTimeoutMs);
					const completionSignal = options?.signal
						? AbortSignal.any([options.signal, completionTimeoutSignal])
						: completionTimeoutSignal;
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionSignal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error),
						};
					}
				}
			}

			results.push(base);
		}

		return results;
	}
}
