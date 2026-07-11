import type { UsageCostHistoryEntry, UsageLimit, UsageProvider, UsageWindow } from "../usage";

const OPENCODE_GO_PROVIDER = "opencode-go";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OPENCODE_GO_LIMITS = [
	{ id: "rolling-5h", label: "5 Hour", durationMs: 5 * HOUR_MS, limitUsd: 12 },
	{ id: "weekly", label: "Weekly", durationMs: 7 * DAY_MS, limitUsd: 30 },
	{ id: "monthly", label: "Monthly", durationMs: 30 * DAY_MS, limitUsd: 60 },
] as const;

function sumWindowCosts(entries: UsageCostHistoryEntry[], sinceMs: number): { used: number; resetsAt?: number } {
	let used = 0;
	let firstRecordedAt: number | undefined;
	for (const entry of entries) {
		if (entry.recordedAt < sinceMs) continue;
		used += entry.costUsd;
		if (firstRecordedAt === undefined || entry.recordedAt < firstRecordedAt) {
			firstRecordedAt = entry.recordedAt;
		}
	}
	return { used, resetsAt: firstRecordedAt };
}

function resolveStatus(usedFraction: number): UsageLimit["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function buildWindowLimit(
	limit: (typeof OPENCODE_GO_LIMITS)[number],
	entries: UsageCostHistoryEntry[],
	nowMs: number,
): UsageLimit {
	const sinceMs = nowMs - limit.durationMs;
	const windowCost = sumWindowCosts(entries, sinceMs);
	const used = Number(windowCost.used.toFixed(6));
	const usedFraction = used / limit.limitUsd;
	const window: UsageWindow = {
		id: limit.id,
		label: limit.label,
		durationMs: limit.durationMs,
	};
	if (windowCost.resetsAt !== undefined) {
		window.resetsAt = windowCost.resetsAt + limit.durationMs;
	}
	return {
		id: limit.id,
		label: `${limit.label} limit`,
		scope: {
			provider: OPENCODE_GO_PROVIDER,
			windowId: limit.id,
		},
		window,
		amount: {
			used,
			limit: limit.limitUsd,
			remaining: Math.max(0, limit.limitUsd - used),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "usd",
		},
		status: resolveStatus(usedFraction),
	};
}

export const opencodeGoUsageProvider: UsageProvider = {
	id: OPENCODE_GO_PROVIDER,
	supports: params => params.provider === OPENCODE_GO_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: false,
	async fetchUsage(params, ctx) {
		if (params.provider !== OPENCODE_GO_PROVIDER || params.credential.type !== "api_key") return null;
		const nowMs = Date.now();
		const sinceMs = nowMs - OPENCODE_GO_LIMITS[OPENCODE_GO_LIMITS.length - 1]!.durationMs;
		const entries =
			ctx.listUsageCosts?.({ provider: OPENCODE_GO_PROVIDER, accountKey: params.accountKey, sinceMs }) ?? [];
		return {
			provider: OPENCODE_GO_PROVIDER,
			fetchedAt: nowMs,
			limits: OPENCODE_GO_LIMITS.map(limit => buildWindowLimit(limit, entries, nowMs)),
			notes: ["OMP-observed spend only; OpenCode usage outside OMP is not included."],
			metadata: {
				planType: "OpenCode Go",
				source: "omp-observed-request-costs",
			},
		};
	},
};
