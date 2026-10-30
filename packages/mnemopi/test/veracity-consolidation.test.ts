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
});
