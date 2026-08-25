/**
 * Framework-neutral TypeScript client SDK for OMP Stats v1 API.
 *
 * Usage:
 * ```ts
 * import { createOmpStatsClient } from "@oh-my-pi/omp-stats/client-sdk";
 * const client = createOmpStatsClient({ baseUrl: "http://127.0.0.1:3847" });
 * const overview = await client.overview({ range: "7d" });
 * ```
 */

import type {
	BehaviorDashboardStats,
	CostTimeSeriesPoint,
	GainDashboardStats,
	ModelStats,
	ProviderDashboardStats,
	TimeSeriesPoint,
	ToolDashboardStats,
} from "./shared-types";
import type { AggregatedStats, FolderStats, MessageStats } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the OMP Stats client. */
export interface OmpStatsClientOptions {
	/** Base URL of the OMP Stats server (e.g. "http://127.0.0.1:3847"). */
	baseUrl: string;
	/** Optional fetch implementation for testing or custom transport. */
	fetch?: typeof globalThis.fetch;
}

/** Supported time ranges. */
export type TimeRange = "today" | "1h" | "24h" | "7d" | "30d" | "90d" | "all";

/** Query options for endpoints that support a range parameter. */
export interface RangeQuery {
	/** Time range for the query. Defaults to "24h". */
	range?: TimeRange;
}

/** Query options for the errors endpoint. */
export interface ErrorsQuery extends RangeQuery {
	/** Maximum number of errors to return. Defaults to 20. */
	limit?: number;
}

/** Query options for the requests endpoint. */
export interface RequestsQuery extends RangeQuery {
	/** Maximum number of requests to return. Defaults to 20. */
	limit?: number;
	/** Offset for pagination. Defaults to 0. */
	offset?: number;
}

/** Query options for the gain endpoint. */
export interface GainQuery extends RangeQuery {
	/** Project filter (cwd prefix). */
	project?: string;
}

/** Meta response shape. */
export interface MetaResponse {
	version: number;
	ranges: string[];
	endpoints: string[];
	serverTime: number;
	supportedParams: Record<string, string>;
	unsupportedParams: Record<string, string>;
}

/** Overview response shape (same as existing /api/stats/overview). */
export interface OverviewResponse {
	overall: AggregatedStats;
	byAgentType: import("./shared-types").AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
}

/** Models response shape (same as existing /api/stats/model-dashboard). */
export interface ModelsResponse {
	byModel: ModelStats[];
	modelSeries: import("./shared-types").ModelTimeSeriesPoint[];
	modelPerformanceSeries: import("./shared-types").ModelPerformancePoint[];
}

/** Providers response shape (same as existing /api/stats/providers). */
export interface ProvidersResponse extends ProviderDashboardStats {}

/** Tools response shape (same as existing /api/stats/tools). */
export interface ToolsResponse extends ToolDashboardStats {}

/** Projects response shape (same as existing /api/stats/folders). */
export interface ProjectsResponse extends Array<FolderStats> {}

/** Costs response shape (same as existing /api/stats/costs). */
export interface CostsResponse {
	costSeries: CostTimeSeriesPoint[];
}

/** Behavior response shape (same as existing /api/stats/behavior). */
export interface BehaviorResponse extends BehaviorDashboardStats {}

/** Errors response shape (same as existing /api/stats/errors). */
export interface ErrorsResponse extends Array<MessageStats> {}

/** Requests response shape (paginated). */
export interface RequestsResponse {
	requests: MessageStats[];
	total: number;
}

/** Gain response shape (same as existing /api/stats/gain). */
export interface GainResponse extends GainDashboardStats {}

/** OMP Stats client interface. */
export interface OmpStatsClient {
	/** Fetch the v1 API metadata. */
	meta(): Promise<MetaResponse>;
	/** Fetch overview stats for the given time range. */
	overview(query?: RangeQuery): Promise<OverviewResponse>;
	/** Fetch model dashboard stats. */
	models(query?: RangeQuery): Promise<ModelsResponse>;
	/** Fetch provider dashboard stats. */
	providers(query?: RangeQuery): Promise<ProvidersResponse>;
	/** Fetch tool dashboard stats. */
	tools(query?: RangeQuery): Promise<ToolsResponse>;
	/** Fetch project/folder stats. */
	projects(query?: RangeQuery): Promise<ProjectsResponse>;
	/** Fetch cost dashboard stats. */
	costs(query?: RangeQuery): Promise<CostsResponse>;
	/** Fetch behavior dashboard stats. */
	behavior(query?: RangeQuery): Promise<BehaviorResponse>;
	/** Fetch recent errors. */
	errors(query?: ErrorsQuery): Promise<ErrorsResponse>;
	/** Fetch recent requests (paginated). */
	requests(query?: RequestsQuery): Promise<RequestsResponse>;
	/** Fetch gain/efficiency stats. */
	gain(query?: GainQuery): Promise<GainResponse>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an OMP Stats v1 API client.
 *
 * @param options - Client configuration.
 * @returns A typed client with methods for each v1 endpoint.
 */
export function createOmpStatsClient(options: OmpStatsClientOptions): OmpStatsClient {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const fetchFn = options.fetch ?? globalThis.fetch;

	const get = <T>(apiPath: string, params?: Record<string, string | number | undefined>): Promise<T> => {
		const url = new URL(`${baseUrl}${apiPath}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined && value !== null) {
					url.searchParams.set(key, String(value));
				}
			}
		}
		return fetchFn(url.toString()).then(async response => {
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`OMP Stats API error ${response.status}: ${body}`);
			}
			return (await response.json()) as T;
		});
	};

	return {
		meta: () => get<MetaResponse>("/api/v1/meta"),
		overview: query => get<OverviewResponse>("/api/v1/overview", { range: query?.range }),
		models: query => get<ModelsResponse>("/api/v1/models", { range: query?.range }),
		providers: query => get<ProvidersResponse>("/api/v1/providers", { range: query?.range }),
		tools: query => get<ToolsResponse>("/api/v1/tools", { range: query?.range }),
		projects: query => get<ProjectsResponse>("/api/v1/projects", { range: query?.range }),
		costs: query => get<CostsResponse>("/api/v1/costs", { range: query?.range }),
		behavior: query => get<BehaviorResponse>("/api/v1/behavior", { range: query?.range }),
		errors: query => get<ErrorsResponse>("/api/v1/errors", { range: query?.range, limit: query?.limit }),
		requests: query =>
			get<RequestsResponse>("/api/v1/requests", { range: query?.range, limit: query?.limit, offset: query?.offset }),
		gain: query => get<GainResponse>("/api/v1/gain", { range: query?.range, project: query?.project }),
	};
}
