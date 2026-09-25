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
	SessionSummary,
	SessionTrace,
	TimeRange,
	ToolDashboardStats,
} from "./types";

const API_BASE = "/api";

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

export async function getOverviewStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<OverviewStats> {
	return fetchJson<OverviewStats>(`${API_BASE}/stats/overview?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getModelDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ModelDashboardStats> {
	return fetchJson<ModelDashboardStats>(`${API_BASE}/stats/model-dashboard?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getCostDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<CostDashboardStats> {
	return fetchJson<CostDashboardStats>(`${API_BASE}/stats/costs?range=${encodeURIComponent(range)}`, { signal });
}

export async function getRecentRequests(limit = 50, signal?: AbortSignal): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/recent?limit=${limit}`, { signal });
}

export async function getRecentErrors(
	range: TimeRange = "24h",
	limit = 50,
	signal?: AbortSignal,
): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/errors?range=${encodeURIComponent(range)}&limit=${limit}`, {
		signal,
	});
}

export async function getRequestDetails(id: number, signal?: AbortSignal): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`${API_BASE}/request/${id}`, { signal });
}

export async function sync(signal?: AbortSignal): Promise<{ processed: number; files: number; totalMessages: number }> {
	return fetchJson<{ processed: number; files: number; totalMessages: number }>(`${API_BASE}/sync`, { signal });
}

export async function getBehaviorDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<BehaviorDashboardStats> {
	return fetchJson<BehaviorDashboardStats>(`${API_BASE}/stats/behavior?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getFolderStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<FolderStats[]> {
	return fetchJson<FolderStats[]>(`${API_BASE}/stats/folders?range=${encodeURIComponent(range)}`, { signal });
}

export async function getGainDashboardStats(
	range: TimeRange = "24h",
	project?: string | null,
	signal?: AbortSignal,
): Promise<GainDashboardStats> {
	const params = new URLSearchParams({ range });
	if (project) params.set("project", project);
	return fetchJson<GainDashboardStats>(`${API_BASE}/stats/gain?${params}`, { signal });
}

export async function getToolDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ToolDashboardStats> {
	return fetchJson<ToolDashboardStats>(`${API_BASE}/stats/tools?range=${encodeURIComponent(range)}`, { signal });
}

export async function getProviderDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ProviderDashboardStats> {
	return fetchJson<ProviderDashboardStats>(`${API_BASE}/stats/providers?range=${encodeURIComponent(range)}`, {
		signal,
	});
}
export async function getSessions(limit = 100, q?: string, signal?: AbortSignal): Promise<SessionSummary[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (q) params.set("q", q);
	return fetchJson<SessionSummary[]>(`${API_BASE}/sessions?${params}`, { signal });
}

export async function getSessionTrace(file: string, signal?: AbortSignal): Promise<SessionTrace> {
	return fetchJson<SessionTrace>(`${API_BASE}/session/trace?file=${encodeURIComponent(file)}`, { signal });
}

/** Fetch one full journal entry for the span drawer. Entries are opaque JSON. */
export async function getSessionEntryDetail(
	file: string,
	id: string,
	signal?: AbortSignal,
): Promise<{ entry: unknown }> {
	return fetchJson<{ entry: unknown }>(
		`${API_BASE}/session/entry?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`,
		{ signal },
	);
}
