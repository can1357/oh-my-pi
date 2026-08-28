import { scheduler } from "node:timers/promises";
import { bareModelId, parseAnthropicModel } from "@oh-my-pi/pi-catalog/identity";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import * as AIError from "../error";
import { claudeCodeVersion } from "../providers/claude-code-fingerprint";
import {
	type CredentialRankingContext,
	type CredentialRankingStrategy,
	resolveUsedFraction,
	type UsageAmount,
	type UsageFetchContext,
	type UsageFetchParams,
	type UsageLimit,
	type UsageProvider,
	type UsageReport,
	type UsageStatus,
	type UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, parseIsoTimestamp, WEEK_MS } from "./shared";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth";
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;

const CLAUDE_HEADERS = {
	accept: "application/json, text/plain, */*",
	"accept-encoding": "gzip, compress, deflate, br",
	"anthropic-beta":
		"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
	"content-type": "application/json",
	"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
	connection: "keep-alive",
} as const;

function normalizeClaudeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	const lower = trimmed.toLowerCase();
	if (lower.endsWith("/api/oauth")) return trimmed;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return DEFAULT_ENDPOINT;
	}
	let path = url.pathname.replace(/\/+$/, "");
	if (path === "/") path = "";
	if (path.toLowerCase().endsWith("/v1")) {
		path = path.slice(0, -3);
	}
	if (!path) return `${url.origin}/api/oauth`;
	return `${url.origin}${path}/api/oauth`;
}

interface ClaudeUsageBucket {
	utilization?: number;
	resets_at?: string;
}

interface ParsedUsageBucket {
	utilization?: number;
	resetsAt?: number;
}

interface ClaudeExtraUsage {
	is_enabled?: boolean;
	monthly_limit?: number | null;
	used_credits?: number;
	decimal_places?: number;
	currency?: string;
}

interface ClaudeMoneyAmount {
	amount_minor?: number;
	currency?: string;
	exponent?: number;
}

interface ClaudeSpend {
	used?: ClaudeMoneyAmount | null;
	limit?: ClaudeMoneyAmount | null;
	enabled?: boolean;
}

interface ParsedClaudeExtraUsage {
	used: number;
	limit?: number;
}
type ClaudeUnifiedWindow = "5h" | "7d" | "7d_oi";
type ClaudeModelKind = "opus" | "sonnet" | "fable" | "mythos";

interface ClaudeUsageResponse {
	five_hour?: ClaudeUsageBucket | null;
	seven_day?: ClaudeUsageBucket | null;
	seven_day_opus?: ClaudeUsageBucket | null;
	seven_day_sonnet?: ClaudeUsageBucket | null;
	limits?: unknown;
	extra_usage?: ClaudeExtraUsage | null;
	spend?: ClaudeSpend | null;
}

interface ClaudeApiLimitModelScope {
	display_name?: string | null;
}

interface ClaudeApiLimitScope {
	model?: ClaudeApiLimitModelScope | null;
}

interface ClaudeApiLimitEntry {
	kind?: string;
	percent?: unknown;
	resets_at?: string | null;
	scope?: ClaudeApiLimitScope | null;
	is_active?: boolean;
}

interface ParsedApiLimitEntry {
	kind: string;
	bucket: ParsedUsageBucket;
	displayName?: string;
}

function parseBucket(bucket: unknown): ParsedUsageBucket | undefined {
	if (!isRecord(bucket)) return undefined;
	const utilization = toNumber(bucket.utilization);
	const resetsAt = parseIsoTimestamp(typeof bucket.resets_at === "string" ? bucket.resets_at : undefined);
	if (utilization === undefined && resetsAt === undefined) {
		return undefined;
	}
	return { utilization, resetsAt };
}

function getApiLimitDisplayName(scope: unknown): string | undefined {
	if (!isRecord(scope)) return undefined;
	const model = scope.model;
	if (!isRecord(model)) return undefined;
	const displayName = model.display_name;
	return typeof displayName === "string" && displayName.trim() ? displayName.trim() : undefined;
}

/**
 * Anthropic kept the legacy account-wide buckets populated, but as of
 * 2026-07-02 the legacy per-model weekly buckets (`seven_day_opus` /
 * `seven_day_sonnet`) are permanently null. Model-scoped weekly caps now arrive
 * only through generic `limits[]` entries (`kind: "weekly_scoped"`) with the
 * model family named by `scope.model.display_name`.
 *
 * `is_active` is deliberately ignored: live payloads mark only the currently
 * binding limit active (an account pinned at a 100% Fable cap reports its 77%
 * shared weekly row as `is_active: false`), so it signals severity ranking,
 * not bucket existence. Filtering on it hid real utilization — a scoped row
 * at 5% with a live reset rendered as `not reported` in `omp usage`.
 */
function parseApiLimitEntries(raw: unknown): ParsedApiLimitEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: ParsedApiLimitEntry[] = [];
	for (const rawEntry of raw) {
		if (!isRecord(rawEntry)) continue;
		const entry = rawEntry as ClaudeApiLimitEntry;
		if (typeof entry.kind !== "string") continue;
		const utilization = toNumber(entry.percent);
		const resetsAt = parseIsoTimestamp(typeof entry.resets_at === "string" ? entry.resets_at : undefined);
		if (utilization === undefined && resetsAt === undefined) continue;
		const displayName = getApiLimitDisplayName(entry.scope);
		entries.push({
			kind: entry.kind,
			bucket: { utilization, resetsAt },
			...(displayName ? { displayName } : {}),
		});
	}
	return entries;
}

function parseUnifiedWindow(
	headers: Record<string, string>,
	window: ClaudeUnifiedWindow,
): ParsedUsageBucket | undefined {
	const prefix = `anthropic-ratelimit-unified-${window}-`;
	const utilizationFraction = toNumber(headers[`${prefix}utilization`]);
	const resetSeconds = toNumber(headers[`${prefix}reset`]);
	const utilization = utilizationFraction === undefined ? undefined : utilizationFraction * 100;
	const resetsAt = resetSeconds !== undefined && resetSeconds > 0 ? resetSeconds * 1000 : undefined;
	if (utilization === undefined && resetsAt === undefined) {
		return undefined;
	}
	return { utilization, resetsAt };
}

function getPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNestedPayloadString(payload: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
	const nested = payload[key];
	return isRecord(nested) ? getPayloadString(nested, nestedKey) : undefined;
}

function extractUsageIdentity(payload: ClaudeUsageResponse): { accountId?: string; email?: string } {
	if (!isRecord(payload)) return {};
	const accountId =
		getPayloadString(payload, "account_id") ??
		getPayloadString(payload, "accountId") ??
		getPayloadString(payload, "user_id") ??
		getPayloadString(payload, "userId") ??
		getNestedPayloadString(payload, "account", "uuid") ??
		getNestedPayloadString(payload, "account", "id") ??
		getNestedPayloadString(payload, "user", "uuid") ??
		getNestedPayloadString(payload, "user", "id");
	const email =
		getPayloadString(payload, "email") ??
		getPayloadString(payload, "user_email") ??
		getPayloadString(payload, "userEmail") ??
		getNestedPayloadString(payload, "account", "email") ??
		getNestedPayloadString(payload, "user", "email");
	return { accountId, email };
}

function hasUsageData(payload: ClaudeUsageResponse): boolean {
	return (
		parseBucket(payload.five_hour)?.utilization !== undefined ||
		parseBucket(payload.seven_day)?.utilization !== undefined ||
		parseBucket(payload.seven_day_opus)?.utilization !== undefined ||
		parseBucket(payload.seven_day_sonnet)?.utilization !== undefined ||
		parseApiLimitEntries(payload.limits).some(entry => entry.bucket.utilization !== undefined) ||
		buildClaudeExtraUsageLimit(payload) !== null
	);
}

function isRetryableStatus(status: number): boolean {
	// Exclude 429: the usage endpoint is informational and rate-limited per
	// source IP, so retrying a rate_limit_error inside a single fetch can't
	// succeed and only deepens the throttle (3 attempts per poll). Fall through
	// to the caller's failure cool-down and retry on the next poll instead.
	return AIError.isTransientStatus(status) && status !== 429;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!isRecord(error)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError";
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
	const baseline = BASE_RETRY_DELAY_MS * 2 ** attempt;
	if (!retryAfter?.trim()) return baseline;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(baseline, Math.max(0, seconds * 1000));
	const dateDelay = Date.parse(retryAfter) - Date.now();
	return Number.isFinite(dateDelay) ? Math.max(baseline, Math.max(0, dateDelay)) : baseline;
}

async function waitBeforeRetry(
	attempt: number,
	retryAfter: string | null,
	signal?: AbortSignal,
	retryWait?: UsageFetchContext["retryWait"],
): Promise<boolean> {
	if (signal?.aborted) return false;
	if (attempt >= MAX_ATTEMPTS - 1) return false;
	try {
		const delayMs = retryDelayMs(attempt, retryAfter);
		if (retryWait) {
			await retryWait(delayMs, signal);
		} else {
			await scheduler.wait(delayMs, { signal });
		}
		return !signal?.aborted;
	} catch (error) {
		if (isAbortError(error, signal)) return false;
		throw error;
	}
}

async function fetchUsagePayload(
	url: string,
	headers: Record<string, string>,
	ctx: UsageFetchContext,
	signal?: AbortSignal,
): Promise<ClaudeUsageResponse | null> {
	if (signal?.aborted) return null;

	let lastPayload: ClaudeUsageResponse | null = null;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const response = await ctx.fetch(url, { headers, signal });

			if (!response.ok) {
				const retryable = isRetryableStatus(response.status);
				ctx.logger?.warn("Claude usage fetch failed", {
					status: response.status,
					statusText: response.statusText,
					attempt,
					willRetry: retryable && attempt < MAX_ATTEMPTS - 1,
				});
				if (!retryable) return null;
				const retryAfter = response.headers.get("retry-after");
				if (!(await waitBeforeRetry(attempt, retryAfter, signal, ctx.retryWait))) break;
				continue;
			}

			const parsed = (await response.json()) as unknown;
			if (isRecord(parsed)) {
				const payload = parsed as ClaudeUsageResponse;
				lastPayload = payload;
				if (hasUsageData(payload)) return payload;
			}

			ctx.logger?.warn("Claude usage response missing usage data", {
				attempt,
				willRetry: attempt < MAX_ATTEMPTS - 1,
			});
			if (!(await waitBeforeRetry(attempt, null, signal, ctx.retryWait))) break;
		} catch (error) {
			if (isAbortError(error, signal)) return null;
			ctx.logger?.warn("Claude usage fetch error", {
				error: String(error),
				attempt,
				willRetry: attempt < MAX_ATTEMPTS - 1,
			});
			if (!(await waitBeforeRetry(attempt, null, signal, ctx.retryWait))) break;
		}
	}

	return lastPayload;
}

interface ClaudeProfile {
	uuid?: string;
	email?: string;
	account?: {
		uuid?: string;
		email?: string;
	};
}

function extractProfileIdentity(profile: ClaudeProfile | null): { accountId?: string; email?: string } {
	if (!profile || !isRecord(profile)) return {};
	const account = isRecord(profile.account) ? profile.account : undefined;
	return {
		accountId:
			(typeof profile.uuid === "string" && profile.uuid.trim() ? profile.uuid.trim() : undefined) ??
			(typeof account?.uuid === "string" && account.uuid.trim() ? account.uuid.trim() : undefined),
		email:
			(typeof profile.email === "string" && profile.email.trim() ? profile.email.trim() : undefined) ??
			(typeof account?.email === "string" && account.email.trim() ? account.email.trim() : undefined),
	};
}

async function fetchProfile(
	baseUrl: string,
	headers: Record<string, string>,
	ctx: UsageFetchContext,
	signal?: AbortSignal,
): Promise<ClaudeProfile | null> {
	if (signal?.aborted) return null;
	const url = `${baseUrl}/profile`;
	try {
		const response = await ctx.fetch(url, { headers, signal });
		if (!response.ok) return null;
		const payload = (await response.json()) as unknown;
		return isRecord(payload) ? (payload as ClaudeProfile) : null;
	} catch (error) {
		if (isAbortError(error, signal)) return null;
		ctx.logger?.debug("Claude profile fetch error", { error: String(error) });
		return null;
	}
}

function buildUsageAmount(utilization: number | undefined): UsageAmount | undefined {
	if (utilization === undefined) return undefined;
	const clamped = Math.min(Math.max(utilization, 0), 100);
	const usedFraction = clamped / 100;
	return {
		used: clamped,
		limit: 100,
		remaining: Math.max(0, 100 - clamped),
		usedFraction,
		remainingFraction: Math.max(0, 1 - usedFraction),
		unit: "percent",
	};
}

function buildUsageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function parseDollarAmount(
	amountMinor: unknown,
	exponent: unknown,
	currency: unknown,
	currencyRequired: boolean,
): number | undefined {
	if (
		typeof amountMinor !== "number" ||
		!Number.isSafeInteger(amountMinor) ||
		amountMinor < 0 ||
		typeof exponent !== "number" ||
		!Number.isSafeInteger(exponent) ||
		exponent < 0
	) {
		return undefined;
	}
	if (currency === undefined) {
		if (currencyRequired) return undefined;
	} else if (typeof currency !== "string" || currency.toUpperCase() !== "USD") {
		return undefined;
	}
	const divisor = 10 ** exponent;
	if (!Number.isFinite(divisor)) return undefined;
	const dollars = amountMinor / divisor;
	return Number.isFinite(dollars) ? dollars : undefined;
}

function parseSpendExtraUsage(value: unknown): ParsedClaudeExtraUsage | null {
	if (!isRecord(value) || value.enabled !== true || !Object.hasOwn(value, "limit") || !isRecord(value.used)) {
		return null;
	}
	const used = parseDollarAmount(value.used.amount_minor, value.used.exponent, value.used.currency, true);
	if (used === undefined) return null;
	if (value.limit === null) return { used };
	if (!isRecord(value.limit)) return null;
	const limit = parseDollarAmount(value.limit.amount_minor, value.limit.exponent, value.limit.currency, true);
	// Reject non-positive caps rather than normalizing them into contradictory zero fractions.
	return limit === undefined || limit <= 0 ? null : { used, limit };
}

function parseLegacyExtraUsage(value: unknown): ParsedClaudeExtraUsage | null {
	if (!isRecord(value) || value.is_enabled !== true || !Object.hasOwn(value, "monthly_limit")) return null;
	const decimalPlaces = value.decimal_places === undefined ? 2 : value.decimal_places;
	const used = parseDollarAmount(value.used_credits, decimalPlaces, value.currency, false);
	if (used === undefined) return null;
	if (value.monthly_limit === null || value.monthly_limit === undefined) return { used };
	const limit = parseDollarAmount(value.monthly_limit, decimalPlaces, value.currency, false);
	return limit === undefined || limit <= 0 ? null : { used, limit };
}

function buildExtraUsageAmount(used: number, limit: number | undefined): UsageAmount | undefined {
	if (limit === undefined) return { used, unit: "usd" };
	const remaining = Math.max(0, limit - used);
	const usedFraction = used / limit;
	const remainingFraction = remaining / limit;
	if (!Number.isFinite(remaining) || !Number.isFinite(usedFraction) || !Number.isFinite(remainingFraction)) {
		return undefined;
	}
	return {
		used,
		unit: "usd",
		limit,
		remaining,
		usedFraction,
		remainingFraction,
	};
}

function buildClaudeExtraUsageLimit(payload: ClaudeUsageResponse): UsageLimit | null {
	const parsed =
		payload.spend === null || payload.spend === undefined
			? parseLegacyExtraUsage(payload.extra_usage)
			: parseSpendExtraUsage(payload.spend);
	if (!parsed) return null;

	const amount = buildExtraUsageAmount(parsed.used, parsed.limit);
	if (!amount) return null;
	const status =
		parsed.limit === undefined
			? undefined
			: parsed.used >= parsed.limit
				? "exhausted"
				: (buildUsageStatus(amount.usedFraction) ?? "ok");
	return {
		id: "anthropic:extra",
		label: "Claude Extra Usage",
		scope: {
			provider: "anthropic",
			windowId: "extra",
		},
		amount,
		...(status !== undefined ? { status } : {}),
	};
}

function buildUsageLimit(args: {
	id: string;
	label: string;
	windowId: string;
	windowLabel: string;
	durationMs: number;
	bucket: ParsedUsageBucket | undefined;
	provider: "anthropic";
	tier?: string;
	shared?: boolean;
}): UsageLimit | null {
	if (!args.bucket) return null;
	const amount = buildUsageAmount(args.bucket.utilization);
	if (!amount) return null;
	const window: UsageWindow = {
		id: args.windowId,
		label: args.windowLabel,
		durationMs: args.durationMs,
		...(args.bucket.resetsAt !== undefined ? { resetsAt: args.bucket.resetsAt } : {}),
	};
	return {
		id: args.id,
		label: args.label,
		scope: {
			provider: args.provider,
			windowId: args.windowId,
			...(args.tier !== undefined ? { tier: args.tier } : {}),
			...(args.shared !== undefined ? { shared: args.shared } : {}),
		},
		window,
		amount,
		status: buildUsageStatus(amount.usedFraction),
	};
}

function slugifyClaudeLimitDisplayName(displayName: string): string {
	return displayName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Scoped weekly rows are per-model-family counters, not account-wide windows.
 * They deliberately leave `scope.shared` unset so credential-wide exhaustion
 * gating only considers the shared umbrella windows; an exhausted Fable weekly
 * cap must not block Opus or Sonnet requests on the same credential.
 */
function buildScopedWeeklyUsageLimits(entries: readonly ParsedApiLimitEntry[]): UsageLimit[] {
	const seenSlugs = new Set<string>();
	const limits: UsageLimit[] = [];
	for (const entry of entries) {
		if (entry.kind !== "weekly_scoped" || !entry.displayName) continue;
		const slug = slugifyClaudeLimitDisplayName(entry.displayName);
		if (!slug || seenSlugs.has(slug)) continue;
		seenSlugs.add(slug);
		const limit = buildUsageLimit({
			id: `anthropic:7d:${slug}`,
			label: `Claude 7 Day (${entry.displayName})`,
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: entry.bucket,
			provider: "anthropic",
			tier: slug,
		});
		if (limit) limits.push(limit);
	}
	return limits;
}

export function parseClaudeRateLimitHeaders(headers: Record<string, string>, now = Date.now()): UsageReport | null {
	const fiveHour = parseUnifiedWindow(headers, "5h");
	const sevenDay = parseUnifiedWindow(headers, "7d");
	const modelScopedSevenDay = parseUnifiedWindow(headers, "7d_oi");
	const limits = [
		buildUsageLimit({
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			windowId: "5h",
			windowLabel: "5 Hour",
			durationMs: 5 * HOUR_MS,
			bucket: fiveHour,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d",
			label: "Claude 7 Day",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: sevenDay,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d:fable",
			label: "Claude 7 Day (Fable)",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: modelScopedSevenDay,
			provider: "anthropic",
			tier: "fable",
		}),
	].filter((limit): limit is UsageLimit => limit !== null);

	if (limits.length === 0) return null;
	return {
		provider: "anthropic",
		fetchedAt: now,
		limits,
		metadata: { source: "ratelimit-headers" },
	};
}

async function fetchClaudeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "anthropic") return null;
	const credential = params.credential;
	if (credential.type !== "oauth" || !credential.accessToken) return null;

	const baseUrl = normalizeClaudeBaseUrl(params.baseUrl);
	const url = `${baseUrl}/usage`;
	const headers: Record<string, string> = {
		...CLAUDE_HEADERS,
		authorization: `Bearer ${credential.accessToken}`,
	};

	const payload = await fetchUsagePayload(url, headers, ctx, params.signal);
	if (!payload || !isRecord(payload)) return null;

	const apiLimitEntries = parseApiLimitEntries(payload.limits);
	const fiveHour = parseBucket(payload.five_hour) ?? apiLimitEntries.find(entry => entry.kind === "session")?.bucket;
	const sevenDay =
		parseBucket(payload.seven_day) ?? apiLimitEntries.find(entry => entry.kind === "weekly_all")?.bucket;
	const sevenDayOpus = parseBucket(payload.seven_day_opus);
	const sevenDaySonnet = parseBucket(payload.seven_day_sonnet);

	const limits = [
		buildUsageLimit({
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			windowId: "5h",
			windowLabel: "5 Hour",
			durationMs: 5 * HOUR_MS,
			bucket: fiveHour,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d",
			label: "Claude 7 Day",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: sevenDay,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d:opus",
			label: "Claude 7 Day (Opus)",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: sevenDayOpus,
			provider: "anthropic",
			tier: "opus",
		}),
		buildUsageLimit({
			id: "anthropic:7d:sonnet",
			label: "Claude 7 Day (Sonnet)",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: WEEK_MS,
			bucket: sevenDaySonnet,
			provider: "anthropic",
			tier: "sonnet",
		}),
		...buildScopedWeeklyUsageLimits(apiLimitEntries),
		buildClaudeExtraUsageLimit(payload),
	].filter((limit): limit is UsageLimit => limit !== null);

	if (limits.length === 0) return null;
	const identity = extractUsageIdentity(payload);
	let accountId = identity.accountId ?? credential.accountId;
	let email = identity.email ?? credential.email;
	if ((!accountId || !email) && !params.signal?.aborted) {
		const profileIdentity = extractProfileIdentity(await fetchProfile(baseUrl, headers, ctx, params.signal));
		accountId = accountId ?? profileIdentity.accountId;
		email = email ?? profileIdentity.email;
	}

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: url,
			...(accountId ? { accountId } : {}),
			...(email ? { email } : {}),
			...(credential.orgId ? { orgId: credential.orgId } : {}),
		},
		raw: payload,
	};

	return report;
}

export const claudeUsageProvider: UsageProvider = {
	id: "anthropic",
	fetchUsage: fetchClaudeUsage,
	parseRateLimitHeaders: parseClaudeRateLimitHeaders,
	supports: params => params.provider === "anthropic" && params.credential.type === "oauth",
};

function getClaudeModelKind(context: CredentialRankingContext | undefined): ClaudeModelKind | undefined {
	const modelId = context?.modelId;
	if (!modelId) return undefined;
	return parseAnthropicModel(bareModelId(modelId))?.kind;
}

/**
 * Claude model-scoped rows are only relevant to the matching model family.
 * Credential-wide exhaustion checks stay on shared umbrella windows unless the
 * request model parses to a concrete Anthropic kind, preventing a Fable cap from
 * suppressing unrelated Opus/Sonnet traffic. Feeds ranking pressure and the
 * opt-in reserve-health scope (`scopeLimitsForReserve`); credential-wide hard
 * blocks use {@link scopeClaudeLimitsForModelHardBlock} instead.
 */
function scopeClaudeLimitsForModel(report: UsageReport, context: CredentialRankingContext | undefined): UsageLimit[] {
	const kind = getClaudeModelKind(context);
	return report.limits.filter(
		limit => limit.scope.shared === true || (kind !== undefined && limit.scope.tier === kind),
	);
}

/**
 * A Fable/Mythos weekly row is trusted for gating only at full exhaustion
 * (server `exhausted` status or used fraction >= 1) with a live reset
 * timestamp. Anything below that stays untrusted: the counters are
 * notoriously unreliable short of the cap (they report high utilization
 * while the account can still serve requests).
 */
function isConfirmedExhaustedTierRow(limit: UsageLimit, nowMs: number): boolean {
	const resetsAt = limit.window?.resetsAt;
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= nowMs) return false;
	if (limit.status === "exhausted") return true;
	const fraction = resolveUsedFraction(limit);
	return typeof fraction === "number" && fraction >= 1;
}

/**
 * Scope limits for proactive hard-blocking (gating). Fable and Mythos tier
 * weekly caps participate only when {@link isConfirmedExhaustedTierRow}
 * confirms them, so a confirmed-dead account is skipped up front and a
 * reactive 429 block extends to the tier reset in markUsageLimitReached,
 * while unconfirmed rows remain ranking pressure and opt-in reserve health via
 * scopeClaudeLimitsForModel.
 */
function scopeClaudeLimitsForModelHardBlock(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit[] {
	const kind = getClaudeModelKind(context);
	const requireConfirmedTierRow = kind === "fable" || kind === "mythos";
	const nowMs = Date.now();
	return report.limits.filter(limit => {
		if (limit.scope.shared === true) return true;
		if (kind === undefined || limit.scope.tier !== kind) return false;
		return !requireConfirmedTierRow || isConfirmedExhaustedTierRow(limit, nowMs);
	});
}

function rankingUsedFraction(limit: UsageLimit): number {
	const fraction = resolveUsedFraction(limit);
	if (typeof fraction !== "number" || !Number.isFinite(fraction)) return 0.5;
	return Math.min(Math.max(fraction, 0), 1);
}

function rankingDrainRate(limit: UsageLimit, nowMs: number): number {
	const usedFraction = rankingUsedFraction(limit);
	const durationMs = limit.window?.durationMs ?? WEEK_MS;
	if (!Number.isFinite(durationMs) || durationMs <= 0) return usedFraction;
	const resetAt = limit.window?.resetsAt;
	if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return usedFraction;
	const remainingWindowMs = resetAt - nowMs;
	const clampedRemainingWindowMs = Math.min(Math.max(remainingWindowMs, 0), durationMs);
	const elapsedMs = durationMs - clampedRemainingWindowMs;
	if (elapsedMs <= 0) return usedFraction;
	const elapsedHours = elapsedMs / (60 * 60 * 1000);
	if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return usedFraction;
	return usedFraction / elapsedHours;
}

function morePressuredLimit(
	left: UsageLimit | undefined,
	right: UsageLimit | undefined,
	nowMs: number,
): UsageLimit | undefined {
	if (!left) return right;
	if (!right) return left;
	const leftDrainRate = rankingDrainRate(left, nowMs);
	const rightDrainRate = rankingDrainRate(right, nowMs);
	if (rightDrainRate !== leftDrainRate) return rightDrainRate > leftDrainRate ? right : left;
	return rankingUsedFraction(right) > rankingUsedFraction(left) ? right : left;
}

function findClaudeSecondaryLimit(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit | undefined {
	const nowMs = Date.now();
	return scopeClaudeLimitsForModel(report, context)
		.filter(limit => limit.scope.windowId === "7d" || limit.window?.id === "7d")
		.reduce<UsageLimit | undefined>((selected, limit) => morePressuredLimit(selected, limit, nowMs), undefined);
}

export const claudeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		const primary = report.limits.find(limit => limit.id === "anthropic:5h");
		const secondary = findClaudeSecondaryLimit(report, context);
		return { primary, secondary };
	},
	scopeLimits: scopeClaudeLimitsForModelHardBlock,
	// Reserve health is a non-destructive fallback, not a credential hard
	// block, so it trusts the mapped tier row before confirmed exhaustion: a
	// Fable/Mythos weekly cap inside the reserve margin should move the turn to
	// a healthy candidate rather than serve until 100%.
	scopeLimitsForReserve: scopeClaudeLimitsForModel,
	/**
	 * Fable/Mythos usage-limit errors map to tier-local weekly counters. Scope
	 * reactive backoff blocks for those tiers, mirroring the per-counter
	 * precedent in packages/ai/src/usage/google-antigravity.ts:466-497.
	 */
	blockScope(context) {
		const kind = getClaudeModelKind(context);
		return kind === "fable" || kind === "mythos" ? `tier:${kind}` : undefined;
	},
	windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
};
