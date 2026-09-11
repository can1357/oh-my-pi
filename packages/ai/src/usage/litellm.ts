/**
 * LiteLLM proxy budget usage provider.
 *
 * A LiteLLM virtual key carries a `spend`/`max_budget` pair for its primary
 * budget window plus optional additional windows (`budget_limits[]`), and the
 * user owning the key may carry its own budget. All of it is readable by the
 * key itself through the self-service management routes `GET /key/info` (no
 * `key` query → the caller's own row) and `GET /user/info`. Those routes live
 * at the proxy root, not under the OpenAI-compatible `/v1` prefix the provider
 * base URL points at.
 */

import { getDefaultModelDiscoveryBaseUrl } from "@oh-my-pi/pi-catalog/provider-models";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "litellm";

type LitellmUsageSource = "key-info" | "user-info";

/** Proxy root for management routes: provider base URL minus any trailing `/v1`. */
function normalizeLitellmRootUrl(baseUrl?: string): string {
	const configured = baseUrl?.trim() || getDefaultModelDiscoveryBaseUrl(PROVIDER)!;
	return configured.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

const DURATION_UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: HOUR_MS,
	d: DAY_MS,
};

/** `budget_duration` span in ms (`30s`, `15m`, `24h`, `7d`); calendar `mo` units carry no fixed span. */
function parseBudgetDurationMs(duration: string): number | undefined {
	const match = /^(\d+)\s*(s|m|h|d)$/i.exec(duration);
	if (!match) return undefined;
	return Number(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()];
}

interface LitellmWindowSpec {
	/** Canonical window id the usage UIs bucket on (`daily`, `7d`, `monthly`) or the raw LiteLLM duration. */
	id: string;
	label: string;
	durationMs?: number;
}

function resolveWindowSpec(duration: string): LitellmWindowSpec {
	const normalized = duration.trim().toLowerCase();
	const durationMs = parseBudgetDurationMs(normalized);
	if (durationMs === DAY_MS) return { id: "daily", label: "Daily", durationMs };
	if (durationMs === WEEK_MS) return { id: "7d", label: "Weekly", durationMs };
	if (normalized === "30d" || normalized === "1mo" || normalized === "monthly") {
		return { id: "monthly", label: "Monthly", ...(durationMs !== undefined ? { durationMs } : {}) };
	}
	return { id: normalized, label: normalized, ...(durationMs !== undefined ? { durationMs } : {}) };
}

function budgetAmount(spend: number, maxBudget: number): UsageAmount {
	const used = Math.max(0, spend);
	// `max_budget: 0` is an admin hard block: every request is over budget.
	const usedFraction = maxBudget > 0 ? used / maxBudget : 1;
	return {
		used,
		limit: maxBudget,
		remaining: Math.max(0, maxBudget - used),
		usedFraction,
		remainingFraction: Math.max(0, 1 - usedFraction),
		unit: "usd",
	};
}

/** One budget window; `duration` null means a lifetime cap with no reset. */
function budgetLimit(args: {
	owner: "key" | "user";
	label: "Key" | "User";
	duration: string | undefined;
	spend: unknown;
	maxBudget: unknown;
	resetAt: unknown;
}): UsageLimit | undefined {
	const spend = toNumber(args.spend);
	const maxBudget = toNumber(args.maxBudget);
	if (spend === undefined || maxBudget === undefined || maxBudget < 0) return undefined;

	const spec = args.duration?.trim() ? resolveWindowSpec(args.duration) : undefined;
	const resetsAt = parseIsoTimestamp(args.resetAt);
	const window: UsageWindow | undefined = spec
		? {
				id: spec.id,
				label: spec.label,
				...(spec.durationMs !== undefined ? { durationMs: spec.durationMs } : {}),
				...(resetsAt !== undefined ? { resetsAt } : {}),
			}
		: undefined;
	const windowId = spec?.id ?? "lifetime";
	const amount = budgetAmount(spend, maxBudget);
	return {
		id: `${PROVIDER}:${args.owner}:${windowId}`,
		label: `${args.label} · ${windowId}`,
		scope: { provider: PROVIDER, ...(spec ? { windowId: spec.id } : {}) },
		...(window ? { window } : {}),
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

/**
 * `/key/info` → primary window from `spend`/`max_budget`/`budget_duration`,
 * plus each `budget_limits[]` window whose spend the proxy reports under
 * `budget_limits_usage` (older proxies omit it; those windows are skipped
 * rather than shown as unspent).
 */
export function parseLitellmKeyLimits(payload: unknown): UsageLimit[] {
	if (!isRecord(payload) || !isRecord(payload.info)) return [];
	const info = payload.info;
	const limits: UsageLimit[] = [];

	const primaryDuration = typeof info.budget_duration === "string" ? info.budget_duration : undefined;
	const primary = budgetLimit({
		owner: "key",
		label: "Key",
		duration: primaryDuration,
		spend: info.spend,
		maxBudget: info.max_budget,
		resetAt: info.budget_reset_at,
	});
	if (primary) limits.push(primary);

	const usage = isRecord(info.budget_limits_usage) ? info.budget_limits_usage : undefined;
	if (usage && Array.isArray(info.budget_limits)) {
		for (const entry of info.budget_limits) {
			if (!isRecord(entry) || typeof entry.budget_duration !== "string") continue;
			const duration = entry.budget_duration;
			if (duration === primaryDuration) continue;
			const windowUsage = usage[duration];
			if (!isRecord(windowUsage)) continue;
			const limit = budgetLimit({
				owner: "key",
				label: "Key",
				duration,
				spend: windowUsage.current_spend,
				maxBudget: entry.max_budget,
				resetAt: entry.reset_at,
			});
			if (limit) limits.push(limit);
		}
	}
	return limits;
}

/** `/user/info` → the owning user's budget window; `user_info` is null for keys without a user. */
export function parseLitellmUserLimits(payload: unknown): UsageLimit[] {
	if (!isRecord(payload) || !isRecord(payload.user_info)) return [];
	const info = payload.user_info;
	const limit = budgetLimit({
		owner: "user",
		label: "User",
		duration: typeof info.budget_duration === "string" ? info.budget_duration : undefined,
		spend: info.spend,
		maxBudget: info.max_budget,
		resetAt: info.budget_reset_at,
	});
	return limit ? [limit] : [];
}

async function fetchLitellmJson(
	ctx: UsageFetchContext,
	url: string,
	init: RequestInit,
	source: LitellmUsageSource,
): Promise<unknown | undefined> {
	try {
		const response = await ctx.fetch(url, init);
		if (!response.ok) {
			ctx.logger?.warn("LiteLLM usage request failed", { status: response.status, provider: PROVIDER, source });
			return undefined;
		}
		return await response.json();
	} catch (error) {
		ctx.logger?.warn("LiteLLM usage request error", { provider: PROVIDER, source, error: String(error) });
		return undefined;
	}
}

async function fetchLitellmUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const { credential } = params;
	const apiKey = credential.type === "api_key" ? credential.apiKey?.trim() : undefined;
	if (!apiKey) return null;

	const root = normalizeLitellmRootUrl(params.baseUrl ?? credential.apiEndpoint);
	const init: RequestInit = {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: params.signal,
	};
	const fetchedAt = Date.now();
	// Either route may be restricted on a given deployment; a failure on one
	// must not discard the budgets the other returned.
	const [keyInfo, userInfo] = await Promise.all([
		fetchLitellmJson(ctx, `${root}/key/info`, init, "key-info"),
		fetchLitellmJson(ctx, `${root}/user/info`, init, "user-info"),
	]);
	if (keyInfo === undefined && userInfo === undefined) return null;

	const limits = [...parseLitellmKeyLimits(keyInfo), ...parseLitellmUserLimits(userInfo)];

	const metadata: Record<string, unknown> = {};
	if (isRecord(keyInfo) && isRecord(keyInfo.info) && typeof keyInfo.info.key_alias === "string") {
		metadata.keyAlias = keyInfo.info.key_alias;
	}
	if (isRecord(userInfo) && isRecord(userInfo.user_info) && typeof userInfo.user_info.user_id === "string") {
		metadata.userId = userInfo.user_info.user_id;
	}

	return {
		provider: PROVIDER,
		fetchedAt,
		limits,
		...(limits.length === 0 ? { notes: ["No LiteLLM budget is configured for this key or its user."] } : {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		raw: { keyInfo, userInfo },
	};
}

/** Surfaces LiteLLM key and user budget windows from the proxy's self-service management routes. */
export const litellmUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchLitellmUsage,
	supports: params =>
		params.provider === PROVIDER && params.credential.type === "api_key" && Boolean(params.credential.apiKey),
	validatesCredentials: true,
};
