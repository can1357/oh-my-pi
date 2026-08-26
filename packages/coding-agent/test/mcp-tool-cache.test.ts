/**
 * Tests for `MCPToolCache` cache-identity hashing.
 *
 * Contract: `lazy` and `enabled` are connection *policy* (when to connect,
 * whether to connect at all), not part of a server's identity. Flipping
 * either on an already-cached server must still hit the cache — otherwise
 * every eager-to-lazy transition (the whole point of adding the option to an
 * existing server) orphans the cache and starts the server tool-less until a
 * manual `/mcp reconnect`, and `/mcp enable` writing an explicit
 * `enabled: true` over a previously-omitted key does the same to a
 * re-enabled lazy server. Changes to fields that actually identify the
 * connection (e.g. `command`) must still miss.
 */
import { describe, expect, it } from "bun:test";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";

function fakeStorage(): AgentStorage {
	const store = new Map<string, string>();
	return {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string, _expiresAtSec: number) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
}

const TOOL_DEF: MCPToolDefinition = {
	name: "tool",
	description: "A tool.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function config(overrides?: Partial<MCPStdioServerConfig>): MCPStdioServerConfig {
	return { type: "stdio", command: "server-cmd", args: ["--flag"], ...overrides };
}

describe("MCPToolCache", () => {
	it("hits on an identical config", async () => {
		const cache = new MCPToolCache(fakeStorage());
		await cache.set("srv", config(), [TOOL_DEF]);
		expect(await cache.get("srv", config())).toEqual([TOOL_DEF]);
	});

	it("regression: flipping lazy on an eager-cached server still hits the cache", async () => {
		const cache = new MCPToolCache(fakeStorage());
		const eagerConfig = config();
		await cache.set("srv", eagerConfig, [TOOL_DEF]);

		const cached = await cache.get("srv", { ...eagerConfig, lazy: true });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: flipping lazy back off a lazy-cached server still hits the cache", async () => {
		const cache = new MCPToolCache(fakeStorage());
		const lazyConfig = config({ lazy: true });
		await cache.set("srv", lazyConfig, [TOOL_DEF]);

		const cached = await cache.get("srv", { ...lazyConfig, lazy: false });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: re-enabling a lazy server whose config previously omitted `enabled` still hits the cache", async () => {
		const cache = new MCPToolCache(fakeStorage());
		const omittedConfig = config({ lazy: true });
		await cache.set("srv", omittedConfig, [TOOL_DEF]);

		const cached = await cache.get("srv", { ...omittedConfig, enabled: true });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("misses when an identity-relevant field changes", async () => {
		const cache = new MCPToolCache(fakeStorage());
		await cache.set("srv", config(), [TOOL_DEF]);

		const cached = await cache.get("srv", config({ command: "different-cmd" }));

		expect(cached).toBeNull();
	});

	it("misses for an unknown server name", async () => {
		const cache = new MCPToolCache(fakeStorage());
		await cache.set("srv", config(), [TOOL_DEF]);

		expect(await cache.get("other", config())).toBeNull();
	});
});
