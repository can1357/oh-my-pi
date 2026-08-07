import { FACTORY_DROID_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/discovery";
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
/** Matches the CLI version the wire contract was verified against. */
const FACTORY_DROID_CLIENT_VERSION = "0.189.0";

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
 * Parses `GET /api/billing/limits` (the payload the droid CLI renders in its
 * usage footer) into a usage report: per-pool (Standard credits / Droid Core)
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

			const windowEnd = typeof windowValue.windowEnd === "string" ? Date.parse(windowValue.windowEnd) : undefined;
			const window: UsageWindow = {
				id: `${pool.key}-${windowDef.id}`,
				label: `${pool.label} ${windowDef.label}`,
				durationMs: windowDef.durationMs,
				...(windowEnd !== undefined && Number.isFinite(windowEnd) ? { resetsAt: windowEnd } : {}),
			};

			const usedFraction = Math.min(1, Math.max(0, usedPercent / 100));
			const amount: UsageAmount = {
				used: usedPercent,
				limit: 100,
				remaining: Math.max(0, 100 - usedPercent),
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

		try {
			const response = await ctx.fetch(FACTORY_BILLING_LIMITS_URL, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${credential.accessToken}`,
					"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
					"X-Factory-Client": "cli",
				},
				signal: params.signal,
			});
			if (!response.ok) {
				ctx.logger?.warn("Factory Droid usage request failed", {
					status: response.status,
					provider: params.provider,
				});
				return null;
			}
			const payload: unknown = await response.json();
			const report = parseFactoryDroidUsage(payload);
			if (report) {
				const metadata = {
					...(credential.email ? { email: credential.email } : {}),
					...(credential.orgId ? { orgId: credential.orgId } : {}),
				};
				if (Object.keys(metadata).length > 0) report.metadata = metadata;
			}
			return report;
		} catch (error) {
			ctx.logger?.warn("Factory Droid usage request error", {
				provider: params.provider,
				error: String(error),
			});
			return null;
		}
	},
};
