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
 * entries per connection (about 31 MB at 384 dimensions, 61 MB at 768, 82 MB at 1024), evicting the
 * least recently used first.
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

/** SQLite's BINARY collation: UTF-8 byte order, i.e. code point order, where UTF-16 `<` differs past U+FFFF. */
function compareBinary(a: string, b: string): number {
	for (let index = 0; index < a.length && index < b.length; index += 1) {
		const x = a.charCodeAt(index);
		const y = b.charCodeAt(index);
		if (x === y) continue;
		// A surrogate belongs to a code point past U+FFFF, so it outranks every other UTF-16 unit.
		const xSurrogate = x >= 0xd800 && x <= 0xdfff;
		const ySurrogate = y >= 0xd800 && y <= 0xdfff;
		if (xSurrogate === ySurrogate) return x - y;
		return xSurrogate ? 1 : -1;
	}
	return a.length - b.length;
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
		vectors: new LRUCache<string, Float32Array | null>({ max: MAX_CACHED_VECTORS }),
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
 * Decoded embeddings for `memoryIds`, listed in the order the pre-cache query returned them whatever the cache
 * holds (recall breaks similarity ties by this order); ids without a usable embedding are absent from the result.
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
	// That query (`memory_id IN (...)` per 500 ids) walked the primary-key index, so each chunk came back in id order.
	const out = new Map<string, Float32Array>();
	for (let offset = 0; offset < memoryIds.length; offset += FETCH_CHUNK) {
		for (const id of memoryIds.slice(offset, offset + FETCH_CHUNK).sort(compareBinary)) {
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
