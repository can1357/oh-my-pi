import type { Database, SQLQueryBindings } from "bun:sqlite";

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
 *   dropped only when the embedding table's signature (row count plus its newest row) moved too.
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
	signature: string;
	/** Insertion order is least to most recently used. */
	vectors: Map<string, Float32Array | null>;
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

/**
 * Writers only INSERT OR REPLACE (a new rowid) or DELETE, so any embedding change moves the row count or
 * the newest row; the newest row's content also catches a deleted newest row re-inserted at the same rowid.
 */
function embeddingSignature(db: Database): string {
	const row = db
		.query<{ count: number; rowid: number; memory_id: string; embedding_json: unknown }, []>(
			"SELECT (SELECT COUNT(*) FROM memory_embeddings) AS count, rowid, memory_id, embedding_json FROM memory_embeddings ORDER BY rowid DESC LIMIT 1",
		)
		.get();
	return row ? `${row.count}:${row.rowid}:${row.memory_id}:${row.embedding_json}` : "";
}

// shortcut: this connection's own embedding writes also move the signature, so the first foreign commit after
// them drops the cache once; refresh the signature after own writes if that shows up in profiles.
function currentCache(db: Database): ConnectionCache {
	const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
	const existing = caches.get(db);
	if (existing?.dataVersion === dataVersion) return existing;
	const signature = embeddingSignature(db);
	if (existing?.signature === signature) {
		existing.dataVersion = dataVersion;
		return existing;
	}
	const fresh: ConnectionCache = { dataVersion, signature, vectors: new Map() };
	caches.set(db, fresh);
	return fresh;
}

/** Stored embeddings for `memoryIds`, in that order; `null` for ids without a usable row. */
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
 * Decoded embeddings for `memoryIds`, in `memoryIds` order whatever the cache holds (recall breaks
 * similarity ties by this order); ids without a usable embedding are absent from the result.
 */
export function cachedEmbeddings(db: Database, memoryIds: readonly string[]): Map<string, Float32Array> {
	const out = new Map<string, Float32Array>();
	if (db.inTransaction) {
		for (const [id, vector] of readEmbeddings(db, memoryIds)) if (vector !== null) out.set(id, vector);
		return out;
	}
	const { vectors } = currentCache(db);
	const fetched = readEmbeddings(
		db,
		memoryIds.filter(id => !vectors.has(id)),
	);
	for (const id of memoryIds) {
		const vector = fetched.get(id) ?? vectors.get(id) ?? null;
		// Re-insert to mark it most recently used.
		vectors.delete(id);
		vectors.set(id, vector);
		if (vector !== null) out.set(id, vector);
	}
	for (const id of vectors.keys()) {
		if (vectors.size <= MAX_CACHED_VECTORS) break;
		vectors.delete(id);
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
