import { scheduler } from "node:timers/promises";
import { toNumber } from "@pk-nerdsaver-ai/pi-catalog/utils";
import * as AIError from "../error";
import { claudeCodeVersion } from "../providers/anthropic";
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

const DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
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
type ClaudeUnifiedWindow = "5h" | "7d";

interface ClaudeUsageResponse {
	five_hour?: ClaudeUsageBucket | null;
	seven_day?: ClaudeUsageBucket | null;
	seven_day_opus?: ClaudeUsageBucket | null;
	seven_day_sonnet?: ClaudeUsageBucket | null;
}

type ClaudeUsagePayload = {
	payload: ClaudeUsageResponse;
	orgId?: string;
};

function parseIsoTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBucket(bucket: unknown): ParsedUsageBucket | undefined {
	if (!isRecord(bucket)) return undefined;
	const utilization = toNumber(bucket.utilization);
	const resetsAt = parseIsoTime(typeof bucket.resets_at === "string" ? bucket.resets_at : undefined);
	if (utilization === undefined && resetsAt === undefined) {
		return undefined;
	}
	return { utilization, resetsAt };
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

function extractUsageIdentity(payload: ClaudeUsageResponse, orgId?: string): { accountId?: string; email?: string } {
	if (!isRecord(payload)) return { accountId: orgId };
	const accountId =
		getPayloadString(payload, "account_id") ??
		getPayloadString(payload, "accountId") ??
		getPayloadString(payload, "user_id") ??
		getPayloadString(payload, "userId") ??
		getPayloadString(payload, "org_id") ??
		getPayloadString(payload, "orgId") ??
		getNestedPayloadString(payload, "account", "uuid") ??
		getNestedPayloadString(payload, "account", "id") ??
		getNestedPayloadString(payload, "organization", "uuid") ??
		getNestedPayloadString(payload, "organization", "id") ??
		getNestedPayloadString(payload, "user", "uuid") ??
		getNestedPayloadString(payload, "user", "id") ??
		orgId;
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
		parseBucket(payload.seven_day_sonnet)?.utilization !== undefined
	);
}

function isRetryableStatus(status: number): boolean {
	return AIError.isTransientStatus(status);
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
): Promise<ClaudeUsagePayload | null> {
	if (signal?.aborted) return null;

	let lastPayload: ClaudeUsageResponse | null = null;
	let lastOrgId: string | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const response = await ctx.fetch(url, { headers, signal });
			const orgId = response.headers.get("anthropic-organization-id")?.trim() || undefined;
			lastOrgId = orgId ?? lastOrgId;

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
				if (hasUsageData(payload)) return { payload, orgId };
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

	return lastPayload ? { payload: lastPayload, orgId: lastOrgId } : null;
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
			tier: args.tier,
			shared: args.shared,
		},
		window,
		amount,
		status: buildUsageStatus(amount.usedFraction),
	};
}

export function parseClaudeRateLimitHeaders(headers: Record<string, string>, now = Date.now()): UsageReport | null {
	const fiveHour = parseUnifiedWindow(headers, "5h");
	const sevenDay = parseUnifiedWindow(headers, "7d");
	const limits = [
		buildUsageLimit({
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			windowId: "5h",
			windowLabel: "5 Hour",
			durationMs: FIVE_HOURS_MS,
			bucket: fiveHour,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d",
			label: "Claude 7 Day",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: SEVEN_DAYS_MS,
			bucket: sevenDay,
			provider: "anthropic",
			shared: true,
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

	const payloadResult = await fetchUsagePayload(url, headers, ctx, params.signal);
	if (!payloadResult || !isRecord(payloadResult.payload)) return null;
	const { payload, orgId } = payloadResult;

	const fiveHour = parseBucket(payload.five_hour);
	const sevenDay = parseBucket(payload.seven_day);
	const sevenDayOpus = parseBucket(payload.seven_day_opus);
	const sevenDaySonnet = parseBucket(payload.seven_day_sonnet);

	const limits = [
		buildUsageLimit({
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			windowId: "5h",
			windowLabel: "5 Hour",
			durationMs: FIVE_HOURS_MS,
			bucket: fiveHour,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d",
			label: "Claude 7 Day",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: SEVEN_DAYS_MS,
			bucket: sevenDay,
			provider: "anthropic",
			shared: true,
		}),
		buildUsageLimit({
			id: "anthropic:7d:opus",
			label: "Claude 7 Day (Opus)",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: SEVEN_DAYS_MS,
			bucket: sevenDayOpus,
			provider: "anthropic",
			tier: "opus",
		}),
		buildUsageLimit({
			id: "anthropic:7d:sonnet",
			label: "Claude 7 Day (Sonnet)",
			windowId: "7d",
			windowLabel: "7 Day",
			durationMs: SEVEN_DAYS_MS,
			bucket: sevenDaySonnet,
			provider: "anthropic",
			tier: "sonnet",
		}),
	].filter((limit): limit is UsageLimit => limit !== null);

	if (limits.length === 0) return null;
	const identity = extractUsageIdentity(payload, orgId);
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
			...(orgId ? { orgId } : {}),
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

export const claudeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const primary = report.limits.find(l => l.id === "anthropic:5h");
		const secondary = report.limits.find(l => l.id === "anthropic:7d");
		return { primary, secondary };
	},
	windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
};
