import { describe, expect, it } from "bun:test";
import { buildAgentTokenShare, buildModelPerformanceLookup } from "../src/client/data/view-models";
import type { AgentTypeStats, ModelPerformancePoint } from "../src/shared-types";

const DAY = 24 * 60 * 60 * 1000;

describe("client view models", () => {
	it("keeps sparse all-time model performance buckets instead of dropping old points", () => {
		const points: ModelPerformancePoint[] = [
			{
				timestamp: DAY,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 1,
				avgTtft: 250,
				avgTokensPerSecond: 40,
			},
			{
				timestamp: DAY * 10,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 2,
				avgTtft: 500,
				avgTokensPerSecond: 60,
			},
		];

		const series = buildModelPerformanceLookup(points, "all").get("gpt-5.5::openai-codex");

		expect(series?.data.map(point => point.timestamp)).toEqual([DAY, DAY * 10]);
		expect(series?.data.map(point => point.requests)).toEqual([1, 2]);
		expect(series?.data.map(point => point.avgTtftSeconds)).toEqual([0.25, 0.5]);
	});
});

function agentStats(
	agentType: AgentTypeStats["agentType"],
	tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
	totalRequests = 1,
): AgentTypeStats {
	return {
		agentType,
		totalRequests,
		totalInputTokens: tokens.input,
		totalOutputTokens: tokens.output,
		totalCacheReadTokens: tokens.cacheRead ?? 0,
		totalCacheWriteTokens: tokens.cacheWrite ?? 0,
		totalCost: 0,
	};
}

describe("buildAgentTokenShare", () => {
	it("orders segments main -> subagent -> advisor and shares sum to 1", () => {
		// Insertion order is intentionally scrambled to prove the fixed ordering.
		const view = buildAgentTokenShare([
			agentStats("advisor", { input: 10, output: 10 }),
			agentStats("main", { input: 50, output: 30, cacheRead: 20 }),
			agentStats("subagent", { input: 40, output: 20 }),
		]);

		expect(view.segments.map(s => s.agentType)).toEqual(["main", "subagent", "advisor"]);
		// Denominator is input+output+cacheRead+cacheWrite: 100 + 60 + 20 = 180.
		expect(view.totalTokens).toBe(180);
		expect(view.segments[0].tokens).toBe(100);
		expect(view.segments[0].share).toBeCloseTo(100 / 180, 8);
		expect(view.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 8);
	});

	it("omits absent agent types and reports zero totals without dividing by zero", () => {
		const present = buildAgentTokenShare([agentStats("main", { input: 5, output: 5 })]);
		expect(present.segments.map(s => s.agentType)).toEqual(["main"]);
		expect(present.segments[0].share).toBe(1);

		const empty = buildAgentTokenShare([]);
		expect(empty.totalTokens).toBe(0);
		expect(empty.segments).toEqual([]);
	});
});
