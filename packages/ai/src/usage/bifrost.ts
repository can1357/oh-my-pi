import { getDefaultModelDiscoveryBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error";
import type { Provider } from "../types";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageScope,
	UsageUnit,
	UsageWindow,
} from "../usage";
import { buildUsageAmount, DAY_MS, HOUR_MS, parseIsoTimestamp, usageStatus } from "./shared";

/** Self-service quota of the calling virtual key; the key itself is the credential. */
const QUOTA_PATH = "/api/governance/virtual-keys/quota";

/** Bifrost reset durations: `30s`, `5m`, `1h`, `1d`, `1w`, `1M`, `1Q`, `1Y`. */
const DURATION = /^(\d+)(s|m|h|d|w|M|Q|Y)$/;
const FIXED_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS };
const CALENDAR_UNIT_MONTHS: Record<string, number> = { M: 1, Q: 3, Y: 12 };

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The window a budget or rate-limit dimension resets on, anchored at its last reset. */
function resetWindow(duration: unknown, lastReset: unknown): UsageWindow | undefined {
	if (typeof duration !== "string") return undefined;
	const match = DURATION.exec(duration);
	if (!match) return undefined;
	const count = Number(match[1]);
	const unit = match[2];
	const anchor = parseIsoTimestamp(lastReset);
	const fixedMs = FIXED_UNIT_MS[unit];
	let resetsAt: number | undefined;
	if (anchor !== undefined) {
		if (fixedMs !== undefined) {
			resetsAt = anchor + count * fixedMs;
		} else {
			const next = new Date(anchor);
			next.setUTCMonth(next.getUTCMonth() + count * CALENDAR_UNIT_MONTHS[unit]);
			resetsAt = next.getTime();
		}
	}
	return {
		id: duration,
		label: duration,
		...(fixedMs !== undefined ? { durationMs: count * fixedMs } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function capLimit(
	id: string,
	label: string,
	scope: UsageScope,
	unit: UsageUnit,
	used: number | undefined,
	cap: number | undefined,
	window: UsageWindow | undefined,
): UsageLimit | null {
	if (used === undefined || cap === undefined) return null;
	const amount = buildUsageAmount({
		unit,
		used,
		limit: cap,
		remaining: Math.max(0, cap - used),
		// A zero cap blocks every request.
		usedFraction: cap <= 0 ? 1 : undefined,
	});
	return {
		id,
		label,
		scope: window ? { ...scope, windowId: window.id } : scope,
		...(window ? { window } : {}),
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

/** One USD budget row; an active override adds its amount on top of `max_limit`. */
function budgetLimits(idPrefix: string, label: string, scope: UsageScope, budgets: unknown): UsageLimit[] {
	if (!Array.isArray(budgets)) return [];
	const limits: UsageLimit[] = [];
	for (const budget of budgets) {
		if (!isRecord(budget)) continue;
		const max = finite(budget.max_limit);
		const override = finite(budget.override_amount) ?? 0;
		const limit = capLimit(
			`${idPrefix}:budget:${typeof budget.id === "string" ? budget.id : limits.length}`,
			`${label} budget`,
			scope,
			"usd",
			finite(budget.current_usage),
			max === undefined ? undefined : max + override,
			resetWindow(budget.reset_duration, budget.last_reset),
		);
		if (limit) limits.push(limit);
	}
	return limits;
}

/** Token and request dimensions of one rate limit; a null maximum is unlimited. */
function rateLimits(idPrefix: string, label: string, scope: UsageScope, rateLimit: unknown): UsageLimit[] {
	if (!isRecord(rateLimit)) return [];
	return [
		capLimit(
			`${idPrefix}:tokens`,
			`${label} tokens`,
			scope,
			"tokens",
			finite(rateLimit.token_current_usage),
			finite(rateLimit.token_max_limit),
			resetWindow(rateLimit.token_reset_duration, rateLimit.token_last_reset),
		),
		capLimit(
			`${idPrefix}:requests`,
			`${label} requests`,
			scope,
			"requests",
			finite(rateLimit.request_current_usage),
			finite(rateLimit.request_max_limit),
			resetWindow(rateLimit.request_reset_duration, rateLimit.request_last_reset),
		),
	].filter((limit): limit is UsageLimit => !!limit);
}

/**
 * Key-wide limits are `shared`; a provider config's limits carry its Bifrost
 * provider as `scope.tier`; a model config's carry `scope.modelId` (prefixed
 * with its provider when it names one).
 */
function quotaLimits(provider: Provider, body: Record<string, unknown>): UsageLimit[] {
	const keyScope: UsageScope = { provider, shared: true };
	const limits: UsageLimit[] = [
		...budgetLimits(`${provider}:key`, "Key", keyScope, body.budgets),
		// `rate_limit` is the effective merge of `rate_limits`; reading both double-counts.
		...rateLimits(`${provider}:key:rate`, "Key", keyScope, body.rate_limit),
	];
	if (body.is_active === false) {
		limits.push({
			id: `${provider}:key:active`,
			label: "Virtual key inactive",
			scope: keyScope,
			amount: { unit: "unknown" },
			status: "exhausted",
		});
	}
	const modelLimits = (route: string | undefined, model: Record<string, unknown>): UsageLimit[] => {
		if (typeof model.model_name !== "string" || !model.model_name) return [];
		const modelId = route ? `${route}/${model.model_name}` : model.model_name;
		const scope: UsageScope = { provider, modelId, ...(route ? { tier: route } : {}) };
		return [
			...budgetLimits(`${provider}:model:${modelId}`, modelId, scope, model.budgets),
			...rateLimits(`${provider}:model:${modelId}:rate`, modelId, scope, model.rate_limit),
		];
	};
	for (const config of Array.isArray(body.provider_configs) ? body.provider_configs : []) {
		if (!isRecord(config) || typeof config.provider !== "string" || !config.provider) continue;
		const route = config.provider;
		const scope: UsageScope = { provider, tier: route };
		limits.push(
			...budgetLimits(`${provider}:provider:${route}`, route, scope, config.budgets),
			...rateLimits(`${provider}:provider:${route}:rate`, route, scope, config.rate_limit),
		);
		for (const model of Array.isArray(config.model_budgets) ? config.model_budgets : []) {
			if (isRecord(model)) limits.push(...modelLimits(route, model));
		}
	}
	for (const model of Array.isArray(body.model_configs) ? body.model_configs : []) {
		if (!isRecord(model)) continue;
		limits.push(
			...modelLimits(typeof model.provider === "string" && model.provider ? model.provider : undefined, model),
		);
	}
	return limits;
}

/** The gateway root a configured inference base URL (`…/v1`) serves management routes under. */
function gatewayRoot(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
		return `${url.origin}${path}`;
	} catch {
		return undefined;
	}
}

async function getQuota(
	root: string,
	apiKey: string,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<Response | undefined> {
	try {
		return await ctx.fetch(`${root}${QUOTA_PATH}`, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			redirect: "error",
			signal: params.signal,
		});
	} catch {
		ctx.logger?.debug("Bifrost quota request failed", { root });
		return undefined;
	}
}

/**
 * Reads the calling virtual key's budgets and rate limits. A base URL behind
 * an integration route (`…/openai`) retries the origin when its own root
 * has no quota route. A 401 or 403 (expired key) rejects so the cached report
 * is discarded; a key with no configured limits reports nothing.
 */
async function fetchBifrostUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const apiKey = params.credential.type === "api_key" ? params.credential.apiKey?.trim() : undefined;
	const configured =
		params.baseUrl ?? (params.provider === "bifrost" ? getDefaultModelDiscoveryBaseUrl("bifrost") : undefined);
	const root = configured ? gatewayRoot(configured) : undefined;
	if (!apiKey || !root) return null;

	let endpoint = root;
	let response = await getQuota(root, apiKey, params, ctx);
	const origin = new URL(root).origin;
	if (response?.status === 404 && origin !== root) {
		endpoint = origin;
		response = await getQuota(origin, apiKey, params, ctx);
	}
	if (!response) return null;
	if (response.status === 401 || response.status === 403) {
		throw new ProviderHttpError(`Bifrost quota endpoint returned ${response.status}`, response.status);
	}
	if (!response.ok) {
		ctx.logger?.debug("Bifrost quota endpoint unavailable", { endpoint, status: response.status });
		return null;
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		ctx.logger?.debug("Bifrost quota response was not JSON", { endpoint });
		return null;
	}
	if (!isRecord(body)) return null;
	const limits = quotaLimits(params.provider, body);
	if (limits.length === 0) return null;

	const configs = Array.isArray(body.provider_configs) ? body.provider_configs : [];
	const accountId = configs
		.map(config => (isRecord(config) ? config.virtual_key_id : undefined))
		.find((id): id is string => typeof id === "string" && id.length > 0);
	const keyName = typeof body.virtual_key_name === "string" ? body.virtual_key_name : undefined;
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint, ...(accountId ? { accountId } : {}), ...(keyName ? { keyName } : {}) },
	};
}

/**
 * Limits that gate `context.modelId`: key-wide ones, its route's provider
 * config, and its model config. Without a model only key-wide limits apply,
 * so one exhausted route never reads as the whole gateway being exhausted.
 */
function scopeBifrostLimits(report: UsageReport, context?: CredentialRankingContext): UsageLimit[] {
	const modelId = context?.modelId;
	return report.limits.filter(limit => {
		const { modelId: scoped, tier } = limit.scope;
		if (scoped === undefined && tier === undefined) return true;
		if (!modelId) return false;
		if (scoped !== undefined) return modelId === scoped || (tier === undefined && modelId.endsWith(`/${scoped}`));
		return modelId.startsWith(`${tier}/`);
	});
}

export const bifrostRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		const limits = scopeBifrostLimits(report, context)
			.filter(limit => limit.window?.durationMs !== undefined)
			.sort((a, b) => (a.window?.durationMs ?? 0) - (b.window?.durationMs ?? 0));
		return { primary: limits[0], secondary: limits[1] };
	},
	scopeLimits: scopeBifrostLimits,
	windowDefaults: { primaryMs: HOUR_MS, secondaryMs: DAY_MS },
};

/**
 * Budgets and rate limits of the calling Bifrost virtual key, its provider
 * configs, and its model configs, from the gateway's self-service quota route.
 */
export const bifrostUsageProvider: UsageProvider = {
	id: "bifrost",
	usesRequestKey: true,
	fetchUsage: fetchBifrostUsage,
};
