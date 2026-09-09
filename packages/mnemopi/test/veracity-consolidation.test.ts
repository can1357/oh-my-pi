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
});
