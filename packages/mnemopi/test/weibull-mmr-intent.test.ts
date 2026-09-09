import { describe, expect, it } from "bun:test";
import { mmrRerank } from "@oh-my-pi/pi-mnemopi/core/mmr";
import { adjustWeights, classifyIntent } from "@oh-my-pi/pi-mnemopi/core/query-intent";
import {
	DEFAULT_HALFLIFE_HOURS,
	WEIBULL_PARAMS,
	weibullBoost,
	weibullDecayFactor,
} from "@oh-my-pi/pi-mnemopi/core/weibull";

describe("Weibull decay", () => {
	it("exposes parameters for memory types used by recall", () => {
		const expectedTypes = [
			"profile",
			"preference",
			"setup",
			"fact",
			"learning",
			"pattern",
			"project",
			"goal",
			"entity",
			"event",
			"issue",
			"request",
			"general",
		] as const;

		for (const type of expectedTypes) {
			expect(WEIBULL_PARAMS[type]).toHaveProperty("k");
			expect(WEIBULL_PARAMS[type]).toHaveProperty("eta");
		}
	});

	it("keeps stable profile memories longer than fast request memories", () => {
		const profileDecay = weibullDecayFactor(720, "profile");
		const requestDecay = weibullDecayFactor(720, "request");

		expect(profileDecay).toBeGreaterThan(requestDecay);
		expect(profileDecay).toBeGreaterThan(0.5);
	});

	it("decays request memories quickly", () => {
		expect(weibullDecayFactor(168, "request")).toBeLessThan(0.1);
	});

	it("gives a fresh memory a full boost", () => {
		const now = new Date("2026-05-30T12:00:00.000Z");
		expect(weibullBoost(now.toISOString(), now, "general")).toBeCloseTo(1.0, 5);
	});

	it("retains profiles longer than the default exponential fallback", () => {
		const age = 5000;
		const profileDecay = weibullDecayFactor(age, "profile");
		const exponentialDecay = Math.exp(-age / DEFAULT_HALFLIFE_HOURS);

		expect(profileDecay).toBeGreaterThan(exponentialDecay);
	});

	it("uses one-week exponential behavior for the general type", () => {
		const age = 168;
		expect(weibullDecayFactor(age, "general")).toBeCloseTo(Math.exp(-age / 168.0), 5);
	});

	it("returns zero for missing or invalid timestamps", () => {
		expect(weibullBoost("not-a-date", undefined, "general")).toBe(0.0);
		expect(weibullBoost(null, undefined, "general")).toBe(0.0);
	});

	it("clamps future timestamps to full boost", () => {
		const queryTime = new Date("2026-05-30T12:00:00.000Z");
		expect(weibullBoost("2026-05-30T13:00:00.000Z", queryTime, "general")).toBe(1.0);
	});
});

describe("Query intent", () => {
	it("classifies temporal queries", () => {
		const intent = classifyIntent("what happened last Monday");

		expect(intent.category).toBe("temporal");
		expect(intent.confidence).toBeGreaterThan(0.3);
		expect(intent.fts_bias).toBeGreaterThan(intent.vec_bias);
	});

	it("classifies factual queries", () => {
		expect(classifyIntent("what is the database password").category).toBe("factual");
	});

	it("classifies preference/entity overlap consistently with pattern order", () => {
		const intent = classifyIntent("what does Denis prefer for lunch");

		expect(["preference", "entity"]).toContain(intent.category);
		expect(intent.signals).toContain("entity");
		expect(intent.signals).toContain("preference");
	});

	it("classifies procedural queries", () => {
		const intent = classifyIntent("how do I deploy this project");

		expect(intent.category).toBe("procedural");
		expect(intent.vec_bias).toBeGreaterThan(intent.fts_bias);
	});

	it("falls back to general with zero confidence", () => {
		const intent = classifyIntent("hello world test");

		expect(intent.category).toBe("general");
		expect(intent.confidence).toBe(0.0);
		expect(intent.signals).toEqual([]);
	});

	it("adjusts and normalizes weights for temporal intent", () => {
		const intent = classifyIntent("what happened last week");
		const [vecWeight, ftsWeight, importanceWeight] = adjustWeights(0.5, 0.3, 0.2, intent);

		expect(ftsWeight).toBeGreaterThan(vecWeight);
		expect(vecWeight + ftsWeight + importanceWeight).toBeCloseTo(1.0, 5);
	});
});

describe("MMR reranking", () => {
	it("returns the highest-scoring result first and preserves requested length", () => {
		const results = [
			{ content: "database password is hunter2", score: 0.95 },
			{ content: "server runs on port 8080", score: 0.85 },
			{ content: "deploy script is in /opt/deploy", score: 0.8 },
		];

		const reranked = mmrRerank(results, 0.7, 3);

		expect(reranked).toHaveLength(3);
		expect(reranked[0]?.content).toBe("database password is hunter2");
	});

	it("diversifies similar high-scoring results", () => {
		const results = [
			{ content: "the database password is hunter2", score: 0.95 },
			{ content: "the database password was hunter2", score: 0.94 },
			{ content: "the database password should be hunter2", score: 0.93 },
			{ content: "unrelated topic about gardening", score: 0.5 },
		];

		const reranked = mmrRerank(results, 0.5, 3);

		expect(reranked.map(result => result.content)).toContain("unrelated topic about gardening");
	});

	it("handles single and empty result sets", () => {
		expect(mmrRerank([{ content: "only one result", score: 0.5 }])).toHaveLength(1);
		expect(mmrRerank([])).toHaveLength(0);
	});

	it("returns no results for non-positive topK", () => {
		const results = [
			{ content: "first", score: 0.9 },
			{ content: "second", score: 0.8 },
		];

		expect(mmrRerank(results, 0.7, 0)).toEqual([]);
		expect(mmrRerank(results, 0.7, -3)).toEqual([]);
	});

	it("accepts typed-array-backed custom similarity scoring", () => {
		const results = [
			{ content: "a", score: 0.9, vector: new Float32Array([1, 0]) },
			{ content: "b", score: 0.8, vector: new Float32Array([1, 0]) },
			{ content: "c", score: 0.7, vector: new Float32Array([0, 1]) },
		];
		const byContent = new Map(results.map(result => [result.content, result.vector] as const));
		const cosine = (left: string, right: string): number => {
			const leftVector = byContent.get(left);
			const rightVector = byContent.get(right);
			if (leftVector === undefined || rightVector === undefined) return 0;
			return (leftVector[0] ?? 0) * (rightVector[0] ?? 0) + (leftVector[1] ?? 0) * (rightVector[1] ?? 0);
		};

		const reranked = mmrRerank(results, 0.5, 2, cosine);

		expect(reranked.map(result => result.content)).toEqual(["a", "c"]);
	});
});
