import { FACTORY_DROID_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/discovery";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";

const FACTORY_BILLING_LIMITS_URL = "https://api.factory.ai/api/billing/limits";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WINDOW_DEFS = [
	{ key: "fiveHour", id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60_000 },
	{ key: "weekly", id: "weekly", label: "Weekly", durationMs: 7 * 24 * 60 * 60_000 },
	{ key: "monthly", id: "monthly", label: "Monthly", durationMs: 30 * 24 * 60 * 60_000 },
] as const;

const POOL_DEFS = [
	{ key: "standard", label: "Standard credits" },
	{ key: "core", label: "Droid Core" },
] as const;

function statusFor(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * Parses `GET /api/billing/limits` into a usage report: per-pool
 * (Standard credits / Droid Core)
 * × per-window (5h / weekly / monthly) percent-used limits, plus the extra
 * usage balance when present.
 */
export function parseFactoryDroidUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !isRecord(payload.limits)) return null;
	const limits: UsageLimit[] = [];

	for (const pool of POOL_DEFS) {
		const poolValue = payload.limits[pool.key];
		if (!isRecord(poolValue)) continue;
		for (const windowDef of WINDOW_DEFS) {
			const windowValue = poolValue[windowDef.key];
			if (!isRecord(windowValue)) continue;
			const usedPercent = toNumber(windowValue.usedPercent);
			if (usedPercent === undefined) continue;

			// Factory freezes a window at its last-used state when it lapses
			// instead of rolling it forward: an idle pool keeps reporting its
			// final usedPercent (e.g. 100) with a past windowEnd indefinitely,
			// and the next window starts lazily on the next request. The droid
			// CLI treats windowEnd >= now as "active" and filters everything
			// else out of the display ("Use Droid to start"); mirror that —
			// an inactive window reads as 0% used with no reset countdown.
			const windowEnd = typeof windowValue.windowEnd === "string" ? Date.parse(windowValue.windowEnd) : undefined;
			const active = windowEnd !== undefined && Number.isFinite(windowEnd) && windowEnd >= fetchedAt;
			const window: UsageWindow = {
				id: `${pool.key}-${windowDef.id}`,
				label: `${pool.label} ${windowDef.label}`,
				durationMs: windowDef.durationMs,
				...(active ? { resetsAt: windowEnd } : {}),
			};

			const effectiveUsedPercent = active ? usedPercent : 0;
			const usedFraction = Math.min(1, Math.max(0, effectiveUsedPercent / 100));
			const amount: UsageAmount = {
				used: effectiveUsedPercent,
				limit: 100,
				remaining: Math.max(0, 100 - effectiveUsedPercent),
				usedFraction,
				remainingFraction: Math.max(0, 1 - usedFraction),
				unit: "percent",
			};
			limits.push({
				id: `factory-droid:${pool.key}:${windowDef.id}`,
				label: `${pool.label} ${windowDef.label} window`,
				scope: { provider: "factory-droid", windowId: window.id },
				window,
				amount,
				status: statusFor(usedFraction),
			});
		}
	}

	const balanceCents = toNumber(payload.extraUsageBalanceCents);
	if (balanceCents !== undefined && balanceCents > 0) {
		const balanceUsd = balanceCents / 100;
		limits.push({
			id: "factory-droid:extra-balance",
			label: "Extra usage balance",
			scope: { provider: "factory-droid" },
			amount: {
				used: 0,
				limit: balanceUsd,
				remaining: balanceUsd,
				usedFraction: 0,
				remainingFraction: 1,
				unit: "usd",
			},
			status: "ok",
		});
	}

	if (limits.length === 0) return null;
	return { provider: "factory-droid", fetchedAt, limits, raw: payload };
}

/**
 * Fetches and parses `GET /api/billing/limits`. Shared between the usage
 * provider (quota widgets) and the factory-droid transport's error path,
 * which re-checks pool state to turn the proxy's bare 403s into actionable
 * quota messages. Returns null on any failure — callers treat that as
 * "quota unknown", never as exhaustion.
 */
export async function fetchFactoryDroidUsageReport(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<UsageReport | null> {
	try {
		const response = await fetchImpl(FACTORY_BILLING_LIMITS_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
				"X-Factory-Client": "cli",
			},
			signal,
		});
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		return parseFactoryDroidUsage(payload);
	} catch {
		return null;
	}
}

export const factoryDroidUsageProvider: UsageProvider = {
	id: "factory-droid",
	supports(params: UsageFetchParams): boolean {
		if (params.provider !== "factory-droid") return false;
		const { credential } = params;
		return credential.type === "oauth" ? Boolean(credential.accessToken) : false;
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "factory-droid") return null;
		const { credential } = params;
		if (credential.type !== "oauth" || !credential.accessToken) return null;

		const report = await fetchFactoryDroidUsageReport(credential.accessToken, ctx.fetch, params.signal);
		if (!report) {
			ctx.logger?.warn("Factory Droid usage request failed", { provider: params.provider });
			return null;
		}
		if (report) {
			const metadata = {
				...(credential.email ? { email: credential.email } : {}),
				...(credential.orgId ? { orgId: credential.orgId } : {}),
			};
			if (Object.keys(metadata).length > 0) report.metadata = metadata;
		}
		return report;
	},
};
