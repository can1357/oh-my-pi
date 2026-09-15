import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import {
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	parseAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, parsePositiveTimestamp, WEEK_MS } from "./shared";

const PROVIDER = "alibaba-token-plan";
const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const ADDON_LIST_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/list";
/** Limit id for purchased add-on credits (Credit Pack / extra bundle). */
const ADDON_LIMIT_ID = "credits:addon";
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const INTERNATIONAL_CONSOLE = {
	origin: "https://home.qwencloud.com",
	dashboardUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
	sessionUrl: "https://home.qwencloud.com/tool/user/info.json",
	gatewayAction: "IntlBroadScopeAspnGateway",
	region: "ap-southeast-1",
	usageUrlBase:
		"https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=",
	cornerstoneParam: {
		domain: "home.qwencloud.com",
		consoleSite: "QWENCLOUD",
		console: "ONE_CONSOLE",
		xsp_lang: "en-US",
		protocol: "V2",
		productCode: "p_efm",
	},
} as const;
const CHINA_CONSOLE = {
	origin: "https://bailian.console.aliyun.com",
	dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	sessionUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	gatewayAction: "BroadScopeAspnGateway",
	region: "cn-beijing",
	usageUrlBase:
		"https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=",
	cornerstoneParam: {
		feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
		protocol: "V2",
		console: "ONE_CONSOLE",
		productCode: "p_efm",
		switchAgent: 12608464,
		switchUserType: 3,
		domain: "bailian.console.aliyun.com",
		consoleSite: "BAILIAN_ALIYUN",
		userNickName: "",
		userPrincipalName: "",
		xsp_lang: "zh-CN",
	},
} as const;

function extractCookieValue(header: string, name: string): string | undefined {
	for (const segment of header.split(";")) {
		const separator = segment.indexOf("=");
		if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
		const value = segment.slice(separator + 1).trim();
		return value || undefined;
	}
	return undefined;
}

function unwrapGatewayData(value: Record<string, unknown>): Record<string, unknown> {
	let current = value;
	if (typeof current.Data === "string") {
		try {
			const parsed: unknown = JSON.parse(current.Data);
			if (isRecord(parsed)) current = parsed;
		} catch {
			return current;
		}
	}
	if (isRecord(current.DataV2) && isRecord(current.DataV2.data)) current = current.DataV2.data;
	if (isRecord(current.data)) current = current.data;
	return current;
}

function parseUsedFraction(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || parsed < 0) return undefined;
	return Math.min(1, parsed > 1 ? parsed / 100 : parsed);
}

function usageStatus(usedFraction: number): UsageLimit["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

/** Mirrors the store's exhaustion test so a strategy can reason about its own limits. */
function limitExhausted(limit: UsageLimit): boolean {
	if (limit.status !== undefined && limit.status !== "unknown") return limit.status === "exhausted";
	const usedFraction = limit.amount.usedFraction;
	return usedFraction !== undefined && usedFraction >= 1;
}

function buildLimit(
	id: "5h" | "7d",
	label: string,
	durationMs: number,
	usedFraction: number | undefined,
	resetsAt: number | undefined,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (usedFraction === undefined) return undefined;
	return {
		id: `credits:${id}`,
		label,
		scope: { provider: PROVIDER, ...(accountId ? { accountId } : {}), windowId: id },
		window: { id, label, durationMs, ...(resetsAt ? { resetsAt } : {}) },
		amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
		status: usageStatus(usedFraction),
	};
}

/**
 * Purchased add-on credits (Credit Pack / extra bundle) are a separate pool
 * from the plan's 5-hour and weekly windows: the plan can read 100% while the
 * add-on still serves traffic. Reported as its own limit so the store can see
 * the headroom, and deliberately without `resetsAt` — an add-on expires rather
 * than resets, and letting its expiry drive a block deadline would sideline a
 * recovered account for weeks.
 */
function buildAddonLimit(
	remainingCredits: number,
	totalCredits: number,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (!(totalCredits > 0) || remainingCredits < 0) return undefined;
	const usedFraction = Math.min(1, Math.max(0, (totalCredits - remainingCredits) / totalCredits));
	return {
		id: ADDON_LIMIT_ID,
		label: "Credit Pack",
		scope: { provider: PROVIDER, ...(accountId ? { accountId } : {}), windowId: "addon" },
		window: { id: "addon", label: "Credit Pack", durationMs: WEEK_MS },
		amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
		status: usageStatus(usedFraction),
	};
}

/** Sum the active add-on bundles into one pool; a missing list means "no add-on". */
function buildAddonLimitFromList(data: Record<string, unknown>, accountId: string | undefined): UsageLimit | undefined {
	const items = data.items;
	if (!Array.isArray(items)) return undefined;
	let remaining = 0;
	let total = 0;
	for (const item of items) {
		if (!isRecord(item) || item.status !== "ACTIVE") continue;
		const itemRemaining = toNumber(item.remainingCredits);
		const itemTotal = toNumber(item.totalCredits);
		if (itemRemaining === undefined || itemTotal === undefined) continue;
		remaining += itemRemaining;
		total += itemTotal;
	}
	return buildAddonLimit(remaining, total, accountId);
}

function accountIdFromUserData(value: Record<string, unknown>): string | undefined {
	for (const key of ["accountId", "userId", "aliyunId", "loginId"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
	}
	return undefined;
}

async function fetchAlibabaTokenPlanUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER || params.credential.type !== "api_key" || !params.credential.apiKey) return null;
	const credential = parseAlibabaTokenPlanCredential(params.credential.apiKey);
	if (!credential?.cookie) return null;
	const cookie = credential.cookie;
	const isChina = credential.baseUrl === ALIBABA_TOKEN_PLAN_CN_BASE_URL;
	const consoleConfig = isChina ? CHINA_CONSOLE : INTERNATIONAL_CONSOLE;

	try {
		const sessionResponse = await ctx.fetch(consoleConfig.sessionUrl, {
			headers: {
				Accept: isChina
					? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
					: "application/json, text/plain, */*",
				Cookie: cookie,
				Referer: `${consoleConfig.origin}/`,
				"User-Agent": BROWSER_USER_AGENT,
			},
			redirect: "manual",
			signal: params.signal,
		});
		if (!sessionResponse.ok) {
			ctx.logger?.warn("Alibaba Token Plan session lookup failed", {
				provider: PROVIDER,
				status: sessionResponse.status,
			});
			return null;
		}

		let secToken: string | undefined;
		let accountId: string | undefined;
		if (isChina) {
			const html = await sessionResponse.text();
			secToken = /\bSEC_TOKEN\s*:\s*"([^"]+)"/.exec(html)?.[1];
			if (!secToken) {
				ctx.logger?.warn("Alibaba Token Plan China session response invalid", { provider: PROVIDER });
				return null;
			}
		} else {
			const userPayload: unknown = await sessionResponse.json();
			if (!isRecord(userPayload) || !isRecord(userPayload.data) || typeof userPayload.data.secToken !== "string") {
				ctx.logger?.warn("QwenCloud session response invalid", { provider: PROVIDER });
				return null;
			}
			secToken = userPayload.data.secToken;
			accountId = accountIdFromUserData(userPayload.data);
		}

		const csrf = extractCookieValue(cookie, "login_aliyunid_csrf") ?? extractCookieValue(cookie, "csrf");
		const headers: Record<string, string> = {
			Accept: "application/json, text/plain, */*",
			"Content-Type": "application/x-www-form-urlencoded",
			Cookie: cookie,
			Origin: consoleConfig.origin,
			Referer: consoleConfig.dashboardUrl,
			"User-Agent": BROWSER_USER_AGENT,
			"X-Requested-With": "XMLHttpRequest",
		};
		if (csrf) {
			headers["x-xsrf-token"] = csrf;
			headers["x-csrf-token"] = csrf;
		}
		const callConsoleApi = async (api: string): Promise<Record<string, unknown> | null> => {
			const body = new URLSearchParams({
				product: "sfm_bailian",
				action: consoleConfig.gatewayAction,
				region: consoleConfig.region,
				sec_token: secToken,
				params: JSON.stringify({
					Api: api,
					Data: {
						cornerstoneParam: {
							...(isChina ? { feTraceId: crypto.randomUUID() } : {}),
							...consoleConfig.cornerstoneParam,
						},
					},
					V: "1.0",
				}),
			});
			const response = await ctx.fetch(`${consoleConfig.usageUrlBase}${encodeURIComponent(api)}`, {
				method: "POST",
				headers,
				body,
				redirect: "manual",
				signal: params.signal,
			});
			if (!response.ok) {
				ctx.logger?.warn("Alibaba Token Plan console call failed", {
					provider: PROVIDER,
					api,
					status: response.status,
				});
				return null;
			}
			const payload: unknown = await response.json();
			if (!isRecord(payload) || payload.successResponse === false || !isRecord(payload.data)) {
				ctx.logger?.warn("Alibaba Token Plan console response invalid", { provider: PROVIDER, api });
				return null;
			}
			return unwrapGatewayData(payload.data);
		};

		const responseData = await callConsoleApi(USAGE_API);
		if (!responseData) return null;
		const limits = [
			buildLimit(
				"5h",
				"5 Hour Credits",
				5 * HOUR_MS,
				parseUsedFraction(responseData.per5HourPercentage),
				parsePositiveTimestamp(responseData.per5HourResetTime),
				accountId,
			),
			buildLimit(
				"7d",
				"7 Day Credits",
				WEEK_MS,
				parseUsedFraction(responseData.per1WeekPercentage),
				parsePositiveTimestamp(responseData.per1WeekResetTime),
				accountId,
			),
		].filter((limit): limit is UsageLimit => limit !== undefined);
		if (limits.length === 0) return null;

		// Add-on credits live in their own pool and are reported separately. A
		// failure here must not cost the plan windows, so it degrades to "no
		// add-on reported" and the plan windows keep gating the credential.
		const addonData = await callConsoleApi(ADDON_LIST_API);
		const addonLimit = addonData ? buildAddonLimitFromList(addonData, accountId) : undefined;
		if (addonLimit) limits.push(addonLimit);

		return {
			provider: PROVIDER,
			fetchedAt: Date.now(),
			limits,
			metadata: { source: isChina ? "bailian-console" : "qwencloud-console", ...(accountId ? { accountId } : {}) },
		};
	} catch (error) {
		ctx.logger?.warn("Alibaba Token Plan usage request failed", {
			provider: PROVIDER,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

export const alibabaTokenPlanUsageProvider: UsageProvider = {
	id: PROVIDER,
	retainLastGoodOnFailure: false,
	fetchUsage: fetchAlibabaTokenPlanUsage,
	supports: params =>
		params.provider === PROVIDER &&
		params.credential.type === "api_key" &&
		Boolean(params.credential.apiKey && parseAlibabaTokenPlanCredential(params.credential.apiKey)?.cookie),
};

/**
 * Limits that gate a hard block for this provider.
 *
 * Add-on credits are a shared overflow pool: while any remain, an exhausted
 * plan window does not make the credential unusable, so the plan windows must
 * not gate a hard block. The add-on limit itself never gates one — it expires
 * rather than resets, so its deadline would sideline a recovered account for
 * weeks — hence it is dropped once it is spent and the plan windows take over
 * again.
 */
function tokenPlanGatingLimits(report: UsageReport): UsageLimit[] {
	const addon = report.limits.find(limit => limit.id === ADDON_LIMIT_ID);
	if (addon && !limitExhausted(addon)) return [addon];
	return report.limits.filter(limit => limit.id !== ADDON_LIMIT_ID);
}

export const alibabaTokenPlanRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.id === "credits:5h"),
		secondary: report.limits.find(limit => limit.id === "credits:7d"),
	}),
	scopeLimits: tokenPlanGatingLimits,
	/**
	 * A live report can lift a stale block. The add-on list is a second console
	 * call, so a transient failure there can block a funded account; without
	 * healing, an API-key block is never re-probed and would stand until the
	 * plan reset. Judging the block against the same gating limits selection
	 * uses lets the next healthy report clear it.
	 */
	healableBlockScopes: report => [{ blockScope: "", limits: tokenPlanGatingLimits(report) }],
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
