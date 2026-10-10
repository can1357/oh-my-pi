import type {
	CostDashboardStats,
	FolderStats,
	FrustrationDashboardStats,
	FrustrationEstimate,
	FrustrationJobStatus,
	GainDashboardStats,
	LiveStatus,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	ProviderDashboardStats,
	ProviderWindowStats,
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

/** Prefer the server's `{ error }` body over a bare status line. */
async function readErrorMessage(res: Response, endpoint: string): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
			return body.error;
		}
	} catch {
		// Non-JSON error body: fall through to the status line.
	}
	return `HTTP error ${res.status} on ${endpoint}`;
}

/**
 * Response validators keyed by the parsed body they describe. Revalidating a
 * body sends its ETag; the entry dies with the body when callers drop it.
 */
const validators = new WeakMap<object, string>();

/**
 * Fetch `endpoint` as JSON, revalidating `previous` when it came from an
 * ETag-bearing response: a 304 resolves to `previous` itself (same reference,
 * no re-parse).
 */
async function fetchJson<T>(endpoint: string, options?: RequestInit, previous?: T): Promise<T> {
	const etag = typeof previous === "object" && previous !== null ? validators.get(previous) : undefined;
	let init = options;
	if (etag) {
		const headers = new Headers(options?.headers);
		headers.set("If-None-Match", etag);
		init = { ...options, headers };
	}
	const res = await fetch(endpoint, init);
	if (res.status === 304 && etag) return previous as T;
	if (!res.ok) {
		throw new ApiError(res.status, endpoint, await readErrorMessage(res, endpoint));
	}
	const data = (await res.json()) as T;
	const nextEtag = res.headers.get("ETag");
	if (nextEtag && typeof data === "object" && data !== null) validators.set(data, nextEtag);
	return data;
}

/**
 * Spend-incurring actions carry this custom header. It forces a CORS preflight
 * the server never approves, so a cross-site page cannot trigger them.
 */
const ACTION_HEADERS = { "X-Omp-Stats-Action": "1" };

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

/** Ask the server to start a background sync; progress arrives on the `/api/events` stream. */
export async function requestSync(): Promise<LiveStatus> {
	return fetchJson<LiveStatus>(`${API_BASE}/sync`, { method: "POST" });
}

export async function getFrustrationDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<FrustrationDashboardStats> {
	return fetchJson<FrustrationDashboardStats>(`${API_BASE}/stats/frustration?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

/** Pre-run cost quote for judging every unjudged message in `range`. */
export async function getFrustrationEstimate(range: TimeRange, signal?: AbortSignal): Promise<FrustrationEstimate> {
	return fetchJson<FrustrationEstimate>(`${API_BASE}/frustration/estimate?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

/** Start the judge run over the unjudged messages in `range`. Spends money. */
export async function startFrustrationRun(range: TimeRange): Promise<FrustrationJobStatus> {
	return fetchJson<FrustrationJobStatus>(`${API_BASE}/frustration/judge?range=${encodeURIComponent(range)}`, {
		method: "POST",
		headers: ACTION_HEADERS,
	});
}

export async function cancelFrustrationRun(): Promise<FrustrationJobStatus> {
	return fetchJson<FrustrationJobStatus>(`${API_BASE}/frustration/cancel`, {
		method: "POST",
		headers: ACTION_HEADERS,
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

/** Subscription-window insights (all providers) plus utilization series for `provider` only. */
export async function getProviderWindowStats(
	range: TimeRange,
	provider: string | null,
	signal?: AbortSignal,
): Promise<ProviderWindowStats> {
	const params = new URLSearchParams({ range });
	if (provider !== null) params.set("provider", provider);
	return fetchJson<ProviderWindowStats>(`${API_BASE}/stats/provider-windows?${params}`, { signal });
}

export async function getSessions(limit = 100, q?: string, signal?: AbortSignal): Promise<SessionSummary[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (q) params.set("q", q);
	return fetchJson<SessionSummary[]>(`${API_BASE}/sessions?${params}`, { signal });
}

/**
 * Pass the last trace for `file` as `previous` to revalidate it: an unchanged
 * trace resolves to that same object without downloading or parsing the body.
 */
export async function getSessionTrace(
	file: string,
	signal?: AbortSignal,
	previous?: SessionTrace,
): Promise<SessionTrace> {
	// `no-store`: validation is ours (above); the browser cache would only keep a second multi-MB copy.
	return fetchJson<SessionTrace>(
		`${API_BASE}/session/trace?file=${encodeURIComponent(file)}`,
		{ signal, cache: "no-store" },
		previous,
	);
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
