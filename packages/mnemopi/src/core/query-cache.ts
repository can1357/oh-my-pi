import type { Database } from "bun:sqlite";
import { type Env, enhancedRecallEnabled } from "../config";
import { openDatabase } from "../db";
import { cosineSimilarity } from "./vector-math";

export type QueryCacheResult = Record<string, unknown>;
export type QueryEmbedding = readonly number[];

export interface QueryCacheOptions {
	readonly dbPath?: string | null;
	readonly db_path?: string | null;
	readonly maxSize?: number;
	readonly max_size?: number;
	readonly ttlSeconds?: number;
	readonly ttl_seconds?: number;
}

export interface QueryCacheStats {
	readonly hits: number;
	readonly misses: number;
	readonly hit_rate: number;
	readonly tier1_hits: number;
	readonly tier2_hits: number;
	readonly tier3_hits: number;
	readonly tier4_hits: number;
	readonly size: number;
	readonly max_size: number;
	readonly version: number;
}

interface Tier23Entry {
	readonly embedding: QueryEmbedding;
	readonly results: readonly QueryCacheResult[];
}

interface CacheRow {
	readonly normalized: string;
	readonly embedding_json: string | null;
	readonly results_json: string;
}

export function isEnhancedRecallEnabled(env: Env = process.env): boolean {
	return enhancedRecallEnabled(env);
}

export function isQueryCacheEnabled(useCache = true, env: Env = process.env): boolean {
	return useCache && isEnhancedRecallEnabled(env);
}

export class QueryCache {
	readonly maxSize: number;
	readonly ttlSeconds: number;

	#cacheVersion = 0;
	#tier1 = new Map<string, readonly QueryCacheResult[]>();
	#tier23 = new Map<string, Tier23Entry>();
	#tier4 = new Map<string, readonly QueryCacheResult[]>();
	#insertTimes = new Map<string, number>();
	#conn: Database | null = null;

	hits = 0;
	misses = 0;
	tier1Hits = 0;
	tier2Hits = 0;
	tier3Hits = 0;
	tier4Hits = 0;

	constructor(options: QueryCacheOptions | string | null = {}, maxSize = 1000, ttlSeconds = 3600) {
		if (typeof options === "string" || options === null) {
			this.maxSize = Math.max(0, Math.trunc(maxSize));
			this.ttlSeconds = Math.max(0, ttlSeconds);
			if (options !== null) this.#initDb(options);
			return;
		}
		this.maxSize = Math.max(0, Math.trunc(options.maxSize ?? options.max_size ?? 1000));
		this.ttlSeconds = Math.max(0, options.ttlSeconds ?? options.ttl_seconds ?? 3600);
		const dbPath = options.dbPath ?? options.db_path;
		if (dbPath !== undefined && dbPath !== null) this.#initDb(dbPath);
	}

	#initDb(dbPath: string): void {
		const db = openDatabase(dbPath, { pragmas: false });
		this.#conn = db;
		if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
		db.exec(`
			CREATE TABLE IF NOT EXISTS query_cache (
				normalized TEXT PRIMARY KEY,
				embedding_json TEXT,
				results_json TEXT,
				hit_count INTEGER DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				last_hit TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX IF NOT EXISTS idx_cache_hits ON query_cache(hit_count DESC);
		`);

		try {
			const rows = db.query("SELECT normalized, embedding_json, results_json FROM query_cache").all() as CacheRow[];
			const now = Date.now() / 1000;
			for (const row of rows) {
				try {
					const results = JSON.parse(row.results_json) as QueryCacheResult[];
					this.#rememberKey(row.normalized, now);
					this.#tier1.set(row.normalized, results);
					this.#tier4.set(row.normalized, results);
					if (row.embedding_json !== null) {
						const embedding = JSON.parse(row.embedding_json) as number[];
						this.#tier23.set(row.normalized, { embedding, results });
					}
				} catch {
					// Match Python's best-effort persistence loading: corrupt rows are ignored.
				}
			}
		} catch {
			// Keep an in-memory cache if persistence loading fails after schema setup.
		}
	}

	invalidate(): void {
		this.#cacheVersion += 1;
		this.#tier1.clear();
		this.#tier23.clear();
		this.#tier4.clear();
		this.#insertTimes.clear();
		if (this.#conn !== null) {
			this.#conn.run("DELETE FROM query_cache");
		}
	}

	get(query: string, embedding?: QueryEmbedding | null): readonly QueryCacheResult[] | null {
		const normalized = this.normalize(query);
		const now = Date.now() / 1000;
		if (this.#expireIfNeeded(normalized, now)) {
			this.misses += 1;
			return null;
		}

		const tier1 = this.#tier1.get(normalized);
		if (tier1 !== undefined) {
			this.#touchKey(normalized);
			this.hits += 1;
			this.tier1Hits += 1;
			this.#recordPersistentHit(normalized);
			return tier1;
		}

		if (embedding !== undefined && embedding !== null && embedding.length !== 0) {
			let bestScore = 0;
			let bestKey: string | null = null;
			for (const [cachedKey, cached] of this.#tier23) {
				if (this.#isExpired(cachedKey, now)) continue;
				const cosine = cosineSimilarity(embedding, cached.embedding);
				if (cosine >= 0.88) {
					bestScore = cosine;
					bestKey = cachedKey;
					break;
				}
				if (cosine >= 0.78) {
					const jaccard = this.jaccardWords(query, cachedKey);
					if (jaccard >= 0.15 && cosine > bestScore) {
						bestScore = cosine;
						bestKey = cachedKey;
					}
				}
			}
			if (bestKey !== null) {
				const entry = this.#tier23.get(bestKey);
				if (entry !== undefined) {
					this.#touchKey(bestKey);
					this.hits += 1;
					if (bestScore >= 0.88) this.tier2Hits += 1;
					else this.tier3Hits += 1;
					this.#recordPersistentHit(bestKey);
					return entry.results;
				}
			}
		}

		let queryWords: Set<string> | null = null;
		for (const [cachedKey, results] of this.#tier4) {
			if (this.#isExpired(cachedKey, now)) continue;
			queryWords ??= new Set(normalized.split(/\s+/));
			if (queryWords.size === 0) continue;
			let overlap = 0;
			for (const cachedWord of cachedKey.split(/\s+/)) if (queryWords.has(cachedWord)) overlap += 1;
			if (overlap >= queryWords.size * 0.7 && overlap >= 2) {
				this.#touchKey(cachedKey);
				this.hits += 1;
				this.tier4Hits += 1;
				this.#recordPersistentHit(cachedKey);
				return results;
			}
		}

		this.misses += 1;
		return null;
	}

	put(query: string, results: readonly QueryCacheResult[], embedding?: QueryEmbedding | null): void {
		if (this.maxSize === 0) return;
		const normalized = this.normalize(query);
		const now = Date.now() / 1000;
		this.#rememberKey(normalized, now);
		this.#tier1.set(normalized, results);
		this.#tier4.set(normalized, results);
		if (embedding !== undefined && embedding !== null && embedding.length !== 0) {
			this.#tier23.set(normalized, { embedding, results });
		} else {
			this.#tier23.delete(normalized);
		}
		this.#putPersistent(normalized, results, embedding);
		this.#evictIfNeeded();
	}

	close(): void {
		if (this.#conn === null) return;
		this.#conn.close();
		this.#conn = null;
	}

	get hitRate(): number {
		const total = this.hits + this.misses;
		return total > 0 ? this.hits / total : 0;
	}

	stats(): QueryCacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			hit_rate: Math.round(this.hitRate * 1000) / 1000,
			tier1_hits: this.tier1Hits,
			tier2_hits: this.tier2Hits,
			tier3_hits: this.tier3Hits,
			tier4_hits: this.tier4Hits,
			size: this.#tier1.size,
			max_size: this.maxSize,
			version: this.#cacheVersion,
		};
	}

	normalize(query: string): string {
		const words: string[] = [];
		for (const rawWord of query.split(/\s+/)) {
			if (rawWord.length > 1) words.push(rawWord.toLowerCase());
		}
		return words.sort().join(" ");
	}

	jaccardWords(queryA: string, queryB: string): number {
		const wordsA = this.#wordSet(queryA);
		const wordsB = this.#wordSet(queryB);
		if (wordsA.size === 0 || wordsB.size === 0) return 0;
		let intersection = 0;
		for (const word of wordsA) if (wordsB.has(word)) intersection += 1;
		return intersection / (wordsA.size + wordsB.size - intersection);
	}

	#wordSet(query: string): Set<string> {
		const words = new Set<string>();
		for (const rawWord of query.toLowerCase().split(/\s+/)) {
			if (rawWord.length !== 0) words.add(rawWord);
		}
		return words;
	}

	#rememberKey(key: string, now: number): void {
		this.#insertTimes.delete(key);
		this.#insertTimes.set(key, now);
	}

	#touchKey(key: string): void {
		const insertTime = this.#insertTimes.get(key);
		if (insertTime !== undefined) {
			this.#insertTimes.delete(key);
			this.#insertTimes.set(key, insertTime);
		}
		this.#touchMap(this.#tier1, key);
		this.#touchMap(this.#tier23, key);
		this.#touchMap(this.#tier4, key);
	}

	#touchMap<V>(map: Map<string, V>, key: string): void {
		const value = map.get(key);
		if (value === undefined && !map.has(key)) return;
		map.delete(key);
		map.set(key, value as V);
	}

	#isExpired(key: string, now: number): boolean {
		const insertedAt = this.#insertTimes.get(key);
		return insertedAt !== undefined && now - insertedAt > this.ttlSeconds;
	}

	#expireIfNeeded(key: string, now: number): boolean {
		if (!this.#isExpired(key, now)) return false;
		this.#deleteKey(key, true);
		return true;
	}

	#deleteKey(key: string, persistent: boolean): void {
		this.#tier1.delete(key);
		this.#tier23.delete(key);
		this.#tier4.delete(key);
		this.#insertTimes.delete(key);
		if (persistent && this.#conn !== null) this.#conn.run("DELETE FROM query_cache WHERE normalized = ?", [key]);
	}

	#evictIfNeeded(): void {
		const now = Date.now() / 1000;
		for (const [key, insertedAt] of this.#insertTimes) {
			if (now - insertedAt > this.ttlSeconds) this.#deleteKey(key, true);
		}
		while (this.#tier1.size > this.maxSize) {
			const oldest = this.#tier1.keys().next();
			if (oldest.done) break;
			this.#deleteKey(oldest.value, true);
		}
	}

	#putPersistent(
		normalized: string,
		results: readonly QueryCacheResult[],
		embedding: QueryEmbedding | null | undefined,
	): void {
		if (this.#conn === null) return;
		try {
			this.#conn.run(
				"INSERT OR REPLACE INTO query_cache (normalized, embedding_json, results_json) VALUES (?, ?, ?)",
				[
					normalized,
					embedding !== undefined && embedding !== null ? JSON.stringify(embedding) : null,
					JSON.stringify(results),
				],
			);
		} catch {
			// Persistence is best-effort; in-memory tiers remain authoritative for this process.
		}
	}

	#recordPersistentHit(normalized: string): void {
		if (this.#conn === null) return;
		try {
			this.#conn.run(
				"UPDATE query_cache SET hit_count = hit_count + 1, last_hit = CURRENT_TIMESTAMP WHERE normalized = ?",
				[normalized],
			);
		} catch {
			// Match Python's best-effort persistence behavior.
		}
	}
}
