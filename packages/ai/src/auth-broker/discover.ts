/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml/config.yaml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	$envExact,
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
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
import * as AIError from "../error";
import { AuthBrokerClient, AuthBrokerError } from "./client";
import { type AuthBrokerAccountPool, RemoteAuthCredentialStore } from "./remote-store";
import { readAuthBrokerSnapshotCache, writeAuthBrokerSnapshotCache } from "./snapshot-cache";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS, type SnapshotResponse } from "./types";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

export interface ResolveAuthBrokerConfigOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface DiscoverAuthStorageOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;
	/** Programmatic pool for SDK hosts. Takes precedence over the environment file. */
	accountPool?: AuthBrokerAccountPool;
	accountPolicies?: AuthAccountPolicies;
	authStorageOptions?: Omit<AuthStorageOptions, "accountPolicies" | "configValueResolver" | "sourceLabel">;
	/** Transport for every broker request. Default global `fetch`. */
	fetch?: typeof fetch;
	/**
	 * Deadline for revalidating a fresh cached snapshot; one signal governs both
	 * the reachability probe and the snapshot fetch. Default
	 * `AbortSignal.timeout(SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS)`.
	 */
	revalidationSignal?: AbortSignal;
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

interface ConfigSnapshot {
	url?: string;
	token?: string;
	accountPolicies?: unknown;
	usageReservePct?: unknown;
}

/**
 * Resolve a dotted config key (e.g. `auth.broker.url`) against a parsed YAML
 * record, accepting both nested form (`auth: { broker: { url } }`) and the
 * legacy flat literal-dot key (`"auth.broker.url": ...`). Nested wins when both
 * are present. Returns the value only when it is a string.
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
			key => key !== "provider" && key !== "account" && key !== "priority" && key !== "reservePct",
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

async function readConfigYaml(agentDir: string): Promise<ConfigSnapshot> {
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
		const record = parsed as Record<string, unknown>;
		return {
			url: readDottedString(record, "auth.broker.url"),
			token: readDottedString(record, "auth.broker.token"),
			accountPolicies: readDottedValue(record, "auth.accountPolicies"),
			usageReservePct: readDottedValue(record, "retry.usageReservePct"),
		};
	}
	return {};
}

export interface AuthAccountPolicyConfig {
	accountPolicies: AuthAccountPolicies;
	defaultReservePct: number;
}

export interface LoadAuthAccountPolicyConfigOptions {
	agentDir?: string;
	accountPolicies?: unknown;
	usageReservePct?: unknown;
}

/** Load and strictly validate account-selection policy configuration, with main-config fallback. */
export async function loadAuthAccountPolicyConfig(
	options: LoadAuthAccountPolicyConfigOptions = {},
): Promise<AuthAccountPolicyConfig> {
	const agentDir = options.agentDir ?? getAgentDir();
	const needsMainConfigFallback = options.accountPolicies === undefined || options.usageReservePct === undefined;
	const snapshot = needsMainConfigFallback ? await readConfigYaml(agentDir) : undefined;
	return {
		accountPolicies: parseAuthAccountPolicies(
			options.accountPolicies === undefined ? snapshot?.accountPolicies : options.accountPolicies,
		),
		defaultReservePct: parseUsageReservePct(
			options.usageReservePct === undefined ? snapshot?.usageReservePct : options.usageReservePct,
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

	const accountPool = new Map<string, ReadonlySet<string>>();
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
		if (!Array.isArray(value)) {
			throw new AIError.ConfigurationError(
				`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE entry for ${provider} must be an array of identity keys`,
			);
		}
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
		accountPool.set(provider, identities);
	}
	return accountPool;
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
 * Resolve broker connection configuration using the same precedence as the TUI:
 *
 * 1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars.
 * 2. `auth.broker.url` / `auth.broker.token` in `<agentDir>/config.yml` or `<agentDir>/config.yaml`.
 * 3. `<config-root>/auth-broker.token` file (paired with a URL from env/config).
 *
 * Returns `null` when no broker URL is configured — callers should fall back to
 * the local SQLite store. Throws when a URL is configured but no token is
 * available, matching the TUI behavior.
 */
export async function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;

	const envUrl = process.env.OMP_AUTH_BROKER_URL;
	const envToken = process.env.OMP_AUTH_BROKER_TOKEN;

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml(agentDir);
		if (!url && fromConfig.url) {
			const resolved = await resolveConfig(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfig(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
	if (!token) {
		throw new AIError.MissingApiKeyError(
			undefined,
			`OMP_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set OMP_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}

export interface OpenAuthCredentialStoreOptions {
	/** Broker to connect to; `null` opens the local SQLite store under `agentDir`. */
	brokerConfig: AuthBrokerClientConfig | null;
	agentDir?: string;
	cachePath?: string;
	sourceLabel?: string;
	/** Programmatic pool for SDK hosts. Takes precedence over the environment file. */
	accountPool?: AuthBrokerAccountPool;
}

/** Credential store opened by {@link openAuthCredentialStore} plus its diagnostics label. */
export interface OpenedAuthCredentialStore {
	store: AuthCredentialStore;
	sourceLabel: string;
}

/**
 * Open the credential store {@link discoverAuthStorage} would use for
 * `brokerConfig`: the remote broker store (fails fast when the broker has no
 * usable snapshot) or the local SQLite store. Also feeds
 * {@link AuthStorage.replaceStore} when broker settings change at runtime.
 */
export async function openAuthCredentialStore(
	options: OpenAuthCredentialStoreOptions,
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
		const persist =
			ttlMs > 0
				? (snapshot: SnapshotResponse): void => {
						void writeAuthBrokerSnapshotCache({
							path: cachePath,
							token: brokerConfig.token,
							url: brokerConfig.url,
							snapshot,
						}).catch(error => {
							logger.debug("auth-broker snapshot cache write failed", { error: String(error) });
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
		// No usable cache: block on the broker with the client's normal timeout so
		// a misconfigured/unreachable broker or revoked token fails startup with an
		// actionable error (issue #8096) instead of yielding an empty store.
		// Fresh cache: revalidate within the startup budget so the current snapshot
		// or an authorization rejection wins synchronously; a broker that is
		// unreachable, slow, or failing for any other reason leaves startup on the
		// cache and the store's background stream picks up the current generation.
		const revalidation = cachedSnapshot
			? (options.revalidationSignal ?? AbortSignal.timeout(SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS))
			: undefined;
		if (!revalidation || (await isAuthBrokerReachable(client, revalidation))) {
			try {
				const initialResult = await client.fetchSnapshot({ signal: revalidation });
				if (initialResult.status !== 200)
					throw new AuthBrokerError("Auth broker returned no initial snapshot", {
						status: initialResult.status,
					});
				initialSnapshot = initialResult.snapshot;
				persist?.(initialSnapshot);
			} catch (error) {
				if (!cachedSnapshot || (error instanceof AuthBrokerError && error.kind === "unauthorized")) throw error;
				logger.debug("auth-broker snapshot revalidation failed; starting from cache", { error: String(error) });
			}
		}
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot,
			onSnapshot: persist,
			accountPool,
		});
		return { store, sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}` };
	}

	const dbPath = getAgentDbPath(options.agentDir ?? getAgentDir());
	const store = await SqliteAuthCredentialStore.open(dbPath);
	return { store, sourceLabel: options.sourceLabel ?? `local ${dbPath}` };
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. This is the single source of truth
 * for the TUI and the catalog generator.
 */
export async function discoverAuthStorage(options: DiscoverAuthStorageOptions = {}): Promise<AuthStorage> {
	const agentDir = options.agentDir ?? getAgentDir();
	const brokerConfig = await resolveAuthBrokerConfig({
		agentDir,
		configValueResolver: options.configValueResolver,
	});
	const { accountPolicies, defaultReservePct } = await loadAuthAccountPolicyConfig({
		agentDir,
		accountPolicies: options.accountPolicies,
		usageReservePct: options.authStorageOptions?.defaultReservePct,
	});
	const { store, sourceLabel } = await openAuthCredentialStore({
		brokerConfig,
		agentDir,
		cachePath: options.cachePath,
		sourceLabel: options.sourceLabel,
		accountPool: options.accountPool,
	});
	const storage = new AuthStorage(store, {
		...options.authStorageOptions,
		configValueResolver: options.configValueResolver,
		sourceLabel,
		accountPolicies,
		defaultReservePct,
	});
	await storage.credentials.reload();
	return storage;
}
