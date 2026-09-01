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
 * `limits.monthly`: `usage` is the consumed fraction (0..1) of the monthly
 * allowance. Ollama does not expose the absolute cap, a reset timestamp, or a
 * remaining balance — only the fraction and per-model request counts.
 */
function parseMonthlyLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const usage = toNumber(raw.usage);
	if (usage === undefined) return null;
	const models = Array.isArray(raw.models) ? raw.models : [];
	const requests = models.reduce(
		(sum, model) => sum + (isRecord(model) ? parseRequestCount(model.request_count) : 0),
		0,
	);
	const amount: UsageAmount = { usedFraction: Math.max(usage, 0), unit: "credits" };
	return {
		id: `${provider}:monthly`,
		label: "Monthly allowance",
		scope: { provider, windowId: "monthly", shared: true },
		window: { id: "monthly", label: "Monthly" },
		amount,
		status: usageStatus(usage),
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
			ctx.logger?.warn("Ollama Cloud usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("Ollama Cloud usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;

	const limits: UsageLimit[] = [];
	const monthly = parseMonthlyLimit(isRecord(payload.limits) ? payload.limits.monthly : undefined, params.provider);
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
	validatesCredentials: false,
};

/** Fetches the Ollama Cloud monthly allowance from the ollama.com usage API. */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaCloudUsage,
	supports: params => params.provider === OLLAMA_CLOUD_PROVIDER,
	validatesCredentials: false,
};
