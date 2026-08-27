import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	FolderStats,
	GainDashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	ProviderDashboardStats,
	RequestDetails,
	TimeRange,
	ToolDashboardStats,
} from "./types";

const V1_BASE = "/api/v1";
const LEGACY_BASE = "/api";

export class ApiError extends Error {
	status: number;
	endpoint: string;

	constructor(status: number, endpoint: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.endpoint = endpoint;
	}
}

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const res = await fetch(endpoint, options);
	if (!res.ok) {
		throw new ApiError(res.status, endpoint, `HTTP error ${res.status} on ${endpoint}`);
	}
	return res.json() as Promise<T>;
}

async function fetchV1<T>(v1Path: string, legacyPath: string, options?: RequestInit): Promise<T> {
	try {
		return await fetchJson<T>(`${V1_BASE}${v1Path}`, options);
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			return fetchJson<T>(`${LEGACY_BASE}${legacyPath}`, options);
		}
		throw err;
	}
}

export async function getOverviewStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<OverviewStats> {
	return fetchV1<OverviewStats>(
		`/overview?range=${encodeURIComponent(range)}`,
		`/stats/overview?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getModelDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ModelDashboardStats> {
	return fetchV1<ModelDashboardStats>(
		`/models?range=${encodeURIComponent(range)}`,
		`/stats/model-dashboard?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getCostDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<CostDashboardStats> {
	return fetchV1<CostDashboardStats>(
		`/costs?range=${encodeURIComponent(range)}`,
		`/stats/costs?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getRecentRequests(
	limit = 50,
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<MessageStats[]> {
	try {
		const res = await fetchJson<{ requests: MessageStats[]; total: number }>(
			`${V1_BASE}/requests?range=${encodeURIComponent(range)}&limit=${limit}`,
			{ signal },
		);
		if (Array.isArray(res as unknown as MessageStats[])) return res as unknown as MessageStats[];
		if (res && Array.isArray(res.requests)) return res.requests;
		return [];
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			return fetchJson<MessageStats[]>(`${LEGACY_BASE}/stats/recent?limit=${limit}`, { signal });
		}
		throw err;
	}
}

export async function getRecentErrors(
	range: TimeRange = "24h",
	limit = 50,
	signal?: AbortSignal,
): Promise<MessageStats[]> {
	return fetchV1<MessageStats[]>(
		`/errors?range=${encodeURIComponent(range)}&limit=${limit}`,
		`/stats/errors?range=${encodeURIComponent(range)}&limit=${limit}`,
		{
			signal,
		},
	);
}

export async function getRequestsPaginated(
	range: TimeRange = "24h",
	limit = 50,
	offset = 0,
	signal?: AbortSignal,
): Promise<{ requests: MessageStats[]; total: number }> {
	try {
		const res = await fetchJson<{ requests: MessageStats[]; total: number }>(
			`${V1_BASE}/requests?range=${encodeURIComponent(range)}&limit=${limit}&offset=${offset}`,
			{ signal },
		);
		if (res && Array.isArray(res.requests) && typeof res.total === "number") return res;
		// Fallback: legacy returned array
		if (Array.isArray(res as unknown as MessageStats[])) {
			const arr = res as unknown as MessageStats[];
			return { requests: arr.slice(offset, offset + limit), total: arr.length };
		}
		return { requests: [], total: 0 };
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			const legacy = await fetchJson<MessageStats[]>(`${LEGACY_BASE}/stats/recent?limit=${limit}`, { signal });
			return { requests: legacy.slice(offset, offset + limit), total: legacy.length };
		}
		throw err;
	}
}

export async function getRequestDetails(id: number, signal?: AbortSignal): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`${LEGACY_BASE}/request/${id}`, { signal });
}

export async function sync(signal?: AbortSignal): Promise<{ processed: number; files: number; totalMessages: number }> {
	return fetchJson<{ processed: number; files: number; totalMessages: number }>(`${LEGACY_BASE}/sync`, { signal });
}

export async function getBehaviorDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<BehaviorDashboardStats> {
	return fetchV1<BehaviorDashboardStats>(
		`/behavior?range=${encodeURIComponent(range)}`,
		`/stats/behavior?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getFolderStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<FolderStats[]> {
	return fetchV1<FolderStats[]>(
		`/projects?range=${encodeURIComponent(range)}`,
		`/stats/folders?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getGainDashboardStats(
	range: TimeRange = "24h",
	project?: string | null,
	signal?: AbortSignal,
): Promise<GainDashboardStats> {
	const params = new URLSearchParams({ range });
	if (project) params.set("project", project);
	return fetchV1<GainDashboardStats>(`/gain?${params}`, `/stats/gain?${params}`, { signal });
}

export async function getToolDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ToolDashboardStats> {
	return fetchV1<ToolDashboardStats>(
		`/tools?range=${encodeURIComponent(range)}`,
		`/stats/tools?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getProviderDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ProviderDashboardStats> {
	return fetchV1<ProviderDashboardStats>(
		`/providers?range=${encodeURIComponent(range)}`,
		`/stats/providers?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getMeta(
	signal?: AbortSignal,
): Promise<{ version: number; ranges: string[]; endpoints: string[]; serverTime: number }> {
	return fetchV1<{ version: number; ranges: string[]; endpoints: string[]; serverTime: number }>(`/meta`, `/stats`, {
		signal,
	});
}
