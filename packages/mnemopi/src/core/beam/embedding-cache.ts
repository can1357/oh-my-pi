import type { Database, SQLQueryBindings } from "bun:sqlite";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";

/**
 * Decoded `memory_embeddings` vectors, kept per SQLite connection so recall does not parse every
 * candidate's embedding JSON on each call.
 *
 * Staleness rules:
 * - Writes through this connection go through {@link forgetCachedEmbeddings} /
 *   {@link clearCachedEmbeddings} at every site that inserts, replaces or deletes embedding rows. A caller
 *   that writes `memory_embeddings` through raw SQL on the same connection must call
 *   {@link forgetCachedEmbeddings} for those ids too.
 * - A commit from any other connection (another session sharing the bank) bumps `PRAGMA data_version`.
 *   Most of those commits (recall counts, new memories) leave every vector as it was, so the cache is
 *   dropped only when `memory_embedding_generation`, which triggers bump on every embedding insert, update
 *   and delete, moved too.
 * - Inside an open transaction rows may be uncommitted, and ROLLBACK does not bump `data_version`, so
 *   reads there neither use nor fill the cache.
 *
 * `null` records "no usable embedding row", so ids still waiting for their vector are not
 * re-queried on every recall; the insert that later stores the vector forgets that entry.
 *
 * Vectors are kept as `Float32Array`: embedding models emit float32, so this loses nothing for
 * them and halves the memory of `Float64Array`. The cache holds at most {@link MAX_CACHED_VECTORS}
 * entries and {@link MAX_CACHED_BYTES} of vector data per connection, whichever is reached first,
 * evicting the least recently used first: all 20,000 fit at 384, 768 and 1024 dimensions (31, 61 and
 * 82 MB); a 3,584-dimension model is capped by bytes at about 7,000 vectors.
 */
interface ConnectionCache {
	dataVersion: number;
	generation: number;
	vectors: LRUCache<string, Float32Array | null>;
}

const caches = new WeakMap<Database, ConnectionCache>();
const FETCH_CHUNK = 500;
/** Bounds a connection whose scored rows keep moving (new memories push old ones out of the recall window). */
export const MAX_CACHED_VECTORS = 20_000;
/** Bounds memory for high-dimensional models, where 20,000 vectors would take hundreds of megabytes. */
export const MAX_CACHED_BYTES = 96 * 1024 * 1024;
/** A cached "no embedding" marker or empty vector still holds a key; count it at a nominal size. */
const NOMINAL_ENTRY_BYTES = 64;

function decodeEmbedding(raw: unknown): Float32Array | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return null;
		const vector = new Float32Array(parsed.length);
		for (let i = 0; i < parsed.length; i += 1) {
			const value = Number(parsed[i]);
			if (!Number.isFinite(value)) return null;
			vector[i] = value;
		}
		return vector;
	} catch {
		return null;
	}
}

// shortcut: a foreign commit that leaves vectors alone, landing after this connection wrote some, drops the cache
// once (the counter moved and data_version cannot say who moved it); track own bumps if that shows up in profiles.
function currentCache(db: Database): ConnectionCache {
	// One statement reads both from one snapshot; separate reads could pass a peer's bump off as this connection's.
	const state = db
		.query<{ dataVersion: number; generation: number }, []>(
			"SELECT (SELECT data_version FROM pragma_data_version) AS dataVersion, gen AS generation FROM memory_embedding_generation",
		)
		.get();
	const dataVersion = state?.dataVersion ?? 0;
	const generation = state?.generation ?? 0;
	const existing = caches.get(db);
	// An unchanged data_version means only this connection committed, and its writes forgot their own ids.
	if (existing && (existing.dataVersion === dataVersion || existing.generation === generation)) {
		existing.dataVersion = dataVersion;
		existing.generation = generation;
		return existing;
	}
	const fresh: ConnectionCache = {
		dataVersion,
		generation,
		vectors: new LRUCache<string, Float32Array | null>({
			max: MAX_CACHED_VECTORS,
			maxSize: MAX_CACHED_BYTES,
			// The LRU requires a positive size; an empty stored vector (`[]`) has none of its own.
			sizeCalculation: vector => (vector && vector.byteLength > 0 ? vector.byteLength : NOMINAL_ENTRY_BYTES),
		}),
	};
	caches.set(db, fresh);
	return fresh;
}

/** Stored embeddings for `memoryIds`; `null` for ids without a usable row. */
function readEmbeddings(db: Database, memoryIds: readonly string[]): Map<string, Float32Array | null> {
	const out = new Map<string, Float32Array | null>();
	for (let offset = 0; offset < memoryIds.length; offset += FETCH_CHUNK) {
		const chunk = memoryIds.slice(offset, offset + FETCH_CHUNK);
		const rows = db
			.query<{ memory_id: string; embedding_json: unknown }, SQLQueryBindings[]>(
				`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${chunk.map(() => "?").join(",")})`,
			)
			.all(...chunk);
		const found = new Map<string, Float32Array | null>();
		for (const row of rows) found.set(row.memory_id, decodeEmbedding(row.embedding_json));
		for (const id of chunk) out.set(id, found.get(id) ?? null);
	}
	return out;
}

/**
 * Decoded embeddings for `memoryIds`, listed in one fixed order whatever the cache holds (recall breaks similarity
 * ties by this order); ids without a usable embedding are absent from the result.
 */
export function cachedEmbeddings(db: Database, memoryIds: readonly string[]): Map<string, Float32Array> {
	let found: Map<string, Float32Array | null>;
	if (db.inTransaction) {
		found = readEmbeddings(db, memoryIds);
	} else {
		const { vectors } = currentCache(db);
		found = new Map();
		const missing: string[] = [];
		for (const id of memoryIds) {
			const vector = vectors.get(id);
			if (vector === undefined) missing.push(id);
			else found.set(id, vector);
		}
		for (const [id, vector] of readEmbeddings(db, missing)) {
			vectors.set(id, vector);
			found.set(id, vector);
		}
	}
	// Each 500-id chunk in id order: the pre-cache query (`memory_id IN (...)` per chunk, no ORDER BY) returned the
	// primary-key order, which this matches for the ASCII ids Mnemopi generates. Other ids get a fixed code-unit order.
	const out = new Map<string, Float32Array>();
	for (let offset = 0; offset < memoryIds.length; offset += FETCH_CHUNK) {
		for (const id of memoryIds.slice(offset, offset + FETCH_CHUNK).sort()) {
			const vector = found.get(id);
			if (vector) out.set(id, vector);
		}
	}
	return out;
}

/** Call after this connection inserts, replaces or deletes the embedding rows of `memoryIds`. */
export function forgetCachedEmbeddings(db: Database, memoryIds: Iterable<string>): void {
	const cache = caches.get(db);
	if (!cache) return;
	for (const id of memoryIds) cache.vectors.delete(id);
}

/** Call after this connection deletes embedding rows in bulk. */
export function clearCachedEmbeddings(db: Database): void {
	caches.delete(db);
}
