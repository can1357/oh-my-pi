import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $pickenv, logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import { copyUsageReport, handUsageCredential, handUsageLogger, resolveUsedFraction } from "../usage";
import type {
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingContext,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "../usage";
import { DEFAULT_USAGE_PROVIDERS } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import type { CredentialBlocks } from "./blocks";
import type { KeyOverrides } from "./cascade";
import {
	buildUsageCredential,
	oauthUsageRequest,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_HEADER_INGEST_INTERVAL_MS,
	usageCacheIdentity,
	usageRequest,
} from "./usage-cache";
import type { UsageCache, UsageRequestDescriptor } from "./usage-cache";
import type { CredentialPool } from "./pool";
import type { RankingStrategyResolver } from "../usage/registry";
import { mergeRefreshedOrganizationScope, OAUTH_REFRESH_SKEW_MS } from "./refresh";
import type { OAuthRefresher } from "./refresh";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { AuthCredentialStore } from "./store";
import type { AuthCredential, OAuthCredential, ObservedUsageInput, UsageApi, UsageProviderRegistration } from "./types";
import { AdmittedSignal, callThroughGate, selectLiveRegistration } from "./provider-gate";
import type { ProviderCallGate } from "./provider-gate";
import {
	dedupeUsageReports,
	isUsageLimitExhausted,
	scopedUsageLimits,
	usageReportMetadataValue,
	usageReportScopeAccountId,
} from "./usage-report";

/** Convert an OAuth usage credential into a refreshable stored shape; used by probes and health. */
export function buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
	if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
		return null;
	}
	return {
		type: "oauth",
		access: credential.accessToken,
		refresh: credential.refreshToken,
		expires: credential.expiresAt,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
		region: credential.region,
		inferenceRegion: credential.inferenceRegion,
		activeOrganizationId: credential.activeOrganizationId,
	};
}

/** Merge refreshed OAuth tokens and identity into a usage credential; used by probes and health. */
export function mergeRefreshedUsageCredential(
	credential: UsageCredential,
	refreshed: OAuthCredentials,
): UsageCredential {
	return {
		...credential,
		accessToken: refreshed.access,
		refreshToken: refreshed.refresh,
		expiresAt: refreshed.expires,
		accountId: refreshed.accountId ?? credential.accountId,
		projectId: refreshed.projectId ?? credential.projectId,
		email: refreshed.email ?? credential.email,
		enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
		apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
		...mergeRefreshedOrganizationScope(credential, refreshed),
	};
}

/** Dependencies for usage fetching and cache coordination; supplied by AuthStorage. */
export interface UsageServiceDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	overrides: KeyOverrides;
	refresher: OAuthRefresher;
	cache: UsageCache;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	strategies: RankingStrategyResolver;
	usageProviders: (provider: Provider) => UsageProvider | undefined;
	fetch: typeof fetch;
	requestTimeoutMs: number;
	logger: UsageLogger;
}

type UsageReportsOptions = {
	provider?: Provider;
	baseUrlResolver?: (provider: Provider) => string | undefined;
	signal?: AbortSignal;
};

/**
 * One usage probe's report and the runtime registration that produced it — undefined when the
 * configured resolver answered, or nothing did. A result belongs to its producer: once that is no
 * longer the registration in force, the result is not recorded for the provider.
 */
type UsageProbeOutcome = { report: UsageReport | null; runtime?: UsageProviderRegistration };

/** Usage reports: per-credential cached fetches, aggregate reports, header ingestion, history. */
export class UsageService implements UsageApi {
	#deps: UsageServiceDeps;
	/**
	 * Runtime registrations per provider, newest last. Several sessions may register the same
	 * provider (a subagent rebinding its parent's extensions does), so the one in force is a
	 * selection: the newest whose owner is live, else the configured/default resolver. Each provider
	 * is stored exactly as its author supplied it.
	 */
	#runtimeUsageProviderOverrides: Map<Provider, UsageProviderRegistration[]> = new Map();
	/** One probe per credential report key, tagged with the refresh epoch it can answer. */
	#usageRequestInFlight: Map<string, { refreshEpoch: number; promise: Promise<UsageReport | null> }> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	readonly fetch: typeof fetch;
	readonly logger: UsageLogger;
	readonly requestTimeoutMs: number;

	constructor(deps: UsageServiceDeps) {
		this.#deps = deps;
		this.fetch = deps.fetch;
		this.logger = deps.logger;
		this.requestTimeoutMs = deps.requestTimeoutMs;
	}

	/** Whether OAuth usage can be fetched via a provider or the store hook. */
	canFetchOAuthUsage(provider: Provider): boolean {
		return this.providerFor(provider) !== undefined || this.#deps.store.getUsageReport !== undefined;
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	providerFor(provider: Provider): UsageProvider | undefined {
		return this.#liveRuntimeEntry(provider)?.provider ?? this.#deps.usageProviders(provider);
	}

	/**
	 * The registration answering for `provider`: the newest live runtime registration, else the
	 * configured/default resolver's provider with no gate. Every call into a usage provider goes
	 * through the entry this returns, so it runs through its owner's gate.
	 */
	providerEntryFor(provider: Provider): UsageProviderRegistration | undefined {
		const runtime = this.#liveRuntimeEntry(provider);
		if (runtime) return runtime;
		const configured = this.#deps.usageProviders(provider);
		return configured ? { provider: configured } : undefined;
	}

	/**
	 * The answering provider's `cacheVersion`, for the usage cache's keys. The read is the
	 * author's code (it may be a getter) on the path of every cache lookup, so it runs through the
	 * owner's gate and a throw or a refusal means no version rather than a failed lookup.
	 */
	cacheVersionFor(provider: Provider): number | undefined {
		const entry = this.providerEntryFor(provider);
		if (!entry) return undefined;
		try {
			return callThroughGate(entry.gate, () => entry.provider.cacheVersion);
		} catch (error) {
			logger.debug("Usage provider cache version unavailable; keying without it", {
				provider,
				error: String(error),
			});
			return undefined;
		}
	}

	/**
	 * Install a runtime usage provider override (not persisted to disk).
	 *
	 * Runtime overrides are checked before the configured resolver, including its built-in
	 * fallback. The newest registration whose owner is live answers; registering again with the
	 * same `gate` replaces that owner's registration in place instead of stacking another.
	 */
	setProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string, gate?: ProviderCallGate): void {
		const registration: UsageProviderRegistration = { provider: usageProvider, apiKey, gate };
		const entries = this.#runtimeUsageProviderOverrides.get(provider);
		const index = entries ? entries.findIndex(entry => entry.gate === gate) : -1;
		if (!entries) this.#runtimeUsageProviderOverrides.set(provider, [registration]);
		else if (index >= 0) entries[index] = registration;
		else entries.push(registration);
		this.#deps.cache.invalidateForProvider(provider);
	}
	/** Carry runtime usage provider overrides over from the service this one replaces (store swap). */
	adoptRuntimeProviders(previous: UsageService): void {
		this.#runtimeUsageProviderOverrides = previous.#runtimeUsageProviderOverrides;
	}

	/**
	 * Remove runtime usage registrations for `provider`: the one `gate` owns when a gate is
	 * given, every one of them otherwise — what a host teardown means.
	 *
	 * The gate argument keeps the meaning it has always had. Making it the whole-teardown call
	 * regardless would silently widen every existing gated caller, which is the shape of defect
	 * this round exists to remove. {@link removeRegistration} is the separate case: the HOST's
	 * own ungated registration, which `undefined` cannot express here.
	 */
	removeProvider(provider: Provider, gate?: ProviderCallGate): void {
		if (gate) {
			this.removeRegistration(provider, gate);
			return;
		}
		if (!this.#runtimeUsageProviderOverrides.has(provider)) return;
		this.#deps.cache.invalidateForProvider(provider);
		this.#runtimeUsageProviderOverrides.delete(provider);
	}

	/**
	 * Remove exactly one runtime registration for `provider`: the one `gate` owns, or the host's
	 * own — the ungated one — when `gate` is undefined. Every other registration for the name stays
	 * to be selected, so one party handing off or withdrawing takes away only its own.
	 */
	removeRegistration(provider: Provider, gate: ProviderCallGate | undefined): void {
		// Selecting first drops retired owners' registrations, so what is left is live.
		const selected = this.#liveRuntimeEntry(provider);
		const entries = this.#runtimeUsageProviderOverrides.get(provider);
		const index = entries ? entries.findIndex(entry => entry.gate === gate) : -1;
		if (!entries || index < 0) return;
		// Invalidate while the departing registration still answers, as the teardown does, so its
		// rows go and the next answerer's survive. Removing one that does not answer changes nothing
		// a reader sees.
		if (entries[index] === selected) this.#deps.cache.invalidateForProvider(provider);
		entries.splice(index, 1);
		if (entries.length === 0) this.#runtimeUsageProviderOverrides.delete(provider);
	}

	/**
	 * The newest runtime registration for `provider` whose owner is live. Registrations of retired
	 * owners are dropped here; when the newest one was among them a different provider answers
	 * from now on, so the cache is invalidated as {@link setProvider} and {@link removeProvider} do.
	 */
	#liveRuntimeEntry(provider: Provider): UsageProviderRegistration | undefined {
		const entries = this.#runtimeUsageProviderOverrides.get(provider);
		if (!entries) return undefined;
		const selected = selectLiveRegistration(entries);
		if (entries.every(entry => entry.gate?.retired !== true)) return selected;
		const live = entries.filter(entry => entry.gate?.retired !== true);
		if (live.length === 0) this.#runtimeUsageProviderOverrides.delete(provider);
		else this.#runtimeUsageProviderOverrides.set(provider, live);
		// After the prune, so the invalidation's own key lookup selects without re-entering here.
		if (selected !== entries[entries.length - 1]) this.#deps.cache.invalidateForProvider(provider);
		return selected;
	}

	/** Providers with a live runtime registration. Selection may delete the key being visited,
	 *  which Map iteration tolerates. */
	#liveRuntimeProviders(): Provider[] {
		const providers: Provider[] = [];
		for (const provider of this.#runtimeUsageProviderOverrides.keys()) {
			if (this.#liveRuntimeEntry(provider)) providers.push(provider);
		}
		return providers;
	}

	/**
	 * Asks the selected provider whether it handles `request`. Reading `supports` is the author's
	 * code as much as calling it (it may be a getter), so it is read once, and the read and the call
	 * run through the owner's gate inside one guard, with the provider as the receiver. `undefined`
	 * means the provider gave no answer — it threw, or its owner retired after selection — which
	 * costs that provider alone.
	 *
	 * `signal` is the request's bridge when the request carries one. The author sees the admitted
	 * signal here as it does at every other call. The bridge must exist before this check, which
	 * is the first call to the USAGE provider on that path — the author's `cacheVersion` getter
	 * and a near-expiry credential refresh can both run before it, each inside its own gate.
	 */
	#supports(
		entry: UsageProviderRegistration,
		provider: Provider,
		request: UsageFetchParams,
		signal?: AdmittedSignal,
	): boolean | undefined {
		try {
			return callThroughGate(entry.gate, () => {
				const usageProvider = entry.provider;
				const supports = usageProvider.supports;
				if (!supports) return true;
				// A session's provider is handed its own copy of the credential: the host keeps the
				// request, fetches it next and keys the cache by it, so a getter or assignment on the
				// host's credential would decide those after this call.
				const handed = entry.gate
					? { ...request, credential: handUsageCredential(request.credential, provider) }
					: request;
				const admitted = signal?.admit();
				return Reflect.apply(supports, usageProvider, [admitted ? { ...handed, signal: admitted } : handed]);
			});
		} catch (error) {
			logger.debug("Usage provider support check failed; skipping provider", { provider, error: String(error) });
			return undefined;
		}
	}

	/**
	 * The answering provider's failure policy, read through its owner's gate. The shared defaults
	 * stand in when it sets none, when a getter throws, or when its owner retired after selection.
	 */
	#failurePolicy(provider: Provider): { retainLastGoodOnFailure: boolean; failureBackoffMs: number } {
		const entry = this.providerEntryFor(provider);
		if (entry) {
			try {
				return callThroughGate(entry.gate, () => ({
					retainLastGoodOnFailure: entry.provider.retainLastGoodOnFailure !== false,
					failureBackoffMs: entry.provider.failureBackoffMs ?? USAGE_FAILURE_BACKOFF_MS,
				}));
			} catch (error) {
				logger.debug("Usage provider failure policy unavailable; using defaults", {
					provider,
					error: String(error),
				});
			}
		}
		return { retainLastGoodOnFailure: true, failureBackoffMs: USAGE_FAILURE_BACKOFF_MS };
	}

	/** Preserve the persisted OAuth row's login anchor and subtype metadata on usage-path refresh. */
	persistRefreshedCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId = this.#deps.pool.findIdForUsageCredential(provider, previous),
	): void {
		if (credentialId === undefined) return;
		const entry = this.#deps.pool.entries(provider).find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth") return;
		this.#deps.pool.replaceById(provider, credentialId, {
			...entry.credential,
			access: next.accessToken ?? entry.credential.access,
			refresh: next.refreshToken ?? entry.credential.refresh,
			expires: next.expiresAt ?? entry.credential.expires,
			accountId: next.accountId ?? entry.credential.accountId,
			projectId: next.projectId ?? entry.credential.projectId,
			email: next.email ?? entry.credential.email,
			enterpriseUrl: next.enterpriseUrl ?? entry.credential.enterpriseUrl,
			apiEndpoint: next.apiEndpoint ?? entry.credential.apiEndpoint,
			orgId: next.orgId,
			orgName: next.orgName,
			region: next.region,
			inferenceRegion: next.inferenceRegion,
			activeOrganizationId: next.activeOrganizationId,
		});
	}

	/** Probe a provider endpoint, refreshing near-expiry OAuth tokens when possible. */
	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageProbeOutcome> {
		if (!this.providerFor(request.provider)) return { report: null };

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageFetchParams = {
			...request,
			accountKey: usageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#deps.pool.findIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#deps.refresher.refresh(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = mergeRefreshedUsageCredential(request.credential, refreshed);
					this.persistRefreshedCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: usageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (request.credential.expiresAt <= Date.now() && AIError.isDefinitiveOAuthFailure(errorMsg)) {
						// The current access token is unusable, so don't replay an
						// old usage report after its rotating refresh token is revoked.
						// This changes cache state only; usage polling remains
						// non-authoritative about the credential lifecycle.
						this.#deps.cache.set(this.#deps.cache.reportKey(request), {
							value: null,
							expiresAt: 0,
						});
					}
					// Usage polling is advisory. A refresh can fail while the current
					// access token remains valid inside the refresh skew, so probe with
					// that token and never mutate credential state from this path.
					this.logger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		// Selected after the refresh: an owner that retired while it ran no longer answers, and the
		// registration in force now does. A refusal from a gate that retires after this point is
		// one failed fetch, caught below like any other.
		const runtime = this.#liveRuntimeEntry(request.provider);
		const entry = runtime ?? this.providerEntryFor(request.provider);
		if (!entry) return { report: null, runtime };

		// Built before the support check, which is the first call this path makes to the USAGE
		// provider. It is not the first author code the path reaches, and this comment has been
		// too strong twice: `report()` evaluates the author's `cacheVersion` getter while
		// building the cache key, and the block above refreshes a near-expiry credential, which
		// hands a non-leased `refreshToken` — an OAuth provider's, possibly the same
		// extension's — this request's timeout signal. Both run inside their own gates, and both
		// precede this. One bridge per request, admitted inside each gated call: the timeout
		// fires on the host's timer, long after a quick fetch is over, so the signal the usage
		// provider is handed follows the caller's only while this request runs.
		const signal = new AdmittedSignal(entry.gate, params.signal);
		if (!this.#supports(entry, request.provider, params, signal)) {
			signal.release();
			return { report: null, runtime };
		}

		try {
			const previousReport = this.#deps.cache.getStale<UsageReport | null>(
				this.#deps.cache.reportKey(request),
			)?.value;
			// A session's provider gets its own logger: the storage's is one the host keeps calling
			// after this call, so a method reassigned on it would run the author's code in every
			// later host log line, outside the session's admission.
			const context: UsageFetchContext = {
				fetch: this.fetch,
				logger: entry.gate ? handUsageLogger(this.logger) : this.logger,
				...(previousReport ? { previousReport } : {}),
			};
			const report = await callThroughGate(entry.gate, async () => {
				// And its own copy of the credential, which the host reads below to attribute the
				// report and keeps in the request it caches under.
				const handed: UsageFetchParams = { ...params, signal: signal.admit() };
				if (entry.gate) handed.credential = handUsageCredential(params.credential, request.provider);
				const answered = await entry.provider.fetchUsage(handed, context);
				// Copied where it comes back, as the session's work: what follows reads and extends
				// only the copy, never the author's report.
				return entry.gate ? copyUsageReport(answered, request.provider, "fetchUsage") : answered;
			});
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return { report, runtime };
		} catch (error) {
			// Definitive auth failure (revoked key, lapsed subscription): purge
			// the last-good report so #fetchUsageCached's failure branch can't
			// keep rendering and ranking from stale quota the way it does for
			// transient failures. Mirrors the definitive-OAuth-refresh path. Only
			// while this registration still answers: once it has been superseded,
			// the report under that key is its successor's.
			if (
				error instanceof AIError.ProviderHttpError &&
				(error.status === 401 || error.status === 403) &&
				runtime === this.#liveRuntimeEntry(request.provider)
			) {
				this.#deps.cache.set(this.#deps.cache.reportKey(request), {
					value: null,
					expiresAt: 0,
				});
			}
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return { report: null, runtime };
		} finally {
			signal.release();
		}
	}

	/** Cache a credential report with jitter and failure cooldown. */
	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		options: { timeoutMs?: number } = {},
	): Promise<UsageReport | null> {
		const timeoutMs = options.timeoutMs;
		const cacheKey = this.#deps.cache.reportKey(request);
		const failureKey = this.#deps.cache.failureKey(cacheKey);
		const now = Date.now();
		const cached = this.#deps.cache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const failure = this.#deps.cache.get<null>(failureKey);
		if (failure && failure.expiresAt > now) {
			return this.#deps.cache.lastGood(cacheKey);
		}

		// Invalidation must not fork an already-running credential probe. Share it;
		// only a refresh that postdates its start (user refresh, confirmed reset)
		// earns one successor probe.
		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) {
			const report = await inFlight.promise;
			return inFlight.refreshEpoch === this.#deps.cache.refreshEpoch(request.provider)
				? report
				: this.#fetchUsageCached(request, options);
		}
		const usageCacheEpoch = this.#deps.cache.epoch;
		const refreshEpoch = this.#deps.cache.refreshEpoch(request.provider);
		const recoveryEpoch = this.#deps.cache.recoveryEpoch(request.provider);
		const promise = (async () => {
			const { report, runtime } = await this.#fetchUsageUncached(request, timeoutMs);
			// A registration that stopped answering while it ran — its owner retired, or it was
			// withdrawn or replaced — no longer speaks for this provider. Its result answers this
			// probe and is recorded nowhere: neither cached as the successor's report nor allowed to
			// cool the successor down. Selecting here also applies a retirement nobody has looked up
			// yet, which invalidates the cache and so earns the successor its own probe below.
			if (runtime !== this.#liveRuntimeEntry(request.provider)) return report;
			// Keyed again, now, by the producer's cache version: the registration that keyed this
			// probe when it started may have retired while it ran.
			const reportKey = this.#deps.cache.reportKey(request);
			// Block marks bump the generation too: a report racing a fresh 429 may
			// predate it, so it answers this probe but is neither cached nor used
			// to heal blocks.
			const invalidated = usageCacheEpoch !== this.#deps.cache.epoch;
			if (report !== null) {
				if (invalidated) return report;
				this.#deps.blocks.reconcileRequest(request, report);
				const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#deps.cache.set(reportKey, {
					value: report,
					expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter,
				});
				this.#recordUsageHistory(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Most providers serve the last good
			// value through transient failures. Session-cookie providers can opt out
			// so an expired login does not display stale quota indefinitely. The
			// policy is the producer's: it is still the registration in force.
			const failurePolicy = this.#failurePolicy(request.provider);
			const retainLastGood = !invalidated && failurePolicy.retainLastGoodOnFailure;
			const lastGood = retainLastGood ? this.#deps.cache.lastGood(reportKey) : null;
			const failureBackoffMs = failurePolicy.failureBackoffMs;
			const backoffJitter = failureBackoffMs * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + failureBackoffMs + backoffJitter;
			// Dropping snapshots is not recovery from a failed endpoint. Persist its
			// cooldown even if a manual refresh or block update raced this probe.
			// A confirmed reset is the exception: the old failure cannot suppress
			// the first post-reset probe.
			if (recoveryEpoch === this.#deps.cache.recoveryEpoch(request.provider)) {
				this.#deps.cache.set(this.#deps.cache.failureKey(reportKey), { value: null, expiresAt: coolDown });
			}
			if (!invalidated) this.#deps.cache.set(reportKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(cacheKey);
		});

		this.#usageRequestInFlight.set(cacheKey, { refreshEpoch, promise });
		const report = await promise;
		return refreshEpoch === this.#deps.cache.refreshEpoch(request.provider)
			? report
			: this.#fetchUsageCached(request, options);
	}

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#deps.store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = usageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#deps.store, entries);
		} catch (error) {
			this.logger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	history(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#deps.store.listUsageHistory?.(query) ?? [];
	}

	/**
	 * Forward one completed request's usage to the store's observer hook.
	 * Broker-backed stores batch these into per-install reports so the broker
	 * can track actual token burn per client; local stores have no hook and
	 * the call is a no-op.
	 */
	observe(entry: ObservedUsageInput): void {
		const record = this.#deps.store.recordObservedUsage;
		if (!record) return;
		try {
			record.call(
				this.#deps.store,
				[
					{
						at: entry.at ?? Date.now(),
						provider: entry.provider,
						model: entry.model,
						requests: 1,
						inputTokens: entry.usage.input,
						outputTokens: entry.usage.output,
						cacheReadTokens: entry.usage.cacheRead,
						cacheWriteTokens: entry.usage.cacheWrite,
						costUsd: Number.isFinite(entry.costUsd) ? (entry.costUsd ?? 0) : 0,
					},
				],
				entry.client,
			);
		} catch (error) {
			this.logger?.debug("observed usage record failed", {
				provider: entry.provider,
				error: String(error),
			});
		}
	}

	/** Broker host: persist one client's observed-usage report (per-install token burn). */
	recordClient(report: ClientUsageReport): boolean {
		const record = this.#deps.store.recordClientUsage;
		if (!record) return false;
		record.call(this.#deps.store, report);
		return true;
	}

	/** Broker host: aggregate recorded per-client usage since `sinceMs`. */
	clientSummary(sinceMs: number): ClientUsageSummary {
		return this.#deps.store.getClientUsageSummary?.(sinceMs) ?? { clients: [] };
	}

	/** Merge rate-limit headers into the latest account report. */
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean {
		const entry = this.providerEntryFor(provider);
		if (!entry) return false;
		const credential = this.#deps.affinity.activeOAuth(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#deps.cache.reportKey(oauthUsageRequest(provider, credential, options?.baseUrl));
		const now = Date.now();
		// Reading the property is already the author's code: a provider may expose its parser
		// through a getter. It is read once, and that read and the call run through the owner's
		// gate inside one guard, so a retired owner's getter never runs. This runs on the response
		// path of every request and must not be able to fail one: a gate refuses by throwing, and a
		// third-party parser can throw for its own reasons. Either way there are simply no headers
		// to ingest.
		let parsedReport: UsageReport | null | undefined;
		try {
			parsedReport = callThroughGate(entry.gate, () => {
				const usageProvider = entry.provider;
				const parse = usageProvider.parseRateLimitHeaders;
				if (!parse) return undefined;
				// A session's parser is handed its own copy of the headers: the caller's record is the
				// live response's, which the agent session hands on to its response hooks after this.
				// It is a plain record (`normalizeProviderResponse` builds it), so a spread copies it.
				const parsed = Reflect.apply(parse, usageProvider, [
					entry.gate ? { ...headers } : headers,
					now,
					{ responseStatus: options?.responseStatus },
				]);
				// Copied inside the call, as the session's work: the merge below reads only the copy.
				return entry.gate ? copyUsageReport(parsed, provider, "parseRateLimitHeaders") : parsed;
			});
		} catch (error) {
			logger.debug("Rate-limit header parser failed; skipping ingest", { provider, error: String(error) });
			return false;
		}
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: persist that snapshot immediately. A full-backed cache can
		// then block the next getApiKey; a cold header-only snapshot first probes
		// the usage endpoint.
		const exhausted = parsedReport.limits.some(limit => isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...parsedReport.metadata };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#deps.store.ingestUsageReport?.bind(this.#deps.store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#deps.store.fetchUsageReports) return false;
		const priorEntry = this.#deps.cache.getStale<UsageReport | null>(cacheKey);
		const prior = priorEntry?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...report.metadata,
					...prior.metadata,
					source: prior.metadata?.source,
					headersUpdatedAt: now,
				},
			};
		}

		// Header ingestion merges values but never extends a cache entry's lifetime.
		// Preserve the existing expiry (including active failure cooldowns) so full
		// reports refetch on their original 5-minute schedule and full-payload-only
		// rows such as extra usage stay current; headers only refresh window rows
		// between fetches. A newly minted header-only report is durable but stale.
		const expiresAt = Math.max(priorEntry?.expiresAt ?? now - 1, now - 1);
		this.#deps.cache.set(cacheKey, { value: merged, expiresAt });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	/** Collect resolved account requests, restricted to runtime providers when the store owns aggregate reports. */
	async #collectUsageRequests(
		options?: UsageReportsOptions,
		providerFilter?: ReadonlySet<Provider>,
	): Promise<UsageRequestDescriptor[]> {
		const requests: UsageRequestDescriptor[] = [];
		const providers =
			providerFilter ??
			new Set<string>([
				...this.#deps.pool.providers(),
				...this.#liveRuntimeProviders(),
				...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
			]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			// A provider nobody answers for has no requests; its credentials need no work.
			if (!this.providerEntryFor(provider)) continue;
			const providerRequests = await this.#collectProviderRequests(provider, options);
			if (providerRequests) requests.push(...providerRequests);
		}

		return requests;
	}

	/**
	 * One provider's usage requests, or undefined when no registration answers for it any more,
	 * or the one in force gave no answer to whether it supports one — it threw, or its owner
	 * retired mid-check. Such a provider contributes nothing to this poll and every other provider
	 * is unaffected.
	 *
	 * Preparing the requests awaits (duplicate pruning, key resolution), and an owner can retire
	 * during any of it. So the registration that judges them — and whose key configuration feeds
	 * them — is selected after the last await, never carried across one.
	 */
	async #collectProviderRequests(
		provider: Provider,
		options?: UsageReportsOptions,
	): Promise<UsageRequestDescriptor[] | undefined> {
		const baseUrl = options?.baseUrlResolver?.(provider);
		let entries = this.#deps.pool.entries(provider);
		if (entries.length > 0) {
			const dedupedEntries = await this.#deps.pool.pruneDuplicates(provider, entries);
			if (dedupedEntries.length !== entries.length) {
				this.#deps.pool.replace(provider, dedupedEntries);
			}
			entries = dedupedEntries;
		}

		// A declared OAuth bearer env list means usage probes must ignore stored
		// API keys and borrowed API-key env aliases. Even when an API-key row
		// exists, fall back to the provider's own OAuth env bearer.
		const oauthTokenEnv = authPolicyFor(provider)?.oauthTokenEnv;
		if (oauthTokenEnv) {
			const registration = this.providerEntryFor(provider);
			if (!registration) return undefined;
			const stored: UsageRequestDescriptor[] = [];
			for (const entry of entries) {
				if (entry.credential.type === "oauth") stored.push(oauthUsageRequest(provider, entry.credential, baseUrl));
			}
			const requests = this.#supportedRequests(registration, provider, stored);
			if (requests === undefined || requests.length > 0) return requests;
			const oauthToken = $pickenv(...oauthTokenEnv);
			if (!oauthToken) return requests;
			const envRequest = usageRequest(provider, { type: "oauth", accessToken: oauthToken }, baseUrl);
			return this.#supportedRequests(registration, provider, [envRequest]);
		}

		if (entries.length === 0) {
			// The key configuration is the registration's own, so it is resolved again when a
			// different registration took over while the previous one's resolved.
			let registration = this.providerEntryFor(provider);
			let resolved: { config: string; key: string | undefined } | undefined;
			while (registration?.apiKey && registration.apiKey !== resolved?.config) {
				const config = registration.apiKey;
				resolved = { config, key: await this.#deps.overrides.resolve(config) };
				registration = this.providerEntryFor(provider);
			}
			if (!registration) return undefined;
			const extensionUsageKey =
				registration.apiKey && registration.apiKey === resolved?.config ? resolved.key : undefined;
			const apiKey = this.#deps.overrides.runtimeKey(provider) ?? extensionUsageKey ?? getEnvApiKey(provider);
			if (!apiKey) return [];
			return this.#supportedRequests(registration, provider, [
				usageRequest(provider, { type: "api_key", apiKey }, baseUrl),
			]);
		}

		const candidates: UsageRequestDescriptor[] = [];
		for (const entry of entries) {
			const credential = entry.credential;
			if (credential.type === "api_key") {
				// Stored keys may be references (env var name, "!command") —
				// resolve to the actual secret before it reaches a provider
				// fetcher's Authorization header. Unresolvable references are
				// skipped: probing with the literal reference string would
				// 401 and flag a working credential as bad.
				const apiKey = await this.#deps.overrides.resolve(credential.key);
				if (apiKey) candidates.push(usageRequest(provider, { type: "api_key", apiKey }, baseUrl));
			} else {
				candidates.push(oauthUsageRequest(provider, credential, baseUrl));
			}
		}
		const registration = this.providerEntryFor(provider);
		return registration ? this.#supportedRequests(registration, provider, candidates) : undefined;
	}

	/** The candidates `registration` supports, or undefined when it gave no answer for one of them. */
	#supportedRequests(
		registration: UsageProviderRegistration,
		provider: Provider,
		candidates: readonly UsageRequestDescriptor[],
	): UsageRequestDescriptor[] | undefined {
		const requests: UsageRequestDescriptor[] = [];
		for (const request of candidates) {
			const supported = this.#supports(registration, provider, request);
			if (supported === undefined) return undefined;
			if (supported) requests.push(request);
		}
		return requests;
	}

	/** Fetch the best available report for one stored credential. */
	async report(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#deps.store.getUsageReport?.bind(this.#deps.store);
			if (storeHook) {
				const report = await storeHook(provider, credential, options?.signal);
				if (report) {
					this.#deps.blocks.reconcileRequest(oauthUsageRequest(provider, credential, options?.baseUrl), report);
				}
				return report;
			}
		}
		const usageCredential = buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#deps.overrides.resolve(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(usageRequest(provider, usageCredential, options?.baseUrl), {
			timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs,
		});
	}

	/**
	 * Return model ids whose live reports map to a quantitative usage scope.
	 * Provider strategies supply model/tier mapping when available; otherwise
	 * only explicitly matching model ids and account-wide shared limits count.
	 * Label-only or ambiguous tier limits are excluded rather than guessed.
	 */
	reportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[] {
		const strategy = this.#deps.strategies(provider);
		const providerReports = reports.filter(report => report.provider === provider);
		if (providerReports.length === 0) return [];
		const seen = new Set<string>();
		const reporting: string[] = [];
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			const context: CredentialRankingContext = { modelId };
			const hasUsage = providerReports.some(report => {
				const limits = strategy
					? scopedUsageLimits(strategy, report, context)
					: report.limits.filter(limit => limit.scope.shared === true || limit.scope.modelId === modelId);
				return limits.some(limit => isUsageLimitExhausted(limit) || resolveUsedFraction(limit) !== undefined);
			});
			if (hasUsage) reporting.push(modelId);
		}
		return reporting;
	}

	/**
	 * Fetch every requested report, keeping normal polls parallel while a
	 * manually invalidated provider probes accounts one at a time.
	 */
	#fetchUsageRequests(
		requests: readonly UsageRequestDescriptor[],
		serializedProviders: ReadonlySet<Provider>,
	): Promise<Array<UsageReport | null>> {
		const tails = new Map<Provider, Promise<void>>();
		return Promise.all(
			requests.map(request => {
				if (!serializedProviders.has(request.provider)) {
					return this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
					});
				}
				const tail = tails.get(request.provider) ?? Promise.resolve();
				const current = tail.then(() =>
					this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
					}),
				);
				tails.set(
					request.provider,
					current.then(
						() => undefined,
						() => undefined,
					),
				);
				return current;
			}),
		);
	}

	/** Fetch all providers’ current usage reports, sharing concurrent polls. */
	async reports(options?: UsageReportsOptions): Promise<UsageReport[] | null> {
		// The broker owns its providers' reports; runtime providers registered
		// only in this process still need local per-credential probes.
		const storeOverride = this.#deps.store.fetchUsageReports?.bind(this.#deps.store);
		if (storeOverride) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const scope = options?.provider === undefined ? "*" : `provider:${options.provider}`;
			const overrideKey = `__override__\0${this.#deps.cache.epoch}\0${scope}`;
			let shared = this.#usageReportsInFlight.get(overrideKey);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = storeOverride(undefined, options?.provider).finally(() => {
					this.#usageReportsInFlight.delete(overrideKey);
				});
				this.#usageReportsInFlight.set(overrideKey, shared);
			}
			const fetched = await raceSignal(shared, options?.signal, "usage fetch aborted");
			const reports =
				fetched && options?.provider !== undefined
					? fetched.filter(report => report.provider === options.provider)
					: fetched;
			if (reports) this.#deps.blocks.reconcileReports(reports);
			if (!reports) return reports;
			const runtimeProviders = this.#liveRuntimeProviders();
			if (runtimeProviders.length === 0) return reports;

			// The broker owns its reported providers; only extension providers
			// absent from its response need local credentials and a local probe.
			const brokerProviders = new Set(reports.map(report => report.provider));
			const localProviders = new Set<Provider>();
			for (const provider of runtimeProviders) {
				if (options?.provider !== undefined && provider !== options.provider) continue;
				if (!brokerProviders.has(provider)) localProviders.add(provider);
			}
			if (localProviders.size === 0) return reports;
			const localReports = await this.#fetchLocalReports(options, localProviders);
			return localReports?.length ? [...reports, ...localReports] : reports;
		}
		return this.#fetchLocalReports(
			options,
			options?.provider !== undefined ? new Set([options.provider]) : undefined,
		);
	}

	/** Probe only the selected providers locally, preserving per-credential caching and cooldowns. */
	async #fetchLocalReports(
		options?: UsageReportsOptions,
		providerFilter?: ReadonlySet<Provider>,
	): Promise<UsageReport[] | null> {
		const requests = await this.#collectUsageRequests(options, providerFilter);
		if (requests.length === 0) return [];

		this.logger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const forcedRefresh = this.#deps.cache.forcedRefresh(requests);
		const usageCacheEpoch = this.#deps.cache.epoch;
		const cacheKey = `${this.#deps.cache.reportsKey(requests)}\0${usageCacheEpoch}`;

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return raceSignal(inFlight, options?.signal, "usage fetch aborted");

		const promise = (async () => {
			for (const request of requests) {
				this.logger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await this.#fetchUsageRequests(requests, forcedRefresh.providers);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = dedupeUsageReports(reports, this.logger);
			// no outer cache write — see comment above.
			const resolved = deduped;
			this.logger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						usageReportMetadataValue(report, "email") ??
						usageReportMetadataValue(report, "accountId") ??
						usageReportMetadataValue(report, "account") ??
						usageReportMetadataValue(report, "user") ??
						usageReportMetadataValue(report, "username") ??
						usageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			if (usageCacheEpoch === this.#deps.cache.epoch) this.#deps.cache.clearForceRefresh(forcedRefresh);
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return raceSignal(promise, options?.signal, "usage fetch aborted");
	}

	/**
	 * Discard cached usage reports before a user-requested refresh. The next
	 * read probes upstream serially per provider unless a failure cooldown is
	 * active. Failed probes never replay an invalidated last-good snapshot.
	 */
	async invalidate(provider?: string, signal?: AbortSignal): Promise<void> {
		await this.#deps.cache.clearReports(provider, () => this.#collectUsageRequests());

		if (this.#deps.store.invalidateUsageCache) {
			await this.#deps.store.invalidateUsageCache(provider, signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}
}
