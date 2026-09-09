import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const roots: string[] = [];

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-telemetry-env-"));
	roots.push(root);
	return join(root, "mnemopi.db");
}

afterEach(() => {
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("telemetry and env follow-up parity", () => {
	it("fallback episodic rows expose explicit zero dense_score and linear voice_scores", async () => {
		const beam = new BeamMemory({ sessionId: "s1", dbPath: tempDb() });
		try {
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"ep-no-emb",
					"unique zorblax token for fallback test",
					"consolidation",
					new Date().toISOString(),
					"s1",
					0.5,
				],
			);

			const hit = (await beam.recall("zorblax", 10)).find(row => row.id === "ep-no-emb");
			expect(hit).toBeDefined();
			expect(hit?.tier).toBe("episodic");
			expect(hit?.dense_score).toBe(0);
			expect(typeof hit?.dense_score).toBe("number");
			const scores = hit?.voice_scores;
			expect(scores?.vec).toBe(0);
			expect(typeof scores?.fts).toBe("number");
			expect(typeof scores?.keyword).toBe("number");
			expect(typeof scores?.importance).toBe("number");
			expect(typeof scores?.recency_decay).toBe("number");
		} finally {
			beam.close();
		}
	});

	it("main recall path preserves numeric dense_score and voice_scores on working memory", async () => {
		const beam = new BeamMemory({ sessionId: "s1", dbPath: tempDb() });
		try {
			const id = beam.remember("The user wants dark mode for the editor", {
				source: "conversation",
				importance: 0.8,
			});
			const hit = (await beam.recall("dark mode", 10)).find(row => row.id === id);
			expect(hit).toBeDefined();
			expect(typeof hit?.dense_score).toBe("number");
			const scores = hit?.voice_scores;
			expect(typeof scores?.vec).toBe("number");
			expect(typeof scores?.fts).toBe("number");
			expect(typeof scores?.keyword).toBe("number");
			expect(typeof scores?.importance).toBe("number");
			expect(typeof scores?.recency_decay).toBe("number");
		} finally {
			beam.close();
		}
	});

	it("all linear recall results have numeric voice score entries", async () => {
		const beam = new BeamMemory({ sessionId: "s1", dbPath: tempDb() });
		try {
			beam.remember("The deployment plan is approved", { importance: 0.7 });
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"ep-deploy",
					"the deployment runbook explains rollout",
					"consolidation",
					new Date().toISOString(),
					"s1",
					0.6,
				],
			);

			const results = await beam.recall("deployment", 10);
			expect(results.length).toBeGreaterThan(0);
			for (const row of results) {
				expect(row.voice_scores).toBeDefined();
				const scores = row.voice_scores ?? {};
				for (const key in scores) {
					expect(typeof scores[key]).toBe("number");
				}
			}
		} finally {
			beam.close();
		}
	});
});
