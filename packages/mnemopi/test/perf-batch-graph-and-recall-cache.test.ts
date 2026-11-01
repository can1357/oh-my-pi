import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initBeam } from "../src/core/beam/schema";
import { recall } from "../src/core/beam/recall";
import type { BeamMemoryState } from "../src/core/beam/types";
import { EpisodicGraph } from "../src/core/episodic-graph";

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
	it("findRelatedMemories returns exact main ordering and preserves first-seen edge weight with 1 query per depth", () => {
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

		// Depth 1 (root) -> 1 query, Depth 2 (frontier: node_1, node_3, node_2) -> 1 batched query
		expect(edgeQueryCount).toBe(2);

		const depth1 = related.filter(r => r.depth === 1);
		expect(depth1.map(r => r.memoryId)).toEqual(["node_1", "node_3", "node_2"]);

		const depth2 = related.filter(r => r.depth === 2);
		expect(depth2.map(r => r.memoryId)).toEqual(["leaf_1b", "leaf_1a", "leaf_3a", "leaf_2a"]);

		graph.close();
	});

	it("preserves first-seen edge weight when neighbor is reachable from multiple frontier nodes", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });

		const now = new Date().toISOString();
		graph.addEdge({ source: "root", target: "n1", edgeType: "ctx", weight: 0.9, timestamp: now });
		graph.addEdge({ source: "root", target: "n2", edgeType: "ctx", weight: 0.7, timestamp: now });

		// n1 is processed before n2 because weight 0.9 > 0.7.
		// n1 -> shared has weight 0.3. n2 -> shared has weight 0.95.
		// First-seen semantics: edge from n1 (weight 0.3) must be recorded, not heavier n2 edge.
		graph.addEdge({ source: "n1", target: "shared", edgeType: "ctx", weight: 0.3, timestamp: now });
		graph.addEdge({ source: "n2", target: "shared", edgeType: "ctx", weight: 0.95, timestamp: now });

		const related = graph.findRelatedMemories("root", 2, "ctx");
		const shared = related.find(r => r.memoryId === "shared");
		expect(shared).toBeDefined();
		expect(shared?.weight).toBe(0.3);

		graph.close();
	});

	it("beam.recall with cached embeddings updates scores after UPDATE/DELETE on memory_embeddings, handles zero-norm and non-finite embeddings, and works across repeated recalls", async () => {
		const db = new Database(":memory:");
		initBeam(db);
		const beam = createTestBeam(db);

		const now = new Date().toISOString();
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_1", "Rust compiler performance", now],
		);
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_2", "Database query optimization", now],
		);
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_zero", "Zero norm embedding entry", now],
		);
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_nan", "Non finite embedding entry", now],
		);

		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_1",
			JSON.stringify([1.0, 0.0, 0.0]),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_2",
			JSON.stringify([0.0, 1.0, 0.0]),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_zero",
			JSON.stringify([0.0, 0.0, 0.0]),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_nan",
			JSON.stringify([Number.NaN, 1.0, 0.0]),
		]);

		const queryVec = [1.0, 0.0, 0.0];

		// 1. First recall: populates embedding cache and handles zero-norm & non-finite vectors without NaN scores
		const res1 = await recall(beam, "performance", 10, {
			queryEmbedding: queryVec,
			includeWorking: true,
			useSynonyms: false,
		});

		expect(res1.length).toBeGreaterThan(0);
		for (const r of res1) {
			expect(Number.isFinite(r.score)).toBe(true);
			if (r.dense_score !== undefined) {
				expect(Number.isFinite(r.dense_score)).toBe(true);
			}
		}
		const wm1_res1 = res1.find(r => r.id === "wm_1");
		expect(wm1_res1).toBeDefined();
		expect(wm1_res1?.dense_score).toBeCloseTo(1.0, 3);

		// Zero-norm and non-finite candidates must produce 0 dense score, not NaN
		const wmZero_res1 = res1.find(r => r.id === "wm_zero");
		if (wmZero_res1?.dense_score !== undefined) {
			expect(wmZero_res1.dense_score).toBe(0);
		}
		const wmNan_res1 = res1.find(r => r.id === "wm_nan");
		if (wmNan_res1?.dense_score !== undefined) {
			expect(wmNan_res1.dense_score).toBe(0);
		}

		// 2. Repeated recall: works across repeated recalls with cached embeddings
		const res2 = await recall(beam, "performance", 10, {
			queryEmbedding: queryVec,
			includeWorking: true,
			useSynonyms: false,
		});
		const wm1_res2 = res2.find(r => r.id === "wm_1");
		expect(wm1_res2?.dense_score).toBeCloseTo(1.0, 3);

		// 3. Query embedding with non-finite or zero-norm components also yields valid finite scores
		const resZeroQuery = await recall(beam, "performance", 10, {
			queryEmbedding: [0, 0, 0],
			includeWorking: true,
			useSynonyms: false,
		});
		for (const r of resZeroQuery) {
			expect(Number.isFinite(r.score)).toBe(true);
			if (r.dense_score !== undefined) expect(r.dense_score).toBe(0);
		}

		const resNanQuery = await recall(beam, "performance", 10, {
			queryEmbedding: [Number.NaN, 1.0, 0.0],
			includeWorking: true,
			useSynonyms: false,
		});
		for (const r of resNanQuery) {
			expect(Number.isFinite(r.score)).toBe(true);
			if (r.dense_score !== undefined) expect(Number.isFinite(r.dense_score)).toBe(true);
		}

		// 4. UPDATE on memory_embeddings updates scores on next recall
		db.run("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?", [
			JSON.stringify([0.0, 1.0, 0.0]),
			"wm_1",
		]);
		const resUpdated = await recall(beam, "performance", 10, {
			queryEmbedding: [0.0, 1.0, 0.0],
			includeWorking: true,
			useSynonyms: false,
		});
		const wm1_resUpdated = resUpdated.find(r => r.id === "wm_1");
		expect(wm1_resUpdated?.dense_score).toBeCloseTo(1.0, 3);

		// 5. DELETE from memory_embeddings evicts cached entry and updates scores
		db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", ["wm_1"]);
		const resDeleted = await recall(beam, "performance", 10, {
			queryEmbedding: [0.0, 1.0, 0.0],
			includeWorking: true,
			useSynonyms: false,
		});
		const wm1_resDeleted = resDeleted.find(r => r.id === "wm_1");
		expect(wm1_resDeleted?.dense_score ?? 0).toBe(0);
	});

	it("preserves cached embeddings across both working and episodic tiers without cross-tier eviction", async () => {
		const db = new Database(":memory:");
		initBeam(db);
		const beam = createTestBeam(db);

		const now = new Date().toISOString();
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'user', ?, 'test-session', 0.5)",
			["wm_a", "Working memory item A", now],
		);
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, tier) VALUES (?, ?, 'user', ?, 'test-session', 0.5, 2)",
			["ep_1", "Episodic memory item 1", now],
		);
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, tier) VALUES (?, ?, 'user', ?, 'test-session', 0.5, 2)",
			["ep_2", "Episodic memory item 2", now],
		);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"wm_a",
			JSON.stringify([1.0, 0.0, 0.0]),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"ep_1",
			JSON.stringify([0.8, 0.6, 0.0]),
		]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')", [
			"ep_2",
			JSON.stringify([0.0, 1.0, 0.0]),
		]);

		const wmVecJson = JSON.stringify([1.0, 0.0, 0.0]);
		const ep1VecJson = JSON.stringify([0.8, 0.6, 0.0]);
		const ep2VecJson = JSON.stringify([0.0, 1.0, 0.0]);

		await recall(beam, "memory", 10, {
			queryEmbedding: [1.0, 0.0, 0.0],
			includeWorking: true,
			useSynonyms: false,
		});

		const parseSpy = spyOn(JSON, "parse");
		try {
			const warmRes = await recall(beam, "memory", 10, {
				queryEmbedding: [0.0, 1.0, 0.0],
				includeWorking: true,
				useSynonyms: false,
			});
			expect(warmRes.find(r => r.id === "ep_2")?.dense_score).toBeCloseTo(1.0, 3);
			const parsedEmbeddingInputs = parseSpy.mock.calls
				.map(call => call[0])
				.filter(arg => arg === wmVecJson || arg === ep1VecJson || arg === ep2VecJson);
			expect(parsedEmbeddingInputs).toEqual([]);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("findEdgesTouching and findRelatedMemories handle frontiers larger than 900 IDs without SQL variable errors", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		// Insert 1000 nodes connected to root, plus target leaf nodes
		const nodeCount = 1000;
		for (let i = 0; i < nodeCount; i++) {
			graph.addEdge({
				source: "root",
				target: `frontier_${i}`,
				edgeType: "ctx",
				weight: 0.8,
				timestamp: now,
			});
		}

		// Add an edge from the last frontier node to a target
		graph.addEdge({
			source: "frontier_999",
			target: "target_leaf",
			edgeType: "ctx",
			weight: 0.9,
			timestamp: now,
		});

		const frontierIds = Array.from({ length: nodeCount }, (_, i) => `frontier_${i}`);
		// Directly verify findEdgesTouching with >900 IDs
		const edges = graph.findEdgesTouching(frontierIds, "ctx", 0.5);
		expect(edges.length).toBeGreaterThan(nodeCount);
		const leafEdge = edges.find(e => e.target === "target_leaf" || e.source === "target_leaf");
		expect(leafEdge).toBeDefined();
		expect(leafEdge?.weight).toBe(0.9);

		// Verify findRelatedMemories traversing depth 2 across the 1000-node frontier
		const related = graph.findRelatedMemories("root", 2, "ctx", 0.5);
		const leafRelated = related.find(r => r.memoryId === "target_leaf");
		expect(leafRelated).toBeDefined();
		expect(leafRelated?.depth).toBe(2);
		expect(leafRelated?.weight).toBe(0.9);

		graph.close();
	});

	it("ingestMemory links across >256 prior memories via chunked batching", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const count = 300;

		// Seed > 256 prior memories with distinct IDs and content
		for (let i = 0; i < count; i++) {
			const content = i === 280 ? "Alice works at Initech on compiler systems" : `Arbitrary memory note number ${i}`;
			graph.ingestMemory(content, `mem_${i}`, { linkExisting: false });
		}

		// Ingest a new memory that references Alice and Initech, which should link to mem_280 (in chunk 2: index 256..299)
		const result = graph.ingestMemory("Alice is consulting at Initech today", "mem_target", {
			linkExisting: true,
			minLinkScore: 0.1,
		});

		const linkedEdges = result.edges.filter(
			e =>
				(e.source === "mem_target" && e.target === "mem_280") ||
				(e.source === "mem_280" && e.target === "mem_target"),
		);
		expect(linkedEdges.length).toBeGreaterThan(0);

		graph.close();
	});

	it("findEdgesTouching with limit passes LIMIT to SQLite chunks and returns top-limit edges across chunks", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		// Insert 1000 nodes connected to root across multiple chunks (> 900)
		const nodeCount = 1000;
		for (let i = 0; i < nodeCount; i++) {
			// Assign weights such that nodes in both chunk 1 and chunk 2 have high-weight edges
			// e.g. i = 50 has weight 0.99 (chunk 1), i = 950 has weight 0.98 (chunk 2)
			const weight = i === 50 ? 0.99 : i === 950 ? 0.98 : 0.1;
			graph.addEdge({
				source: "root",
				target: `node_${i}`,
				edgeType: "ctx",
				weight,
				timestamp: now,
			});
		}

		const queriesIssued: string[] = [];
		const originalQuery = db.query.bind(db);
		spyOn(db, "query").mockImplementation((sql: string) => {
			queriesIssued.push(sql);
			return originalQuery(sql);
		});

		const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node_${i}`);
		// Request top 2 edges
		const topEdges = graph.findEdgesTouching(nodeIds, "ctx", 0, 2);

		// Check that SQL contains LIMIT ? for chunked edge queries
		const edgeQueries = queriesIssued.filter(q => q.includes("FROM graph_edges"));
		expect(edgeQueries.length).toBe(2); // 1000 items / 900 chunk size = 2 chunks
		for (const q of edgeQueries) {
			expect(q).toContain("LIMIT ?");
		}

		expect(topEdges).toHaveLength(2);
		expect(topEdges[0]?.target).toBe("node_50");
		expect(topEdges[0]?.weight).toBe(0.99);
		expect(topEdges[1]?.target).toBe("node_950");
		expect(topEdges[1]?.weight).toBe(0.98);

		// Verify limit <= 0 returns []
		expect(graph.findEdgesTouching(nodeIds, "ctx", 0, 0)).toEqual([]);
		expect(graph.findEdgesTouching(nodeIds, "ctx", 0, -5)).toEqual([]);

		graph.close();
	});

	it("findEdgesTouching preserves ascending id tie-breaker order across chunks when weights are equal", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });

		// Insert 1000 nodes across 2 chunks (>900).
		// Chunk 1 has node_10 with id 11, older timestamp, weight 0.8.
		// Chunk 2 has node_950 with id 951, newer timestamp, equal weight 0.8.
		// Under timestamp tie-break, node_950 (newer) would come first.
		// Under id tie-break (ORDER BY weight DESC, id ASC), node_10 (smaller id) must come first.
		const nodeCount = 1000;
		for (let i = 0; i < nodeCount; i++) {
			const weight = i === 10 || i === 950 ? 0.8 : 0.2;
			const timestamp = i === 10 ? "2026-01-01T00:00:00.000Z" : "2026-11-01T00:00:00.000Z";
			graph.addEdge({
				source: "root",
				target: `node_${i}`,
				edgeType: "ctx",
				weight,
				timestamp,
			});
		}

		const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node_${i}`);
		const edges = graph.findEdgesTouching(nodeIds, "ctx", 0.5, 2);

		expect(edges).toHaveLength(2);
		expect(edges[0]?.target).toBe("node_10");
		expect(edges[0]?.weight).toBe(0.8);
		expect(edges[1]?.target).toBe("node_950");
		expect(edges[1]?.weight).toBe(0.8);

		graph.close();
	});

	it("findRelatedMemories across a wide frontier (>900 nodes) processes chunks incrementally and preserves exact BFS first-seen suppression order", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		// Connect root to 1000 nodes at depth 1 (spanning 2 chunks: 0..899, 900..999)
		const nodeCount = 1000;
		for (let i = 0; i < nodeCount; i++) {
			graph.addEdge({
				source: "root",
				target: `f_${i}`,
				edgeType: "ctx",
				weight: 0.8,
				timestamp: now,
			});
		}

		// Both f_50 (chunk 1) and f_950 (chunk 2) connect to shared_leaf, but f_50 has weight 0.7 and f_950 has weight 0.95
		graph.addEdge({
			source: "f_50",
			target: "shared_leaf",
			edgeType: "ctx",
			weight: 0.7,
			timestamp: now,
		});
		graph.addEdge({
			source: "f_950",
			target: "shared_leaf",
			edgeType: "ctx",
			weight: 0.95,
			timestamp: now,
		});

		// f_950 also connects to leaf_950
		graph.addEdge({
			source: "f_950",
			target: "leaf_950",
			edgeType: "ctx",
			weight: 0.6,
			timestamp: now,
		});

		let queryCount = 0;
		const origQuery = db.query.bind(db);
		spyOn(db, "query").mockImplementation((sql: string) => {
			if (typeof sql === "string" && sql.includes("FROM graph_edges")) {
				queryCount++;
			}
			return origQuery(sql);
		});

		const related = graph.findRelatedMemories("root", 2, "ctx", 0.5);

		// Depth 1: 1 query for [root]
		// Depth 2: 1000 frontier nodes chunked into slices of 900 -> 2 chunk queries
		// Total edge queries = 3
		expect(queryCount).toBe(3);

		const shared = related.find(r => r.memoryId === "shared_leaf");
		expect(shared).toBeDefined();
		expect(shared?.depth).toBe(2);
		// First-seen suppression: f_50 (processed in chunk 1) encountered shared_leaf first with weight 0.7,
		// so f_950 (in chunk 2) cannot overwrite it despite higher weight (0.95)
		expect(shared?.weight).toBe(0.7);

		const leaf950 = related.find(r => r.memoryId === "leaf_950");
		expect(leaf950).toBeDefined();
		expect(leaf950?.depth).toBe(2);
		expect(leaf950?.weight).toBe(0.6);

		graph.close();
	});

	it("findRelatedMemories paginates past seen-only edges to discover lower-weight unseen edges", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		// Root connects to seen_1 and seen_2 at depth 1 with weight 0.9
		graph.addEdge({
			source: "root",
			target: "seen_1",
			edgeType: "ctx",
			weight: 0.9,
			timestamp: now,
		});
		graph.addEdge({
			source: "root",
			target: "seen_2",
			edgeType: "ctx",
			weight: 0.9,
			timestamp: now,
		});

		// Add 2500 high-weight (weight: 0.8) edges between seen_1 and seen_2
		// (exceeding FRONTIER_EDGE_PAGE_SIZE = 2048)
		for (let i = 0; i < 2500; i++) {
			graph.addEdge({
				source: "seen_1",
				target: "seen_2",
				edgeType: `seen_link_${i}`,
				weight: 0.8,
				timestamp: now,
			});
		}

		// Add a lower-weight edge (weight: 0.5) from seen_1 to unseen_target
		graph.addEdge({
			source: "seen_1",
			target: "unseen_target",
			edgeType: "ctx",
			weight: 0.5,
			timestamp: now,
		});

		const related = graph.findRelatedMemories("root", 2, "", 0.4);

		// unseen_target should be discovered at depth 2 despite 2500 higher-weight seen-only edges
		const unseen = related.find(r => r.memoryId === "unseen_target");
		expect(unseen).toBeDefined();
		expect(unseen?.depth).toBe(2);
		expect(unseen?.weight).toBe(0.5);

		graph.close();
	});
});
