import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEnhancedRecallEnabled, isQueryCacheEnabled, QueryCache } from "@oh-my-pi/pi-mnemopi/core/query-cache";
import { expandQuery, getSynonyms, normalizeQuery } from "@oh-my-pi/pi-mnemopi/core/synonyms";

const openCaches: QueryCache[] = [];

function cache(options: ConstructorParameters<typeof QueryCache>[0] = {}): QueryCache {
	const instance = new QueryCache(options);
	openCaches.push(instance);
	return instance;
}

afterEach(() => {
	for (const instance of openCaches.splice(0)) instance.close();
});

describe("synonym expansion", () => {
	it("expands canonical groups for query terms", () => {
		const result = expandQuery("what is the db password");
		expect(result).toContain("(database|db|datastore|data_store)");
		expect(result).toContain("(password|pass|pwd|passwd|credential|secret|token)");
	});

	it("normalizes by removing stop words and mapping synonyms to canonical words", () => {
		const result = normalizeQuery("what is the database password");
		expect(result.split(" ")).toEqual(["database", "password"]);
		expect(normalizeQuery("db password")).toBe(normalizeQuery("database password"));
	});

	it("returns synonym groups or the normalized unknown word", () => {
		expect(getSynonyms("db")).toContain("database");
		expect(getSynonyms("db").length).toBeGreaterThan(1);
		expect(getSynonyms("Xyzzy_Unknown_Word")).toEqual(["xyzzy_unknown_word"]);
	});
});

describe("QueryCache", () => {
	it("records exact normalized hits and misses", () => {
		const qc = cache({ maxSize: 100 });
		qc.put("test query", [{ content: "cached result", score: 0.9 }]);

		const cached = qc.get("test query");
		expect(cached?.[0]?.content).toBe("cached result");
		expect(qc.hits).toBe(1);
		expect(qc.tier1Hits).toBe(1);

		expect(qc.get("nonexistent query")).toBeNull();
		expect(qc.misses).toBe(1);
	});

	it("normalizes case and word order for exact cache keys", () => {
		const qc = cache({ max_size: 100 });
		qc.put("What is the database password", [{ content: "test", score: 0.5 }]);

		expect(qc.get("password database the is what")?.[0]?.content).toBe("test");
	});

	it("matches high-confidence embeddings and composite embedding plus keyword overlap", () => {
		const qc = cache({ maxSize: 100 });
		qc.put("alpha beta", [{ content: "vector", score: 0.8 }], [1, 0, 0]);
		qc.put("deploy server status", [{ content: "composite", score: 0.7 }], [0.8, 0.6, 0]);

		expect(qc.get("different words", [0.99, 0.01, 0])?.[0]?.content).toBe("vector");
		expect(qc.tier2Hits).toBe(1);
		expect(qc.get("deploy status", [0.4, 0.916, 0])?.[0]?.content).toBe("composite");
		expect(qc.tier3Hits).toBe(1);
	});

	it("uses tier4 overlap for expanded normalized queries", () => {
		const qc = cache({ maxSize: 100 });
		qc.put("database password config", [{ content: "expanded", score: 0.6 }]);

		expect(qc.get("database password")?.[0]?.content).toBe("expanded");
		expect(qc.tier4Hits).toBe(1);
	});

	it("expires entries by TTL and invalidates all tiers", async () => {
		const qc = cache({ maxSize: 100, ttlSeconds: 0.001 });
		qc.put("query one", [{ content: "test", score: 0.5 }], [1, 0]);
		await Bun.sleep(5);

		expect(qc.get("query one", [1, 0])).toBeNull();
		expect(qc.misses).toBe(1);

		qc.put("query two", [{ content: "test2", score: 0.5 }], [0, 1]);
		qc.invalidate();
		expect(qc.get("query two", [0, 1])).toBeNull();
		expect(qc.stats().version).toBe(1);
	});

	it("evicts least recently used entries when max size is exceeded", () => {
		const qc = cache({ maxSize: 2 });
		qc.put("first item", [{ content: "first" }]);
		qc.put("second item", [{ content: "second" }]);
		expect(qc.get("first item")?.[0]?.content).toBe("first");
		qc.put("third item", [{ content: "third" }]);

		expect(qc.get("second item")).toBeNull();
		expect(qc.get("first item")?.[0]?.content).toBe("first");
		expect(qc.stats().size).toBe(2);
	});

	it("persists to sqlite when a db path is supplied", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-query-cache-"));
		try {
			const dbPath = join(dir, "query_cache.db");
			const first = cache({ db_path: dbPath });
			first.put("persistent query", [{ content: "persisted" }], [1, 2, 3]);
			first.close();

			const second = cache({ dbPath });
			expect(second.get("persistent query")?.[0]?.content).toBe("persisted");
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports stats with rounded hit rate", () => {
		const qc = cache({ maxSize: 100 });
		qc.put("query", [{ content: "x", score: 0.5 }]);
		qc.get("query");
		qc.get("other");

		expect(qc.stats()).toMatchObject({
			hits: 1,
			misses: 1,
			hit_rate: 0.5,
			tier1_hits: 1,
			size: 1,
			max_size: 100,
		});
	});

	it("keeps enhanced recall and query cache disabled unless the Python env gate is set", () => {
		expect(isEnhancedRecallEnabled({})).toBe(false);
		expect(isQueryCacheEnabled(true, {})).toBe(false);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "0" })).toBe(false);
		expect(isQueryCacheEnabled(false, { MNEMOPI_ENHANCED_RECALL: "1" })).toBe(false);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "1" })).toBe(true);
	});
});
