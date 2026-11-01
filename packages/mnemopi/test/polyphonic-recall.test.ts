import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { memoriaRetrieve } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { PolyphonicRecallEngine, polyphonicRecall } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";
import { currentLoopPhase } from "@oh-my-pi/pi-utils";

function makeBeam(): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		sessionId: "test-session",
		authorId: null,
		authorType: null,
		channelId: "test-session",
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
	};
}
function insertWorking(
	beam: BeamMemoryState,
	id: string,
	content: string,
	importance = 0.7,
	timestamp = new Date().toISOString(),
	sessionId = beam.sessionId,
	scope = "global",
): void {
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
			VALUES (?, ?, 'test', ?, ?, ?, '{}', 'unknown', 'unknown', ?, ?)`,
		[id, content, timestamp, sessionId, importance, scope, timestamp],
	);
}
function seedPolyphonicFixture(beam: BeamMemoryState): PolyphonicRecallEngine {
	const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId, channelId: beam.channelId });
	const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
	insertWorking(beam, "m1", "Alice owns the durable launch checklist", 0.8, old);
	insertWorking(beam, "m2", "Alice linked the graph traversal plan", 0.7, old);
	insertWorking(beam, "m3", "Recent operational note for this week", 0.6);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m1",
		JSON.stringify([0.8, 0.2]),
	]);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m2",
		JSON.stringify([1, 0]),
	]);
	beam.db.run(
		`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
			VALUES ('gist_m2', 'Alice graph gist', ?, ?, 'm2')`,
		[new Date().toISOString(), JSON.stringify(["Alice"])],
	);
	beam.db.run(
		`INSERT INTO consolidated_facts
			(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
			VALUES ('cf_alice_owns', 'Alice', 'owns', 'durable launch checklist', 0.9, 2, ?, ?, ?, 'likely_true')`,
		[new Date().toISOString(), new Date().toISOString(), JSON.stringify(["m1"])],
	);
	return engine;
}

afterEach(() => {
	delete process.env.MNEMOPI_VOICE_VECTOR;
	delete process.env.MNEMOPI_VOICE_GRAPH;
	delete process.env.MNEMOPI_VOICE_FACT;
	delete process.env.MNEMOPI_VOICE_TEMPORAL;
});

describe("PolyphonicRecallEngine", () => {
	it("fuses the four voices with RRF and preserves voice attribution order", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m2", "m1", "m3"]);
			expect(results[0]?.voice_scores).toEqual({ vector: 1 / 61, graph: 1 / 61 });
			expect(results[1]?.voice_scores).toEqual({ vector: 1 / 62, fact: 1 / 61 });
			expect(results[2]?.voice_scores).toEqual({ temporal: 1 / 61 });
			expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
			expect(results[0]?.content).toContain("graph traversal");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("reports its synchronous fan-out and fusion to the loop watchdog as mnemopi.recall", () => {
		const beam = makeBeam();
		try {
			seedPolyphonicFixture(beam);
			const recall = PolyphonicRecallEngine.prototype.recall;
			const phases: (string | undefined)[] = [];
			const spy = spyOn(PolyphonicRecallEngine.prototype, "recall").mockImplementation(function (
				this: PolyphonicRecallEngine,
				...args
			) {
				phases.push(currentLoopPhase());
				return recall.apply(this, args);
			});
			try {
				polyphonicRecall(beam, "Alice recent", 10, { queryEmbedding: [1, 0] });

				expect(phases.length).toBeGreaterThan(0);
				expect(phases.every(phase => phase === "mnemopi.recall")).toBe(true);
				expect(currentLoopPhase()).toBeUndefined();
			} finally {
				spy.mockRestore();
			}
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("honors per-voice gates without producing fake-success results", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m1"]);
			expect(results[0]?.voice_scores).toEqual({ fact: 1 / 61 });
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("does not let a query stopword match a stopword fact subject", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			insertWorking(beam, "m-junk", "That is approximately one CSS pixel at the default zoom level");
			const timestamp = new Date().toISOString();
			// Shape the regex extractor stores for "That is ..." sentences.
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_that', 'That', 'related_to', 'approximately one CSS pixel', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["m-junk"])],
			);

			expect(engine.factVoice("the checklist that Alice owns").map(result => result.memoryId)).toEqual(["m1"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("filters vector and temporal voices to beam-session or global memories", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			insertWorking(
				beam,
				"wm-private-b",
				"Other session private vector marker",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-b",
				"Other session global vector marker",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-private-b",
				JSON.stringify([1, 0]),
			]);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-global-b",
				JSON.stringify([1, 0]),
			]);
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_FACT = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const vectorResults = polyphonicRecall(beam, "vector marker", 5, { queryEmbedding: [1, 0] });

			expect(vectorResults.map(result => result.id)).toEqual(["wm-global-b"]);

			process.env.MNEMOPI_VOICE_VECTOR = "0";
			delete process.env.MNEMOPI_VOICE_TEMPORAL;

			const temporalResults = polyphonicRecall(beam, "recent vector marker", 5);

			expect(temporalResults.map(result => result.id)).toEqual(["wm-global-b"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("hydrates fact voice source memories through the session/global visibility filter", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(
				beam,
				"wm-private-fact",
				"Alice private source from another session",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-fact",
				"Alice global source from another session",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_alice_visibility', 'Alice', 'owns', 'visibility fixture', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-private-fact", "wm-global-fact"])],
			);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const results = engine.recall("Alice", null, 5);

			expect(results.map(result => result.id)).toEqual(["wm-global-fact"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("matches consolidated facts with 3-char, 4-char, particle-bearing, supplementary Han, and mixed-script CJK subjects in factVoice", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-cjk-tsmc", "台積電最新營收超過預期", 0.9, timestamp);
			insertWorking(beam, "wm-cjk-pku", "北京大學排名位居前列", 0.9, timestamp);
			insertWorking(beam, "wm-cjk-tokyo", "東京都今日天氣晴朗", 0.9, timestamp);
			insertWorking(beam, "wm-cjk-extb", "𠮷𠀋的專案紀錄已完成", 0.9, timestamp);
			insertWorking(beam, "wm-cjk-hanoi", "HàNội支援CJK的進度已更新", 0.9, timestamp);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf_tsmc_rev', '台積電', '營收', '超過預期', 0.95, 3, ?, ?, ?, 'likely_true'),
					('cf_pku_rank', '北京大學', '排名', '前列', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_tokyo_weather', '東京都', '天氣', '晴朗', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_extb_record', '𠮷𠀋', '狀態', '已完成', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_hanoi_support', 'HàNội支援CJK', '進度', '已更新', 0.95, 2, ?, ?, ?, 'likely_true')`,
				[
					timestamp,
					timestamp,
					JSON.stringify(["wm-cjk-tsmc"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-cjk-pku"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-cjk-tokyo"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-cjk-extb"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-cjk-hanoi"]),
				],
			);
			expect(engine.factVoice("檢查台積電的營收表現").map(hit => hit.memoryId)).toContain("wm-cjk-tsmc");
			expect(engine.factVoice("請問北京大學的排名").map(hit => hit.memoryId)).toContain("wm-cjk-pku");
			expect(engine.factVoice("東京都的天氣如何").map(hit => hit.memoryId)).toContain("wm-cjk-tokyo");
			expect(engine.factVoice("查詢𠮷𠀋的專案紀錄").map(hit => hit.memoryId)).toContain("wm-cjk-extb");
			expect(engine.factVoice("查詢HàNội支援CJK的進度").map(hit => hit.memoryId)).toContain("wm-cjk-hanoi");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("classifies CJK queries without temporal keywords to IE ability in memoriaRetrieve", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', '北京大學', '排名位居前列', '請問北京大學的排名', 0.9, 'wm-cjk-pku')`,
				[beam.sessionId],
			);
			const defaultMemoria = memoriaRetrieve(beam, "請問北京大學的排名");
			expect(defaultMemoria.ability).toBe("IE");
			expect((defaultMemoria.results as Array<{ key?: string }>).map(r => r.key)).toContain("北京大學");

			const nonTemporalOrder = memoriaRetrieve(beam, "資料表欄位順序是什麼");
			expect(nonTemporalOrder.ability).toBe("IE");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("routes mixed-script queries to IE and preserves intact technical subjects", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', 'PostgreSQL資料庫', '連線池設定為 32', 'PostgreSQL資料庫連線池設定', 0.95, 'wm-cjk-tsmc'),
					(?, 1, 'entity', 'postmortem', 'unrelated incident note', 'postmortem review', 0.99, 'wm-cjk-tokyo')`,
				[beam.sessionId, beam.sessionId],
			);
			const mixedMemoria = memoriaRetrieve(beam, "請問PostgreSQL資料庫的連線池設定", null, 1);
			expect(mixedMemoria.ability).toBe("IE");
			expect((mixedMemoria.results as Array<{ key?: string }>)[0]?.key).toBe("PostgreSQL資料庫");

			const englishMemoria = memoriaRetrieve(beam, "what is PostgreSQL", null, 1);
			expect(englishMemoria.ability).toBe("IE");
			expect((englishMemoria.results as Array<{ key?: string }>)[0]?.key).toBe("PostgreSQL資料庫");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("retrieves timeline events for mixed-script CJK terms under TR ability", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_timelines
					(session_id, event_id, date, description, source_memory_id)
					VALUES
					(?, 1, '2026-01-01', '整理內部資料歸檔', 'wm-cjk-tokyo'),
					(?, 2, '2026-03-01', '完成PostgreSQL資料庫叢集遷移', 'wm-cjk-tsmc')`,
				[beam.sessionId, beam.sessionId],
			);
			const timelineMemoria = memoriaRetrieve(beam, "PostgreSQL資料庫", "TR", 1);
			expect(timelineMemoria.ability).toBe("TR");
			expect((timelineMemoria.results as Array<{ event_id?: number }>)[0]?.event_id).toBe(2);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("ranks specific timeline primary matches ahead of older generic timeline matches", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_timelines
					(session_id, event_id, date, description, source_memory_id)
					VALUES
					(?, 1, '2020-01-01', 'General project timeline and historical milestones', 'wm-old-timeline'),
					(?, 2, '2026-05-01', 'PostgreSQL cluster migration completed', 'wm-pg-migration')`,
				[beam.sessionId, beam.sessionId],
			);
			const result = memoriaRetrieve(beam, "PostgreSQL timeline", "TR", 1);
			expect(result.ability).toBe("TR");
			expect((result.results as Array<{ event_id?: number }>)[0]?.event_id).toBe(2);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("does not trigger temporal routing for nearest-neighbor technical compounds", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			expect(engine.temporalVoice("最近鄰演算法")).toEqual([]);
			expect(engine.temporalVoice("最近邻算法")).toEqual([]);

			const retrieveResult = memoriaRetrieve(beam, "最近鄰演算法");
			expect(retrieveResult.ability).not.toBe("TR");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("restricts 截止 routing to deadline phrases and routes 截止頻率 to IE", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			expect(engine.temporalVoice("what is the 截止頻率")).toEqual([]);
			expect(engine.temporalVoice("專案截止日期").length).toBeGreaterThan(0);
			expect(engine.temporalVoice("報名截止").length).toBeGreaterThan(0);

			const cutoffRetrieve = memoriaRetrieve(beam, "what is the 截止頻率");
			expect(cutoffRetrieve.ability).toBe("IE");

			const deadlineRetrieve = memoriaRetrieve(beam, "專案截止日期");
			expect(deadlineRetrieve.ability).toBe("TR");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("retrieves knowledge graph entities with conjunction-bearing names under MR ability", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_kg
					(session_id, subject, predicate, object, confidence, source_memory_id)
					VALUES
					(?, '中國銀行', 'located_in', '北京', 0.99, 'wm-cjk-pku'),
					(?, '大和銀行', 'located_in', '大阪', 0.75, 'wm-cjk-tokyo')`,
				[beam.sessionId, beam.sessionId],
			);
			const daiwaDirect = memoriaRetrieve(beam, "大和銀行", "MR", 1);
			expect((daiwaDirect.results as Array<{ subject?: string }>)[0]?.subject).toBe("大和銀行");

			const daiwaQuestion = memoriaRetrieve(beam, "請問大和銀行的位置", "MR", 1);
			expect((daiwaQuestion.results as Array<{ subject?: string }>)[0]?.subject).toBe("大和銀行");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("matches mixed-script Chinese copula questions like C語言是什麼 and Node.js資料庫 in factVoice", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-c-lang", "C語言是一種通用的編程語言", 0.9, timestamp);
			insertWorking(beam, "wm-node-db", "Node.js資料庫連線已配置完畢", 0.9, timestamp);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf_c_lang', 'C語言', '定義', '編程語言', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_node_db', 'Node.js資料庫', '狀態', '已配置', 0.95, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-c-lang"]), timestamp, timestamp, JSON.stringify(["wm-node-db"])],
			);
			expect(engine.factVoice("C語言是什麼").map(hit => hit.memoryId)).toContain("wm-c-lang");
			expect(engine.factVoice("Node.js資料庫的設定").map(hit => hit.memoryId)).toContain("wm-node-db");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("ranks stronger primary matches above one-term matches in factRetrieve and kgRetrieve", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', '北京大學', '排名位居前列', '請問北京大學的排名', 0.8, 'wm-pku'),
					(?, 1, 'entity', '世界排名', '全球高校最新排名發布', '全球高校世界排名', 0.99, 'wm-world')`,
				[beam.sessionId, beam.sessionId],
			);
			const factTop = memoriaRetrieve(beam, "請問北京大學的排名", "IE", 1);
			expect((factTop.results as Array<{ key?: string }>)[0]?.key).toBe("北京大學");

			beam.db.run(
				`INSERT INTO memoria_kg
					(session_id, subject, predicate, object, confidence, source_memory_id)
					VALUES
					(?, '研究中心', 'located_in', '總部大樓', 0.99, 'wm-center'),
					(?, '研究與發展部', 'located_in', '科技園區', 0.8, 'wm-rd')`,
				[beam.sessionId, beam.sessionId],
			);
			const kgTop = memoriaRetrieve(beam, "請問研究與發展部的位置", "MR", 1);
			expect((kgTop.results as Array<{ subject?: string }>)[0]?.subject).toBe("研究與發展部");
		} finally {
			closeQuietly(beam.db);
		}
	});
	it("activates temporalVoice on both traditional and simplified CJK temporal queries", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-cjk-dep-trad", "上週的部署紀錄顯示一切正常", 0.8, timestamp);
			insertWorking(beam, "wm-cjk-dep-simp", "上周的部署紀錄顯示一切正常", 0.8, timestamp);
			insertWorking(beam, "wm-cjk-progress", "这个月的进度如期推进", 0.8, timestamp);

			const tradHits = engine.temporalVoice("上週的部署");
			expect(tradHits.map(hit => hit.memoryId)).toContain("wm-cjk-dep-trad");

			const simpHits = engine.temporalVoice("上周的部署");
			expect(simpHits.map(hit => hit.memoryId)).toContain("wm-cjk-dep-simp");

			const monthHits = engine.temporalVoice("这个月的进度");
			expect(monthHits.map(hit => hit.memoryId)).toContain("wm-cjk-progress");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("deduplicates near-identical CJK memories while keeping distinct mixed-script and prolonged-sound Japanese memories in diversityRerank", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();

			insertWorking(beam, "wm-cjk-rep1", "台積電法說會公布最新季度合併營收財報與全年資本支出規劃", 0.9, timestamp);
			insertWorking(beam, "wm-cjk-rep2", "台積電法說會公布最新季度合併營收財報與全年資本支出目標", 0.85, timestamp);
			insertWorking(beam, "wm-mixed-ts", "TypeScript支援CJK分詞", 0.8, timestamp);
			insertWorking(beam, "wm-mixed-rs", "Rust支援WASM編譯", 0.75, timestamp);
			insertWorking(beam, "wm-mixed-hanoi", "HàNội支援CJK分詞", 0.7, timestamp);
			insertWorking(beam, "wm-mixed-moscow", "Москва支援CJK分詞", 0.65, timestamp);
			insertWorking(beam, "wm-katakana-server", "サーバー設定の確認", 0.6, timestamp);
			insertWorking(beam, "wm-katakana-router", "ルーター設定の確認", 0.55, timestamp);

			const candidates = new Map([
				[
					"wm-cjk-rep1",
					{
						memoryId: "wm-cjk-rep1",
						combinedScore: 0.08,
						voiceScores: { hybrid: 0.08 },
						metadata: {},
					},
				],
				[
					"wm-cjk-rep2",
					{
						memoryId: "wm-cjk-rep2",
						combinedScore: 0.07,
						voiceScores: { hybrid: 0.07 },
						metadata: {},
					},
				],
				[
					"wm-mixed-ts",
					{
						memoryId: "wm-mixed-ts",
						combinedScore: 0.06,
						voiceScores: { hybrid: 0.06 },
						metadata: {},
					},
				],
				[
					"wm-mixed-rs",
					{
						memoryId: "wm-mixed-rs",
						combinedScore: 0.05,
						voiceScores: { hybrid: 0.05 },
						metadata: {},
					},
				],
				[
					"wm-mixed-hanoi",
					{
						memoryId: "wm-mixed-hanoi",
						combinedScore: 0.04,
						voiceScores: { hybrid: 0.04 },
						metadata: {},
					},
				],
				[
					"wm-mixed-moscow",
					{
						memoryId: "wm-mixed-moscow",
						combinedScore: 0.03,
						voiceScores: { hybrid: 0.03 },
						metadata: {},
					},
				],
				[
					"wm-katakana-server",
					{
						memoryId: "wm-katakana-server",
						combinedScore: 0.02,
						voiceScores: { hybrid: 0.02 },
						metadata: {},
					},
				],
				[
					"wm-katakana-router",
					{
						memoryId: "wm-katakana-router",
						combinedScore: 0.01,
						voiceScores: { hybrid: 0.01 },
						metadata: {},
					},
				],
			]);

			const reranked = engine.diversityRerank(candidates, 10, candidate => {
				const row = beam.db
					.query("SELECT id, content FROM working_memory WHERE id = ?")
					.get(candidate.memoryId) as { id: string; content: string } | null;
				if (!row) return null;
				return {
					id: row.id,
					content: row.content,
					score: candidate.combinedScore,
					combined_score: candidate.combinedScore,
					voice_scores: candidate.voiceScores,
					metadata: candidate.metadata,
					tier: "working",
					tier_label: "working",
				};
			});

			expect(reranked.map(r => r.id)).toEqual([
				"wm-cjk-rep1",
				"wm-mixed-ts",
				"wm-mixed-rs",
				"wm-mixed-hanoi",
				"wm-mixed-moscow",
				"wm-katakana-server",
				"wm-katakana-router",
			]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("prioritizes an exact long CJK fact over higher-importance partial shingle matches in memoriaRetrieve", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, timestamp)
				 VALUES (?, 1, 'IE', '國立故宮博物院', '位於台北', '國立故宮博物院收藏豐富', 0.99, ?),
				        (?, 2, 'IE', '國立臺灣大學', '位於台北', '國立臺灣大學是一所研究型大學', 0.85, ?),
				        (?, 3, 'IE', '北京天氣', '晴朗', '北京天氣預報', 0.99, ?),
				        (?, 4, 'IE', '北京大學', '頂尖學府', '北京大學排名位居前列', 0.85, ?)`,
				[
					beam.sessionId,
					timestamp,
					beam.sessionId,
					timestamp,
					beam.sessionId,
					timestamp,
					beam.sessionId,
					timestamp,
				],
			);

			const retrieved = memoriaRetrieve(beam, "國立臺灣大學", "IE", 1);
			expect(retrieved.ability).toBe("IE");
			expect((retrieved.results as Array<{ key?: string }>)[0]?.key).toBe("國立臺灣大學");

			const clauseRetrieved = memoriaRetrieve(beam, "請問北京大學的排名", "IE", 1);
			expect((clauseRetrieved.results as Array<{ key?: string }>)[0]?.key).toBe("北京大學");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("retains distinct 1-character mixed-script memories in diversityRerank", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-c-lang", "C語言支援指標", 0.85, timestamp);
			insertWorking(beam, "wm-r-lang", "R語言支援統計", 0.8, timestamp);
			insertWorking(beam, "wm-a-type", "A型 v2", 0.78, timestamp);
			insertWorking(beam, "wm-b-type", "B型 v2", 0.75, timestamp);

			const candidates = new Map([
				[
					"wm-c-lang",
					{
						memoryId: "wm-c-lang",
						combinedScore: 0.08,
						voiceScores: { hybrid: 0.08 },
						metadata: {},
					},
				],
				[
					"wm-r-lang",
					{
						memoryId: "wm-r-lang",
						combinedScore: 0.07,
						voiceScores: { hybrid: 0.07 },
						metadata: {},
					},
				],
				[
					"wm-a-type",
					{
						memoryId: "wm-a-type",
						combinedScore: 0.06,
						voiceScores: { hybrid: 0.06 },
						metadata: {},
					},
				],
				[
					"wm-b-type",
					{
						memoryId: "wm-b-type",
						combinedScore: 0.05,
						voiceScores: { hybrid: 0.05 },
						metadata: {},
					},
				],
			]);
			const reranked = engine.diversityRerank(candidates, 10, candidate => {
				const row = beam.db
					.query("SELECT id, content FROM working_memory WHERE id = ?")
					.get(candidate.memoryId) as { id: string; content: string } | null;
				if (!row) return null;
				return {
					id: row.id,
					content: row.content,
					score: candidate.combinedScore,
					combined_score: candidate.combinedScore,
					voice_scores: candidate.voiceScores,
					metadata: candidate.metadata,
					tier: "working",
					tier_label: "working",
				};
			});

			expect(reranked.map(r => r.id)).toEqual(["wm-c-lang", "wm-r-lang", "wm-a-type", "wm-b-type"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("matches consolidated facts with spaced mixed-script and spaced CJK subjects in factVoice", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-project-tokyo", "Project 東京 is on schedule", 0.9, timestamp);
			insertWorking(beam, "wm-seoul-univ", "서울 대학교 연구실", 0.9, timestamp);
			insertWorking(beam, "wm-seoul-unspaced", "서울대학교 위치 안내", 0.9, timestamp);
			insertWorking(beam, "wm-jp-server", "サーバー設定が完了", 0.9, timestamp);
			insertWorking(beam, "wm-jp-hw-server", "ｻｰﾊﾞｰ設定が完了", 0.9, timestamp);
			insertWorking(beam, "wm-moscow-cjk", "Москва支援CJK部署", 0.9, timestamp);
			insertWorking(beam, "wm-sf-branch", "サンフランシスコ支社の開設", 0.9, timestamp);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
				 VALUES
					('cf_proj_tokyo', 'Project 東京', 'status', 'on schedule', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_seoul_univ', '서울 대학교', 'location', 'Seoul', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_seoul_unspaced', '서울대학교', 'location', 'Seoul', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_jp_server', 'サーバー設定', 'status', 'ready', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_jp_hw_server', 'ｻｰﾊﾞｰ', 'status', 'ready', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_moscow_cjk', 'Москва', 'status', 'ready', 0.95, 2, ?, ?, ?, 'likely_true'),
					('cf_sf_branch', 'サンフランシスコ', 'status', 'opened', 0.95, 2, ?, ?, ?, 'likely_true')`,
				[
					timestamp,
					timestamp,
					JSON.stringify(["wm-project-tokyo"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-seoul-univ"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-seoul-unspaced"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-jp-server"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-jp-hw-server"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-moscow-cjk"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-sf-branch"]),
				],
			);

			expect(engine.factVoice("Project 東京").map(hit => hit.memoryId)).toContain("wm-project-tokyo");
			expect(engine.factVoice("Project 東京的進度").map(hit => hit.memoryId)).toContain("wm-project-tokyo");
			expect(engine.factVoice("서울 대학교").map(hit => hit.memoryId)).toContain("wm-seoul-univ");
			expect(engine.factVoice("서울대학교의 위치").map(hit => hit.memoryId)).toContain("wm-seoul-unspaced");
			expect(engine.factVoice("サーバー設定を確認").map(hit => hit.memoryId)).toContain("wm-jp-server");
			expect(engine.factVoice("ｻｰﾊﾞｰ設定を確認").map(hit => hit.memoryId)).toContain("wm-jp-hw-server");
			expect(engine.factVoice("查詢Москва支援CJK的進度").map(hit => hit.memoryId)).toContain("wm-moscow-cjk");
			expect(engine.factVoice("サンフランシスコについて").map(hit => hit.memoryId)).toContain("wm-sf-branch");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("promotes singleton-CJK identifiers to primary terms and ranks TypeA型 above TypeA", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', 'TypeA', 'Base ASCII model configuration', 'TypeA configuration', 0.95, 'wm-type-a'),
					(?, 1, 'entity', 'TypeA型', 'Variant model with singleton CJK suffix', 'TypeA型 configuration', 0.95, 'wm-type-a-cjk')`,
				[beam.sessionId, beam.sessionId],
			);
			const result = memoriaRetrieve(beam, "what is TypeA型", "IE", 1);
			expect(result.ability).toBe("IE");
			expect((result.results as Array<{ key?: string }>)[0]?.key).toBe("TypeA型");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("matches simplified Chinese copula questions like C语言是什么 in factVoice", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			insertWorking(beam, "wm-c-lang-sim", "C语言是一种通用的编程语言", 0.9, timestamp);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf_c_lang_sim', 'C语言', '定义', '编程语言', 0.95, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-c-lang-sim"])],
			);
			expect(engine.factVoice("C语言是什么").map(hit => hit.memoryId)).toContain("wm-c-lang-sim");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("downweights chronological timeline routing words so PostgreSQL wins at topK=1", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_timelines
					(session_id, event_id, date, description, source_memory_id)
					VALUES
					(?, 1, '2020-01-01', 'General chronological sequence of events and order of releases', 'wm-chronological-generic'),
					(?, 2, '2026-05-01', 'PostgreSQL cluster setup completed', 'wm-pg-cluster')`,
				[beam.sessionId, beam.sessionId],
			);
			const result = memoriaRetrieve(beam, "PostgreSQL chronological", "TR", 1);
			expect(result.ability).toBe("TR");
			expect((result.results as Array<{ event_id?: number }>)[0]?.event_id).toBe(2);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("excludes technical 最近 compounds from temporal routing and routes 最近公共祖先算法 to IE", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			expect(engine.temporalVoice("最近公共祖先算法")).toEqual([]);
			expect(engine.temporalVoice("最近点对问题")).toEqual([]);

			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', '最近公共祖先算法', 'LCA 算法實作細節', '最近公共祖先算法說明', 0.95, 'wm-lca')`,
				[beam.sessionId],
			);
			const result = memoriaRetrieve(beam, "最近公共祖先算法");
			expect(result.ability).toBe("IE");
			expect((result.results as Array<{ key?: string }>)[0]?.key).toBe("最近公共祖先算法");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("filters out were as a stopword in makeQuestionTokenGroups so subsequent terms are not dropped", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', 'hyperdrive', 'Hyperdrive engine propulsion system', 'hyperdrive specifications', 0.95, 'wm-hyperdrive')`,
				[beam.sessionId],
			);
			// Query with "were" plus multiple terms leading up to "hyperdrive"
			const result = memoriaRetrieve(beam, "what were alpha beta gamma delta epsilon zeta eta hyperdrive", "IE", 1);
			expect(result.ability).toBe("IE");
			expect((result.results as Array<{ key?: string }>)[0]?.key).toBe("hyperdrive");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("ranks exact primary fact subject matches ahead of higher-confidence shingle matches", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			// Beijing has confidence 0.95 (shingle), Peking University has confidence 0.60 (primary)
			const timestamp = new Date().toISOString();
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf-shingle', '北京', 'is', 'a city', 0.95, 10, ?, ?, ?, 'likely_true'),
					('cf-primary', '北京大學', 'ranks', 'number one', 0.60, 2, ?, ?, ?, 'likely_true')`,
				[
					timestamp,
					timestamp,
					JSON.stringify(["wm-beijing-city"]),
					timestamp,
					timestamp,
					JSON.stringify(["wm-pku-rank"]),
				],
			);
			const results = engine.factVoice("請問北京大學的排名", 1);
			expect(results.length).toBe(1);
			expect(results[0]?.memoryId).toBe("wm-pku-rank");
			expect(results[0]?.metadata.subject).toBe("北京大學");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("routes Japanese and Korean time questions to TR ability in memoriaRetrieve", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_timelines
					(session_id, event_id, date, description, source_memory_id)
					VALUES
					(?, 1, '2026-10-01', 'v1.0 リリース デプロイ 완료 배포', 'wm-timeline-deploy')`,
				[beam.sessionId],
			);
			const jpResult = memoriaRetrieve(beam, "いつデプロイしましたか");
			expect(jpResult.ability).toBe("TR");
			expect((jpResult.results as Array<{ description?: string }>)[0]?.description).toContain("v1.0 リリース");

			const krResult = memoriaRetrieve(beam, "언제 배포했나요");
			expect(krResult.ability).toBe("TR");
			expect((krResult.results as Array<{ description?: string }>)[0]?.description).toContain("배포");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("matches NFC subject in factVoice when query is NFD-normalized", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf-jp-server', 'サーバー設定', 'is', 'NFC subject', 0.9, 3, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-jp-server-nfc"])],
			);
			const nfdQuery = "サーバー設定を確認".normalize("NFD");
			const hits = engine.factVoice(nfdQuery);
			expect(hits.map(h => h.memoryId)).toContain("wm-jp-server-nfc");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("enables temporalVoice for 昨天的截止頻率是多少 while what is the 截止頻率 remains non-temporal", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const now = new Date();
			beam.db.run(
				`INSERT INTO working_memory
					(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
					VALUES
					('wm-temp-cutoff', '昨天的截止頻率數據', 'test', ?, ?, 0.8, '{}', 'unknown', 'unknown', 'global', ?)`,
				[now.toISOString(), beam.sessionId, now.toISOString()],
			);
			const temporalHits = engine.temporalVoice("昨天的截止頻率是多少");
			expect(temporalHits.map(h => h.memoryId)).toContain("wm-temp-cutoff");

			const nonTemporalHits = engine.temporalVoice("what is the 截止頻率");
			expect(nonTemporalHits).toEqual([]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("tokenizes sentence punctuation cleanly, routes 近期/最新 to TR, carries subject specificity into factScore, and preserves long particle-stripped MEMORIA subjects", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const timestamp = new Date().toISOString();
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES
					('cf-pg', 'PostgreSQL', 'is', 'relational DB', 0.9, 2, ?, ?, ?, 'likely_true'),
					('cf-rank', '排名', 'is', 'generic rank', 0.9, 2, ?, ?, ?, 'likely_true'),
					('cf-pku', '北京大學', 'is', 'top university', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[
					timestamp,
					timestamp,
					JSON.stringify(["wm-pg"]),
					timestamp,
					timestamp,
					JSON.stringify(["a_rank"]),
					timestamp,
					timestamp,
					JSON.stringify(["z_pku"]),
				],
			);

			// 1. Punctuation & hashtag boundary: "what is PostgreSQL?" and "#PostgreSQL" match "PostgreSQL"
			const pgHits = engine.factVoice("what is PostgreSQL?", 1);
			expect(pgHits[0]?.memoryId).toBe("wm-pg");
			const hashtagPgHits = engine.factVoice("請查詢 #PostgreSQL 的設定", 1);
			expect(hashtagPgHits[0]?.memoryId).toBe("wm-pg");

			// 2. Mixed-script Japanese possessive particle の: "C言語の仕様を確認" matches "C言語"
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf-clang', 'C言語', 'is', 'systems language', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-clang"])],
			);
			const clangHits = engine.factVoice("C言語の仕様を確認", 1);
			expect(clangHits[0]?.memoryId).toBe("wm-clang");

			// 3. Specificity tie-breaker: "北京大學" (4 chars) beats "排名" (2 chars) at equal confidence even with later memoryId
			const pkuHits = engine.factVoice("請問北京大學的排名", 1);
			expect(pkuHits[0]?.memoryId).toBe("z_pku");

			// 4. 近期 / 最新 route to TR in memoriaRetrieve and looksTemporal even when followed by 公共/距離
			beam.db.run(
				`INSERT INTO memoria_timelines (session_id, event_id, date, description, source_memory_id)
					VALUES (?, 1, '2026-10-30', '近期完成了公共 API 核心服務部署', 'tl-recent')`,
				[beam.sessionId],
			);
			expect(memoriaRetrieve(beam, "近期部署了什麼").ability).toBe("TR");
			expect(memoriaRetrieve(beam, "最新部署是什麼").ability).toBe("TR");
			expect(memoriaRetrieve(beam, "最新公共 API 部署").ability).toBe("TR");
			expect(memoriaRetrieve(beam, "近期公共服務變更").ability).toBe("TR");
			expect(memoriaRetrieve(beam, "最近公共祖先演算法").ability).not.toBe("TR");

			// 5. Long particle-stripped MEMORIA subject (>12 chars) preserved as primary
			beam.db.run(
				`INSERT INTO memoria_facts (session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', 'ソフ', 'unrelated shingle match', 'ソフ', 0.99, 'mf-shingle'),
					(?, 1, 'entity', 'ソフトウェア開発プロジェクト', 'exact long subject match', 'ソフトウェア開発プロジェクト', 0.60, 'mf-long')`,
				[beam.sessionId, beam.sessionId],
			);
			const longRes = memoriaRetrieve(beam, "ソフトウェア開発プロジェクトについて", undefined, 1);
			expect((longRes.results as Array<{ key?: string }>)[0]?.key).toBe("ソフトウェア開発プロジェクト");

			// 6. Cyrillic/non-ASCII case variants match Memoria facts across casing differences
			beam.db.run(
				`INSERT INTO memoria_facts (session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES (?, 2, 'entity', 'Москва', 'capital of Russia', 'what is Москва', 0.95, 'mf-moscow')`,
				[beam.sessionId],
			);
			const moscowRes = memoriaRetrieve(beam, "what is москва", "IE", 1);
			expect((moscowRes.results as Array<{ key?: string }>)[0]?.key).toBe("Москва");

			// 7. Simplified Chinese 后天 and 大后天 temporal routing
			expect(memoriaRetrieve(beam, "后天部署了什么").ability).toBe("TR");
			expect(memoriaRetrieve(beam, "大后天部署").ability).toBe("TR");

			// 8. diversityRerank preserves mixed-script memories with distinct Latin identifiers
			insertWorking(beam, "wm-pg-db", "PostgreSQL資料庫連線設定與備份策略", 0.9, timestamp);
			insertWorking(beam, "wm-my-db", "MySQL資料庫連線設定與備份策略", 0.85, timestamp);
			const mixedCandidates = new Map([
				[
					"wm-pg-db",
					{
						memoryId: "wm-pg-db",
						combinedScore: 0.1,
						voiceScores: { hybrid: 0.1 },
						metadata: {},
					},
				],
				[
					"wm-my-db",
					{
						memoryId: "wm-my-db",
						combinedScore: 0.09,
						voiceScores: { hybrid: 0.09 },
						metadata: {},
					},
				],
			]);
			const mixedReranked = engine.diversityRerank(mixedCandidates, 10, candidate => {
				const row = beam.db
					.query("SELECT id, content FROM working_memory WHERE id = ?")
					.get(candidate.memoryId) as { id: string; content: string } | null;
				if (!row) return null;
				return {
					id: row.id,
					content: row.content,
					score: candidate.combinedScore,
					combined_score: candidate.combinedScore,
					voice_scores: candidate.voiceScores,
					metadata: candidate.metadata,
					tier: "working",
					tier_label: "working",
				};
			});
			expect(mixedReranked.map(r => r.id)).toEqual(["wm-pg-db", "wm-my-db"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("excludes grammatical tenses (e.g. 过去式) from TR ability and routes what is 过去式 to IE", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', '过去式', 'past tense grammatical form', 'grammar reference', 0.95, 'wm-tense')`,
				[beam.sessionId],
			);
			const result = memoriaRetrieve(beam, "what is 过去式", null, 10);
			expect(result.ability).toBe("IE");
			expect(result.results.length).toBeGreaterThan(0);
			expect((result.results as Array<{ key?: string }>)[0]?.key).toBe("过去式");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("retains target in token budget for long queries with non-ASCII terms and retrieves both Москва and target facts", () => {
		const beam = makeBeam();
		try {
			beam.db.run(
				`INSERT INTO memoria_facts
					(session_id, message_idx, fact_type, key, value, context_snippet, importance, source_memory_id)
					VALUES
					(?, 0, 'entity', 'target', 'prod-cluster', 'deployment target specification', 0.9, 'wm-target'),
					(?, 0, 'entity', 'Москва', 'capital city', 'russian office deployment', 0.9, 'wm-moscow')`,
				[beam.sessionId, beam.sessionId],
			);
			const query = "what is москва project deployment status owner version target";
			const result = memoriaRetrieve(beam, query, "IE", 10);
			expect(result.ability).toBe("IE");
			const keys = (result.results as Array<{ key?: string }>).map(r => r.key);
			expect(keys).toContain("Москва");
			expect(keys).toContain("target");
		} finally {
			closeQuietly(beam.db);
		}
	});
});
