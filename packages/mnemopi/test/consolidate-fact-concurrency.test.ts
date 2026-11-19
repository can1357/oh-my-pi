import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeracityConsolidator } from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";
import { closeQuietly } from "@oh-my-pi/pi-mnemopi/db";

function withDb<T>(fn: (path: string, cons: VeracityConsolidator) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-veracity-concurrency-"));
	const path = join(dir, "facts.db");
	const cons = new VeracityConsolidator(path);
	try {
		return fn(path, cons);
	} finally {
		closeQuietly(cons.conn);
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("consolidate_fact SQLite serialization", () => {
	it("records repeated same-SPO observations as one row with compounded confidence", () => {
		withDb((_path, cons) => {
			const first = cons.consolidateFact("Alice", "is", "developer", "stated", "src_a");
			const second = cons.consolidateFact("Alice", "is", "developer", "stated", "src_b");
			const third = cons.consolidateFact("Alice", "is", "developer", "stated", "src_c");

			expect(second.confidence).toBeGreaterThan(first.confidence);
			expect(third.confidence).toBeGreaterThan(second.confidence);

			const rows = cons.conn
				.query("SELECT mention_count, confidence, sources_json FROM consolidated_facts WHERE subject = 'Alice'")
				.all() as Array<{ mention_count: number; confidence: number; sources_json: string }>;
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected Alice row");
			expect(row.mention_count).toBe(3);
			expect(row.confidence).toBe(third.confidence);
			expect(JSON.parse(row.sources_json)).toEqual(["src_a", "src_b", "src_c"]);
		});
	});

	it("writes distinct SPOs through separate connections without dropping rows", () => {
		withDb((path, cons) => {
			const second = new VeracityConsolidator(path);
			try {
				cons.consolidateFact("Person0", "is", "engineer", "stated", "src_0");
				second.consolidateFact("Person1", "is", "engineer", "stated", "src_1");
				second.consolidateFact("Person2", "is", "engineer", "stated", "src_2");
				cons.consolidateFact("Person3", "is", "engineer", "stated", "src_3");

				const count = cons.conn
					.query("SELECT COUNT(*) AS count FROM consolidated_facts WHERE subject LIKE 'Person%'")
					.get() as { count: number };
				expect(count.count).toBe(4);
			} finally {
				closeQuietly(second.conn);
			}
		});
	});

	it("participates in an outer transaction instead of starting a nested BEGIN", () => {
		withDb((_path, cons) => {
			cons.conn.exec("BEGIN");
			try {
				const fact = cons.consolidateFact("Dan", "is", "designer", "stated", "src_x");
				expect(fact.subject).toBe("Dan");
				const visibleInside = cons.conn
					.query("SELECT mention_count FROM consolidated_facts WHERE subject = 'Dan'")
					.get() as { mention_count: number };
				expect(visibleInside.mention_count).toBe(1);
				cons.conn.exec("COMMIT");
			} catch (error) {
				cons.conn.exec("ROLLBACK");
				throw error;
			}

			const rows = cons.conn
				.query("SELECT mention_count FROM consolidated_facts WHERE subject = 'Dan'")
				.all() as Array<{ mention_count: number }>;
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected Dan row");
			expect(row.mention_count).toBe(1);
		});
	});

	it("rolls back its own transaction when a mid-update error occurs", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Eve", "is", "scientist", "stated", "src_a");
			const original = cons.bayesianUpdate;
			cons.bayesianUpdate = () => {
				throw new Error("simulated mid-update failure");
			};
			try {
				expect(() => cons.consolidateFact("Eve", "is", "scientist", "stated", "src_b")).toThrow("simulated");
			} finally {
				cons.bayesianUpdate = original;
			}

			const row = cons.conn
				.query("SELECT mention_count, sources_json FROM consolidated_facts WHERE subject = 'Eve'")
				.get() as { mention_count: number; sources_json: string };
			expect(row.mention_count).toBe(1);
			expect(JSON.parse(row.sources_json)).toEqual(["src_a"]);
		});
	});

	it("does not leak a fact insert when conflict recording fails", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Kate", "is", "X", "stated", "src_x");
			cons.consolidateFact("Kate", "is", "Y", "stated", "src_y");
			const original = cons.recordConflict;
			let calls = 0;
			cons.recordConflict = (...args: Parameters<VeracityConsolidator["recordConflict"]>) => {
				calls += 1;
				if (calls === 2) throw new Error("simulated mid-loop failure");
				return original.apply(cons, args);
			};
			try {
				expect(() => cons.consolidateFact("Kate", "is", "Z", "stated", "src_z")).toThrow("simulated");
			} finally {
				cons.recordConflict = original;
			}

			const rows = cons.conn
				.query("SELECT object FROM consolidated_facts WHERE subject = 'Kate' AND object = 'Z'")
				.all();
			expect(rows).toHaveLength(0);
		});
	});
});
