import { getDefaultModelDiscoveryBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { normalizeLiteLLMManagementBaseUrl } from "@oh-my-pi/pi-catalog/wire/litellm";
import { ProviderHttpError } from "../error";
import type { Provider } from "../types";
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
import { isRecord } from "../utils";
import { buildUsageAmount, parseIsoTimestamp, usageStatus } from "./shared";

const PROVIDER = "litellm";
const KEY_INFO_PATH = "/key/info";
const SELF_USER_INFO_PATH = "/v2/user/info";
const MANAGEMENT_KEY_PREFIX = "sk-";

const REPORT_NOTE = "Reported key/user budget counters may lag enforcement; other gateway limits are not included.";
const USER_SCOPE_NOTE = "Whether the user budget applies to team-scoped requests depends on gateway policy.";
const NO_LIMIT_NOTE = "No finite budget limit reported.";
const THROTTLE_NOTE = "This key has opted into budget throttling; gateway policy may throttle rather than block it.";

/**
 * Bounded ISO-8601 subset matching what LiteLLM's management API serialises:
 * `YYYY-MM-DD`, optionally followed by `T` or space, `HH:mm:ss`, fractional
 * seconds, and `Z` / `±HH:mm` / `±HHmm`. Anything else is rejected rather than
 * handed to `Date.parse`, which silently rolls impossible dates forward.
 */
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?)?$/;

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parses a LiteLLM timestamp after validating its calendar components; naive datetimes are UTC. */
function parseLiteLLMTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = TIMESTAMP_PATTERN.exec(value.trim());
	if (!match) return undefined;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
		return undefined;
	}
	const date = `${yearText}-${monthText}-${dayText}`;
	if (hourText === undefined) return parseIsoTimestamp(date);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	let offset = "Z";
	if (zone !== undefined && zone !== "Z") {
		const offsetHour = Number(zone.slice(1, 3));
		const offsetMinute = Number(zone.slice(-2));
		if (offsetHour > 23 || offsetMinute > 59) return undefined;
		offset = `${zone[0]}${zone.slice(1, 3)}:${zone.slice(-2)}`;
	}
	const millis = fraction === undefined ? "" : `.${fraction.slice(0, 3)}`;
	return parseIsoTimestamp(`${date}T${hourText}:${minuteText}:${secondText}${millis}${offset}`);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveLiteLLMBaseUrl(params: UsageFetchParams): string | undefined {
	const configured = params.baseUrl ?? litellmUsageProvider.defaultBaseUrl?.(params.provider);
	const trimmed = configured?.trim();
	if (!trimmed) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return undefined;
	const normalized = normalizeLiteLLMManagementBaseUrl(trimmed);
	return normalized || undefined;
}

function resolveApiKey(params: UsageFetchParams): string | undefined {
	if (params.credential.type !== "api_key") return undefined;
	return nonEmptyString(params.credential.apiKey);
}

/**
 * Returns the decoded JSON object, or `undefined` when this scope is
 * unavailable (non-2xx other than 401, transport or decode failure, non-object
 * body). A 401 throws so the cached report is purged instead of re-served.
 */
async function getJson(url: string, apiKey: string, ctx: UsageFetchContext, signal: AbortSignal | undefined) {
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			redirect: "error",
			signal,
		});
	} catch {
		ctx.logger?.debug("LiteLLM usage request failed", { url });
		return undefined;
	}
	if (response.status === 401) {
		throw new ProviderHttpError("LiteLLM usage endpoint returned 401", 401);
	}
	if (!response.ok) {
		ctx.logger?.debug("LiteLLM usage endpoint unavailable", { url, status: response.status });
		return undefined;
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		ctx.logger?.debug("LiteLLM usage response was not JSON", { url });
		return undefined;
	}
	return isRecord(json) ? json : undefined;
}

interface BudgetCounters {
	spend: number;
	/** Finite cap, or undefined when the gateway reports none or an unusable one. */
	cap: number | undefined;
	window: UsageWindow | undefined;
}

function buildWindow(duration: unknown, resetAt: unknown): UsageWindow | undefined {
	const id = nonEmptyString(duration);
	if (!id) return undefined;
	const resetsAt = parseLiteLLMTimestamp(resetAt);
	return { id, label: id, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** `null`/`undefined` mean the field is absent; any other non-finite value is explicit and unusable. */
function readCap(value: unknown): { present: boolean; cap: number | undefined } {
	if (value === null || value === undefined) return { present: false, cap: undefined };
	return { present: true, cap: finiteNumber(value) };
}

/**
 * Applies the key's own temporary budget adjustment the way the proxy's auth
 * check does: both metadata fields present, finite increase, expiry parsed as
 * UTC and strictly in the future. A missing field leaves the base cap alone;
 * a present but unusable value (including `null`) makes the cap unknown
 * rather than guessing.
 */
function applyTemporaryAdjustment(cap: number | undefined, metadata: unknown, now: number): number | undefined {
	if (!isRecord(metadata)) return cap;
	const increase = metadata.temp_budget_increase;
	const expiry = metadata.temp_budget_expiry;
	if (increase === undefined || expiry === undefined) return cap;
	if (cap === undefined) return undefined;
	const amount = finiteNumber(increase);
	const expiresAt = parseLiteLLMTimestamp(expiry);
	if (amount === undefined || expiresAt === undefined) return undefined;
	if (expiresAt <= now) return cap;
	const adjusted = cap + amount;
	return Number.isFinite(adjusted) ? adjusted : undefined;
}

function parseKeyCounters(info: Record<string, unknown>, now: number): BudgetCounters | undefined {
	const spend = finiteNumber(info.spend);
	if (spend === undefined || spend < 0) return undefined;
	const table = isRecord(info.litellm_budget_table) ? info.litellm_budget_table : undefined;
	const ownCap = readCap(info.max_budget);
	const baseCap = ownCap.present ? ownCap.cap : readCap(table?.max_budget).cap;
	const cap = applyTemporaryAdjustment(baseCap, info.metadata, now);
	const window =
		info.budget_duration !== null && info.budget_duration !== undefined
			? buildWindow(info.budget_duration, info.budget_reset_at)
			: buildWindow(table?.budget_duration, table?.budget_reset_at);
	return { spend, cap, window };
}

function parseUserCounters(user: Record<string, unknown>): (BudgetCounters & { userId: string }) | undefined {
	const spend = finiteNumber(user.spend);
	if (spend === undefined || spend < 0) return undefined;
	const userId = nonEmptyString(user.user_id);
	if (!userId) return undefined;
	return {
		userId,
		spend,
		cap: readCap(user.max_budget).cap,
		window: buildWindow(user.budget_duration, user.budget_reset_at),
	};
}

function buildBudgetAmount(counters: BudgetCounters): { amount: UsageAmount; status: UsageStatus; notes?: string[] } {
	const { spend, cap } = counters;
	if (cap === undefined) {
		return {
			amount: buildUsageAmount({ unit: "usd", used: spend, limit: undefined, remaining: undefined }),
			status: "unknown",
			notes: [NO_LIMIT_NOTE],
		};
	}
	if (cap <= 0) {
		return {
			amount: buildUsageAmount({ unit: "usd", used: spend, limit: cap, remaining: 0, usedFraction: 1 }),
			status: "exhausted",
		};
	}
	const amount = buildUsageAmount({ unit: "usd", used: spend, limit: cap, remaining: Math.max(0, cap - spend) });
	return { amount, status: usageStatus(amount.usedFraction) };
}

function buildLimit(
	id: string,
	label: string,
	provider: Provider,
	accountId: string | undefined,
	counters: BudgetCounters,
	extraNotes: string[] = [],
): UsageLimit {
	const { amount, status, notes } = buildBudgetAmount(counters);
	const limitNotes = [...(notes ?? []), ...extraNotes];
	return {
		id,
		label,
		scope: {
			provider,
			shared: true,
			...(counters.window ? { windowId: counters.window.id } : {}),
			...(accountId ? { accountId } : {}),
		},
		...(counters.window ? { window: counters.window } : {}),
		amount,
		status,
		...(limitNotes.length > 0 ? { notes: limitNotes } : {}),
	};
}

/**
 * Reads the authenticated key's own `/key/info` record (management keys only)
 * and the authenticated user's `/v2/user/info` record, each without a query,
 * and reports their USD budget counters. Either scope alone is enough; a 401
 * from either discards the whole report.
 */
async function fetchLiteLLMUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const apiKey = resolveApiKey(params);
	const baseUrl = resolveLiteLLMBaseUrl(params);
	if (!apiKey || !baseUrl) return null;
	const fetchedAt = Date.now();

	let keyInfo: Record<string, unknown> | undefined;
	if (apiKey.startsWith(MANAGEMENT_KEY_PREFIX)) {
		const body = await getJson(`${baseUrl}${KEY_INFO_PATH}`, apiKey, ctx, params.signal);
		keyInfo = body && isRecord(body.info) ? body.info : undefined;
	}
	const user = await getJson(`${baseUrl}${SELF_USER_INFO_PATH}`, apiKey, ctx, params.signal);

	const keyCounters = keyInfo ? parseKeyCounters(keyInfo, fetchedAt) : undefined;
	const userCounters = user ? parseUserCounters(user) : undefined;
	if (!keyCounters && !userCounters) return null;

	const accountId = userCounters?.userId ?? nonEmptyString(keyInfo?.user_id);
	const email = nonEmptyString(user?.user_email);
	const limits: UsageLimit[] = [];
	if (keyCounters) {
		const limit = buildLimit(
			`${params.provider}:key:${Bun.hash(apiKey).toString(16)}:budget`,
			"Key budget",
			params.provider,
			accountId,
			keyCounters,
		);
		const throttles = isRecord(keyInfo?.metadata) && keyInfo.metadata.throttle_on_budget_exceeded === true;
		if (limit.status === "exhausted" && throttles) limit.notes = [...(limit.notes ?? []), THROTTLE_NOTE];
		limits.push(limit);
	}
	if (userCounters) {
		limits.push(
			buildLimit(`${params.provider}:user:budget`, "User budget", params.provider, accountId, userCounters),
		);
	}

	return {
		provider: params.provider,
		fetchedAt,
		limits,
		notes: userCounters ? [REPORT_NOTE, USER_SCOPE_NOTE] : [REPORT_NOTE],
		metadata: {
			source: "litellm-management",
			endpoint: baseUrl,
			...(accountId ? { accountId } : {}),
			...(email ? { email } : {}),
		},
	};
}

export const litellmUsageProvider: UsageProvider = {
	id: PROVIDER,
	cacheVersion: 1,
	usesRequestKey: true,
	validatesCredentials: false,
	defaultBaseUrl: provider => (provider === PROVIDER ? getDefaultModelDiscoveryBaseUrl(PROVIDER) : undefined),
	fetchUsage: fetchLiteLLMUsage,
	supports: params => resolveApiKey(params) !== undefined && resolveLiteLLMBaseUrl(params) !== undefined,
};
