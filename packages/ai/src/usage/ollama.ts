import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { ProviderHttpError } from "../error";
import { DAY_MS, parseIsoTimestamp, usageStatus } from "./shared";

const OLLAMA_PROVIDER = "ollama";
const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";
const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";
const FALLBACK_ACTIVITY_WINDOW_MS = 28 * DAY_MS;

function parseRequestCount(value: unknown): number {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * Legacy unmigrated plans report `limits.session` (5h rolling) and
 * `limits.weekly` (7-day rolling) — the pre-monthly-credit shape recorded in
 * PR #10101. Accounts that switched to monthly billing stop returning these
 * keys, so a missing key simply yields no limit. `usage` is again a 0..1
 * fraction with per-model request counts and no reset timestamp.
 */
const LEGACY_PLAN_WINDOWS = [
	{ key: "session", id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
	{ key: "weekly", id: "7d", label: "7 Day", durationMs: 7 * 24 * 60 * 60 * 1000 },
] as const;

function parseLegacyPlanLimit(
	raw: unknown,
	plan: (typeof LEGACY_PLAN_WINDOWS)[number],
	provider: UsageFetchParams["provider"],
): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const usage = toNumber(raw.usage);
	if (usage === undefined) return null;
	const fraction = Math.max(usage, 0);
	const models = Array.isArray(raw.models) ? raw.models : [];
	const requests = models.reduce(
		(sum, model) => sum + (isRecord(model) ? parseRequestCount(model.request_count) : 0),
		0,
	);
	return {
		id: `${provider}:${plan.id}`,
		label: `Ollama ${plan.label}`,
		scope: { provider, windowId: plan.id, shared: true },
		window: { id: plan.id, label: plan.label, durationMs: plan.durationMs },
		amount: { used: fraction * 100, usedFraction: fraction, unit: "percent" },
		status: usageStatus(fraction),
		notes: requests > 0 ? [`${requests} requests this period`] : undefined,
	};
}

/**
 * Migrated plans report `limits.monthly`: `usage` is the consumed fraction
 * (0..1) of the monthly allowance. Ollama does not expose the absolute cap, a
 * reset timestamp, or a remaining balance — only the fraction and per-model
 * request counts.
 */
function parseMonthlyLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const usage = toNumber(raw.usage);
	if (usage === undefined) return null;
	const fraction = Math.max(usage, 0);
	const models = Array.isArray(raw.models) ? raw.models : [];
	const requests = models.reduce(
		(sum, model) => sum + (isRecord(model) ? parseRequestCount(model.request_count) : 0),
		0,
	);
	// Fraction-only quota: no absolute credit quantity exists, so the unit is
	// "percent" — renderers turn usedFraction into "X% used", while a named
	// unit like "credits" would print a false "0.40 credits used".
	const amount: UsageAmount = { used: fraction * 100, usedFraction: fraction, unit: "percent" };
	return {
		id: `${provider}:monthly`,
		label: "Monthly allowance",
		scope: { provider, windowId: "monthly", shared: true },
		window: { id: "monthly", label: "Monthly" },
		amount,
		status: usageStatus(fraction),
		notes: requests > 0 ? [`${requests} requests this period`] : undefined,
	};
}

/**
 * `activity`: trailing (rolling ~4-week) spend window with a per-model
 * breakdown. This is observed spend, not a quota — no cap value is exposed.
 */
function parseActivityLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const cost = toNumber(raw.cost);
	if (cost === undefined) return null;
	const period = isRecord(raw.period) ? raw.period : {};
	const startMs = parseIsoTimestamp(period.starting_at);
	const endMs = parseIsoTimestamp(period.ending_at);
	const durationMs =
		startMs !== undefined && endMs !== undefined && endMs > startMs ? endMs - startMs : FALLBACK_ACTIVITY_WINDOW_MS;
	return {
		id: `${provider}:activity`,
		label: "Spend (4-week trailing)",
		scope: { provider, windowId: "activity", shared: true },
		window: { id: "activity", label: "4 weeks", durationMs },
		amount: { used: cost, unit: "usd" },
		notes: ["Trailing spend reported by Ollama; the absolute monthly allowance cap is not exposed."],
	};
}

function stubReport(params: UsageFetchParams): UsageReport {
	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.projectId) metadata.projectId = params.credential.projectId;
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [],
		notes: ["No usage endpoint reachable for this credential; per-response token usage is reported during requests."],
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

async function fetchOllamaUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_PROVIDER && params.provider !== OLLAMA_CLOUD_PROVIDER) {
		return null;
	}
	return stubReport(params);
}

async function fetchOllamaCloudUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_CLOUD_PROVIDER) return null;
	const credential = params.credential;
	const apiKey = credential.type === "api_key" ? credential.apiKey : undefined;
	if (!apiKey) return stubReport(params);

	let payload: unknown = null;
	try {
		const response = await ctx.fetch(OLLAMA_CLOUD_USAGE_URL, {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: params.signal,
		});
		if (!response.ok) {
			// A revoked/expired key is a definitive auth failure, not a transient
			// outage: throw so AuthStorage purges the last-good report instead of
			// serving stale quota for the duration of the failure cooldown.
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Ollama Cloud usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Ollama Cloud usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Ollama Cloud usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;

	const limits: UsageLimit[] = [];
	const payloadLimits = isRecord(payload.limits) ? payload.limits : {};
	for (const plan of LEGACY_PLAN_WINDOWS) {
		const legacy = parseLegacyPlanLimit(payloadLimits[plan.key], plan, params.provider);
		if (legacy) limits.push(legacy);
	}
	const monthly = parseMonthlyLimit(payloadLimits.monthly, params.provider);
	if (monthly) limits.push(monthly);
	const activity = parseActivityLimit(payload.activity, params.provider);
	if (activity) limits.push(activity);
	if (limits.length === 0) return null;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: OLLAMA_CLOUD_USAGE_URL },
		raw: payload,
	};
}

/** Registers local Ollama accounts with usage views even though no quota endpoint is exposed. */
export const ollamaUsageProvider: UsageProvider = {
	id: OLLAMA_PROVIDER,
	fetchUsage: fetchOllamaUsage,
	supports: params => params.provider === OLLAMA_PROVIDER,
	// The local stub never contacts the configured server, so it cannot
	// authenticate anything — flagging it as validating would make
	// `omp auth check` report unreachable local engines as healthy.
	validatesCredentials: false,
};

/** Fetches Ollama Cloud quota (legacy session/weekly or migrated monthly) from the ollama.com usage API. */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaCloudUsage,
	supports: params => params.provider === OLLAMA_CLOUD_PROVIDER,
	validatesCredentials: false,
};
