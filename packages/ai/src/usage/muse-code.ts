import * as AIError from "../error";
import { parseMuseCodeCredential, requestMuseCodeKey, type MuseCodeKeyResponse } from "../registry/oauth/muse-code";
import type { UsageAmount, UsageFetchParams, UsageLimit, UsageProvider, UsageReport, UsageWindow } from "../usage";
import { parseIsoTimestamp, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "muse-code";
const SOURCE = "api.meta.ai/muse-code/key";
const FAILURE_BACKOFF_MS = 5 * 60_000;

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

function buildLimit(
	id: string,
	label: string,
	usedPercent: number | undefined,
	window: UsageWindow,
	tier: string | undefined,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
	const amount = percentAmount(usedPercent);
	return {
		id,
		label,
		scope: { provider: PROVIDER, accountId, tier, windowId: window.id, shared: true },
		window,
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

function formatRollingWindowLabel(minutes: number | undefined): string {
	if (minutes === undefined) return "Rolling Window";
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} ${hours === 1 ? "Hour" : "Hours"}`;
	}
	return `${minutes} ${minutes === 1 ? "Minute" : "Minutes"}`;
}

function buildLimits(payload: MuseCodeKeyResponse, accountId: string | undefined): UsageLimit[] {
	const usage = payload.subs_usage;
	if (!usage) return [];
	const tier = payload.subs_tier_name?.trim() || payload.subs_tier_id?.trim() || undefined;
	const limits: UsageLimit[] = [];
	if (usage.window) {
		const minutes = usage.window.window_duration_mins;
		const durationMs =
			typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
		const label = formatRollingWindowLabel(
			typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined,
		);
		const id = durationMs === undefined ? "rolling" : `${Math.round(durationMs / 60_000)}m`;
		const limit = buildLimit(
			id,
			label,
			usage.window.used_percent,
			{
				id,
				label,
				durationMs,
				resetsAt: parseResetTimestamp(usage.window.resets_at),
			},
			tier,
			accountId,
		);
		if (limit) limits.push(limit);
	}
	if (usage.weekly) {
		const limit = buildLimit(
			"1w",
			"Weekly",
			usage.weekly.used_percent,
			{
				id: "1w",
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
		const limits = buildLimits(payload, accountId);
		if (limits.length === 0) return null;
		const raw = { ...payload };
		delete raw.api_key;

		return {
			provider: PROVIDER,
			fetchedAt: Date.now(),
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
