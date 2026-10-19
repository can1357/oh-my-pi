import * as AIError from "../error";
import { parseMuseCodeCredential, requestMuseCodeKey, type MuseCodeKeyResponse } from "../registry/oauth/muse-code";
import {
	resolveUsedFraction,
	type UsageAmount,
	type UsageFetchParams,
	type UsageLimit,
	type UsageProvider,
	type UsageReport,
	type UsageWindow,
} from "../usage";
import { parseIsoTimestamp, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "muse-code";
const SOURCE = "api.meta.ai/muse-code/key";
const FAILURE_BACKOFF_MS = 5 * 60_000;
const WEEKLY_ID = "1w";
/** Limit ids `rollingWindow()` produces: `<minutes>m`, or `rolling` when Meta names no duration. */
const ROLLING_ID = /^(?:rolling|\d+m)$/;
/** Meta's documented rolling window, used when no earlier report names one. */
const DEFAULT_ROLLING_MINUTES = 300;
type MuseCodeSubscriptionUsage = NonNullable<MuseCodeKeyResponse["subs_usage"]>;

function parseResetTimestamp(value: string | number | undefined): number | undefined {
	return typeof value === "string" ? parseIsoTimestamp(value) : parsePositiveTimestamp(value);
}

function percentAmount(usedPercent: number): UsageAmount {
	const used = Math.min(usedPercent, 100);
	const usedFraction = used / 100;
	return {
		used,
		limit: 100,
		remaining: 100 - used,
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit: "percent",
	};
}

function percentLimit(
	id: string,
	label: string,
	usedPercent: number,
	window: UsageWindow,
	tier: string | undefined,
	accountId: string | undefined,
	notes?: string[],
): UsageLimit {
	const amount = percentAmount(usedPercent);
	return {
		id,
		label,
		scope: { provider: PROVIDER, accountId, tier, windowId: window.id, shared: true },
		window,
		amount,
		status: usageStatus(amount.usedFraction),
		...(notes ? { notes } : {}),
	};
}

function buildLimit(
	id: string,
	label: string,
	usedPercent: number | undefined,
	window: UsageWindow,
	tier: string | undefined,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
	return percentLimit(id, label, usedPercent, window, tier, accountId);
}

function formatRollingWindowLabel(minutes: number | undefined): string {
	if (minutes === undefined) return "Rolling Window";
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} ${hours === 1 ? "Hour" : "Hours"}`;
	}
	return `${minutes} ${minutes === 1 ? "Minute" : "Minutes"}`;
}

function rollingWindow(minutes: number | undefined): UsageWindow {
	const valid = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
	const durationMs = valid ? minutes * 60_000 : undefined;
	const label = formatRollingWindowLabel(valid ? Math.round(minutes) : undefined);
	const id = durationMs === undefined ? "rolling" : `${Math.round(durationMs / 60_000)}m`;
	return { id, label, durationMs };
}

function buildLimits(
	usage: MuseCodeSubscriptionUsage,
	tier: string | undefined,
	accountId: string | undefined,
): UsageLimit[] {
	const limits: UsageLimit[] = [];
	if (usage.window) {
		const window = rollingWindow(usage.window.window_duration_mins);
		const limit = buildLimit(
			window.id,
			window.label,
			usage.window.used_percent,
			{ ...window, resetsAt: parseResetTimestamp(usage.window.resets_at) },
			tier,
			accountId,
		);
		if (limit) limits.push(limit);
	}
	if (usage.weekly) {
		const limit = buildLimit(
			WEEKLY_ID,
			"Weekly",
			usage.weekly.used_percent,
			{
				id: WEEKLY_ID,
				label: "Weekly",
				durationMs: WEEK_MS,
				resetsAt: parseResetTimestamp(usage.weekly.resets_at),
			},
			tier,
			accountId,
		);
		if (limit) limits.push(limit);
	}
	return limits;
}

/**
 * Limits for a key response that omits `subs_usage`, which Meta does while the
 * rolling window is idle: no request has opened one, so it is unused. Weekly
 * usage only accrues inside a rolling window, so the previous report's weekly
 * figure holds until its reset and is zero after it. The carried figure is a
 * lower bound: usage after that report (late in its window, or from another
 * client on the same subscription) is not visible. Meta's weekly reset is a
 * fixed weekly boundary (observed at Monday 00:00 UTC), so a passed reset rolls
 * forward by whole weeks. Without a previous weekly figure and its reset the
 * weekly limit stays unreported: an unbounded carry would present old usage as
 * current forever.
 */
function buildIdleLimits(
	previous: UsageReport | undefined,
	tier: string | undefined,
	accountId: string | undefined,
	now: number,
): UsageLimit[] {
	const previousRolling = previous?.limits.find(limit => ROLLING_ID.test(limit.id));
	const shape = previousRolling?.window ?? rollingWindow(DEFAULT_ROLLING_MINUTES);
	const window: UsageWindow = { id: shape.id, label: shape.label, durationMs: shape.durationMs };
	const limits = [
		percentLimit(window.id, window.label, 0, window, tier, accountId, ["Idle: no request has opened this window"]),
	];
	const previousWeekly = previous?.limits.find(limit => limit.id === WEEKLY_ID);
	const usedFraction = previousWeekly ? resolveUsedFraction(previousWeekly) : undefined;
	let resetsAt = previousWeekly?.window?.resetsAt;
	if (usedFraction === undefined || resetsAt === undefined) return limits;
	const reset = resetsAt <= now;
	if (reset) resetsAt += (Math.floor((now - resetsAt) / WEEK_MS) + 1) * WEEK_MS;
	limits.push(
		percentLimit(
			WEEKLY_ID,
			"Weekly",
			reset ? 0 : usedFraction * 100,
			{ id: WEEKLY_ID, label: "Weekly", durationMs: WEEK_MS, resetsAt },
			tier,
			accountId,
			[
				reset
					? "Reset since the last reported usage"
					: "Carried from the last reported usage; later usage not visible",
			],
		),
	);
	return limits;
}

export const museCodeUsageProvider: UsageProvider = {
	id: PROVIDER,
	validatesCredentials: true,
	failureBackoffMs: FAILURE_BACKOFF_MS,

	supports(params: UsageFetchParams): boolean {
		if (params.provider !== PROVIDER || params.credential.type !== "oauth" || !params.credential.accessToken) {
			return false;
		}
		try {
			parseMuseCodeCredential(params.credential.accessToken);
			return true;
		} catch {
			return false;
		}
	},

	async fetchUsage(params, ctx): Promise<UsageReport | null> {
		if (params.provider !== PROVIDER || params.credential.type !== "oauth") return null;
		const encodedCredential = params.credential.accessToken?.trim();
		if (!encodedCredential) return null;
		const { oauthAccessToken } = parseMuseCodeCredential(encodedCredential);

		let payload: MuseCodeKeyResponse;
		try {
			payload = await requestMuseCodeKey(oauthAccessToken, { fetch: ctx.fetch, signal: params.signal });
		} catch (error) {
			if (error instanceof AIError.OAuthError && (error.status === 401 || error.status === 403)) {
				throw new AIError.ProviderHttpError(error.message, error.status, { cause: error });
			}
			return null;
		}
		if (payload.is_subs_active === false) {
			throw new AIError.ProviderHttpError("Muse Code subscription is inactive", 403);
		}
		const email = payload.user_email?.trim().toLowerCase() || params.credential.email;
		const accountId = payload.user_id?.trim() || params.credential.accountId || email;
		const tier = payload.subs_tier_name?.trim() || payload.subs_tier_id?.trim() || undefined;
		const now = Date.now();
		// Payment-required responses omit `subs_usage` too; only an explicitly
		// active subscription with no payment demand or action means an idle window.
		const idle =
			payload.is_subs_active === true &&
			payload.require_payment !== true &&
			!payload.require_payment_action_url?.trim() &&
			!payload.action_url?.trim();
		const limits = payload.subs_usage
			? buildLimits(payload.subs_usage, tier, accountId)
			: idle
				? buildIdleLimits(ctx.previousReport, tier, accountId, now)
				: [];
		if (limits.length === 0) return null;
		const raw = { ...payload };
		delete raw.api_key;

		return {
			provider: PROVIDER,
			fetchedAt: now,
			limits,
			metadata: {
				source: SOURCE,
				...(email ? { email } : {}),
				...(accountId ? { accountId } : {}),
				...(payload.subs_tier_name ? { tier: payload.subs_tier_name } : {}),
			},
			raw,
		};
	},
};
