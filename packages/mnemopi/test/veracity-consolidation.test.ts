import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { VeracityConsolidator } from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";

describe("VeracityConsolidator", () => {
	it("does not close a caller-owned Database handle", () => {
		const db = new Database(":memory:", { create: true, readwrite: true, strict: true });
		try {
			const consolidator = new VeracityConsolidator(":memory:", db);
			consolidator.consolidateFact("Alice", "likes", "tea", "stated", "test");

			consolidator.close();

			const row = db.query("SELECT COUNT(*) AS count FROM consolidated_facts").get() as { count: number };
			expect(row.count).toBe(1);
		} finally {
			db.close();
		}
	});

	it("records a contradiction for a single-valued relation but not for a multi-valued one", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			consolidator.consolidateFact("Alice", "lives_in", "Paris", "stated", "m1");
			consolidator.consolidateFact("Alice", "lives_in", "Rome", "stated", "m2");
			consolidator.consolidateFact("Alice", "related_to", "Rust", "stated", "m3");
			consolidator.consolidateFact("Alice", "related_to", "Go", "stated", "m4");
			consolidator.consolidateFact("Alice", "related_to", "Zig", "stated", "m5");

			expect(consolidator.getConflicts()).toHaveLength(1);
		} finally {
			consolidator.close();
		}
	});

	it("does not inflate mention_count, confidence, or updated_at on duplicate source ID", () => {
		const db = new Database(":memory:", { create: true, readwrite: true, strict: true });
		const consolidator = new VeracityConsolidator(":memory:", db);
		try {
			const initial = consolidator.consolidateFact("Alice", "likes", "tea", "stated", "m1");
			expect(initial.mention_count).toBe(1);
			const initialConfidence = initial.confidence;
			const sentinelUpdatedAt = "2000-01-01T00:00:00.000Z";
			db.query("UPDATE consolidated_facts SET updated_at = ? WHERE id = ?").run(sentinelUpdatedAt, initial.id!);

			const dupe = consolidator.consolidateFact("Alice", "likes", "tea", "unknown", "m1");
			expect(dupe.mention_count).toBe(1);
			expect(dupe.confidence).toBe(initialConfidence);
			expect(dupe.veracity).toBe("stated");
			expect(dupe.sources).toEqual(["m1"]);
			const afterDupeRow = db
				.query("SELECT updated_at, last_seen FROM consolidated_facts WHERE id = ?")
				.get(initial.id!) as { updated_at: string; last_seen: string | null };
			expect(afterDupeRow.updated_at).toBe(sentinelUpdatedAt);
			expect(afterDupeRow.last_seen).toBe(initial.last_seen);

			const distinct = consolidator.consolidateFact("Alice", "likes", "tea", "stated", "m2");
			expect(distinct.mention_count).toBe(2);
			expect(distinct.confidence).toBeGreaterThan(initialConfidence);
			expect(distinct.sources).toEqual(["m1", "m2"]);
		} finally {
			consolidator.close();
			db.close();
		}
	});
});
