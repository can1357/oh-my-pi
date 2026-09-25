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
import { logger } from "@oh-my-pi/pi-utils";
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
import type {
	AuthAccountPolicies,
	AuthApiKeyOptions,
	AuthCredential,
	AuthCredentialEntry,
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

/** Store-bound credential modules; rebuilt as a unit by {@link AuthStorage.replaceStore}. */
interface AuthStorageModules {
	pool: CredentialPool;
	coordination: CredentialCoordination;
	keys: KeyCascade;
	oauth: OAuthAccounts;
	sessions: SessionAffinity;
	usage: UsageService;
	health: CredentialHealth;
	limits: RateLimits;
	resets: ResetCredits;
	blocks: CredentialBlocks;
}

/**
 * Credential management over an {@link AuthCredentialStore}: multi-account
 * selection with usage-aware ranking, rate-limit blocks, OAuth refresh, and
 * usage reporting. See the module doc for the namespace layout.
 *
 * Namespaces resolve against the current store on every access, so holders of
 * this instance follow {@link AuthStorage.replaceStore} without re-wiring.
 */
export class AuthStorage {
	readonly #options: AuthStorageOptions;
	readonly #overrides: KeyOverrides;
	readonly #policies: AccountPolicies;
	#modules: AuthStorageModules;
	#generationUnsubscribes = new Map<(generation: number) => void, () => void>();

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#options = options;
		this.#overrides = new KeyOverrides(options.configValueResolver);
		this.#policies = new AccountPolicies(options.accountPolicies ?? [], options.defaultReservePct);
		this.#modules = this.#compose(store, options.sourceLabel);
		if (options.onCredentialDisabled) this.#modules.pool.onDisabled(options.onCredentialDisabled);
	}

	/** Stored credential rows, change/disable events, broker snapshot. */
	get credentials(): CredentialsApi {
		return this.#modules.pool;
	}
	/** Provider auth cascade and key overrides. */
	get keys(): KeysApi {
		return this.#modules.keys;
	}
	/** OAuth login, account access, listings, refresh. */
	get oauth(): OAuthApi {
		return this.#modules.oauth;
	}
	/** Session → account pins. */
	get sessions(): SessionsApi {
		return this.#modules.sessions;
	}
	/** Usage reports, header ingestion, history. */
	get usage(): UsageApi {
		return this.#modules.usage;
	}
	/** Model pool health and per-credential probes. */
	get health(): HealthApi {
		return this.#modules.health;
	}
	/** Usage-limit marking and credential rotation. */
	get limits(): LimitsApi {
		return this.#modules.limits;
	}
	/** Saved rate-limit resets. */
	get resets(): ResetsApi {
		return this.#modules.resets;
	}
	/** Persisted rate-limit blocks (auth-broker server seam). */
	get blocks(): BlocksApi {
		return this.#modules.blocks;
	}

	/**
	 * Apply new account routing policy (live `auth.accountPolicies` /
	 * `retry.usageReservePct` change). Throws a configuration error, leaving the
	 * active policy untouched, when the policy is malformed or does not match the
	 * stored OAuth accounts.
	 */
	setAccountPolicies(config: { accountPolicies: AuthAccountPolicies; defaultReservePct: number }): void {
		const pool = this.#modules.pool;
		const stored = new Map<string, AuthCredential[]>();
		for (const provider of pool.providers()) stored.set(provider, pool.credentials(provider));
		this.#policies.replace(config.accountPolicies, config.defaultReservePct, stored);
	}

	/**
	 * Swap the backing credential store in place (live `auth.broker.url` change).
	 * Loads `store` into fresh store-bound state — pins, blocks, and usage caches are
	 * keyed by the old store's row ids — then closes the previous store. Runtime key
	 * overrides, account policies, usage-provider overrides, and credential event
	 * subscribers carry over. On a load failure `store` is closed and the current
	 * store stays active.
	 */
	async replaceStore(store: AuthCredentialStore, options: { sourceLabel?: string } = {}): Promise<void> {
		const next = this.#compose(store, options.sourceLabel ?? this.#options.sourceLabel);
		try {
			await next.pool.reload();
		} catch (error) {
			next.pool.close();
			throw error;
		}
		const previous = this.#modules;
		next.pool.adoptSubscribers(previous.pool);
		next.usage.adoptRuntimeProviders(previous.usage);
		this.#modules = next;
		previous.pool.close();
		next.pool.bump("store-replaced");
	}

	#compose(store: AuthCredentialStore, sourceLabel: string | undefined): AuthStorageModules {
		const options = this.#options;
		const overrides = this.#overrides;
		const policies = this.#policies;
		const blockHealth = new BlockStoreHealth(sourceLabel);
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
			sourceLabel,
		});
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher });

		return {
			pool,
			coordination,
			keys,
			oauth,
			sessions: affinity,
			usage,
			health: new CredentialHealth({
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
			}),
			limits,
			resets: new ResetCredits({ store, pool, oauth, usage, usageCache, blocks }),
			blocks,
		};
	}

	/** Open the SQLite store at `dbPath` and wrap it (standalone use, e.g. the pi-ai CLI). */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/** Close the underlying credential store; the instance must not be reused. */
	close(): void {
		this.#modules.pool.close();
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
		return this.#modules.coordination.hasCoolingDownCredentials(provider, modelId);
	}

	getCredentialIncarnation(credentialId: number): number {
		return this.#modules.coordination.getCredentialIncarnation(credentialId);
	}


	tryAcquireQuotaProbeLease(credentialId: number, blockScope: string): string | null {
		return this.#modules.coordination.tryAcquireQuotaProbeLease(credentialId, blockScope);
	}

	recordQuotaProbeSuccess(credentialId: number, blockScope: string, leaseId: string | null): boolean {
		return this.#modules.coordination.recordQuotaProbeSuccess(credentialId, blockScope, leaseId);
	}

	noteTransientSoftAvoid(credentialId: number, blockScope: string, untilMs: number): void {
		this.#modules.coordination.noteTransientSoftAvoid(credentialId, blockScope, untilMs);
	}

	/**
	 * Drop an inflight quota probe for `requestId` without clearing cooldown.
	 * Call when the attempt is abandoned (fallback / turn release) so a later
	 * request can acquire a fresh lease.
	 */
	clearQuotaProbe(requestId: string): void {
		this.#modules.coordination.clearQuotaProbe(requestId);
	}

	settleQuotaProbeSuccess(requestId: string): boolean {
		return this.#modules.coordination.settleQuotaProbeSuccess(requestId);
	}

	clearAnonymousQuotaProbe(credentialId: number, blockScope: string): void {
		this.#modules.coordination.clearAnonymousQuotaProbe(credentialId, blockScope);
	}

	settleAnonymousQuotaProbe(credentialId: number, blockScope: string): boolean {
		return this.#modules.coordination.settleAnonymousQuotaProbe(credentialId, blockScope);
	}
}
