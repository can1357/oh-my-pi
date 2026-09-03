import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { factRecall, formatContext, recall, recallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";

type TestBeam = BeamMemoryState & { close(): void };

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
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
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function insertWorking(
	beam: TestBeam,
	id: string,
	content: string,
	options: { timestamp?: string; importance?: number; sessionId?: string; scope?: string } = {},
): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, ?, ?, ?, 'unknown', 'general')",
		[
			id,
			content,
			options.timestamp ?? "2026-05-30T12:00:00.000Z",
			options.sessionId ?? beam.sessionId,
			options.importance ?? 0.5,
			options.scope ?? "global",
		],
	);
}

function insertEpisodic(
	beam: TestBeam,
	id: string,
	content: string,
	options: { timestamp?: string; importance?: number; eventDate?: string } = {},
): void {
	beam.db.run(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type, event_date) VALUES (?, ?, 'test', ?, ?, ?, 'global', 'unknown', 'general', ?)",
		[
			id,
			content,
			options.timestamp ?? "2026-05-30T12:00:00.000Z",
			beam.sessionId,
			options.importance ?? 0.5,
			options.eventDate ?? null,
		],
	);
}

describe("beam recall free functions", () => {
	it("orders deterministic FTS-only working-memory hits by lexical strength", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-weak", "banana appears once beside unrelated notes");
		insertWorking(beam, "wm-strong", "banana banana banana release checklist");

		const results = await recall(beam, "banana", 2, { queryTime: "2026-05-30T12:00:00.000Z" });

		const top = results[0];
		expect(results.map(result => result.id)).toEqual(["wm-strong", "wm-weak"]);
		expect(top?.tier_label).toBe("working");
		if (top === undefined || top.fts_score === undefined) {
			throw new Error("expected a scored recall result");
		}
		expect(top.fts_score).toBeGreaterThan(0);
	});

	it("fuses working and episodic memory candidates", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-deploy", "deploy runbook says use the blue pipeline");
		insertEpisodic(beam, "em-deploy", "deploy retrospective: blue pipeline avoided downtime");

		const results = await recall(beam, "deploy blue pipeline", 5, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results.map(result => result.id)).toContain("wm-deploy");
		expect(results.map(result => result.id)).toContain("em-deploy");
		expect(new Set(results.map(result => result.tier_label))).toEqual(new Set(["working", "episodic"]));
	});

	it("keeps global episodic rows visible when a channelId filter is active while still isolating other channels", async () => {
		const beam = makeBeam();
		// Global row with channel_id NULL — the shape produced by importFromDict()
		// and by any cross-channel/global memory. Must survive a channelId filter.
		insertEpisodic(beam, "em-global", "quokka migration protocol uses base64 snapshots");
		// Non-global row owned by a different channel/session — must stay hidden.
		beam.db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, scope, channel_id, veracity, memory_type) VALUES ('em-other-channel', 'quokka migration protocol for team beta', 'test', ?, 'other-session', 0.5, 'session', 'other-bank', 'unknown', 'general')",
			["2026-05-30T12:00:00.000Z"],
		);

		const results = await recall(beam, "quokka migration protocol", 5, {
			queryTime: "2026-05-30T12:00:00.000Z",
			channelId: "project-bank",
			includeWorking: false,
		});

		const ids = results.map(result => result.id);
		expect(ids).toContain("em-global");
		expect(ids).not.toContain("em-other-channel");
	});

	it("boosts memories near the requested temporal target", async () => {
		const beam = makeBeam();
		insertEpisodic(beam, "em-old", "incident alpha resolved by rotating credentials", {
			timestamp: "2026-05-10T09:00:00.000Z",
			eventDate: "2026-05-10",
		});
		insertEpisodic(beam, "em-target", "incident alpha resolved by rotating credentials", {
			timestamp: "2026-05-29T09:00:00.000Z",
			eventDate: "2026-05-29",
		});

		const results = await recall(beam, "incident alpha", 2, {
			queryTime: "2026-05-29T12:00:00.000Z",
			temporalWeight: 1.0,
			temporalHalflife: 12,
			includeWorking: false,
		});

		const target = results[0];
		const old = results[1];
		expect(target?.id).toBe("em-target");
		if (
			target === undefined ||
			old === undefined ||
			target.temporal_score === undefined ||
			old.temporal_score === undefined
		) {
			throw new Error("expected two temporally scored recall results");
		}
		expect(target.temporal_score).toBeGreaterThan(old.temporal_score);
	});

	it("accounts for importance and recency in deterministic fallback scoring", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-low", "phoenix migration requires operator approval", {
			timestamp: new Date().toISOString(),
			importance: 0.1,
		});
		insertWorking(beam, "wm-high", "phoenix migration requires operator approval", {
			timestamp: "2025-05-30T12:00:00.000Z",
			importance: 1.0,
		});

		const results = await recall(beam, "phoenix migration", 2, {
			importanceWeight: 0.8,
			ftsWeight: 0.1,
			vecWeight: 0.1,
		});

		expect(results[0]?.id).toBe("wm-high");
		expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
	});

	it("handles CJK token queries without embeddings", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-cjk", "数据库 密码 已轮换");
		insertWorking(beam, "wm-other", "unrelated english note");

		const results = await recall(beam, "数据库", 3);

		expect(results[0]?.id).toBe("wm-cjk");
		expect(results.map(result => result.id)).not.toContain("wm-other");
	});

	it("does not retry scoped recall without the session filter when only another session matches", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-private-other", "orion marker lives only in the other private session", {
			sessionId: "s2",
			scope: "session",
		});

		const results = await recall(beam, "orion marker", 5);

		expect(results).toHaveLength(0);
	});

	it("formats context in bullet and JSON sandwich sections", () => {
		const beam = makeBeam();
		const results = [
			{
				id: "a",
				content: "highest confidence fact",
				source: "unit",
				timestamp: "2026-05-30T00:00:00.000Z",
				score: 0.9,
			},
			{
				id: "b",
				content: "supporting fact",
				source: "unit",
				timestamp: "2026-05-29T00:00:00.000Z",
				score: 0.5,
			},
		];

		const bullet = formatContext(beam, results);
		const json = JSON.parse(formatContext(beam, results, "json")) as {
			top_facts: string[];
			supporting_context: string[];
		};

		expect(bullet).toContain("## Top Facts");
		expect(bullet).toContain("highest confidence fact");
		expect(json.top_facts[0]).toContain("highest confidence fact");
		expect(json.supporting_context[0]).toContain("supporting fact");
	});

	it("recalls structured facts via FTS and LIKE fallback shape", () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-1", beam.sessionId, "service", "uses", "postgres database", "2026-05-30T00:00:00.000Z", 0.91],
		);

		const results = factRecall(beam, "postgres", 3);

		expect(results).toHaveLength(1);
		expect(results[0]?.content).toBe("postgres database");
		expect(results[0]?.fact_id).toBe("fact-1");
		expect(results[0]?.subject).toBe("service");
	});

	it("keeps exact fact hits for conversational questions", () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-name", beam.sessionId, "name", "is", "Alice", "2026-05-30T00:00:00.000Z", 0.95],
		);

		const results = factRecall(beam, "what do you know about my name", 3);

		expect(results[0]?.fact_id).toBe("fact-name");
		expect(results[0]?.content).toBe("Alice");
	});

	it("scores exact fact hits above filler-heavy working memories", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-filler", "could you remind me about my old onboarding checklist", { importance: 1.0 });
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-name", beam.sessionId, "name", "is", "Alice", "2026-05-30T00:00:00.000Z", 0.95],
		);
		const results = await recallEnhanced(beam, "could you remind me about my name", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-name");
	});

	it("treats current-intent words as optional fact-query scaffolding", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-current", "my current name profile is stale", { importance: 1.0 });
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-name", beam.sessionId, "name", "called", "Alice", "2026-05-30T00:00:00.000Z", 0.1],
		);

		const results = await recallEnhanced(beam, "what my current name", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-name");
	});

	it("strips clitic fragments before scoring conversational fact queries", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-clitic", "what s my name onboarding checklist", { importance: 1.0 });
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-name", beam.sessionId, "name", "called", "Eve", "2026-05-30T00:00:00.000Z", 0.1],
		);

		const results = await recallEnhanced(beam, "what's my name", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-name");
	});

	it("preserves stop-word-looking entity tokens when scoring facts", async () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-may", beam.sessionId, "May", "birthday", "June 1", "2026-05-30T00:00:00.000Z", 0.1],
		);
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-bob", beam.sessionId, "Bob", "birthday", "June 2", "2026-05-30T00:00:00.000Z", 1.0],
		);

		const results = await recallEnhanced(beam, "May birthday", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-may");
	});

	it("preserves matching two-letter fact entities when scoring facts", async () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-us", beam.sessionId, "US", "timezone", "Eastern", "2026-05-30T00:00:00.000Z", 0.1],
		);
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-eu", beam.sessionId, "EU", "timezone", "Central European", "2026-05-30T00:00:00.000Z", 1.0],
		);

		const results = await recallEnhanced(beam, "US timezone", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-us");
	});

	it("does not preserve filler tokens through substring matches", async () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-my", beam.sessionId, "my", "birthday", "June 1", "2026-05-30T00:00:00.000Z", 0.1],
		);
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-amy", beam.sessionId, "Amy", "birthday", "June 2", "2026-05-30T00:00:00.000Z", 1.0],
		);

		const results = await recallEnhanced(beam, "what is my birthday", 1, {
			includeFacts: true,
			queryEmbedding: null,
			useMmr: false,
		});

		expect(results[0]?.id).toBe("fact-my");
	});

	it("keeps exact working-memory hits above weak matching facts in enhanced recall", async () => {
		const beam = makeBeam();
		insertWorking(
			beam,
			"wm-quasar",
			"MNEMOPI FULL PIPELINE TEST 20260613: The user Verge prefers OMP memory to run at full power. Unique entity QuasarOtter owns SignalPineapple and uses RecallEngine-Seven.",
		);
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"fact-generic",
				beam.sessionId,
				"Instruction",
				"states",
				"always trigger the user stop sequence in mnemopi's callRemoteLlm test",
				"2026-05-30T00:00:00.000Z",
				1.0,
			],
		);

		const results = await recallEnhanced(
			beam,
			"QuasarOtter SignalPineapple RecallEngine-Seven MNEMOPI FULL PIPELINE TEST 20260613",
			3,
			{ includeFacts: true, queryEmbedding: null, useMmr: false },
		);

		expect(results[0]?.id).toBe("wm-quasar");
		expect(results.map(result => result.id)).toContain("fact-generic");
	});

	it("filters fact recall to same-session facts plus explicitly global facts", () => {
		const beam = makeBeam();
		beam.db.run("ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT 'session'");
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"fact-private",
				"s2",
				"service",
				"uses",
				"postgres private database",
				"2026-05-30T00:00:00.000Z",
				0.99,
				"session",
			],
		);
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"fact-global",
				"s2",
				"service",
				"uses",
				"postgres global database",
				"2026-05-30T00:00:00.000Z",
				0.9,
				"global",
			],
		);

		const results = factRecall(beam, "postgres database", 5);

		expect(results.map(result => result.fact_id)).toEqual(["fact-global"]);
		expect(results[0]?.content).toBe("postgres global database");
	});

	it("increments enhanced recall counts only for the final returned MMR results", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-enhanced-keep", "calypso migration plan keeps postgres online", { importance: 1.0 });
		insertWorking(beam, "wm-enhanced-drop", "calypso migration plan keeps redis online", { importance: 0.9 });

		const results = await recallEnhanced(beam, "calypso migration plan keeps online", 1, { useCache: false });
		const returned = results[0]?.id;
		if (returned === undefined) throw new Error("expected enhanced recall to return one result");

		const rows = beam.db
			.query("SELECT id, recall_count FROM working_memory WHERE id IN (?, ?) ORDER BY id")
			.all("wm-enhanced-drop", "wm-enhanced-keep") as { id: string; recall_count: number }[];
		const counts = new Map(rows.map(row => [row.id, row.recall_count]));

		expect(counts.get(returned)).toBe(1);
		expect(counts.get(returned === "wm-enhanced-keep" ? "wm-enhanced-drop" : "wm-enhanced-keep")).toBe(0);
	});

	it("enhanced recall applies intent/synonym/MMR path without dropping required fields", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-db", "database migration notes mention postgres");
		insertWorking(beam, "wm-cache", "cache migration notes mention redis");

		const results = await recallEnhanced(beam, "db migration", 2, { useCache: false });

		expect(results).toHaveLength(2);
		expect(results[0]?.id).toBeTruthy();
		expect(typeof results[0]?.score).toBe("number");
		expect(results[0]?.explanation).toBeTruthy();
	});

	it("clips long content with a trailing ellipsis and reports the original length (issue #4443)", async () => {
		const beam = makeBeam();
		const head = "Decision record: the deploy pipeline uses blue-green cutover. ";
		const body = "Detail sentence about rollout invariants. ".repeat(20);
		const tail = "CRITICAL-TAIL: rollback requires restoring the previous DNS weight map first.";
		const full = `${head}${body}${tail}`;
		insertWorking(beam, "wm-long", full, { importance: 0.9 });

		const results = await recall(beam, "deploy pipeline blue-green cutover", 5);
		const hit = results.find(row => row.id === "wm-long");
		expect(hit).toBeDefined();
		expect(hit?.truncated).toBe(true);
		expect(hit?.full_length).toBe(full.length);
		expect(hit?.content.length).toBe(500);
		expect(hit?.content.endsWith("…")).toBe(true);
		expect(hit?.content.includes("CRITICAL-TAIL")).toBe(false);
	});

	it("returns short content untouched with truncated=false", async () => {
		const beam = makeBeam();
		const short = "quick working note that fits well under the preview cap";
		insertWorking(beam, "wm-short", short);

		const results = await recall(beam, "quick working note preview cap", 5);
		const hit = results.find(row => row.id === "wm-short");
		expect(hit).toBeDefined();
		expect(hit?.truncated).toBe(false);
		expect(hit?.full_length).toBe(short.length);
		expect(hit?.content).toBe(short);
	});

	it("honours a caller-supplied contentPreviewChars cap and disables clipping when 0", async () => {
		const beam = makeBeam();
		const long = "long ".repeat(400).trim();
		insertWorking(beam, "wm-cap", long);

		const capped = await recall(beam, "long", 3, { contentPreviewChars: 40 });
		const cappedHit = capped.find(row => row.id === "wm-cap");
		expect(cappedHit?.content.length).toBe(40);
		expect(cappedHit?.content.endsWith("…")).toBe(true);
		expect(cappedHit?.full_length).toBe(long.length);

		const full = await recall(beam, "long", 3, { contentPreviewChars: 0 });
		const fullHit = full.find(row => row.id === "wm-cap");
		expect(fullHit?.content).toBe(long);
		expect(fullHit?.truncated).toBe(false);
	});
});
