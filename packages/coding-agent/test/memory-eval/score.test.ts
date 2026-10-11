import { describe, expect, it } from "bun:test";
import {
	compatRecall,
	cp,
	lmeEvaluateRetrieval,
	lmeEvaluateTurn2Session,
	lmeMetrics,
	messageLevelMetrics,
} from "../../bench/memory-eval/score";

describe("memory-eval score", () => {
	it("message metrics", () => {
		expect(messageLevelMetrics([["a"], ["x", "b"], ["c"]], ["b", "c"])).toEqual({
			"recall@1": 0,
			"recall@5": 1,
			"recall@10": 1,
			mrr: 0.5,
		});
	});

	it("empty ranking scores zero without NaN", () => {
		expect(messageLevelMetrics([], ["a"])).toEqual({ "recall@1": 0, "recall@5": 0, "recall@10": 0, mrr: 0 });
		expect(lmeMetrics([], ["s1_1"], ["s1_1", "s2_1"])["session.recall_all@5"]).toBe(0);
		for (const v of Object.values(lmeMetrics([], ["s1_1"], ["s1_1", "s2_1"]))) expect(Number.isNaN(v)).toBe(false);
	});

	it("turn2session widens k to distinct sessions", () => {
		const corpus = ["answer_a_1", "answer_a_3", "s_b_1", "answer_c_1"];
		// top-2 turns are both from session answer_a; widening reaches answer_c at index 3.
		expect(lmeEvaluateTurn2Session([0, 1, 2, 3], ["answer_a_1", "answer_c_1"], corpus, 3).recallAll).toBe(1);
		expect(lmeEvaluateRetrieval([0, 1, 2, 3], ["answer_a_1", "answer_c_1"], corpus, 2).recallAll).toBe(0);
	});

	it("turn2session widening terminates when fewer than k sessions exist", () => {
		const r = lmeEvaluateTurn2Session([0, 1], ["a_1"], ["a_1", "a_2"], 5);
		expect(r).toEqual({ recallAny: 1, recallAll: 1, ndcgAny: 1 });
	});

	it("ndcg matches official definition", () => {
		// Official dcg gives rank 1 and rank 2 discounts of 1 and 1/log2(2) = 1.
		expect(lmeEvaluateRetrieval([1, 0], ["d0"], ["d0", "d1"], 2).ndcgAny).toBeCloseTo(1, 12);
		expect(lmeEvaluateRetrieval([1, 2, 0], ["d0"], ["d0", "d1", "d2"], 3).ndcgAny).toBeCloseTo(1 / Math.log2(3), 12);
	});

	it("ndcg ideal sorts the whole corpus", () => {
		// Two relevant docs, only one retrieved in top 1: dcg 1, ideal dcg (k=1) 1.
		expect(lmeEvaluateRetrieval([0], ["d0", "d1"], ["d0", "d1", "d2"], 1).ndcgAny).toBe(1);
		// k=2 ideal = 1 + 1/log2(2) = 2; actual [1,0] = 1.
		expect(lmeEvaluateRetrieval([0, 2], ["d0", "d1"], ["d0", "d1", "d2"], 2).ndcgAny).toBeCloseTo(0.5, 12);
	});

	it("empty gold follows Python all([]) / any([])", () => {
		expect(lmeEvaluateRetrieval([0], [], ["d0"], 1)).toEqual({ recallAny: 0, recallAll: 1, ndcgAny: 0 });
	});

	it("lmeMetrics emits the expected keys", () => {
		expect(Object.keys(lmeMetrics([0], ["s1_1"], ["s1_1"])).sort()).toEqual(
			[
				"session.recall_any@5",
				"session.recall_all@5",
				"session.ndcg_any@5",
				"session.recall_any@10",
				"session.recall_all@10",
				"session.ndcg_any@10",
				"turn.recall_all@5",
				"turn.recall_all@10",
				"turn.ndcg_any@10",
				"turn.recall_all@50",
			].sort(),
		);
	});

	it("compat prefixes slice by code point", () => {
		const gold = `${"😀".repeat(50)}tail`;
		expect(cp(gold, 3)).toBe("😀😀😀");
		expect(compatRecall(["😀".repeat(50)], [gold], 10)).toBe(1);
		expect(compatRecall(["x", "y"], ["y"], 1)).toBe(0);
	});

	it("compat counts at most one hit per memory", () => {
		expect(compatRecall(["ab cd"], ["ab", "cd"], 10)).toBe(0.5);
		expect(compatRecall(["ab", "ab"], ["ab", "zz"], 10)).toBe(1);
	});
});
