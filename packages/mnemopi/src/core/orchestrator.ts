import { createHash } from "node:crypto";
import { envDisabled } from "../util/env";
import type { BeamMemoryState, RecallEnhancedOptions, RecallOptions, RecallResult } from "./beam/types";
import { embedQuery } from "./embeddings";
import {
	type PolyphonicMemoryResult,
	type PolyphonicRecallOptions,
	polyphonicRecall,
	polyphonicRecallIsEnabled,
} from "./polyphonic-recall";
import {
	isQueryCacheEnabled,
	QueryCache,
	type QueryCacheResult,
	type QueryCacheStats,
	type QueryEmbedding,
} from "./query-cache";

export interface OrchestratorBeam extends BeamMemoryState {
	recall?: (query: string, topK?: number, options?: RecallOptions) => Promise<RecallResult[]>;
	recallEnhanced?: (query: string, topK?: number, options?: RecallOptions) => Promise<RecallResult[]>;
}

export interface OrchestrateRecallOptions
	extends Omit<RecallEnhancedOptions, "queryEmbedding">,
		Omit<PolyphonicRecallOptions, "queryEmbedding" | "lengthNormalization" | "scoreFloor"> {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly enhanced?: boolean;
	readonly forcePolyphonic?: boolean;
	readonly forceLinear?: boolean;
	/**
	 * Row-visibility filters that `beam/recall.ts`'s `buildWhere()` reads from whatever options
	 * bag reaches `recall()`/`recallEnhanced()`. They are not part of the public
	 * `RecallOptions`/`RecallEnhancedOptions` contract in `beam/types.ts` -- that module keeps
	 * them on a private `RecallOptionsInternal` extension -- but `toLinearRecallOptions()` below
	 * forwards this options object to the beam unmodified, so a caller setting them (there is no
	 * other typed path to `ignoreSessionScope` at all) already reaches `buildWhere` today. They
	 * are declared here so `cacheDiscriminator` can read them without an inline cast, and so
	 * passing them is type-checked instead of silently relying on structural leniency.
	 */
	readonly ignoreSessionScope?: boolean;
	readonly source?: string | null;
	readonly topic?: string | null;
	readonly veracity?: string | null;
	readonly memoryType?: string | null;
}

/**
 * Superset of {@link RecallResult} carrying the polyphonic-only proof fields.
 *
 * `RecallResult` has a `[key: string]: unknown` index signature, so
 * `Omit<RecallResult, K>` collapses to `{ [x: string]: unknown }` and erases every
 * named property — including the required `id`/`content`. They are therefore
 * re-declared explicitly, otherwise this type is not assignable to `RecallResult`
 * and every consumer (e.g. `coding-agent` `mergeRecallResult`) fails to type-check.
 */
export interface OrchestratedRecallResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	id: string;
	content: string;
	score?: number;
	metadata?: RecallResult["metadata"];
	tier?: RecallResult["tier"] | PolyphonicMemoryResult["tier"];
	combined_score?: PolyphonicMemoryResult["combined_score"];
	voice_scores?: PolyphonicMemoryResult["voice_scores"];
}

function toLinearRecallOptions(options: OrchestrateRecallOptions): RecallOptions {
	if (options.queryEmbedding instanceof Float32Array) {
		return { ...options, queryEmbedding: Array.from(options.queryEmbedding) };
	}
	return options as RecallOptions;
}

/**
 * Each voice is individually killable via `MNEMOPI_VOICE_VECTOR|GRAPH|FACT|TEMPORAL` (see the
 * local `envDisabled` in `polyphonic-recall.ts`, mirrored here through the shared `../util/env`
 * helper of the same name and "0"/"false"/"no"/"off" semantics). Flipping one changes what
 * `polyphonicRecall` returns for an otherwise-identical query, so a negative-control run (e.g.
 * `MNEMOPI_VOICE_GRAPH=0`) must never be served a cache hit produced under a different voice
 * mix -- see `cacheDiscriminator` below.
 */
function voiceEnvMask(): string {
	const vector = envDisabled("MNEMOPI_VOICE_VECTOR") ? "0" : "1";
	const graph = envDisabled("MNEMOPI_VOICE_GRAPH") ? "0" : "1";
	const fact = envDisabled("MNEMOPI_VOICE_FACT") ? "0" : "1";
	const temporal = envDisabled("MNEMOPI_VOICE_TEMPORAL") ? "0" : "1";
	return `${vector}${graph}${fact}${temporal}`;
}

/**
 * `QueryCache` keys tier1/tier4 purely on normalized query text, and tiers 2/3 match by
 * embedding cosine similarity across every entry it holds -- neither tier is aware that two
 * calls sharing the same query text can legitimately want different result sets. Fold every
 * dimension that changes what `orchestrateRecall` would otherwise compute into one compact,
 * readable discriminator string, and route each distinct discriminator to its own physical
 * `QueryCache` instance (`OrchestratorQueryCache` below) instead of baking it into the query
 * text handed to a single shared instance: tier2's cosine >= 0.88 branch never consults the key
 * text, so a text suffix would still let it cross-match two different discriminators whenever
 * the real query happens to embed near-identically.
 */
/**
 * Every option `beam/recall.ts`'s `buildWhere()` reads to decide which rows a call is even
 * allowed to see, folded into one key segment -- `buildWhere` is that module's single source of
 * truth for row visibility and is not exported, so this list is hand-maintained; a new option
 * added there MUST be added here too. (`factVisibilityWhere()`, the other visibility-relevant
 * function in that module, reads only `beam.sessionId` and schema state, neither of which
 * varies per call -- `sess=` below already covers it.)
 *
 * `ignoreSessionScope`, a non-empty `channelId`, and either `authorId`/`authorType` are each a
 * *different* widening path in `buildWhere` -- `1=1` (whole bank), `session_id OR scope='global'
 * OR channel_id` (channel-widened), and `1=1` again (author-widened) respectively -- so each
 * gets its own segment rather than being collapsed into one "is this call widened" boolean: two
 * calls that widen along different axes can still resolve to different row sets. The remaining
 * fields (`fromDate`/`toDate`/`source`/`topic`/`veracity`/`memoryType`) are plain equality
 * filters `buildWhere` ANDs onto the same clause. Values are read positionally (never via
 * `JSON.stringify` of an object literal) so the segment order -- and therefore the resulting
 * key -- cannot drift with a options bag's key insertion order.
 */
function visibilityDiscriminator(options: OrchestrateRecallOptions): string {
	const ignoreSessionScope = options.ignoreSessionScope === true ? "1" : "0";
	const channelId = options.channelId ?? "";
	const authorId = options.authorId ?? "";
	const authorType = options.authorType ?? "";
	const fromDate = options.fromDate ?? "";
	const toDate = options.toDate ?? "";
	const source = options.source ?? "";
	const topic = options.topic ?? "";
	const veracity = options.veracity ?? "";
	const memoryType = options.memoryType ?? "";
	return (
		`isc=${ignoreSessionScope}|ch=${channelId}|aid=${authorId}|atype=${authorType}|` +
		`from=${fromDate}|to=${toDate}|src=${source}|topic=${topic}|ver=${veracity}|mtype=${memoryType}`
	);
}

function cacheDiscriminator(
	beam: OrchestratorBeam,
	topK: number,
	polyphonic: boolean,
	options: OrchestrateRecallOptions,
): string {
	// `mode` separates the three dispatch branches below: only `polyphonicRecall` emits
	// `combined_score`/`graph` voice scores, and `recallEnhanced` merges in facts/synonyms that
	// plain `recall` does not -- their result shapes are not interchangeable.
	const mode = polyphonic ? "poly" : options.enhanced === true ? "enh" : "lin";
	const includeFacts = options.includeFacts === true ? "1" : "0";
	// Length mode, score floor and pool floor all alter the final candidate set for the same
	// query/topK; never serve a cache entry across any of those A/B boundaries. poolFloor was
	// added as a forwarded option without a discriminator term, so two calls differing only in
	// poolFloor shared a bucket and the second was served the first arm's rows -- silently wrong
	// in exactly the A/B comparison the knob exists for.
	const lengthNormalization = options.lengthNormalization ?? "none";
	const scoreFloor =
		typeof options.scoreFloor === "number" && Number.isFinite(options.scoreFloor)
			? Math.max(0, options.scoreFloor)
			: 0;
	const poolFloor =
		typeof options.poolFloor === "number" && Number.isFinite(options.poolFloor) ? Math.max(0, options.poolFloor) : 0;
	// `contentPreviewChars` clips returned content, so it shapes the rows a caller receives even
	// though it does not change which rows are selected. QueryCache tier 1 keys on the normalized
	// query alone, so without this term a 100-char-preview call and a clipping-disabled call share a
	// bucket and the second is served the first one's truncated rows.
	const preview =
		typeof options.contentPreviewChars === "number" && Number.isFinite(options.contentPreviewChars)
			? Math.max(0, Math.trunc(options.contentPreviewChars))
			: "default";
	// Only a CALLER-SUPPLIED embedding may partition buckets, and the three input states are
	// semantically distinct, so they must not collapse:
	//   undefined -> auto-derive; ALL such calls share one bucket, which is what lets QueryCache
	//                tier 2/3 match a cached result for a similar but DIFFERENT query text
	//   null      -> explicitly FTS-only, a different result set, so its own bucket
	//   number[]  -> caller-supplied vector, one bucket per distinct vector
	// Passing the RESOLVED embedding here instead would give every distinct query text its own
	// physical bucket and destroy tier 2/3 cross-query reuse entirely.
	const explicit = options.queryEmbedding;
	const embedding =
		explicit === undefined
			? "auto"
			: explicit === null
				? "none"
				: explicit.length === 0
					? "empty"
					: createHash("sha256").update(Array.from(explicit).join(",")).digest("hex");
	return `${mode}|k=${topK}|facts=${includeFacts}|len=${lengthNormalization}|floor=${scoreFloor}|pool=${poolFloor}|prev=${preview}|emb=${embedding}|${visibilityDiscriminator(options)}|sess=${beam.sessionId}|voices=${voiceEnvMask()}`;
}

/**
 * One physical `QueryCache` per `cacheDiscriminator()` bucket, all reachable from a single
 * `beam.caches.queryCache` slot -- exactly the property `invalidateCaches()` in `beam/store.ts`
 * already probes (`beam.caches.queryCache?.invalidate?.()`) at every remember/forget/consolidate
 * site. A single slot (rather than one cache keyed per discriminator directly on `beam.caches`)
 * is what lets that pre-existing hook clear every bucket in one shot instead of only the one a
 * caller happens to name.
 */
export class OrchestratorQueryCache {
	readonly #buckets = new Map<string, QueryCache>();

	#bucket(discriminator: string): QueryCache {
		let bucket = this.#buckets.get(discriminator);
		if (bucket === undefined) {
			// No `dbPath`/`db_path` -> stays purely in-memory; never write a persistence table
			// into the beam's own SQLite schema from here.
			bucket = new QueryCache({});
			this.#buckets.set(discriminator, bucket);
		}
		return bucket;
	}

	get(discriminator: string, query: string, embedding: QueryEmbedding | null): readonly QueryCacheResult[] | null {
		return this.#bucket(discriminator).get(query, embedding);
	}

	put(
		discriminator: string,
		query: string,
		results: readonly QueryCacheResult[],
		embedding: QueryEmbedding | null,
	): void {
		this.#bucket(discriminator).put(query, results, embedding);
	}

	/** Probed by `invalidateCaches()` in `beam/store.ts` on every remember/forget/consolidate. */
	invalidate(): void {
		for (const bucket of this.#buckets.values()) bucket.invalidate();
	}

	/** Aggregate stats across every discriminator bucket touched so far in this process. */
	/**
	 * Number of physical buckets, i.e. distinct discriminators seen.
	 *
	 * `stats().size` sums ENTRIES across buckets, so it cannot distinguish one bucket holding two
	 * queries from two buckets holding one each — exactly the difference between correct keying and
	 * over-partitioning that destroys tier-2/3 cross-query reuse.
	 */
	get bucketCount(): number {
		return this.#buckets.size;
	}

	stats(): QueryCacheStats {
		let hits = 0;
		let misses = 0;
		let tier1Hits = 0;
		let tier2Hits = 0;
		let tier3Hits = 0;
		let tier4Hits = 0;
		let size = 0;
		let maxSize = 0;
		let version = 0;
		for (const bucket of this.#buckets.values()) {
			const bucketStats = bucket.stats();
			hits += bucketStats.hits;
			misses += bucketStats.misses;
			tier1Hits += bucketStats.tier1_hits;
			tier2Hits += bucketStats.tier2_hits;
			tier3Hits += bucketStats.tier3_hits;
			tier4Hits += bucketStats.tier4_hits;
			size += bucketStats.size;
			maxSize += bucketStats.max_size;
			version = Math.max(version, bucketStats.version);
		}
		const total = hits + misses;
		return {
			hits,
			misses,
			hit_rate: total > 0 ? Math.round((hits / total) * 1000) / 1000 : 0,
			tier1_hits: tier1Hits,
			tier2_hits: tier2Hits,
			tier3_hits: tier3Hits,
			tier4_hits: tier4Hits,
			size,
			max_size: maxSize,
			version,
		};
	}
}

function getOrchestratorQueryCache(beam: OrchestratorBeam): OrchestratorQueryCache {
	const existing = beam.caches.queryCache;
	if (existing instanceof OrchestratorQueryCache) return existing;
	const created = new OrchestratorQueryCache();
	beam.caches.queryCache = created;
	return created;
}

export async function orchestrateRecall(
	beam: OrchestratorBeam,
	query: string,
	topK = 20,
	options: OrchestrateRecallOptions = {},
): Promise<OrchestratedRecallResult[]> {
	const polyphonic = !options.forceLinear && (options.forcePolyphonic === true || polyphonicRecallIsEnabled());
	let queryEmbedding: readonly number[] | Float32Array | null | undefined = options.queryEmbedding;
	if (queryEmbedding === undefined && query.length > 0) {
		// Auto-derive when the caller did not pass one. `embedQuery()` returns null when
		// embeddings are disabled or no provider is configured, so this is a no-op for
		// FTS-only deployments. `null` (explicit "no embedding") is preserved untouched.
		queryEmbedding = await embedQuery(query);
	}

	// Query cache: a single call opts out with `useCache: false`; the global gate is
	// `MNEMOPI_ENHANCED_RECALL` (`isQueryCacheEnabled`), which defaults OFF. When disabled this
	// entire block is skipped -- no lookup, no store, and every branch below runs exactly as it
	// did before this change, so callers who have not opted in see zero behaviour difference.
	const cacheEnabled = isQueryCacheEnabled(options.useCache !== false);
	let cache: OrchestratorQueryCache | null = null;
	let discriminator: string | null = null;
	let cacheEmbedding: QueryEmbedding | null = null;
	if (cacheEnabled) {
		cache = getOrchestratorQueryCache(beam);
		discriminator = cacheDiscriminator(beam, topK, polyphonic, options);
		if (queryEmbedding instanceof Float32Array) cacheEmbedding = Array.from(queryEmbedding);
		else if (queryEmbedding !== null && queryEmbedding !== undefined) cacheEmbedding = queryEmbedding;
		const cached = cache.get(discriminator, query, cacheEmbedding);
		if (cached !== null) return cached as unknown as OrchestratedRecallResult[];
	}

	let results: OrchestratedRecallResult[];
	if (polyphonic) {
		results = polyphonicRecall(beam, query, topK, { ...options, queryEmbedding });
	} else {
		const linearOptions = toLinearRecallOptions({ ...options, queryEmbedding });
		if (options.enhanced === true && typeof beam.recallEnhanced === "function") {
			results = await beam.recallEnhanced(query, topK, linearOptions);
		} else if (typeof beam.recall === "function") {
			results = await beam.recall(query, topK, linearOptions);
		} else {
			results = [];
		}
	}

	if (cache !== null && discriminator !== null) {
		cache.put(discriminator, query, results as unknown as readonly QueryCacheResult[], cacheEmbedding);
	}
	return results;
}
