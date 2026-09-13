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
 *   - `set(name, cfg, [])` never makes an empty toolset authoritative: it
 *     writes only a short-lived invalidation marker, which `get` reports as a
 *     MISS, so every read still triggers a live re-list.
 *   - `get` treats an already-persisted empty toolset as a cache MISS (so a
 *     pre-fix poisoned entry self-heals on the next read).
 *   - A non-empty toolset still round-trips through set/get unchanged.
 *   - A write cannot clobber a newer one that landed while it awaited the
 *     config hash — including a newer write from a *different* cache instance
 *     over the same storage (a second session, or a subagent), and including
 *     when the store started out empty so there was no row to invalidate.
 *   - Of two concurrent NON-empty writes from different cache instances over
 *     one persisted row, the newer catalog wins regardless of which finishes
 *     hashing first — a first-writer-wins path would cache a retired catalog
 *     for the full TTL.
 *   - That ordering survives a peer process replacing the row between a
 *     writer's read and its write: the comparison has to be part of the write,
 *     not a check made against bytes that can go stale before it runs.
 *   - The invalidation marker takes that same ordering: an empty write
 *     descheduled past a newer non-empty write must not replace the populated
 *     cache with a tombstone, while still retiring a catalog older than it.
 *   - The row's ordering token is claimed BEFORE its `tools/list`, so a
 *     delayed response to an earlier request cannot outrank the newer catalog
 *     (or the newer empty-result tombstone) a faster later request persisted,
 *     while a genuinely later request still replaces an earlier catalog.
 *   - The empty-result marker stays readable as long as a populated row, so a
 *     `tools/list` with no bounded lifetime (a large or disabled MCP timeout)
 *     cannot land after the marker expired and re-persist a retired catalog.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { MCPToolCache, toolCatalogObservedAt } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Minimal in-memory stand-in for the AgentStorage methods the cache uses. */
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
		setCacheIfMatches(key: string, expectedValue: string | null, value: string): boolean {
			if ((raw.get(key) ?? null) !== expectedValue) return false;
			raw.set(key, value);
			return true;
		},
	};
	return stub as unknown as AgentStorage & { raw: Map<string, string> };
}

/**
 * Variant honoring the `expires_at > now` filter the real SQLite store applies.
 * The invalidation marker must stay *readable* under this filter — that is how
 * a concurrent writer detects it, and how a delayed `tools/list` response
 * learns its catalog was superseded.
 */
function createExpiringFakeStorage(): AgentStorage & { expiryOf(key: string): number | undefined } {
	const raw = new Map<string, { value: string; expiresAtSec: number }>();
	const visible = (key: string): string | null => {
		const row = raw.get(key);
		if (!row) return null;
		return row.expiresAtSec > Date.now() / 1000 ? row.value : null;
	};
	const stub = {
		getCache(key: string): string | null {
			return visible(key);
		},
		setCache(key: string, value: string, expiresAtSec: number): void {
			raw.set(key, { value, expiresAtSec });
		},
		setCacheIfMatches(key: string, expectedValue: string | null, value: string, expiresAtSec: number): boolean {
			if (visible(key) !== expectedValue) return false;
			raw.set(key, { value, expiresAtSec });
			return true;
		},
		expiryOf(key: string): number | undefined {
			return raw.get(key)?.expiresAtSec;
		},
	};
	return stub as unknown as AgentStorage & { expiryOf(key: string): number | undefined };
}

/**
 * Store that lets another process's write land in the window between a
 * writer's read of the row and the write that read decides.
 *
 * Several CLI processes share one `agent.db`, so the row a writer inspected can
 * be replaced before that writer's own statement runs. The peer is not on this
 * event loop, so no in-process scheduling reproduces it: `armPeerWrite`
 * installs a one-shot that runs immediately after a `getCache` has captured
 * what it will return, so the caller decides on bytes that are already stale.
 *
 * `setCacheIfMatches` does not fire the hook — a conditional write is a single
 * statement and has no such window to model.
 */
function createInterleavedStorage(): AgentStorage & { armPeerWrite(write: (store: PeerWriter) => void): void } {
	const raw = new Map<string, { value: string; expiresAtSec: number }>();
	let armed: ((store: PeerWriter) => void) | undefined;
	const visible = (key: string): string | null => {
		const row = raw.get(key);
		if (!row) return null;
		return row.expiresAtSec > Date.now() / 1000 ? row.value : null;
	};
	const peer: PeerWriter = {
		put(key: string, value: string, expiresAtSec: number): void {
			raw.set(key, { value, expiresAtSec });
		},
	};
	const stub = {
		armPeerWrite(write: (store: PeerWriter) => void): void {
			armed = write;
		},
		getCache(key: string): string | null {
			const observed = visible(key);
			const hook = armed;
			armed = undefined;
			hook?.(peer);
			return observed;
		},
		setCache(key: string, value: string, expiresAtSec: number): void {
			raw.set(key, { value, expiresAtSec });
		},
		setCacheIfMatches(key: string, expectedValue: string | null, value: string, expiresAtSec: number): boolean {
			if (visible(key) !== expectedValue) return false;
			raw.set(key, { value, expiresAtSec });
			return true;
		},
	};
	return stub as unknown as AgentStorage & { armPeerWrite(write: (store: PeerWriter) => void): void };
}

/** The raw row-write another process performs; bypasses the hook it triggers from. */
type PeerWriter = { put(key: string, value: string, expiresAtSec: number): void };

const CONFIG: MCPServerConfig = { type: "stdio", command: "echo" };
const TOOL: MCPToolDefinition = { name: "do_stuff", inputSchema: { type: "object" } };
/** Two distinguishable non-empty catalogs, for the cross-instance write race. */
const OLD_TOOL: MCPToolDefinition = { name: "retired_tool", inputSchema: { type: "object" } };
const NEW_TOOL: MCPToolDefinition = { name: "current_tool", inputSchema: { type: "object" } };

/**
 * A token strictly later than `previous`.
 *
 * Two back-to-back readings can land on the same tick, and the cache resolves a
 * tie in the incumbent row's favor — correct, but not the ordering these tests
 * are about. Spin to the next distinguishable reading so "issued later" is
 * unambiguous. Bounded by the clock's resolution, not by a delay.
 */
function tokenAfter(previous: number): number {
	let next = toolCatalogObservedAt();
	while (next <= previous) next = toolCatalogObservedAt();
	return next;
}

/**
 * A reservation that must have succeeded for the test's premise to hold.
 * `observeCatalogAt()` returns `undefined` when it could not publish its claim,
 * and a test asserting on ordering has nothing to say in that case.
 */
function reserved(cache: MCPToolCache, serverName: string): number {
	const token = cache.observeCatalogAt(serverName);
	if (token === undefined) throw new Error(`claim for ${serverName} was not reserved`);
	return token;
}

describe("MCPToolCache empty-toolset guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("set() never makes an empty toolset authoritative", async () => {
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		await cache.set("litellm", CONFIG, []);

		// Whatever was written is only an invalidation marker: it carries no
		// tools, so every read is a miss and a live re-list still happens.
		const written = storage.raw.get("mcp_tools:litellm");
		if (written !== undefined) {
			const parsed: unknown = JSON.parse(written);
			const tools = parsed && typeof parsed === "object" && "tools" in parsed ? parsed.tools : undefined;
			expect(tools).toEqual([]);
		}
		expect(await cache.get("litellm", CONFIG)).toBeNull();
	});

	test("the invalidation marker outlives a tools/list that has no bounded lifetime", async () => {
		// The marker is the only thing that tells a delayed `tools/list` response
		// its catalog was superseded, and an MCP request has no bound: the timeout
		// is configurable and `timeout: 0` disables it. A marker that expires
		// first goes invisible under the store's `expires_at > now` filter, so the
		// late response sees an absent row, passes the ordering comparison, and
		// persists the retired catalog for the full 30-day TTL.
		const storage = createExpiringFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		// A's `tools/list` goes out first; B's goes out after it and comes back
		// empty, so the server has genuinely dropped its tools.
		const aRequestedAt = toolCatalogObservedAt();
		const bRequestedAt = tokenAfter(aRequestedAt);
		await sessionB.set("litellm", CONFIG, [], bRequestedAt);

		// A's response finally lands long after any short marker window would
		// have closed. Wall-clock only — the ordering tokens are sampled from
		// `performance`, so this moves the store's expiry filter and nothing else.
		const landedAt = Date.now() + 60 * 60 * 1000;
		vi.spyOn(Date, "now").mockReturnValue(landedAt);

		await sessionA.set("litellm", CONFIG, [OLD_TOOL], aRequestedAt);

		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
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

	test("a slower non-empty set() cannot resurrect an entry another cache instance invalidated", async () => {
		const storage = createFakeStorage();
		// Each top-level session builds its own cache over the shared agent.db
		// (`sdk.ts`), and subagents add more — so `#writeSeq` cannot order them.
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		await sessionA.set("litellm", CONFIG, [TOOL]);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([TOOL]);

		// A re-lists non-empty and parks on the async config hash.
		const slowNonEmpty = sessionA.set("litellm", CONFIG, [TOOL]);

		// B observes the server drop its tools and invalidates. A's sequence map
		// never saw this write, so only the persisted state can order the two.
		await sessionB.set("litellm", CONFIG, []);
		expect(await sessionB.get("litellm", CONFIG)).toBeNull();

		// A resolves last. It must not resurrect the tools B retired.
		await slowNonEmpty;
		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
		expect(await sessionB.get("litellm", CONFIG)).toBeNull();
	});

	test("the cross-instance guard holds on a store that honors expiry", async () => {
		const storage = createExpiringFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		await sessionA.set("litellm", CONFIG, [TOOL]);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([TOOL]);

		const slowNonEmpty = sessionA.set("litellm", CONFIG, [TOOL]);
		await sessionB.set("litellm", CONFIG, []);

		await slowNonEmpty;
		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
	});

	test("a slower non-empty set() cannot land after a newer empty result on an initially empty store", async () => {
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		// Nothing cached yet — the store starts empty (or every prior row expired).
		expect(await sessionA.get("litellm", CONFIG)).toBeNull();

		// A lists non-empty and parks on the async config hash, having sampled an
		// absent row.
		const slowNonEmpty = sessionA.set("litellm", CONFIG, [TOOL]);

		// B then observes the server list empty. That result is newer, so A's
		// toolset is obsolete — B must leave a marker A can see, even though there
		// was no row to invalidate.
		await sessionB.set("litellm", CONFIG, []);

		// A resolves last. It must not persist the obsolete tools for the TTL.
		await slowNonEmpty;
		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
		expect(await sessionB.get("litellm", CONFIG)).toBeNull();
	});

	test("the initially-empty-store guard holds on a store that honors expiry", async () => {
		const storage = createExpiringFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		const slowNonEmpty = sessionA.set("litellm", CONFIG, [TOOL]);
		await sessionB.set("litellm", CONFIG, []);

		await slowNonEmpty;
		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
	});

	test("the newer of two concurrent non-empty writes wins even when the older lands first", async () => {
		const storage = createFakeStorage();
		// Two instances over ONE persisted row — the only configuration that
		// reproduces this. `#writeSeq` orders writers inside a single instance;
		// each top-level session builds its own cache over the shared agent.db
		// (`sdk.ts`), and subagents and separate CLI processes add more, so a
		// same-process counter cannot order these two at all.
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		// Both writes are NON-empty — distinct from the resolved empty-write
		// race. Both start against the same (absent) row, so both sample the
		// same `persistedBeforeHash`, and both must await the config hash.
		const older = sessionA.set("litellm", CONFIG, [OLD_TOOL]);
		const newer = sessionB.set("litellm", CONFIG, [NEW_TOOL]);

		await Promise.all([older, newer]);

		// The newer catalog must stand. Pre-fix the post-hash comparison is a
		// bare "did the bytes change", so whichever call finishes hashing first
		// wins: the older one lands, and the newer one sees a changed row and
		// returns early — leaving the retired catalog cached for the full
		// 30-day TTL with nothing to correct it.
		expect(await sessionB.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a later non-empty write still replaces an older cached catalog", async () => {
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		// Over-correction guard for the ordering token: ordering writes by when
		// each `set()` began must not wedge the row against legitimate later
		// updates. These two writes do not race — the first fully completes
		// before the second begins — so the second is unambiguously newer and
		// must land, from a different instance and with the row already
		// carrying the first instance's token.
		await sessionA.set("litellm", CONFIG, [OLD_TOOL]);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([OLD_TOOL]);

		await sessionB.set("litellm", CONFIG, [NEW_TOOL]);

		expect(await sessionB.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("the cross-instance non-empty ordering holds on a store that honors expiry", async () => {
		const storage = createExpiringFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		// Same race against a seeded row rather than an absent one, on a store
		// that applies the real `expires_at > now` filter.
		await sessionA.set("litellm", CONFIG, [TOOL]);

		const older = sessionA.set("litellm", CONFIG, [OLD_TOOL]);
		const newer = sessionB.set("litellm", CONFIG, [NEW_TOOL]);
		await Promise.all([older, newer]);

		expect(await sessionB.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a newer catalog written between the older writer's read and its write still stands", async () => {
		// The bytes a peer process leaves in the row. Built by a real `set()`, so
		// the payload is whatever production writes rather than a hand-rolled
		// shape that could drift from it.
		const peerSource = createFakeStorage();
		await new MCPToolCache(peerSource).set("litellm", CONFIG, [NEW_TOOL]);
		const peerPayload: unknown = JSON.parse(peerSource.raw.get("mcp_tools:litellm") as string);
		if (!isRecord(peerPayload)) throw new Error("peer payload must be an object");

		const storage = createInterleavedStorage();
		const sessionA = new MCPToolCache(storage);

		// A enters first, so A's ordering token is the older one and A's catalog
		// is the earlier observation of the server.
		const older = sessionA.set("litellm", CONFIG, [OLD_TOOL]);
		// Stamp the peer as having entered after A. The peer runs in another
		// process, so this is the only way its token relates to A's; sampling the
		// same clock A samples, one moment later, is exactly that relationship.
		const peerBytes = JSON.stringify({
			...peerPayload,
			writeStartedAt: performance.timeOrigin + performance.now(),
		});

		// The peer's write lands after A has read the row and before A writes it.
		// A therefore decides against bytes that no longer exist, which is the
		// interleaving a same-process scheduler cannot produce: A's read and its
		// write sit in one continuation with no await between them.
		storage.armPeerWrite(peer => {
			peer.put("mcp_tools:litellm", peerBytes, Math.floor(Date.now() / 1000) + 60 * 60);
		});

		await older;

		// A must not overwrite a catalog it never saw. Comparing the token on the
		// value A read cannot prevent that — the comparison is already stale by
		// the time the write runs — so the token has to gate the write itself.
		expect(await sessionA.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("an empty set() descheduled past a newer catalog cannot tombstone it", async () => {
		// The empty write takes no async hash, so `#writeSeq` orders it against
		// everything on its own instance. Across processes there is no such
		// counter: several CLI sessions share one `agent.db`, so an empty write
		// can claim its ordering token, be descheduled, and reach storage after a
		// NEWER non-empty write has committed. Writing unconditionally there
		// replaces a populated cache with a tombstone, and every later startup
		// loses its deferred cached tools until a live list succeeds — worst
		// exactly when the server is slow or unavailable.
		const peerSource = createFakeStorage();
		await new MCPToolCache(peerSource).set("litellm", CONFIG, [NEW_TOOL]);
		const peerPayload: unknown = JSON.parse(peerSource.raw.get("mcp_tools:litellm") as string);
		if (!isRecord(peerPayload)) throw new Error("peer payload must be an object");

		const storage = createInterleavedStorage();
		const sessionA = new MCPToolCache(storage);

		// The peer's write lands after A's empty write read the row and before it
		// writes — the interleaving a same-process scheduler cannot produce,
		// since that read and write sit in one continuation with no await
		// between them. Its token is stamped from inside the hook, so it is
		// sampled after A claimed its own: the peer's catalog is the later
		// observation of the server, which is the relationship being tested.
		storage.armPeerWrite(peer => {
			const peerBytes = JSON.stringify({
				...peerPayload,
				writeStartedAt: performance.timeOrigin + performance.now(),
			});
			peer.put("mcp_tools:litellm", peerBytes, Math.floor(Date.now() / 1000) + 60 * 60);
		});

		await sessionA.set("litellm", CONFIG, []);

		// The newer catalog stands, so a startup still reads it from cache.
		expect(await sessionA.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("an empty set() still retires a catalog that predates it", async () => {
		// Over-correction guard: ordering the marker must not stop it from doing
		// its job. A catalog cached before this empty result is stale, so the
		// marker has to replace it or a later slow-start loads retired tools.
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		await sessionA.set("litellm", CONFIG, [TOOL]);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([TOOL]);

		await sessionB.set("litellm", CONFIG, []);

		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
	});

	test("a delayed response to an earlier tools/list cannot overwrite a newer catalog", async () => {
		// Two sessions share the store. A asks the server first but its response
		// is delayed; B asks second, gets answered promptly, and persists. When
		// A's stale answer finally arrives it must NOT replace B's newer catalog
		// for the 30-day TTL.
		//
		// The ordering token has to be claimed before each `tools/list`, not when
		// its response lands: sampled at write time A's token is the LARGER of
		// the two (its response came back last), so A outranks B and the retired
		// catalog wins.
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		const aRequestedAt = toolCatalogObservedAt();
		const bRequestedAt = tokenAfter(aRequestedAt);

		// B's response arrives and is persisted first.
		await sessionB.set("litellm", CONFIG, [NEW_TOOL], bRequestedAt);
		expect(await sessionB.get("litellm", CONFIG)).toEqual([NEW_TOOL]);

		// A's delayed response lands afterwards, carrying its request-time token.
		await sessionA.set("litellm", CONFIG, [OLD_TOOL], aRequestedAt);

		expect(await sessionA.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a delayed non-empty response cannot replace a newer empty-result tombstone", async () => {
		// Same inversion against the invalidation marker. A's `tools/list` went
		// out first and came back non-empty; B's went out later and came back
		// empty, so the server has genuinely dropped its tools and B's tombstone
		// is the current truth. A's late answer must not resurrect the catalog —
		// a read must stay a miss so a live re-list happens.
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		await sessionA.set("litellm", CONFIG, [TOOL]);

		const aRequestedAt = toolCatalogObservedAt();
		const bRequestedAt = tokenAfter(aRequestedAt);

		await sessionB.set("litellm", CONFIG, [], bRequestedAt);
		expect(await sessionB.get("litellm", CONFIG)).toBeNull();

		await sessionA.set("litellm", CONFIG, [OLD_TOOL], aRequestedAt);

		expect(await sessionA.get("litellm", CONFIG)).toBeNull();
	});

	test("a response to a later tools/list still replaces an earlier catalog", async () => {
		// Over-correction guard: honoring request order must not wedge the row.
		// A asked first and its catalog is cached; B asked afterwards, so B's
		// answer is the newer observation and must land.
		const storage = createFakeStorage();
		const sessionA = new MCPToolCache(storage);
		const sessionB = new MCPToolCache(storage);

		const aRequestedAt = toolCatalogObservedAt();
		await sessionA.set("litellm", CONFIG, [OLD_TOOL], aRequestedAt);
		expect(await sessionA.get("litellm", CONFIG)).toEqual([OLD_TOOL]);

		const bRequestedAt = tokenAfter(aRequestedAt);
		await sessionB.set("litellm", CONFIG, [NEW_TOOL], bRequestedAt);

		expect(await sessionA.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("an earlier request's late response cannot overwrite a newer catalog on one instance", async () => {
		// Both writes are on the SAME cache instance — a connection-time list and
		// a refresh over one session's cache — so the in-instance ordering is
		// what decides them, not the persisted token. The refresh asked the
		// server later but is still hashing when the connection-time response
		// lands. Ordering the two by which entered `set()` last makes that stale
		// response authoritative: it writes its retired catalog, and the newer
		// one then sees itself superseded and drops — leaving the older catalog
		// cached for the full 30-day TTL.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		const olderRequestedAt = toolCatalogObservedAt();
		const newerRequestedAt = tokenAfter(olderRequestedAt);

		// Park the newer write inside the real `hashConfig()` await — the only
		// place a non-empty write sits while another enters behind it. Exactly
		// one digest is deferred, so every later hash (including `get`'s) is real.
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const realDigest = crypto.subtle.digest.bind(crypto.subtle);
		let deferNext = true;
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
			if (!deferNext) return realDigest(algorithm, data);
			deferNext = false;
			entered.resolve();
			await released.promise;
			return realDigest(algorithm, data);
		});

		const newer = cache.set("litellm", CONFIG, [NEW_TOOL], newerRequestedAt);
		// Gate on the hash actually being entered rather than a scheduling guess,
		// so the older write lands in the window the reviewer named.
		await entered.promise;
		await cache.set("litellm", CONFIG, [OLD_TOOL], olderRequestedAt);

		released.resolve();
		await newer;

		expect(await cache.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a newer catalog still wins when the writer's clock reads behind the stored token", async () => {
		// `performance.timeOrigin` is fixed when a process starts, so a backward
		// wall-clock correction splits live processes across two scales: one that
		// started before keeps reading on the old, higher scale, while one started
		// after reads on the corrected, lower one. The second process's genuinely
		// newer `tools/list` then carries the SMALLER token and would lose every
		// comparison, leaving the retired catalog cached for the full TTL.
		//
		// `observeCatalogAt()` floors its reading above the token already on the
		// row, so the persisted sequence is monotonic whatever a single clock says.
		const storage = createFakeStorage();
		const beforeCorrection = new MCPToolCache(storage);
		const afterCorrection = new MCPToolCache(storage);

		// The long-lived process writes first, on the pre-correction scale.
		const highReading = reserved(beforeCorrection, "litellm");
		await beforeCorrection.set("litellm", CONFIG, [OLD_TOOL], highReading);
		expect(await beforeCorrection.get("litellm", CONFIG)).toEqual([OLD_TOOL]);

		// The post-correction process reads an hour lower than the stored token,
		// yet its request goes out later in real time. Mock the raw clock rather
		// than the token so the floor is what has to rescue the ordering.
		vi.spyOn(performance, "now").mockReturnValue(performance.now() - 60 * 60 * 1000);
		const lowReading = reserved(afterCorrection, "litellm");
		expect(lowReading).toBeGreaterThan(highReading);

		await afterCorrection.set("litellm", CONFIG, [NEW_TOOL], lowReading);

		expect(await afterCorrection.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("an earlier request on the corrected clock still loses to the floored row", async () => {
		// The floor must not turn every low reading into a winner: a request that
		// genuinely went out before the stored one must still defer, or the floor
		// would have replaced the ordering with last-writer-wins.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		const first = reserved(cache, "litellm");
		const second = tokenAfter(first);
		await cache.set("litellm", CONFIG, [NEW_TOOL], second);

		// `first` was sampled before the row existed, so it carries no floor and
		// is genuinely the earlier observation.
		await cache.set("litellm", CONFIG, [OLD_TOOL], first);

		expect(await cache.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a claim that never publishes does not write the cache", async () => {
		// The retry loop is bounded, so under sustained contention every attempt
		// can lose. The token it computed is `max(reading, nextAfter(ceiling))` —
		// a long-lived process still on a higher pre-correction clock can compute
		// one ABOVE every winner, and because it never reached the claim row no
		// peer can see it. A newer request then reserves a SMALLER token, and
		// when this delayed response lands `#writeOrdered()` reads it as newest
		// and overwrites the newer catalog for the full TTL. An unreserved token
		// must therefore not order a write at all.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		// A legitimate newer catalog from a peer that DID reserve.
		await cache.set("litellm", CONFIG, [NEW_TOOL], reserved(cache, "litellm"));
		expect(await cache.get("litellm", CONFIG)).toEqual([NEW_TOOL]);

		// Every CAS now loses, exactly as sustained cross-process contention
		// looks from inside one process.
		const contended = new MCPToolCache(storage);
		const cas = vi.spyOn(storage, "setCacheIfMatches").mockReturnValue(false);
		const token = contended.observeCatalogAt("litellm");
		cas.mockRestore();

		// Unreserved: the reservation failed, so there is no order to write with.
		expect(token).toBeUndefined();

		// Passing it through must skip the cache rather than clobber the peer's
		// newer catalog with this unordered one.
		await contended.set("litellm", CONFIG, [OLD_TOOL], token);
		expect(await cache.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a claim reserves its token so a concurrent process floors above it", async () => {
		// The floor only orders a claim against writes that have already LANDED.
		// After a backward correction the dangerous peer is a long-lived
		// pre-correction process whose `tools/list` is still in flight: its high
		// token is nowhere on the row, so a post-correction process reads the
		// older persisted write, floors just above that, and ends up UNDER the
		// stale request — which then outranks the newer catalog for the full TTL.
		const storage = createFakeStorage();
		const beforeCorrection = new MCPToolCache(storage);
		const afterCorrection = new MCPToolCache(storage);

		// A landed write from some earlier pass, so the row carries a low token.
		const seed = reserved(beforeCorrection, "litellm");
		await beforeCorrection.set("litellm", CONFIG, [OLD_TOOL], seed);

		// The pre-correction process issues a request on the HIGHER scale and
		// parks: nothing of it has been written except its claim.
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60 * 60 * 1000);
		const inFlight = reserved(beforeCorrection, "litellm");
		vi.restoreAllMocks();

		// The post-correction process claims afterwards, in real time, on the
		// corrected scale. Without the reservation it would floor above the
		// landed row only and sit below the parked request.
		const later = reserved(afterCorrection, "litellm");
		expect(later).toBeGreaterThan(inFlight);

		// Its catalog is the newest observation, so it must survive the stale
		// response landing afterwards.
		await afterCorrection.set("litellm", CONFIG, [NEW_TOOL], later);
		await beforeCorrection.set("litellm", CONFIG, [OLD_TOOL], inFlight);

		expect(await afterCorrection.get("litellm", CONFIG)).toEqual([NEW_TOOL]);
	});

	test("a reservation keeps serving the catalog already on the row", async () => {
		// The claim rewrites the row before the request answers, so it must carry
		// the existing catalog through untouched: a cache that went cold on every
		// refresh would force a live `tools/list` on each startup.
		const storage = createFakeStorage();
		const cache = new MCPToolCache(storage);

		await cache.set("litellm", CONFIG, [OLD_TOOL], reserved(cache, "litellm"));

		cache.observeCatalogAt("litellm");

		expect(await cache.get("litellm", CONFIG)).toEqual([OLD_TOOL]);
	});

	test("a claim never renews the cached catalog's expiry", async () => {
		// A claim is published BEFORE its `tools/list` answers, so a server whose
		// listing reliably hangs or fails issues claim after claim with no new
		// catalog behind any of them. Writing the claim onto the catalog's row
		// would restate that row's `expires_at` every time — `setCacheIfMatches`
		// always overwrites it — so the obsolete toolset would be renewed
		// indefinitely instead of ageing out 30 days after its last successful
		// listing.
		const storage = createExpiringFakeStorage();
		const cache = new MCPToolCache(storage);

		await cache.set("litellm", CONFIG, [OLD_TOOL], reserved(cache, "litellm"));
		const writtenExpiry = storage.expiryOf("mcp_tools:litellm");
		expect(writtenExpiry).toBeDefined();
		// Later failed attempts: each claims a token, none produces a catalog.
		// The stored expiry is `now + TTL` in whole seconds, so the clock has to
		// advance past a second boundary for a renewal to be a DIFFERENT value —
		// without that, a rewrite lands on the identical number and hides.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
		cache.observeCatalogAt("litellm");
		cache.observeCatalogAt("litellm");

		expect(storage.expiryOf("mcp_tools:litellm")).toBe(writtenExpiry);
		// And the catalog is still served, so nothing went cold either.
		expect(await cache.get("litellm", CONFIG)).toEqual([OLD_TOOL]);
	});

	test("re-floors a claim that lost the reservation race", async () => {
		// The reviewer's race: a peer's claim lands between this process's read of
		// the claim row and the CAS that read decided. Ignoring the `false` return
		// would hand back a token computed against a row that no longer exists —
		// BELOW the winner's — and the request would then lose to a catalog it is
		// genuinely newer than. The retry has to re-read and re-floor.
		const storage = createInterleavedStorage();
		const cache = new MCPToolCache(storage);

		// A peer claims an hour ahead, landing in the read/write window.
		const peerToken = Date.now() + 60 * 60 * 1000;
		storage.armPeerWrite(store => {
			store.put(
				"mcp_tools_claim:litellm",
				JSON.stringify({ claimedAt: peerToken }),
				Math.floor(Date.now() / 1000) + 60 * 60,
			);
		});

		const claimed = reserved(cache, "litellm");

		// Floored above the peer that won, not above the row it had read.
		expect(claimed).toBeGreaterThan(peerToken);
	});
});
