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

async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringifyJson(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	/**
	 * Per-server monotonic write sequence. `set()` for an empty toolset writes
	 * synchronously, but a non-empty `set()` must first `await hashConfig()`. So
	 * an OLDER non-empty write can still be parked in `hashConfig()` when a NEWER
	 * empty write lands and invalidates — and then resolve and re-persist the
	 * stale non-empty tools for the full TTL. Each `set()` claims the next
	 * sequence at entry and re-checks it immediately before touching storage:
	 * a write superseded by a newer one (any toolset, empty or not) drops
	 * instead of clobbering the newer result.
	 */
	#writeSeq = new Map<string, number>();

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
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		// An empty cached toolset is treated as a MISS. A gateway warming up (or
		// any server mid-restart) can answer `tools/list` with a successful
		// `[]`; caching that as authoritative for 30 days poisoned every later
		// session. Returning null forces a live re-list instead — and self-heals
		// any pre-fix poisoned entry on the next read.
		if (parsed.tools.length === 0) return null;

		return parsed.tools as MCPToolDefinition[];
	}

	async set(serverName: string, config: MCPServerConfig, tools: MCPToolDefinition[]): Promise<void> {
		const seq = (this.#writeSeq.get(serverName) ?? 0) + 1;
		this.#writeSeq.set(serverName, seq);
		const isCurrent = (): boolean => this.#writeSeq.get(serverName) === seq;

		// An empty `tools/list` must never leave a *stale* non-empty entry
		// standing: if the server genuinely dropped its tools, a later slow-start
		// (one whose live list misses the startup race) would load those obsolete
		// tools from cache. So invalidate an existing entry — but never *create*
		// an authoritative empty one (the transient warmup empty this PR fixes).
		// Invalidation writes an already-expired empty row: `getCache`'s
		// `expires_at > now` filter then misses it, `cleanExpiredCache` reaps it,
		// and `get`'s empty-guard is a second line of defense for stores that
		// ignore expiry. A server with nothing cached needs no write at all.
		if (tools.length === 0) {
			if (isCurrent() && this.storage.getCache(cacheKey(serverName)) !== null) {
				const emptyPayload: MCPToolCachePayload = { version: CACHE_VERSION, configHash: "", tools: [] };
				this.storage.setCache(cacheKey(serverName), JSON.stringify(emptyPayload), 0);
			}
			return;
		}

		let configHash: string;
		try {
			configHash = await hashConfig(config);
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

		// Re-check the sequence AFTER the async hash: if a newer `set()` (empty or
		// not) claimed the sequence while we awaited, its result is authoritative
		// — persisting these now would resurrect stale tools past the newer write.
		if (!isCurrent()) return;

		const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}
