import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initBeam } from "../src/core/beam/schema";
import { recall, vectorSimilarities, getEmbeddingCacheStateForTests } from "../src/core/beam/recall";
import type { BeamMemoryState } from "../src/core/beam/types";
import { EpisodicGraph } from "../src/core/episodic-graph";
import { VeracityConsolidator } from "../src/core/veracity-consolidation";

function createTestBeam(db: Database): BeamMemoryState {
	return {
		db,
		dbPath: ":memory:",
		sessionId: "test-session",
		authorId: null,
		authorType: null,
		channelId: "test-session",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
}

describe("performance optimizations: batched graph and recall cache", () => {
	it("findRelatedMemories traverses BFS frontier using 1 batched query per depth level", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });

		const now = new Date().toISOString();
		// Level 1 neighbors of root
		graph.addEdge({ source: "root", target: "node_1", edgeType: "ctx", weight: 0.9, timestamp: now });
		graph.addEdge({ source: "root", target: "node_2", edgeType: "ctx", weight: 0.7, timestamp: now });
		graph.addEdge({ source: "root", target: "node_3", edgeType: "ctx", weight: 0.8, timestamp: now });

		// Level 2 neighbors
		graph.addEdge({ source: "node_1", target: "leaf_1a", edgeType: "ctx", weight: 0.6, timestamp: now });
		graph.addEdge({ source: "node_1", target: "leaf_1b", edgeType: "ctx", weight: 0.95, timestamp: now });
		graph.addEdge({ source: "node_2", target: "leaf_2a", edgeType: "ctx", weight: 0.85, timestamp: now });
		graph.addEdge({ source: "node_3", target: "leaf_3a", edgeType: "ctx", weight: 0.5, timestamp: now });

		// Track queries issued to graph_edges
		let edgeQueryCount = 0;
		const originalQuery = db.query.bind(db);
		spyOn(db, "query").mockImplementation((sql: string) => {
			if (typeof sql === "string" && sql.includes("graph_edges")) {
				edgeQueryCount++;
			}
			return originalQuery(sql);
		});

		const related = graph.findRelatedMemories("root", 2, "ctx");

		// Depth 1 frontier has 1 node ('root') -> 1 query.
		// Depth 2 frontier has 3 nodes ('node_1', 'node_2', 'node_3') -> 1 batched query instead of 3 queries!
		expect(edgeQueryCount).toBe(2);

		// Semantics & depth correctness
		expect(related.map(r => r.memoryId)).toContain("node_1");
		expect(related.map(r => r.memoryId)).toContain("node_2");
		expect(related.map(r => r.memoryId)).toContain("node_3");
		expect(related.map(r => r.memoryId)).toContain("leaf_1a");
		expect(related.map(r => r.memoryId)).toContain("leaf_1b");
		expect(related.map(r => r.memoryId)).toContain("leaf_2a");
		expect(related.map(r => r.memoryId)).toContain("leaf_3a");

		const depth1 = related.filter(r => r.depth === 1);
		expect(depth1.map(r => r.memoryId)).toEqual(["node_1", "node_3", "node_2"]); // sorted by weight DESC (0.9, 0.8, 0.7)

		const depth2 = related.filter(r => r.depth === 2);
		expect(depth2.map(r => r.memoryId)).toEqual(["leaf_1b", "leaf_2a", "leaf_1a", "leaf_3a"]); // sorted by weight DESC (0.95, 0.85, 0.6, 0.5)

		graph.close();
	});

	it("ingestMemory hoists entity queries and links multiple memories efficiently", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });

		const m1 = graph.ingestMemory("Alice uses TypeScript and React for building frontend tools.", "mem_1");
		expect(m1.memoryId).toBe("mem_1");

		const m2 = graph.ingestMemory("Bob also uses TypeScript for backend development.", "mem_2");
		expect(m2.memoryId).toBe("mem_2");

		const m3 = graph.ingestMemory("Charlie uses React and TypeScript for user interfaces.", "mem_3");
		expect(m3.memoryId).toBe("mem_3");

		const related = graph.findRelatedMemories("mem_2", 1);
		expect(related.some(r => r.memoryId === "mem_1")).toBe(true);

		graph.close();
	});

	it("vectorSimilarities caches parsed embeddings and precomputed norms across repeated calls and invalidates on update", () => {
		const db = new Database(":memory:");
		initBeam(db);

		const beam = createTestBeam(db);

		const now = new Date().toISOString();
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_1", "Doc 1 content", now],
		);
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_2", "Doc 2 content", now],
		);

		const vec1 = [1.0, 0.0, 0.0];
		const vec2 = [0.0, 1.0, 0.0];
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_1",
			JSON.stringify(vec1),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_2",
			JSON.stringify(vec2),
		]);

		const queryVec = [1.0, 0.0, 0.0];

		let jsonParseCount = 0;
		const originalJsonParse = JSON.parse;
		const parseSpy = spyOn(JSON, "parse").mockImplementation(
			(text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
				jsonParseCount++;
				return originalJsonParse(text, reviver);
			},
		);

		try {
			// First call: parses 2 embeddings and stores them in cache
			const sim1 = vectorSimilarities(beam, ["wm_1", "wm_2"], queryVec, "working");
			expect(sim1.get("wm_1")).toBeCloseTo(1.0, 5);
			expect(sim1.get("wm_2")).toBeCloseTo(0.0, 5);
			expect(jsonParseCount).toBe(2);

			const cacheState = getEmbeddingCacheStateForTests(beam);
			expect(cacheState?.size).toBe(2);

			// Second call: reuses cached vectors and precomputed norms without calling JSON.parse!
			const sim2 = vectorSimilarities(beam, ["wm_1", "wm_2"], queryVec, "working");
			expect(sim2.get("wm_1")).toBeCloseTo(1.0, 5);
			expect(sim2.get("wm_2")).toBeCloseTo(0.0, 5);
			expect(jsonParseCount).toBe(2); // no new JSON.parse calls!

			// Updating row wm_2 invalidates wm_2 in cache because raw JSON differs
			const updatedVec2 = [0.7071, 0.7071, 0.0];
			db.run("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?", [
				JSON.stringify(updatedVec2),
				"wm_2",
			]);

			const sim3 = vectorSimilarities(beam, ["wm_1", "wm_2"], queryVec, "working");
			expect(sim3.get("wm_1")).toBeCloseTo(1.0, 5);
			expect(sim3.get("wm_2")).toBeCloseTo(0.7071, 3);
			// wm_2 was re-parsed because raw string changed, while wm_1 was reused from cache
			expect(jsonParseCount).toBe(3);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("beam.recall integrates with vectorSimilarities with queryEmbedding", async () => {
		const db = new Database(":memory:");
		initBeam(db);

		const beam = createTestBeam(db);

		const now = new Date().toISOString();
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.8)",
			["wm_target", "Specialized database engine performance", now],
		);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_target",
			JSON.stringify([0.9, 0.1, 0.0]),
		]);

		const results = await recall(beam, "database", 10, {
			queryEmbedding: [0.9, 0.1, 0.0],
			includeWorking: true,
			useSynonyms: false,
		});

		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]?.id).toBe("wm_target");
	});

	it("initializes composite and expression indexes in schema and consolidator", () => {
		const db = new Database(":memory:");
		initBeam(db);
		const consolidator = new VeracityConsolidator(":memory:", db);
		const graph = new EpisodicGraph({ db });

		const indexes = db.query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'").all() as {
			name: string;
			tbl_name: string;
			sql: string;
		}[];

		const indexMap = new Map(indexes.map(i => [i.name, i]));

		expect(indexMap.has("idx_cf_spo")).toBe(true);
		expect(indexMap.get("idx_cf_spo")?.tbl_name).toBe("consolidated_facts");

		expect(indexMap.has("idx_facts_lower_subject")).toBe(true);
		expect(indexMap.get("idx_facts_lower_subject")?.tbl_name).toBe("facts");
		expect(indexMap.get("idx_facts_lower_subject")?.sql).toContain("LOWER(subject)");

		expect(indexMap.has("idx_facts_lower_object")).toBe(true);
		expect(indexMap.get("idx_facts_lower_object")?.tbl_name).toBe("facts");
		expect(indexMap.get("idx_facts_lower_object")?.sql).toContain("LOWER(object)");

		expect(indexMap.has("idx_edges_type_source_target")).toBe(true);
		expect(indexMap.get("idx_edges_type_source_target")?.tbl_name).toBe("graph_edges");

		consolidator.close();
		graph.close();
	});
});
