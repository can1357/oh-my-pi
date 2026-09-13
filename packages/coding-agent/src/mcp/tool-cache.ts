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
/**
 * Prefix for the per-server ordering CLAIM, kept in its own row rather than on
 * the catalog's.
 *
 * A claim has to be published before the `tools/list` it orders has answered,
 * so it would otherwise rewrite the catalog row while that catalog is still
 * the newest thing known. `setCacheIfMatches` always restates `expires_at` and
 * the store cannot report a row's current expiry, so every such rewrite would
 * renew the cached listing's 30-day life without a new listing behind it — a
 * server whose `tools/list` reliably hangs would keep an obsolete catalog alive
 * forever. A separate key means the catalog row is never touched by a claim, so
 * it ages out from its last SUCCESSFUL write no matter how many requests are
 * attempted against it.
 */
const CLAIM_PREFIX = "mcp_tools_claim:";
/**
 * How long a claim row lives.
 *
 * A claim is an ordering high-water mark, and it must not expire while a
 * request it orders can still land. A `tools/list` has no bounded lifetime —
 * the timeout is configurable and `timeout: 0` disables it — so no span tied to
 * a request duration is safe, and matching the catalog TTL was not either: a
 * listing outstanding past that window loses its mark, and a process starting
 * afterwards (across a backward clock correction) reserves a SMALLER token,
 * persists the current catalog, and is then overwritten when the delayed
 * response lands carrying its larger pre-correction token.
 *
 * The mark is cheap — one number per server — and only ever pushes the next
 * claim higher, never suppresses a write, so it is kept effectively forever
 * rather than sized against a request that has no maximum duration.
 */
const CLAIM_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
/**
 * How long an invalidation marker stays readable — the same TTL a populated
 * row gets.
 *
 * The marker carries the ordering token that tells a delayed `tools/list`
 * response its catalog has been superseded, and an MCP request has no bounded
 * lifetime: the timeout is configurable and `timeout: 0` disables it outright.
 * A marker that expires while such a request is still in flight is invisible
 * to `getCache`, so the response that finally lands sees an absent row, passes
 * the write comparison, and persists the retired catalog for the full TTL with
 * nothing to correct it. Outliving an in-flight `hashConfig()` — the window a
 * shorter TTL was sized for — is only the nearer half of the job.
 *
 * Keeping it costs one row: `get` reports an empty toolset as a MISS for as
 * long as the marker stands, so it never withholds tools, and any later
 * non-empty listing replaces it.
 */
const CACHE_TOMBSTONE_TTL_MS = CACHE_TTL_MS;
/**
 * How many times a non-empty write re-decides against a row another writer
 * committed under it. Every refusal means a peer's write landed, so a real
 * contention run terminates on its own; this only bounds a key being hammered
 * by many processes at once, where giving up simply leaves the peer's newer
 * row in place.
 */
const CACHE_CLAIM_ATTEMPTS = 4;

/**
 * Backstop for {@link MCPToolCache.#writeOrdered}, which exits on the row's
 * ordering token rather than on this count. Every CAS loss there is a peer
 * commit, and a peer at or above our token takes the early return, so the
 * losses that keep the loop running are older writers — one per request already
 * in flight against this server. The bound only has to outlast that, and exists
 * for a storage layer that never reports success.
 */
const CACHE_WRITE_ATTEMPTS = 64;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
	/**
	 * When the `tools/list` that produced this row was ISSUED, as a Unix-epoch
	 * millisecond reading. Persisted so it travels with the row: it is the only
	 * ordering signal two writers in *different* processes share, and it is
	 * sampled before the request rather than after its response so it orders the
	 * calls by when each asked the server, not by which response came back (or
	 * finished hashing) first.
	 *
	 * Absent on rows written before this field existed; {@link readWriteStartedAt}
	 * reports that as unknown and the comparison stays conservative.
	 */
	writeStartedAt?: number;
};

/**
 * The claim row's payload: one server's highest in-flight ordering token.
 *
 * Kept out of {@link MCPToolCachePayload} on purpose. A claim is published
 * before its `tools/list` answers, so writing it onto the catalog row would
 * restate that row's expiry and keep an obsolete catalog alive for as long as
 * requests keep being attempted; and folding it into `writeStartedAt` would
 * make an unfinished request look like a completed write and block its own
 * result from landing.
 */
type MCPToolClaimPayload = {
	claimedAt: number;
};

/**
 * The ordering token on a persisted row, or `undefined` when the row is absent,
 * unparseable, or predates the field.
 */
function readWriteStartedAt(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const startedAt = parsed.writeStartedAt;
	return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : undefined;
}

/**
 * The token on a claim row, or `undefined` when it is absent or unparseable.
 */
function readClaimedAt(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const claimed = parsed.claimedAt;
	return typeof claimed === "number" && Number.isFinite(claimed) ? claimed : undefined;
}

/**
 * The highest of a completed write's token and an in-flight claim's, or
 * `undefined` when neither exists.
 *
 * A new claim must clear both: a server can hold a finished catalog while a
 * newer request is still outstanding, and flooring above only one of them
 * lands the next claim under the other.
 */
function orderingCeiling(catalogRaw: string | null, claimRaw: string | null): number | undefined {
	const candidates = [readWriteStartedAt(catalogRaw), readClaimedAt(claimRaw)].filter(
		(value): value is number => value !== undefined,
	);
	return candidates.length === 0 ? undefined : Math.max(...candidates);
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
	const stable = stableStringifyJson(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

/**
 * Sample the cross-process ordering token for a `tools/list` that is about to
 * be issued, and hand it to the {@link MCPToolCache.set} that persists the
 * response.
 *
 * `Date.now()` alone is millisecond-granular, so two catalogs observed in the
 * same millisecond would tie; `performance.now()` adds sub-millisecond
 * resolution while `timeOrigin` keeps the reading on the epoch scale every
 * process shares (a bare `performance.now()` is process-relative and would not
 * compare).
 *
 * Capture it BEFORE the request. Sampling it when the response arrives orders
 * two writers by response latency instead of by request order, so a delayed
 * response to an EARLIER `tools/list` would carry the LARGER token and
 * overwrite the newer catalog a faster later request already persisted — for
 * the full cache TTL, with nothing to correct it.
 *
 * The reading is floored above the token already on the row, which is what
 * keeps the sequence usable across a BACKWARD wall-clock step. `timeOrigin` is
 * fixed when a process starts, so a correction splits live processes across two
 * scales: one started before keeps reading high, one started after reads low.
 * The second process's genuinely newer `tools/list` would then carry the
 * SMALLER token, lose every comparison, and leave the retired catalog cached
 * for the full TTL. Flooring makes the persisted sequence monotonic whatever a
 * single clock reads.
 *
 * The bare function takes no store, so it cannot read that floor — callers that
 * have a cache should use {@link MCPToolCache.observeCatalogAt}, which does.
 * This spelling stays for callers with no cache (a test, an out-of-band
 * invalidation) and is the behaviour a single-process run already had. Neither
 * makes two processes that never see each other's row comparable — only a
 * shared logical counter would — but an unordered pair is the case
 * `unorderable` already handles conservatively.
 */
export function toolCatalogObservedAt(): number {
	return performance.timeOrigin + performance.now();
}

/**
 * The smallest token strictly greater than `value`.
 *
 * The tokens are fractional-millisecond doubles, so an integer bump would
 * overshoot a sub-millisecond ordering the readings themselves can express.
 * `Math.nextUp` is not available, and adding a fixed epsilon is a no-op once
 * the value is large enough that the epsilon falls below its ULP — which is
 * exactly the range these live in. Scaling by the next representable double
 * keeps the step at one ULP.
 */
function nextAfter(value: number): number {
	if (!Number.isFinite(value)) return value;
	if (value === 0) return Number.MIN_VALUE;
	const buffer = new DataView(new ArrayBuffer(8));
	buffer.setFloat64(0, value);
	const bits = buffer.getBigUint64(0);
	buffer.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
	return buffer.getFloat64(0);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

function claimKey(serverName: string): string {
	return `${CLAIM_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	/**
	 * Claim the ordering token for a `tools/list` about to be issued for
	 * `serverName`, floored above everything already known for that server and
	 * PUBLISHED before returning.
	 *
	 * The floor is what survives a backward wall-clock step: see
	 * {@link toolCatalogObservedAt} for why a bare reading can fall behind a
	 * live process that started on the pre-correction scale.
	 *
	 * Flooring alone orders this claim against writes that have already landed,
	 * not against requests still in flight elsewhere. Several CLI processes
	 * share one `agent.db`, so after a backward correction a long-lived
	 * pre-correction process holds a high token that appears nowhere until its
	 * `tools/list` answers — a process started after the correction floors above
	 * the older catalog only, lands under that parked request, and loses to a
	 * catalog that was already stale. Publishing the claim makes it visible, so
	 * the next claimer floors above it instead of under it.
	 *
	 * The claim goes in its OWN row ({@link CLAIM_PREFIX}), never on the
	 * catalog's: see {@link MCPToolClaimPayload}.
	 *
	 * Returns `undefined` when the claim could not be published within
	 * {@link CACHE_CLAIM_ATTEMPTS}: an unreserved token must never order a
	 * write, so that request skips caching rather than risking an inversion.
	 *
	 * Publishing is a CAS, and a lost race is re-driven rather than ignored.
	 * Losing means a peer's claim landed between this read and this write, so
	 * the token just computed was floored against state that no longer holds —
	 * returning it would hand back an unpublished token BELOW the winner's,
	 * which is the inversion this exists to prevent. Every loss is a peer
	 * succeeding, so a contended server still terminates.
	 */
	observeCatalogAt(serverName: string): number | undefined {
		const catalog = cacheKey(serverName);
		const claim = claimKey(serverName);
		let claimed = 0;
		for (let attempt = 0; attempt < CACHE_CLAIM_ATTEMPTS; attempt++) {
			const claimRaw = this.storage.getCache(claim);
			const ceiling = orderingCeiling(this.storage.getCache(catalog), claimRaw);
			const reading = toolCatalogObservedAt();
			claimed = ceiling === undefined ? reading : Math.max(reading, nextAfter(ceiling));
			const serialized = JSON.stringify({ claimedAt: claimed } satisfies MCPToolClaimPayload);
			const expiresAtSec = Math.floor((Date.now() + CLAIM_TTL_MS) / 1000);
			if (this.storage.setCacheIfMatches(claim, claimRaw, serialized, expiresAtSec)) return claimed;
		}
		// Out of attempts: nothing this request computed was ever published.
		// Returning it anyway is not safe in the direction the old comment here
		// claimed. The token is `max(reading, nextAfter(ceiling))`, so a
		// long-lived process still on a higher pre-correction clock can compute a
		// token ABOVE every winner — invisible to peers, because it never
		// reached the claim row. A newer request then reserves a SMALLER token,
		// and when this request's delayed response lands, `#writeOrdered()` reads
		// it as the newest and overwrites the newer catalog (or its tombstone)
		// for the full TTL. That is the inversion the claim exists to prevent.
		//
		// A request whose order cannot be established does not get to write:
		// `undefined` means "unreserved", and `set()` skips the cache entirely.
		// The live tools are unaffected — only the persisted catalog is skipped,
		// and the next list re-populates it.
		return undefined;
	}

	/**
	 * The newest request-time ordering token any `set()` on this instance has
	 * carried for a server. `set()` for an empty toolset writes synchronously,
	 * but a non-empty `set()` must first `await hashConfig()`. So a write whose
	 * `tools/list` went out EARLIER can still be parked in `hashConfig()` when a
	 * newer one lands — and then resolve and re-persist a superseded catalog for
	 * the full TTL. Every `set()` records its token at entry and re-checks it
	 * immediately before touching storage: a write a later-issued one superseded
	 * drops instead of clobbering the newer result.
	 *
	 * The mark is a high-water reading of {@link toolCatalogObservedAt}, not an
	 * arrival counter. Entry order is response order, so a counter makes
	 * whichever response came back last authoritative: a newer refresh parked in
	 * `hashConfig()` would be knocked out by an earlier request's late response
	 * simply because that response entered afterwards, and the older catalog
	 * would then be cached for the full TTL. Comparing the same request-time
	 * token {@link set} persists keeps both halves of the ordering on one clock.
	 *
	 * This orders writers within ONE instance only, which is why it cannot be
	 * the whole story: every top-level session builds its own cache over the
	 * shared store (`sdk.ts`), and subagents and separate CLI processes add
	 * more. A same-process map cannot see a writer in another one — see the
	 * persisted `writeStartedAt` token that {@link set} compares for the
	 * cross-instance half.
	 */
	#newestObserved = new Map<string, number>();

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

	/**
	 * Persist a `tools/list` response.
	 *
	 * `observedAt` is the caller's {@link toolCatalogObservedAt} reading, taken
	 * BEFORE it issued the `tools/list` this `tools` array answers. It becomes
	 * the row's cross-process ordering token. Sampling it here instead would
	 * order two writers by when their responses came back: a delayed response to
	 * an EARLIER request would then carry the LARGER token and overwrite the
	 * newer catalog a faster later request already persisted (or replace its
	 * empty-result tombstone) for the full TTL. Optional for callers with no
	 * request to anchor on — an out-of-band invalidation, or a test — which fall
	 * back to sampling now.
	 */
	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		...observed: [] | [observedAt: number | undefined]
	): Promise<void> {
		// An OMITTED token means "no request to anchor on" (an out-of-band
		// invalidation, or a test) and samples now. An explicit `undefined` is a
		// FAILED reservation from `observeCatalogAt()`: that write has no
		// established order, so it must not touch the cache at all. The two cases
		// are opposite, which is why they cannot share a `?? sampleNow()`.
		if (observed.length === 1 && observed[0] === undefined) {
			// Unreserved, so this response must not be cached — but it still
			// OBSERVED the server, and later than anything already in flight here.
			// Returning without marking that left an earlier request free to pass
			// `isCurrent()` and `#writeOrdered()` (which inspects the catalog row,
			// never the claim) and persist its superseded catalog for 30 days.
			// Sampling now is sound because every earlier request's token was read
			// before this one entered, so the mark is above all of them and below
			// anything that enters next.
			const unreservedAt = toolCatalogObservedAt();
			const seen = this.#newestObserved.get(serverName);
			this.#newestObserved.set(serverName, Math.max(seen ?? unreservedAt, unreservedAt));
			return;
		}
		const writeStartedAt = observed[0] ?? toolCatalogObservedAt();
		const newestSeen = this.#newestObserved.get(serverName);
		this.#newestObserved.set(serverName, Math.max(newestSeen ?? writeStartedAt, writeStartedAt));
		// A write is still current while nothing issued LATER has entered `set()`
		// on this instance. A tie keeps us current — two readings can land on the
		// same tick, and the storage comparison resolves that in the incumbent
		// row's favor rather than dropping both.
		const isCurrent = (): boolean => (this.#newestObserved.get(serverName) ?? writeStartedAt) <= writeStartedAt;

		// An empty `tools/list` must never leave a *stale* non-empty entry
		// standing: if the server genuinely dropped its tools, a later slow-start
		// (one whose live list misses the startup race) would load those obsolete
		// tools from cache. So invalidate — but never *create* an authoritative
		// empty one (the transient warmup empty this PR fixes): the marker is an
		// empty toolset, which `get` reports as a MISS for as long as it is
		// readable, so a live re-list still happens on every read.
		//
		// The marker is written even when nothing is cached. It is the only state
		// a concurrent writer in another instance shares with us, and that writer
		// may already be parked in `hashConfig()` holding an obsolete non-empty
		// toolset sampled when the row was absent. With no write, its post-hash
		// re-read still sees `null`, matches its own pre-hash sample, and persists
		// those obsolete tools for the full 30-day TTL. A visible row is what
		// makes that comparison fail.
		//
		// Hence a *live* row rather than an already-expired one: an expired row is
		// invisible to `getCache`'s `expires_at > now` filter, so no concurrent
		// writer could detect it. See {@link CACHE_TOMBSTONE_TTL_MS} for why the
		// row has to stay readable as long as a populated one.
		if (tools.length === 0) {
			if (!isCurrent()) return;
			const emptyPayload: MCPToolCachePayload = {
				version: CACHE_VERSION,
				configHash: "",
				tools: [],
				writeStartedAt,
			};
			// The marker takes the SAME storage-level ordering the non-empty path
			// takes. An empty write has no `hashConfig()` to park in, but it can
			// still be descheduled between claiming `writeStartedAt` and reaching
			// storage — several CLI processes share one `agent.db`, and
			// `#newestObserved` cannot see a writer in another one. An unconditional
			// write there overwrites a NEWER populated cache with a tombstone, and
			// every later startup then loses its deferred cached tools until a
			// live list succeeds — worst exactly when the server is slow or down.
			// So the same token comparison and the same conditional write decide
			// this one: defer to a row a newer `set()` already committed, replace
			// an older one, and re-decide when the row moves under us.
			this.#writeOrdered({
				serverName,
				payload: emptyPayload,
				ttlMs: CACHE_TOMBSTONE_TTL_MS,
				writeStartedAt,
				unorderable: "replace",
			});
			return;
		}

		// Sample the persisted bytes BEFORE the await. `#newestObserved` cannot see a
		// concurrent writer in another instance — each top-level session builds
		// its own cache over the shared store, and subagents add more — so the
		// stored row is the only state both writers share, and its ordering
		// token is what tells us which of them observed the server later.
		// Re-compared below.
		const persistedBeforeHash = this.storage.getCache(cacheKey(serverName));

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
			writeStartedAt,
		};

		// Re-check the same-instance ordering AFTER the async hash: a `set()`
		// whose `tools/list` went out later (any toolset, empty or not) has
		// entered on this instance, so its result is authoritative and persisting
		// these now would resurrect a catalog it already superseded.
		if (!isCurrent()) return;

		// Then the cross-instance ordering, which `#newestObserved` cannot see:
		// each top-level session builds its own cache over the shared store, and
		// subagents and separate CLI processes add more.
		this.#writeOrdered({
			serverName,
			payload,
			ttlMs: CACHE_TTL_MS,
			writeStartedAt,
			baseline: { bytes: persistedBeforeHash },
			unorderable: "drop",
		});
	}

	/**
	 * Persist `serialized` only while it is still the newest observation of the
	 * server, comparing the ordering token on the row it would replace.
	 *
	 * The one storage-level ordering both write paths take. "Did the bytes
	 * change" is not enough on its own: two writes can start against the same
	 * row, and whichever reaches storage first would win regardless of which saw
	 * the server later — first-writer-wins, so an older catalog can outlive a
	 * newer one for the full TTL. The persisted token records when the *winning*
	 * `tools/list` was issued, so a call whose request went out earlier defers to
	 * a row a newer request already wrote, and a call whose request went out
	 * later replaces it even though the bytes changed under it.
	 *
	 * Deciding from a row we merely *read* settles nothing: a writer in another
	 * process shares only the store, so it can replace the row between our read
	 * and our write and we would overwrite a decision we never saw. So the row
	 * we compared is also the row the write requires — `setCacheIfMatches`
	 * refuses when the stored bytes moved, and we re-decide against whatever
	 * landed instead. Each refusal means some other writer committed, so the
	 * loop makes progress; the bound only stops a pathologically busy key from
	 * spinning, and giving up leaves that writer's row standing, which is the
	 * conservative outcome.
	 *
	 * A row carrying a token is ALWAYS compared, never skipped because it is the
	 * same row the caller sampled before its `await`. With a request-time token
	 * those two facts came apart: a write whose `tools/list` went out first can
	 * enter `set()` after a newer write has already committed, so the row it
	 * samples pre-hash is the newer one and "unchanged since I looked" no longer
	 * implies "nothing newer landed".
	 *
	 * `baseline` therefore only decides an UNORDERABLE row — one with no
	 * comparable token, so pre-token-field or unparseable. A row still identical
	 * to what the caller sampled is one it already accounted for, which is what
	 * lets a write upgrade a legacy row; any other unorderable row takes the
	 * caller's `unorderable` direction. A caller with no await passes none and
	 * every unorderable row takes that direction.
	 *
	 * `unorderable` decides a row carrying no comparable token — absent bytes
	 * aside, an unparseable row or one written before the field existed. Nothing
	 * orders us against it, so each caller takes its own conservative direction:
	 * a catalog write drops (never displace a row that might be newer), while an
	 * invalidation marker replaces it (its worst case is one forced live re-list,
	 * and retiring an unorderable stale catalog is the reason it is written).
	 *
	 * The token itself is floored above whatever the store already holds when it
	 * is SAMPLED, not here — see {@link toolCatalogObservedAt}. Flooring at write
	 * time would be too late: the comparison above would already have rejected a
	 * reading that fell behind the stored row.
	 */
	#writeOrdered(args: {
		serverName: string;
		payload: MCPToolCachePayload;
		ttlMs: number;
		writeStartedAt: number;
		baseline?: { bytes: string | null };
		unorderable: "drop" | "replace";
	}): void {
		const key = cacheKey(args.serverName);
		// Bounded by the SEMANTIC exit below, not by the attempt count. A CAS loss
		// proves only that a peer committed — not that its catalog is newer — so
		// stopping after a fixed number of losses leaves an older toolset cached
		// for the full TTL despite this newer listing having succeeded. Every loss
		// is a peer commit, and a peer whose token is at or above ours takes the
		// early return, so the losses that keep us here are all older writers:
		// finite, one per request already in flight. The count remains only as a
		// backstop against a storage layer that never reports success.
		for (let attempt = 0; attempt < CACHE_WRITE_ATTEMPTS; attempt++) {
			const persistedNow = this.storage.getCache(key);
			const persistedStartedAt = readWriteStartedAt(persistedNow);
			if (persistedStartedAt !== undefined) {
				// The row's `tools/list` was issued at or after ours, so it is the
				// newer observation of the server. Leave it standing.
				if (persistedStartedAt >= args.writeStartedAt) return;
			} else if (persistedNow !== args.baseline?.bytes && args.unorderable === "drop") {
				return;
			}

			let serialized: string;
			try {
				serialized = JSON.stringify(args.payload);
			} catch (error) {
				logger.warn("MCP tool cache serialize failed", { serverName: args.serverName, error: String(error) });
				return;
			}

			const expiresAtSec = Math.floor((Date.now() + args.ttlMs) / 1000);
			if (this.storage.setCacheIfMatches(key, persistedNow, serialized, expiresAtSec)) return;
		}

		logger.debug("MCP tool cache write contended out", { serverName: args.serverName });
	}
}
