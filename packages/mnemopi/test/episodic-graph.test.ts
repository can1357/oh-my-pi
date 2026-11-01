import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { EpisodicGraph } from "../src/core/episodic-graph";

describe("episodic-graph traversal regression", () => {
	it("findRelatedMemories continues paging past 10,000 edges converging on the same unseen neighbor to discover lower-weight unseen neighbors", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		// Root connects to frontier node
		graph.addEdge({
			source: "root",
			target: "frontier_1",
			edgeType: "ctx",
			weight: 0.9,
			timestamp: now,
		});

		// Insert 10,000 edges from frontier_1 converging on the same unseen neighbor "converged-unseen"
		// with higher weight (0.8)
		const insertStmt = db.prepare(
			"INSERT INTO graph_edges (source, target, edge_type, weight, timestamp) VALUES (?, ?, ?, ?, ?)",
		);
		const tx = db.transaction(() => {
			for (let i = 0; i < 10000; i++) {
				insertStmt.run("frontier_1", "converged-unseen", `dup_link_${i}`, 0.8, now);
			}
			// Insert lower-weight edge (0.1) from frontier_1 to another unseen neighbor "tail-unseen"
			insertStmt.run("frontier_1", "tail-unseen", "tail_link", 0.1, now);
		});
		tx();

		const related = graph.findRelatedMemories("root", 2, "", 0.05);

		const converged = related.find(r => r.memoryId === "converged-unseen");
		expect(converged).toBeDefined();
		expect(converged?.depth).toBe(2);

		const tail = related.find(r => r.memoryId === "tail-unseen");
		expect(tail).toBeDefined();
		expect(tail?.depth).toBe(2);
		expect(tail?.weight).toBe(0.1);

		graph.close();
	});

	it("attributes shared unseen neighbors across a frontier chunk to the earliest frontier node in chunk order", () => {
		const db = new Database(":memory:");
		const graph = new EpisodicGraph({ db });
		const now = new Date().toISOString();

		graph.addEdge({ source: "root", target: "f1", edgeType: "ctx", weight: 0.9, timestamp: now });
		graph.addEdge({ source: "root", target: "f2", edgeType: "ctx", weight: 0.8, timestamp: now });

		// f2 has a higher weight edge to shared_neighbor (0.95), but f1 appears earlier in the frontier chunk
		// with weight 0.4; f1 should claim shared_neighbor with its own strongest edge (0.4), matching per-node order.
		graph.addEdge({ source: "f2", target: "shared_neighbor", edgeType: "from_f2", weight: 0.95, timestamp: now });
		graph.addEdge({ source: "f1", target: "shared_neighbor", edgeType: "from_f1", weight: 0.4, timestamp: now });
		graph.addEdge({ source: "f1", target: "shared_neighbor", edgeType: "from_f1_weaker", weight: 0.2, timestamp: now });

		const related = graph.findRelatedMemories("root", 2, "", 0.05);
		const shared = related.filter(r => r.memoryId === "shared_neighbor");
		expect(shared).toHaveLength(1);
		expect(shared[0]?.edgeType).toBe("from_f1");
		expect(shared[0]?.weight).toBe(0.4);

		graph.close();
	});
});
