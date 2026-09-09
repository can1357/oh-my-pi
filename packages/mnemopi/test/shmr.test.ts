import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import * as embeddings from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	clusterBySimilarity,
	cosineSimilarity,
	embed,
	getResonanceLog,
	harmonize,
	recallBeliefs,
} from "@oh-my-pi/pi-mnemopi/core/shmr";

let embedSpy: Mock<typeof embeddings.embed> | null = null;

afterEach(() => {
	embedSpy?.mockRestore();
	embedSpy = null;
});

/** Routes the embeddings module's batch API through a fake per-text vector table. */
function stubProvider(vectorFor: (text: string) => Float32Array): void {
	embedSpy = spyOn(embeddings, "embed").mockImplementation(async (texts: readonly string[]) => texts.map(vectorFor));
}

function stubNoProvider(): void {
	embedSpy = spyOn(embeddings, "embed").mockResolvedValue(null);
}

describe("SHMR embedding integration", () => {
	it("clusters with provider vectors when an embedding provider is configured", async () => {
		// Zero word overlap between the first two texts: the hash fallback could
		// never cluster them, so a [2, 1] split proves provider vectors were used.
		const table: Record<string, Float32Array> = {
			"alpha beta": new Float32Array([1, 0, 0]),
			"gamma delta": new Float32Array([1, 0, 0]),
			"omega psi": new Float32Array([0, 1, 0]),
		};
		stubProvider(text => table[text] ?? new Float32Array([0, 0, 1]));
		const clusters = await clusterBySimilarity(
			[{ object: "alpha beta" }, { object: "gamma delta" }, { object: "omega psi" }],
			0.9,
		);
		expect(clusters.map(cluster => cluster.length).sort()).toEqual([1, 2]);
		// One batch call for all missing vectors, not one call per item.
		expect(embedSpy?.mock.calls.length).toBe(1);
		expect(embedSpy?.mock.calls[0]?.[0]).toEqual(["alpha beta", "gamma delta", "omega psi"]);
	});

	it("falls back to deterministic hash vectors when no provider is available", async () => {
		stubNoProvider();
		const a = await embed("dark mode preference");
		const b = await embed("dark mode preference");
		const c = await embed("unrelated database migration");
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
		const clusters = await clusterBySimilarity(
			[
				{ object: "dark mode preference", embedding: a },
				{ object: "dark mode preference", embedding: b },
				{ object: "unrelated database migration", embedding: c },
			],
			0.9,
		);
		expect(clusters.map(cluster => cluster.length).sort()).toEqual([1, 2]);
	});

	it("reuses precomputed vectors from memory_embeddings during harmonize", async () => {
		// No provider and zero word overlap between contents: only the precomputed
		// vectors stored in memory_embeddings can make these two items cluster.
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run("INSERT INTO episodic_memory (id, content, importance) VALUES (?, ?, ?)", [
				"m1",
				"alpha beta quartz one",
				0.8,
			]);
			db.run("INSERT INTO episodic_memory (id, content, importance) VALUES (?, ?, ?)", [
				"m2",
				"gamma delta umbra two",
				0.8,
			]);
			db.run("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)", ["m1", "[1, 0, 0]"]);
			db.run("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)", ["m2", "[1, 0, 0]"]);
			const stats = await harmonize({ db, session_id: "s" }, 10, 1, 0.9);
			expect(stats.status).toBe("harmonized");
			expect(stats.clusters_found).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("SHMR deterministic helpers", () => {
	it("harmonizes corroborated facts without an LLM", async () => {
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f1", "s", "user", "prefers", "dark mode", 0.8, "2026-01-01T00:00:00"],
			);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f2", "s", "user", "prefers", "dark mode", 0.9, "2026-01-02T00:00:00"],
			);
			const stats = await harmonize({ db, session_id: "s" }, 10, 1, 0.8);
			expect(stats.status).toBe("harmonized");
			expect(stats.clusters_found).toBe(1);
			expect(stats.beliefs_generated).toBeGreaterThanOrEqual(1);
			const beliefs = await recallBeliefs({ db }, "dark mode", 5);
			expect(beliefs.some(belief => belief.content === "dark mode" && belief.source === "harmonic_belief")).toBe(
				true,
			);
			expect(getResonanceLog({ db }, 1)[0]?.beliefs_generated).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
	});

	it("reports insufficient candidates deterministically", async () => {
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const stats = await harmonize({ db }, 10, 1, 0.8);
			expect(stats.status).toBe("insufficient_candidates");
			expect(stats.beliefs_generated).toBe(0);
		} finally {
			db.close();
		}
	});
});
