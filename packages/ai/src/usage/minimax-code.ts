import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, parsePositiveTimestamp, usageStatus } from "./shared";

const INTL_PROVIDER = "minimax-code";
const INTL_BASE_URL = "https://api.minimax.io";
const REMAINS_PATH = "/v1/token_plan/remains";
/** `current_*_status` enum reported per window: 1 normal, 2 exhausted, 3 unlimited. */
const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;
/**
 * The plan-wide token quota every chat model draws from. It is a quota category,
 * not a catalog model id, so its limits are scoped `shared`: `AuthStorage` has no
 * MiniMax ranking strategy and would otherwise match `scope.modelId` against ids
 * like `MiniMax-M3` and drop the "models with usage data" mapping. Category
 * buckets such as `video` meter a separate quota and keep their own model scope.
 */
const SHARED_BUCKET = "general";

/** One `model_remains[]` bucket: a plan quota tracked over a rolling interval plus a weekly window. */
interface TokenPlanBucket {
	modelName: string;
	intervalStart?: number;
	intervalEnd?: number;
	intervalRemainingPercent?: number;
	intervalTotalCount?: number;
	intervalUsageCount?: number;
	intervalStatus?: number;
	weeklyStart?: number;
	weeklyEnd?: number;
	weeklyRemainingPercent?: number;
	weeklyTotalCount?: number;
	weeklyUsageCount?: number;
	weeklyStatus?: number;
}

/** `current_*_remaining_percent` is 0..100 remaining; usage fractions are 0..1 used. */
function usedFractionFromRemainingPercent(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || !Number.isFinite(parsed)) return undefined;
	// (100 - p) / 100 keeps whole percentages exact; 1 - p / 100 does not (90 → 0.09999999999999998).
	return Math.min(1, Math.max(0, (100 - parsed) / 100));
}

function parseBucket(value: unknown): TokenPlanBucket | null {
	if (!isRecord(value)) return null;
	const modelName = typeof value.model_name === "string" ? value.model_name.trim() : "";
	if (!modelName) return null;
	return {
		modelName,
		intervalStart: parsePositiveTimestamp(value.start_time),
		intervalEnd: parsePositiveTimestamp(value.end_time),
		intervalRemainingPercent: toNumber(value.current_interval_remaining_percent),
		intervalTotalCount: toNumber(value.current_interval_total_count),
		intervalUsageCount: toNumber(value.current_interval_usage_count),
		intervalStatus: toNumber(value.current_interval_status),
		weeklyStart: parsePositiveTimestamp(value.weekly_start_time),
		weeklyEnd: parsePositiveTimestamp(value.weekly_end_time),
		weeklyRemainingPercent: toNumber(value.current_weekly_remaining_percent),
		weeklyTotalCount: toNumber(value.current_weekly_total_count),
		weeklyUsageCount: toNumber(value.current_weekly_usage_count),
		weeklyStatus: toNumber(value.current_weekly_status),
	};
}

/**
 * A model outside the current plan is reported as both windows "unlimited"
 * with zero totals and 100% remaining, which would otherwise read as a pristine
 * quota. MiniMax's own CLI treats exactly this shape as "not in plan"
 * ([MiniMax-AI/cli#173](https://github.com/MiniMax-AI/cli/issues/173)), so the
 * bucket is kept out of the limits and named in `metadata.unavailableModels`.
 * Zero totals alone are not enough: a live plan reports `0/0` with status 1 and
 * a real remaining percentage.
 */
function isUnavailablePlan(bucket: TokenPlanBucket): boolean {
	return (
		bucket.intervalTotalCount === 0 &&
		bucket.weeklyTotalCount === 0 &&
		bucket.intervalStatus === STATUS_UNLIMITED &&
		bucket.weeklyStatus === STATUS_UNLIMITED
	);
}

/**
 * Interval length varies per bucket (text quotas roll every few hours, media
 * quotas daily), so the window id follows the reported span instead of a
 * hardcoded tier. Spans that are not whole hours are labelled in minutes
 * rather than rounded into a wrong hour count.
 */
function intervalWindowId(durationMs: number | undefined): { id: string; label: string } {
	if (durationMs === undefined || durationMs <= 0) return { id: "interval", label: "Interval" };
	if (durationMs % HOUR_MS === 0) {
		const hours = durationMs / HOUR_MS;
		return { id: `${hours}h`, label: `${hours} Hour` };
	}
	const minutes = Math.round(durationMs / 60_000);
	if (minutes <= 0) return { id: "interval", label: "Interval" };
	return { id: `${minutes}m`, label: `${minutes} Minute` };
}

function buildLimit(args: {
	provider: string;
	bucket: TokenPlanBucket;
	windowId: string;
	windowLabel: string;
	durationMs?: number;
	resetsAt?: number;
	usedFraction: number | undefined;
	windowStatus?: number;
	usageCount?: number;
	totalCount?: number;
	accountId?: string;
}): UsageLimit | undefined {
	// The endpoint's own status outranks the percentage: an exhausted window may
	// omit it, or keep a stale one that would otherwise render as healthy quota.
	const usedFraction = args.windowStatus === STATUS_EXHAUSTED ? 1 : args.usedFraction;
	if (usedFraction === undefined) return undefined;
	const totalCount = args.totalCount;
	return {
		id: `${args.bucket.modelName}:${args.windowId}`,
		label: `${args.bucket.modelName.charAt(0).toUpperCase()}${args.bucket.modelName.slice(1)} ${args.windowLabel}`,
		scope: {
			provider: args.provider,
			...(args.accountId ? { accountId: args.accountId } : {}),
			...(args.bucket.modelName === SHARED_BUCKET ? { shared: true as const } : { modelId: args.bucket.modelName }),
			windowId: args.windowId,
		},
		window: {
			id: args.windowId,
			label: args.windowLabel,
			...(args.durationMs !== undefined && args.durationMs > 0 ? { durationMs: args.durationMs } : {}),
			...(args.resetsAt ? { resetsAt: args.resetsAt } : {}),
		},
		amount: {
			used: usedFraction * 100,
			usedFraction,
			remaining: 100 - usedFraction * 100,
			remainingFraction: 1 - usedFraction,
			unit: "percent",
		},
		status: usageStatus(usedFraction),
		...(totalCount !== undefined && totalCount > 0
			? { notes: [`Requests: ${args.usageCount ?? 0}/${totalCount}`] }
			: {}),
	};
}

function buildBucketLimits(provider: string, bucket: TokenPlanBucket, accountId: string | undefined): UsageLimit[] {
	const intervalDuration =
		bucket.intervalStart !== undefined && bucket.intervalEnd !== undefined
			? bucket.intervalEnd - bucket.intervalStart
			: undefined;
	const weeklyDuration =
		bucket.weeklyStart !== undefined && bucket.weeklyEnd !== undefined
			? bucket.weeklyEnd - bucket.weeklyStart
			: undefined;
	const interval = intervalWindowId(intervalDuration);
	return [
		buildLimit({
			provider,
			bucket,
			windowId: interval.id,
			windowLabel: interval.label,
			durationMs: intervalDuration,
			resetsAt: bucket.intervalEnd,
			usedFraction: usedFractionFromRemainingPercent(bucket.intervalRemainingPercent),
			windowStatus: bucket.intervalStatus,
			usageCount: bucket.intervalUsageCount,
			totalCount: bucket.intervalTotalCount,
			accountId,
		}),
		buildLimit({
			provider,
			bucket,
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: weeklyDuration,
			resetsAt: bucket.weeklyEnd,
			usedFraction: usedFractionFromRemainingPercent(bucket.weeklyRemainingPercent),
			windowStatus: bucket.weeklyStatus,
			usageCount: bucket.weeklyUsageCount,
			totalCount: bucket.weeklyTotalCount,
			accountId,
		}),
	].filter((limit): limit is UsageLimit => limit !== undefined);
}

/**
 * MiniMax Token Plan usage provider (international, `api.minimax.io`).
 *
 * `GET /v1/token_plan/remains` returns one `model_remains[]` bucket per plan
 * quota (text, media, …), each carrying a rolling interval window and a weekly
 * window with the remaining percentage. MiniMax answers HTTP 200 even for
 * rejected credentials, so `base_resp.status_code` is the real success signal.
 */
async function fetchMiniMaxCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== INTL_PROVIDER) return null;
	const apiKey = params.credential.apiKey;
	if (params.credential.type !== "api_key" || !apiKey) return null;

	try {
		const configuredBaseUrl = params.baseUrl?.trim();
		const baseUrl = configuredBaseUrl ? configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") : INTL_BASE_URL;
		const response = await ctx.fetch(`${baseUrl}${REMAINS_PATH}`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("MiniMax Token Plan usage fetch failed", {
				provider: params.provider,
				status: response.status,
			});
			return null;
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload)) return null;
		const statusCode = isRecord(payload.base_resp) ? toNumber(payload.base_resp.status_code) : undefined;
		if (statusCode !== 0) {
			ctx.logger?.warn("MiniMax Token Plan usage response rejected", {
				provider: params.provider,
				statusCode: statusCode ?? "missing",
			});
			return null;
		}
		if (!Array.isArray(payload.model_remains)) return null;

		const accountId = params.credential.accountId;
		const limits: UsageLimit[] = [];
		const models: string[] = [];
		const unavailableModels: string[] = [];
		for (const entry of payload.model_remains) {
			const bucket = parseBucket(entry);
			if (!bucket) continue;
			models.push(bucket.modelName);
			if (isUnavailablePlan(bucket)) {
				unavailableModels.push(bucket.modelName);
				continue;
			}
			limits.push(...buildBucketLimits(params.provider, bucket, accountId));
		}
		if (limits.length === 0) return null;

		return {
			provider: params.provider,
			fetchedAt: Date.now(),
			limits,
			metadata: {
				source: "minimax-token-plan",
				models,
				...(unavailableModels.length > 0 ? { unavailableModels } : {}),
				...(accountId ? { accountId } : {}),
			},
			raw: payload,
		};
	} catch (error) {
		ctx.logger?.warn("MiniMax Token Plan usage request failed", {
			provider: params.provider,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

/** MiniMax Token Plan (international, `api.minimax.io`). */
export const minimaxCodeUsageProvider: UsageProvider = {
	id: INTL_PROVIDER,
	fetchUsage: fetchMiniMaxCodeUsage,
	supports: params =>
		params.provider === INTL_PROVIDER && params.credential.type === "api_key" && Boolean(params.credential.apiKey),
};
