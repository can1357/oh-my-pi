import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadDataset } from "../../bench/memory-eval/datasets";
import type { DroppedRow, EngineAdapter, RecallHit, RememberItem } from "../../bench/memory-eval/engine";
import { oracleEngine, randomEngine } from "../../bench/memory-eval/engines/sanity";
import { buildResultFile, primaryMetric, runCases } from "../../bench/memory-eval/runner";
import type { EvalCase, EvalMessage } from "../../bench/memory-eval/types";

const fixtureDir = path.join(import.meta.dir, "fixtures", "data");

let tmp: string;
beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-runner-"));
});
afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const msg = (messageId: string, content: string): EvalMessage => ({
	messageId,
	sessionId: "s",
	role: "user",
	content,
});

const caseOf = (messages: EvalMessage[], goldMessageIds: string[]): EvalCase => ({
	caseId: "c/1",
	dataset: "beam-100k",
	messages,
	questions: [{ questionId: "q1", text: "q", category: "cat", goldMessageIds, goldSessionIds: [] }],
});

const twoMessageCase = caseOf([msg("m1", "alpha beta"), msg("m2", "Gamma   DELTA, the second message")], ["m2"]);

interface FakeOptions {
	rowIds: (items: readonly RememberItem[]) => (string | null)[];
	hits: RecallHit[];
	vectors?: number;
	dropped?: DroppedRow[];
	onSleep?: () => void;
}

function fakeEngine(options: FakeOptions): EngineAdapter {
	return {
		name: "mnemopi",
		describe: async () => ({}),
		open: async () => {},
		remember: async items => options.rowIds(items),
		// Unset: every remembered row has its vector.
		vectorCount: async () => options.vectors ?? Number.POSITIVE_INFINITY,
		sleep: async () => options.onSleep?.(),
		recall: async (_question, k) => options.hits.slice(0, k),
		lastDropped: () => options.dropped ?? [],
		close: async () => {},
		dispose: async () => {},
		warmup: async () => {},
	};
}

const hit = (engineId: string, content: string, summaryOf: string[] = []): RecallHit => ({
	engineId,
	tier: "working",
	content,
	summaryOf,
});

describe("runner", () => {
	/** The best recall@k any ranking of k memories can reach: k slots cannot hold more than k gold messages. */
	const ceiling = (k: number, gold: readonly string[]): number => Math.min(1, k / new Set(gold).size);

	it("oracle reaches the recall ceiling on every question", async () => {
		const { cases } = await loadDataset("beam-100k", fixtureDir);
		const { questions } = await runCases(oracleEngine(), cases, "standard", 10, tmp);
		const gold = new Map(cases.flatMap(c => c.questions).map(q => [q.questionId, q.goldMessageIds]));
		expect(questions.length).toBeGreaterThan(0);
		for (const q of questions) {
			expect(q.metrics["recall@10"]).toBe(ceiling(10, gold.get(q.questionId)!));
			expect(q.metrics.mrr).toBe(1);
		}
	});
	it("oracle recall@10 is 10/11 with 11 gold messages", async () => {
		const messages = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `text ${i}`));
		const elevenGold = caseOf(
			messages,
			messages.slice(0, 11).map(m => m.messageId),
		);
		const { questions } = await runCases(oracleEngine(), [elevenGold], "standard", 10, tmp);
		expect(questions[0].ranked).toHaveLength(10);
		expect(questions[0].metrics["recall@10"]).toBe(ceiling(10, elevenGold.questions[0].goldMessageIds));
		expect(questions[0].metrics["recall@10"]).toBeCloseTo(10 / 11, 12);
	});
	it("oracle scores perfect LongMemEval session recall", async () => {
		const { cases } = await loadDataset("lme-s", fixtureDir);
		const { questions } = await runCases(oracleEngine(), cases, "standard", 50, tmp);
		expect(questions.every(r => r.metrics["session.recall_all@5"] === 1)).toBe(true);
		expect(questions[0].lme?.rankings[0]).toBe(0);
	});
	it("random engine is deterministic across runs", async () => {
		const { cases } = await loadDataset("beam-100k", fixtureDir);
		const a = await runCases(randomEngine(), cases, "standard", 10, tmp);
		const b = await runCases(randomEngine(), cases, "standard", 10, tmp);
		expect(a.questions.map(q => q.ranked)).toEqual(b.questions.map(q => q.ranked));
	});
	it("sanity engines return only the top k hits", async () => {
		const { cases } = await loadDataset("beam-100k", fixtureDir);
		for (const engine of [oracleEngine(), randomEngine()]) {
			const { questions } = await runCases(engine, cases, "standard", 2, tmp);
			expect(questions.map(q => q.ranked.length)).toEqual(questions.map(() => 2));
		}
	});
	it("oracle ranks each gold message once", async () => {
		// Ten copies of m1 ahead of m2 must not push m2 out of the top 10.
		const repeated = caseOf([msg("m1", "alpha"), msg("m2", "beta")], [...Array(10).fill("m1"), "m2"]);
		const { questions } = await runCases(oracleEngine(), [repeated], "standard", 10, tmp);
		expect(questions[0].ranked.map(h => h.messageIds)).toEqual([["m1"], ["m2"]]);
		expect(questions[0].metrics["recall@10"]).toBe(1);
	});
	it("duplicate content maps one row to every message", async () => {
		const dupCase = caseOf([msg("m1", "same text"), msg("m2", "same text")], ["m2"]);
		const engine = fakeEngine({ rowIds: items => items.map(() => "row-1"), hits: [hit("row-1", "same text")] });
		const { questions } = await runCases(engine, [dupCase], "standard", 10, tmp);
		expect(questions[0].ranked[0].messageIds).toEqual(["m1", "m2"]);
		expect(questions[0].metrics["recall@10"]).toBe(1);
	});
	it("episodic hits map through summaryOf and unknown rows fall back to content", async () => {
		const engine = fakeEngine({
			rowIds: items => items.map((_, i) => `r${i + 1}`),
			hits: [
				{ engineId: "e1", tier: "episodic", content: "summary", summaryOf: ["r1", "r2"] },
				hit("unknown", "prefix: gamma delta, the second message, and more text"),
			],
		});
		const { questions } = await runCases(engine, [twoMessageCase], "standard", 10, tmp);
		expect(questions[0].ranked.map(h => [h.messageIds, h.viaFallback])).toEqual([
			[["m1", "m2"], false],
			[["m2"], true],
		]);
		const file = buildResultFile(
			{
				dataset: "beam-100k",
				datasetRevision: "r",
				engine: "mnemopi",
				engineInfo: {},
				protocol: "standard",
				k: 10,
				mnemopiRecall: "recall",
				polyphonic: false,
				gitCommit: "g",
				gitDirty: false,
				startedAt: "t",
			},
			await runCases(engine, [twoMessageCase], "standard", 10, tmp),
			[],
		);
		expect(file.fallbackRate).toBe(0.5);
	});
	it("a hit that maps to nothing stays in the ranking and is not a fallback match", async () => {
		const engine = fakeEngine({ rowIds: items => items.map((_, i) => `r${i}`), hits: [hit("zzz", "nothing alike")] });
		const { questions } = await runCases(engine, [twoMessageCase], "standard", 10, tmp);
		expect(questions[0].ranked[0].messageIds).toEqual([]);
		expect(questions[0].ranked[0].viaFallback).toBe(false);
		expect(questions[0].metrics["recall@10"]).toBe(0);
	});
	it("the content fallback ignores messages shorter than 20 characters", async () => {
		// "ok" is a whole message: any hit that says "ok" would otherwise count as recalling it.
		const shortGold = caseOf([msg("m1", "ok"), msg("m2", "a message long enough to match on its prefix")], ["m1"]);
		const engine = fakeEngine({
			rowIds: items => items.map((_, i) => `r${i}`),
			hits: [hit("zzz", "I think it is ok to proceed")],
		});
		const { questions } = await runCases(engine, [shortGold], "standard", 10, tmp);
		expect(questions[0].ranked[0].messageIds).toEqual([]);
		expect(questions[0].metrics["recall@10"]).toBe(0);
	});
	it("standard run aborts when the engine stored no vectors", async () => {
		const engine = fakeEngine({ rowIds: items => items.map((_, i) => `r${i}`), hits: [], vectors: 0 });
		await expect(runCases(engine, [twoMessageCase], "standard", 10, tmp)).rejects.toThrow("embeddings unavailable");
	});
	it("fts-only skips the vector check", async () => {
		const engine = fakeEngine({ rowIds: items => items.map((_, i) => `r${i}`), hits: [], vectors: 0 });
		const { questions } = await runCases(engine, [twoMessageCase], "fts-only", 10, tmp);
		expect(questions).toHaveLength(1);
	});
	it("aborts when any case leaves a remembered row without a vector, not only the first", async () => {
		let opened = 0;
		const engine: EngineAdapter = {
			...fakeEngine({ rowIds: items => items.map((_, i) => `r${i}`), hits: [] }),
			open: async () => {
				opened++;
			},
			// Case 1 stores both rows' vectors; case 2 loses one.
			vectorCount: async () => (opened === 1 ? 2 : 1),
		};
		const cases = [twoMessageCase, { ...twoMessageCase, caseId: "c/2" }];
		await expect(runCases(engine, cases, "standard", 10, tmp)).rejects.toThrow(
			"embeddings unavailable for mnemopi: 1 of 2 remembered rows in case c/2 have no vector",
		);
		opened = 0;
		expect((await runCases(engine, cases, "fts-only", 10, tmp)).questions).toHaveLength(2);
	});
	it("builds aggregates, nearest-rank latency percentiles and the primary metric", async () => {
		const { cases } = await loadDataset("lme-s", fixtureDir);
		const run = await runCases(oracleEngine(), cases, "standard", 50, tmp);
		const file = buildResultFile(
			{
				dataset: "lme-s",
				datasetRevision: "r",
				engine: "oracle",
				engineInfo: {},
				protocol: "standard",
				k: 50,
				mnemopiRecall: "recall",
				polyphonic: false,
				gitCommit: "g",
				gitDirty: false,
				startedAt: "t",
			},
			run,
			[],
		);
		expect(file.aggregate[primaryMetric("lme-s")]).toBe(1);
		expect(file.aggregate["latency.p50"]).toBeGreaterThanOrEqual(0);
		expect(file.perCategory[run.questions[0].category]).toBeDefined();
		expect(primaryMetric("beam-500k")).toBe("recall@10");
	});

	it("records dropped derived rows and counts the ones that map to a gold message", async () => {
		const engine = fakeEngine({
			rowIds: items => items.map((_, i) => `r${i + 1}`),
			hits: [hit("r1", "alpha beta")],
			dropped: [
				{ tier: "memoria_source", engineId: "memoria_source_r2", sourceMemoryId: "r2", rank: 0 },
				{ tier: "memoria", engineId: "memoria_1", sourceMemoryId: null, rank: 3 },
			],
		});
		const run = await runCases(engine, [twoMessageCase], "standard", 10, tmp);
		expect(run.questions[0].dropped).toEqual([
			{ tier: "memoria_source", messageIds: ["m2"], rank: 0, gold: true },
			{ tier: "memoria", messageIds: [], rank: 3, gold: false },
		]);
		// Dropped rows never enter the ranking or the score.
		expect(run.questions[0].ranked).toHaveLength(1);
		const file = buildResultFile(
			{
				dataset: "beam-100k",
				datasetRevision: "r",
				engine: "mnemosyne",
				engineInfo: {},
				protocol: "standard",
				k: 10,
				mnemopiRecall: "recall",
				polyphonic: false,
				gitCommit: "g",
				gitDirty: false,
				startedAt: "t",
			},
			run,
			[],
		);
		expect(file.droppedRows).toBe(2);
		expect(file.droppedGoldRows).toBe(1);
	});

	it("scores recall over the deduplicated gold ids", async () => {
		// Real BEAM has questions whose gold list repeats an id.
		const engine = fakeEngine({
			rowIds: items => items.map((_, i) => `r${i + 1}`),
			hits: [hit("r2", "Gamma   DELTA")],
		});
		const repeated = caseOf(twoMessageCase.messages, ["m2", "m2"]);
		expect((await runCases(engine, [repeated], "standard", 10, tmp)).questions[0].metrics["recall@10"]).toBe(1);
		const mixed = caseOf(twoMessageCase.messages, ["m1", "m1", "m2"]);
		expect((await runCases(engine, [mixed], "standard", 10, tmp)).questions[0].metrics["recall@10"]).toBe(0.5);
	});

	it("with-sleep sleeps once per case and standard never does", async () => {
		let sleeps = 0;
		const engine = fakeEngine({
			rowIds: items => items.map((_, i) => `r${i}`),
			hits: [],
			onSleep: () => {
				sleeps++;
			},
		});
		const cases = [twoMessageCase, { ...twoMessageCase, caseId: "c/2" }];
		await runCases(engine, cases, "with-sleep", 10, tmp);
		expect(sleeps).toBe(2);
		await runCases(engine, cases, "standard", 10, tmp);
		expect(sleeps).toBe(2);
	});

	it("names store directories by case index, so a case id of .. stays inside the store root", async () => {
		const parent = await fs.mkdtemp(path.join(tmp, "escape-"));
		const storeRoot = path.join(parent, "stores");
		await fs.mkdir(storeRoot);
		const sentinel = path.join(parent, "sentinel");
		await Bun.write(sentinel, "keep");
		const oracle = oracleEngine();
		const opened: string[] = [];
		const engine: EngineAdapter = {
			...oracle,
			open: async (evalCase, options) => {
				opened.push(path.relative(storeRoot, options.storeDir));
				await oracle.open(evalCase, options);
			},
		};
		const cases = [
			{ ...twoMessageCase, caseId: ".." },
			{ ...twoMessageCase, caseId: "../x" },
		];
		await runCases(engine, cases, "standard", 10, storeRoot);
		expect(await Bun.file(sentinel).exists()).toBe(true);
		expect(opened).toEqual(["0", "1"]);
	});

	/** A LongMemEval case whose messages are `ids` (`<session>_<turn>`), with gold `gold`; the fake ranks `hits`. */
	const lmeCase = (ids: string[], gold: string[]): EvalCase => ({
		...caseOf(
			ids.map(id => msg(id, `turn ${id}`)),
			gold,
		),
		dataset: "lme-s",
	});

	it("LongMemEval asks for a ranking deep enough for session-level widening", async () => {
		// 50 turns of one session, then the gold turn of another: session@5 widens past turn 50 to find a 2nd session.
		const ids = [...Array.from({ length: 50 }, (_, i) => `sA_${i + 1}`), "answer_sB_1"];
		const engine = fakeEngine({
			rowIds: items => items.map(item => item.messageId),
			hits: ids.map(id => hit(id, "")),
		});
		const { questions } = await runCases(engine, [lmeCase(ids, ["answer_sB_1"])], "standard", 50, tmp);
		expect(questions[0].metrics["turn.recall_all@50"]).toBe(0);
		expect(questions[0].metrics["session.recall_all@5"]).toBe(1);
	});

	it("LongMemEval keeps an unmapped hit's rank as a non-gold position", async () => {
		const ids = ["s1_1", "s2_1", "answer_s3_1"];
		const engine = fakeEngine({
			rowIds: items => items.map(item => item.messageId),
			hits: [...["u1", "u2", "u3", "u4", "u5"].map(id => hit(id, "nothing alike")), hit("answer_s3_1", "")],
		});
		const { questions } = await runCases(engine, [lmeCase(ids, ["answer_s3_1"])], "standard", 50, tmp);
		expect(questions[0].ranked.map(h => h.messageIds)).toEqual([[], [], [], [], [], ["answer_s3_1"]]);
		// The gold turn is 6th: outside the top 5 turns, and behind 5 other documents at session level.
		expect(questions[0].metrics["turn.recall_all@5"]).toBe(0);
		expect(questions[0].metrics["session.recall_all@5"]).toBe(0);
		expect(questions[0].metrics["turn.recall_all@10"]).toBe(1);
		expect(questions[0].metrics["session.recall_all@10"]).toBe(1);
	});

	it("with-sleep refuses LongMemEval, whose corpus ranks cannot hold a summary covering several sessions", async () => {
		let warmed = false;
		const engine: EngineAdapter = {
			...oracleEngine(),
			warmup: async () => {
				warmed = true;
			},
		};
		await expect(runCases(engine, [lmeCase(["s1_1"], ["s1_1"])], "with-sleep", 50, tmp)).rejects.toThrow(
			"with-sleep does not support LongMemEval",
		);
		expect(warmed).toBe(false);
	});
});
