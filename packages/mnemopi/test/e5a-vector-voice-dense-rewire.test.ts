import { describe, expect, it, spyOn } from "bun:test";

import { DENSE_CANDIDATE_LIMIT } from "@oh-my-pi/pi-mnemopi/config";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

function seedEmbedding(beam: BeamMemory, memoryId: string, vector: readonly number[]): void {
	beam.db.run("INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		memoryId,
		JSON.stringify(vector),
	]);
}

describe("polyphonic vector voice dense rewire", () => {
	it("returns ranked candidates from memory_embeddings for working and episodic tiers", () => {
		const beam = new BeamMemory({ sessionId: "e5a", dbPath: ":memory:" });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES ('wm-1', 'working row', 'test', datetime('now'), 'e5a', 0.5)",
			);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-1', 'episodic row', 'test', datetime('now'), 0.5)",
			);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-far', 'far row', 'test', datetime('now'), 0.5)",
			);
			seedEmbedding(beam, "wm-1", [1, 0]);
			seedEmbedding(beam, "em-1", [1, 0]);
			seedEmbedding(beam, "em-far", [0, 1]);

			const results = new PolyphonicRecallEngine({ db: beam.db }).vectorVoice([1, 0]);
			const ids = results.map(result => result.memoryId);
			expect(ids).toContain("wm-1");
			expect(ids).toContain("em-1");
			const farScore = results.find(result => result.memoryId === "em-far")?.score ?? 0;
			const nearScore = results.find(result => result.memoryId === "em-1")?.score ?? 0;
			expect(farScore).toBeLessThan(nearScore);
			expect(new Set(results.map(result => result.metadata.embedding_tier))).toEqual(
				new Set(["working", "episodic"]),
			);
			expect(results.every(result => result.voice === "vector")).toBe(true);
		} finally {
			beam.close();
		}
	});

	it("excludes superseded and expired rows while tolerating missing query embeddings", () => {
		const beam = new BeamMemory({ sessionId: "e5a-filter", dbPath: ":memory:" });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, superseded_by) VALUES ('wm-old', 'old', 'test', datetime('now'), 'e5a-filter', 0.5, 'wm-live')",
			);
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES ('wm-live', 'live', 'test', datetime('now'), 'e5a-filter', 0.5)",
			);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance, valid_until) VALUES ('em-expired', 'expired', 'test', datetime('now'), 0.5, datetime('now', '-1 day'))",
			);
			seedEmbedding(beam, "wm-old", [1, 0]);
			seedEmbedding(beam, "wm-live", [1, 0]);
			seedEmbedding(beam, "em-expired", [1, 0]);

			const engine = new PolyphonicRecallEngine({ db: beam.db });
			const ids = new Set(engine.vectorVoice([1, 0]).map(result => result.memoryId));
			expect(ids.has("wm-old")).toBe(false);
			expect(ids.has("em-expired")).toBe(false);
			expect(ids.has("wm-live")).toBe(true);
			expect(engine.vectorVoice(null)).toEqual([]);
		} finally {
			beam.close();
		}
	});

	it("full recall carries vector voice attribution and stats report embedded rows", () => {
		const beam = new BeamMemory({ sessionId: "e5a-rrf", dbPath: ":memory:" });
		try {
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-x', 'target content', 'test', datetime('now'), 0.5)",
			);
			seedEmbedding(beam, "em-x", [1, 0]);
			const engine = new PolyphonicRecallEngine({ db: beam.db });

			const results = engine.recall("target content", [1, 0], 10);

			expect(results.some(result => result.voice_scores.vector !== undefined)).toBe(true);
			expect(engine.getStats().vector_stats).toEqual({ embedded_rows: 1 });
		} finally {
			beam.close();
		}
	});

	it("scores only the newest DENSE_CANDIDATE_LIMIT rows of a tier", () => {
		const beam = new BeamMemory({ sessionId: "e5a-window", dbPath: ":memory:" });
		try {
			const insert = beam.db.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, 'row', 'test', ?, 'e5a-window', 0.5)",
			);
			beam.db.transaction(() => {
				insert.run("wm-old", "2020-01-01T00:00:00.000Z");
				for (let i = 0; i < DENSE_CANDIDATE_LIMIT; i++) {
					insert.run(`wm-${i}`, new Date(Date.UTC(2021, 0, 1) + i * 1000).toISOString());
				}
			})();
			const newest = `wm-${DENSE_CANDIDATE_LIMIT - 1}`;
			seedEmbedding(beam, "wm-old", [1, 0]);
			seedEmbedding(beam, newest, [1, 0]);

			const ids = new PolyphonicRecallEngine({ db: beam.db }).vectorVoice([1, 0]).map(result => result.memoryId);

			expect(ids).toEqual([newest]);
		} finally {
			beam.close();
		}
	});

	it("does not re-read stored vectors on a repeated recall", () => {
		const beam = new BeamMemory({ sessionId: "e5a-cache", dbPath: ":memory:" });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES ('wm-1', 'cached row', 'test', datetime('now'), 'e5a-cache', 0.5)",
			);
			seedEmbedding(beam, "wm-1", [1, 0]);
			const engine = new PolyphonicRecallEngine({ db: beam.db });
			const first = engine.recall("cached row", [1, 0], 10);
			expect(first.map(result => result.id)).toEqual(["wm-1"]);

			const query = spyOn(beam.db, "query");
			try {
				expect(engine.recall("cached row", [1, 0], 10)).toEqual(first);
				expect(query.mock.calls.filter(([sql]) => sql.includes("memory_embeddings"))).toEqual([]);
			} finally {
				query.mockRestore();
			}
		} finally {
			beam.close();
		}
	});
});
