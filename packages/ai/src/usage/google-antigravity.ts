import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import * as AIError from "../error";
import type {
	CredentialRankingContext,
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
import { DAY_MS, parseIsoTimestamp, WEEK_MS } from "./shared";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	dailyQuotaInfos?: AntigravityQuotaInfo[];
	weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	weeklyQuotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

interface AntigravityWindowDescriptor {
	id: string;
	label: string;
	durationMs?: number;
}

function classifyWindow(id: string | undefined, label: string | undefined): AntigravityWindowDescriptor | undefined {
	const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
	if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
		return { id: "daily", label: "Daily", durationMs: DAY_MS };
	}
	if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
	return undefined;
}

function inferWindowFromReset(resetAt: number | undefined, nowMs: number): AntigravityWindowDescriptor {
	if (resetAt !== undefined && resetAt - nowMs > DAY_MS) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	return { id: "daily", label: "Daily", durationMs: DAY_MS };
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
	return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
	quotaInfos: AntigravityQuotaInfo[],
	nowMs: number,
): WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor> {
	const descriptors = new WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor>();
	const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

	for (const info of quotaInfos) {
		const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
		if (explicitDescriptor) {
			descriptors.set(info, explicitDescriptor);
			continue;
		}
		const group = groups.get(quotaInferenceKey(info)) ?? [];
		group.push({ info, resetAt: parseIsoTimestamp(info.resetTime) });
		groups.set(quotaInferenceKey(info), group);
	}

	for (const group of groups.values()) {
		const resetTimes = [...new Set(group.map(entry => entry.resetAt).filter(resetAt => resetAt !== undefined))].sort(
			(a, b) => a - b,
		);
		const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
		for (const entry of group) {
			const descriptor =
				latestReset !== undefined && entry.resetAt === latestReset
					? { id: "weekly", label: "Weekly", durationMs: WEEK_MS }
					: inferWindowFromReset(entry.resetAt, nowMs);
			descriptors.set(entry.info, descriptor);
		}
	}

	return descriptors;
}

function withWindowDescriptor(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): AntigravityQuotaInfo {
	if (!descriptor) return info;
	return {
		...info,
		windowId: info.windowId ?? descriptor.id,
		windowLabel: info.windowLabel ?? descriptor.label,
	};
}

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): UsageWindow | undefined {
	const resetAt = parseIsoTimestamp(info.resetTime);
	const hasResetAt = resetAt !== undefined;
	if (!descriptor && !hasResetAt) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
		...(hasResetAt ? { resetsAt: resetAt } : {}),
	};
}

function buildAmount(info: AntigravityQuotaInfo): UsageAmount {
	const apiRemainingFraction = clampFraction(info.remainingFraction);
	// Observed Antigravity responses omit remainingFraction for exhausted
	// Google/Gemini counters and keep only resetTime. Treat that shape as
	// "blocked until reset" rather than unknown so a healthy sibling backend
	// counter cannot mask it during dedupe.
	const remainingFraction = apiRemainingFraction ?? (info.resetTime ? 0 : undefined);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
	switch (info.modelProvider ?? info.apiProvider) {
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
			return "Anthropic";
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return "Google";
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return "OpenAI";
		default:
			return undefined;
	}
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: AntigravityWindowDescriptor) => {
		results.push({ ...source, ...withWindowDescriptor(value, windowDescriptor), ...(tier ? { tier } : {}) });
	};
	const addValue = (
		value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined,
		tier?: string,
		windowDescriptor?: AntigravityWindowDescriptor,
	) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const entry of value) addInfo(entry, tier, windowDescriptor);
			return;
		}
		addInfo(value, tier, windowDescriptor);
	};

	addValue(info.quotaInfo);
	addValue(info.quotaInfos);
	addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
	addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
	addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
	addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			addValue(value, tier);
		}
	}

	const addWindowMap = (values?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>) => {
		if (!values) return;
		for (const [windowId, value] of Object.entries(values)) {
			addValue(value, undefined, classifyWindow(windowId, undefined));
		}
	};
	addWindowMap(info.quotaInfoByWindow);
	addWindowMap(info.quotaInfosByWindow);

	return results;
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl?.replace(/\/+$/, "");
	const endpoints = baseUrl ? [baseUrl] : [DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.sandbox.googleapis.com"];

	let response: Response | undefined;
	let successfulEndpoint = DEFAULT_ENDPOINT;
	for (const endpoint of endpoints) {
		try {
			const url = `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`;
			response = await ctx.fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": getAntigravityUserAgent(),
				},
				body: JSON.stringify({ project: credential.projectId }),
				signal: params.signal,
			});

			if (response.ok) {
				successfulEndpoint = endpoint;
				break;
			}

			if (AIError.isTransientStatus(response.status)) {
				continue;
			}
			break;
		} catch (error) {
			if (endpoint === endpoints[endpoints.length - 1]) {
				throw error;
			}
		}
	}

	if (!response?.ok) {
		ctx.logger?.warn("Antigravity usage fetch failed", {
			status: response?.status ?? 0,
			statusText: response?.statusText ?? "unknown",
		});
		return null;
	}
	const data = (await response.json()) as AntigravityUsageResponse;

	// The API returns per-model quota entries, but quota is shared across
	// models within the same backend counter, tier, and reset window. Keep
	// Google and Anthropic-backed Antigravity models separate so a healthy
	// Claude counter cannot mask an exhausted Gemini counter.
	const deduped = new Map<
		string,
		{
			amount: UsageAmount;
			window: UsageWindow | undefined;
			tier: string | undefined;
			tierKey: string;
			windowId: string;
			counterName: string | undefined;
			counterKey: string;
		}
	>();
	let earliestReset: number | undefined;

	for (const [_modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
		for (const quotaInfo of quotaInfos) {
			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
			if (window?.resetsAt) {
				earliestReset = earliestReset ? Math.min(earliestReset, window.resetsAt) : window.resetsAt;
			}
			const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
			const counterName = formatCounterName(quotaInfo);
			const counterKey = counterName?.toLowerCase() ?? "default";
			// Use the parsed window id when available so provider enum names like
			// WINDOW_WEEKLY normalize into the same visible `/usage` group as
			// weeklyQuotaInfo entries.
			const windowId = window?.id ?? quotaInfo.windowId ?? "default";
			const key = `${counterKey}|${tierKey}|${windowId}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, { amount, window, tier: quotaInfo.tier, tierKey, windowId, counterName, counterKey });
				continue;
			}
			// Merge: keep the entry with fraction data for the bar, but
			// also keep any window with a reset time so "resets in…" survives.
			const eFrac = existing.amount.remainingFraction;
			const cFrac = amount.remainingFraction;
			const eHasFrac = eFrac !== undefined;
			const cHasFrac = cFrac !== undefined;

			let bestAmount = existing.amount;
			let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
			let bestTier = existing.tier ?? quotaInfo.tier;

			if (!eHasFrac && cHasFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			}
			// Always merge in window with reset time if the current
			// best doesn't have one.
			if (!bestWindow?.resetsAt && window?.resetsAt) {
				bestWindow = window;
			}
			deduped.set(key, {
				amount: bestAmount,
				window: bestWindow,
				tier: bestTier,
				tierKey: existing.tierKey,
				windowId: existing.windowId,
				counterName: existing.counterName,
				counterKey: existing.counterKey,
			});
		}
	}

	const limits: UsageLimit[] = [];
	for (const entry of deduped.values()) {
		const label = entry.counterName ? `Usage (${entry.counterName})` : "Usage";
		limits.push({
			id: `${params.provider}:${entry.counterKey}:${entry.tierKey}:${entry.windowId}`,
			label,
			scope: {
				provider: params.provider,
				accountId: credential.accountId,
				projectId: credential.projectId,
				tier: entry.tier,
				windowId: entry.windowId,
			},
			window: entry.window,
			amount: entry.amount,
			status: getUsageStatus(entry.amount.remainingFraction),
		});
	}

	limits.sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});

	const metadata: UsageReport["metadata"] = {
		endpoint: successfulEndpoint,
		projectId: credential.projectId,
	};
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata,
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};

/** Map an Antigravity model id to its backend quota-counter key. */
export function getAntigravityCounterKeyForModel(modelId: string | undefined): string | undefined {
	return modelId ? quotaTierFor("google-antigravity", modelId) : undefined;
}

function getAntigravityCounterLimits(report: UsageReport, counterKey: string): UsageLimit[] {
	const prefix = `${report.provider}:${counterKey}:`;
	return report.limits.filter(limit => limit.id.toLowerCase().startsWith(prefix));
}

/**
 * Scope an Antigravity report to the active model's backend counter, falling
 * back to legacy default counters only when that backend has no limits.
 *
 * Exhaustion checks are only safe with a concrete backend counter. A no-model
 * credential lookup (for example image-provider discovery) must not turn one
 * exhausted family into a provider-wide block.
 */
export function scopeAntigravityLimitsForModel(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
	if (!counterKey) return [];
	const backendLimits = getAntigravityCounterLimits(report, counterKey);
	if (backendLimits.length > 0) return backendLimits;
	return getAntigravityCounterLimits(report, "default");
}

function rankAntigravityLimits(report: UsageReport, context: CredentialRankingContext | undefined): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
	if (!counterKey) return report.limits;
	return scopeAntigravityLimitsForModel(report, context);
}

/**
 * Antigravity quotas are returned per backend counter (Anthropic / Google /
 * OpenAI) and can include both daily and weekly windows. `fetchAntigravityUsage`
 * sorts `limits` ascending by `remainingFraction`; after model-family scoping,
 * the most-pressured relevant counter/window is index 0.
 *
 * Leave `secondary` unset: AuthStorage compares secondary metrics before
 * primary metrics, which is correct for providers with a fixed short/long
 * split but wrong here. Ranking Antigravity by the bottleneck counter first
 * avoids preferring an account at 95% Gemini daily / 0% Claude weekly over one
 * with healthier Gemini headroom.
 */
export const antigravityRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		return { primary: rankAntigravityLimits(report, context)[0] };
	},
	scopeLimits: scopeAntigravityLimitsForModel,
	// Always return a scope for Antigravity so missing/unknown model context
	// cannot fall through to AuthStorage's provider-wide block bucket.
	blockScope(context) {
		const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
		return `counter:${counterKey ?? "unknown"}`;
	},
	// Antigravity windows carry `durationMs` when the response identifies them
	// as daily/weekly. Fall back to daily for legacy unlabelled quotaInfo
	// entries from `daily-cloudcode-pa.googleapis.com`.
	windowDefaults: { primaryMs: DAY_MS, secondaryMs: DAY_MS },
};
