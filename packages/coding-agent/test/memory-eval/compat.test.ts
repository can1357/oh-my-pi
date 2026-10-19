import { describe, expect, it } from "bun:test";
import { type CalibrationDump, compareCalibration, runUpstreamCompat } from "../../bench/memory-eval/compat";
import type { EngineAdapter, EngineOpenOptions, RememberItem } from "../../bench/memory-eval/engine";
import type { UpstreamCompatOps } from "../../bench/memory-eval/engines/mnemosyne";
import type { QuestionResult } from "../../bench/memory-eval/runner";
import type { UpstreamCompatConversation } from "../../bench/memory-eval/types";

interface Fake {
	engine: EngineAdapter & UpstreamCompatOps;
	opened: EngineOpenOptions[];
	remembered: RememberItem[];
	consolidated: Parameters<UpstreamCompatOps["consolidate"]>[];
}

/** Stores contents in insertion order; `recallRaw` returns the stored contents that contain the query. */
function fakeEngine(): Fake {
	const opened: EngineOpenOptions[] = [];
	const remembered: RememberItem[] = [];
	const consolidated: Parameters<UpstreamCompatOps["consolidate"]>[] = [];
	const contents: string[] = [];
	const engine: EngineAdapter & UpstreamCompatOps = {
		name: "mnemosyne",
		describe: async () => ({}),
		open: async (_evalCase, options) => {
			opened.push(options);
		},
		remember: async items => {
			remembered.push(...items);
			return items.map(item => {
				contents.push(item.content);
				return `w${contents.length - 1}`;
			});
		},
		vectorCount: async () => contents.length,
		vectorCoverage: async ids => ids.length,
		sleep: async () => {},
		unembeddedSummaries: async () => 0,
		recall: async () => [],
		close: async () => {},
		dispose: async () => {},
		warmup: async () => {},
		oldestWorking: async limit => contents.slice(0, limit).map((content, i) => ({ engineId: `w${i}`, content })),
		consolidate: async (...args) => {
			consolidated.push(args);
			return "e0";
		},
		recallRaw: async (query, k) => contents.filter(c => c.includes(query)).slice(0, k),
	};
	return { engine, opened, remembered, consolidated };
}

const conversations: UpstreamCompatConversation[] = [
	{
		messages: ["alpha one", "  ", "beta two", "alpha three"],
		questions: [
			{ text: "alpha", goldIndices: [0] },
			{ text: "beta", goldIndices: [2, 2, 9] },
			{ text: "skipped: no gold", goldIndices: [] },
			{ text: "", goldIndices: [0] },
		],
	},
	{ messages: ["😀".repeat(90), "gamma"], questions: [{ text: "gamma", goldIndices: [1] }] },
];

describe("runUpstreamCompat", () => {
	it("aborts when any remembered row has no vector, before consolidating", async () => {
		const fake = fakeEngine();
		fake.engine.vectorCoverage = async ids => ids.length - 1;
		await expect(runUpstreamCompat(fake.engine, conversations)).rejects.toThrow(
			"embeddings unavailable for mnemosyne: 1 of 5 remembered rows have no vector",
		);
		expect(fake.consolidated).toEqual([]);
	});

	it("aborts when the consolidated summary has no vector", async () => {
		const fake = fakeEngine();
		fake.engine.vectorCoverage = async ids => (ids.includes("e0") ? 0 : ids.length);
		await expect(runUpstreamCompat(fake.engine, conversations)).rejects.toThrow(
			"embeddings unavailable for mnemosyne: the consolidated summary e0 has no vector",
		);
	});

	it("ingests like upstream: one store, non-blank messages, global ids, source bench", async () => {
		const fake = fakeEngine();
		await runUpstreamCompat(fake.engine, conversations);
		expect(fake.opened.map(o => o.protocol)).toEqual(["upstream-compat"]);
		expect(fake.remembered.map(r => [r.messageId, r.content, r.source, r.importance])).toEqual([
			["0", "alpha one", "bench", 0.5],
			["1", "beta two", "bench", 0.5],
			["2", "alpha three", "bench", 0.5],
			["3", "😀".repeat(90), "bench", 0.5],
			["4", "gamma", "bench", 0.5],
		]);
	});

	it("consolidates the oldest rows with a code-point-sliced summary", async () => {
		const fake = fakeEngine();
		await runUpstreamCompat(fake.engine, conversations);
		expect(fake.consolidated).toEqual([
			[
				`alpha one | beta two | alpha three | ${"😀".repeat(80)} | gamma`,
				["w0", "w1", "w2", "w3", "w4"],
				"bench_consolidation",
				0.4,
				"global",
			],
		]);
	});

	it("scores asked questions with upstream's gold set and skips the rest", async () => {
		const results = await runUpstreamCompat(fakeEngine().engine, conversations);
		expect(results.map(r => [r.questionId, r.metrics["compat.recall@10"]])).toEqual([
			["0:0", 1],
			["0:1", 0.5], // gold {2, 9}: index 9 is outside the conversation, so it counts but never matches
			["1:0", 1],
		]);
		expect(results[0].compat).toEqual({
			question: "alpha",
			rankedContents: ["alpha one", "alpha three"],
			goldContents: ["alpha one"],
		});
		expect(results[1].compat?.goldContents).toEqual(["beta two", ""]);
	});
});

describe("compareCalibration", () => {
	const dumpOf = (results: QuestionResult[]): CalibrationDump => ({
		questions: results.map(r => ({
			conversation: Number(r.questionId.split(":")[0]),
			question: r.compat!.question,
			rankedContents: [...r.compat!.rankedContents],
			recall: r.metrics["compat.recall@10"],
		})),
		meanRecall: results.reduce((sum, r) => sum + r.metrics["compat.recall@10"], 0) / results.length,
	});

	it("reports no mismatch for identical runs", async () => {
		const results = await runUpstreamCompat(fakeEngine().engine, conversations);
		const b = { questions: results, aggregate: { "compat.recall@10": dumpOf(results).meanRecall } };
		expect(compareCalibration(dumpOf(results), b)).toEqual([]);
	});

	it("names the first differing rank, the recall and the mean", async () => {
		const results = await runUpstreamCompat(fakeEngine().engine, conversations);
		const b = { questions: results, aggregate: { "compat.recall@10": dumpOf(results).meanRecall } };
		const a = dumpOf(results);
		a.questions[0].rankedContents.reverse();
		a.questions[1].recall = 1;
		a.meanRecall = 0;
		const mismatches = compareCalibration(a, b);
		expect(mismatches).toHaveLength(3);
		expect(mismatches[0]).toContain("[0] conversation 0");
		expect(mismatches[0]).toContain("first differ at rank 0");
		expect(mismatches[1]).toContain("recall A 1, B 0.5");
		expect(mismatches[2]).toContain("meanRecall");
	});

	it("reports a question count difference", async () => {
		const results = await runUpstreamCompat(fakeEngine().engine, conversations);
		const a = dumpOf(results);
		a.questions.pop();
		const b = { questions: results, aggregate: { "compat.recall@10": a.meanRecall } };
		expect(compareCalibration(a, b)[0]).toBe("question count: A 2, B 3");
	});
});
