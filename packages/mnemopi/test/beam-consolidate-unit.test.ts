import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	consolidateToEpisodic,
	degradeEpisodic,
	extractAndStoreFacts,
	getConsolidationLog,
	getContaminated,
	getEpisodicStats,
	getMemoriaStats,
	memoriaRetrieve,
	sleep,
	sleepAllSessions,
} from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { REGEX_EXTRACTION_MAX_INPUT_CHARS } from "@oh-my-pi/pi-mnemopi/core/entities";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function state(sessionId = "s1"): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-1",
		authorType: "user",
		channelId: sessionId,
		useCloud: false,
		eventEmitter: undefined,
		pluginManager: null,
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
}

function oldIso(hours = 20): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function insertWorking(db: Database, id: string, sessionId: string, content: string, source = "conversation"): void {
	db.run(
		`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, scope, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, content, source, oldIso(), sessionId, 0.7, "true", "session", oldIso()],
	);
}

const opened: Database[] = [];

function trackedState(sessionId = "s1"): BeamMemoryState {
	const beam = state(sessionId);
	opened.push(beam.db);
	return beam;
}

afterEach(() => {
	while (opened.length > 0) {
		const db = opened.pop();
		if (db !== undefined) closeQuietly(db);
	}
});

describe("beam consolidation free functions", () => {
	it("consolidates working ids into a real episodic row with stats", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "User likes dark mode");

		const id = consolidateToEpisodic(beam, "User likes dark mode", ["wm1"], "consolidation", 0.8, {
			metadata: { reason: "unit" },
			veracity: "true",
		});

		const row = beam.db.query("SELECT * FROM episodic_memory WHERE id = ?").get(id) as Record<string, unknown> | null;
		expect(row).not.toBeNull();
		expect(row?.content).toBe("User likes dark mode");
		expect(row?.summary_of).toBe("wm1");
		expect(row?.session_id).toBe("s1");
		expect(row?.veracity).toBe("true");
		expect(getEpisodicStats(beam).total).toBe(1);
	});

	it("consolidateToEpisodic populates the episodic graph (gists, edges) for the new memory (#2435)", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "Alice deployed the staging cluster checklist");

		const id = consolidateToEpisodic(
			beam,
			"Alice deployed the staging cluster checklist",
			["wm1"],
			"consolidation",
			0.7,
		);

		const gist = beam.db.query("SELECT id, memory_id FROM gists WHERE memory_id = ?").get(id) as {
			id: string;
			memory_id: string;
		} | null;
		expect(gist).not.toBeNull();
		expect(gist?.id).toBe(`gist_${id}`);
		const edges = beam.db
			.query("SELECT source, target, edge_type FROM graph_edges WHERE source = ? OR target = ?")
			.all(id, id) as { source: string; target: string; edge_type: string }[];
		expect(edges.some(edge => edge.source === id && edge.target === `gist_${id}` && edge.edge_type === "ctx")).toBe(
			true,
		);
	});

	it("sleepAllSessions adds gists and edges for every consolidated session (#2435)", () => {
		const beam = trackedState("maintenance");
		insertWorking(beam.db, "wm-a1", "a", "Alpha launch checklist");
		insertWorking(beam.db, "wm-b1", "b", "Beta launch checklist");

		const result = sleepAllSessions(beam, false);
		expect(result.items_consolidated).toBe(2);
		const gistCount = (beam.db.query("SELECT COUNT(*) AS count FROM gists").get() as { count: number }).count;
		const edgeCount = (beam.db.query("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number }).count;
		expect(gistCount).toBe(2);
		expect(edgeCount).toBeGreaterThan(0);
	});

	it("sleep dry-run is side-effect-free and real sleep marks originals, writes summary and log", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "task alpha", "conversation");
		insertWorking(beam.db, "wm2", "s1", "task beta", "conversation");

		const dry = sleep(beam, true);
		expect(dry.status).toBe("dry_run");
		expect(dry.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 0,
		});
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE consolidated_at IS NOT NULL").get(),
		).toEqual({ count: 0 });

		const real = sleep(beam, false);
		expect(real.status).toBe("consolidated");
		expect(real.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM working_memory").get()).toEqual({
			count: 2,
		});
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE consolidated_at IS NOT NULL").get(),
		).toEqual({ count: 2 });
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 1,
		});
		expect(getConsolidationLog(beam, 1)[0]?.items_consolidated).toBe(2);
	});
	it("sleep caps oversized episodes before extraction and embedding", () => {
		const beam = trackedState();
		beam.config.maxEpisodeChars = 512;
		const transcript = "[role: user] progress output with noisy tool transcript ".repeat(40);
		insertWorking(beam.db, "wm-big", "s1", transcript, "conversation");

		const result = sleep(beam, false);
		const row = beam.db
			.query(
				`SELECT content, length(content) AS chars, json_extract(metadata_json, '$.truncated') AS truncated,
				 json_extract(metadata_json, '$.original_chars') AS original_chars,
				 json_extract(metadata_json, '$.max_chars') AS max_chars
				 FROM episodic_memory WHERE source = 'sleep_consolidation'`,
			)
			.get() as {
			content: string;
			chars: number;
			truncated: number;
			original_chars: number;
			max_chars: number;
		} | null;

		expect(result.status).toBe("consolidated");
		expect(row).not.toBeNull();
		expect(row?.chars).toBeLessThanOrEqual(512);
		expect(row?.content.includes("sleep_consolidation episode truncated")).toBe(true);
		expect(row?.truncated).toBe(1);
		expect(row?.original_chars).toBeGreaterThan(512);
		expect(row?.max_chars).toBe(512);
	});

	it("sleep consolidates embedText projections instead of raw working content", () => {
		const beam = trackedState();
		const raw =
			"[role: user]\nI always prefer tabs\n[user:end]\n\n[role: assistant]\nthe parser never initializes\n[assistant:end]";
		const clean = "I always prefer tabs\n\nthe parser never initializes";
		beam.db.run(
			`INSERT INTO working_memory
			 (id, content, embed_text, source, timestamp, session_id, importance, veracity, scope, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["wm-projected", raw, clean, "coding-agent-transcript", oldIso(), "s1", 0.7, "unknown", "session", oldIso()],
		);

		const result = sleep(beam, false);
		const row = beam.db.query("SELECT content FROM episodic_memory WHERE source = 'sleep_consolidation'").get() as {
			content: string;
		} | null;

		expect(result.status).toBe("consolidated");
		expect(row?.content).toContain("I always prefer tabs");
		expect(row?.content).toContain("the parser never initializes");
		expect(row?.content).not.toContain("[role:");
		expect(row?.content).not.toContain(":end]");
		expect(beam.db.query("SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH ?").all("tabs")).toHaveLength(1);
		expect(beam.db.query("SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH ?").all("role")).toEqual([]);
	});
	it("sleep splits capped source groups without dropping row ids", () => {
		const beam = trackedState();
		beam.config.maxEpisodeChars = 100;
		insertWorking(beam.db, "wm-one", "s1", `first ${"a".repeat(70)}`, "conversation");
		insertWorking(beam.db, "wm-two", "s1", `second ${"b".repeat(70)}`, "conversation");
		insertWorking(beam.db, "wm-three", "s1", `third ${"c".repeat(70)}`, "conversation");

		const result = sleep(beam, false);
		const rows = beam.db
			.query("SELECT summary_of, length(content) AS chars FROM episodic_memory WHERE source = 'sleep_consolidation'")
			.all() as { summary_of: string; chars: number }[];

		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBe(3);
		expect(result.summaries_created).toBe(3);
		expect(rows).toHaveLength(3);
		expect(rows.every(row => row.chars <= 100)).toBe(true);
		expect(rows.map(row => row.summary_of).sort()).toEqual(["wm-one", "wm-three", "wm-two"]);
	});

	it("sleepAllSessions consolidates eligible rows outside the caller session", () => {
		const beam = trackedState("maintenance");
		insertWorking(beam.db, "wm-a", "a", "alpha session task");
		insertWorking(beam.db, "wm-b", "b", "beta session task");

		const result = sleepAllSessions(beam, false);
		expect(result.status).toBe("consolidated");
		expect(result.sessions_scanned).toBe(2);
		expect(result.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 2,
		});
	});

	it("degradation marks old tier transitions without deleting memories", () => {
		const beam = trackedState();
		const id1 = consolidateToEpisodic(beam, "A detailed tier one memory", ["wm1"]);
		const id2 = consolidateToEpisodic(
			beam,
			"B detailed tier two memory with Project Phoenix deadline and important release facts.".repeat(12),
			["wm2"],
		);
		beam.db.run("UPDATE episodic_memory SET tier = 1, created_at = ? WHERE id = ?", [oldIso(31 * 24), id1]);
		beam.db.run("UPDATE episodic_memory SET tier = 2, created_at = ? WHERE id = ?", [oldIso(181 * 24), id2]);

		const dry = degradeEpisodic(beam, true);
		expect(dry.tier1_to_tier2).toBe(1);
		expect(dry.tier2_to_tier3).toBe(1);
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id1) as { tier: number }).tier).toBe(
			1,
		);

		const real = degradeEpisodic(beam, false);
		expect(real.status).toBe("degraded");
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id1) as { tier: number }).tier).toBe(
			2,
		);
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id2) as { tier: number }).tier).toBe(
			3,
		);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 2,
		});
	});

	it("returns contaminated episodic memories by veracity and importance", () => {
		const beam = trackedState();
		consolidateToEpisodic(beam, "High stakes inferred memory", ["wm1"], "test", 0.9, {
			veracity: "inferred",
		});
		consolidateToEpisodic(beam, "High stakes unknown memory", ["wm2"], "test", 0.8, {
			veracity: "unknown",
		});
		consolidateToEpisodic(beam, "High stakes false memory", ["wm3"], "test", 0.85, {
			veracity: "false",
		});
		consolidateToEpisodic(beam, "Low stakes unknown memory", ["wm4"], "test", 0.1, {
			veracity: "unknown",
		});
		consolidateToEpisodic(beam, "Clean true memory", ["wm5"], "test", 0.95, { veracity: "true" });

		const rows = getContaminated(beam, 10, 0.5);
		expect(rows.map(row => row.content)).toEqual([
			"High stakes inferred memory",
			"High stakes false memory",
			"High stakes unknown memory",
		]);
	});

	it("extracts/stores MEMORIA facts and retrieves them with stats", () => {
		const beam = trackedState();
		const counts = extractAndStoreFacts(
			beam,
			"My name is Ada. I prefer Rust. Dashboard API latency is 250ms. Release is v1.2.3 on 2026-05-30. ProjectX uses SQLite.",
			7,
			"wm-facts",
		);

		expect(counts.metric).toBeGreaterThanOrEqual(1);
		expect(counts.version).toBeGreaterThanOrEqual(1);
		expect(counts.date).toBeGreaterThanOrEqual(1);
		expect(counts.entity).toBeGreaterThanOrEqual(1);
		const stats = getMemoriaStats(beam);
		expect(stats.memoria_facts).toBeGreaterThanOrEqual(4);
		expect(stats.memoria_preferences).toBeGreaterThanOrEqual(1);
		expect(stats.memoria_kg).toBeGreaterThanOrEqual(1);

		const metrics = memoriaRetrieve(beam, "what was dashboard api latency", "IE", 5);
		expect(metrics.results.some(row => String((row as Record<string, unknown>).value).includes("250ms"))).toBe(true);
		const facts = beam.db.query("SELECT COUNT(*) AS count FROM facts WHERE source_msg_id = ?").get("wm-facts") as {
			count: number;
		};
		expect(facts.count).toBeGreaterThanOrEqual(4);
	});

	it("skips pattern fact extraction for oversized raw transcripts", () => {
		const beam = trackedState();
		const line = "progress boot done 615014ms downloading gapps its@66% priv-app files done 221MB version 1.2.3\n";
		const text = line.repeat(Math.ceil((REGEX_EXTRACTION_MAX_INPUT_CHARS + 1) / line.length));
		const counts = extractAndStoreFacts(beam, text, 7, "large-transcript");

		expect(counts).toEqual({
			metric: 0,
			date: 0,
			version: 0,
			entity: 0,
			sequence: 0,
			timeline: 0,
			negation: 0,
			decision: 0,
		});
		const facts = beam.db.query("SELECT COUNT(*) AS count FROM memoria_facts").get() as { count: number };
		expect(facts.count).toBe(0);
	});

	it("metric prefix stops at a markdown table pipe, not 50 raw chars back (regression, garbled-metric-facts audit 2026-09-03)", () => {
		const beam = trackedState();
		// Real garbled sample from a live bank: "iam-role_smrx/sm-secrets_ssm-parameters_api" -> "2api",
		// produced when the 50-char lookbehind crossed a table row's pipe delimiters and glued
		// three unrelated cells together.
		const text = "| iam-role | smrx/sm-secrets | ssm-parameters | uses 2 APIs |\n";
		extractAndStoreFacts(beam, text, 1, "table-row-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		for (const row of rows) {
			expect(row.subject).not.toContain("iam-role");
			expect(row.subject).not.toContain("secrets");
			expect(row.subject).not.toContain("ssm-parameters");
		}
		expect(rows.some(row => row.subject === "uses_api")).toBe(true);
	});

	it("metric prefix stops at a sentence boundary, not 50 raw chars back", () => {
		const beam = trackedState();
		// Real garbled sample: "owns_both+rewrote_one_second" -> "30seconds", from a run-on
		// sentence where the lookbehind crossed a period into an unrelated prior clause.
		const text = "Alice owns both services. Bob rewrote the migration step in 30 seconds flat.\n";
		extractAndStoreFacts(beam, text, 1, "sentence-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		for (const row of rows) {
			expect(row.subject).not.toContain("owns");
			expect(row.subject).not.toContain("both");
		}
	});

	it("still extracts a clean metric key from a normal single-line sentence (no false negatives)", () => {
		const beam = trackedState();
		const text = "The p99 response time is 250ms under load.\n";
		extractAndStoreFacts(beam, text, 1, "clean-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0]?.subject).toBe("p99_response_time_ms");
		expect(rows[0]?.object).toBe("250ms");
	});

	it("still extracts known-good short technical metric names that trip the review script's heuristic", () => {
		const beam = trackedState();
		const text = "The imdsv2 max lifetime is 15 days by policy.\n";
		extractAndStoreFacts(beam, text, 1, "short-key-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0]?.subject).toBe("imdsv2_max_lifetime_day");
		expect(rows[0]?.object).toBe("15days");
	});

	it("does not treat a version/decimal dot as a sentence boundary (regression, blocker-review fix)", () => {
		const beam = trackedState();
		// "v1.2" and "3.14"-style dots must NOT truncate the prefix window: only a `.` followed
		// by whitespace (a real sentence end) is a boundary. Before this correction, the naive
		// `[.!?;]` boundary set treated every literal dot as a break, silently dropping
		// "Deployed" from the key and changing extraction behavior for ordinary version mentions.
		const text = "Deployed v1.2 migration finished in 30 seconds flat.\n";
		extractAndStoreFacts(beam, text, 1, "version-dot-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0]?.subject).toBe("v12_migration_finished_second");
		expect(rows[0]?.object).toBe("30seconds");
	});

	it("still truncates at a real sentence-ending period even when an earlier version dot is present", () => {
		const beam = trackedState();
		// Confirms the fix distinguishes "v1.2" (decimal, not a boundary) from the period that
		// actually ends the first sentence -- the extractor must still stop there.
		const text = "Deployed v1.2. Migration finished in 30 seconds flat.\n";
		extractAndStoreFacts(beam, text, 1, "sentence-after-version-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0]?.subject).toBe("migration_finished_second");
		expect(rows[0]?.subject).not.toContain("v1");
		expect(rows[0]?.subject).not.toContain("deployed");
	});

	it("does not leak words from before a backtick code span into the metric key", () => {
		const beam = trackedState();
		// The backtick boundary must stop the window at the code span, not just mask its
		// contents -- otherwise words before the span could still glue onto the key.
		const text = "Run `npm install --legacy-peer-deps` then wait about 30 seconds for it to finish.\n";
		extractAndStoreFacts(beam, text, 1, "backtick-source");

		const rows = beam.db.query("SELECT subject, object FROM facts WHERE predicate = 'metric'").all() as Array<{
			subject: string;
			object: string;
		}>;
		expect(rows.length).toBe(1);
		expect(rows[0]?.subject).not.toContain("npm");
		expect(rows[0]?.subject).not.toContain("install");
		expect(rows[0]?.subject).not.toContain("run");
	});
});
