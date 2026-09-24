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
import { CredentialHealth } from "./auth/health";
import { OAuthAccounts } from "./auth/oauth";
import { AccountPolicies } from "./auth/policy";
import { CredentialPool } from "./auth/pool";
import { OAuthRefresher } from "./auth/refresh";
import { ResetCredits } from "./auth/resets";
import { RateLimits } from "./auth/rotation";
import { CredentialSelector } from "./auth/select";
import { SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
import type { AuthCredentialStore } from "./auth/store";
import type {
	AuthApiKeyOptions,
	AuthStorageOptions,
	BlocksApi,
	CredentialsApi,
	HealthApi,
	KeysApi,
	LimitsApi,
	OAuthApi,
	ResetsApi,
	SessionsApi,
	UsageApi,
} from "./auth/types";
import { UsageService } from "./auth/usage";
import { DEFAULT_USAGE_REQUEST_TIMEOUT_MS, UsageCache } from "./auth/usage-cache";
import type { UsageLogger } from "./usage";
import { defaultRankingStrategy, defaultUsageProvider } from "./usage/registry";

export { isSqliteBusyError, isSqliteCorruptionError, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
export * from "./auth/store";
export * from "./auth/types";

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

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		const overrides = new KeyOverrides(options.configValueResolver);
		const policies = new AccountPolicies(
			options.accountPolicies ?? [],
			options.defaultReservePct,
			options.hotWindowFraction,
		);
		const blockHealth = new BlockStoreHealth(options.sourceLabel);
		const strategies = options.rankingStrategyResolver ?? defaultRankingStrategy;
		const pool = new CredentialPool(store, {
			policies,
			blockHealth,
			onReset: provider => {
				selector.resetRoundRobin(provider);
				affinity.clearProvider(provider);
			},
		});
		const refresher = new OAuthRefresher({ store, pool, policies, override: options.refreshOAuthCredential });
		const usageProviders = options.usageProviderResolver ?? defaultUsageProvider;
		const usageCache = new UsageCache(store, pool, usageProviders);
		const blocks = new CredentialBlocks({ store, pool, health: blockHealth, usageCache, strategies });
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
		const selector = new CredentialSelector({
			store,
			pool,
			policies,
			blocks,
			affinity,
			usage,
			refresher,
			strategies,
		});
		const limits = new RateLimits({ store, pool, overrides, blocks, affinity, usage, strategies });
		const keys = new KeyCascade({
			pool,
			overrides,
			selector,
			affinity,
			rotate: (provider, sessionId, rotateOptions) => limits.rotate(provider, sessionId, rotateOptions),
			sourceLabel: options.sourceLabel,
		});
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher });

		this.#pool = pool;
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

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.keys}`.get`.
	 */
	getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		return this.keys.get(provider, sessionId, options);
	}

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.credentials}`.reload`.
	 */
	reload(): Promise<void> {
		return this.credentials.reload();
	}
}
