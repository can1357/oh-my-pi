import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeracityConsolidator } from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";
import { closeQuietly } from "@oh-my-pi/pi-mnemopi/db";

afterEach(() => {
	vi.restoreAllMocks();
});
function withDb<T>(fn: (path: string, cons: VeracityConsolidator) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-veracity-siblings-"));
	const path = join(dir, "facts.db");
	const cons = new VeracityConsolidator(path);
	try {
		return fn(path, cons);
	} finally {
		closeQuietly(cons.conn);
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("VeracityConsolidator sibling write methods", () => {
	it("resolve_conflict has first-writer-wins semantics", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Alice", "is", "engineer", "stated", "src_a");
			cons.consolidateFact("Alice", "is", "manager", "inferred", "src_b");
			const conflict = cons.getConflicts()[0];
			if (conflict === undefined) throw new Error("expected Alice conflict");

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			cons.resolveConflict(conflict.id, conflict.fact_a_id);
			cons.resolveConflict(conflict.id, conflict.fact_b_id);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("already resolved");

			const facts = cons.conn
				.query("SELECT id, superseded_by FROM consolidated_facts WHERE subject = 'Alice'")
				.all() as Array<{ id: string; superseded_by: string | null }>;
			expect(facts.filter(row => row.superseded_by !== null)).toHaveLength(1);
			const conflictRow = cons.conn.query("SELECT resolution FROM conflicts WHERE id = ?").get(conflict.id) as {
				resolution: string | null;
			};
			expect(conflictRow.resolution).toBe(`superseded_by_${conflict.fact_a_id}`);
		});
	});

	it("resolve_conflict_by_facts marks only the losing fact superseded", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Carol", "is", "lead", "stated");
			cons.consolidateFact("Carol", "is", "founder", "stated");
			const rows = cons.conn
				.query("SELECT id, object FROM consolidated_facts WHERE subject = 'Carol'")
				.all() as Array<{ id: string; object: string }>;
			const winning = rows.find(row => row.object === "lead")?.id;
			const losing = rows.find(row => row.object === "founder")?.id;
			if (winning === undefined) throw new Error("expected Carol lead fact");
			if (losing === undefined) throw new Error("expected Carol founder fact");

			cons.resolveConflictByFacts(winning, losing);
			cons.resolveConflictByFacts(winning, losing);

			const loser = cons.conn.query("SELECT superseded_by FROM consolidated_facts WHERE id = ?").get(losing) as {
				superseded_by: string | null;
			};
			const winner = cons.conn.query("SELECT superseded_by FROM consolidated_facts WHERE id = ?").get(winning) as {
				superseded_by: string | null;
			};
			expect(loser.superseded_by).toBe(winning);
			expect(winner.superseded_by).toBeNull();
		});
	});

	it("run_consolidation_pass resolves obvious high-confidence conflicts and nests safely", () => {
		withDb((_path, cons) => {
			for (let i = 0; i < 4; i += 1) cons.consolidateFact("Eve", "is", "CEO", "stated", `src_high_${i}`);
			cons.consolidateFact("Eve", "is", "VP", "inferred", "src_low");

			cons.runConsolidationPass();

			const rows = cons.conn
				.query("SELECT object, superseded_by FROM consolidated_facts WHERE subject = 'Eve' ORDER BY object")
				.all() as Array<{ object: string; superseded_by: string | null }>;
			const byObject = Object.fromEntries(rows.map(row => [row.object, row.superseded_by]));
			if (!("CEO" in byObject)) throw new Error("expected Eve CEO fact");
			if (!("VP" in byObject)) throw new Error("expected Eve VP fact");
			expect(byObject.CEO).toBeNull();
			expect(byObject.VP).toBeTruthy();
		});
	});

	it("_serialized_write commits, rolls back, and respects caller-owned transactions", () => {
		withDb((_path, cons) => {
			cons.serializedWrite(() => {
				cons.conn.run(`
					INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_committed', 's', 'p', 'o', 0.5, 1, datetime('now'), datetime('now'), '[]', 'stated')
				`);
			});
			expect(cons.conn.query("SELECT id FROM consolidated_facts WHERE id = 'cf_committed'").get()).not.toBeNull();

			expect(() =>
				cons.serializedWrite(() => {
					cons.conn.run(`
						INSERT INTO consolidated_facts
						(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
						VALUES ('cf_doomed', 's', 'p', 'doomed', 0.5, 1, datetime('now'), datetime('now'), '[]', 'stated')
					`);
					throw new Error("simulated mid-write failure");
				}),
			).toThrow("simulated");
			expect(cons.conn.query("SELECT id FROM consolidated_facts WHERE id = 'cf_doomed'").get()).toBeNull();

			cons.conn.exec("BEGIN");
			try {
				cons.serializedWrite(() => {
					cons.conn.run(`
						INSERT INTO consolidated_facts
						(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
						VALUES ('cf_nested', 's', 'p', 'nested', 0.5, 1, datetime('now'), datetime('now'), '[]', 'stated')
					`);
				});
				cons.conn.exec("ROLLBACK");
			} catch (error) {
				cons.conn.exec("ROLLBACK");
				throw error;
			}
			expect(cons.conn.query("SELECT id FROM consolidated_facts WHERE id = 'cf_nested'").get()).toBeNull();
		});
	});

	it("get_consolidated_facts and stats exclude superseded facts", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Nina", "owns", "service-a", "stated");
			cons.consolidateFact("Nina", "owns", "service-b", "inferred");
			const conflict = cons.getConflicts()[0];
			if (conflict === undefined) throw new Error("expected Nina conflict");
			cons.resolveConflict(conflict.id, conflict.fact_a_id);

			const facts = cons.getConsolidatedFacts("Nina", 0);
			expect(facts).toHaveLength(1);
			const fact = facts[0];
			if (fact === undefined) throw new Error("expected active Nina fact");
			expect(fact.id).toBe(conflict.fact_a_id);

			const stats = cons.getStats();
			expect(stats.active_facts).toBe(1);
			expect(stats.superseded_facts).toBe(1);
			expect(stats.unresolved_conflicts).toBe(0);
		});
	});
});
