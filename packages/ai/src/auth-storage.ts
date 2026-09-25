/**
 * Credential storage for API keys and OAuth tokens.
 *
 * {@link AuthStorage} composes the credential modules under `./auth/` over one
 * {@link AuthCredentialStore} and exposes them as namespaces:
 * - `credentials` — stored rows, reload/poll, change and disable events, broker snapshot
 * - `keys` — the provider auth cascade (runtime → config → OAuth → login key → env → stored key)
 * - `oauth` — login, per-account access resolution, account listings, refresh
 * - `sessions` — session → account pins
 * - `usage` — usage reports, header ingestion, history
 * - `health` — model pool health and per-credential auth probes
 * - `limits` — usage-limit marking and credential rotation
 * - `resets` — saved rate-limit resets
 * - `blocks` — persisted rate-limit blocks (auth-broker server seam)
 *
 * @example
 * const auth = await AuthStorage.create(getAgentDbPath());
 * await auth.credentials.reload();
 * const apiKey = await auth.keys.get("anthropic", sessionId, { modelId });
 */
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import { SessionAffinity } from "./auth/affinity";
import { BlockStoreHealth, CredentialBlocks } from "./auth/blocks";
import { KeyCascade, KeyOverrides } from "./auth/cascade";
import { CredentialCoordination } from "./auth/coordination";
import { CredentialHealth } from "./auth/health";
import { OAuthAccounts } from "./auth/oauth";
import { AccountPolicies } from "./auth/policy";
import { CredentialPool } from "./auth/pool";
import { QuotaProbeLeaseBook } from "./auth/probe-lease";
import { OAuthRefresher } from "./auth/refresh";
import { ResetCredits } from "./auth/resets";
import { RateLimits } from "./auth/rotation";
import { CredentialSelector } from "./auth/select";
import { SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
import type { AuthCredentialStore } from "./auth/store";
import { createHash } from "node:crypto";
import * as AIError from "./error";
import type { OAuthCredentials } from "./registry/oauth/types";
import type {
	AuthApiKeyOptions,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	AuthStorageOptions,
	BlocksApi,
	CheckCredentialsOptions,
	CredentialDisabledEvent,
	CredentialHealthResult,
	CredentialOrigin,
	CredentialsApi,
	DisabledCredentialSummary,
	HealthApi,
	KeysApi,
	LimitsApi,
	ListResetCreditsOptions,
	MarkUsageLimitOptions,
	ModelUsageHealth,
	ModelUsageHealthOptions,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthApi,
	OAuthLoginController,
	OAuthLoginIdentity,
	ObservedUsageInput,
	RedeemResetCreditOptions,
	ResetCreditRedeemOutcome,
	ResetsApi,
	SessionsApi,
	StoredAuthCredential,
	StoredCredentialBlock,
	UsageApi,
	UsageLimitMarkResult,
} from "./auth/types";
import type { TurnReservationResult } from "./auth/types";
import { UsageService } from "./auth/usage";
import { DEFAULT_USAGE_REQUEST_TIMEOUT_MS, UsageCache } from "./auth/usage-cache";
import type { ApiKeyResolver } from "./auth-retry";
import type { Provider } from "./types";
import type {
	ClientUsageReport,
	ClientUsageSummary,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import { defaultRankingStrategy, defaultUsageProvider } from "./usage/registry";

export { isSqliteBusyError, isSqliteCorruptionError, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
export * from "./auth/store";
export * from "./auth/types";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

/** SHA-256 bearer fingerprint, so superseded OAuth token bytes never enter the identity cache. */
function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}

/** Stable identity of an OAuth row. Missing/malformed fields yield null (not a switch). */
function fingerprintOAuthPhysicalIdentity(credential: AuthCredential): string | null {
	if (credential.type !== "oauth") return null;
	const parts: string[] = [];
	const accountId = credential.accountId?.trim();
	const email = credential.email?.trim().toLowerCase();
	const orgId = credential.orgId?.trim();
	if (accountId) parts.push(`account:${accountId}`);
	if (email) parts.push(`email:${email}`);
	if (orgId) parts.push(`org:${orgId}`);
	if (parts.length === 0) return null;
	return parts.join("|");
}

function identityFieldMap(fingerprint: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of fingerprint.split("|")) {
		const sep = part.indexOf(":");
		if (sep <= 0) continue;
		fields.set(part.slice(0, sep), part.slice(sep + 1));
	}
	return fields;
}

/**
 * True when fingerprints do not conflict: shared keys match, and keys present
 * on only one side are inconclusive (enrichment or temporary field omission).
 */
function isConservativeIdentityEnrichment(oldFingerprint: string, newFingerprint: string): boolean {
	const oldFields = identityFieldMap(oldFingerprint);
	const newFields = identityFieldMap(newFingerprint);
	for (const [key, value] of oldFields) {
		const next = newFields.get(key);
		if (next !== undefined && next !== value) return false;
	}
	return true;
}

function turnReservationKey(credentialId: number, incarnation: number): string {
	return `${credentialId}:${incarnation}`;
}

function anonymousProbeRequestKey(credentialId: number, blockScope: string): string {
	return `anon-probe:${credentialId}:${blockScope}`;
}

const WORKSPACE_DEACTIVATED_PATTERN = /\bdeactivated_workspace\b|\bdeactivated[_ ](?:org|organization|workspace)\b/i;
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/**
 * Anthropic-only idle window after which a session's pinned credential no
 * longer suppresses usage-based re-ranking. Anthropic caps OAuth prompt-cache
 * retention at `ttl: "1h"` (ephemeral ~5min otherwise), so after this long
 * without an Anthropic resolve the conversation-prefix cache is no longer
 * guaranteed warm. Other providers retain indefinite stickiness until their
 * own cache lifetimes are verified.
 */
const ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS = 60 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	source?: "login";
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Credential management over an {@link AuthCredentialStore}: multi-account
 * selection with usage-aware ranking, rate-limit blocks, OAuth refresh, and
 * usage reporting. See the module doc for the namespace layout.
 */
export class AuthStorage {
	/** Stored credential rows, change/disable events, broker snapshot. */
	readonly credentials: CredentialsApi;
	/** Provider auth cascade and key overrides. */
	readonly keys: KeysApi;
	/** OAuth login, account access, listings, refresh. */
	readonly oauth: OAuthApi;
	/** Session → account pins. */
	readonly sessions: SessionsApi;
	/** Usage reports, header ingestion, history. */
	readonly usage: UsageApi;
	/** Model pool health and per-credential probes. */
	readonly health: HealthApi;
	/** Usage-limit marking and credential rotation. */
	readonly limits: LimitsApi;
	/** Saved rate-limit resets. */
	readonly resets: ResetsApi;
	/** Persisted rate-limit blocks (auth-broker server seam). */
	readonly blocks: BlocksApi;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#coordination: CredentialCoordination;
	#generationUnsubscribes = new Map<(generation: number) => void, () => void>();

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		const overrides = new KeyOverrides(options.configValueResolver);
		const policies = new AccountPolicies(options.accountPolicies ?? [], options.defaultReservePct);
		const blockHealth = new BlockStoreHealth(options.sourceLabel);
		const strategies = options.rankingStrategyResolver ?? defaultRankingStrategy;
		const probeBook = new QuotaProbeLeaseBook();
		const pool = new CredentialPool(store, {
			policies,
			blockHealth,
			onReset: provider => {
				selector.resetRoundRobin(provider);
				affinity.clearProvider(provider);
			},
			onCredentialIdentityChanged: (provider, credentialId, previous, next) =>
				coordination.maybeBumpIncarnation(provider, credentialId, previous, next),
		});
		const refresher = new OAuthRefresher({ store, pool, policies, override: options.refreshOAuthCredential });
		const usageProviders = options.usageProviderResolver ?? defaultUsageProvider;
		const usageCache = new UsageCache(store, pool, usageProviders);
		const blocks = new CredentialBlocks({ store, pool, health: blockHealth, usageCache, strategies, probeBook });
		const affinity = new SessionAffinity(store, pool, overrides);
		const usage = new UsageService({
			store,
			pool,
			overrides,
			refresher,
			cache: usageCache,
			blocks,
			affinity,
			strategies,
			usageProviders,
			fetch: options.usageFetch ?? fetch,
			requestTimeoutMs: options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS,
			logger:
				options.usageLogger ??
				({
					debug: (message, meta) => logger.debug(message, meta),
					warn: (message, meta) => logger.warn(message, meta),
				} satisfies UsageLogger),
		});
		const coordination = new CredentialCoordination({
			pool,
			blocks,
			affinity,
			usageCache,
			strategies,
			probeLeases: probeBook,
		});
		const selector = new CredentialSelector({
			store,
			pool,
			policies,
			blocks,
			affinity,
			usage,
			refresher,
			strategies,
			coordination,
		});
		const limits = new RateLimits({ store, pool, overrides, blocks, affinity, usage, strategies });
		const keys = new KeyCascade({
			pool,
			overrides,
			selector,
			affinity,
			coordination,
			rotate: (provider, sessionId, rotateOptions) => limits.rotate(provider, sessionId, rotateOptions),
			sourceLabel: options.sourceLabel,
		});
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher });

		this.#pool = pool;
		this.#overrides = overrides;
		this.#coordination = coordination;
		this.credentials = pool;
		this.keys = keys;
		this.oauth = oauth;
		this.sessions = affinity;
		this.usage = usage;
		this.health = new CredentialHealth({
			store,
			pool,
			keys,
			policies,
			blocks,
			affinity,
			usage,
			refresher,
			overrides,
			strategies,
		});
		this.limits = limits;
		this.resets = new ResetCredits({ store, pool, oauth, usage, usageCache, blocks });
		this.blocks = blocks;
		if (options.onCredentialDisabled) pool.onDisabled(options.onCredentialDisabled);
	}

	/** Open the SQLite store at `dbPath` and wrap it (standalone use, e.g. the pi-ai CLI). */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/** Close the underlying credential store; the instance must not be reused. */
	close(): void {
		this.#pool.close();
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Pre-namespace flat API — kept for the coding-agent, TUI, gateway, and test
	// callers written before the module split. Everything below delegates to the
	// namespaces above; new code should use them directly.
	// ─────────────────────────────────────────────────────────────────────────────

	// Generation / events ------------------------------------------------------

	getGeneration(): number {
		return this.credentials.generation;
	}

	async pollExternalChanges(): Promise<boolean> {
		return this.credentials.poll();
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		const unsubscribe = this.credentials.onGeneration(listener);
		this.#generationUnsubscribes.set(listener, unsubscribe);
		return () => this.offGenerationChanged(listener);
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationUnsubscribes.get(listener)?.();
		this.#generationUnsubscribes.delete(listener);
	}

	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		return this.credentials.onDisabled(listener);
	}

	// Key overrides ------------------------------------------------------------

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.keys.setRuntime(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.keys.removeRuntime(provider);
	}

	setConfigApiKey(provider: string, apiKeyConfig: string): void {
		this.keys.setConfig(provider, apiKeyConfig);
	}

	removeConfigApiKey(provider: string): void {
		this.keys.removeConfig(provider);
	}

	clearConfigApiKeys(): void {
		this.keys.clearConfig();
	}

	setConfigValueResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.keys.setResolver(resolver);
	}

	setRuntimeUsageProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		this.usage.setProvider(provider, usageProvider, apiKey);
	}

	removeRuntimeUsageProvider(provider: Provider): void {
		this.usage.removeProvider(provider);
	}

	// Credentials --------------------------------------------------------------

	reload(): Promise<void> {
		return this.credentials.reload();
	}

	get(provider: string): AuthCredential | undefined {
		return this.credentials.get(provider);
	}

	set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		return this.credentials.set(provider, credential);
	}

	listStoredCredentials(provider?: string): StoredAuthCredential[] {
		return this.credentials.list(provider);
	}

	list(provider?: string): StoredAuthCredential[] {
		return this.credentials.list(provider);
	}

	remove(provider: string): Promise<void> {
		return this.credentials.remove(provider);
	}

	removeCredential(provider: string, credentialId: number): Promise<boolean> {
		return this.credentials.removeById(provider, credentialId);
	}

	has(provider: string): boolean {
		return this.credentials.has(provider);
	}

	hasOAuth(provider: string): boolean {
		return this.credentials.hasOAuth(provider);
	}

	getOAuthCredential(provider: string) {
		return this.credentials.getOAuth(provider);
	}

	getAll() {
		return this.credentials.all();
	}

	exportSnapshot(): AuthCredentialSnapshot {
		return this.credentials.snapshot();
	}

	listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		return this.credentials.listDisabled(provider, signal);
	}

	revalidateCredentials(): Promise<void> {
		return this.credentials.revalidate();
	}

	disableCredentialById(id: number, disabledCause: string): Promise<boolean> {
		return this.credentials.disable(id, disabledCause);
	}

	disableCredentialByIdAsync(id: number, disabledCause: string): Promise<boolean> {
		return this.credentials.disable(id, disabledCause);
	}

	upsertCredential(provider: string, credential: AuthCredential): Promise<AuthCredentialSnapshotEntry[]> {
		return this.credentials.upsert(provider, credential);
	}

	// Auth-source classification ------------------------------------------------

	getCredentialOrigin(provider: string): CredentialOrigin | undefined {
		return this.keys.source(provider);
	}

	describeCredentialSource(provider: string, sessionId?: string): string | undefined {
		return this.keys.describe(provider, sessionId);
	}

	hasKeylessPlaceholder(provider: string): boolean {
		return this.keys.keyless(provider);
	}

	hasAuth(provider: string): boolean {
		return this.keys.source(provider) !== undefined;
	}

	hasConcreteAuth(provider: string): boolean {
		return this.keys.source(provider)?.concrete === true;
	}

	hasResolvableAuth(provider: string): boolean {
		return this.keys.source(provider, { env: "aliases" }) !== undefined;
	}

	hasNonEnvCredential(provider: string): boolean {
		const source = this.keys.source(provider);
		return source !== undefined && source.kind !== "env";
	}

	// Key resolution ------------------------------------------------------------

	peekApiKey(provider: string): Promise<string | undefined> {
		return this.keys.peek(provider);
	}

	/**
	 * Sync peek of runtime/config override credentials only.
	 *
	 * Mirrors the first two legs of {@link peekApiKey} / {@link getApiKey}
	 * (CLI `--api-key`, then `models.yml` `providers.*.apiKey`) so synchronous
	 * callers — e.g. credential-scoped startup cache hashing — share the same
	 * precedence without inventing a second ordering.
	 */
	peekApiKeyOverrides(provider: string): string | undefined {
		return this.#overrides.runtimeKey(provider) ?? this.#overrides.configKey(provider);
	}

	getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		return this.keys.get(provider, sessionId, options);
	}

	resolver(
		provider: string,
		options?: { sessionId?: string; baseUrl?: string; modelId?: string },
	): ApiKeyResolver {
		return this.keys.resolver(provider, options);
	}

	// OAuth --------------------------------------------------------------------

	login(provider: Parameters<OAuthApi["login"]>[0], ctrl: OAuthLoginController): Promise<OAuthLoginIdentity | undefined> {
		return this.oauth.login(provider, ctrl);
	}

	async logout(provider: string): Promise<void> {
		await this.credentials.remove(provider);
	}

	getOAuthAccess(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<OAuthAccess | undefined> {
		return this.oauth.access(provider, sessionId, options);
	}

	getOAuthAccesses(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		return this.oauth.accessAll(provider, options);
	}

	getOAuthAccessAt(
		provider: string,
		position: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		const account = this.oauth.accounts(provider)[position];
		if (!account) return Promise.resolve(undefined);
		return this.oauth.accessById(provider, account.credentialId, options);
	}

	getOAuthAccessByCredentialId(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		return this.oauth.accessById(provider, credentialId, options);
	}

	listOAuthAccounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		return this.oauth.accounts(provider, sessionId);
	}

	getOAuthAccountId(provider: string, sessionId?: string): string | undefined {
		const accountId = this.oauth.identity(provider, sessionId)?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	getOAuthAccountIdentity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		return this.oauth.identity(provider, sessionId);
	}

	refreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.oauth.refresh(id, signal);
	}

	forceRefreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.oauth.refresh(id, signal);
	}

	pinSessionOAuthAccount(
		provider: string,
		sessionId: string,
		credentialId: number,
		options?: { lastUsedAtMs?: number },
	): boolean {
		return this.sessions.pin(provider, sessionId, credentialId, { restoredAtMs: options?.lastUsedAtMs });
	}

	inheritSessionCredentials(sourceSessionId: string, targetSessionId: string): number {
		return this.sessions.inherit(sourceSessionId, targetSessionId);
	}

	releaseSessionCredentialForReselection(provider: string, sessionId: string): boolean {
		return this.sessions.release(provider, sessionId);
	}

	// Usage --------------------------------------------------------------------

	fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		return this.usage.reports(options);
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.usage.history(query);
	}

	recordObservedUsage(entry: ObservedUsageInput): void {
		this.usage.observe(entry);
	}

	recordClientUsage(report: ClientUsageReport): boolean {
		return this.usage.recordClient(report);
	}

	getClientUsageSummary(sinceMs: number): ClientUsageSummary {
		return this.usage.clientSummary(sinceMs);
	}

	ingestUsageHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean {
		return this.usage.ingestHeaders(provider, headers, options);
	}

	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.usage.providerFor(provider);
	}

	getUsageReportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[] {
		return this.usage.reportingModelIds(provider, modelIds, reports);
	}

	invalidateUsageCache(provider?: Provider, signal?: AbortSignal): Promise<void> {
		return this.usage.invalidate(provider, signal);
	}

	// Health -------------------------------------------------------------------

	getModelUsageHealth(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		return this.health.model(provider, options);
	}

	checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		return this.health.check(options);
	}

	// Rate limits / rotation ----------------------------------------------------

	markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageLimitOptions,
	): Promise<UsageLimitMarkResult> {
		return this.limits.markReached(provider, sessionId, options);
	}

	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: Parameters<LimitsApi["rotate"]>[2],
	): Promise<boolean> {
		return this.limits.rotate(provider, sessionId, options);
	}

	invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		options?: Parameters<LimitsApi["invalidateMatching"]>[2],
	): Promise<boolean> {
		return this.limits.invalidateMatching(provider, apiKey, options);
	}

	// Reset credits --------------------------------------------------------------

	listResetCredits(options?: ListResetCreditsOptions) {
		return this.resets.list(options);
	}

	redeemResetCredit(options: RedeemResetCreditOptions): Promise<ResetCreditRedeemOutcome> {
		return this.resets.redeem(options);
	}

	// Persisted blocks -----------------------------------------------------------

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		return this.blocks.list(credentialIds);
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		this.blocks.upsert(block);
	}

	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
		this.blocks.delete(credentialId, providerKey, blockScope);
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.blocks.deleteAll(credentialId);
	}

	// In-process coordination (fork feature: probe leases, ---------
	// incarnation tracking) ------------------------------------------------------

	/**
	 * True when the provider has stored credentials but every candidate is under
	 * an active backoff / Retry-After / probe-lease hold (so getApiKey returned
	 * undefined for quota reasons rather than missing auth).
	 */
	hasCoolingDownCredentials(provider: string, modelId?: string): boolean {
		return this.#coordination.hasCoolingDownCredentials(provider, modelId);
	}

	getCredentialIncarnation(credentialId: number): number {
		return this.#coordination.getCredentialIncarnation(credentialId);
	}

	tryAcquireQuotaProbeLease(credentialId: number, blockScope: string): string | null {
		return this.#coordination.tryAcquireQuotaProbeLease(credentialId, blockScope);
	}

	recordQuotaProbeSuccess(credentialId: number, blockScope: string, leaseId: string | null): boolean {
		return this.#coordination.recordQuotaProbeSuccess(credentialId, blockScope, leaseId);
	}

	noteTransientSoftAvoid(credentialId: number, blockScope: string, untilMs: number): void {
		this.#coordination.noteTransientSoftAvoid(credentialId, blockScope, untilMs);
	}

	/**
	 * Drop an inflight quota probe for `requestId` without clearing cooldown.
	 * Call when the attempt is abandoned (fallback / turn release) so a later
	 * request can acquire a fresh lease.
	 */
	clearQuotaProbe(requestId: string): void {
		this.#coordination.clearQuotaProbe(requestId);
	}

	settleQuotaProbeSuccess(requestId: string): boolean {
		return this.#coordination.settleQuotaProbeSuccess(requestId);
	}

	/** Drop an anonymous (requestId-less) inflight probe without clearing cooldown. */
	clearAnonymousQuotaProbe(credentialId: number, blockScope: string): void {
		this.#coordination.clearAnonymousQuotaProbe(credentialId, blockScope);
	}

	/** Record a requestId-less probe vend as successful: clears the cooldown lease. */
	settleAnonymousQuotaProbe(credentialId: number, blockScope: string): boolean {
		return this.#coordination.settleAnonymousQuotaProbe(credentialId, blockScope);
	}

	tryAcquireTurnReservation(args: {
		credentialId: number;
		incarnation: number;
		requestId: string;
		ttlMs?: number;
	}): TurnReservationResult {
		return this.#coordination.tryAcquireTurnReservation(args);
	}

	releaseTurnReservation(requestId: string): void {
		this.#coordination.releaseTurnReservation(requestId);
	}
}
