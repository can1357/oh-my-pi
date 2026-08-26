/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
};

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

/**
 * Fields excluded from cache-identity hashing because they are connection
 * *policy* (when to connect, whether to connect at all), not part of the
 * server's identity — flipping either on an already-cached server must
 * still hit the cache, or an eager-to-lazy transition orphans the cache and
 * starts the server tool-less.
 */
const CURRENT_IDENTITY_EXCLUDED_KEYS: readonly (keyof MCPServerConfig)[] = ["lazy", "enabled"];

/**
 * Identity-exclusion sets used by every prior cache-identity hashing scheme,
 * recent first: excluding only `lazy` (before `enabled` was added to the
 * exclusion set), then excluding neither (the shape that shipped before this
 * cache computed a policy-stripped identity at all). Checked on a miss so a
 * cache written under an older release still hits. This is required, not an
 * optimization: an eager server that misses just reconnects in the
 * background and repopulates its cache, but a *lazy* server with no cache
 * registers no tools at all and stays dormant until a manual
 * `/mcp reconnect` (see `connectServers` in `manager.ts`) — every algorithm
 * change here would otherwise strand every already-lazy server on upgrade.
 */
const LEGACY_IDENTITY_EXCLUDED_KEYS: ReadonlyArray<readonly (keyof MCPServerConfig)[]> = [["lazy"], []];

function stripKeys(config: MCPServerConfig, keys: readonly (keyof MCPServerConfig)[]): Record<string, unknown> {
	const identity: Record<string, unknown> = { ...config };
	for (const key of keys) delete identity[key];
	return identity;
}

async function hashIdentity(identity: Record<string, unknown>): Promise<string> {
	const stable = stableStringifyJson(identity);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

/**
 * Every policy-value combination a legacy scheme could have baked into its
 * hash for `keys`: each key absent, `true`, or `false`. Legacy hashes must
 * enumerate these rather than reuse the *current* config's policy values —
 * a version-1 cache written from `{ command, enabled: true }` has to match
 * today's `{ command, lazy: true }` (user dropped the redundant `enabled`
 * while adopting `lazy`), because policy fields are by definition not part
 * of the server's identity. Values are booleans only: discovery coerces the
 * accepted string forms before an `MCPServerConfig` ever reaches hashing.
 */
function policyVariants(keys: readonly (keyof MCPServerConfig)[]): Record<string, boolean>[] {
	let variants: Record<string, boolean>[] = [{}];
	for (const key of keys) {
		variants = variants.flatMap(variant => [variant, { ...variant, [key]: true }, { ...variant, [key]: false }]);
	}
	return variants;
}

/** Hashes of `config` under every retired identity-exclusion set, for cache-miss migration. */
async function hashLegacyConfigs(config: MCPServerConfig): Promise<string[]> {
	const identity = stripKeys(config, CURRENT_IDENTITY_EXCLUDED_KEYS);
	const hashes = new Set<string>();
	for (const excluded of LEGACY_IDENTITY_EXCLUDED_KEYS) {
		// Policy keys the legacy scheme still hashed (did not yet exclude).
		const hashedPolicyKeys = CURRENT_IDENTITY_EXCLUDED_KEYS.filter(key => !excluded.includes(key));
		for (const variant of policyVariants(hashedPolicyKeys)) {
			hashes.add(await hashIdentity({ ...identity, ...variant }));
		}
	}
	return [...hashes];
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	async get(serverName: string, config: MCPServerConfig): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = await hashIdentity(stripKeys(config, CURRENT_IDENTITY_EXCLUDED_KEYS));
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) {
			let legacyHashes: string[];
			try {
				legacyHashes = await hashLegacyConfigs(config);
			} catch (error) {
				logger.warn("MCP tool cache legacy hash failed", { serverName, error: String(error) });
				return null;
			}
			if (!legacyHashes.includes(parsed.configHash)) return null;
		}

		return parsed.tools as MCPToolDefinition[];
	}

	async set(serverName: string, config: MCPServerConfig, tools: MCPToolDefinition[]): Promise<void> {
		let configHash: string;
		try {
			configHash = await hashIdentity(stripKeys(config, CURRENT_IDENTITY_EXCLUDED_KEYS));
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}
