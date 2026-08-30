/**
 * Devin (Codeium Cascade) account plan + credit usage provider.
 *
 * Devin ships no REST usage endpoint: plan tier, credit balances, the
 * daily/weekly quota windows and the account identity all come back from the
 * single `SeatManagementService/GetUserStatus` unary Connect RPC the native CLI
 * issues at startup. The request body is raw (unframed) protobuf carrying the
 * CLI identity metadata plus the session token; the backend gates the CLI
 * surface on that identity tuple.
 */

import {
	BillingStrategy,
	GetUserStatusRequestSchema,
	type GetUserStatusResponse,
	GetUserStatusResponseSchema,
	MetadataSchema,
	type PlanInfo,
	type PlanStatus,
	TeamsTier,
	type Timestamp,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { DEVIN_DEFAULT_BASE_URL, devinCliMetadata, normalizeDevinSessionToken } from "@oh-my-pi/pi-catalog/wire/devin";
import { decodeDevinUnaryMessage } from "@oh-my-pi/pi-catalog/wire/devin-proto";
import type {
	UsageAmount,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageScope,
	UsageWindow,
} from "../usage";
import { DAY_MS, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "devin";
// Seat management lives on the Cascade backend, never on the `api.devin.ai`
// host stored as the credential's `apiEndpoint` (that one only mints the CLI
// session token), so the credential endpoint is deliberately not consulted.
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

const MICROS_PER_USD = 1_000_000;

function timestampMs(timestamp: Timestamp): number {
	return Number(timestamp.seconds) * 1_000 + timestamp.nanos / 1_000_000;
}

/** Session token as the CLI sends it: the wire format carries the scheme prefix. */
function devinSessionToken(credential: UsageCredential): string | undefined {
	const raw = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
	const token = raw?.trim();
	return token ? normalizeDevinSessionToken(token) : undefined;
}

/** `TEAMS_TIER_DEVIN_PRO` → `Devin Pro`, for plans that ship no `plan_name`. */
function devinTierLabel(tier: TeamsTier): string | undefined {
	if (tier === TeamsTier.UNSPECIFIED) return undefined;
	const name = TeamsTier[tier];
	if (!name) return undefined;
	return name
		.toLowerCase()
		.split("_")
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** Billing-cycle window shared by every credit bucket; `plan_end` is the reset. */
function devinPlanWindow(planStatus: PlanStatus): UsageWindow {
	const start = planStatus.planStart ? timestampMs(planStatus.planStart) : undefined;
	const end = planStatus.planEnd ? timestampMs(planStatus.planEnd) : undefined;
	const durationMs = start !== undefined && end !== undefined && end > start ? end - start : undefined;
	return {
		id: "monthly",
		label: "Plan Period",
		...(durationMs !== undefined ? { durationMs } : {}),
		...(end !== undefined && end > 0 ? { resetsAt: end } : {}),
	};
}

interface DevinCreditBucket {
	id: string;
	label: string;
	/** Monthly grant for the bucket; 0 when the plan grants none. */
	limit: number;
	used: number;
	/** Server-reported balance — top-ups make this diverge from `limit - used`. */
	available: number;
}

/** Credits carry no catalog unit; xAI's quota-point precedent uses `unknown`. */
function devinCreditLimit(bucket: DevinCreditBucket, window: UsageWindow, scope: UsageScope): UsageLimit | undefined {
	const limit = bucket.limit > 0 ? bucket.limit : undefined;
	const used = Math.max(0, bucket.used);
	const remaining = Math.max(0, bucket.available);
	if (limit === undefined && used === 0 && remaining === 0) return undefined;
	const usedFraction = limit !== undefined ? used / limit : undefined;
	const amount: UsageAmount = {
		used,
		remaining,
		...(limit !== undefined ? { limit } : {}),
		...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
		unit: "unknown",
	};
	return {
		id: `devin:credits:${bucket.id}`,
		label: bucket.label,
		scope: { ...scope, windowId: window.id },
		window,
		amount,
		status: usageStatus(usedFraction),
	};
}

interface DevinQuotaWindow {
	id: "daily" | "weekly";
	label: string;
	windowId: string;
	durationMs: number;
	/** `*_quota_remaining_percent`, 0..100. */
	remainingPercent: number;
	/** `*_quota_reset_at_unix`, epoch seconds; 0 when the plan has no such window. */
	resetAtUnix: bigint;
	hidden: boolean;
}

/**
 * Credit-billed plans leave the quota percents at their proto defaults, which
 * would read as a fully consumed window. Only surface a percent window when the
 * server dated it, or when the plan is explicitly quota-billed.
 */
function devinQuotaApplies(quota: DevinQuotaWindow, plan: PlanInfo | undefined): boolean {
	if (quota.hidden) return false;
	if (quota.resetAtUnix > 0n) return true;
	return plan?.billingStrategy === BillingStrategy.QUOTA;
}

function devinQuotaLimit(quota: DevinQuotaWindow, scope: UsageScope): UsageLimit {
	const remaining = Math.max(0, Math.min(100, quota.remainingPercent));
	const used = 100 - remaining;
	const usedFraction = used / 100;
	const resetsAt = parsePositiveTimestamp(Number(quota.resetAtUnix));
	return {
		id: `devin:quota:${quota.id}`,
		label: quota.label,
		scope: { ...scope, windowId: quota.windowId },
		window: {
			id: quota.windowId,
			label: quota.label,
			durationMs: quota.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			limit: 100,
			remaining,
			usedFraction,
			remainingFraction: remaining / 100,
			unit: "percent",
		},
		status: usageStatus(usedFraction),
	};
}

function buildDevinReport(response: GetUserStatusResponse): UsageReport | null {
	const userStatus = response.userStatus;
	if (!userStatus) return null;
	const planStatus = userStatus.planStatus;
	// `GetUserStatusResponse.plan_info` is the authoritative copy; the one nested
	// under `plan_status` is the same message and only fills in for older servers.
	const plan = response.planInfo ?? planStatus?.planInfo;
	const email = userStatus.email.trim() || undefined;
	const accountId = userStatus.userId.trim() || undefined;
	const orgId = plan?.devinInfo?.orgId.trim() || userStatus.teamId.trim() || undefined;
	const orgName = plan?.devinInfo?.accountDisplayName.trim() || undefined;
	const planName = plan?.planName.trim() || devinTierLabel(plan?.teamsTier ?? userStatus.teamsTier);

	const scope: UsageScope = {
		provider: PROVIDER,
		...(accountId !== undefined ? { accountId } : {}),
		...(orgId !== undefined ? { orgId } : {}),
		...(planName !== undefined ? { tier: planName } : {}),
	};

	const limits: UsageLimit[] = [];
	if (planStatus) {
		const planWindow = devinPlanWindow(planStatus);
		const buckets: DevinCreditBucket[] = [
			{
				id: "prompt",
				label: "Prompt Credits",
				limit: plan?.monthlyPromptCredits ?? 0,
				used: planStatus.usedPromptCredits,
				available: planStatus.availablePromptCredits,
			},
			{
				id: "flow",
				label: "Flow Credits",
				limit: plan?.monthlyFlowCredits ?? 0,
				used: planStatus.usedFlowCredits,
				available: planStatus.availableFlowCredits,
			},
			{
				id: "flex",
				label: "Flex Credits",
				limit: plan?.monthlyFlexCreditPurchaseAmount ?? 0,
				used: planStatus.usedFlexCredits,
				available: planStatus.availableFlexCredits,
			},
		];
		for (const bucket of buckets) {
			const limit = devinCreditLimit(bucket, planWindow, scope);
			if (limit) limits.push(limit);
		}
		const quotas: DevinQuotaWindow[] = [
			{
				id: "daily",
				label: "Daily Quota",
				windowId: "1d",
				durationMs: DAY_MS,
				remainingPercent: planStatus.dailyQuotaRemainingPercent,
				resetAtUnix: planStatus.dailyQuotaResetAtUnix,
				hidden: plan?.hideDailyQuota === true,
			},
			{
				id: "weekly",
				label: "Weekly Quota",
				windowId: "7d",
				durationMs: WEEK_MS,
				remainingPercent: planStatus.weeklyQuotaRemainingPercent,
				resetAtUnix: planStatus.weeklyQuotaResetAtUnix,
				hidden: plan?.hideWeeklyQuota === true,
			},
		];
		for (const quota of quotas) {
			if (devinQuotaApplies(quota, plan)) limits.push(devinQuotaLimit(quota, scope));
		}
	}

	const planEnd = planStatus?.planEnd ? timestampMs(planStatus.planEnd) : undefined;
	const overageUsd = Number(planStatus?.overageBalanceMicros ?? 0n) / MICROS_PER_USD;
	const metadata: Record<string, unknown> = { source: "seat-management" };
	if (email !== undefined) metadata.email = email;
	if (accountId !== undefined) metadata.accountId = accountId;
	if (orgId !== undefined) metadata.orgId = orgId;
	if (orgName !== undefined) metadata.orgName = orgName;
	if (planName !== undefined) metadata.planType = planName;
	if (planEnd !== undefined && planEnd > 0) metadata.planEnd = planEnd;
	if (overageUsd !== 0) metadata.overageBalanceUsd = overageUsd;

	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		...(overageUsd !== 0 ? { notes: [`Overage balance: $${overageUsd.toFixed(2)}`] } : {}),
		metadata,
	};
}

async function fetchDevinUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const token = devinSessionToken(params.credential);
	if (!token) return null;
	const baseUrl = (params.baseUrl ?? DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");

	try {
		const request = create(GetUserStatusRequestSchema, {
			metadata: create(MetadataSchema, devinCliMetadata(token)),
		});
		const response = await ctx.fetch(`${baseUrl}${GET_USER_STATUS_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/proto",
				"connect-protocol-version": "1",
				accept: "*/*",
			},
			body: toBinary(GetUserStatusRequestSchema, request),
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Devin user status fetch failed", { provider: PROVIDER, status: response.status });
			return null;
		}
		const decoded = decodeDevinUnaryMessage(
			GetUserStatusResponseSchema,
			new Uint8Array(await response.arrayBuffer()),
		);
		const report = decoded ? buildDevinReport(decoded) : null;
		if (!report) {
			ctx.logger?.warn("Devin user status response invalid", { provider: PROVIDER });
			return null;
		}
		return report;
	} catch (error) {
		ctx.logger?.warn("Devin user status request failed", {
			provider: PROVIDER,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

export const devinUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchDevinUsage,
	supports: params => params.provider === PROVIDER && devinSessionToken(params.credential) !== undefined,
	validatesCredentials: true,
};
