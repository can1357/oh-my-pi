/**
 * Client-side type definitions.
 *
 * Shared shapes (aggregations, time-series, dashboard payloads) live in
 * `../shared-types` and are re-exported here. The types declared inline below
 * are deliberately client-only because:
 *   - `Usage` is redeclared locally so the client bundle avoids importing
 *     `@oh-my-pi/pi-ai` (the server-side AI types package).
 *   - `MessageStats.stopReason` is widened from the server's `StopReason`
 *     enum to `string`, again to keep the client free of pi-ai types.
 *   - `TimeRange`, `OverviewStats`, `ModelDashboardStats`,
 *     `CostDashboardStats` are UI-only view shapes the server never produces.
 */

import type {
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
} from "../shared-types";

export * from "../shared-types";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests?: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface MessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: Usage;
}

export interface RequestDetails extends MessageStats {
	messages: unknown[];
	output: unknown;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

export interface OverviewStats {
	overall: AggregatedStats;
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
}

export interface ModelDashboardStats {
	byModel: ModelStats[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
}

export interface CostDashboardStats {
	costSeries: CostTimeSeriesPoint[];
}
