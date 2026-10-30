import { describe, expect, it } from "bun:test";
import { EpisodicGraph, type GraphEdge } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function withGraph<T>(fn: (graph: EpisodicGraph) => T): T {
	const db = openDatabase(":memory:");
	try {
		const graph = new EpisodicGraph({ db });
		return fn(graph);
	} finally {
		closeQuietly(db);
	}
}

function edge(source: string, target: string, edgeType: string, weight: number): GraphEdge {
	return { source, target, edgeType, weight, timestamp: "2026-05-30T00:00:00.000Z" };
}

describe("EpisodicGraph CRUD", () => {
	it("extracts, stores, and reads gists and facts", () => {
		withGraph(graph => {
			const gist = graph.extractGist(
				"Alice had a meeting with Bob yesterday at the office. She was excited about Project Atlas.",
				"mem_001",
			);
			expect(gist.id).toBe("gist_mem_001");
			expect(gist.participants).toContain("Alice");
			expect(gist.participants).toContain("Bob");
			expect(gist.timeScope).toBe("point_in_time");
			expect(gist.emotion).toBe("positive");

			graph.storeGist(gist, "mem_001");
			expect(graph.getGist(gist.id)?.participants).toContain("Alice");
			expect(graph.findGistsByParticipant("Bob")).toHaveLength(1);

			const facts = graph.extractFacts("Alice is a senior developer. Alice uses Python.", "mem_001");
			expect(facts.length).toBeGreaterThanOrEqual(2);
			for (const fact of facts) graph.storeFact(fact, "mem_001", "test");

			const aliceFacts = graph.findFactsBySubject("Alice");
			expect(aliceFacts.map(fact => fact.predicate)).toContain("is");
			expect(aliceFacts.map(fact => fact.predicate)).toContain("uses");
			expect(graph.getStats()).toEqual({
				gists: 1,
				facts: facts.length,
				edges: 0,
				totalNodes: facts.length + 1,
			});
		});
	});
	it("extracts facts with multi-word objects, clause boundaries, and case-insensitive lookup", () => {
		withGraph(graph => {
			const facts1 = graph.extractFacts("Alice is a senior developer.", "mem_alice");
			expect(facts1).toHaveLength(1);
			expect(facts1[0]).toMatchObject({
				subject: "Alice",
				predicate: "is",
				object: "senior developer",
			});

			const facts2 = graph.extractFacts("Bob works at Market Corp.", "mem_bob");
			expect(facts2).toHaveLength(1);
			expect(facts2[0]).toMatchObject({
				subject: "Bob",
				predicate: "works_at",
				object: "Market Corp",
			});

			const facts3 = graph.extractFacts("Atlas has 3 worker nodes.", "mem_atlas");
			expect(facts3).toHaveLength(1);
			expect(facts3[0]).toMatchObject({
				subject: "Atlas",
				predicate: "has",
				object: "3 worker nodes",
			});

			graph.storeFact(facts1[0]!, "mem_alice", "test");
			expect(graph.findFactsBySubject("alice")).toHaveLength(1);
			expect(graph.findFactsBySubject("ALICE")).toHaveLength(1);
		});
	});

	it("rejects sentence-initial stopword/pronoun subjects and isolates newline boundaries", () => {
		withGraph(graph => {
			const stopwordFacts = graph.extractFacts("This is a migration. That has a bug. It uses SQLite.", "mem_stop");
			expect(stopwordFacts.some(f => ["This", "That", "It"].includes(f.subject))).toBe(false);
			expect(stopwordFacts).toEqual([]);

			const newlineFacts = graph.extractFacts("Summary\nAlice is a developer.", "mem_nl");
			expect(newlineFacts).toHaveLength(1);
			expect(newlineFacts[0]?.subject).toBe("Alice");
			expect(newlineFacts[0]?.object).toBe("developer");

			const twoSentenceFacts = graph.extractFacts("We shipped Atlas. Alice is a developer.", "mem_sent1");
			expect(twoSentenceFacts).toHaveLength(1);
			expect(twoSentenceFacts[0]?.subject).toBe("Alice");
			expect(twoSentenceFacts[0]?.object).toBe("developer");

			const doneSentenceFacts = graph.extractFacts("Done. Alice is a developer.", "mem_sent2");
			expect(doneSentenceFacts).toHaveLength(1);
			expect(doneSentenceFacts[0]?.subject).toBe("Alice");
		});
	});

	it("extracts facts for Unicode proper nouns and CJK predicates", () => {
		withGraph(graph => {
			const greekFacts = graph.extractFacts("Βασίλης uses Python.", "mem_greek");
			expect(greekFacts).toHaveLength(1);
			expect(greekFacts[0]).toMatchObject({
				subject: "Βασίλης",
				predicate: "uses",
				object: "Python",
			});

			const cjkFacts = graph.extractFacts("Mnemopi 使用 SQLite，並支援圖譜檢索。", "mem_cjk");
			expect(cjkFacts).toHaveLength(1);
			expect(cjkFacts[0]).toMatchObject({
				subject: "Mnemopi",
				predicate: "uses",
				object: "SQLite",
			});
		});
	});

	it("extracts objects with dots, quotes, and units, and avoids ReDoS backtracking", () => {
		withGraph(graph => {
			const redosAttack = "A is " + " ".repeat(4000) + "(";
			const attackFacts = graph.extractFacts(redosAttack, "mem_attack");
			expect(attackFacts).toEqual([]);
			const nodeFacts = graph.extractFacts("Alice uses Node.js.", "mem_node");
			expect(nodeFacts).toHaveLength(1);
			expect(nodeFacts[0]?.object).toBe("Node.js");

			const ramFacts = graph.extractFacts("Atlas has 3.5 GB of RAM.", "mem_ram");
			expect(ramFacts).toHaveLength(1);
			expect(ramFacts[0]?.object).toBe("3.5 GB of RAM");

			const managerFacts = graph.extractFacts("Alice is Bob's manager.", "mem_mgr");
			expect(managerFacts).toHaveLength(1);
			expect(managerFacts[0]?.object).toBe("Bob's manager");
		});
	});

	it("rejects CJK false-positive triples on function particles, verbs, and unanchored clauses", () => {
		withGraph(graph => {
			const falsePositives = graph.extractFacts(
				"我認為這樣比較好。效能很好但是記憶體不足。目前沒有測試。會議結束於是大家回家。他總是使用 Vim。这个系统是分布式架构。这些服务使用 Redis。",
				"mem_cjk_fp",
			);
			expect(falsePositives).toEqual([]);
		});
	});
});

describe("EpisodicGraph gist location extraction", () => {
	it("captures capitalized proper-noun places and ignores lowercase prose", () => {
		withGraph(graph => {
			expect(graph.extractGist("Met Bob in Paris yesterday.", "mem_loc_1").location).toBe("Paris");
			// Regression for #7917: the /i flag made [A-Z] match lowercase mid-sentence
			// prose, so ordinary text like "...in your loaded context plus" leaked in as a location.
			expect(graph.extractGist("We stored the summary in your loaded context plus.", "mem_loc_2").location).toBe(
				null,
			);
		});
	});
});

describe("EpisodicGraph non-Latin participants", () => {
	it("extracts proper nouns from Greek and Cyrillic content (issue #7918)", () => {
		withGraph(graph => {
			const greek = graph.extractGist("Ο Βασίλης συνάντησε τη Μαρία στην Αθήνα.", "mem_el");
			expect(greek.participants).toContain("Βασίλης");
			expect(greek.participants).toContain("Μαρία");

			const cyrillic = graph.extractGist("Иван встретил Анну в Москве.", "mem_ru");
			expect(cyrillic.participants).toContain("Иван");
			expect(cyrillic.participants).toContain("Анну");

			graph.storeGist(greek, "mem_el");
			expect(graph.findGistsByParticipant("Βασίλης")).toHaveLength(1);
		});
	});

	it("does not read the trailing letter of a non-ASCII word as the pronoun I (issue #16723)", () => {
		withGraph(graph => {
			expect(graph.extractGist("tôi đã sửa rồi, đi tiếp đi", "mem_vi").participants).toEqual([]);
			expect(graph.extractGist("Chúng tôi gặp nhau ở Hà Nội.", "mem_hn").participants).toEqual(["Chúng", "Hà Nội"]);
		});
	});
});

describe("EpisodicGraph links and traversal", () => {
	it("creates idempotent weighted links and traverses neighborhoods", () => {
		withGraph(graph => {
			graph.addEdge(edge("mem_a", "mem_b", "ctx", 0.8));
			graph.addEdge(edge("mem_b", "mem_c", "ctx", 0.7));
			graph.addEdge(edge("mem_a", "mem_d", "syn", 0.4));
			graph.addEdge(edge("mem_a", "mem_b", "ctx", 0.9));

			const all = graph.findRelatedMemories("mem_a", 2);
			expect(all.map(item => item.memoryId)).toContain("mem_b");
			expect(all.map(item => item.memoryId)).toContain("mem_c");
			expect(all.find(item => item.memoryId === "mem_b")?.weight).toBe(0.9);

			const ctxOnly = graph.findRelatedMemories("mem_a", 2, "ctx");
			expect(ctxOnly.map(item => item.memoryId)).toContain("mem_b");
			expect(ctxOnly.map(item => item.memoryId)).toContain("mem_c");
			expect(ctxOnly.map(item => item.memoryId)).not.toContain("mem_d");

			const strongOnly = graph.findRelatedMemories("mem_a", 2, "", 0.75);
			expect(strongOnly.map(item => item.memoryId)).toEqual(["mem_b"]);

			const oneHop = graph.findRelatedMemories("mem_a", 1);
			expect(oneHop.map(item => item.memoryId)).not.toContain("mem_c");
			expect(graph.getStats().edges).toBe(3);
		});
	});

	it("accepts agent-declared edge types", () => {
		withGraph(graph => {
			graph.addEdge(edge("bug_123", "fix_456", "caused", 0.9));
			const results = graph.findRelatedMemories("bug_123", 1, "caused");
			expect(results).toEqual([{ memoryId: "fix_456", edgeType: "caused", weight: 0.9, depth: 1 }]);
		});
	});
});

describe("EpisodicGraph scoring and proactive links", () => {
	it("scores memories by shared graph features", () => {
		withGraph(graph => {
			graph.ingestMemory("Alice is a developer. Alice uses Python at the office.", "mem_a", {
				linkExisting: false,
			});
			graph.ingestMemory("Alice uses Python for backend work at the office.", "mem_b", {
				linkExisting: false,
			});
			graph.ingestMemory("Carol works at MarketCo. Carol uses Rust.", "mem_c", {
				linkExisting: false,
			});

			expect(graph.scoreMemoryLink("mem_a", "mem_b")).toBeGreaterThan(graph.scoreMemoryLink("mem_a", "mem_c"));
			expect(graph.scoreMemoryLink("mem_a", "missing")).toBe(0);
		});
	});

	it("ingestMemory stores episode nodes and creates deterministic ctx/rel/proactive links", () => {
		withGraph(graph => {
			const first = graph.ingestMemory("Alice is a senior developer. Alice uses Python at the office.", "mem_1");
			expect(first.gist.id).toBe("gist_mem_1");
			expect(first.facts.length).toBeGreaterThanOrEqual(2);
			expect(graph.findRelatedMemories("mem_1", 1).map(item => item.memoryId)).toContain("gist_mem_1");

			const second = graph.ingestMemory("Alice uses Python during deployment reviews at the office.", "mem_2", {
				minLinkScore: 0.2,
			});
			expect(
				second.edges.some(item => item.source === "mem_2" && item.target === "mem_1" && item.edgeType === "ctx"),
			).toBe(true);

			const neighbors = graph.findRelatedMemories("mem_2", 2, "", 0.2);
			expect(neighbors.map(item => item.memoryId)).toContain("mem_1");
			expect(neighbors.map(item => item.memoryId)).toContain("gist_mem_2");
			expect(graph.getStats().gists).toBe(2);
			expect(graph.getStats().facts).toBe(first.facts.length + second.facts.length);
		});
	});

	it("does not link memories that only share a time scope", () => {
		withGraph(graph => {
			graph.ingestMemory("Yesterday the database migration finished on staging.", "mem_db");
			const unrelated = graph.ingestMemory("Today I bought fresh vegetables at the market.", "mem_food");
			expect(unrelated.gist.timeScope).toBe("point_in_time");
			expect(graph.getGist("gist_mem_db")?.timeScope).toBe("point_in_time");
			expect(unrelated.edges.filter(item => item.target === "mem_db")).toEqual([]);

			const related = graph.ingestMemory("Today the database migration finished on production.", "mem_db_prod");
			const linked = related.edges.filter(item => item.target === "mem_db").map(item => item.edgeType);
			expect(linked.sort()).toEqual(["ctx", "related_to"]);
			expect(related.edges.filter(item => item.target === "mem_food")).toEqual([]);

			graph.ingestMemory("Alice uses Python.", "mem_alice");
			const entityOnly = graph.ingestMemory(
				"Alice uses Python during long winter evenings while sketching harbor boats.",
				"mem_alice_evenings",
			);
			const toAlice = entityOnly.edges.filter(item => item.target === "mem_alice");
			const references = toAlice.find(item => item.edgeType === "references");
			expect(references?.weight).toBeGreaterThanOrEqual(0.35);
			expect(toAlice.some(item => item.edgeType === "related_to")).toBe(false);
			expect(toAlice.find(item => item.edgeType === "ctx")?.weight).toBe(references?.weight);
		});
	});
});
