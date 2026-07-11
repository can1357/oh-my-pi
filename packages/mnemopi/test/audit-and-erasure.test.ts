import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMemoryAudit } from "../src/core/audit-log";
import { Mnemopi } from "../src/core/memory";

describe("memory governance (U14)", () => {
	let db: Database;
	let memory: Mnemopi;

	beforeEach(() => {
		db = new Database(":memory:");
		memory = new Mnemopi({ db, sessionId: "audit-test", bank: "default" });
	});

	afterEach(() => {
		memory.close();
		db.close();
	});

	test("every facade memory op lands in the audit log", async () => {
		const id = memory.remember("the API gateway lives at src/gateway.ts", { source: "test" });
		expect(id).toBeTruthy();
		await memory.recall("gateway", 5);
		memory.get(id);
		memory.update(id, "the API gateway moved to src/net/gateway.ts");
		memory.forget(id);

		const ops = readMemoryAudit(db).map(row => row.op);
		expect(ops).toContain("remember");
		expect(ops).toContain("recall");
		expect(ops).toContain("get");
		expect(ops).toContain("update");
		expect(ops).toContain("forget");
		// Point ops carry the memory id for traceability.
		const forgetRow = readMemoryAudit(db, { op: "forget" })[0];
		expect(forgetRow?.memory_id).toBe(id);
	});

	test("erasure cascades to embeddings and extraction derivatives", () => {
		const id = memory.remember("secret deployment key rotates on Tuesdays", { source: "test" });

		// Simulate derivatives the pipelines would have produced for this memory.
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			id,
			JSON.stringify([0.1, 0.2]),
			"test-model",
		);
		db.prepare(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES (?, ?, ?, ?, ?, ?)",
		).run("fact-1", "audit-test", "deployment key", "rotates", "Tuesdays", id);
		db.prepare(
			"INSERT INTO episodic_memory (id, content, summary_of) VALUES (?, ?, ?)",
		).run("epi-1", "summary mentioning the secret rotation", JSON.stringify([id]));

		expect(memory.forget(id)).toBe(true);

		const count = (sql: string, param: string): number =>
			(db.prepare(sql).get(param) as { n: number }).n;
		expect(count("SELECT COUNT(*) n FROM working_memory WHERE id = ?", id)).toBe(0);
		expect(count("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id = ?", id)).toBe(0);
		expect(count("SELECT COUNT(*) n FROM facts WHERE source_msg_id = ?", id)).toBe(0);
		expect(count("SELECT COUNT(*) n FROM episodic_memory WHERE summary_of LIKE '%' || ? || '%'", id)).toBe(0);
	});

	test("audit failures never break the operation", () => {
		// Drop the audit table and make the name collide with a view to force
		// insert failures; remember must still succeed.
		db.run("DROP TABLE IF EXISTS memory_audit_log");
		db.run("CREATE VIEW memory_audit_log AS SELECT 1 AS x");
		const id = memory.remember("still works", { source: "test" });
		expect(id).toBeTruthy();
	});
});
