import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { factoryDroidApiBaseUrl, factoryDroidClientHeaders } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const WINDOW_DEFS = [
	{ key: "fiveHour", id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", id: "weekly", label: "Weekly", durationMs: WEEK_MS },
	{ key: "monthly", id: "monthly", label: "Monthly", durationMs: 30 * DAY_MS },
] as const;

const POOL_DEFS = [
	{ key: "standard", label: "Standard credits" },
	{ key: "core", label: "Droid Core" },
] as const;

/**
 * Parses `GET /api/billing/limits` into a usage report: per-pool
 * (Standard credits / Droid Core)
 * × per-window (5h / weekly / monthly) percent-used limits, plus the extra
 * usage balance when present.
 */
export function parseFactoryDroidUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	if (payload.usesTokenRateLimitsBilling === false) {
		return {
			provider: "factory-droid",
			fetchedAt,
			limits: [],
			notes: ["This Factory account does not use token-rate-limit billing; no quota windows are exposed."],
			raw: payload,
		};
	}
	if (!isRecord(payload.limits)) return null;
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
			const windowEnd = parseIsoTimestamp(windowValue.windowEnd);
			const active = windowEnd !== undefined && windowEnd >= fetchedAt;
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
				status: usageStatus(usedFraction),
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
 * Fetches scoped billing usage for account display and ranking. A 401/403
 * means the credential lost access and throws so cached quota is dropped;
 * any other failure means quota unknown. Inference failures never trigger a
 * billing probe.
 */
async function fetchFactoryDroidUsageReport(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
	scope: { region?: string; orgId?: string } = {},
): Promise<UsageReport | null> {
	try {
		const response = await fetchImpl(`${factoryDroidApiBaseUrl(scope.region)}/api/billing/limits`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				...factoryDroidClientHeaders(scope.orgId),
			},
			signal,
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Factory Droid usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			return null;
		}
		const payload: unknown = await response.json();
		return parseFactoryDroidUsage(payload);
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		return null;
	}
}

export const factoryDroidUsageProvider: UsageProvider = {
	cacheVersion: 4,
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

		const report = await fetchFactoryDroidUsageReport(credential.accessToken, ctx.fetch, params.signal, credential);
		if (!report) {
			ctx.logger?.warn("Factory Droid usage request failed", { provider: params.provider });
			return null;
		}
		const metadata = {
			...(credential.email ? { email: credential.email } : {}),
			...(credential.orgId ? { orgId: credential.orgId } : {}),
		};
		if (Object.keys(metadata).length > 0) report.metadata = metadata;
		return report;
	},
};

/** Limits a model's pool draws from; unknown models see every quota window. */
function scopeFactoryDroidLimits(report: UsageReport, context?: CredentialRankingContext): UsageLimit[] {
	// The billing pool is the `quota-tiers provider="factory-droid"` KDL rule.
	const pool = context?.modelId ? quotaTierFor("factory-droid", context.modelId) : undefined;
	if (!pool) return report.limits.filter(limit => limit.id !== "factory-droid:extra-balance");
	return report.limits.filter(limit => limit.id.startsWith(`factory-droid:${pool}:`));
}

/** Factory's Core and Standard credits have independent subscription windows. */
export const factoryDroidRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		const limits = scopeFactoryDroidLimits(report, context);
		return {
			primary: limits.find(limit => limit.window?.id.endsWith("-5h")),
			secondary: limits.find(limit => limit.window?.id.endsWith("-weekly")),
		};
	},
	scopeLimits: scopeFactoryDroidLimits,
	blockScope(context) {
		const pool = context?.modelId ? quotaTierFor("factory-droid", context.modelId) : undefined;
		return pool ? `pool:${pool}` : "pool:unknown";
	},
	blockScopes(context) {
		if (!context) return ["pool:core", "pool:standard", "pool:unknown"];
		const pool = context.modelId ? quotaTierFor("factory-droid", context.modelId) : undefined;
		return pool ? [`pool:${pool}`] : ["pool:unknown"];
	},
	healableBlockScopes(report) {
		// A funded balance alone does not establish permission or preference to use it.
		return [
			...(["core", "standard"] as const).map(pool => ({
				blockScope: `pool:${pool}`,
				limits: report.limits.filter(limit => limit.id.startsWith(`factory-droid:${pool}:`)),
			})),
			{
				blockScope: "pool:unknown",
				limits: report.limits.filter(limit => limit.id !== "factory-droid:extra-balance"),
			},
		];
	},
	windowDefaults: { primaryMs: 5 * HOUR_MS, secondaryMs: WEEK_MS },
};
