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

interface CacheEntry<T> {
	readonly scope: string;
	readonly normalized: string;
	/** Distinct words of {@link normalized}, for the tier-4 overlap test. */
	readonly words: ReadonlySet<string>;
	readonly results: readonly T[];
	readonly embedding: QueryEmbedding | null;
}

interface CacheRow {
	readonly normalized: string;
	readonly embedding_json: string | null;
	readonly results_json: string;
}

/** Separates the option scope from the normalized query inside an entry key. */
const SCOPE_SEPARATOR = "\u0000";

function splitEntryKey(key: string): { scope: string; normalized: string } {
	const index = key.lastIndexOf(SCOPE_SEPARATOR);
	if (index < 0) return { scope: "", normalized: key };
	return { scope: key.slice(0, index), normalized: key.slice(index + 1) };
}

export function isEnhancedRecallEnabled(env: Env = process.env, configured?: boolean): boolean {
	return enhancedRecallEnabled(env, configured);
}

export function isQueryCacheEnabled(useCache = true, env: Env = process.env, configured?: boolean): boolean {
	return useCache && isEnhancedRecallEnabled(env, configured);
}

/**
 * Tiered query result cache. Every entry lives in a `scope`: an opaque string the
 * caller derives from all non-query inputs (result limit, filters, visibility,
 * ranking mode, ...). Lookups only ever consider entries of the same scope, so the
 * fuzzy tiers can match a *similar query* but never a different set of options.
 *
 * - Tier 1: exact normalized query match.
 * - Tiers 2/3: query embedding cosine >= 0.88, or >= 0.78 plus word overlap.
 * - Tier 4: shared distinct words cover at least 70% of the new query and half of the
 *   cached one, so a reworded or trimmed query hits but a short query never lands
 *   inside a long cached prompt that merely contains its words.
 */
export class QueryCache<T = QueryCacheResult> {
	readonly maxSize: number;
	readonly ttlSeconds: number;

	#cacheVersion = 0;
	/** Entry key -> entry; Map order is least- to most-recently used. */
	#entries = new Map<string, CacheEntry<T>>();
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
					const results = JSON.parse(row.results_json) as T[];
					const embedding = row.embedding_json === null ? null : (JSON.parse(row.embedding_json) as number[]);
					const { scope, normalized } = splitEntryKey(row.normalized);
					this.#entries.set(row.normalized, {
						scope,
						normalized,
						words: this.#wordSet(normalized),
						results,
						embedding,
					});
					this.#rememberKey(row.normalized, now);
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
		this.#entries.clear();
		this.#insertTimes.clear();
		if (this.#conn !== null) {
			this.#conn.run("DELETE FROM query_cache");
		}
	}

	get(query: string, embedding?: QueryEmbedding | null, scope = ""): readonly T[] | null {
		const normalized = this.normalize(query);
		const exactKey = `${scope}${SCOPE_SEPARATOR}${normalized}`;
		const now = Date.now() / 1000;
		if (this.#expireIfNeeded(exactKey, now)) {
			this.misses += 1;
			return null;
		}

		const exact = this.#entries.get(exactKey);
		if (exact !== undefined) {
			this.#touchKey(exactKey);
			this.hits += 1;
			this.tier1Hits += 1;
			this.#recordPersistentHit(exactKey);
			return exact.results;
		}

		if (embedding !== undefined && embedding !== null && embedding.length !== 0) {
			let bestScore = 0;
			let bestKey: string | null = null;
			for (const [cachedKey, cached] of this.#entries) {
				if (cached.scope !== scope || cached.embedding === null) continue;
				if (this.#isExpired(cachedKey, now)) continue;
				const cosine = cosineSimilarity(embedding, cached.embedding);
				if (cosine >= 0.88) {
					bestScore = cosine;
					bestKey = cachedKey;
					break;
				}
				if (cosine >= 0.78) {
					const jaccard = this.jaccardWords(query, cached.normalized);
					if (jaccard >= 0.15 && cosine > bestScore) {
						bestScore = cosine;
						bestKey = cachedKey;
					}
				}
			}
			if (bestKey !== null) {
				const entry = this.#entries.get(bestKey);
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
		for (const [cachedKey, cached] of this.#entries) {
			if (cached.scope !== scope) continue;
			if (this.#isExpired(cachedKey, now)) continue;
			queryWords ??= this.#wordSet(normalized);
			if (queryWords.size === 0) continue;
			let shared = 0;
			for (const word of queryWords) if (cached.words.has(word)) shared += 1;
			if (shared >= 2 && shared >= queryWords.size * 0.7 && shared >= cached.words.size * 0.5) {
				this.#touchKey(cachedKey);
				this.hits += 1;
				this.tier4Hits += 1;
				this.#recordPersistentHit(cachedKey);
				return cached.results;
			}
		}

		this.misses += 1;
		return null;
	}

	put(query: string, results: readonly T[], embedding?: QueryEmbedding | null, scope = ""): void {
		if (this.maxSize === 0) return;
		const normalized = this.normalize(query);
		const key = `${scope}${SCOPE_SEPARATOR}${normalized}`;
		const now = Date.now() / 1000;
		const storedEmbedding =
			embedding !== undefined && embedding !== null && embedding.length !== 0 ? embedding : null;
		this.#entries.delete(key);
		this.#entries.set(key, {
			scope,
			normalized,
			words: this.#wordSet(normalized),
			results,
			embedding: storedEmbedding,
		});
		this.#rememberKey(key, now);
		this.#putPersistent(key, results, storedEmbedding);
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
			size: this.#entries.size,
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
		const entry = this.#entries.get(key);
		if (entry !== undefined) {
			this.#entries.delete(key);
			this.#entries.set(key, entry);
		}
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
		this.#entries.delete(key);
		this.#insertTimes.delete(key);
		if (persistent && this.#conn !== null) this.#conn.run("DELETE FROM query_cache WHERE normalized = ?", [key]);
	}

	#evictIfNeeded(): void {
		const now = Date.now() / 1000;
		for (const [key, insertedAt] of this.#insertTimes) {
			if (now - insertedAt > this.ttlSeconds) this.#deleteKey(key, true);
		}
		while (this.#entries.size > this.maxSize) {
			const oldest = this.#entries.keys().next();
			if (oldest.done) break;
			this.#deleteKey(oldest.value, true);
		}
	}

	#putPersistent(key: string, results: readonly T[], embedding: QueryEmbedding | null): void {
		if (this.#conn === null) return;
		try {
			this.#conn.run(
				"INSERT OR REPLACE INTO query_cache (normalized, embedding_json, results_json) VALUES (?, ?, ?)",
				[key, embedding !== null ? JSON.stringify(embedding) : null, JSON.stringify(results)],
			);
		} catch {
			// Persistence is best-effort; in-memory tiers remain authoritative for this process.
		}
	}

	#recordPersistentHit(key: string): void {
		if (this.#conn === null) return;
		try {
			this.#conn.run(
				"UPDATE query_cache SET hit_count = hit_count + 1, last_hit = CURRENT_TIMESTAMP WHERE normalized = ?",
				[key],
			);
		} catch {
			// Match Python's best-effort persistence behavior.
		}
	}
}
