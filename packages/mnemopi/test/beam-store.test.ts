import { afterEach, describe, expect, it } from "bun:test";
import { recallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import {
	exportToDict,
	forgetWorking,
	get,
	getContext,
	getGlobalWorkingStats,
	getWorkingStats,
	importFromDict,
	invalidate,
	remember,
	rememberBatch,
	scratchpadClear,
	scratchpadRead,
	scratchpadWrite,
	updateWorking,
} from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamEvent, BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { EpisodicGraph } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const states: BeamMemoryState[] = [];

function makeState(sessionId = "session-a", events: BeamEvent[] = []): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: event => {
			events.push(event);
		},
		pluginManager: {
			emit: event => {
				events.push({ ...event, type: `plugin:${event.type}` });
			},
		},
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

describe("beam store free functions", () => {
	it("remembers one item, deduplicates exact content, emits events, and keeps FTS in sync", () => {
		const events: BeamEvent[] = [];
		const beam = makeState("session-a", events);

		const id = remember(beam, "User prefers terse answers", {
			source: "conversation",
			importance: 0.8,
			metadata: { topic: "style" },
			veracity: "stated",
		});
		const duplicate = remember(beam, "User prefers terse answers", {
			importance: 0.9,
			veracity: "unknown",
		});

		expect(duplicate).toBe(id);
		expect(events.map(event => event.type)).toEqual([
			"MEMORY_ADDED",
			"plugin:MEMORY_ADDED",
			"MEMORY_UPDATED",
			"plugin:MEMORY_UPDATED",
		]);
		const row = get(beam, id);
		expect(row?.memory_store).toBe("working");
		expect(row?.content).toBe("User prefers terse answers");
		expect(row?.importance).toBe(0.9);
		expect(row?.veracity).toBe("stated");

		const ftsRows = beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("terse") as {
			id: string;
		}[];
		expect(ftsRows.map(row => row.id)).toEqual([id]);
	});

	it("batch remembers items and returns context ordered by global scope, importance, then recency", () => {
		const beam = makeState();
		// Timestamps must stay inside the 24h working-memory TTL or trimWorkingMemory
		// drops them, so anchor them to "now" rather than a fixed (and eventually
		// stale) calendar date. Order: low-priority oldest, global, high newest.
		const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
		const ids = rememberBatch(
			beam,
			[
				{ content: "Local low priority", importance: 0.1, timestamp: minutesAgo(3) },
				{
					content: "Global rule always include",
					importance: 0.2,
					scope: "global",
					timestamp: minutesAgo(2),
				},
				{ content: "Local high priority", importance: 0.9, timestamp: minutesAgo(1) },
			],
			{ veracity: "imported" },
		);
		expect(rememberBatch).toBe(rememberBatch);

		expect(ids).toHaveLength(3);
		expect(getContext(beam, 3).map(row => row.content)).toEqual([
			"Global rule always include",
			"Local high priority",
			"Local low priority",
		]);
		expect(getWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
		expect(getGlobalWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
	});

	it("updates, invalidates, gets episodic fallback, forgets with authorized annotation cascade, and reports scoped stats", () => {
		const beam = makeState();
		const id = remember(beam, "Old wording", { importance: 0.2 });
		beam.db.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'mentions', 'Alice')").run(id);
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, veracity) VALUES (?, ?, 'sleep', ?, ?, 0.7, '{}', 'unknown')",
			)
			.run("episodic-1", "Episodic fallback", "2026-05-30T00:00:00.000Z", beam.sessionId);

		expect(updateWorking(beam, id, "New wording", 0.6)).toBe(true);
		expect(get(beam, id)?.content).toBe("New wording");
		expect(
			(
				beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("New") as {
					id: string;
				}[]
			).map(row => row.id),
		).toEqual([id]);
		expect(get(beam, "episodic-1")?.memory_store).toBe("episodic");
		expect(getWorkingStats(beam, "author-a", "user", "channel-a")).toMatchObject({ total: 1 });
		expect(invalidate(beam, id, "replacement-1")).toBe(true);
		expect(getContext(beam, 10).some(row => row.id === id)).toBe(false);
		expect(forgetWorking(beam, id)).toBe(true);
		expect(get(beam, id)).toBeNull();
		expect(beam.db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE memory_id = ?").get(id)).toEqual({
			count: 0,
		});
		expect(forgetWorking(beam, id)).toBe(false);
	});

	it("keeps scratchpad scoped to the active session", () => {
		const first = makeState("session-a");
		const second = makeState("session-b");
		const firstId = scratchpadWrite(first, "draft note");
		scratchpadWrite(second, "other session note");

		expect(firstId).toHaveLength(16);
		expect(scratchpadRead(first).map(row => row.content)).toEqual(["draft note"]);
		scratchpadClear(first);
		expect(scratchpadRead(first)).toEqual([]);
		expect(scratchpadRead(second).map(row => row.content)).toEqual(["other session note"]);
	});

	it("exports and imports working memory, episodic memory, scratchpad, and consolidation log idempotently", () => {
		const source = makeState("source-session");
		const id = remember(source, "Exported working memory", { veracity: "tool", importance: 0.75 });
		scratchpadWrite(source, "portable scratch");
		source.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, summary_of) VALUES ('episode-1', 'Exported episode', 'sleep', '2026-05-30T00:00:00.000Z', 'source-session', 0.6, '{}', ?)",
			)
			.run(id);
		source.db
			.prepare(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES ('source-session', 1, 'Exported', '2026-05-30T00:00:00.000Z')",
			)
			.run();

		const exported = exportToDict(source);
		expect(exported.working_memory as unknown[]).toHaveLength(1);
		expect(exported.scratchpad as unknown[]).toHaveLength(1);

		const dest = makeState("dest-session");
		expect(importFromDict(dest, exported)).toEqual({
			working_memory: { inserted: 1, skipped: 0, overwritten: 0 },
			episodic_memory: { inserted: 1, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
			scratchpad: { inserted: 1, updated: 0 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported)).toMatchObject({
			working_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			episodic_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			scratchpad: { inserted: 0, updated: 1 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported, true)).toMatchObject({
			working_memory: { inserted: 0, skipped: 0, overwritten: 1 },
			episodic_memory: { inserted: 0, skipped: 0, overwritten: 1 },
		});
		expect(get(dest, id)?.content).toBe("Exported working memory");
		expect(dest.db.prepare("SELECT COUNT(*) AS count FROM scratchpad").get()).toEqual({ count: 1 });
		expect(scratchpadRead(dest).map(row => row.content)).toEqual([]);
	});

	it("keeps byte-identical rows distinct when the caller supplies explicit ids", () => {
		// Retention chunking motivates this: two chunks of one oversized message can be
		// byte-identical (a long repeated payload) and are distinguished only by chunk_index and
		// ranges. Content dedupe collapsed them -- the later chunk UPDATED the earlier row, so only
		// the first chunk's metadata survived and exact reconstruction became impossible.
		const beam = makeState("explicit-ids");
		const content = "[role: user]\nrepeated payload\n[user:end]";
		const first = remember(beam, content, { memoryId: "chunk-a", metadata: { chunk_index: 0 } });
		const second = remember(beam, content, { memoryId: "chunk-b", metadata: { chunk_index: 1 } });
		expect(first).toBe("chunk-a");
		expect(second).toBe("chunk-b");
		const rows = beam.db
			.prepare("SELECT id, json_extract(metadata_json,'$.chunk_index') AS idx FROM working_memory ORDER BY id")
			.all() as { id: string; idx: number }[];
		expect(rows.map(row => row.id)).toEqual(["chunk-a", "chunk-b"]);
		expect(rows.map(row => row.idx)).toEqual([0, 1]);
	});

	it("refreshes metadata when the same explicit id is stored again with the same content", () => {
		// An explicit id must dedupe against ITSELF so a retention rerun or a re-migration updates
		// its row instead of inserting a copy. The update must rewrite metadata_json: for a chunk the
		// ranges ARE the payload, so skipping them would leave a row whose recorded position no
		// longer matches its content.
		const beam = makeState("explicit-ids-idempotent");
		const content = "chunk body that does not change";
		remember(beam, content, { memoryId: "chunk-x", metadata: { chunk_index: 0, ranges: [{ start: 0 }] } });
		remember(beam, content, { memoryId: "chunk-x", metadata: { chunk_index: 4, ranges: [{ start: 9 }] } });
		const rows = beam.db.prepare("SELECT id, content, metadata_json FROM working_memory").all() as {
			id: string;
			content: string;
			metadata_json: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content).toBe(content);
		const meta = JSON.parse(rows[0]?.metadata_json ?? "{}") as {
			chunk_index: number;
			ranges: { start: number }[];
		};
		expect(meta.chunk_index).toBe(4);
		expect(meta.ranges[0]?.start).toBe(9);
	});

	it("refuses to rewrite the content stored under an existing explicit id", () => {
		// Embeddings, extracted facts, annotations and episodic gists were all derived from the
		// row's content, and scheduleEmbedding only re-runs when embed_text differs from content.
		// Rewriting content in place would strand all of it, so the store refuses rather than
		// half-applying. Callers deriving the id from content (both chunk paths, via stableMemoryId)
		// get a fresh id when content changes and never reach this.
		const beam = makeState("explicit-ids-content-change");
		remember(beam, "original body", { memoryId: "chunk-z" });
		expect(() => remember(beam, "different body", { memoryId: "chunk-z" })).toThrow(/different content/);
		const row = beam.db.prepare("SELECT content FROM working_memory WHERE id = 'chunk-z'").get() as {
			content: string;
		};
		expect(row.content).toBe("original body");
	});

	it("refuses an explicit id that already belongs to another session", () => {
		// `id` is a global PRIMARY KEY, so without this check a cross-session id would fall through
		// to an INSERT and surface as a raw SQLite constraint error.
		const beam = makeState("session-one");
		remember(beam, "shared body", { memoryId: "chunk-shared" });
		const collided = { ...beam, sessionId: "session-two" } as typeof beam;
		expect(() => remember(collided, "shared body", { memoryId: "chunk-shared" })).toThrow(
			/already exists in session/,
		);
	});

	it("leaves stored metadata alone when an explicit-id update supplies none", () => {
		// COALESCE semantics: a caller updating without metadata must not wipe what is stored.
		const beam = makeState("explicit-ids-keep-meta");
		const content = "stable chunk body";
		remember(beam, content, { memoryId: "chunk-y", metadata: { chunk_index: 7 } });
		remember(beam, content, { memoryId: "chunk-y" });
		const row = beam.db
			.prepare("SELECT json_extract(metadata_json,'$.chunk_index') AS idx FROM working_memory WHERE id = 'chunk-y'")
			.get() as { idx: number | null };
		expect(row.idx).toBe(7);
	});

	it("does not rewrite metadata on the implicit content-dedupe path", () => {
		// Regression guard for the fix itself: adding metadata_json to the shared UPDATE must not
		// change behaviour for callers that never supplied an id.
		const beam = makeState("implicit-keeps-meta");
		remember(beam, "same words", { metadata: { origin: "first" } });
		remember(beam, "same words", { metadata: { origin: "second" } });
		const row = beam.db
			.prepare("SELECT json_extract(metadata_json,'$.origin') AS origin FROM working_memory")
			.get() as { origin: string };
		expect(row.origin).toBe("first");
	});

	it("still dedupes by content when no explicit id is given", () => {
		// Unchanged behaviour for callers that do not track identity.
		const beam = makeState("implicit-dedupe");
		const a = remember(beam, "same words", { source: "conversation" });
		const b = remember(beam, "same words", { source: "conversation" });
		expect(a).toBe(b);
		expect(beam.db.prepare("SELECT COUNT(*) AS c FROM working_memory").get()).toEqual({ c: 1 });
	});

	it("keeps restored durable rows and cascades linked artifacts on trim, force-import, and forget (issue #4819)", () => {
		const beam = makeState("trim-4819");
		// EpisodicGraph owns the `gists` / `graph_edges` schema; init it so the
		// cascade can be exercised end to end on the shared connection.
		new EpisodicGraph({ db: beam.db, dbPath: ":memory:" });
		const oldTimestamp = new Date(Date.now() - 1000 * 3_600_000).toISOString();
		const countOf = (sql: string, ...params: (string | number | null)[]): number => {
			const row = beam.db.prepare(sql).get(...params) as { count: number };
			return row.count;
		};
		const seedArtifacts = (memoryId: string): void => {
			beam.db
				.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'mentions', 'Alice')")
				.run(memoryId);
			beam.db
				.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[0.1]', 't')")
				.run(memoryId);
			beam.db
				.prepare(
					"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES (?, 'trim-4819', 'Alice', 'is', 'User', ?)",
				)
				.run(`fact-${memoryId}`, memoryId);
			beam.db
				.prepare(
					"INSERT INTO memoria_facts (session_id, fact_type, key, value, source_memory_id) VALUES ('trim-4819', 'name', 'name', 'Alice', ?)",
				)
				.run(memoryId);
			beam.db
				.prepare("INSERT INTO gists (id, text, memory_id) VALUES (?, 'g', ?)")
				.run(`gist_${memoryId}`, memoryId);
			beam.db
				.prepare("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, 'ctx')")
				.run(memoryId, `gist_${memoryId}`);
			beam.db
				.prepare("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, 'rel')")
				.run(`gist_${memoryId}`, `fact-${memoryId}`);
		};
		const artifactCount = (memoryId: string): number =>
			countOf("SELECT COUNT(*) AS count FROM annotations WHERE memory_id = ?", memoryId) +
			countOf("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?", memoryId) +
			countOf("SELECT COUNT(*) AS count FROM facts WHERE source_msg_id = ?", memoryId) +
			countOf("SELECT COUNT(*) AS count FROM memoria_facts WHERE source_memory_id = ?", memoryId) +
			countOf("SELECT COUNT(*) AS count FROM gists WHERE memory_id = ?", memoryId) +
			countOf(
				"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? OR target = ? OR source = ? OR target = ?",
				memoryId,
				memoryId,
				`gist_${memoryId}`,
				`gist_${memoryId}`,
			);

		// (1) Restored durable row: old timestamp, consolidated_at NULL, IMPORTED tier.
		const durableId = "restored-durable";
		beam.db
			.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, trust_tier, consolidated_at) VALUES (?, 'canonical fact', 'backup', ?, 'trim-4819', 0.9, 'IMPORTED', NULL)",
			)
			.run(durableId, oldTimestamp);
		seedArtifacts(durableId);

		// (2) Un-consolidated scratch row: old timestamp, consolidated_at NULL,
		// STATED tier (no IMPORTED exemption). D7: the TTL/overflow trim only
		// ever reclaims rows that ARE consolidated, so this row must survive
		// purely because `sleep()` has not promoted it yet.
		const unconsolidatedId = "unconsolidated-scratch";
		beam.db
			.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, trust_tier, consolidated_at) VALUES (?, 'idle chatter', 'conversation', ?, 'trim-4819', 0.2, 'STATED', NULL)",
			)
			.run(unconsolidatedId, oldTimestamp);
		seedArtifacts(unconsolidatedId);

		// (3) Already-consolidated old row: past TTL, STATED tier, consolidated_at
		// set. This is the only shape the TTL/overflow trim may still reclaim.
		const consolidatedOldId = "consolidated-old";
		beam.db
			.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, trust_tier, consolidated_at) VALUES (?, 'already promoted', 'conversation', ?, 'trim-4819', 0.2, 'STATED', ?)",
			)
			.run(consolidatedOldId, oldTimestamp, oldTimestamp);
		seedArtifacts(consolidatedOldId);

		// A normal write triggers the automatic trim.
		remember(beam, "a fresh conversational note", { source: "conversation" });

		// Durable row survives with all artifacts intact.
		expect(get(beam, durableId)?.content).toBe("canonical fact");
		expect(artifactCount(durableId)).toBe(7);

		// Un-consolidated row survives too: trim never deletes un-promoted memory.
		expect(get(beam, unconsolidatedId)?.content).toBe("idle chatter");
		expect(artifactCount(unconsolidatedId)).toBe(7);

		// Already-consolidated old row is trimmed and every linked artifact cascades.
		expect(countOf("SELECT COUNT(*) AS count FROM working_memory WHERE id = ?", consolidatedOldId)).toBe(0);
		expect(artifactCount(consolidatedOldId)).toBe(0);

		// (4) forgetWorking cascades every linked artifact, not just annotations.
		expect(forgetWorking(beam, durableId)).toBe(true);
		expect(artifactCount(durableId)).toBe(0);
	});

	it("leaves imported un-consolidated working memory NULL so restored banks survive trim (issue #4819, D7)", () => {
		const dest = makeState("import-4819");
		const oldTimestamp = new Date(Date.now() - 1000 * 3_600_000).toISOString();
		importFromDict(
			dest,
			{
				working_memory: [
					{
						id: "restored-import",
						content: "durable restored fact",
						timestamp: oldTimestamp,
						session_id: "import-4819",
						trust_tier: "STATED",
						consolidated_at: null,
					},
				],
			},
			true,
		);
		const importedRow = dest.db
			.prepare("SELECT consolidated_at FROM working_memory WHERE id = 'restored-import'")
			.get() as { consolidated_at: string | null };
		// D7: trim now only reclaims rows that ARE consolidated, so protection
		// comes from staying NULL — which also leaves the row free to actually
		// promote via `sleep()` later — rather than from a fake "already
		// consolidated" stamp that would otherwise make it immediately eligible
		// for deletion.
		expect(importedRow.consolidated_at).toBeNull();

		remember(dest, "a fresh note", { source: "conversation" });
		expect(get(dest, "restored-import")?.content).toBe("durable restored fact");
	});

	it("force-import overwrite cleans stale linked artifacts of the replaced row (issue #4819)", () => {
		const dest = makeState("import-overwrite-4819");
		const id = "overwrite-me";
		dest.db
			.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, trust_tier) VALUES (?, 'stale', 'backup', '2020-01-01T00:00:00.000Z', 'import-overwrite-4819', 0.5, 'IMPORTED')",
			)
			.run(id);
		dest.db.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'mentions', 'Stale')").run(id);
		dest.db
			.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[0.9]', 'old')")
			.run(id);
		dest.db
			.prepare(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES ('stale-fact', 'import-overwrite-4819', 'a', 'is', 'b', ?)",
			)
			.run(id);

		importFromDict(
			dest,
			{
				working_memory: [
					{ id, content: "fresh replacement", session_id: "import-overwrite-4819", trust_tier: "IMPORTED" },
				],
			},
			true,
		);

		expect(get(dest, id)?.content).toBe("fresh replacement");
		const staleArtifacts =
			(
				dest.db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE memory_id = ?").get(id) as {
					count: number;
				}
			).count +
			(
				dest.db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(id) as {
					count: number;
				}
			).count +
			(
				dest.db.prepare("SELECT COUNT(*) AS count FROM facts WHERE source_msg_id = ?").get(id) as {
					count: number;
				}
			).count;
		expect(staleArtifacts).toBe(0);
	});
});

describe("fact-id read path (issue #4725)", () => {
	function insertFact(
		beam: BeamMemoryState,
		factId: string,
		sessionId: string,
		subject: string,
		predicate: string,
		object: string,
		confidence = 0.9,
	): void {
		beam.db
			.prepare(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(factId, sessionId, subject, predicate, object, "2026-05-30T00:00:00.000Z", confidence);
	}

	it("resolves an id surfaced by fact recall to a read-only fact row", async () => {
		const beam = makeState();
		insertFact(beam, "fact-postgres", beam.sessionId, "service", "uses", "postgres database", 0.91);

		const results = await recallEnhanced(beam, "postgres", 5, { includeFacts: true });
		const surfaced = results.find(result => result.source === "facts");
		expect(surfaced?.id).toBe("fact-postgres");

		// memory://<id> reads and memory_edit both resolve ids via get(); a
		// surfaced fact id must not be a dead end.
		const row = get(beam, "fact-postgres");
		expect(row).toMatchObject({
			id: "fact-postgres",
			content: "service uses postgres database",
			source: "facts",
			importance: 0.91,
			session_id: beam.sessionId,
			memory_store: "fact",
		});
		expect(JSON.parse(String(row?.metadata))).toMatchObject({
			subject: "service",
			predicate: "uses",
			object: "postgres database",
		});
	});

	it("keeps fact reads session-scoped like fact recall, honoring explicit global scope", () => {
		const beam = makeState();
		insertFact(beam, "fact-other", "session-other", "service", "uses", "postgres database");
		expect(get(beam, "fact-other")).toBeNull();

		beam.db.run("ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT 'session'");
		beam.db.run("UPDATE facts SET scope = 'global' WHERE fact_id = 'fact-other'");
		expect(get(beam, "fact-other")?.memory_store).toBe("fact");
	});

	it("keeps working rows first on id collision and never deletes facts via forgetWorking", () => {
		const beam = makeState();
		insertFact(beam, "shared-id", beam.sessionId, "service", "uses", "postgres database");
		const workingId = remember(beam, "working row shadowing a fact id");
		beam.db.prepare("UPDATE working_memory SET id = ? WHERE id = ?").run("shared-id", workingId);

		expect(get(beam, "shared-id")?.memory_store).toBe("working");

		expect(forgetWorking(beam, "fact-missing")).toBe(false);
		expect(forgetWorking(beam, "shared-id")).toBe(true);
		expect(get(beam, "shared-id")?.memory_store).toBe("fact");
	});
});
