import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { buildUsageAmount, HOUR_MS, parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

function parseDollarAmount(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/^\$/, "").trim();
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRollingFiveHourLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const remaining = typeof raw.remaining === "number" ? raw.remaining : undefined;
	const max = typeof raw.max === "number" ? raw.max : undefined;
	const limited = raw.limited === true;
	const nextTickAt = parseIsoTimestamp(raw.nextTickAt);
	const tickPercent = typeof raw.tickPercent === "number" ? raw.tickPercent : undefined;

	if (remaining === undefined && max === undefined) return null;

	const used = max !== undefined && remaining !== undefined ? max - remaining : undefined;
	const regenPercent = tickPercent !== undefined ? Number((tickPercent * 100).toFixed(2)) : undefined;
	const window: UsageWindow = {
		id: "5h",
		label: regenPercent !== undefined ? `5h · regen ${regenPercent}%/tick` : "5h",
		durationMs: 5 * HOUR_MS,
		...(nextTickAt !== undefined ? { resetsAt: nextTickAt, resetLabel: "tick" } : {}),
	};
	const amount = buildUsageAmount({ used, limit: max, remaining, unit: "requests" });
	const status: UsageStatus = limited ? "exhausted" : usageStatus(amount.usedFraction ?? 0);
	return {
		id: "synthetic:requests:5h",
		label: "Synthetic Requests",
		scope: { provider, windowId: "5h", shared: true },
		window,
		amount,
		status,
	};
}

function parseWeeklyTokenLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const remainingCredits = parseDollarAmount(raw.remainingCredits);
	const maxCredits = parseDollarAmount(raw.maxCredits);
	const percentRemaining = typeof raw.percentRemaining === "number" ? raw.percentRemaining : undefined;
	const nextRegenAt = parseIsoTimestamp(raw.nextRegenAt);

	if (remainingCredits === undefined && maxCredits === undefined) return null;

	const usedFraction =
		percentRemaining !== undefined ? Math.min(Math.max(1 - percentRemaining / 100, 0), 1) : undefined;
	const used = usedFraction !== undefined && maxCredits !== undefined ? usedFraction * maxCredits : undefined;
	const nextRegenCredits = parseDollarAmount(raw.nextRegenCredits);
	const window: UsageWindow = {
		id: "7d",
		label: nextRegenCredits !== undefined ? `7d · regen $${nextRegenCredits.toFixed(2)}/tick` : "7d",
		durationMs: WEEK_MS,
		...(nextRegenAt !== undefined ? { resetsAt: nextRegenAt, resetLabel: "regen" } : {}),
	};
	const amount = buildUsageAmount({
		used,
		limit: maxCredits,
		remaining: remainingCredits,
		usedFraction,
		unit: "usd",
	});
	return {
		id: "synthetic:usd:7d",
		label: "Synthetic Credits",
		scope: { provider, windowId: "7d", shared: true },
		window,
		amount,
		status: amount.usedFraction === undefined ? undefined : usageStatus(amount.usedFraction),
	};
}

async function fetchSyntheticUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "synthetic") return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	let payload: unknown = null;
	try {
		const response = await ctx.fetch(QUOTAS_URL, {
			headers: {
				Authorization: `Bearer ${credential.apiKey}`,
				"Content-Type": "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Synthetic usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("Synthetic usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;

	const limits: UsageLimit[] = [];

	const fiveHour = parseRollingFiveHourLimit(payload.rollingFiveHourLimit, params.provider);
	if (fiveHour) limits.push(fiveHour);

	const weekly = parseWeeklyTokenLimit(payload.weeklyTokenLimit, params.provider);
	if (weekly) limits.push(weekly);

	if (limits.length === 0) return null;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: QUOTAS_URL },
		raw: payload,
	};
}

export const syntheticUsageProvider: UsageProvider = {
	id: "synthetic",
	fetchUsage: fetchSyntheticUsage,
	supports: params => params.provider === "synthetic" && params.credential.type === "api_key",
};
