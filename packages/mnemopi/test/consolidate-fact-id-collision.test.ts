import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFactId, VeracityConsolidator } from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";
import { closeQuietly } from "@oh-my-pi/pi-mnemopi/db";

afterEach(() => {
	vi.restoreAllMocks();
});

function withDb<T>(fn: (path: string, cons: VeracityConsolidator) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-veracity-"));
	const path = join(dir, "facts.db");
	const cons = new VeracityConsolidator(path);
	try {
		return fn(path, cons);
	} finally {
		closeQuietly(cons.conn);
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("compute_fact_id", () => {
	it("is deterministic and uses the stable SHA-256 framed format", () => {
		const id = computeFactId("Alice", "is", "developer");
		expect(computeFactId("Alice", "is", "developer")).toBe(id);
		expect(id).toMatch(/^cf_[0-9a-f]{24}$/);

		const framed = Buffer.concat([
			Buffer.from("5:"),
			Buffer.from("Alice"),
			Buffer.from("2:"),
			Buffer.from("is"),
			Buffer.from("9:"),
			Buffer.from("developer"),
		]);
		expect(id).toBe(`cf_${createHash("sha256").update(framed).digest("hex").slice(0, 24)}`);
	});

	it("distinguishes long, separator-smuggled, and differently bucketed SPOs", () => {
		const ids = new Set([
			computeFactId(
				"EngineerLeadAlice",
				"is_described_in_the_internal_documentation_at_section_4_paragraph_3_as",
				"a competent and reliable engineer who delivers on time",
			),
			computeFactId(
				"EngineerLeadAlice",
				"is_described_in_the_internal_documentation_at_section_4_paragraph_3_as",
				"a competent and reliable engineer who escalates blockers",
			),
			computeFactId("a_b", "c", "d"),
			computeFactId("a", "b_c", "d"),
			computeFactId("a\x1f", "b", "c"),
			computeFactId("a", "\x1fb", "c"),
		]);
		expect(ids.size).toBe(6);
	});

	it("normalizes Unicode and rejects invalid components", () => {
		expect(computeFactId("café", "is", "open")).toBe(computeFactId("café", "is", "open"));
		expect(() => computeFactId("", "is", "developer")).toThrow("must be non-empty");
		expect(() => computeFactId("Alice", "", "developer")).toThrow("must be non-empty");
		expect(() => computeFactId("Alice", "is", "")).toThrow("must be non-empty");
		expect(() => computeFactId(null as unknown as string, "is", "developer")).toThrow("must be a str");
	});
});

describe("consolidate_fact id collision behavior", () => {
	it("stores hash ids and keeps distinct long-content facts", () => {
		withDb((_path, cons) => {
			const pred = "is_described_in_the_internal_documentation_at_section_4_paragraph_3_as";
			cons.consolidateFact(
				"EngineerLeadAlice",
				pred,
				"a competent and reliable engineer who delivers on time",
				"stated",
				"mem_x",
			);
			cons.consolidateFact(
				"EngineerLeadAlice",
				pred,
				"a competent and reliable engineer who escalates blockers",
				"stated",
				"mem_y",
			);

			const rows = cons.conn
				.query("SELECT id, object FROM consolidated_facts WHERE subject = ? ORDER BY object")
				.all("EngineerLeadAlice") as Array<{ id: string; object: string }>;
			expect(rows).toHaveLength(2);
			expect(new Set(rows.map(row => row.id)).size).toBe(2);
			for (const row of rows) expect(row.id).toBe(computeFactId("EngineerLeadAlice", pred, row.object));
		});
	});

	it("deduplicates by SPO so legacy ids are preserved while new rows use hashes", () => {
		withDb((_path, cons) => {
			const legacyId = "cf_Eve_is_a_lawyer";
			cons.conn
				.query(`
					INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES (?, 'Eve', 'is', 'a lawyer', 0.5, 1, '2026-01-01T00:00:00', '2026-01-01T00:00:00', '[]', 'stated')
				`)
				.run(legacyId);

			const result = cons.consolidateFact("Eve", "is", "a lawyer", "stated", "mem_new");
			const rows = cons.conn
				.query("SELECT id, mention_count, sources_json FROM consolidated_facts WHERE subject = 'Eve'")
				.all() as Array<{ id: string; mention_count: number; sources_json: string }>;

			expect(result.id).toBe(legacyId);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected Eve row");
			expect(row.id).toBe(legacyId);
			expect(row.mention_count).toBe(2);
			expect(JSON.parse(row.sources_json)).toEqual(["mem_new"]);

			cons.consolidateFact("Eve", "is", "a judge", "stated", "mem_other");
			const newRow = cons.conn
				.query("SELECT id FROM consolidated_facts WHERE subject = 'Eve' AND object = 'a judge'")
				.get() as { id: string };
			expect(newRow.id).toBe(computeFactId("Eve", "is", "a judge"));
		});
	});

	it("resolves conflicts with compute_fact_id and rejects ambiguous winners", () => {
		withDb((_path, cons) => {
			cons.consolidateFact("Grace", "is", "the CTO", "stated");
			cons.consolidateFact("Grace", "is", "the VP", "inferred");
			const conflict = cons.getConflicts()[0];
			if (conflict === undefined) throw new Error("expected Grace conflict");

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			cons.resolveConflict(conflict.id, "cf_definitely_not_in_db_0000000000");
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("matches neither fact_a_id");
			expect(cons.getConflicts()).toHaveLength(1);

			const winning = computeFactId("Grace", "is", "the CTO");
			cons.resolveConflict(conflict.id, winning);
			expect(cons.getConflicts()).toHaveLength(0);
			const loser = cons.conn
				.query("SELECT superseded_by FROM consolidated_facts WHERE object = 'the VP'")
				.get() as { superseded_by: string | null };
			expect(loser.superseded_by).toBe(winning);
		});
	});
});
