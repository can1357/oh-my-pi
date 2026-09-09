import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

type TempDb = { dir: string; path: string };
const tempDbs: TempDb[] = [];

function tempDb(name = "mnemopi.db"): TempDb {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-beam-parity-"));
	const db = { dir, path: join(dir, name) };
	tempDbs.push(db);
	return db;
}

function closeAndRemoveAll(): void {
	while (tempDbs.length > 0) {
		const db = tempDbs.pop();
		if (db) rmSync(db.dir, { recursive: true, force: true });
	}
}

afterEach(closeAndRemoveAll);

describe("Beam TS parity integration", () => {
	it("constructs on string DB paths, creates parents, remembers, and recalls from an isolated file DB", async () => {
		const db = tempDb(join("nested", "beam.db"));
		const beam = new BeamMemory({ sessionId: "path-coercion", dbPath: db.path });
		try {
			expect(beam.dbPath).toBe(db.path);
			const id = beam.remember("Prefers Neovim for editing", {
				source: "preference",
				importance: 0.9,
				veracity: "stated",
			});
			expect(id.length).toBeGreaterThan(0);
			expect(beam.getContext(5)).toMatchObject([
				{ id, content: "Prefers Neovim for editing", source: "preference" },
			]);
			const recalled = await beam.recall("Neovim editing", 5);
			expect(recalled.some(row => row.id === id && row.tier === "working")).toBe(true);
		} finally {
			beam.close();
		}
	});

	it("rememberBatch performs always-on enrichment for every row and keeps per-row source annotations", () => {
		const db = tempDb();
		const beam = new BeamMemory({ sessionId: "batch-enrichment", dbPath: db.path });
		try {
			const ids = beam.rememberBatch([
				{ content: "Alice deployed the service", source: "document" },
				{ content: "Bob filed a bug", source: "conversation" },
				{ content: "Carol approved the plan", source: "email" },
			]);
			expect(ids).toHaveLength(3);
			const documentId = ids[0];
			const emailId = ids[2];
			if (documentId === undefined || emailId === undefined) {
				throw new Error("rememberBatch did not return expected IDs");
			}
			for (const id of ids) {
				const kinds = (
					beam.db.query("SELECT kind FROM annotations WHERE memory_id = ? ORDER BY kind").all(id) as {
						kind: string;
					}[]
				).map(row => row.kind);
				expect(kinds).toContain("occurred_on");
			}
			const sourceRows = beam.db
				.query("SELECT memory_id, value FROM annotations WHERE kind = 'has_source' ORDER BY value")
				.all() as { memory_id: string; value: string }[];
			expect(sourceRows).toEqual([
				{ memory_id: documentId, value: "document" },
				{ memory_id: emailId, value: "email" },
			]);
		} finally {
			beam.close();
		}
	});

	it("rememberBatch threads veracity into storage and recall scoring", async () => {
		const db = tempDb();
		const beam = new BeamMemory({ sessionId: "veracity", dbPath: db.path });
		try {
			const token = "veraxxxordtest";
			for (const label of ["stated", "unknown", "inferred", "imported", "tool"] as const) {
				beam.rememberBatch([{ content: `${token} ${label} tagged content`, source: "test" }], {
					veracity: label,
				});
			}
			const results = await beam.recall(token, 20);
			const scores = new Map(results.map(row => [row.veracity, row.score ?? 0]));
			expect([...scores.keys()].sort()).toEqual(["imported", "inferred", "stated", "tool", "unknown"]);
			expect(scores.get("stated") ?? 0).toBeGreaterThan(scores.get("unknown") ?? 0);
			expect(scores.get("unknown") ?? 0).toBeGreaterThan(scores.get("inferred") ?? 0);
			expect(scores.get("inferred") ?? 0).toBeGreaterThan(scores.get("imported") ?? 0);
			expect(scores.get("imported") ?? 0).toBeGreaterThan(scores.get("tool") ?? 0);
		} finally {
			beam.close();
		}
	});
});
