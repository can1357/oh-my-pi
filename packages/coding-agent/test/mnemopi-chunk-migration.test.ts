import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRetentionTranscript } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import * as stateModule from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { EpisodicGraph } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";

type MigrationReceipt = {
	readonly dryRun: boolean;
	readonly candidates: number;
	readonly migrated: number;
	readonly skipped: number;
	readonly children: number;
	readonly lowConfidenceEdges: number;
	readonly lowConfidenceReferences: number;
	readonly pendingEmbeddings: number;
};

type MigrationOptions = {
	readonly dbPath: string;
	readonly maxChars: number;
	readonly dryRun?: boolean;
};

type Migrate = (options: MigrationOptions) => MigrationReceipt;
type Validate = (
	dbPath: string,
	sourceId: string,
) => {
	readonly valid: boolean;
	readonly sourceHash: string;
	readonly reconstructedHash: string;
	readonly orphanReferences: number;
};

const roots: string[] = [];

function migrationFns(): { migrate: Migrate; validate: Validate } {
	const exports = stateModule as unknown as {
		migrateWorkingMemoryChunks?: unknown;
		validateWorkingMemoryChunkMigration?: unknown;
	};
	expect(typeof exports.migrateWorkingMemoryChunks).toBe("function");
	expect(typeof exports.validateWorkingMemoryChunkMigration).toBe("function");
	if (typeof exports.migrateWorkingMemoryChunks !== "function") throw new Error("migration is not implemented");
	if (typeof exports.validateWorkingMemoryChunkMigration !== "function")
		throw new Error("validator is not implemented");
	return {
		migrate: exports.migrateWorkingMemoryChunks as Migrate,
		validate: exports.validateWorkingMemoryChunkMigration as Validate,
	};
}

function seedDb(): { dbPath: string; sourceId: string; originalContent: string } {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-chunks-"));
	roots.push(root);
	const dbPath = join(root, "mnemopi.db");
	const db = new Database(dbPath);
	initBeam(db);
	void new EpisodicGraph({ db, dbPath });
	const sourceId = "oversized-source";
	const originalContent = prepareRetentionTranscript(
		[
			{ role: "user", content: `first question ${"a".repeat(90)}` },
			{ role: "assistant", content: `first answer ${"b".repeat(90)}` },
			{ role: "user", content: `second question: Alpha uses Beta ${"c".repeat(90)}` },
			{ role: "assistant", content: `second answer ${"d".repeat(90)}` },
		],
		true,
	).transcript;
	if (originalContent === null) throw new Error("expected transcript");
	db.run(
		`INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, scope,
			 veracity, memory_type, consolidated_at, author_id, author_type, channel_id, trust_tier, created_at)
		 VALUES (?, ?, ?, 'coding-agent-transcript', '2026-08-24T00:00:00.000Z', 'bank-a', 0.65,
			 ?, 'bank', 'unknown', 'episode', NULL, 'coding-agent', 'agent', 'bank-a', 'private',
			 '2026-08-24T00:00:00.000Z')`,
		[
			sourceId,
			originalContent,
			"first question first answer second question second answer",
			JSON.stringify({ session_id: "session-a", source_id: "source-a", retained_through_user_turn: 2 }),
		],
	);
	db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 'test')", [sourceId]);
	db.run("INSERT INTO annotations (memory_id, kind, value, source) VALUES (?, 'mentions', 'Alpha', 'test')", [
		sourceId,
	]);
	db.run(
		`INSERT INTO working_memory
			(id,content,source,timestamp,session_id,importance,metadata_json,scope,veracity,memory_type,created_at)
		 VALUES ('other-node','Alpha uses Beta external context','test','2026-08-24T00:00:00.000Z',
		         'bank-a',0.5,'{}','global','unknown','general','2026-08-24T00:00:00.000Z')`,
	);
	db.run(
		"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES ('fact-1','bank-a','Alpha','uses','Beta',?)",
		[sourceId],
	);
	db.run(
		"INSERT INTO memoria_facts (session_id, fact_type, key, value, source_memory_id) VALUES ('bank-a','fact','alpha','beta',?)",
		[sourceId],
	);
	db.run("INSERT INTO gists (id, text, memory_id) VALUES ('gist-source','Alpha uses Beta summary',?)", [sourceId]);
	db.run(
		"INSERT INTO memoria_facts (session_id, fact_type, key, value, source_memory_id) VALUES ('bank-a','fact','inferred','unrelated external inference',?)",
		[sourceId],
	);
	db.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, 'other-node', 'ctx')", [sourceId]);
	db.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, 'opaque-node', 'ctx')", [sourceId]);
	db.close();
	return { dbPath, sourceId, originalContent };
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("working-memory transcript chunk migration", () => {
	it("dry-runs without creating schema or changing any row", () => {
		const { dbPath, sourceId, originalContent } = seedDb();
		const before = new Database(dbPath).serialize();

		const receipt = migrationFns().migrate({ dbPath, maxChars: 180, dryRun: true });

		expect(receipt).toMatchObject({ dryRun: true, candidates: 1, migrated: 0, children: 0 });
		const db = new Database(dbPath);
		expect(db.query("SELECT content, superseded_by FROM working_memory WHERE id = ?").get(sourceId)).toEqual({
			content: originalContent,
			superseded_by: null,
		});
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name='working_memory_chunk_migrations'").get()).toBeNull();
		expect(db.serialize()).toEqual(before);
		db.close();
	});

	it("preserves the parent, creates bounded deterministic children, maps references, and is idempotent", () => {
		const { dbPath, sourceId, originalContent } = seedDb();
		const { migrate, validate } = migrationFns();

		const first = migrate({ dbPath, maxChars: 180 });
		expect(first.lowConfidenceEdges).toBe(1);
		expect(first.lowConfidenceReferences).toBe(1);
		expect(first.candidates).toBe(1);
		expect(first.migrated).toBe(1);
		expect(first.children).toBeGreaterThan(1);
		expect(first.pendingEmbeddings).toBe(first.children);

		const db = new Database(dbPath);
		const parent = db
			.query<{ content: string; superseded_by: string | null }, [string]>(
				"SELECT content, superseded_by FROM working_memory WHERE id = ?",
			)
			.get(sourceId);
		expect(parent?.content).toBe(originalContent);
		const children = db
			.query<{ id: string; content: string; embed_text: string | null; metadata_json: string }, [string]>(
				"SELECT id, content, embed_text, metadata_json FROM working_memory WHERE json_extract(metadata_json,'$.chunk_of') = ? ORDER BY CAST(json_extract(metadata_json,'$.chunk_index') AS INTEGER)",
			)
			.all(sourceId);
		expect(children).toHaveLength(first.children);
		expect(children.every(row => row.content.length <= 180)).toBe(true);
		expect(children.every(row => row.embed_text !== null && row.embed_text.length < originalContent.length)).toBe(
			true,
		);
		expect(children.every(row => !row.embed_text?.includes("[role:"))).toBe(true);
		expect(new Set(children.map(row => row.embed_text)).size).toBeGreaterThan(1);
		expect(new Set(children.map(row => row.id)).size).toBe(children.length);
		const canonical = children[0]?.id;
		const evidenceChild = children.find(row => row.content.includes("Alpha uses Beta"))?.id;
		if (canonical === undefined || evidenceChild === undefined)
			throw new Error("expected canonical and evidence child");
		expect(parent?.superseded_by).toBe(canonical);
		expect(db.query<{ memory_id: string }, []>("SELECT memory_id FROM annotations").get()?.memory_id).toBe(
			evidenceChild,
		);
		expect(db.query<{ source_msg_id: string }, []>("SELECT source_msg_id FROM facts").get()?.source_msg_id).toBe(
			evidenceChild,
		);
		expect(
			db
				.query<{ source_memory_id: string }, []>("SELECT source_memory_id FROM memoria_facts WHERE key='alpha'")
				.get()?.source_memory_id,
		).toBe(evidenceChild);
		expect(
			db
				.query<{ source_memory_id: string | null }, []>(
					"SELECT source_memory_id FROM memoria_facts WHERE key='inferred'",
				)
				.get()?.source_memory_id,
		).toBeNull();
		expect(
			db
				.query<{ confidence: string }, []>(
					"SELECT confidence FROM working_memory_chunk_reference_mappings WHERE table_name='memoria_facts' AND original_rowid=(SELECT rowid FROM memoria_facts WHERE key='inferred')",
				)
				.get()?.confidence,
		).toBe("low");
		const edges = db
			.query<{ source: string; target: string; edge_type: string }, []>(
				"SELECT source,target,edge_type FROM graph_edges ORDER BY source,target",
			)
			.all();
		expect(edges).toContainEqual({ source: evidenceChild, target: "other-node", edge_type: "ctx" });
		expect(edges.some(edge => edge.source === sourceId || edge.target === sourceId)).toBe(false);
		expect(edges.some(edge => edge.source === canonical && edge.target === "opaque-node")).toBe(false);
		expect(edges).toHaveLength(1);
		const mappingRows = db
			.query<{ confidence: string; original_target: string; score: number; margin: number }, []>(
				"SELECT confidence,original_target,score,margin FROM working_memory_chunk_edge_mappings ORDER BY original_edge_id",
			)
			.all();
		expect(mappingRows.map(row => row.confidence)).toEqual(["high", "low"]);
		expect(mappingRows.find(row => row.original_target === "other-node")?.margin).toBeGreaterThan(0);
		expect(mappingRows.find(row => row.original_target === "opaque-node")?.score).toBe(0);
		const graph = new EpisodicGraph({ db, dbPath });
		const related = graph.findRelatedMemories(evidenceChild, 2, "ctx", 0).map(item => item.memoryId);
		expect(related).toContain("other-node");
		expect(related).not.toContain(canonical);
		for (const sibling of children.map(row => row.id).filter(id => id !== evidenceChild)) {
			expect(related).not.toContain(sibling);
		}
		expect(db.query("SELECT 1 FROM memory_embeddings WHERE memory_id = ?").get(sourceId)).toBeNull();
		db.close();
		const validation = validate(dbPath, sourceId);
		expect(validation).toMatchObject({ valid: true, orphanReferences: 0 });
		expect(validation.reconstructedHash).toBe(validation.sourceHash);

		const second = migrate({ dbPath, maxChars: 180 });
		expect(second).toMatchObject({ candidates: 0, migrated: 0, skipped: 1, children: 0 });
		const verify = new Database(dbPath);
		expect(
			verify
				.query<{ count: number }, [string]>(
					"SELECT COUNT(*) AS count FROM working_memory WHERE json_extract(metadata_json,'$.chunk_of') = ?",
				)
				.get(sourceId)?.count,
		).toBe(first.children);
		verify.close();
	});

	it("validates against chunk order even when physical row order is scrambled", () => {
		const { dbPath, sourceId } = seedDb();
		const { migrate, validate } = migrationFns();
		// Replace the parent with a transcript whose SINGLE message must split across several
		// chunks: intra-message piece order is the only thing `reconstructRetentionChunks`
		// takes from chunk order, so a multi-chunk message is what makes ordering observable.
		const oversized = prepareRetentionTranscript(
			[{ role: "user", content: Array.from({ length: 40 }, (_, i) => `sentence ${i} of the runbook.`).join(" ") }],
			true,
		).transcript;
		if (oversized === null) throw new Error("expected oversized transcript");
		const seedDbHandle = new Database(dbPath);
		seedDbHandle.run("UPDATE working_memory SET content = ?, embed_text = ? WHERE id = ?", [
			oversized,
			oversized,
			sourceId,
		]);
		seedDbHandle.close();
		migrate({ dbPath, maxChars: 180 });

		const db = new Database(dbPath);
		const rows = db
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM working_memory WHERE json_extract(metadata_json,'$.chunk_of') = ? ORDER BY rowid",
			)
			.all(sourceId);
		expect(rows.length).toBeGreaterThan(1);
		const first = rows[0];
		if (first === undefined) throw new Error("expected children");
		const columns = Object.keys(first);
		db.run("BEGIN");
		db.run("DELETE FROM working_memory WHERE json_extract(metadata_json,'$.chunk_of') = ?", [sourceId]);
		for (const row of [...rows].reverse()) {
			db.run(
				`INSERT INTO working_memory (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				columns.map(column => row[column] as never),
			);
		}
		db.run("COMMIT");
		const physical = db
			.query<{ id: string }, [string]>(
				"SELECT id FROM working_memory WHERE json_extract(metadata_json,'$.chunk_of') = ? ORDER BY rowid",
			)
			.all(sourceId)
			.map(row => row.id);
		expect(physical).toEqual(rows.map(row => row.id as string).reverse());
		db.close();

		const validation = validate(dbPath, sourceId);
		expect(validation.valid).toBe(true);
		expect(validation.reconstructedHash).toBe(validation.sourceHash);
	});
});
