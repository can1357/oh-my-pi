/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPResultCacheHint, MCPServerConfig, MCPToolDefinition } from "./types";

/** Version 2 adds an explicit era/scope policy and millisecond server expiry. */
export const MCP_TOOL_CACHE_VERSION = 2;
const CACHE_PREFIX = "mcp_tools:";
/** Explicit compatibility lifetime used only for initialize-era tool lists. */
export const MCP_LEGACY_TOOL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePolicy =
	| {
			kind: "modern-public";
			cacheScope: "public";
			receivedAtMs: number;
			ttlMs: number;
			expiresAtMs: number;
	  }
	| {
			kind: "legacy-compatibility";
			expiresAtMs: number;
	  };

type MCPToolCachePayload = {
	version: typeof MCP_TOOL_CACHE_VERSION;
	configHash: string;
	tools: MCPToolDefinition[];
	cachePolicy: MCPToolCachePolicy;
};

function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringify(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(
		private storage: AgentStorage,
		private now: () => number = Date.now,
	) {}

	/**
	 * Replace any older reusable record with an immediately stale tombstone.
	 * AgentStorage has no delete primitive; persisting an expired v2 payload
	 * prevents a later process from reviving data superseded by a private or
	 * explicitly non-cacheable response.
	 */
	#invalidate(serverName: string, now: number): void {
		if (this.storage.getCache(cacheKey(serverName)) === null) return;
		const tombstone: MCPToolCachePayload = {
			version: MCP_TOOL_CACHE_VERSION,
			configHash: "",
			tools: [],
			cachePolicy: {
				kind: "modern-public",
				cacheScope: "public",
				receivedAtMs: now,
				ttlMs: 0,
				expiresAtMs: now,
			},
		};
		this.storage.setCache(cacheKey(serverName), JSON.stringify(tombstone), Math.floor(now / 1000));
	}

	async get(serverName: string, config: MCPServerConfig): Promise<MCPToolDefinition[] | null> {
		const raw = this.storage.getCache(cacheKey(serverName));
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		// Version 1 records predate protocol-era/scope metadata. They may have
		// originated from a modern private result under the old fixed 30-day
		// policy, so they are intentionally ignored rather than guessed legacy.
		if (!isRecord(parsed) || parsed.version !== MCP_TOOL_CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string" || !Array.isArray(parsed.tools)) return null;
		if (!parsed.tools.every(tool => isRecord(tool) && typeof tool.name === "string")) return null;

		const cachePolicy = parsed.cachePolicy;
		if (!isRecord(cachePolicy) || !Number.isSafeInteger(cachePolicy.expiresAtMs)) return null;
		if ((cachePolicy.expiresAtMs as number) <= this.now()) return null;
		if (cachePolicy.kind === "modern-public") {
			if (
				cachePolicy.cacheScope !== "public" ||
				!Number.isSafeInteger(cachePolicy.receivedAtMs) ||
				!Number.isSafeInteger(cachePolicy.ttlMs) ||
				(cachePolicy.ttlMs as number) <= 0 ||
				(cachePolicy.receivedAtMs as number) >= (cachePolicy.expiresAtMs as number)
			) {
				return null;
			}
		} else if (cachePolicy.kind !== "legacy-compatibility") {
			return null;
		}

		let currentHash: string;
		try {
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}
		if (parsed.configHash !== currentHash) return null;
		return parsed.tools as MCPToolDefinition[];
	}

	/**
	 * Persist only policy-isolated tool lists. Modern results require a fresh,
	 * scope-consistent public hint. Private/zero/stale/uncertain data is skipped.
	 */
	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		hint: MCPResultCacheHint | undefined,
	): Promise<boolean> {
		const now = this.now();
		let cachePolicy: MCPToolCachePolicy;
		if (hint?.era === "modern") {
			if (
				hint.operation !== "tools/list" ||
				!hint.scopeConsistent ||
				hint.cacheScope !== "public" ||
				!Number.isSafeInteger(hint.receivedAt) ||
				!Number.isSafeInteger(hint.ttlMs) ||
				!Number.isSafeInteger(hint.expiresAt) ||
				hint.ttlMs <= 0 ||
				hint.expiresAt <= now
			) {
				this.#invalidate(serverName, now);
				return false;
			}
			cachePolicy = {
				kind: "modern-public",
				cacheScope: "public",
				receivedAtMs: hint.receivedAt,
				ttlMs: hint.ttlMs,
				expiresAtMs: hint.expiresAt,
			};
		} else if (hint?.era === "legacy-compatibility" && hint.operation === "tools/list") {
			cachePolicy = {
				kind: "legacy-compatibility",
				expiresAtMs: now + MCP_LEGACY_TOOL_CACHE_TTL_MS,
			};
		} else {
			this.#invalidate(serverName, now);
			return false;
		}

		let configHash: string;
		try {
			configHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return false;
		}

		const payload: MCPToolCachePayload = {
			version: MCP_TOOL_CACHE_VERSION,
			configHash,
			tools,
			cachePolicy,
		};
		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return false;
		}

		// AgentStorage expires at whole seconds; ceil prevents early eviction.
		// The payload's exact millisecond expiry prevents serving the final
		// fractional second after the server TTL has elapsed.
		this.storage.setCache(cacheKey(serverName), serialized, Math.ceil(cachePolicy.expiresAtMs / 1000));
		return true;
	}
}
