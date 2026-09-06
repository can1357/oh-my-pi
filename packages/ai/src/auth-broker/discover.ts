/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml/config.yaml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	$env,
	$envExact,
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	isEnoent,
	isRetryableStatus,
	logger,
	MAIN_CONFIG_FILENAMES,
	parseFlag,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	type AuthAccountPolicies,
	type AuthCredentialStore,
	AuthStorage,
	type AuthStorageOptions,
	DEFAULT_USAGE_RESERVE_PCT,
	SqliteAuthCredentialStore,
} from "../auth-storage";
import type { CredentialEncryption } from "../auth/sqlite-credential-store";
import * as AIError from "../error";
import { AuthBrokerClient, AuthBrokerError, type FetchSnapshotResult } from "./client";
import { HybridAuthCredentialStore } from "./hybrid-store";
import { type AuthBrokerAccountPool, type AuthBrokerProviderPool, RemoteAuthCredentialStore } from "./remote-store";
import { readAuthBrokerSnapshotCache, scheduleAuthBrokerSnapshotCacheWrite } from "./snapshot-cache";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS, type SnapshotResponse } from "./types";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

/** Values from one already-loaded main config, before environment and command resolution. */
export interface PersistedAuthSettings {
	url?: string;
	token?: string;
	accountPolicies?: unknown;
	usageReservePct?: unknown;
	encrypt?: boolean;
}

interface AuthSettingsSource {
	agentDir?: string;
	/** A supplied snapshot, including an empty one, skips main config discovery. */
	persistedSettings?: PersistedAuthSettings;
}

export interface ResolveAuthBrokerConfigOptions extends AuthSettingsSource {
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface DiscoverAuthStorageOptions extends ResolveAuthBrokerConfigOptions {
	cachePath?: string;
	sourceLabel?: string;
	/** Programmatic pool for SDK hosts. Takes precedence over the environment file. */
	accountPool?: AuthBrokerAccountPool;
	accountPolicies?: AuthAccountPolicies;
	authStorageOptions?: Omit<AuthStorageOptions, "accountPolicies" | "configValueResolver" | "sourceLabel">;
	/**
	 * Without a usable snapshot cache, retry a broker that is restarting or
	 * briefly unreachable for up to 30 s (default `true`). A host with a user
	 * waiting on it passes `false` to fail at once.
	 */
	retryUnreachableBroker?: boolean;
	/**
	 * Called after each failed attempt at the initial snapshot that startup will
	 * retry, so a CLI can tell its user it is waiting on the broker.
	 */
	onBrokerRetry?: (retry: AuthBrokerStartupRetry) => void;
	/** Transport for every broker request. Default global `fetch`. */
	fetch?: typeof fetch;
	/**
	 * Deadline for revalidating a fresh cached snapshot; one signal governs both
	 * the reachability probe and the snapshot fetch. Default
	 * `AbortSignal.timeout(SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS)`.
	 */
	revalidationSignal?: AbortSignal;
}

/** A failed attempt at the initial snapshot that startup retries. */
export interface AuthBrokerStartupRetry {
	url: string;
	error: AuthBrokerError;
	/** Wait before the next attempt. */
	delayMs: number;
	/** How long startup retries in total before failing. */
	budgetMs: number;
}

/**
 * Startup budget for revalidating a fresh cached snapshot against the broker.
 * One deadline covers both the unauthenticated reachability probe and the
 * authenticated snapshot fetch so a proxy that answers `/v1/healthz` quickly
 * but stalls `/v1/snapshot` cannot hold startup past the budget.
 */
export const SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS = 500;

/**
 * The client's health request uses the same fetch transport (including proxy
 * routing) as snapshot requests, so a reachable answer here means the
 * authenticated fetch is worth its round trip.
 */
async function isAuthBrokerReachable(client: AuthBrokerClient, signal: AbortSignal): Promise<boolean> {
	try {
		await client.healthz(signal);
		return true;
	} catch (error) {
		// Any HTTP response proves the transport reached the broker. Network and
		// timeout failures leave startup on the fresh cached snapshot.
		return error instanceof AuthBrokerError && error.kind !== "transport";
	}
}

/** Path to the local bearer token file. Created by `omp auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

/**
 * Default resolver for config values: checks `process.env` first, then treats
 * the value as a literal. Does NOT execute `!command` syntax; such values are
 * left unresolved so the caller can fall back to the token file.
 */
async function defaultResolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) return undefined;
	const envValue = $envExact(config);
	return envValue || config;
}

async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await fs.readFile(getAuthBrokerTokenFilePath(), "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

type ReadAuthSettings = () => Promise<PersistedAuthSettings>;

function authSettingsReader({ agentDir, persistedSettings }: AuthSettingsSource): ReadAuthSettings {
	let loaded = persistedSettings === undefined ? undefined : Promise.resolve(persistedSettings);
	return () => (loaded ??= readConfigYaml(agentDir ?? getAgentDir()));
}

/**
 * Resolve a dotted config key (e.g. `auth.broker.url`) against a parsed YAML
 * record, accepting both nested form (`auth: { broker: { url } }`) and the
 * legacy flat literal-dot key (`"auth.broker.url": ...`). Nested wins when both
 * are present.
 */
function readDottedValue(record: Record<string, unknown>, dottedKey: string): unknown {
	let current: unknown = record;
	for (const segment of dottedKey.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return record[dottedKey];
		const currentRecord = current as Record<string, unknown>;
		if (!Object.hasOwn(currentRecord, segment)) return record[dottedKey];
		current = currentRecord[segment];
	}
	return current;
}

function readDottedString(record: Record<string, unknown>, dottedKey: string): string | undefined {
	const value = readDottedValue(record, dottedKey);
	return typeof value === "string" ? value : undefined;
}

/** Extract auth values with main-config precedence, not the effective Settings layer. */
export function readPersistedAuthSettings(record: Readonly<Record<string, unknown>>): PersistedAuthSettings {
	const encrypt = readDottedValue(record, "auth.encrypt");
	return {
		url: readDottedString(record, "auth.broker.url"),
		token: readDottedString(record, "auth.broker.token"),
		accountPolicies: readDottedValue(record, "auth.accountPolicies"),
		usageReservePct: readDottedValue(record, "retry.usageReservePct"),
		encrypt: typeof encrypt === "boolean" ? encrypt : undefined,
	};
}

function parseAuthAccountPolicies(value: unknown): AuthAccountPolicies {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new AIError.ConfigurationError("auth.accountPolicies must be an array");
	}

	return value.map((entry, index) => {
		const path = `auth.accountPolicies[${index}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new AIError.ConfigurationError(`${path} must be an object`);
		}
		const policy = entry as Record<string, unknown>;
		const unknownPolicyFields = Object.keys(policy).filter(
			key =>
				key !== "provider" &&
				key !== "account" &&
				key !== "priority" &&
				key !== "reservePct" &&
				key !== "reclaimAbovePct",
		);
		if (unknownPolicyFields.length > 0) {
			throw new AIError.ConfigurationError(`${path} has unknown fields: ${unknownPolicyFields.join(", ")}`);
		}
		const provider = policy.provider;
		if (typeof provider !== "string" || provider.length === 0) {
			throw new AIError.ConfigurationError(`${path}.provider must be a non-empty string`);
		}
		if (provider.trim() !== provider) {
			throw new AIError.ConfigurationError(`${path}.provider must not contain surrounding whitespace`);
		}
		if (policy.account === null || typeof policy.account !== "object" || Array.isArray(policy.account)) {
			throw new AIError.ConfigurationError(`${path}.account must be an object`);
		}

		const accountPath = `${path}.account`;
		const rawAccount = policy.account as Record<string, unknown>;
		const selectorFields = ["email", "accountId", "projectId", "orgId"] as const;
		const baseIdentityFields = ["email", "accountId", "projectId"] as const;
		const unknownAccountFields = Object.keys(rawAccount).filter(
			key => !selectorFields.includes(key as (typeof selectorFields)[number]),
		);
		if (unknownAccountFields.length > 0) {
			throw new AIError.ConfigurationError(`${accountPath} has unknown fields: ${unknownAccountFields.join(", ")}`);
		}
		for (const field of selectorFields) {
			const fieldValue = rawAccount[field];
			if (fieldValue !== undefined && (typeof fieldValue !== "string" || fieldValue.length === 0)) {
				throw new AIError.ConfigurationError(`${accountPath}.${field} must be a non-empty string`);
			}
		}
		if (!baseIdentityFields.some(field => rawAccount[field] !== undefined)) {
			throw new AIError.ConfigurationError(
				`${accountPath} must include at least one of email, accountId, or projectId`,
			);
		}
		if (policy.priority !== undefined && (typeof policy.priority !== "number" || !Number.isFinite(policy.priority))) {
			throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
		}
		if (
			policy.reservePct !== undefined &&
			(typeof policy.reservePct !== "number" ||
				!Number.isFinite(policy.reservePct) ||
				policy.reservePct < 0 ||
				policy.reservePct > 100)
		) {
			throw new AIError.ConfigurationError(`${path}.reservePct must be between 0 and 100`);
		}
		if (
			policy.reclaimAbovePct !== undefined &&
			(typeof policy.reclaimAbovePct !== "number" || !Number.isFinite(policy.reclaimAbovePct))
		) {
			throw new AIError.ConfigurationError(`${path}.reclaimAbovePct must be a finite number`);
		}

		return {
			provider,
			account: {
				...(typeof rawAccount.email === "string" ? { email: rawAccount.email } : {}),
				...(typeof rawAccount.accountId === "string" ? { accountId: rawAccount.accountId } : {}),
				...(typeof rawAccount.projectId === "string" ? { projectId: rawAccount.projectId } : {}),
				...(typeof rawAccount.orgId === "string" ? { orgId: rawAccount.orgId } : {}),
			},
			...(typeof policy.priority === "number" ? { priority: policy.priority } : {}),
			...(typeof policy.reservePct === "number" ? { reservePct: policy.reservePct } : {}),
			...(typeof policy.reclaimAbovePct === "number" ? { reclaimAbovePct: policy.reclaimAbovePct } : {}),
		};
	});
}

function parseUsageReservePct(value: unknown): number {
	const reservePct = value === undefined ? DEFAULT_USAGE_RESERVE_PCT : value;
	if (typeof reservePct !== "number" || !Number.isFinite(reservePct)) {
		throw new AIError.ConfigurationError("retry.usageReservePct must be a finite number");
	}
	return reservePct;
}

async function readConfigYaml(agentDir: string): Promise<PersistedAuthSettings> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const configPath = path.join(agentDir, filename);
		let raw: string;
		try {
			raw = await fs.readFile(configPath, "utf8");
		} catch (error) {
			if (isEnoent(error)) continue;
			throw new AIError.ConfigurationError(`Unable to read ${configPath}: ${String(error)}`);
		}

		let parsed: unknown;
		try {
			parsed = YAML.parse(raw);
		} catch (error) {
			throw new AIError.ConfigurationError(`${configPath} contains invalid YAML: ${String(error)}`);
		}
		// An empty or comment-only file parses to null: no settings, not a malformed config.
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new AIError.ConfigurationError(`${configPath} must contain a YAML object`);
		}
		return readPersistedAuthSettings(parsed as Record<string, unknown>);
	}
	return {};
}

export interface AuthAccountPolicyConfig {
	accountPolicies: AuthAccountPolicies;
	defaultReservePct: number;
}

export interface LoadAuthAccountPolicyConfigOptions extends AuthSettingsSource {
	accountPolicies?: unknown;
	usageReservePct?: unknown;
}

/** Load and strictly validate account-selection policy configuration, with main-config fallback. */
export function loadAuthAccountPolicyConfig(
	options: LoadAuthAccountPolicyConfigOptions = {},
): Promise<AuthAccountPolicyConfig> {
	return resolveAccountPolicies(authSettingsReader(options), options.accountPolicies, options.usageReservePct);
}

async function resolveAccountPolicies(
	readConfig: ReadAuthSettings,
	accountPolicies: unknown,
	usageReservePct: unknown,
): Promise<AuthAccountPolicyConfig> {
	const snapshot = accountPolicies === undefined || usageReservePct === undefined ? await readConfig() : undefined;
	return {
		accountPolicies: parseAuthAccountPolicies(
			accountPolicies === undefined ? snapshot?.accountPolicies : accountPolicies,
		),
		defaultReservePct: parseUsageReservePct(
			usageReservePct === undefined ? snapshot?.usageReservePct : usageReservePct,
		),
	};
}

export async function loadAuthBrokerAccountPool(): Promise<AuthBrokerAccountPool | undefined> {
	const filePath = process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE?.trim();
	if (!filePath) return undefined;

	let parsed: unknown;
	try {
		const raw = await fs.readFile(filePath, "utf8");
		parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
	} catch (error) {
		throw new AIError.ConfigurationError(`Unable to read OMP_AUTH_BROKER_ACCOUNT_POOL_FILE at ${filePath}`, {
			cause: error,
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new AIError.ConfigurationError("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE must contain a JSON object");
	}

	const accountPool = new Map<string, ReadonlySet<string> | AuthBrokerProviderPool>();
	for (const [provider, value] of Object.entries(parsed)) {
		const normalizedProvider = provider.trim();
		if (normalizedProvider.length === 0) {
			throw new AIError.ConfigurationError("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE contains an empty provider id");
		}
		if (provider !== normalizedProvider) {
			throw new AIError.ConfigurationError(
				"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE contains a provider id with surrounding whitespace",
			);
		}
		accountPool.set(provider, parseAccountPoolEntry(provider, value));
	}
	return accountPool;
}

/**
 * One pool-file entry: an identity array (visible OAuth accounts, API keys
 * kept), `true` (everything visible), `false` (nothing visible), or a rule
 * object `{ "accounts"?: [...], "apiKeys"?: boolean }`.
 */
function parseAccountPoolEntry(provider: string, value: unknown): ReadonlySet<string> | AuthBrokerProviderPool {
	if (Array.isArray(value)) return parseAccountPoolIdentities(provider, value);
	if (value === true) return {};
	if (value === false) return { accounts: new Set(), apiKeys: false };
	if (value === null || typeof value !== "object") {
		throw new AIError.ConfigurationError(
			`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} must be an array of identity keys, a boolean, or an object with "accounts"/"apiKeys"`,
		);
	}
	const rule: { accounts?: ReadonlySet<string>; apiKeys?: boolean } = {};
	for (const [key, field] of Object.entries(value)) {
		if (key === "accounts") {
			if (!Array.isArray(field)) {
				throw new AIError.ConfigurationError(
					`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} has "accounts" that is not an array of identity keys`,
				);
			}
			rule.accounts = parseAccountPoolIdentities(provider, field);
		} else if (key === "apiKeys") {
			if (typeof field !== "boolean") {
				throw new AIError.ConfigurationError(
					`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} has "apiKeys" that is not a boolean`,
				);
			}
			rule.apiKeys = field;
		} else {
			throw new AIError.ConfigurationError(
				`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} has unknown field ${JSON.stringify(key)}`,
			);
		}
	}
	return rule;
}

function parseAccountPoolIdentities(provider: string, value: unknown[]): Set<string> {
	const identities = new Set<string>();
	for (const identity of value) {
		if (typeof identity !== "string" || identity.length === 0) {
			throw new AIError.ConfigurationError(
				`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} contains an invalid identity key`,
			);
		}
		if (identity !== identity.trim()) {
			throw new AIError.ConfigurationError(
				`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} contains an identity key with surrounding whitespace`,
			);
		}
		identities.add(identity);
	}
	return identities;
}

function resolveSnapshotTtlMs(): number {
	const raw = process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS;
	if (raw === undefined) return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const ttlMs = Number(value);
	if (Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
	logger.warn("Invalid OMP_AUTH_BROKER_SNAPSHOT_TTL_MS; using default", { value: raw });
	return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
}

/**
 * How long startup keeps retrying the initial snapshot when no cache can stand
 * in, so a broker restart or a short network outage does not fail startup.
 */
const INITIAL_SNAPSHOT_RETRY_BUDGET_MS = 30_000;
const INITIAL_SNAPSHOT_RETRY_INITIAL_DELAY_MS = 500;
const INITIAL_SNAPSHOT_RETRY_MAX_DELAY_MS = 8_000;

/** No HTTP answer, or one a restarting broker or its proxy gives (5xx, 408, 429). */
function isTransientAuthBrokerError(error: unknown): error is AuthBrokerError {
	return error instanceof AuthBrokerError && (error.status === undefined || isRetryableStatus(error.status));
}

interface InitialSnapshotOptions {
	url: string;
	/** Retry transient failures; without it the first failure throws. */
	retry: boolean;
	onRetry?: (retry: AuthBrokerStartupRetry) => void;
}

/**
 * Fetch the snapshot a broker store opens with. With `retry`, transient
 * failures are retried with exponential backoff under one
 * {@link INITIAL_SNAPSHOT_RETRY_BUDGET_MS} deadline that also cancels a request
 * in flight; a rejected token or any other definite answer fails at once.
 */
async function fetchInitialSnapshot(
	client: AuthBrokerClient,
	{ url, retry, onRetry }: InitialSnapshotOptions,
): Promise<SnapshotResponse> {
	const budget = retry ? AbortSignal.timeout(INITIAL_SNAPSHOT_RETRY_BUDGET_MS) : undefined;
	let delayMs = INITIAL_SNAPSHOT_RETRY_INITIAL_DELAY_MS;
	let lastError: AuthBrokerError | undefined;
	for (;;) {
		let result: FetchSnapshotResult;
		try {
			result = await client.fetchSnapshot({ signal: budget });
		} catch (error) {
			// The deadline cancelled this request: give up without reporting another retry.
			const cause = budget?.aborted ? (lastError ?? error) : undefined;
			if (cause instanceof AuthBrokerError) throw initialSnapshotRetriesSpent(cause);
			if (!budget || !isTransientAuthBrokerError(error)) throw error;
			lastError = error;
			logger.warn("auth-broker initial snapshot failed; retrying", { error: error.message, delayMs });
			onRetry?.({ url, error, delayMs, budgetMs: INITIAL_SNAPSHOT_RETRY_BUDGET_MS });
			try {
				await scheduler.wait(delayMs, { signal: budget });
			} catch {
				throw initialSnapshotRetriesSpent(lastError);
			}
			delayMs = Math.min(delayMs * 2, INITIAL_SNAPSHOT_RETRY_MAX_DELAY_MS);
			continue;
		}
		if (result.status !== 200)
			throw new AuthBrokerError("Auth broker returned no initial snapshot", { status: result.status });
		return result.snapshot;
	}
}

function initialSnapshotRetriesSpent(lastError: AuthBrokerError): AuthBrokerError {
	return new AuthBrokerError(
		`Auth broker gave no initial snapshot after retrying for ${INITIAL_SNAPSHOT_RETRY_BUDGET_MS / 1000}s: ${lastError.message}`,
		{ status: lastError.status, body: lastError.body, kind: lastError.kind, cause: lastError },
	);
}

/**
 * Resolve broker connection configuration using the same precedence as the TUI:
 *
 * 1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars.
 * 2. `auth.broker.url` / `auth.broker.token` from supplied main config or the main YAML file.
 * 3. `<config-root>/auth-broker.token` file (paired with a URL from env/config).
 *
 * Returns `null` when no broker URL is configured — callers should fall back to
 * the local SQLite store. Throws when a URL is configured but no token is
 * available, matching the TUI behavior.
 */
export function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	return resolveBrokerConfig(authSettingsReader(options), options.configValueResolver);
}

async function resolveBrokerConfig(
	readConfig: ReadAuthSettings,
	resolveConfig = defaultResolveConfigValue,
): Promise<AuthBrokerClientConfig | null> {
	let url = process.env.OMP_AUTH_BROKER_URL;
	let token = process.env.OMP_AUTH_BROKER_TOKEN;
	if (!url) {
		const { url: configured } = await readConfig();
		if (configured) url = await resolveConfig(configured);
	}
	if (!url) return null;

	if (!token) {
		const { token: configured } = await readConfig();
		if (configured) token = await resolveConfig(configured);
		if (!token) token = (await readTokenFile()) ?? undefined;
	}
	if (!token) {
		throw new AIError.MissingApiKeyError(
			undefined,
			`OMP_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set OMP_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}

export interface OpenAuthCredentialStoreOptions extends AuthSettingsSource {
	/** Broker to connect to; `null` opens the local SQLite store under `agentDir`. */
	brokerConfig: AuthBrokerClientConfig | null;
	cachePath?: string;
	sourceLabel?: string;
	/** Programmatic pool for SDK hosts. Takes precedence over the environment file. */
	accountPool?: AuthBrokerAccountPool;
	/**
	 * Without a usable cache, retry a broker that is restarting or briefly
	 * unreachable for up to 30 s instead of failing on the first try. Startup
	 * sets this; a runtime settings switch fails fast and keeps its current store.
	 */
	retryUnreachableBroker?: boolean;
	/** Called after each failed attempt that {@link retryUnreachableBroker} retries. */
	onBrokerRetry?: (retry: AuthBrokerStartupRetry) => void;
}

/** Credential store opened by {@link openAuthCredentialStore} plus its diagnostics label. */
export interface OpenedAuthCredentialStore {
	store: AuthCredentialStore;
	sourceLabel: string;
}

/**
 * Open the credential store {@link discoverAuthStorage} would use for
 * `brokerConfig`: the remote broker store (fails when the broker has no
 * usable snapshot) wrapped in {@link HybridAuthCredentialStore}, which keeps
 * logins the broker will not serve in the local `agent.db`; or the local SQLite
 * store. Also feeds
 * {@link AuthStorage.replaceStore} when broker settings change at runtime.
 */
export function openAuthCredentialStore(options: OpenAuthCredentialStoreOptions): Promise<OpenedAuthCredentialStore> {
	return openCredentialStore(options, options.agentDir ?? getAgentDir(), authSettingsReader(options));
}

async function openCredentialStore(
	options: OpenAuthCredentialStoreOptions,
	agentDir: string,
	readConfig: ReadAuthSettings,
): Promise<OpenedAuthCredentialStore> {
	const brokerConfig = options.brokerConfig;
	if (brokerConfig) {
		const accountPool = options.accountPool ?? (await loadAuthBrokerAccountPool());
		const client = new AuthBrokerClient({
			url: brokerConfig.url,
			token: brokerConfig.token,
			fetchImpl: options.fetch,
		});
		const cachePath = options.cachePath ?? getAuthBrokerSnapshotCachePath();
		const ttlMs = resolveSnapshotTtlMs();
		// Coalesced fire-and-forget: the first snapshot lands immediately (so a
		// fresh boot seeds the cache), bursts collapse into one trailing write,
		// and anything pending is flushed on shutdown.
		const persist =
			ttlMs > 0
				? (snapshot: SnapshotResponse): void => {
						scheduleAuthBrokerSnapshotCacheWrite({
							path: cachePath,
							token: brokerConfig.token,
							url: brokerConfig.url,
							snapshot,
						});
					}
				: undefined;

		let cachedSnapshot: SnapshotResponse | undefined;
		if (ttlMs > 0) {
			cachedSnapshot =
				(await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: brokerConfig.token,
					url: brokerConfig.url,
					ttlMs,
				}).catch(error => {
					logger.debug("auth-broker snapshot cache read failed", { error: String(error) });
					return null;
				})) ?? undefined;
		}

		let initialSnapshot = cachedSnapshot;
		if (!cachedSnapshot) {
			// No usable cache: block on the broker so a misconfigured/unreachable
			// broker or revoked token fails startup with an actionable error
			// (issue #8096) instead of yielding an empty credential store.
			try {
				initialSnapshot = await fetchInitialSnapshot(client, {
					url: brokerConfig.url,
					retry: options.retryUnreachableBroker === true,
					onRetry: options.onBrokerRetry,
				});
			} catch (error) {
				if (!(error instanceof AuthBrokerError)) throw error;
				throw new AuthBrokerStartupError(brokerConfig.url, error);
			}
			persist?.(initialSnapshot);
		} else {
			// Fresh cache: revalidate within the startup budget so the current snapshot
			// or an authorization rejection wins synchronously; a broker that is
			// unreachable, slow, or failing for any other reason leaves startup on the
			// cache and the store's background stream picks up the current generation.
			const revalidation = options.revalidationSignal ?? AbortSignal.timeout(SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS);
			if (await isAuthBrokerReachable(client, revalidation)) {
				try {
					const initialResult = await client.fetchSnapshot({ signal: revalidation });
					if (initialResult.status !== 200)
						throw new AuthBrokerError("Auth broker returned no initial snapshot", {
							status: initialResult.status,
						});
					initialSnapshot = initialResult.snapshot;
					persist?.(initialSnapshot);
				} catch (error) {
					if (error instanceof AuthBrokerError && error.kind === "unauthorized") {
						throw new AuthBrokerStartupError(brokerConfig.url, error);
					}
					logger.debug("auth-broker snapshot revalidation failed; starting from cache", { error: String(error) });
				}
			}
		}
		// Opened before the broker store, whose constructor starts background sync that a failed open would leak.
		const local = await openLocalStore(agentDir, readConfig);
		const broker = new RemoteAuthCredentialStore({
			client,
			initialSnapshot,
			onSnapshot: persist,
			accountPool,
		});
		return {
			store: new HybridAuthCredentialStore({ broker, local }),
			sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
		};
	}

	const store = await openLocalStore(agentDir, readConfig);
	return { store, sourceLabel: options.sourceLabel ?? `local ${getAgentDbPath(agentDir)}` };
}

/** Names the broker actually contacted, without resolving its configuration again on failure. */
export class AuthBrokerStartupError extends AuthBrokerError {
	constructor(
		readonly url: string,
		cause: AuthBrokerError,
	) {
		super(cause.message, { status: cause.status, body: cause.body, kind: cause.kind, cause });
	}
}

/**
 * This machine's credential store, `<agentDir>/agent.db`. `OMP_AUTH_ENCRYPT`, else
 * `auth.encrypt` in `<agentDir>/config.yml`, forces sealing new secrets under the
 * OS-vault master key on, or off (unsealing those sealed earlier); unset, the
 * store keeps its current mode (see {@link SqliteAuthCredentialStore.unlock}).
 * In broker mode only the logins kept on this machine land here; the broker
 * encrypts its own store.
 */
export function openLocalAuthCredentialStore(agentDir: string = getAgentDir()): Promise<SqliteAuthCredentialStore> {
	return openLocalStore(agentDir, authSettingsReader({ agentDir }));
}

async function openLocalStore(agentDir: string, readConfig: ReadAuthSettings): Promise<SqliteAuthCredentialStore> {
	const env = $env.OMP_AUTH_ENCRYPT;
	const encrypt: CredentialEncryption = env ? parseFlag(env) : ((await readConfig()).encrypt ?? "auto");
	return SqliteAuthCredentialStore.open(getAgentDbPath(agentDir), { encrypt });
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. This is the single source of truth
 * for the TUI and the catalog generator.
 */
export async function discoverAuthStorage(options: DiscoverAuthStorageOptions = {}): Promise<AuthStorage> {
	return (await discoverAuthStorageWithConfig(options)).storage;
}

/** Open the storage and return the resolved broker to callers maintaining live settings. */
export async function discoverAuthStorageWithConfig(
	options: DiscoverAuthStorageOptions = {},
): Promise<{ storage: AuthStorage; brokerConfig: AuthBrokerClientConfig | null }> {
	const agentDir = options.agentDir ?? getAgentDir();
	const readConfig = authSettingsReader({ agentDir, persistedSettings: options.persistedSettings });
	const brokerConfig = await resolveBrokerConfig(readConfig, options.configValueResolver);
	const { accountPolicies, defaultReservePct } = await resolveAccountPolicies(
		readConfig,
		options.accountPolicies,
		options.authStorageOptions?.defaultReservePct,
	);
	const { store, sourceLabel } = await openCredentialStore(
		{ ...options, brokerConfig, retryUnreachableBroker: options.retryUnreachableBroker ?? true },
		agentDir,
		readConfig,
	);
	const storage = new AuthStorage(store, {
		...options.authStorageOptions,
		configValueResolver: options.configValueResolver,
		sourceLabel,
		accountPolicies,
		defaultReservePct,
	});
	await storage.credentials.reload();
	return { storage, brokerConfig };
}
