import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { extractCursorAccessTokenUserId } from "../registry/oauth/cursor";
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
import { parseIsoTimestamp, usageStatus } from "./shared";

function parseTimestamp(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	return parseIsoTimestamp(value);
}

const DEFAULT_CURSOR_BASE_URL = "https://api2.cursor.sh";

function normalizeCursorBaseUrl(baseUrl?: string): string {
	if (!baseUrl) return DEFAULT_CURSOR_BASE_URL;
	return baseUrl.replace(/\/+$/, "");
}

type CursorUsageSource = "auth-usage" | "usage-summary" | "auth-me";

async function fetchCursorJson(
	ctx: UsageFetchContext,
	url: string,
	init: RequestInit,
	source: CursorUsageSource,
): Promise<unknown | undefined> {
	try {
		const response = await ctx.fetch(url, init);
		if (!response.ok) {
			ctx.logger?.warn("Cursor usage request failed", {
				status: response.status,
				provider: "cursor",
				source,
			});
			return undefined;
		}
		return await response.json();
	} catch (error) {
		ctx.logger?.warn("Cursor usage request error", {
			provider: "cursor",
			source,
			error: String(error),
		});
		return undefined;
	}
}

function deriveResetsAt(payload: Record<string, unknown>): number | undefined {
	const endKeys = ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"];
	for (const key of endKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) return parsed;
	}

	const startKeys = ["startOfMonth", "billingCycleStart", "startOfBillingCycle"];
	for (const key of startKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) {
			const date = new Date(parsed);
			date.setUTCMonth(date.getUTCMonth() + 1);
			return date.getTime();
		}
	}
	return undefined;
}

/**
 * Parse a Cursor cents bucket (`used`/`limit`/`remaining` in USD cents).
 * Returns null for disabled or non-positive / malformed buckets.
 */
function parseCursorCentsBucket(bucket: Record<string, unknown>): UsageAmount | null {
	if (bucket.enabled === false) return null;

	const reportedUsed = toNumber(bucket.used);
	const reportedRemaining = toNumber(bucket.remaining);
	const hasValidUsed = reportedUsed !== undefined && reportedUsed >= 0;
	const hasValidRemaining = reportedRemaining !== undefined && reportedRemaining >= 0;
	const limit = toNumber(bucket.limit);

	if (bucket.limit === null || bucket.limit === undefined) {
		if (!hasValidUsed) return null;
		return { used: reportedUsed / 100, unit: "usd" };
	}

	if (limit === undefined || limit <= 0) return null;
	let used: number;
	if (reportedUsed !== undefined && reportedUsed > 0) {
		used = reportedUsed;
	} else if (hasValidRemaining && reportedRemaining < limit) {
		used = Math.max(0, limit - reportedRemaining);
	} else if (hasValidUsed) {
		used = reportedUsed;
	} else {
		return null;
	}
	const remaining = Math.max(0, limit - used);
	return {
		used: used / 100,
		limit: limit / 100,
		remaining: remaining / 100,
		usedFraction: used / limit,
		remainingFraction: remaining / limit,
		unit: "usd",
	};
}

/**
 * Cursor's dashboard does not treat plan.used / plan.limit as the visible %.
 * Pro+ shows separate quota pools (not one shared percent):
 * - Cursor Models  ← autoPercentUsed
 *   (includes Cursor Grok 4.5 and Composer 2.5)
 * - Other Models   ← apiPercentUsed (separate included-$ pool; different quota)
 * Prefer those fractions when present; fall back to cents only for older overall buckets.
 */
function parseCursorPlanDashboardAmounts(bucket: Record<string, unknown>): {
	auto?: UsageAmount;
	api?: UsageAmount;
	fallback?: UsageAmount;
} {
	if (bucket.enabled === false) return {};

	const limitCents = toNumber(bucket.limit);
	const limitUsd = limitCents !== undefined && limitCents > 0 ? limitCents / 100 : undefined;
	const autoPct = toNumber(bucket.autoPercentUsed);
	const apiPct = toNumber(bucket.apiPercentUsed);
	const totalPct = toNumber(bucket.totalPercentUsed);

	const fromPercent = (pct: number, withLimit: boolean): UsageAmount => {
		const usedFraction = Math.max(0, pct) / 100;
		if (withLimit && limitUsd !== undefined) {
			const used = limitUsd * usedFraction;
			return {
				used,
				limit: limitUsd,
				remaining: Math.max(0, limitUsd - used),
				usedFraction,
				remainingFraction: Math.max(0, 1 - usedFraction),
				unit: "usd",
			};
		}
		return { used: usedFraction * 100, usedFraction, unit: "percent" };
	};

	const result: { auto?: UsageAmount; api?: UsageAmount; fallback?: UsageAmount } = {};
	if (autoPct !== undefined) result.auto = fromPercent(autoPct, false);
	if (apiPct !== undefined) result.api = fromPercent(apiPct, true);
	if (!result.auto && !result.api) {
		if (totalPct !== undefined) {
			result.fallback = fromPercent(totalPct, true);
		} else {
			const cents = parseCursorCentsBucket(bucket);
			if (cents) result.fallback = cents;
		}
	}
	return result;
}

function pushCursorPlanRails(limits: UsageLimit[], bucket: Record<string, unknown>, window: UsageWindow): void {
	const rails = parseCursorPlanDashboardAmounts(bucket);
	if (rails.auto) {
		limits.push({
			id: "cursor:usd:individual-auto",
			label: "Cursor Models",
			scope: { provider: "cursor", windowId: window.id },
			window,
			amount: rails.auto,
			...(rails.auto.usedFraction !== undefined ? { status: usageStatus(rails.auto.usedFraction) } : {}),
		});
	}
	if (rails.api) {
		limits.push({
			id: "cursor:usd:individual-api",
			label: "Other Models",
			scope: { provider: "cursor", windowId: window.id },
			window,
			amount: rails.api,
			...(rails.api.usedFraction !== undefined ? { status: usageStatus(rails.api.usedFraction) } : {}),
		});
	}
	if (rails.fallback) {
		limits.push({
			id: "cursor:usd:individual-plan",
			label: "Personal Usage",
			scope: { provider: "cursor", windowId: window.id },
			window,
			amount: rails.fallback,
			...(rails.fallback.usedFraction !== undefined ? { status: usageStatus(rails.fallback.usedFraction) } : {}),
		});
	}
}

/**
 * Cursor's `/api/usage-summary` has shipped two personal-bucket shapes:
 * - Enterprise/team dashboards historically exposed `individualUsage.overall`
 * - Current Pro / Pro+ / Ultra dashboards expose `individualUsage.plan`
 *   (plus optional `onDemand`)
 *
 * Prefer a *usable* overall bucket; if overall is absent/disabled/malformed,
 * fall through to plan rails (`autoPercentUsed` / `apiPercentUsed`). Always
 * consider on-demand afterward so a valid on-demand meter is not dropped when
 * the included plan bucket is empty.
 */
export function parseCursorIndividualUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !isRecord(payload.individualUsage)) {
		return null;
	}

	const resetsAt = deriveResetsAt(payload);
	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
	const limits: UsageLimit[] = [];

	const overall = isRecord(payload.individualUsage.overall) ? payload.individualUsage.overall : null;
	const plan = isRecord(payload.individualUsage.plan) ? payload.individualUsage.plan : null;

	// Prefer a usable overall bucket; if it is disabled/malformed, fall through to plan.
	let usedOverall = false;
	if (overall) {
		const amount = parseCursorCentsBucket(overall);
		if (amount) {
			usedOverall = true;
			limits.push({
				id: "cursor:usd:individual-overall",
				label: "Personal Usage",
				scope: { provider: "cursor", windowId: window.id },
				window,
				amount,
				...(amount.usedFraction !== undefined ? { status: usageStatus(amount.usedFraction) } : {}),
			});
		}
	}
	if (!usedOverall && plan) {
		pushCursorPlanRails(limits, plan, window);
	}

	// Keep on-demand even when the included plan/overall bucket is absent or unusable.
	if (isRecord(payload.individualUsage.onDemand)) {
		const onDemandAmount = parseCursorCentsBucket(payload.individualUsage.onDemand);
		if (onDemandAmount && onDemandAmount.limit !== undefined && onDemandAmount.limit > 0) {
			limits.push({
				id: "cursor:usd:individual-ondemand",
				label: "On-Demand Usage",
				scope: { provider: "cursor", windowId: window.id },
				window,
				amount: onDemandAmount,
				...(onDemandAmount.usedFraction !== undefined ? { status: usageStatus(onDemandAmount.usedFraction) } : {}),
			});
		}
	}

	if (limits.length === 0) return null;

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		raw: payload,
	};
}

export function parseCursorUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	const limits: UsageLimit[] = [];
	const resetsAt = deriveResetsAt(payload);

	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};

	for (const [key, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;

		// used can be: numRequests, used, amountUsed, usdUsed
		const usedVal =
			toNumber(value.numRequests) ?? toNumber(value.used) ?? toNumber(value.amountUsed) ?? toNumber(value.usdUsed);

		// limit can be: maxRequestUsage, limit, amountLimit, usdLimit
		const limitVal =
			toNumber(value.maxRequestUsage) ??
			toNumber(value.limit) ??
			toNumber(value.amountLimit) ??
			toNumber(value.usdLimit);

		if (usedVal === undefined) continue;

		const isUsd =
			key === "planUsage" ||
			key.toLowerCase().includes("usd") ||
			key.toLowerCase().includes("billing") ||
			key.toLowerCase().includes("stripe");

		const unit = isUsd ? "usd" : "requests";
		const cleanBucket = key.toLowerCase().trim();
		const limitId = isUsd ? `cursor:usd:${cleanBucket}` : `cursor:requests:${cleanBucket}`;

		const label = isUsd ? `${key} spend` : `${key} requests`;

		// Some Cursor plans report no legacy numeric cap (`maxRequestUsage: null`).
		// Emit an uncapped, used-only meter for those buckets instead of dropping
		// them, which used to collapse the whole account to "no usage data".
		let amount: UsageAmount;
		if (limitVal === undefined) {
			amount = { used: usedVal, unit };
		} else {
			const remaining = Math.max(0, limitVal - usedVal);
			amount = {
				used: usedVal,
				limit: limitVal,
				remaining,
				usedFraction: limitVal > 0 ? usedVal / limitVal : 0,
				remainingFraction: limitVal > 0 ? remaining / limitVal : 0,
				unit,
			};
		}

		limits.push({
			id: limitId,
			label,
			scope: {
				provider: "cursor",
				...(window ? { windowId: window.id } : {}),
			},
			...(window ? { window } : {}),
			amount,
			...(amount.usedFraction !== undefined ? { status: usageStatus(amount.usedFraction) } : {}),
		});
	}

	if (limits.length === 0) {
		return null;
	}

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		raw: payload,
	};
}

export const cursorUsageProvider: UsageProvider = {
	id: "cursor",
	supports(params: UsageFetchParams): boolean {
		if (params.provider !== "cursor") return false;
		const { credential } = params;
		if (credential.type === "oauth") {
			return Boolean(credential.accessToken);
		}
		if (credential.type === "api_key") {
			return Boolean(credential.apiKey);
		}
		return false;
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "cursor") return null;
		const { credential } = params;
		const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
		if (!token) return null;

		const baseUrl = normalizeCursorBaseUrl(params.baseUrl ?? credential.apiEndpoint);
		const url = `${baseUrl}/auth/usage`;
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		};
		const fetchedAt = Date.now();

		const legacyReportPromise = fetchCursorJson(
			ctx,
			url,
			{
				headers,
				signal: params.signal,
			},
			"auth-usage",
		).then(payload => parseCursorUsage(payload, fetchedAt));

		let summaryReportPromise = Promise.resolve<UsageReport | null>(null);
		let profileEmailPromise = Promise.resolve<string | undefined>(undefined);
		if (credential.type === "oauth" && baseUrl === DEFAULT_CURSOR_BASE_URL) {
			const userId = extractCursorAccessTokenUserId(token);
			if (userId) {
				const sessionHeaders: Record<string, string> = {
					Accept: "application/json",
					Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
				};
				summaryReportPromise = fetchCursorJson(
					ctx,
					"https://cursor.com/api/usage-summary",
					{
						headers: sessionHeaders,
						signal: params.signal,
					},
					"usage-summary",
				).then(payload => parseCursorIndividualUsage(payload, fetchedAt));
				profileEmailPromise = fetchCursorJson(
					ctx,
					"https://cursor.com/api/auth/me",
					{
						headers: sessionHeaders,
						signal: params.signal,
					},
					"auth-me",
				).then(payload => {
					if (
						!isRecord(payload) ||
						payload.sub !== userId ||
						typeof payload.email !== "string" ||
						!payload.email.trim()
					) {
						return undefined;
					}
					return payload.email.trim();
				});
			}
		}

		const [legacyReport, summaryReport, profileEmail] = await Promise.all([
			legacyReportPromise,
			summaryReportPromise,
			profileEmailPromise,
		]);
		let report: UsageReport | null;
		if (legacyReport && summaryReport) {
			report = {
				provider: "cursor",
				fetchedAt,
				limits: [...legacyReport.limits, ...summaryReport.limits],
				raw: {
					authUsage: legacyReport.raw,
					usageSummary: summaryReport.raw,
				},
			};
		} else {
			report = legacyReport ?? summaryReport;
		}
		if (!report) return null;

		const email = profileEmail ?? credential.email?.trim();
		const metadata = {
			...(email ? { email } : {}),
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.projectId ? { projectId: credential.projectId } : {}),
		};
		if (Object.keys(metadata).length > 0) report.metadata = metadata;
		return report;
	},
};
