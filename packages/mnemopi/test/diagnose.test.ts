import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { type DiagnosticSummary, inspectDatabase, runDiagnostics } from "@oh-my-pi/pi-mnemopi/diagnose";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "mnemopi-ts-diagnose-"));
}

function status(summary: DiagnosticSummary, check: string): string | undefined {
	return summary.entries.find(entry => entry.check === check)?.status;
}

function detail(summary: DiagnosticSummary, check: string): string | undefined {
	return summary.entries.find(entry => entry.check === check)?.detail;
}

describe("diagnose helpers", () => {
	it("initializes and inspects Beam schema on a temporary DB", () => {
		const root = tempRoot();
		try {
			const dbPath = join(root, "mnemopi.db");
			const memory = new BeamMemory({ dbPath });
			try {
				const id = memory.remember("Diagnose working row", { source: "test" });
				memory.consolidateToEpisodic("Diagnose episodic row", [id], "test", 0.6);
				memory.scratchpadWrite("diagnose scratchpad row");
				memory.db.run("INSERT INTO triples (subject, predicate, object, source) VALUES (?, ?, ?, ?)", [
					"alice",
					"uses",
					"beam",
					"test",
				]);
			} finally {
				memory.close();
			}

			const summary = runDiagnostics({ dbPath, dataDir: root });
			expect(summary.database).toBe(dbPath);
			expect(summary.checks_failed).toBe(0);
			expect(status(summary, "integrity_check")).toBe("OK");
			expect(status(summary, "table:working_memory")).toBe("OK");
			expect(status(summary, "table:episodic_memory")).toBe("OK");
			expect(status(summary, "table:triples")).toBe("OK");
			expect(status(summary, "columns:working_memory")).toBe("OK");
			expect(status(summary, "working_memory_count")).toBe("1");
			expect(status(summary, "episodic_memory_count")).toBe("1");
			expect(status(summary, "scratchpad_count")).toBe("1");
			expect(status(summary, "triples_count")).toBe("1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports missing schema on an in-memory DB when initialization is disabled", () => {
		const db = new Database(":memory:");
		try {
			const summary = inspectDatabase({ db, dbPath: ":memory:", initialize: false });
			expect(summary.checks_failed).toBeGreaterThan(0);
			expect(status(summary, "integrity_check")).toBe("OK");
			expect(status(summary, "table:working_memory")).toBe("MISSING");
			expect(status(summary, "working_memory_count")).toBe("MISSING");
			expect(summary.key_findings).toContain("table:working_memory missing");
		} finally {
			db.close();
		}
	});

	it("detects incomplete required columns without reading memory content", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
			const summary = inspectDatabase({ db, dbPath: ":memory:", initialize: false });
			expect(status(summary, "columns:working_memory")).toBe("MISSING");
			expect(detail(summary, "columns:working_memory") ?? "").toContain("source");
			expect(summary.entries.some(entry => entry.detail?.includes("Diagnose working row"))).toBe(false);
		} finally {
			db.close();
		}
	});
});
