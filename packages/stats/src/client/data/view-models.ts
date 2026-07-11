import { rangeMeta } from "../components/range-meta";
import type {
	AgentType,
	AgentTypeStats,
	BehaviorOverallStats,
	BehaviorTimeSeriesPoint,
	CostTimeSeriesPoint,
	FolderStats,
	ModelPerformancePoint,
	TimeRange,
} from "../types";

/** Fixed display order for the agent-token-share breakdown. */
const AGENT_TYPE_ORDER: AgentType[] = ["main", "subagent", "advisor"];

export interface AgentTokenSegment {
	agentType: AgentType;
	/** input + output + cache read + cache write — the displayed denominator. */
	tokens: number;
	requests: number;
	cost: number;
	/** Fraction (0-1) of total tokens across all present agent types. */
	share: number;
}

export interface AgentTokenShareView {
	totalTokens: number;
	totalCost: number;
	segments: AgentTokenSegment[];
}

/**
 * Build the "token usage by agent" breakdown: one segment per agent type that
 * appears in the data, ordered main -> subagents -> advisor, each carrying its
 * token total and share of the grand total. Token counts sum the same four
 * columns the overview renders (input + output + cache read + cache write) so a
 * segment's share never disagrees with the count beside it.
 */
export function buildAgentTokenShare(stats: AgentTypeStats[]): AgentTokenShareView {
	const byType = new Map<AgentType, AgentTypeStats>();
	for (const stat of stats) byType.set(stat.agentType, stat);

	const tokensOf = (stat: AgentTypeStats) =>
		stat.totalInputTokens + stat.totalOutputTokens + stat.totalCacheReadTokens + stat.totalCacheWriteTokens;

	const present = AGENT_TYPE_ORDER.map(type => byType.get(type)).filter(
		(stat): stat is AgentTypeStats => stat !== undefined,
	);
	const totalTokens = present.reduce((sum, stat) => sum + tokensOf(stat), 0);
	const totalCost = present.reduce((sum, stat) => sum + stat.totalCost, 0);

	const segments = present.map(stat => {
		const tokens = tokensOf(stat);
		return {
			agentType: stat.agentType,
			tokens,
			requests: stat.totalRequests,
			cost: stat.totalCost,
			share: totalTokens > 0 ? tokens / totalTokens : 0,
		};
	});

	return { totalTokens, totalCost, segments };
}

export interface CostSummaryView {
	totalCost: number;
	avgDailyCost: number;
	topModelName: string;
	topModelCost: number;
}

export interface ModelPerformanceDataPoint {
	timestamp: number;
	avgTtftSeconds: number | null;
	avgTokensPerSecond: number | null;
	requests: number;
}

export interface ModelPerformanceSeries {
	label: string;
	data: ModelPerformanceDataPoint[];
}

export interface BehaviorSummaryView {
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalFrustration: number;
	highestFrictionModel: {
		model: string;
		provider: string;
		score: number;
	} | null;
}

export interface FolderRowView extends FolderStats {
	costPercentage: number;
	requestsPercentage: number;
}

export function buildCostSummary(costSeries: CostTimeSeriesPoint[]): CostSummaryView {
	const totalCost = costSeries.reduce((sum, p) => sum + p.cost, 0);
	const dayBuckets = new Set(costSeries.map(p => p.timestamp)).size;
	const avgDailyCost = dayBuckets > 0 ? totalCost / dayBuckets : 0;

	const modelTotals = new Map<string, number>();
	for (const point of costSeries) {
		modelTotals.set(point.model, (modelTotals.get(point.model) ?? 0) + point.cost);
	}

	let topModelName = "";
	let topModelCost = 0;
	for (const [model, cost] of modelTotals) {
		if (cost > topModelCost) {
			topModelName = model;
			topModelCost = cost;
		}
	}

	return {
		totalCost,
		avgDailyCost,
		topModelName,
		topModelCost,
	};
}

export function buildModelPerformanceLookup(
	points: ModelPerformancePoint[],
	range: TimeRange,
): Map<string, ModelPerformanceSeries> {
	if (points.length === 0) return new Map();

	const meta = rangeMeta(range);
	const bucketMs = meta.bucketMs;
	const bucketCount = meta.bucketCount;

	const buckets =
		bucketCount > 0
			? (() => {
					const maxTimestamp = points.reduce((max, point) => Math.max(max, point.timestamp), 0);
					const anchor = maxTimestamp > 0 ? maxTimestamp : Math.floor(Date.now() / bucketMs) * bucketMs;
					const start = anchor - (bucketCount - 1) * bucketMs;
					return Array.from({ length: bucketCount }, (_, index) => start + index * bucketMs);
				})()
			: Array.from(new Set(points.map(p => p.timestamp))).sort((a, b) => a - b);
	const bucketIndex = new Map(buckets.map((timestamp, index) => [timestamp, index]));
	const seriesByKey = new Map<string, ModelPerformanceSeries>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		let series = seriesByKey.get(key);
		if (!series) {
			series = {
				label: `${point.model} (${point.provider})`,
				data: buckets.map(timestamp => ({
					timestamp,
					avgTtftSeconds: null,
					avgTokensPerSecond: null,
					requests: 0,
				})),
			};
			seriesByKey.set(key, series);
		}

		const index = bucketIndex.get(point.timestamp);
		if (index === undefined) continue;

		series.data[index] = {
			timestamp: point.timestamp,
			avgTtftSeconds: point.avgTtft !== null ? point.avgTtft / 1000 : null,
			avgTokensPerSecond: point.avgTokensPerSecond,
			requests: point.requests,
		};
	}

	return seriesByKey;
}

export function buildBehaviorSummary(
	overall: BehaviorOverallStats,
	series: BehaviorTimeSeriesPoint[],
): BehaviorSummaryView {
	const totalFrustration = overall.totalNegation + overall.totalRepetition + overall.totalBlame;

	const totals = new Map<string, { model: string; provider: string; score: number }>();
	for (const point of series) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		const score = point.yelling + point.profanity + point.anguish + point.negation + point.repetition + point.blame;
		if (existing) {
			existing.score += score;
		} else {
			totals.set(key, { model: point.model, provider: point.provider, score });
		}
	}

	let highestFrictionModel: { model: string; provider: string; score: number } | null = null;
	for (const entry of totals.values()) {
		if (!highestFrictionModel || entry.score > highestFrictionModel.score) {
			highestFrictionModel = entry;
		}
	}

	return {
		totalMessages: overall.totalMessages,
		totalYelling: overall.totalYelling,
		totalProfanity: overall.totalProfanity,
		totalAnguish: overall.totalAnguish,
		totalFrustration,
		highestFrictionModel,
	};
}

export function buildFolderRows(folders: FolderStats[]): FolderRowView[] {
	const sorted = [...folders].sort((a, b) => {
		if (b.totalCost !== a.totalCost) {
			return b.totalCost - a.totalCost;
		}
		return b.totalRequests - a.totalRequests;
	});

	const maxCost = sorted.reduce((max, f) => Math.max(max, f.totalCost), 0);
	const maxRequests = sorted.reduce((max, f) => Math.max(max, f.totalRequests), 0);

	return sorted.map(f => ({
		...f,
		costPercentage: maxCost > 0 ? (f.totalCost / maxCost) * 100 : 0,
		requestsPercentage: maxRequests > 0 ? (f.totalRequests / maxRequests) * 100 : 0,
	}));
}
