/**
 * Kiro credit usage from `AmazonCodeWhispererService.GetUsageLimits` on the
 * credential's management region: monthly plan credits, active bonus grants,
 * and overage. Timestamps arrive as epoch seconds; the `…WithPrecision`
 * counters carry the fractional credits the dashboard shows.
 */
import { KiroManagementHttpError, kiroManagementRequest } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { decodeKiroCredential, kiroOAuthService } from "@oh-my-pi/pi-catalog/wire/kiro";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageCredential,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { buildUsageAmount, DAY_MS, HOUR_MS, parsePositiveTimestamp, usageStatus } from "./shared";

const PROVIDER_ID = "kiro";
const PLAN_LIMIT_ID = "kiro:credits";
const BONUS_LIMIT_PREFIX = "kiro:bonus:";
const OVERAGE_LIMIT_ID = "kiro:overage";
const MONTH_MS = 30 * DAY_MS;

/** Region, bearer and (OAuth only) profile ARN to ask for usage; undefined when the credential has no region. */
function usageRoute(
	credential: UsageCredential,
): { region: string; token: string; profileArn?: string; apiKey: boolean; service?: "q" } | undefined {
	if (credential.type === "oauth") {
		if (!credential.accessToken || !credential.region) return undefined;
		return {
			region: credential.region,
			token: credential.accessToken,
			profileArn: credential.kiroProfileArn,
			apiKey: false,
			service: kiroOAuthService(credential),
		};
	}
	try {
		const decoded = decodeKiroCredential(credential.apiKey ?? "");
		// An env key without `KIRO_API_REGION` has no region; usage never probes.
		return decoded.region ? { region: decoded.region, token: decoded.token, apiKey: true } : undefined;
	} catch {
		return undefined;
	}
}

/** Credits `used` of `limit`; a zero-credit allowance counts as fully used. */
function credits(used: number, limit: number): UsageAmount {
	return buildUsageAmount({
		used,
		limit,
		remaining: Math.max(0, limit - used),
		usedFraction: limit > 0 ? Math.min(used / limit, 1) : 1,
		unit: "credits",
	});
}

/** Prefer the fractional `…WithPrecision` counter over its rounded twin. */
function precise(record: Record<string, unknown>, key: string): number | undefined {
	return toNumber(record[`${key}WithPrecision`]) ?? toNumber(record[key]);
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Parse a `GetUsageLimits` response: the plan credits, one limit per active
 * bonus grant, and the overage credits when overage billing is enabled. A spent
 * plan with bonus or overage left is a `warning`, not exhausted. Null when the
 * response has no readable credit breakdown.
 */
export function parseKiroUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !Array.isArray(payload.usageBreakdownList)) return null;
	const credit = payload.usageBreakdownList.find(
		(entry): entry is Record<string, unknown> => isRecord(entry) && entry.resourceType === "CREDIT",
	);
	const planUsed = credit && precise(credit, "currentUsage");
	const planLimit = credit && precise(credit, "usageLimit");
	if (!credit || planUsed === undefined || planLimit === undefined || planLimit < 0) return null;

	const title = isRecord(payload.subscriptionInfo) ? text(payload.subscriptionInfo.subscriptionTitle) : undefined;
	// `KIRO PRO` → `Kiro Pro`.
	const planName = title ? title.toLowerCase().replace(/\b\w/g, char => char.toUpperCase()) : "Kiro";
	const monthly: UsageWindow = { id: "monthly", label: "Monthly", durationMs: MONTH_MS };
	const resetsAt = parsePositiveTimestamp(credit.nextDateReset) ?? parsePositiveTimestamp(payload.nextDateReset);
	if (resetsAt !== undefined) monthly.resetsAt = resetsAt;

	const bonuses: UsageLimit[] = [];
	for (const entry of Array.isArray(credit.bonuses) ? credit.bonuses : []) {
		if (!isRecord(entry) || entry.status !== "ACTIVE") continue;
		const used = toNumber(entry.currentUsage);
		const limit = toNumber(entry.usageLimit);
		if (used === undefined || limit === undefined || limit <= 0) continue;
		const expiresAt = parsePositiveTimestamp(entry.expiresAt);
		const window: UsageWindow = {
			id: `bonus-${bonuses.length}`,
			label: "Bonus",
			resetLabel: "expires",
			...(expiresAt !== undefined ? { resetsAt: expiresAt } : {}),
		};
		const amount = credits(used, limit);
		bonuses.push({
			id: `${BONUS_LIMIT_PREFIX}${bonuses.length}`,
			label: text(entry.displayName) ?? "Bonus credits",
			scope: { provider: PROVIDER_ID, windowId: window.id, shared: true },
			window,
			amount,
			status: usageStatus(amount.usedFraction),
		});
	}

	const overageUsed = precise(credit, "currentOverages") ?? 0;
	const overageCap = precise(credit, "overageCap") ?? 0;
	const overageEnabled =
		isRecord(payload.overageConfiguration) &&
		payload.overageConfiguration.overageStatus === "ENABLED" &&
		overageCap > 0;

	const planAmount = credits(planUsed, planLimit);
	const planSpent = planAmount.usedFraction === 1;
	const bonusLeft = bonuses.some(bonus => bonus.status !== "exhausted");
	let planStatus: UsageStatus = usageStatus(planAmount.usedFraction);
	if (planSpent && (bonusLeft || (overageEnabled && overageUsed < overageCap))) planStatus = "warning";
	const limits: UsageLimit[] = [
		{
			id: PLAN_LIMIT_ID,
			label: `${planName} ${text(credit.displayNamePlural)?.toLowerCase() ?? "credits"}`,
			scope: { provider: PROVIDER_ID, windowId: monthly.id, shared: true },
			window: monthly,
			amount: planAmount,
			status: planStatus,
			...(planSpent && bonusLeft ? { notes: ["Plan credits used up; drawing on bonus credits"] } : {}),
		},
		...bonuses,
	];

	if (overageEnabled) {
		const amount = credits(overageUsed, overageCap);
		const notes = planSpent && !bonusLeft ? ["Free credits used up; drawing paid overage"] : [];
		const charges = toNumber(credit.overageCharges);
		const rate = toNumber(credit.overageRate);
		if (charges !== undefined) {
			const perCredit = rate !== undefined ? ` ($${rate.toFixed(2)} per credit)` : "";
			notes.push(`Overage charges: $${charges.toFixed(2)}${perCredit}`);
		}
		limits.push({
			id: OVERAGE_LIMIT_ID,
			label: "Overage credits",
			scope: { provider: PROVIDER_ID, windowId: monthly.id, shared: true },
			window: monthly,
			amount,
			status: usageStatus(amount.usedFraction),
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	// Response `userInfo` (the account email) is deliberately not carried over.
	return { provider: PROVIDER_ID, fetchedAt, limits, ...(title ? { metadata: { planType: planName } } : {}) };
}

export const kiroUsageProvider: UsageProvider = {
	id: PROVIDER_ID,

	supports(params) {
		return params.provider === PROVIDER_ID && usageRoute(params.credential) !== undefined;
	},

	async fetchUsage(params, ctx) {
		const { credential } = params;
		const route = params.provider === PROVIDER_ID ? usageRoute(credential) : undefined;
		// An expired bearer whose refresh failed would only 401 and drop the last good report.
		if (!route || (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())) return null;
		let payload: unknown;
		try {
			payload = await kiroManagementRequest({
				region: route.region,
				token: route.token,
				target: "GetUsageLimits",
				body: {
					origin: "KIRO_CLI",
					...(route.profileArn ? { profileArn: route.profileArn } : {}),
					resourceType: "AGENTIC_REQUEST",
				},
				fetch: ctx.fetch,
				signal: params.signal,
				service: route.service,
			});
		} catch (error) {
			// A rejected login has lost access: drop its cached quota. An API key
			// the usage route refuses simply has no report.
			if (
				!route.apiKey &&
				error instanceof KiroManagementHttpError &&
				(error.status === 401 || error.status === 403)
			) {
				throw new ProviderHttpError(`Kiro usage endpoint returned ${error.status}`, error.status);
			}
			ctx.logger?.warn("Kiro usage request failed", { provider: PROVIDER_ID, error: String(error) });
			return null;
		}
		const report = parseKiroUsage(payload);
		// Attribute the report to the login it measured: logins sharing a profile stay separate accounts.
		if (report && credential.accountId) report.metadata = { ...report.metadata, accountId: credential.accountId };
		return report;
	},
};

/**
 * Gates and measures Kiro accounts by their free allowance: plan credits plus
 * unexpired bonus grants. Paid overage is never allowance, so an account with
 * only overage left ranks behind siblings with free credits but stays a
 * `warning` (not blocked) and still serves alone. Drain ranking stays on the
 * monthly plan meter; Kiro has no short window, so it maps to `secondary`.
 */
export const kiroRankingStrategy: CredentialRankingStrategy = {
	scopeLimits(report) {
		const plan = report.limits.find(limit => limit.id === PLAN_LIMIT_ID);
		if (!plan) return [];
		const now = Date.now();
		let used = 0;
		let limit = 0;
		for (const entry of report.limits) {
			const isBonus = entry.id.startsWith(BONUS_LIMIT_PREFIX);
			if (!isBonus && entry !== plan) continue;
			if (isBonus && (entry.window?.resetsAt ?? Number.POSITIVE_INFINITY) <= now) continue;
			const { used: entryUsed, limit: entryLimit } = entry.amount;
			if (entryUsed === undefined || entryLimit === undefined || entryLimit <= 0) continue;
			used += Math.min(entryUsed, entryLimit);
			limit += entryLimit;
		}
		const amount = credits(used, limit);
		const overage = report.limits.find(entry => entry.id === OVERAGE_LIMIT_ID);
		let status = usageStatus(amount.usedFraction);
		if (status === "exhausted" && overage && overage.status !== "exhausted") status = "warning";
		return [{ ...plan, id: "kiro:effective-credits", amount, status }];
	},
	findWindowLimits(report) {
		return { secondary: report.limits.find(limit => limit.id === PLAN_LIMIT_ID) };
	},
	windowDefaults: {
		// Inert: findWindowLimits never reports a primary window.
		primaryMs: 5 * HOUR_MS,
		secondaryMs: MONTH_MS,
	},
};
