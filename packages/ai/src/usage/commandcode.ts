import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, parseIsoTimestamp, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "commandcode";
const DEFAULT_ORIGIN = "https://api.commandcode.ai";
// The CLI also sends `?limits=1` for its org spend-limit panel; omp reads no
// field from that, so the plain identity route is enough.
const WHOAMI_PATH = "/alpha/whoami";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBSCRIPTIONS_PATH = "/alpha/billing/subscriptions";

/**
 * Monthly credit grant per plan, in credits (USD). The credits route reports
 * only what REMAINS of the grant (`monthlyCredits`), so the total comes from
 * `monthlyCreditsGranted` when the route sends it and from the plan otherwise.
 * Values follow https://commandcode.ai/pricing, keyed by the subscription's
 * `planId`.
 */
const MONTHLY_GRANT_BY_PLAN: Readonly<Record<string, number>> = {
	"individual-go": 10,
	"individual-go-v1": 10,
	"individual-goat": 70,
	"individual-pro": 30,
	"individual-pro-v1": 80,
	"individual-max": 150,
	"individual-ultra": 300,
};

/**
 * Command Code's inference base carries `/provider` or `/provider/v1`, while the
 * account routes sit at the host root, so only the configured origin is kept.
 * A blank or unparseable override means "not configured".
 */
function resolveOrigin(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_ORIGIN;
	try {
		return new URL(trimmed).origin;
	} catch {
		return DEFAULT_ORIGIN;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns the unwrapped JSON body, or `null` for any failure that should read
 * as "no data", 403 included. Only a 401 on a required route throws, so a
 * revoked key purges the cached report instead of re-serving it; an optional
 * route reads its 401 as "no data", so a route-specific denial cannot
 * invalidate a key the required routes accepted.
 */
async function getJson(
	url: string,
	apiKey: string,
	signal: AbortSignal | undefined,
	ctx: UsageFetchContext,
	optional = false,
): Promise<Record<string, unknown> | null> {
	try {
		const response = await ctx.fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			if (response.status === 401 && !optional) {
				throw new ProviderHttpError(
					`Command Code usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Command Code usage fetch failed", {
				url,
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		const json: unknown = await response.json();
		if (!isRecord(json)) return null;
		return isRecord(json.data) ? json.data : json;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code usage fetch error", { url, error: String(error) });
		return null;
	}
}

interface WindowSpec {
	key: "fiveHour" | "weekly";
	id: "5h" | "7d";
	limitLabel: string;
	windowLabel: string;
	durationMs: number;
}

const WINDOWS: readonly WindowSpec[] = [
	{ key: "fiveHour", id: "5h", limitLabel: "5-hour limit", windowLabel: "5-hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", id: "7d", limitLabel: "Weekly limit", windowLabel: "Weekly", durationMs: WEEK_MS },
];

function buildWindowLimit(
	spec: WindowSpec,
	raw: unknown,
	accountId: string,
	orgId: string | undefined,
): UsageLimit | undefined {
	if (!isRecord(raw)) return undefined;
	const used = finiteNumber(raw.used);
	if (used === undefined) return undefined;
	const cap = finiteNumber(raw.cap);
	const usedFraction = cap !== undefined && cap > 0 ? used / cap : undefined;
	const resetsAt = parsePositiveTimestamp(raw.resetAt);
	// Absent fields are omitted, not set to `undefined`: the usage wire schema
	// rejects an explicit `undefined` for an optional key.
	return {
		id: `${PROVIDER}:${spec.id}`,
		label: spec.limitLabel,
		scope: { provider: PROVIDER, accountId, ...(orgId ? { orgId } : {}), windowId: spec.id, shared: true },
		window: {
			id: spec.id,
			label: spec.windowLabel,
			durationMs: spec.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			...(cap !== undefined ? { limit: cap } : {}),
			...(usedFraction !== undefined ? { usedFraction } : {}),
			unit: "credits",
		},
		status: raw.exceeded === true ? "exhausted" : usageStatus(usedFraction),
	};
}

/**
 * Builds the monthly grant limit from the remaining `monthlyCredits`, the
 * grant size, and the subscription's billing period. Without a known grant
 * the remaining amount alone cannot be graded, and without the billing period
 * the limit has no reset, so in either case no limit is emitted and the
 * balance limit stays the only record of it.
 */
function buildMonthlyLimit(
	remaining: number | undefined,
	credits: Record<string, unknown>,
	subscription: Record<string, unknown> | undefined,
	accountId: string,
	orgId: string | undefined,
): UsageLimit | undefined {
	if (remaining === undefined) return undefined;
	const periodStart = parseIsoTimestamp(subscription?.currentPeriodStart);
	const resetsAt = parseIsoTimestamp(subscription?.currentPeriodEnd);
	if (periodStart === undefined || resetsAt === undefined || resetsAt <= periodStart) return undefined;
	const durationMs = resetsAt - periodStart;
	const planId = nonEmptyString(subscription?.planId);
	const grant = finiteNumber(credits.monthlyCreditsGranted) ?? (planId ? MONTHLY_GRANT_BY_PLAN[planId] : undefined);
	if (grant === undefined || grant <= 0) return undefined;
	const used = Math.max(0, grant - remaining);
	const usedFraction = used / grant;
	return {
		id: `${PROVIDER}:monthly`,
		label: "Monthly credits",
		scope: { provider: PROVIDER, accountId, ...(orgId ? { orgId } : {}), windowId: "monthly", shared: true },
		window: { id: "monthly", label: "Monthly", durationMs, resetsAt },
		amount: { used, limit: grant, remaining, usedFraction, unit: "credits" },
		status: usageStatus(usedFraction),
	};
}

/**
 * Reads the account routes that the Command Code CLI calls with the same API
 * key; the Provider API documents no usage endpoint. Pay-as-you-go accounts
 * carry no `windowLimits`, so they report only the credit balance. Credits
 * are queried per org, as the CLI does, so each limit records the org that
 * owns the pool alongside the user.
 */
async function fetchCommandCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	if (params.credential.type !== "api_key" || !params.credential.apiKey) return null;
	const origin = resolveOrigin(params.baseUrl);

	const whoami = await getJson(`${origin}${WHOAMI_PATH}`, params.credential.apiKey, params.signal, ctx);
	if (!whoami) return null;
	const user = isRecord(whoami.user) ? whoami.user : undefined;
	const org = isRecord(whoami.org) ? whoami.org : undefined;
	const userId = nonEmptyString(user?.id);
	if (!userId) return null;
	const orgId = nonEmptyString(org?.id);
	const orgLogin = nonEmptyString(org?.login);

	const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
	const creditsBody = await getJson(
		`${origin}${CREDITS_PATH}${orgQuery}`,
		params.credential.apiKey,
		params.signal,
		ctx,
	);
	if (!creditsBody) return null;
	const credits = isRecord(creditsBody.credits) ? creditsBody.credits : undefined;
	if (!credits) return null;
	const monthly = finiteNumber(credits.monthlyCredits);
	const purchased = finiteNumber(credits.purchasedCredits);
	const free = finiteNumber(credits.freeCredits);
	if (monthly === undefined && purchased === undefined && free === undefined) return null;

	// Only a subscription carries a monthly grant, so pay-as-you-go accounts
	// skip the lookup. A failed lookup drops the monthly limit and nothing else.
	const subscriptionBody =
		monthly !== undefined
			? await getJson(
					`${origin}${SUBSCRIPTIONS_PATH}${orgQuery}`,
					params.credential.apiKey,
					params.signal,
					ctx,
					true,
				)
			: null;
	const subscription = subscriptionBody ?? undefined;

	const limits: UsageLimit[] = [];
	const windowLimits = isRecord(creditsBody.windowLimits) ? creditsBody.windowLimits : undefined;
	for (const spec of WINDOWS) {
		const limit = buildWindowLimit(spec, windowLimits?.[spec.key], userId, orgId);
		if (limit) limits.push(limit);
	}
	const monthlyLimit = buildMonthlyLimit(monthly, credits, subscription, userId, orgId);
	if (monthlyLimit) limits.push(monthlyLimit);
	limits.push({
		id: `${PROVIDER}:balance`,
		label: "Credit balance",
		scope: { provider: PROVIDER, accountId: userId, ...(orgId ? { orgId } : {}), windowId: "balance", shared: true },
		amount: { remaining: (monthly ?? 0) + (purchased ?? 0) + (free ?? 0), unit: "credits" },
	});

	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			accountId: userId,
			email: nonEmptyString(user?.email),
			orgId,
			orgName: orgLogin,
			planType: nonEmptyString(subscription?.planId) ?? nonEmptyString(credits.planId),
		},
		raw: { whoami, credits: creditsBody, ...(subscriptionBody ? { subscription: subscriptionBody } : {}) },
	};
}

export const commandCodeUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/** Ranks Command Code accounts by the 5-hour and weekly credit windows. */
export const commandCodeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.window?.id === "5h"),
		secondary: report.limits.find(limit => limit.window?.id === "7d"),
	}),
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
