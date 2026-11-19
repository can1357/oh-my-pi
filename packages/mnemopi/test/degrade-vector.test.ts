import { describe, expect, it } from "bun:test";

import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { maximallyInformativeBinarization } from "@oh-my-pi/pi-mnemopi/core/binary-vectors";

function oldIso(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function storedEmbedding(beam: BeamMemory, memoryId: string): string | null {
	const row = beam.db.query("SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?").get(memoryId) as {
		embedding_json: string;
	} | null;
	return row?.embedding_json ?? null;
}

describe("degradeEpisodic vector invalidation", () => {
	it("invalidates stale dense fallback and binary vectors when tier 2 content is compressed", () => {
		const beam = new BeamMemory({ sessionId: "degrade-vector", dbPath: ":memory:" });
		try {
			const original = "ORIGINAL_DETAILED_CONTEXT ".repeat(40).trim();
			const id = beam.consolidateToEpisodic(original, ["wm-1"], "test", 0.7);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				id,
				JSON.stringify([1, 0, 0, 0]),
			]);
			beam.db.run("UPDATE episodic_memory SET tier = 2, created_at = ?, binary_vector = ? WHERE id = ?", [
				oldIso(181),
				maximallyInformativeBinarization([1, -1, 1, -1]),
				id,
			]);

			const result = beam.degradeEpisodic(false);

			expect(result.tier2_to_tier3).toBe(1);
			const row = beam.db.query("SELECT content, tier, binary_vector FROM episodic_memory WHERE id = ?").get(id) as {
				content: string;
				tier: number;
				binary_vector: Uint8Array | null;
			};
			expect(row.tier).toBe(3);
			expect(row.content).not.toBe(original);
			expect(storedEmbedding(beam, id)).toBeNull();
			expect(row.binary_vector).toBeNull();
		} finally {
			beam.close();
		}
	});

	it("leaves vector rows intact on dry-run degradation", () => {
		const beam = new BeamMemory({ sessionId: "degrade-dry", dbPath: ":memory:" });
		try {
			const original = "DRY_RUN_CONTEXT ".repeat(40).trim();
			const id = beam.consolidateToEpisodic(original, ["wm-1"], "test", 0.7);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				id,
				JSON.stringify([0, 1, 0, 0]),
			]);
			beam.db.run("UPDATE episodic_memory SET tier = 2, created_at = ?, binary_vector = ? WHERE id = ?", [
				oldIso(181),
				maximallyInformativeBinarization([-1, 1, -1, 1]),
				id,
			]);

			const result = beam.degradeEpisodic(true);
			const row = beam.db.query("SELECT content, tier, binary_vector FROM episodic_memory WHERE id = ?").get(id) as {
				content: string;
				tier: number;
				binary_vector: Uint8Array | null;
			};

			expect(result.status).toBe("dry_run");
			expect(row.content).toBe(original);
			expect(row.tier).toBe(2);
			expect(storedEmbedding(beam, id)).not.toBeNull();
			expect(row.binary_vector).not.toBeNull();
		} finally {
			beam.close();
		}
	});
});
