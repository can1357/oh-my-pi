import type { Database, SQLQueryBindings } from "bun:sqlite";

/**
 * Decoded `memory_embeddings` vectors, kept per SQLite connection so recall does not parse every
 * candidate's embedding JSON on each call.
 *
 * Staleness rules:
 * - Writes through this connection go through {@link forgetCachedEmbeddings} /
 *   {@link clearCachedEmbeddings} at every site that inserts, replaces or deletes embedding rows.
 * - A commit from any other connection (another session sharing the bank) bumps
 *   `PRAGMA data_version`, which drops the whole cache on the next read.
 *
 * `null` records "no usable embedding row", so ids still waiting for their vector are not
 * re-queried on every recall; the insert that later stores the vector forgets that entry.
 */
interface ConnectionCache {
	dataVersion: number;
	vectors: Map<string, Float64Array | null>;
}

const caches = new WeakMap<Database, ConnectionCache>();
const FETCH_CHUNK = 500;

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(",");
}

function decodeEmbedding(raw: unknown): Float64Array | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return null;
		const vector = new Float64Array(parsed.length);
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

function currentCache(db: Database): ConnectionCache {
	const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
	const existing = caches.get(db);
	if (existing && existing.dataVersion === dataVersion) return existing;
	const fresh: ConnectionCache = { dataVersion, vectors: new Map() };
	caches.set(db, fresh);
	return fresh;
}

/** Decoded embeddings for `memoryIds`; ids without a usable embedding are absent from the result. */
export function cachedEmbeddings(db: Database, memoryIds: readonly string[]): Map<string, Float64Array> {
	const cache = currentCache(db);
	const out = new Map<string, Float64Array>();
	const missing: string[] = [];
	for (const id of memoryIds) {
		const cached = cache.vectors.get(id);
		if (cached === undefined) missing.push(id);
		else if (cached !== null) out.set(id, cached);
	}
	for (let offset = 0; offset < missing.length; offset += FETCH_CHUNK) {
		const chunk = missing.slice(offset, offset + FETCH_CHUNK);
		const rows = db
			.query<{ memory_id: string; embedding_json: unknown }, SQLQueryBindings[]>(
				`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${placeholders(chunk.length)})`,
			)
			.all(...chunk);
		const found = new Map<string, Float64Array | null>();
		for (const row of rows) found.set(row.memory_id, decodeEmbedding(row.embedding_json));
		for (const id of chunk) {
			const vector = found.get(id) ?? null;
			cache.vectors.set(id, vector);
			if (vector !== null) out.set(id, vector);
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
