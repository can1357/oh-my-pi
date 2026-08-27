import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, WEEK_MS } from "./shared";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MONTH_MS = 30 * DAY_MS;

interface GlmCodingPlanUsageDetail {
	modelCode?: string;
	usage?: number;
}

interface GlmCodingPlanUsageLimitItem {
	type?: string;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	remaining?: number;
	nextResetTime?: number;
	unit?: number;
	number?: number;
	usageDetails?: GlmCodingPlanUsageDetail[];
}

interface GlmCodingPlanQuotaPayload {
	success?: boolean;
	code?: number;
	msg?: string;
	data?: {
		limits?: GlmCodingPlanUsageLimitItem[];
		/** Plan tier name (e.g. "lite", "pro"). */
		level?: string;
	};
}

/**
 * Host-specific configuration for the GLM Coding Plan quota API. The
 * international (Z.AI, `api.z.ai`) and domestic (Zhipu BigModel,
 * `open.bigmodel.cn`) coding plans serve the same `/api/monitor/usage/*`
 * wire format with the same `id.secret` auth; only host, provider id, and
 * branding differ.
 */
export interface GlmCodingPlanUsageProviderConfig {
	/** Provider id the report is attributed to (`"zai"` | `"zhipu-coding-plan"`). */
	provider: string;
	/** Host origin used when `params.baseUrl` is absent. */
	defaultEndpoint: string;
	/** Limit-id prefix, e.g. `"zai"` → `zai:requests:5h`. */
	brandKey: string;
	/** Display label prefix, e.g. `"ZAI"` → "ZAI Request Quota". */
	brandLabel: string;
}

function normalizeBaseUrl(baseUrl: string | undefined, defaultEndpoint: string): string {
	if (!baseUrl?.trim()) return defaultEndpoint;
	try {
		return new URL(baseUrl.trim()).origin;
	} catch {
		return defaultEndpoint;
	}
}

function parseMillis(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined) return undefined;
	return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function parseUsageDetails(value: unknown): GlmCodingPlanUsageDetail[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const details: GlmCodingPlanUsageDetail[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const modelCode = typeof item.modelCode === "string" && item.modelCode ? item.modelCode : undefined;
		const usage = toNumber(item.usage);
		details.push({
			...(modelCode !== undefined ? { modelCode } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}
	return details.length > 0 ? details : undefined;
}

function parseLimitItem(value: unknown): GlmCodingPlanUsageLimitItem | null {
	if (!isRecord(value)) return null;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (!type) return null;
	return {
		type,
		usage: toNumber(value.usage),
		currentValue: toNumber(value.currentValue),
		percentage: toNumber(value.percentage),
		remaining: toNumber(value.remaining),
		nextResetTime: parseMillis(value.nextResetTime),
		unit: toNumber(value.unit),
		number: toNumber(value.number),
		usageDetails: parseUsageDetails(value.usageDetails),
	};
}

function buildUsageAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	unit: UsageAmount["unit"];
	percentage?: number;
}): UsageAmount {
	const usedFraction =
		args.percentage !== undefined
			? Math.min(Math.max(args.percentage / 100, 0), 1)
			: args.used !== undefined && args.limit !== undefined && args.limit > 0
				? Math.min(args.used / args.limit, 1)
				: undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		used: args.used,
		limit: args.limit,
		remaining: args.remaining,
		usedFraction,
		remainingFraction,
		unit: args.unit,
	};
}

function getUsageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function formatDate(value: Date): string {
	const pad = (input: number) => String(input).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}+${pad(value.getHours())}:${pad(
		value.getMinutes(),
	)}:${pad(value.getSeconds())}`;
}

function formatCountedUnit(count: number, singular: string): string {
	const suffix = count === 1 ? "" : "s";
	return `${count} ${singular}${suffix}`;
}

function buildWindow(parsed: GlmCodingPlanUsageLimitItem): UsageWindow {
	const count = parsed.number !== undefined && parsed.number > 0 ? parsed.number : 1;
	let id: string;
	let label: string;
	let durationMs: number | undefined;
	switch (parsed.unit) {
		case 3:
			id = `${count}h`;
			label = formatCountedUnit(count, "Hour");
			durationMs = count * HOUR_MS;
			break;
		case 4:
			id = `${count}d`;
			label = formatCountedUnit(count, "Day");
			durationMs = count * DAY_MS;
			break;
		case 5:
			id = `${count}mo`;
			label = count === 1 ? "Monthly" : formatCountedUnit(count, "Month");
			durationMs = count * MONTH_MS;
			break;
		case 6:
			id = "1w";
			label = "Weekly";
			durationMs = WEEK_MS;
			break;
		default:
			id = parsed.unit !== undefined ? `${count}u${parsed.unit}` : "quota";
			label = "Quota";
			break;
	}
	return {
		id,
		label,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(parsed.nextResetTime !== undefined ? { resetsAt: parsed.nextResetTime } : {}),
	};
}

function isFeatureRequestLimit(parsed: GlmCodingPlanUsageLimitItem): boolean {
	const detailCodes =
		parsed.usageDetails?.map(detail => detail.modelCode).filter((code): code is string => !!code) ?? [];
	return detailCodes.includes("search-prime") && detailCodes.includes("web-reader") && detailCodes.includes("zread");
}

function requestQuotaLabel(parsed: GlmCodingPlanUsageLimitItem, brandLabel: string): string {
	if (isFeatureRequestLimit(parsed)) return `${brandLabel} Zread Quota`;
	return `${brandLabel} Request Quota`;
}

function buildModelUsageUrl(baseUrl: string, now: Date): string {
	const start = new Date(now.getTime() - WEEK_MS);
	const startTime = formatDate(start);
	const endTime = formatDate(now);
	return `${baseUrl}${MODEL_USAGE_PATH}?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
}

function buildQuotaLimits(payload: GlmCodingPlanQuotaPayload, config: GlmCodingPlanUsageProviderConfig): UsageLimit[] {
	const limitsPayload = Array.isArray(payload.data?.limits) ? payload.data?.limits : [];
	const limits: UsageLimit[] = [];

	for (const rawLimit of limitsPayload) {
		const parsed = parseLimitItem(rawLimit);
		if (!parsed) continue;
		if (parsed.type === "TOKENS_LIMIT") {
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				percentage: parsed.percentage,
				unit: "tokens",
			});
			const window = buildWindow(parsed);
			limits.push({
				id: `${config.brandKey}:tokens:${window.id}`,
				label: `${config.brandLabel} ${window.label} Token Quota`,
				scope: {
					provider: config.provider,
					windowId: window.id,
					shared: true,
				},
				window,
				amount,
				status: getUsageStatus(amount.usedFraction),
			});
		}
		if (parsed.type === "CREDIT_LIMIT") {
			// Domestic (open.bigmodel.cn) coding plans report credit-pool windows
			// instead of token/request buckets — same unit/number window shape,
			// but `usage`/`currentValue`/`remaining` count plan credits.
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				percentage: parsed.percentage,
				unit: "unknown",
			});
			const window = buildWindow(parsed);
			limits.push({
				id: `${config.brandKey}:credits:${window.id}`,
				label: `${config.brandLabel} ${window.label} Credit Quota`,
				scope: {
					provider: config.provider,
					windowId: window.id,
					shared: true,
				},
				window,
				amount,
				status: getUsageStatus(amount.usedFraction),
			});
		}
		if (parsed.type === "TIME_LIMIT") {
			const window = buildWindow(parsed);
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				percentage: parsed.percentage,
				unit: "requests",
			});
			const featureLimit = isFeatureRequestLimit(parsed);
			limits.push({
				id: featureLimit
					? `${config.brandKey}:features:zread:${window.id}`
					: `${config.brandKey}:requests:${window.id}`,
				label: requestQuotaLabel(parsed, config.brandLabel),
				scope: {
					provider: config.provider,
					windowId: window.id,
					shared: !featureLimit,
					...(featureLimit ? { tier: "zread" } : {}),
				},
				window,
				amount,
				status: getUsageStatus(amount.usedFraction),
			});
		}
	}
	return limits;
}

function credentialLimitsFor(brandKey: string): (report: UsageReport) => UsageLimit[] {
	return (report: UsageReport): UsageLimit[] => {
		const limits = report.limits.filter(
			limit =>
				limit.id.startsWith(`${brandKey}:requests:`) ||
				limit.id.startsWith(`${brandKey}:tokens:`) ||
				limit.id.startsWith(`${brandKey}:credits:`),
		);
		return limits;
	};
}

function rankRequestLimits(report: UsageReport, brandKey: string): UsageLimit[] {
	const requestLimits = report.limits.filter(limit => limit.id.startsWith(`${brandKey}:requests:`));
	const credentialLimits = credentialLimitsFor(brandKey)(report);
	const limits = requestLimits.length > 0 ? requestLimits : credentialLimits;
	const ranked = [...limits];
	ranked.sort((left, right) => {
		const leftDuration = left.window?.durationMs ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.window?.durationMs ?? Number.POSITIVE_INFINITY;
		if (leftDuration !== rightDuration) return leftDuration - rightDuration;
		const leftReset = left.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		return leftReset - rightReset;
	});
	return ranked;
}

async function fetchGlmCodingPlanUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
	config: GlmCodingPlanUsageProviderConfig,
): Promise<UsageReport | null> {
	if (params.provider !== config.provider) return null;
	const credential = params.credential;
	// Sign-in (oauth) stores the minted id.secret key in accessToken; the paste
	// path stores it in apiKey. Both are the same raw key used verbatim as the
	// Authorization header (no Bearer prefix).
	const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
	if (!token) return null;

	const baseUrl = normalizeBaseUrl(params.baseUrl, config.defaultEndpoint);
	const url = `${baseUrl}${QUOTA_PATH}`;
	const headers: Record<string, string> = {
		Authorization: token,
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
	};

	let payload: GlmCodingPlanQuotaPayload | null = null;
	try {
		const response = await ctx.fetch(url, {
			headers,
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn(`${config.brandLabel} usage fetch failed`, {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = (await response.json()) as GlmCodingPlanQuotaPayload;
	} catch (error) {
		ctx.logger?.warn(`${config.brandLabel} usage fetch error`, { error: String(error) });
		return null;
	}

	if (!payload) return null;
	if (payload.success !== true) {
		ctx.logger?.warn(`${config.brandLabel} usage response invalid`, { code: payload.code, message: payload.msg });
		return null;
	}

	const limits = buildQuotaLimits(payload, config);
	if (limits.length === 0) return null;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: url,
			accountId: credential.accountId,
			email: credential.email,
			...(typeof payload.data?.level === "string" && payload.data.level ? { planType: payload.data.level } : {}),
		},
		raw: payload,
	};

	const modelUsageUrl = buildModelUsageUrl(baseUrl, new Date());
	try {
		const response = await ctx.fetch(modelUsageUrl, {
			headers,
			signal: params.signal,
		});
		if (response.ok) {
			const modelUsagePayload = (await response.json()) as unknown;
			if (isRecord(modelUsagePayload)) {
				report.metadata = {
					...report.metadata,
					modelUsage: modelUsagePayload,
				};
			}
		}
	} catch (error) {
		ctx.logger?.debug(`${config.brandLabel} model usage fetch failed`, { error: String(error) });
	}

	return report;
}

/**
 * Build the usage provider + ranking strategy for one GLM Coding Plan host.
 * Used by `zai` (international) and `zhipu-coding-plan` (domestic) — see
 * {@link GlmCodingPlanUsageProviderConfig}.
 */
export function createGlmCodingPlanUsageProvider(config: GlmCodingPlanUsageProviderConfig): {
	usageProvider: UsageProvider;
	rankingStrategy: CredentialRankingStrategy;
} {
	return {
		usageProvider: {
			id: config.provider,
			fetchUsage: (params, ctx) => fetchGlmCodingPlanUsage(params, ctx, config),
			supports: params =>
				params.provider === config.provider &&
				(params.credential.type === "oauth"
					? Boolean(params.credential.accessToken)
					: Boolean(params.credential.apiKey)),
		},
		rankingStrategy: {
			findWindowLimits(report) {
				const ranked = rankRequestLimits(report, config.brandKey);
				return { primary: ranked[0], secondary: ranked[1] };
			},
			scopeLimits(report) {
				return credentialLimitsFor(config.brandKey)(report);
			},
			windowDefaults: {
				primaryMs: 5 * HOUR_MS,
				secondaryMs: WEEK_MS,
			},
		},
	};
}

const zai = createGlmCodingPlanUsageProvider({
	provider: "zai",
	defaultEndpoint: "https://api.z.ai",
	brandKey: "zai",
	brandLabel: "ZAI",
});

export const zaiUsageProvider = zai.usageProvider;
export const zaiRankingStrategy = zai.rankingStrategy;
