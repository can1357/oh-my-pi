/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml/config.yaml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */
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
import { AuthStorage } from "../auth-storage";
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
}

const SNAPSHOT_CACHE_REACHABILITY_TIMEOUT_MS = 500;

/**
 * Bound only the reachability decision. The client's health request uses the
 * same fetch transport (including proxy routing) as snapshot requests, while
 * the authenticated snapshot body keeps its normal request timeout.
 */
async function isAuthBrokerReachable(client: AuthBrokerClient): Promise<boolean> {
	try {
		await client.healthz(AbortSignal.timeout(SNAPSHOT_CACHE_REACHABILITY_TIMEOUT_MS));
		return true;
	} catch (error) {
		// Any HTTP response proves the transport reached the broker. Network and
		// timeout failures leave startup on the fresh cached snapshot.
		return error instanceof AuthBrokerError && error.status !== undefined;
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
		const raw = await Bun.file(getAuthBrokerTokenFilePath()).text();
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
}

/**
 * Resolve a dotted config key (e.g. `auth.broker.url`) against a parsed YAML
 * record, accepting both nested form (`auth: { broker: { url } }`) and the
 * legacy flat literal-dot key (`"auth.broker.url": ...`). Nested wins when both
 * are present. Returns the value only when it is a string.
 */
function readDottedString(record: Record<string, unknown>, dottedKey: string): string | undefined {
	let current: unknown = record;
	for (const segment of dottedKey.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) {
			current = undefined;
			break;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current === "string") return current;
	const flat = record[dottedKey];
	return typeof flat === "string" ? flat : undefined;
}

async function readConfigYaml(agentDir: string): Promise<ConfigSnapshot> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const configPath = path.join(agentDir, filename);
		try {
			const raw = await Bun.file(configPath).text();
			const parsed = YAML.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const record = parsed as Record<string, unknown>;
			const url = readDottedString(record, "auth.broker.url");
			const token = readDottedString(record, "auth.broker.token");
			return { url, token };
		} catch (err) {
			if (isEnoent(err)) continue;
			logger.warn("auth-broker config unreadable", { path: configPath, error: String(err) });
			return {};
		}
	}
	return {};
}

export async function loadAuthBrokerAccountPool(): Promise<AuthBrokerAccountPool | undefined> {
	const filePath = process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE?.trim();
	if (!filePath) return undefined;

	let parsed: unknown;
	try {
		parsed = await Bun.file(filePath).json();
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

	if (brokerConfig) {
		const accountPool = options.accountPool ?? (await loadAuthBrokerAccountPool());
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
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
		if (!cachedSnapshot || (await isAuthBrokerReachable(client))) {
			try {
				// No usable cache must fail normally. With a fresh cache, a
				// reachable broker gets a full authenticated fetch so the current
				// snapshot or an authorization rejection wins synchronously.
				const initialResult = await client.fetchSnapshot();
				if (initialResult.status !== 200)
					throw new AuthBrokerError("Auth broker returned no initial snapshot", {
						status: initialResult.status,
					});
				initialSnapshot = initialResult.snapshot;
				persist?.(initialSnapshot);
			} catch (error) {
				if (!cachedSnapshot || (error instanceof AuthBrokerError && [401, 403].includes(error.status ?? 0)))
					throw error;
			}
		}
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot,
			onSnapshot: persist,
			accountPool,
		});
		const storage = new AuthStorage(store, {
			configValueResolver: options.configValueResolver,
			sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
		});
		await storage.reload();
		return storage;
	}

	const dbPath = getAgentDbPath(agentDir);
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
	});
	await storage.reload();
	return storage;
}
