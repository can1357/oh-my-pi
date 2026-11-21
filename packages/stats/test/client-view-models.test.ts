import { describe, expect, it } from "bun:test";
import { SERIES_COLORS } from "../src/client/data/colors";
import { formatEstimatedCost } from "../src/client/data/formatters";
import {
	buildCostSummary,
	buildDecisionModelShare,
	buildModelPerformanceLookup,
	buildUsageTokenShare,
} from "../src/client/data/view-models";
import type { AgentTypeStats, CostTimeSeriesPoint, ModelPerformancePoint, SideChannelStats } from "../src/shared-types";

const DAY = 24 * 60 * 60 * 1000;

describe("client view models", () => {
	it("keeps sparse model performance buckets in time order instead of dropping old points", () => {
		const points: ModelPerformancePoint[] = [
			{
				timestamp: DAY * 10,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 2,
				avgTtft: 500,
				avgTokensPerSecond: 60,
			},
			{
				timestamp: DAY,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 1,
				avgTtft: 250,
				avgTokensPerSecond: 40,
			},
			{
				timestamp: DAY * 5,
				model: "gpt-5.5",
				provider: "openai",
				requests: 3,
				avgTtft: null,
				avgTokensPerSecond: null,
			},
		];

		const lookup = buildModelPerformanceLookup(points);
		const series = lookup.get("gpt-5.5::openai-codex");

		expect(series?.map(point => point.timestamp)).toEqual([DAY, DAY * 10]);
		expect(series?.map(point => point.requests)).toEqual([1, 2]);
		expect(series?.map(point => point.avgTtftSeconds)).toEqual([0.25, 0.5]);
		expect(lookup.get("gpt-5.5::openai")?.map(point => point.avgTtftSeconds)).toEqual([null]);
	});
});

function costPoint(timestamp: number, model: string, provider: string, cost: Partial<CostTimeSeriesPoint> = {}) {
	return {
		timestamp,
		model,
		provider,
		cost: 0,
		unpricedRequests: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		requests: 1,
		...cost,
	} satisfies CostTimeSeriesPoint;
}

describe("buildCostSummary", () => {
	it("aggregates per model+provider, ranks by estimate, and averages over active days", () => {
		const summary = buildCostSummary([
			costPoint(DAY, "sonnet", "anthropic", { cost: 3, costInput: 1, costOutput: 2, requests: 2 }),
			costPoint(DAY, "sonnet", "bedrock", { cost: 1, costOutput: 1 }),
			costPoint(DAY * 3, "sonnet", "anthropic", { cost: 2, costCacheRead: 0.5, costCacheWrite: 1.5 }),
			costPoint(DAY * 3, "grok", "xai-oauth", { unpricedRequests: 4, requests: 4 }),
		]);

		expect(summary.totalCost).toBe(6);
		expect(summary.activeDays).toBe(2);
		expect(summary.avgDailyCost).toBe(3);
		expect(summary.unpricedRequests).toBe(4);
		expect(summary.requests).toBe(8);
		expect([summary.costInput, summary.costOutput, summary.costCacheRead, summary.costCacheWrite]).toEqual([
			1, 3, 0.5, 1.5,
		]);
		expect(summary.models.map(m => m.key)).toEqual(["sonnet::anthropic", "sonnet::bedrock", "grok::xai-oauth"]);
		expect(summary.models[0]).toMatchObject({ cost: 5, requests: 3, costCacheWrite: 1.5 });
		expect(summary.models[0].share).toBeCloseTo(5 / 6, 8);
		expect(summary.topModel?.key).toBe("sonnet::anthropic");
	});

	it("reports no top model when every request is unpriced", () => {
		const summary = buildCostSummary([costPoint(DAY, "grok", "xai-oauth", { unpricedRequests: 2, requests: 2 })]);
		expect(summary.topModel).toBeNull();
		expect(summary.models[0].share).toBe(0);
		expect(formatEstimatedCost(summary.totalCost, summary.unpricedRequests)).toBe("N/A");
	});
});

describe("API-equivalent cost formatting", () => {
	it("distinguishes unpriced subscription usage from a zero-dollar estimate", () => {
		expect(formatEstimatedCost(0, 1)).toBe("N/A");
		expect(formatEstimatedCost(0, 0)).toBe("$0");
		expect(formatEstimatedCost(1.5, 1)).toBe("$1.50");
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

describe("buildUsageTokenShare", () => {
	it("orders segments main -> subagent -> advisor and shares sum to 1", () => {
		// Insertion order is intentionally scrambled to prove the fixed ordering.
		const view = buildUsageTokenShare(
			[
				agentStats("advisor", { input: 10, output: 10 }),
				agentStats("main", { input: 50, output: 30, cacheRead: 20 }),
				agentStats("subagent", { input: 40, output: 20 }),
			],
			[],
		);

		expect(view.segments.map(s => s.key)).toEqual(["agent:main", "agent:subagent", "agent:advisor"]);
		// Denominator is input+output+cacheRead+cacheWrite: 100 + 60 + 20 = 180.
		expect(view.totalTokens).toBe(180);
		expect(view.segments[0].tokens).toBe(100);
		expect(view.segments[0].share).toBeCloseTo(100 / 180, 8);
		expect(view.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 8);
	});

	it("omits absent agent types and reports zero totals without dividing by zero", () => {
		const present = buildUsageTokenShare([agentStats("main", { input: 5, output: 5 })], []);
		expect(present.segments.map(s => s.key)).toEqual(["agent:main"]);
		expect(present.segments[0].share).toBe(1);

		const empty = buildUsageTokenShare([], []);
		expect(empty.totalTokens).toBe(0);
		expect(empty.segments).toEqual([]);
	});
});

function sideChannelStats(category: string, decision: boolean, tokens: number): SideChannelStats {
	return {
		category,
		decision,
		totalRequests: 1,
		totalInputTokens: tokens,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalCost: 0,
	};
}

describe("side channels in the token share", () => {
	const agents = [agentStats("subagent", { input: 30, output: 0 }), agentStats("main", { input: 50, output: 0 })];
	const sideChannels = [
		sideChannelStats("progress", false, 5),
		sideChannelStats("judge", true, 60),
		sideChannelStats("title", false, 15),
		sideChannelStats("find", true, 20),
		// The same category served by a language model stays in the bar.
		sideChannelStats("judge", false, 10),
	];

	it("carves language-model side channels into the bar after the agents and leaves decision models out", () => {
		const view = buildUsageTokenShare(agents, sideChannels);

		expect(view.segments.map(s => s.key)).toEqual([
			"agent:main",
			"agent:subagent",
			"side:title",
			"side:judge",
			"side:progress",
		]);
		// 50 + 30 turns, 15 + 10 + 5 side channels; the 80 decision-model tokens are not in the bar.
		expect(view.totalTokens).toBe(110);
		expect(view.segments[3].tokens).toBe(10);
		expect(view.segments[2].share).toBeCloseTo(15 / 110, 8);
		expect(view.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 8);
	});

	it("shares decision-model usage per use case, and has no segments without any", () => {
		const view = buildDecisionModelShare(sideChannels);
		expect(view.segments.map(s => [s.key, s.tokens, s.share])).toEqual([
			["side:judge", 60, 0.75],
			["side:find", 20, 0.25],
		]);

		expect(buildDecisionModelShare([sideChannelStats("title", false, 15)]).segments).toEqual([]);
	});

	it("colors each view's categories with distinct hues, none of them an agent's in the bar", () => {
		const bar = buildUsageTokenShare(agents, sideChannels).categoryColors;
		const agentHues = SERIES_COLORS.slice(0, 3);
		expect([...bar.keys()].sort()).toEqual(["judge", "progress", "title"]);
		expect(new Set(bar.values()).size).toBe(3);
		expect([...bar.values()].filter(color => agentHues.includes(color))).toEqual([]);

		// The card has no agent segments, so its categories rank over the whole palette.
		const card = buildDecisionModelShare(sideChannels).categoryColors;
		expect([...card.keys()].sort()).toEqual(["find", "judge"]);
		expect(new Set(card.values()).size).toBe(2);
	});
});
