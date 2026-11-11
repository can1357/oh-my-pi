/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentStorageApi } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
};

/**
 * A stdio server without an explicit `cwd` runs in the session's project
 * directory, so two projects can configure the same name and command yet
 * expose different tools. The cache therefore keys and hashes the effective
 * working directory whenever the config leaves `cwd` unset.
 */
function hashConfig(config: MCPServerConfig, scope?: string): string {
	const scoped = "cwd" in config ? undefined : scope;
	const effective = scoped === undefined ? config : { ...config, cwd: scoped };
	return Bun.SHA256.hash(stableStringifyJson(effective), "hex");
}

function cacheKey(serverName: string, config: MCPServerConfig, scope?: string): string {
	const scoped = "cwd" in config ? undefined : scope;
	if (scoped === undefined) return `${CACHE_PREFIX}${serverName}`;
	return `${CACHE_PREFIX}${serverName}@${Bun.SHA256.hash(scoped, "hex").slice(0, 16)}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorageApi) {}

	async get(serverName: string, config: MCPServerConfig, scope?: string): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName, config, scope);
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
			currentHash = hashConfig(config, scope);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		return parsed.tools as MCPToolDefinition[];
	}

	async set(serverName: string, config: MCPServerConfig, tools: MCPToolDefinition[], scope?: string): Promise<void> {
		let configHash: string;
		try {
			configHash = hashConfig(config, scope);
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
		this.storage.setCache(cacheKey(serverName, config, scope), serialized, expiresAtSec);
	}
}
