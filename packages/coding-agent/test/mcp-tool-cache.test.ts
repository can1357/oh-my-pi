/**
 * Tests for `MCPToolCache` cache-identity hashing.
 *
 * Contract: `lazy`, `enabled`, `timeout`, `requestIdFormat`, and
 * `instructions` are connection *policy* (when to connect, whether to
 * connect at all, how long to wait for a response, how outgoing request ids
 * are encoded on the wire, whether the server's instructions reach the
 * system prompt), not part of a server's identity. Flipping any of them on an
 * already-cached server must still hit the cache — otherwise every
 * eager-to-lazy transition (the whole point of adding the option to an
 * existing server) orphans the cache and starts the server tool-less until
 * a manual `/mcp reconnect`, `/mcp enable` writing an explicit
 * `enabled: true` over a previously-omitted key does the same to a
 * re-enabled lazy server, raising `timeout` on an already-cached lazy
 * server does the same again (PR #9793 review), and so does switching
 * `requestIdFormat` on an already-cached lazy server (PR #9793 review,
 * post-rebase), and so does opting a cached lazy server out of its
 * instructions (upstream v18.3.1's per-server `instructions: false`).
 * Changes to fields that actually identify the connection
 * (e.g. `command`) must still miss.
 *
 * A second contract covers the migration itself: released builds hash the
 * full config (including an explicit `instructions` value since upstream
 * v18.3.1), and earlier revisions of this change excluded only `lazy`, then
 * also `enabled`, then also `timeout`, then also `requestIdFormat`, all
 * without changing `CACHE_VERSION`. A cache entry written by any of those
 * must still hit under the current scheme —
 * a miss just costs an eager server a slower startup, but a *lazy* server
 * with no cache registers no tools at all and stays dormant until a manual
 * `/mcp reconnect`. `timeout` is numeric and `requestIdFormat` is a closed
 * two-value enum, neither boolean, so their legacy candidates enumerate
 * each field's own documented value space (its default and, for `timeout`,
 * `0`/omission) alongside the *current* config's value, rather than an open
 * value space (see `hashLegacyConfigs`/`timeoutCandidates`/
 * `requestIdFormatCandidates` in `tool-cache.ts`): the migration tests below
 * cover both an unchanged value and a legacy cache written at the
 * documented default that changes value across the upgrade.
 */
import { describe, expect, it } from "bun:test";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { MCPToolCache, sameMcpServerIdentity } from "../src/mcp/tool-cache";
import type { MCPHttpServerConfig, MCPServerConfig, MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
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

	it("regression: PR #9793 review (post-rebase) — changing requestIdFormat on an already-cached server still hits the cache", async () => {
		const cache = new MCPToolCache(fakeStorage());
		const lazyConfig = config({ lazy: true, requestIdFormat: "number" });
		await cache.set("srv", lazyConfig, [TOOL_DEF]);

		const cached = await cache.get("srv", { ...lazyConfig, requestIdFormat: "string" });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: a round-4 cache (`requestIdFormat` still hashed) survives the upgrade to excluding it too, when the value changes", async () => {
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		// Round 4 (the scheme shipped before this fix) excluded `lazy`,
		// `enabled`, and `timeout`; `requestIdFormat` was still part of the
		// hashed identity.
		const preUpgradeConfig = config({ lazy: true, requestIdFormat: "number" });
		await seedLegacyCacheEntry(store, "srv", preUpgradeConfig, ["lazy", "enabled", "timeout"], [TOOL_DEF]);

		const cached = await cache.get("srv", { ...preUpgradeConfig, requestIdFormat: "string" });

		expect(cached).toEqual([TOOL_DEF]);
	});

	it("regression: opting an already-cached lazy server out of its instructions still hits the cache", async () => {
		// `instructions` (upstream v18.3.1) only filters the system prompt; the
		// server's tool catalog is the same either way. The cache on disk was
		// written before the user added the key.
		const cache = new MCPToolCache(fakeStorage());
		const lazyConfig = config({ lazy: true });
		await cache.set("srv", lazyConfig, [TOOL_DEF]);

		expect(await cache.get("srv", { ...lazyConfig, instructions: false })).toEqual([TOOL_DEF]);
		expect(await cache.get("srv", { ...lazyConfig, instructions: true })).toEqual([TOOL_DEF]);
	});

	it("regression: a released-build cache for a server that sets `instructions` survives converting it to lazy", async () => {
		// Released builds hash the full config, and since upstream v18.3.1 that
		// includes an explicit `instructions` value.
		const { storage, store } = fakeStorageWithStore();
		const cache = new MCPToolCache(storage);
		const releasedConfig = config({ instructions: false });
		await seedLegacyCacheEntry(store, "srv", releasedConfig, [], [TOOL_DEF]);

		expect(await cache.get("srv", { ...releasedConfig, lazy: true })).toEqual([TOOL_DEF]);
		expect(await cache.get("srv", config({ lazy: true }))).toEqual([TOOL_DEF]);
	});
});

/**
 * The identity partition itself, field by field.
 *
 * `sameMcpServerIdentity` is the one answer to "is this a different server":
 * the tool cache keys a catalogue on it, and `MCPManager.#holdServerConfig`
 * retires a crashing server's burst budget on it. Each row asserts both, so
 * the two cannot drift apart.
 *
 * Round 11 (confirm pass, F1) found two fields on the wrong side and they
 * wanted *different* repairs, which is why this is a table and not two
 * regressions: `envLiteralKeys` is a set written in the `env` object's key
 * order, so its order is normalised while its membership still counts;
 * `oauth.prompt` is browser-login policy, so it is excluded outright. The
 * rows that must stay different — `envLiteralKeys` membership, `envPolicy`,
 * `headerPolicy`, `oauth.clientId`/`clientSecret`, a changed scope,
 * `auth.credentialId` — are what a blanket exclusion of either field would
 * break, and `args` is the order that genuinely is identity.
 */
describe("MCP server identity", () => {
	const httpConfig = (overrides?: Partial<MCPHttpServerConfig>): MCPHttpServerConfig => ({
		type: "http",
		url: "https://mcp.example.test/mcp",
		...overrides,
	});

	const ROWS: Array<{ id: string; a: MCPServerConfig; b: MCPServerConfig; same: boolean }> = [
		{
			id: "envLiteralKeys written in a different order",
			a: config({ env: { A: "a", B: "b" }, envLiteralKeys: ["A", "B"] }),
			b: config({ env: { A: "a", B: "b" }, envLiteralKeys: ["B", "A"] }),
			same: true,
		},
		{
			id: "envLiteralKeys naming one key twice",
			a: config({ env: { A: "a" }, envLiteralKeys: ["A"] }),
			b: config({ env: { A: "a" }, envLiteralKeys: ["A", "A"] }),
			same: true,
		},
		{
			id: "envLiteralKeys covering one more key",
			a: config({ env: { A: "a", B: "b" }, envLiteralKeys: ["A"] }),
			b: config({ env: { A: "a", B: "b" }, envLiteralKeys: ["A", "B"] }),
			same: false,
		},
		{
			id: "envPolicy making every value literal",
			a: config({ env: { A: "a" } }),
			b: config({ env: { A: "a" }, envPolicy: "literal" }),
			same: false,
		},
		{
			id: "env written in a different order",
			a: config({ env: { A: "a", B: "b" } }),
			b: config({ env: { B: "b", A: "a" } }),
			same: true,
		},
		{
			id: "args in a different order",
			a: config({ args: ["--one", "--two"] }),
			b: config({ args: ["--two", "--one"] }),
			same: false,
		},
		{
			id: "oauth.prompt asking for a different authorization prompt",
			a: config({ oauth: { prompt: "consent" } }),
			b: config({ oauth: { prompt: "login" } }),
			same: true,
		},
		{ id: "oauth carrying nothing but a prompt", a: config(), b: config({ oauth: { prompt: "login" } }), same: true },
		{
			id: "oauth.redirectUri pointing the login somewhere else",
			a: config({ oauth: { redirectUri: "http://127.0.0.1:9000/cb" } }),
			b: config({ oauth: { redirectUri: "http://127.0.0.1:9100/cb" } }),
			same: true,
		},
		{
			id: "oauth.callbackPort and callbackPath moving the loopback listener",
			a: config({ oauth: { callbackPort: 9000, callbackPath: "/cb" } }),
			b: config({ oauth: { callbackPort: 9100, callbackPath: "/callback" } }),
			same: true,
		},
		{
			id: "oauth.scope listing the same scopes in a different order",
			a: config({ oauth: { scope: "read write" } }),
			b: config({ oauth: { scope: "write read" } }),
			same: true,
		},
		{
			id: "oauth.scope asking for one more scope",
			a: config({ oauth: { scope: "read" } }),
			b: config({ oauth: { scope: "read write" } }),
			same: false,
		},
		{
			id: "oauth.clientId presenting a different client",
			a: config({ oauth: { clientId: "client-a" } }),
			b: config({ oauth: { clientId: "client-b" } }),
			same: false,
		},
		{
			id: "oauth.clientSecret presenting a different secret",
			a: config({ oauth: { clientId: "client", clientSecret: "k" } }),
			b: config({ oauth: { clientId: "client", clientSecret: "k2" } }),
			same: false,
		},
		{
			id: "auth.credentialId naming a different stored credential",
			a: config({ auth: { type: "oauth", credentialId: "cred-a" } }),
			b: config({ auth: { type: "oauth", credentialId: "cred-b" } }),
			same: false,
		},
		{
			id: "auth.resource naming a different OAuth resource",
			a: config({ auth: { type: "oauth", credentialId: "cred", resource: "https://a.example.test" } }),
			b: config({ auth: { type: "oauth", credentialId: "cred", resource: "https://b.example.test" } }),
			same: false,
		},
		{
			id: "headers written in a different order",
			a: httpConfig({ headers: { "X-One": "1", "X-Two": "2" } }),
			b: httpConfig({ headers: { "X-Two": "2", "X-One": "1" } }),
			same: true,
		},
		{
			id: "headerPolicy pinning the headers to the URL's origin",
			a: httpConfig({ headers: { "X-One": "1" } }),
			b: httpConfig({ headers: { "X-One": "1" }, headerPolicy: "origin-locked" }),
			same: false,
		},
	];

	for (const row of ROWS) {
		it(`${row.same ? "is the same server" : "is a different server"}: ${row.id}`, async () => {
			const cache = new MCPToolCache(fakeStorage());
			await cache.set("srv", row.a, [TOOL_DEF]);

			// The breaker's answer and the cache's are one answer, by contract.
			expect({
				identity: sameMcpServerIdentity(row.a, row.b),
				catalogue: (await cache.get("srv", row.b)) !== null,
			}).toEqual({ identity: row.same, catalogue: row.same });
		});
	}
});
