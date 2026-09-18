import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, WEEK_MS, parseIsoTimestamp, parsePositiveTimestamp, usageStatus } from "./shared";

const PROVIDER = "commandcode";
const DEFAULT_ORIGIN = "https://api.commandcode.ai";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBSCRIPTION_PATH = "/alpha/billing/subscriptions";
const WHOAMI_PATH = "/alpha/whoami";

/**
 * Rolling windows the Provider API meters, keyed by the field name in
 * `windowLimits`. Caps (14 credits per 5 hours, 35 per week on the GOAT plan)
 * scale with the plan, so the labels stay plan-agnostic.
 */
const WINDOW_SPECS = [
	{ field: "fiveHour", id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
	{ field: "weekly", id: "7d", label: "Weekly", durationMs: WEEK_MS },
] as const;

/**
 * Monthly credit allowance per plan id. `/alpha/billing/credits` reports only
 * the remaining monthly balance, so the allowance has to come from the plan —
 * this mirrors the table the official CLI ships (`command-code@1.56.0`:
 * `individual-go` 10, `individual-provider` 15, `individual-pro` 30,
 * `individual-pro-v1` 80, `individual-goat` 70, `individual-max` 150,
 * `individual-ultra` 300, `teams-pro` 40). Unknown plans degrade to a
 * remaining-only limit rather than inventing a cap.
 */
const PLAN_ALLOWANCES: Record<string, number> = {
	"individual-go": 10,
	"individual-provider": 15,
	"individual-pro": 30,
	"individual-pro-v1": 80,
	"individual-goat": 70,
	"individual-max": 150,
	"individual-ultra": 300,
	"teams-pro": 40,
};

/**
 * Plan ids arrive from Stripe, so a stored plan may carry a version or
 * promotion suffix the table predates (`individual-pro-v2`). Exact ids win;
 * otherwise the longest prefix does, which keeps `individual-provider` from
 * matching the shorter `individual-pro` entry.
 */
function planAllowance(planId: string | undefined): number | undefined {
	if (!planId) return undefined;
	const exact = PLAN_ALLOWANCES[planId];
	if (exact !== undefined) return exact;
	let best: { id: string; allowance: number } | undefined;
	for (const [id, allowance] of Object.entries(PLAN_ALLOWANCES)) {
		if (!planId.startsWith(id)) continue;
		if (!best || id.length > best.id.length) best = { id, allowance };
	}
	return best?.allowance;
}

/**
 * Command Code's Provider API key authenticates both inference
 * (`<origin>/provider`) and the Studio quota endpoints (`<origin>/alpha/*`)
 * that the official CLI and the web dashboard read. `/alpha/billing/credits`
 * is the authoritative quota source: it carries the rolling windows plus the
 * remaining monthly credit balance, while `/alpha/billing/subscriptions`
 * contributes the billing period the monthly pool resets on.
 *
 * A note on scope flags: the meters are account-wide (no response identifies
 * an individual key), but `scope.shared` is deliberately left unset — that
 * flag also feeds OMP's per-model usage mapping, which would list every
 * Command Code model under a meter that has no per-model breakdown.
 */
async function fetchCommandCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	// The quota endpoints are not configurable: a caller-supplied base URL
	// points at the inference host (a proxy or gateway), so sending the stored
	// key to `/alpha/*` on the canonical origin would both fail for a
	// proxy-scoped credential and disclose it off-site.
	if (params.baseUrl !== undefined) {
		let configured: string | undefined;
		try {
			configured = new URL(params.baseUrl).origin;
		} catch {
			configured = undefined;
		}
		if (configured !== DEFAULT_ORIGIN) {
			ctx.logger?.debug("Command Code usage skipped for a non-canonical base URL", { baseUrl: params.baseUrl });
			return null;
		}
	}

	const headers = { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" };
	const request = async (path: string, search?: Record<string, string | undefined>): Promise<unknown | null> => {
		const url = new URL(`${DEFAULT_ORIGIN}${path}`);
		for (const [key, value] of Object.entries(search ?? {})) {
			if (value) url.searchParams.set(key, value);
		}
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			// A revoked key must purge the cached report instead of letting the
			// last-good value be re-served; every other status is transient.
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Command Code usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Command Code usage request failed", {
				path,
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		return await response.json();
	};

	try {
		// Identity first: on a team plan the quota endpoints are scoped by the
		// organization, and only `/alpha/whoami` names it.
		const whoamiPayload = await request(WHOAMI_PATH);
		const whoami = isRecord(whoamiPayload) ? whoamiPayload : {};
		const user = isRecord(whoami.user) ? whoami.user : undefined;
		const org = isRecord(whoami.org) ? whoami.org : undefined;
		const orgId = typeof org?.id === "string" && org.id ? org.id : undefined;

		const creditsPayload = await request(CREDITS_PATH, { orgId });
		const subscriptionPayload = await request(SUBSCRIPTION_PATH, { orgId });
		const subscription =
			isRecord(subscriptionPayload) && isRecord(subscriptionPayload.data) ? subscriptionPayload.data : undefined;

		if (!isRecord(creditsPayload)) return null;
		const creditFields = isRecord(creditsPayload.credits) ? creditsPayload.credits : {};
		const windowLimits = isRecord(creditsPayload.windowLimits) ? creditsPayload.windowLimits : undefined;

		const limits: UsageLimit[] = [];
		for (const spec of WINDOW_SPECS) {
			const metered = windowLimits ? windowLimits[spec.field] : undefined;
			if (!isRecord(metered)) continue;
			const used = toNumber(metered.used);
			const cap = toNumber(metered.cap);
			if (used === undefined || cap === undefined || cap <= 0) continue;
			const usedFraction = used / cap;
			const resetsAt = parsePositiveTimestamp(metered.resetAt);
			limits.push({
				id: `${PROVIDER}:${spec.id}`,
				label: spec.label,
				scope: { provider: params.provider, accountId: orgId, windowId: spec.id },
				window: {
					id: spec.id,
					label: spec.label,
					durationMs: spec.durationMs,
					...(resetsAt !== undefined ? { resetsAt } : {}),
				},
				amount: {
					used,
					limit: cap,
					remaining: Math.max(0, cap - used),
					usedFraction,
					remainingFraction: Math.max(0, 1 - usedFraction),
					unit: "credits",
				},
				status: usageStatus(usedFraction),
			});
		}

		const monthlyRemaining = toNumber(creditFields.monthlyCredits);
		const purchasedRemaining = toNumber(creditFields.purchasedCredits) ?? 0;
		const freeRemaining = toNumber(creditFields.freeCredits) ?? 0;
		const planId = typeof subscription?.planId === "string" && subscription.planId ? subscription.planId : undefined;
		const allowance = planAllowance(planId);
		if (monthlyRemaining !== undefined || allowance !== undefined) {
			// Purchased and free credits top up the same monthly pool, exactly as
			// the CLI's usage overlay adds them before computing its percentage.
			const extras = purchasedRemaining + freeRemaining;
			const remaining = monthlyRemaining === undefined ? undefined : monthlyRemaining + extras;
			const limit = allowance === undefined ? undefined : allowance + extras;
			const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined;
			const usedFraction =
				limit !== undefined && limit > 0 && used !== undefined ? Math.min(used / limit, 1) : undefined;
			const periodStart = parseIsoTimestamp(subscription?.currentPeriodStart);
			const periodEnd = parseIsoTimestamp(subscription?.currentPeriodEnd);
			const notes = [
				...(extras > 0 ? [`Includes ${extras.toFixed(2)} purchased/free credits`] : []),
				...(creditFields.belowThreshold === true ? ["Below the low-credit threshold"] : []),
			];
			limits.push({
				id: `${PROVIDER}:monthly`,
				label: "Monthly",
				scope: { provider: params.provider, accountId: orgId, windowId: "monthly" },
				window: {
					id: "monthly",
					label: "Monthly",
					...(periodStart !== undefined && periodEnd !== undefined && periodEnd > periodStart
						? { durationMs: periodEnd - periodStart }
						: {}),
					...(periodEnd !== undefined ? { resetsAt: periodEnd } : {}),
				},
				amount: {
					...(used !== undefined ? { used } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(remaining !== undefined ? { remaining } : {}),
					...(usedFraction !== undefined
						? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) }
						: {}),
					unit: "credits",
				},
				status: usageStatus(usedFraction),
				...(notes.length > 0 ? { notes } : {}),
			});
		}

		if (limits.length === 0) return null;

		const email = typeof user?.email === "string" && user.email ? user.email : undefined;
		const accountId = typeof user?.id === "string" && user.id ? user.id : undefined;
		return {
			provider: params.provider,
			fetchedAt: Date.now(),
			limits,
			metadata: {
				endpoint: `${DEFAULT_ORIGIN}${CREDITS_PATH}`,
				...(email ? { email } : {}),
				...(accountId ? { accountId } : {}),
				...(orgId ? { orgId } : {}),
				...(planId ? { planId } : {}),
			},
			raw: creditsPayload,
		};
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code usage fetch error", { error: String(error) });
		return null;
	}
}

export const commandCodeUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
