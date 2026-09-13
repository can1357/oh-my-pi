/**
 * Tests for `MCPToolCache` cache-identity hashing.
 *
 * Contract: `lazy`, `enabled`, and `timeout` are connection *policy* (when
 * to connect, whether to connect at all, how long to wait for a response),
 * not part of a server's identity. Flipping any of them on an
 * already-cached server must still hit the cache — otherwise every
 * eager-to-lazy transition (the whole point of adding the option to an
 * existing server) orphans the cache and starts the server tool-less until
 * a manual `/mcp reconnect`, `/mcp enable` writing an explicit
 * `enabled: true` over a previously-omitted key does the same to a
 * re-enabled lazy server, and raising `timeout` on an already-cached lazy
 * server does the same again (PR #9793 review). Changes to fields that
 * actually identify the connection (e.g. `command`) must still miss.
 *
 * A second contract covers the migration itself: the current hashing scheme
 * is the fourth one this cache has shipped (full config, then excluding
 * only `lazy`, then also `enabled`, then also `timeout`), and
 * `CACHE_VERSION` never changed across those. A cache entry written by an
 * older scheme must still hit under the new one — a miss just costs an
 * eager server a slower startup, but a *lazy* server with no cache
 * registers no tools at all and stays dormant until a manual
 * `/mcp reconnect`. `timeout` is numeric, not boolean, so its legacy
 * candidates enumerate the field's own documented sentinels (its default,
 * `0`, and omission) alongside the *current* config's value, rather than an
 * open value space (see `hashLegacyConfigs`/`timeoutCandidates` in
 * `tool-cache.ts`): the migration tests below cover both an unchanged value
 * and a legacy cache written at the documented default that changes value
 * across the upgrade (PR #9793 review, round 2).
 */
import { describe, expect, it } from "bun:test";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";

function fakeStorage(): AgentStorage {
	return fakeStorageWithStore().storage;
}

function fakeStorageWithStore(): { storage: AgentStorage; store: Map<string, string> } {
	const store = new Map<string, string>();
	const storage = {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string, _expiresAtSec: number) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
	return { storage, store };
}

/** Hashes `config` the way a retired `hashConfig` algorithm did, for seeding a legacy cache entry. */
async function legacyHash(config: MCPStdioServerConfig, excludedKeys: readonly string[]): Promise<string> {
	const identity: Record<string, unknown> = { ...config };
	for (const key of excludedKeys) delete identity[key];
	const stable = stableStringifyJson(identity);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Writes a cache entry directly, bypassing `MCPToolCache.set`, to simulate a pre-upgrade cache on disk. */
async function seedLegacyCacheEntry(
	store: Map<string, string>,
	serverName: string,
	config: MCPStdioServerConfig,
	excludedKeys: readonly string[],
	tools: MCPToolDefinition[],
): Promise<void> {
	const configHash = await legacyHash(config, excludedKeys);
	store.set(`mcp_tools:${serverName}`, JSON.stringify({ version: 1, configHash, tools }));
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

	it("regression: a pre-lazy-connect cache (full config hashed, `enabled` included) survives converting the server to lazy", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		const preUpgradeConfig = config({ enabled: true });
		// Simulate a cache written before this cache ever stripped policy
		// fields out of the hashed identity.
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, [], [TOOL_DEF]);

		const cached = await cache.get("srv", { ...preUpgradeConfig, lazy: true });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: a round-2 cache (only `lazy` excluded, `enabled` still hashed) survives the upgrade to excluding `enabled` too", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		// A server whose config always carried an explicit `enabled: true` —
		// round 2 baked that value into the hash, so upgrading to round 5
		// (which also strips `enabled`) changes the hash with no config edit
		// at all.
		const lazyConfig = config({ lazy: true, enabled: true });
		await seedLegacyCacheEntry(store, "srv", lazyConfig, ["lazy"], [TOOL_DEF]);

		const cached = await cache.get("srv", lazyConfig);

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("still misses a legacy cache when an identity-relevant field changed", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		const preUpgradeConfig = config({ enabled: true });
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, [], [TOOL_DEF]);

		const cached = await cache.get("srv", { ...preUpgradeConfig, lazy: true, command: "different-cmd" });

		expect(cached).toBeNull();
	});

	it("regression: a round-2 cache written with `enabled: true` survives the user dropping `enabled` while adopting `lazy`", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		// Round 2 hashed `enabled` into the entry; the current config no longer
		// carries the key at all, so legacy candidates recomputed from *current*
		// policy values alone can never reproduce that hash — the variants must
		// be enumerated. The connection identity is unchanged throughout.
		const preUpgradeConfig = config({ enabled: true });
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, ["lazy"], [TOOL_DEF]);

		const currentConfig = config({ lazy: true });
		const cached = await cache.get("srv", currentConfig);

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: a round-1 cache (nothing excluded) with explicit `lazy: false, enabled: true` survives both keys being dropped", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		const preUpgradeConfig = config({ lazy: false, enabled: true });
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, [], [TOOL_DEF]);

		const currentConfig = config({ lazy: true });
		const cached = await cache.get("srv", currentConfig);

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: PR #9793 review — changing timeout on an already-cached server still hits the cache", async () => {
		const cache = new MCPToolCache(fakeStorage());
		const lazyConfig = config({ lazy: true, timeout: 30_000 });
		await cache.set("srv", lazyConfig, [TOOL_DEF]);

		const cached = await cache.get("srv", { ...lazyConfig, timeout: 60_000 });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: PR #9793 review (round 2) — a round-3 cache written at the documented timeout default survives both the upgrade and a value change", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		// Round 3 hashed the documented default (30_000ms) because the config
		// never set `timeout` explicitly; upgrading and setting an explicit,
		// different value in the same step must still hit — the default is a
		// documented sentinel, not an unknowable historical number.
		const preUpgradeConfig = config({ lazy: true, timeout: 30_000 });
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, ["lazy", "enabled"], [TOOL_DEF]);

		const cached = await cache.get("srv", { ...preUpgradeConfig, timeout: 60_000 });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: a round-3 cache (`timeout` still hashed) survives the upgrade to excluding it too, when the value is unchanged", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		// Round 3 (the scheme shipped before this fix) excluded only `lazy`
		// and `enabled`; `timeout` was still part of the hashed identity.
		const lazyConfig = config({ lazy: true, timeout: 45_000 });
		await seedLegacyCacheEntry(store, "srv", lazyConfig, ["lazy", "enabled"], [TOOL_DEF]);

		const cached = await cache.get("srv", lazyConfig);

		expect(cached).toEqual([TOOL_DEF]);
	});
});
