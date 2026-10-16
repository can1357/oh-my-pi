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

const twoMessageCase = caseOf([msg("m1", "alpha beta"), msg("m2", "Gamma   DELTA")], ["m2"]);

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
		rssScope: "engine-process",
		describe: async () => ({}),
		open: async () => {},
		remember: async items => options.rowIds(items),
		vectorCount: async () => options.vectors ?? 1,
		sleep: async () => options.onSleep?.(),
		recall: async () => options.hits,
		lastDropped: () => options.dropped ?? [],
		close: async () => {},
		dispose: async () => {},
		warmup: async () => {},
		resources: async () => ({ peakRssBytes: 2, baselineRssBytes: 1 }),
	};
}

const hit = (engineId: string, content: string, summaryOf: string[] = []): RecallHit => ({
	engineId,
	tier: "working",
	content,
	summaryOf,
});

describe("runner", () => {
	it("oracle scores perfect primary metrics", async () => {
		const { cases } = await loadDataset("beam-100k", fixtureDir);
		const { questions } = await runCases(oracleEngine(), cases, "standard", 10, tmp);
		expect(questions.length).toBeGreaterThan(0);
		expect(questions.every(r => r.metrics["recall@10"] === 1 && r.metrics.mrr === 1)).toBe(true);
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
				hit("unknown", "prefix: gamma delta, more text"),
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
				gitCommit: "g",
				startedAt: "t",
			},
			await runCases(engine, [twoMessageCase], "standard", 10, tmp),
			[],
		);
		expect(file.fallbackRate).toBe(0.5);
	});
	it("a hit that maps to nothing stays in the ranking", async () => {
		const engine = fakeEngine({ rowIds: items => items.map((_, i) => `r${i}`), hits: [hit("zzz", "nothing alike")] });
		const { questions } = await runCases(engine, [twoMessageCase], "standard", 10, tmp);
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
				gitCommit: "g",
				startedAt: "t",
			},
			run,
			[],
		);
		expect(file.aggregate[primaryMetric("lme-s")]).toBe(1);
		expect(file.aggregate["latency.p50"]).toBeGreaterThanOrEqual(0);
		expect(file.resources.rssScope).toBe("harness-process");
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
				gitCommit: "g",
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
});
