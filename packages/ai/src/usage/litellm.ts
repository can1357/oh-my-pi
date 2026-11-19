import { getDefaultModelDiscoveryBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { normalizeLiteLLMManagementBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error";
import type { Provider } from "../types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { buildUsageAmount, parseIsoTimestamp, usageStatus } from "./shared";

/** LiteLLM budget durations (`30s`, `7d`, `1mo`); other values are not trusted as display labels. */
const DURATION = /^\d+(?:s|m|h|d|w|mo)$/;
/** LiteLLM serialises naive datetimes in UTC; `Date.parse` would read them as local time. */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function parseResetAt(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const iso = value.trim().replace(" ", "T");
	return parseIsoTimestamp(NAIVE_DATETIME.test(iso) ? `${iso}Z` : iso);
}

/** One USD budget row from a LiteLLM key or user record (`spend`, `max_budget`, `budget_duration`). */
function budgetLimit(
	id: string,
	label: string,
	provider: Provider,
	record: Record<string, unknown>,
): UsageLimit | null {
	const spend = typeof record.spend === "number" && Number.isFinite(record.spend) ? record.spend : undefined;
	if (spend === undefined) return null;
	const cap =
		typeof record.max_budget === "number" && Number.isFinite(record.max_budget) ? record.max_budget : undefined;
	const duration =
		typeof record.budget_duration === "string" && DURATION.test(record.budget_duration)
			? record.budget_duration
			: undefined;
	const resetsAt = parseResetAt(record.budget_reset_at);
	const amount = buildUsageAmount({
		unit: "usd",
		used: spend,
		limit: cap,
		remaining: cap === undefined ? undefined : Math.max(0, cap - spend),
		// A zero cap blocks every request.
		usedFraction: cap !== undefined && cap <= 0 ? 1 : undefined,
	});
	return {
		id,
		label,
		scope: { provider, shared: true, ...(duration ? { windowId: duration } : {}) },
		...(duration
			? { window: { id: duration, label: duration, ...(resetsAt !== undefined ? { resetsAt } : {}) } }
			: {}),
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

type ScopeResult = Record<string, unknown> | "unauthorized" | undefined;

async function getJson(
	url: string,
	apiKey: string,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<ScopeResult> {
	try {
		const response = await ctx.fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			redirect: "error",
			signal: params.signal,
		});
		if (response.status === 401) return "unauthorized";
		if (!response.ok) {
			ctx.logger?.debug("LiteLLM usage endpoint unavailable", { url, status: response.status });
			return undefined;
		}
		const body: unknown = await response.json();
		return isRecord(body) ? body : undefined;
	} catch {
		ctx.logger?.debug("LiteLLM usage request failed", { url });
		return undefined;
	}
}

/**
 * Reads the calling key's `/key/info` (only `sk-` keys have one) and the
 * calling user's `/v2/user/info` from the gateway's management base, both
 * without a query. A 401 drops that scope; a 401 on every scope rejects so the
 * cached report is discarded.
 */
async function fetchLiteLLMUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const apiKey = params.credential.type === "api_key" ? params.credential.apiKey?.trim() : undefined;
	const configured =
		params.baseUrl ?? (params.provider === "litellm" ? getDefaultModelDiscoveryBaseUrl("litellm") : undefined);
	if (!apiKey || !configured) return null;
	const baseUrl = normalizeLiteLLMManagementBaseUrl(configured);
	if (!/^https?:\/\/[^/]/.test(baseUrl)) return null;

	const readsKey = apiKey.startsWith("sk-");
	const [key, user]: ScopeResult[] = await Promise.all([
		readsKey ? getJson(`${baseUrl}/key/info`, apiKey, params, ctx) : undefined,
		getJson(`${baseUrl}/v2/user/info`, apiKey, params, ctx),
	]);
	if (user === "unauthorized" && (!readsKey || key === "unauthorized")) {
		throw new ProviderHttpError("LiteLLM usage endpoint returned 401", 401);
	}
	const keyInfo = isRecord(key) && isRecord(key.info) ? key.info : undefined;
	const userInfo = isRecord(user) ? user : undefined;
	const limits = [
		keyInfo && budgetLimit(`${params.provider}:key:budget`, "Key budget", params.provider, keyInfo),
		userInfo && budgetLimit(`${params.provider}:user:budget`, "User budget", params.provider, userInfo),
	].filter((limit): limit is UsageLimit => !!limit);
	if (limits.length === 0) return null;

	const accountId = [userInfo?.user_id, keyInfo?.user_id].find(id => typeof id === "string" && id.length > 0);
	const email = typeof userInfo?.user_email === "string" ? userInfo.user_email : undefined;
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: baseUrl, ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) },
	};
}

/**
 * Key and user USD budgets from a LiteLLM gateway. Not a built-in default:
 * `ModelRegistry` registers it for `litellm` and every `discovery.type: litellm`
 * provider in models.yml.
 */
export const litellmUsageProvider: UsageProvider = {
	id: "litellm",
	usesRequestKey: true,
	fetchUsage: fetchLiteLLMUsage,
};
