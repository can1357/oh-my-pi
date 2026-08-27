import { rangeMeta } from "../components/range-meta";
import type {
	AgentType,
	AgentTypeStats,
	BehaviorOverallStats,
	BehaviorTimeSeriesPoint,
	CostTimeSeriesPoint,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ProviderAggregate,
	TimeRange,
	ToolUsageStats,
} from "../types";

/** Fixed display order for the agent-token-share breakdown. */
const AGENT_TYPE_ORDER: AgentType[] = ["main", "subagent", "advisor"];

export interface ConversationTokenStats {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
}

/** Sum every conversation-token bucket shown by the overview. */
export function sumConversationTokens(stats: ConversationTokenStats): number {
	return stats.totalInputTokens + stats.totalOutputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens;
}

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
 * token total and share of the grand total. Token counts use the same four
 * conversation-token buckets as the overview total so the two views reconcile.
 */
export function buildAgentTokenShare(stats: AgentTypeStats[]): AgentTokenShareView {
	const byType = new Map<AgentType, AgentTypeStats>();
	for (const stat of stats) byType.set(stat.agentType, stat);

	const present = AGENT_TYPE_ORDER.map(type => byType.get(type)).filter(
		(stat): stat is AgentTypeStats => stat !== undefined,
	);
	const totalTokens = present.reduce((sum, stat) => sum + sumConversationTokens(stat), 0);
	const totalCost = present.reduce((sum, stat) => sum + stat.totalCost, 0);

	const segments = present.map(stat => {
		const tokens = sumConversationTokens(stat);
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
	unpricedRequests: number;
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
	const unpricedRequests = costSeries.reduce((sum, point) => sum + point.unpricedRequests, 0);
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
		unpricedRequests,
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

/** Table row for the Tools route: usage stats plus derived rates/shares. */
export interface ToolRowView extends ToolUsageStats {
	/** errors / calls (0 for zero calls). */
	errorRate: number;
	/** Calls relative to the busiest tool, 0-100, for the share bar. */
	callsPercentage: number;
}

export function buildToolRows(tools: ToolUsageStats[]): ToolRowView[] {
	const maxCalls = tools.reduce((max, t) => Math.max(max, t.calls), 0);
	return tools.map(t => ({
		...t,
		errorRate: t.calls > 0 ? t.errors / t.calls : 0,
		callsPercentage: maxCalls > 0 ? (t.calls / maxCalls) * 100 : 0,
	}));
}
// ---------------------------------------------------------------------------
// Model rows — share bars + sorting (client-side view-model, no server change)
// ---------------------------------------------------------------------------

export type ModelSortKey = "requests" | "tokens" | "cost" | "cache" | "errorRate" | "model";
export type SortDir = "asc" | "desc";

export interface ModelRowView extends ModelStats {
	/** Share of total requests, 0-1. */
	share: number;
	/** Total tokens (input+output+cache). */
	totalTokens: number;
}

export function buildModelRows(models: ModelStats[]): ModelRowView[] {
	const totalRequests = models.reduce((sum, m) => sum + m.totalRequests, 0);
	return models.map(m => ({
		...m,
		share: totalRequests > 0 ? m.totalRequests / totalRequests : 0,
		totalTokens: m.totalInputTokens + m.totalOutputTokens + m.totalCacheReadTokens + m.totalCacheWriteTokens,
	}));
}

export function sortModelRows(rows: ModelRowView[], key: ModelSortKey, dir: SortDir): ModelRowView[] {
	const mul = dir === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		let cmp = 0;
		switch (key) {
			case "requests":
				cmp = a.totalRequests - b.totalRequests;
				break;
			case "tokens":
				cmp = a.totalTokens - b.totalTokens;
				break;
			case "cost":
				cmp = a.totalCost - b.totalCost;
				break;
			case "cache":
				cmp = a.cacheRate - b.cacheRate;
				break;
			case "errorRate":
				cmp = a.errorRate - b.errorRate;
				break;
			case "model":
				cmp = a.model.localeCompare(b.model);
				break;
		}
		if (cmp !== 0) return cmp * mul;
		return b.totalRequests - a.totalRequests;
	});
}

// ---------------------------------------------------------------------------
// Provider rows — sorting + elevated failure flag
// ---------------------------------------------------------------------------

export type ProviderSortKey = "requests" | "cost" | "failure" | "cache" | "provider";
export type ProviderFailureTone = "ok" | "warning" | "danger";

export function providerFailureTone(errorRate: number): ProviderFailureTone {
	if (errorRate >= 0.08) return "danger";
	if (errorRate >= 0.03) return "warning";
	return "ok";
}

export function sortProviderRows(rows: ProviderAggregate[], key: ProviderSortKey, dir: SortDir): ProviderAggregate[] {
	const mul = dir === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		let cmp = 0;
		switch (key) {
			case "requests":
				cmp = a.totalRequests - b.totalRequests;
				break;
			case "cost":
				cmp = a.totalCost - b.totalCost;
				break;
			case "failure": {
				const ar = a.totalRequests > 0 ? a.failedRequests / a.totalRequests : 0;
				const br = b.totalRequests > 0 ? b.failedRequests / b.totalRequests : 0;
				cmp = ar - br;
				break;
			}
			case "cache": {
				const ar = a.totalTokens > 0 ? a.totalCacheReadTokens / a.totalTokens : 0;
				const br = b.totalTokens > 0 ? b.totalCacheReadTokens / b.totalTokens : 0;
				cmp = ar - br;
				break;
			}
			case "provider":
				cmp = a.provider.localeCompare(b.provider);
				break;
		}
		if (cmp !== 0) return cmp * mul;
		return b.totalRequests - a.totalRequests;
	});
}

// ---------------------------------------------------------------------------
// Errors — normalize + group (client-side view-model for the explorer)
// ---------------------------------------------------------------------------

export type ErrorGroupBy = "error" | "provider" | "model";

export function normalizeErrorMessage(msg: string | null): string {
	if (!msg) return "Unknown error";
	let s = msg.trim();
	// Collapse whitespace and take first line only (often stack follows).
	s = s.split("\n")[0] ?? s;
	s = s.replace(/\s+/g, " ").trim();
	// Strip leading status codes in brackets like [403] or "Error:" prefix noise? Keep as part of signature
	// Normalize: lower doesn't — keep case for display but key is lowercased.
	// For key purposes we lowercase and strip trailing punctuation.
	// Also truncate very long messages to 160 chars for grouping stability.
	if (s.length > 160) s = s.slice(0, 160);
	return s || "Unknown error";
}

export function errorGroupKey(msg: string | null, provider: string, model: string, groupBy: ErrorGroupBy): string {
	const norm = normalizeErrorMessage(msg).toLowerCase();
	switch (groupBy) {
		case "provider":
			return provider || "unknown";
		case "model":
			return model || "unknown";
		default:
			return `${provider}::${norm}`;
	}
}

export interface ErrorGroup {
	key: string;
	signature: string;
	provider: string;
	model: string;
	count: number;
	items: MessageStats[];
	latestTimestamp: number;
	representativeMessage: string;
}

export function groupErrors(messages: MessageStats[], groupBy: ErrorGroupBy = "error"): ErrorGroup[] {
	const map = new Map<string, ErrorGroup>();
	for (const m of messages) {
		if (!m.errorMessage) continue;
		const key = errorGroupKey(m.errorMessage, m.provider, m.model, groupBy);
		const sig =
			groupBy === "provider" ? m.provider : groupBy === "model" ? m.model : normalizeErrorMessage(m.errorMessage);
		const existing = map.get(key);
		if (existing) {
			existing.count += 1;
			existing.items.push(m);
			if (m.timestamp > existing.latestTimestamp) existing.latestTimestamp = m.timestamp;
		} else {
			map.set(key, {
				key,
				signature: sig,
				provider: m.provider,
				model: m.model,
				count: 1,
				items: [m],
				latestTimestamp: m.timestamp,
				representativeMessage: normalizeErrorMessage(m.errorMessage),
			});
		}
	}
	const groups = [...map.values()];
	// Most frequent / most recent first: sort by count desc then latest desc.
	groups.sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return b.latestTimestamp - a.latestTimestamp;
	});
	// Within each group sort occurrences newest first for detail list.
	for (const g of groups) g.items.sort((a, b) => b.timestamp - a.timestamp);
	return groups;
}

// ---------------------------------------------------------------------------
// Requests — sort helpers (re-used for the explorer table)
// ---------------------------------------------------------------------------

export type RequestSortKey = "timestamp" | "tokens" | "cost" | "duration" | "model";

export function sortRequests(rows: MessageStats[], key: RequestSortKey, dir: SortDir): MessageStats[] {
	const mul = dir === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		let cmp = 0;
		switch (key) {
			case "timestamp":
				cmp = a.timestamp - b.timestamp;
				break;
			case "tokens":
				cmp = a.usage.totalTokens - b.usage.totalTokens;
				break;
			case "cost":
				cmp = a.usage.cost.total - b.usage.cost.total;
				break;
			case "duration":
				cmp = (a.duration ?? 0) - (b.duration ?? 0);
				break;
			case "model":
				cmp = a.model.localeCompare(b.model);
				break;
		}
		if (cmp !== 0) return cmp * mul;
		return b.timestamp - a.timestamp;
	});
}
