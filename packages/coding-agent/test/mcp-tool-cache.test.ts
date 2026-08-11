import { describe, expect, it } from "bun:test";
import {
	MCP_LEGACY_TOOL_CACHE_TTL_MS,
	MCP_TOOL_CACHE_VERSION,
	MCPToolCache,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/tool-cache";
import {
	createMCPLegacyResultCacheHint,
	type MCPResultCacheHint,
	type MCPServerConfig,
	type MCPToolDefinition,
	mergeMCPModernResultCacheHints,
	validateMCPModernCacheableResult,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-storage";

class MemoryCacheStorage {
	readonly values = new Map<string, string>();
	readonly expiries = new Map<string, number>();
	setCalls = 0;

	getCache(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.setCalls++;
		this.values.set(key, value);
		this.expiries.set(key, expiresAtSec);
	}

	asAgentStorage(): AgentStorage {
		return this as unknown as AgentStorage;
	}
}

const CONFIG: MCPServerConfig = { type: "stdio", command: "cache-server", args: ["--profile", "alpha"] };
const OTHER_PROFILE_CONFIG: MCPServerConfig = {
	type: "stdio",
	command: "cache-server",
	args: ["--profile", "beta"],
};
const TOOLS: MCPToolDefinition[] = [{ name: "cached_tool", inputSchema: { type: "object" } }];

function modernHint(now: number, ttlMs: number, cacheScope: "public" | "private") {
	return validateMCPModernCacheableResult(
		"tools/list",
		{ resultType: "complete", ttlMs, cacheScope, tools: TOOLS },
		now,
	);
}

describe("MCPToolCache server policy", () => {
	it("writes versioned public data with the exact server expiry and stops reading it when stale", async () => {
		let now = 1_000_000;
		const storage = new MemoryCacheStorage();
		const cache = new MCPToolCache(storage.asAgentStorage(), () => now);

		expect(await cache.set("docs", CONFIG, TOOLS, modernHint(now, 2_500, "public"))).toBe(true);
		expect(await cache.get("docs", CONFIG)).toEqual(TOOLS);

		const payload = JSON.parse([...storage.values.values()][0] ?? "null") as Record<string, unknown>;
		expect(payload.version).toBe(MCP_TOOL_CACHE_VERSION);
		expect(payload.cachePolicy).toEqual({
			kind: "modern-public",
			cacheScope: "public",
			receivedAtMs: 1_000_000,
			ttlMs: 2_500,
			expiresAtMs: 1_002_500,
		});
		expect([...storage.expiries.values()][0]).toBe(1003);

		now = 1_002_500;
		expect(await cache.get("docs", CONFIG)).toBeNull();
	});

	it("refuses private, zero-TTL, scope-inconsistent, and malformed-scope modern data", async () => {
		const now = 2_000_000;
		const storage = new MemoryCacheStorage();
		const cache = new MCPToolCache(storage.asAgentStorage(), () => now);
		const publicHint = modernHint(now, 10_000, "public");
		const inconsistent = mergeMCPModernResultCacheHints(publicHint, modernHint(now + 1, 9_000, "private"));
		const malformed = { ...publicHint, cacheScope: "session" } as unknown as MCPResultCacheHint;

		expect(await cache.set("private", CONFIG, TOOLS, modernHint(now, 10_000, "private"))).toBe(false);
		expect(await cache.set("zero", CONFIG, TOOLS, modernHint(now, 0, "public"))).toBe(false);
		expect(await cache.set("inconsistent", CONFIG, TOOLS, inconsistent)).toBe(false);
		expect(await cache.set("malformed", CONFIG, TOOLS, malformed)).toBe(false);
		expect(await cache.set("unknown", CONFIG, TOOLS, undefined)).toBe(false);
		expect(storage.setCalls).toBe(0);
	});

	it("invalidates an older public record when a newer result is private or non-cacheable", async () => {
		const now = 2_500_000;
		const storage = new MemoryCacheStorage();
		const cache = new MCPToolCache(storage.asAgentStorage(), () => now);

		expect(await cache.set("docs", CONFIG, TOOLS, modernHint(now, 60_000, "public"))).toBe(true);
		expect(await cache.get("docs", CONFIG)).toEqual(TOOLS);

		expect(await cache.set("docs", CONFIG, TOOLS, modernHint(now + 1, 60_000, "private"))).toBe(false);
		expect(await cache.get("docs", CONFIG)).toBeNull();

		expect(await cache.set("docs", CONFIG, TOOLS, modernHint(now + 2, 60_000, "public"))).toBe(true);
		expect(await cache.set("docs", CONFIG, TOOLS, modernHint(now + 3, 0, "public"))).toBe(false);
		expect(await cache.get("docs", CONFIG)).toBeNull();
	});

	it("isolates public records by server config and storage profile", async () => {
		const now = 3_000_000;
		const firstProfile = new MemoryCacheStorage();
		const secondProfile = new MemoryCacheStorage();
		const firstCache = new MCPToolCache(firstProfile.asAgentStorage(), () => now);
		const secondCache = new MCPToolCache(secondProfile.asAgentStorage(), () => now);

		await firstCache.set("shared-name", CONFIG, TOOLS, modernHint(now, 10_000, "public"));
		expect(await firstCache.get("shared-name", CONFIG)).toEqual(TOOLS);
		expect(await firstCache.get("shared-name", OTHER_PROFILE_CONFIG)).toBeNull();
		expect(await secondCache.get("shared-name", CONFIG)).toBeNull();
	});

	it("ignores unsafe version-1 records rather than guessing that they are legacy", async () => {
		const storage = new MemoryCacheStorage();
		storage.setCache(
			"mcp_tools:old",
			JSON.stringify({ version: 1, configHash: "unknown", tools: TOOLS }),
			Number.MAX_SAFE_INTEGER,
		);
		const cache = new MCPToolCache(storage.asAgentStorage(), () => 4_000_000);
		expect(await cache.get("old", CONFIG)).toBeNull();
	});

	it("retains the explicit legacy compatibility policy with its labeled fixed lifetime", async () => {
		let now = 5_000_000;
		const storage = new MemoryCacheStorage();
		const cache = new MCPToolCache(storage.asAgentStorage(), () => now);
		const hint = createMCPLegacyResultCacheHint("tools/list", [{ value: { tools: TOOLS }, receivedAt: now }]);

		expect(await cache.set("legacy", CONFIG, TOOLS, hint)).toBe(true);
		expect(await cache.get("legacy", CONFIG)).toEqual(TOOLS);
		const payload = JSON.parse([...storage.values.values()][0] ?? "null") as {
			cachePolicy?: { kind?: string; expiresAtMs?: number };
		};
		expect(payload.cachePolicy).toEqual({
			kind: "legacy-compatibility",
			expiresAtMs: now + MCP_LEGACY_TOOL_CACHE_TTL_MS,
		});

		now += MCP_LEGACY_TOOL_CACHE_TTL_MS;
		expect(await cache.get("legacy", CONFIG)).toBeNull();
	});
});
