import { ProviderHttpError } from "../error";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS } from "./shared";

const UMANS_PROVIDER = "umans";
const DEFAULT_ENDPOINT = "https://api.code.umans.ai";
const USAGE_PATH = "/v1/usage";

/** Umans `GET /v1/usage` response (subset; extras ignored). */
interface UmansUsagePayload {
	plan?: { display_name?: string };
	limits?: {
		requests?: { limit?: number; hard_cap?: number | null; window_seconds?: number };
		concurrency?: { limit?: number; hard_cap?: number | null };
	};
	/** Rolling 5h window metadata; `resets_at` anchors the status-line countdown. */
	window?: { started_at?: string; resets_at?: string; remaining_minutes?: number };
	usage?: {
		requests_in_window?: number;
		remaining_requests?: number;
		/** Model-weighted "effective requests" (umans-flash counts 0.5). */
		weighted_in_window?: number;
		weighted_remaining_requests?: number;
		concurrent_sessions?: number;
		tokens_in?: number;
		tokens_out?: number;
		priority?: { low?: boolean };
	};
}

function normalizeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	const trimmed = baseUrl.trim();
	// Strip a trailing `/v1` (with optional surrounding slashes) so the usage
	// path doesn't double it, but preserve any preceding path prefix (e.g. a
	// path-mounted gateway like `https://gateway.example/team/umans/v1`).
	const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlash.replace(/\/v1$/i, "") || DEFAULT_ENDPOINT;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}

function resolveStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * Soft-cap status never reaches `exhausted`: hitting the effective-request
 * limit only means burst headroom is being consumed — Umans throttles (429)
 * only near the burst ceiling, which the hard row tracks. `exhausted` must
 * stay off this row or the usage-aware fallback demotes a healthy account.
 */
function softCapStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function buildAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	unit: UsageAmount["unit"];
}): UsageAmount {
	const used = args.used;
	const limit = args.limit;
	const usedFraction = used !== undefined && limit !== undefined && limit > 0 ? Math.min(used / limit, 1) : undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		used,
		limit,
		remaining: args.remaining,
		usedFraction,
		remainingFraction,
		unit: args.unit,
	};
}

function buildRequestsLimits(payload: UmansUsagePayload, provider: string): UsageLimit[] {
	const limit = toFiniteNumber(payload.limits?.requests?.limit);
	const hardCap = toFiniteNumber(payload.limits?.requests?.hard_cap);
	const windowSeconds = toFiniteNumber(payload.limits?.requests?.window_seconds);
	const rawUsed = toFiniteNumber(payload.usage?.requests_in_window);
	const rawRemaining = toFiniteNumber(payload.usage?.remaining_requests);
	const weightedUsed = toFiniteNumber(payload.usage?.weighted_in_window);
	const weightedRemaining = toFiniteNumber(payload.usage?.weighted_remaining_requests);
	if (limit === undefined && rawUsed === undefined && weightedUsed === undefined) return [];

	// The 5h window is rolling (FIFO: each request ages out five hours after it
	// fired), but the payload still reports an absolute `resets_at` for the
	// current window epoch — surface it as an incremental countdown (`tick`)
	// rather than a hard reset. `window.id` is `"5h"` to match the status-line
	// usage segment's window-id contract (it only recognizes `"5h"`/`"7d"`).
	let resetsAt: number | undefined;
	if (payload.window?.resets_at) {
		const parsed = Date.parse(payload.window.resets_at);
		resetsAt = Number.isNaN(parsed) ? undefined : parsed;
	}
	const window: UsageWindow = {
		id: "5h",
		label: "rolling 5h",
		durationMs: windowSeconds ? windowSeconds * 1000 : 5 * HOUR_MS,
		...(resetsAt !== undefined ? { resetsAt, resetLabel: "tick" } : {}),
	};

	// Single row: either payloads without weighted counters (legacy) or payloads
	// that report weighted usage but no burst ceiling (`hard_cap`). Without a
	// burst ceiling there is no hard row to defer exhaustion to, so the
	// authoritative counter — weighted when available, else raw — drives the
	// single row and CAN exhaust at the limit. Raw burst traffic above the
	// limit still never drives exhaustion on its own: weighted headroom stays
	// decisive (https://github.com/can1357/oh-my-pi/issues/7858).
	if (weightedUsed === undefined || hardCap === undefined) {
		const amount = buildAmount({
			used: weightedUsed ?? rawUsed,
			limit,
			remaining: weightedUsed !== undefined ? weightedRemaining : rawRemaining,
			unit: "requests",
		});
		return [
			{
				id: "umans:requests",
				label: "Requests (rolling 5h)",
				scope: { provider, windowId: window.id, shared: true },
				window,
				amount,
				status: resolveStatus(amount.usedFraction),
			},
		];
	}

	// Umans weights requests by model ("effective requests": umans-flash counts
	// 0.5), so the weighted counters are the authoritative utilization against
	// the soft `limit`; the raw counters include burst/superseded traffic and
	// read as exhausted mid-window while the account still has weighted
	// headroom (https://github.com/can1357/oh-my-pi/issues/7858). Soft cap hits
	// warn; only the burst ceiling (`hard_cap`, raw counts) can exhaust.
	const softAmount = buildAmount({ used: weightedUsed, limit, remaining: weightedRemaining, unit: "requests" });
	const limits: UsageLimit[] = [
		{
			id: "umans:requests:soft",
			label: "Requests (soft cap)",
			scope: { provider, windowId: window.id, shared: true },
			window,
			amount: softAmount,
			status: softCapStatus(softAmount.usedFraction),
		},
	];
	if (hardCap !== undefined && rawUsed !== undefined) {
		const hardAmount = buildAmount({ used: rawUsed, limit: hardCap, remaining: undefined, unit: "requests" });
		limits.push({
			id: "umans:requests:hard",
			label: "Requests (burst ceiling)",
			scope: { provider, windowId: window.id, shared: true },
			window,
			amount: hardAmount,
			status: resolveStatus(hardAmount.usedFraction),
		});
	}
	return limits;
}

function buildConcurrencyLimit(payload: UmansUsagePayload, provider: string): UsageLimit | null {
	const limit = toFiniteNumber(payload.limits?.concurrency?.limit);
	const used = toFiniteNumber(payload.usage?.concurrent_sessions);
	if (limit === undefined && used === undefined) return null;
	const amount = buildAmount({ used, limit, remaining: undefined, unit: "requests" });
	return {
		id: "umans:concurrency",
		label: "Concurrency",
		// Concurrency is instantaneous, not windowed.
		scope: { provider, windowId: "concurrency" },
		amount,
		status: resolveStatus(amount.usedFraction),
	};
}

async function fetchUmansUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== UMANS_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = normalizeBaseUrl(params.baseUrl);
	const url = `${baseUrl}${USAGE_PATH}`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${credential.apiKey}`,
		accept: "application/json",
	};

	let payload: UmansUsagePayload | null = null;
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			// Auth failures (401/403) must throw so checkCredentials flags the bad
			// key as ok:false rather than ok:null (unknown). Other non-ok statuses
			// are transient — return null so the probe reports "no data".
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Umans usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Umans usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		const json = (await response.json()) as unknown;
		if (!isRecord(json)) {
			ctx.logger?.warn("Umans usage response was not a JSON object");
			return null;
		}
		payload = json as unknown as UmansUsagePayload;
	} catch (error) {
		// Re-throw auth errors so the credential-health probe can surface them.
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Umans usage fetch error", { error: String(error) });
		return null;
	}

	const limits: UsageLimit[] = [...buildRequestsLimits(payload, params.provider)];
	const concurrency = buildConcurrencyLimit(payload, params.provider);
	if (concurrency) limits.push(concurrency);
	if (limits.length === 0) return null;

	const notes: string[] = [];
	if (payload.usage?.priority?.low === true) {
		notes.push("Requests deprioritized after a rate-limit burst.");
	}

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		notes: notes.length > 0 ? notes : undefined,
		metadata: {
			plan: payload.plan?.display_name,
			accountId: credential.accountId,
			email: credential.email,
			endpoint: url,
		},
		raw: payload as Record<string, unknown>,
	};
}

export const umansUsageProvider: UsageProvider = {
	id: UMANS_PROVIDER,
	fetchUsage: fetchUmansUsage,
	supports: params => params.provider === UMANS_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
