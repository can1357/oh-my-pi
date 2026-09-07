/**
 * Regression test: a transient empty `tools/list` must never poison the MCP
 * tool cache.
 *
 * An aggregating MCP gateway (e.g. LiteLLM fronting several upstream servers)
 * answers `tools/list` with a *successful* `{"tools":[]}` for a ~15-20s window
 * after (re)start, before its upstream sessions warm up. `MCPToolCache` keys on
 * the config hash with a 30-day TTL, so caching that empty array made every
 * subsequent session read zero tools until the TTL or a config change cleared
 * it — a whole-session, cross-restart MCP outage.
 *
 * Contract this test defends:
 *   - `set(name, cfg, [])` writes nothing (empty is never authoritative).
 *   - `get` treats an already-persisted empty toolset as a cache MISS (so a
 *     pre-fix poisoned entry self-heals on the next read).
 *   - A non-empty toolset still round-trips through set/get unchanged.
 */
import { describe, expect, test } from "bun:test";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

/** Minimal in-memory stand-in for the two AgentStorage methods the cache uses. */
function createFakeStorage(): AgentStorage & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const stub = {
		raw,
		getCache(key: string): string | null {
			return raw.get(key) ?? null;
		},
		setCache(key: string, value: string): void {
			raw.set(key, value);
		},
	};
	return stub as unknown as AgentStorage & { raw: Map<string, string> };
}

const CONFIG: MCPServerConfig = { type: "stdio", command: "echo" };
const TOOL: MCPToolDefinition = { name: "do_stuff", inputSchema: { type: "object" } };

describe("MCPToolCache empty-toolset guard", () => {
	test("set() does not persist an empty toolset", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		await cache.set("litellm", CONFIG, []);

		expect(storage.raw.size).toBe(0);
		expect(await cache.get("litellm", CONFIG)).toBeNull();
	});

	test("get() treats an already-cached empty toolset as a miss", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		// Simulate a pre-fix poisoned entry: a non-empty cache round-trips, then
		// the same key is overwritten with an empty toolset out of band.
		await cache.set("litellm", CONFIG, [TOOL]);
		const poisoned = storage.raw.get("mcp_tools:litellm");
		expect(poisoned).toBeDefined();
		const parsed = JSON.parse(poisoned as string) as { tools: MCPToolDefinition[] };
		parsed.tools = [];
		storage.raw.set("mcp_tools:litellm", JSON.stringify(parsed));

		expect(await cache.get("litellm", CONFIG)).toBeNull();
	});

	test("non-empty toolset round-trips unchanged", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		await cache.set("litellm", CONFIG, [TOOL]);
		const got = await cache.get("litellm", CONFIG);

		expect(got).toEqual([TOOL]);
	});

	test("set() invalidates a stale non-empty entry when the server later lists empty", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		// Server had tools last session (authoritative, cached)...
		await cache.set("litellm", CONFIG, [TOOL]);
		expect(await cache.get("litellm", CONFIG)).toEqual([TOOL]);

		// ...then genuinely drops them and lists empty. The old entry must not
		// survive its 30-day TTL, or a later slow-start would load obsolete tools
		// from cache. After invalidation the cache reads as a miss.
		await cache.set("litellm", CONFIG, []);
		expect(await cache.get("litellm", CONFIG)).toBeNull();
	});

	test("a slower older non-empty set() cannot clobber a newer empty result", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		// Seed a real cached toolset so the empty write has something to invalidate.
		await cache.set("litellm", CONFIG, [TOOL]);
		expect(await cache.get("litellm", CONFIG)).toEqual([TOOL]);

		// A non-empty write races: it must `await hashConfig()` before it can
		// persist. Start it but do NOT await — it is now parked on the async hash.
		const slowNonEmpty = cache.set("litellm", CONFIG, [TOOL]);

		// A NEWER empty result lands and invalidates synchronously (empty writes
		// take no async hash).
		await cache.set("litellm", CONFIG, []);
		expect(await cache.get("litellm", CONFIG)).toBeNull();

		// The older non-empty write now resolves. It must NOT resurrect the stale
		// tools past the newer empty write — the read stays a miss.
		await slowNonEmpty;
		expect(await cache.get("litellm", CONFIG)).toBeNull();
	});
});
