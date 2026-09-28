import { Buffer } from "node:buffer";
import { planRequirementFor, quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	PlanGate,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageResetCredits,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { normalizeCodexBaseUrl } from "./openai-codex-base-url";
import { listCodexResetCredits } from "./openai-codex-reset";
import { HOUR_MS } from "./shared";

const CODEX_USAGE_PATH = "wham/usage";
const CODEX_VERIFIED_ACCESS_PATH = "accounts/verified_access";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

interface CodexUsageWindowPayload {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface CodexUsageRateLimitPayload {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: CodexUsageWindowPayload | null;
	secondary_window?: CodexUsageWindowPayload | null;
}

interface CodexUsageAdditionalRateLimitPayload {
	limit_name?: string;
	metered_feature?: string;
	rate_limit?: CodexUsageRateLimitPayload | null;
}

interface CodexUsageCreditsPayload {
	has_credits?: boolean;
	unlimited?: boolean;
	overage_limit_reached?: boolean;
	balance?: string | number;
}

interface CodexUsageSpendControlPayload {
	reached?: boolean;
}

interface CodexUsagePayload {
	plan_type?: string;
	rate_limit?: CodexUsageRateLimitPayload | null;
	additional_rate_limits?: CodexUsageAdditionalRateLimitPayload[] | null;
	credits?: CodexUsageCreditsPayload | null;
	spend_control?: CodexUsageSpendControlPayload | null;
}

interface ParsedUsageWindow {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
}

interface ParsedAdditionalUsage {
	limitName?: string;
	meteredFeature?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: ParsedUsageWindow;
	secondary?: ParsedUsageWindow;
}

interface ParsedUsage {
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: ParsedUsageWindow;
	secondary?: ParsedUsageWindow;
	additional: ParsedAdditionalUsage[];
	/**
	 * True when the account can still serve requests on credits after its plan
	 * windows report `limit_reached`. `/wham/usage` only describes the *plan*
	 * allowance, so without this a credit-funded account looks permanently
	 * exhausted until the weekly reset while `/responses` keeps accepting it.
	 */
	creditOverage: boolean;
	raw: CodexUsagePayload;
}

interface JwtPayload {
	[JWT_AUTH_CLAIM]?: {
		chatgpt_account_id?: string;
	};
	[JWT_PROFILE_CLAIM]?: {
		email?: string;
	};
}

const toBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") return value;
	return undefined;
};

function base64UrlDecode(input: string): string {
	const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLen = (4 - (base64.length % 4)) % 4;
	const padded = base64 + "=".repeat(padLen);
	return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwt(token: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const payloadJson = base64UrlDecode(parts[1]);
		return JSON.parse(payloadJson) as JwtPayload;
	} catch {
		return null;
	}
}

function normalizeEmail(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const normalized = email.trim().toLowerCase();
	return normalized || undefined;
}

function extractAccountId(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const payload = parseJwt(token);
	return payload?.[JWT_AUTH_CLAIM]?.chatgpt_account_id ?? undefined;
}

function extractEmail(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const payload = parseJwt(token);
	return normalizeEmail(payload?.[JWT_PROFILE_CLAIM]?.email);
}

/** Whether `accounts/verified_access` grants the account cyber (Daybreak) access; `false` on any failure. */
async function fetchCodexDaybreakAccess(
	baseUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	ctx: UsageFetchContext,
): Promise<boolean> {
	try {
		const response = await ctx.fetch(`${baseUrl}/${CODEX_VERIFIED_ACCESS_PATH}`, { headers, signal });
		if (!response.ok) {
			ctx.logger?.debug("Codex verified access request failed", { status: response.status });
			return false;
		}
		return hasDaybreakAccess(await response.json());
	} catch (error) {
		ctx.logger?.debug("Codex verified access request error", { error: String(error) });
		return false;
	}
}

function hasDaybreakAccess(payload: unknown): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.programs)) return false;
	return payload.programs.some(program => {
		if (!isRecord(program) || program.program !== "cyber") return false;
		return program.state !== "inactive" || (Array.isArray(program.grants) && program.grants.length > 0);
	});
}

function parseUsageWindow(payload: unknown): ParsedUsageWindow | undefined {
	if (!isRecord(payload)) return undefined;
	const usedPercent = toNumber(payload.used_percent);
	const limitWindowSeconds = toNumber(payload.limit_window_seconds);
	const resetAfterSeconds = toNumber(payload.reset_after_seconds);
	const resetAt = toNumber(payload.reset_at);
	if (
		usedPercent === undefined &&
		limitWindowSeconds === undefined &&
		resetAfterSeconds === undefined &&
		resetAt === undefined
	) {
		return undefined;
	}
	return {
		usedPercent,
		limitWindowSeconds,
		resetAfterSeconds,
		resetAt,
	};
}

function parseAdditionalRateLimit(payload: unknown): ParsedAdditionalUsage | null {
	if (!isRecord(payload)) return null;
	const limitName = typeof payload.limit_name === "string" ? payload.limit_name : undefined;
	const meteredFeature = typeof payload.metered_feature === "string" ? payload.metered_feature : undefined;
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	if (!rateLimit) return null;
	const primary = parseUsageWindow(rateLimit.primary_window);
	const secondary = parseUsageWindow(rateLimit.secondary_window);
	const allowed = toBoolean(rateLimit.allowed);
	const limitReached = toBoolean(rateLimit.limit_reached);
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return null;
	return { limitName, meteredFeature, allowed, limitReached, primary, secondary };
}

/**
 * True when paid credits can still fund plan-window overage. Codex CLI never
 * gates on `/wham/usage`, so once the plan allowance is spent it keeps working
 * off this balance; omp must mirror that or it parks a perfectly usable account
 * until the weekly reset.
 *
 * Scoped to the plan verdict on purpose. `credits` describes the account's
 * overage funding for the plan windows, and nothing in the payload says a
 * balance covers a separate metered feature (Spark, reserve). A denial that is
 * not plan exhaustion is left alone for the same reason: credits answer
 * "allowance spent", not "request refused".
 */
function hasPlanCreditOverage(payload: Record<string, unknown>, planLimitReached: boolean | undefined): boolean {
	if (planLimitReached !== true) return false;
	const credits = isRecord(payload.credits) ? payload.credits : undefined;
	if (!credits) return false;
	if (credits.unlimited !== true && credits.has_credits !== true) return false;
	if (credits.overage_limit_reached === true) return false;
	const spendControl = isRecord(payload.spend_control) ? payload.spend_control : undefined;
	return spendControl?.reached !== true;
}

function parseUsagePayload(payload: unknown): ParsedUsage | null {
	if (!isRecord(payload)) return null;
	const planType = typeof payload.plan_type === "string" ? payload.plan_type : undefined;
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	const additionalRaw = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
	const additional = additionalRaw
		.map(parseAdditionalRateLimit)
		.filter((value): value is ParsedAdditionalUsage => value !== null);
	if (!rateLimit && additional.length === 0) return null;
	const planLimitReached = rateLimit ? toBoolean(rateLimit.limit_reached) : undefined;
	const parsed: ParsedUsage = {
		planType,
		allowed: rateLimit ? toBoolean(rateLimit.allowed) : undefined,
		limitReached: planLimitReached,
		primary: rateLimit ? parseUsageWindow(rateLimit.primary_window) : undefined,
		secondary: rateLimit ? parseUsageWindow(rateLimit.secondary_window) : undefined,
		additional,
		creditOverage: hasPlanCreditOverage(payload, planLimitReached),
		raw: payload as CodexUsagePayload,
	};
	if (
		!parsed.primary &&
		!parsed.secondary &&
		parsed.allowed === undefined &&
		parsed.limitReached === undefined &&
		parsed.additional.length === 0
	) {
		return null;
	}
	return parsed;
}

/**
 * Parse the `rate_limit_reset_credits` block from `/wham/usage`. OpenAI Codex
 * reports the count of saved rate-limit resets the account can redeem here; the
 * redeem action itself lives in `./openai-codex-reset`.
 */
function parseResetCredits(payload: unknown): UsageResetCredits | undefined {
	if (!isRecord(payload)) return undefined;
	const block = payload.rate_limit_reset_credits;
	if (!isRecord(block)) return undefined;
	const availableCount = toNumber(block.available_count);
	if (availableCount === undefined) return undefined;
	return { availableCount: Math.max(0, Math.trunc(availableCount)) };
}

function buildCodexUsageUrl(baseUrl: string): string {
	const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return `${normalized}${CODEX_USAGE_PATH}`;
}

function formatWindowLabel(value: number, unit: "hour" | "day"): string {
	const rounded = Math.round(value);
	const suffix = rounded === 1 ? unit : `${unit}s`;
	return `${rounded} ${suffix}`;
}

function buildWindowLabel(seconds: number): { id: string; label: string } {
	const daySeconds = 86_400;
	if (seconds >= daySeconds) {
		const days = Math.round(seconds / daySeconds);
		return { id: `${days}d`, label: formatWindowLabel(days, "day") };
	}
	const hours = Math.max(1, Math.round(seconds / 3600));
	return { id: `${hours}h`, label: formatWindowLabel(hours, "hour") };
}

function resolveResetTime(window: ParsedUsageWindow, nowMs: number): number | undefined {
	const resetAt = window.resetAt;
	if (resetAt !== undefined) {
		const resetAtMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
		if (Number.isFinite(resetAtMs)) return resetAtMs;
	}
	if (window.resetAfterSeconds !== undefined) {
		return nowMs + window.resetAfterSeconds * 1000;
	}
	return undefined;
}

function buildUsageWindow(window: ParsedUsageWindow, key: string, nowMs: number): UsageWindow {
	const resetsAt = resolveResetTime(window, nowMs);
	if (window.limitWindowSeconds !== undefined) {
		const { id, label } = buildWindowLabel(window.limitWindowSeconds);
		const durationMs = window.limitWindowSeconds * 1000;
		return { id, label, durationMs, ...(resetsAt !== undefined ? { resetsAt } : {}) };
	}
	const fallbackLabel = key === "primary" ? "Primary window" : "Secondary window";
	return { id: key, label: fallbackLabel, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function buildUsageAmount(window: ParsedUsageWindow): UsageAmount {
	const usedPercent = window.usedPercent;
	if (usedPercent === undefined) {
		return { unit: "percent" };
	}
	const clamped = Math.min(Math.max(usedPercent, 0), 100);
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

function buildUsageStatus(args: { usedFraction?: number; explicitlyAllowed: boolean }): UsageLimit["status"] {
	if (args.usedFraction === undefined) return "unknown";
	if (args.usedFraction >= 1) return args.explicitlyAllowed ? "warning" : "exhausted";
	if (args.usedFraction >= 0.9) return "warning";
	return "ok";
}

/**
 * Whether Codex will still serve this meter: an explicit positive verdict, or
 * credits covering overage of a spent plan window. The credit override needs
 * `limitReached === true`; a refusal for any other reason is not something a
 * balance can pay for.
 */
function isCodexRequestAllowed(args: { allowed?: boolean; limitReached?: boolean; creditOverage?: boolean }): boolean {
	if (args.creditOverage === true && args.limitReached === true) return true;
	return args.allowed === true && args.limitReached === false;
}

function buildUsageLimit(args: {
	key: "primary" | "secondary";
	window: ParsedUsageWindow;
	accountId?: string;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	creditOverage?: boolean;
	nowMs: number;
}): UsageLimit {
	const usageWindow = buildUsageWindow(args.window, args.key, args.nowMs);
	const amount = buildUsageAmount(args.window);
	return {
		id: `openai-codex:${args.key}`,
		label: usageWindow.label,
		scope: {
			provider: "openai-codex",
			windowId: usageWindow.id,
			shared: true,
		},
		window: usageWindow,
		amount,
		// The shared account-level rejection flag cannot identify which window
		// is binding, but an explicit positive verdict applies to both windows.
		// Preserve 100% as a warning when Codex still allows requests — either
		// explicitly, or because credits fund overage past the plan window.
		// Live usage_limit_reached responses remain authoritative for blocking.
		status: buildUsageStatus({
			usedFraction: amount.usedFraction,
			explicitlyAllowed: isCodexRequestAllowed(args),
		}),
	};
}
function additionalLimitSlug(args: { limitName?: string; meteredFeature?: string }): string {
	const probe = `${args.limitName ?? ""} ${args.meteredFeature ?? ""}`.toLowerCase();
	if (probe.includes("spark") || probe.includes("bengalfox")) return "spark";
	const source = (args.meteredFeature ?? args.limitName ?? "extra").toLowerCase();
	return (
		source
			.replace(/^codex[-_]/, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "extra"
	);
}

function additionalDisplayName(slug: string, limitName?: string): string {
	if (slug === "spark") return "Spark";
	if (limitName) return limitName;
	return slug.replace(
		/(^|-)([a-z])/g,
		(_match, sep: string, ch: string) => `${sep === "-" ? " " : ""}${ch.toUpperCase()}`,
	);
}

function buildAdditionalUsageLimit(args: {
	key: "primary" | "secondary";
	slug: string;
	displayName: string;
	window: ParsedUsageWindow;
	accountId?: string;
	limitName?: string;
	meteredFeature?: string;
	allowed?: boolean;
	limitReached?: boolean;
	nowMs: number;
}): UsageLimit {
	const usageWindow = buildUsageWindow(args.window, args.key, args.nowMs);
	const amount = buildUsageAmount(args.window);
	return {
		id: `openai-codex:${args.slug}:${args.key}`,
		label: `${usageWindow.label} (${args.displayName})`,
		scope: {
			provider: "openai-codex",
			accountId: args.accountId,
			tier: args.slug,
			modelId: args.limitName,
			windowId: usageWindow.id,
			shared: true,
		},
		window: usageWindow,
		amount,
		// A positive meter verdict is authoritative even when the advisory
		// percentage rounds to 100; negative shared verdicts remain window-local.
		// Plan credits are deliberately not passed here: this meter is a separate
		// allowance, and nothing in the payload says a balance funds its overage.
		status: buildUsageStatus({
			usedFraction: amount.usedFraction,
			explicitlyAllowed: isCodexRequestAllowed(args),
		}),
	};
}

/**
 * Parse Codex `x-codex-{primary,secondary}-*` rate-limit response headers into
 * a usage report. The backend attaches these snapshots to every response, so
 * ingesting them lets credential selection block an exhausted account before
 * the next request burns a wire 429.
 */
export function parseCodexRateLimitHeaders(
	headers: Record<string, string>,
	now = Date.now(),
	context?: { responseStatus?: number },
): UsageReport | null {
	const parseWindow = (key: "primary" | "secondary"): ParsedUsageWindow | undefined => {
		const usedPercent = toNumber(headers[`x-codex-${key}-used-percent`]);
		if (usedPercent === undefined) return undefined;
		const windowMinutes = toNumber(headers[`x-codex-${key}-window-minutes`]);
		const resetAt = toNumber(headers[`x-codex-${key}-reset-at`]);
		return {
			usedPercent,
			limitWindowSeconds: windowMinutes === undefined ? undefined : windowMinutes * 60,
			resetAt,
		};
	};
	const primary = parseWindow("primary");
	const secondary = parseWindow("secondary");
	if (!primary && !secondary) return null;
	const limits: UsageLimit[] = [];
	const requestSucceeded =
		context?.responseStatus !== undefined && context.responseStatus >= 200 && context.responseStatus < 300;
	const verdict = requestSucceeded ? { allowed: true, limitReached: false } : {};
	if (primary) limits.push(buildUsageLimit({ key: "primary", window: primary, ...verdict, nowMs: now }));
	if (secondary) limits.push(buildUsageLimit({ key: "secondary", window: secondary, ...verdict, nowMs: now }));
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits,
		metadata: { source: "ratelimit-headers" },
	};
}

/**
 * Plan meter verdict as credential selection should see it. Credits funding
 * overage flip a plan-level rejection back to serving, which is what lets a
 * stale usage-limit block self-heal instead of parking the account until reset.
 * Only the plan meter takes this override — {@link hasPlanCreditOverage}.
 */
function buildPlanMeterState(
	allowed: boolean | undefined,
	limitReached: boolean | undefined,
	creditOverage: boolean,
): { allowed?: boolean; limitReached?: boolean } {
	if (!creditOverage) return { allowed, limitReached };
	return { allowed: true, limitReached: false };
}

export const openaiCodexUsageProvider: UsageProvider = {
	id: "openai-codex",
	supports(params: UsageFetchParams): boolean {
		return params.provider === "openai-codex" && params.credential.type === "oauth";
	},
	parseRateLimitHeaders: parseCodexRateLimitHeaders,
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "openai-codex") return null;
		const { credential } = params;
		if (credential.type !== "oauth") return null;

		const accessToken = credential.accessToken;
		if (!accessToken) return null;

		const nowMs = Date.now();
		if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
			ctx.logger?.warn("Codex usage token expired", { provider: params.provider });
			return null;
		}

		const baseUrl = normalizeCodexBaseUrl(params.baseUrl);
		const accountId = credential.accountId ?? extractAccountId(accessToken);
		const email = normalizeEmail(credential.email ?? extractEmail(accessToken));

		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": USER_AGENT,
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}

		// Runs in parallel with the usage request; never rejects, so a failing
		// entitlement lookup only omits the badge.
		const daybreakAccess = fetchCodexDaybreakAccess(baseUrl, headers, params.signal, ctx);
		const url = buildCodexUsageUrl(baseUrl);
		let payload: unknown;
		try {
			const response = await ctx.fetch(url, { headers, signal: params.signal });
			if (!response.ok) {
				ctx.logger?.warn("Codex usage request failed", { status: response.status, provider: params.provider });
				return null;
			}
			payload = await response.json();
		} catch (error) {
			ctx.logger?.warn("Codex usage request error", { provider: params.provider, error: String(error) });
			return null;
		}

		const parsed = parseUsagePayload(payload);
		const planType =
			parsed?.planType ??
			(isRecord(payload) && typeof payload.plan_type === "string" ? payload.plan_type : undefined);

		const creditOverage = parsed?.creditOverage === true;
		const limits: UsageLimit[] = [];
		const meterStates: Record<string, { allowed?: boolean; limitReached?: boolean }> = {
			chat: buildPlanMeterState(parsed?.allowed, parsed?.limitReached, creditOverage),
		};
		if (parsed?.primary) {
			limits.push(
				buildUsageLimit({
					key: "primary",
					window: parsed.primary,
					accountId,
					planType,
					allowed: parsed.allowed,
					limitReached: parsed.limitReached,
					creditOverage,
					nowMs,
				}),
			);
		}
		if (parsed?.secondary) {
			limits.push(
				buildUsageLimit({
					key: "secondary",
					window: parsed.secondary,
					accountId,
					planType,
					allowed: parsed.allowed,
					limitReached: parsed.limitReached,
					creditOverage,
					nowMs,
				}),
			);
		}
		for (const extra of parsed?.additional ?? []) {
			const slug = additionalLimitSlug({ limitName: extra.limitName, meteredFeature: extra.meteredFeature });
			const displayName = additionalDisplayName(slug, extra.limitName);
			meterStates[slug] = { allowed: extra.allowed, limitReached: extra.limitReached };
			if (extra.primary) {
				limits.push(
					buildAdditionalUsageLimit({
						key: "primary",
						slug,
						displayName,
						window: extra.primary,
						accountId,
						limitName: extra.limitName,
						meteredFeature: extra.meteredFeature,
						allowed: extra.allowed,
						limitReached: extra.limitReached,
						nowMs,
					}),
				);
			}
			if (extra.secondary) {
				limits.push(
					buildAdditionalUsageLimit({
						key: "secondary",
						slug,
						displayName,
						window: extra.secondary,
						accountId,
						limitName: extra.limitName,
						meteredFeature: extra.meteredFeature,
						allowed: extra.allowed,
						limitReached: extra.limitReached,
						nowMs,
					}),
				);
			}
		}

		const resetCredits = parseResetCredits(payload);
		if (resetCredits && resetCredits.availableCount > 0) {
			try {
				const list = await listCodexResetCredits({
					accessToken,
					accountId,
					baseUrl: params.baseUrl,
					fetch: ctx.fetch,
					signal: params.signal,
				});
				if (list?.credits.length) {
					resetCredits.credits = list.credits
						.filter(c => (c.status ?? "available") === "available")
						.map(c => ({
							grantedAt: c.grantedAt,
							expiresAt: c.expiresAt,
							status: c.status,
						}));
				}
				// Always sync the live count from the detail endpoint — it may report
				// fewer or zero available credits after expiry/redeem, even when the
				// /wham/usage payload still has a stale count.
				if (list) {
					resetCredits.availableCount = list.availableCount;
				}
			} catch (error) {
				ctx.logger?.warn("Codex reset credits detail fetch failed", { error: String(error) });
			}
		}
		const daybreak = await daybreakAccess;
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: nowMs,
			limits,
			...(resetCredits ? { resetCredits } : {}),
			metadata: {
				planType,
				...buildPlanMeterState(parsed?.allowed, parsed?.limitReached, creditOverage),
				email,
				accountId,
				meterStates,
				...(daybreak ? { daybreak: true } : {}),
			},
			raw: parsed?.raw ?? payload,
		};

		return report;
	},
};

/** Codex account tier required for the selected model. */
type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
	plus: true,
	business: true,
	team: true,
	enterprise: true,
	edu: true,
	education: true,
	teacher: true,
	teachers: true,
	health: true,
	gov: true,
	government: true,
};
const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

/**
 * Account tier needed for model-aware Codex OAuth routing.
 *
 * GPT-5.6 Terra (including its local pro-mode alias) remains available on every
 * plan. Sol and Luna pro-mode aliases inherit their base models' paid tier;
 * only Spark currently has a documented Pro-plan preference in Codex.
 */
function resolveOpenAICodexPlanRequirement(modelId: string | undefined): OpenAICodexPlanRequirement {
	if (typeof modelId !== "string") return "none";
	const requirement = planRequirementFor("openai-codex", modelId);
	return requirement === "paid" || requirement === "pro" ? requirement : "none";
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata) return undefined;
	const planType = metadata.planType;
	if (typeof planType !== "string") return undefined;
	const normalized = planType
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
	const planType = getUsagePlanType(report);
	if (!planType) return "unknown";
	// Pro Lite is a paid Codex tier, but does not imply full Pro-only model access.
	if (planType === "prolite" || planType === "pro_lite") return "paid";
	const tokens = planType.split("_");
	if (tokens.some(token => OPENAI_CODEX_PRO_PLAN_TOKENS[token] === true)) return "pro";
	if (tokens.some(token => OPENAI_CODEX_PAID_PLAN_TOKENS[token] === true)) return "paid";
	if (tokens.some(token => OPENAI_CODEX_FREE_PLAN_TOKENS[token] === true)) return "free";
	return "unknown";
}

/** Check whether a Codex account report meets the model tier. */
function codexPlanGate(requirement: Exclude<OpenAICodexPlanRequirement, "none">): PlanGate {
	return report => {
		const planClass = classifyOpenAICodexPlan(report);
		if (planClass === "unknown") return undefined;
		return requirement === "paid" ? planClass !== "free" : planClass === "pro";
	};
}

// A Codex request gates only on the chat windows it actually consumes. A
// "-spark" model spends the separate Spark meter; every other Codex model spends
// the 5h/weekly chat windows. Scoping the gating set this way keeps an exhausted
// Spark meter from blocking a normal chat request (and vice versa), instead of
// OR-ing every window and meter in the report into one provider-wide block.
function scopeCodexLimitsForRequest(report: UsageReport, isSparkRequest: boolean): UsageLimit[] {
	return report.limits.filter(limit => {
		if (limit.id === "openai-codex:primary" || limit.id === "openai-codex:secondary") {
			return !isSparkRequest;
		}
		// Additional metered features have ids of the form `openai-codex:<slug>:<key>`.
		const slug = limit.id.split(":")[1];
		return slug === "spark" ? isSparkRequest : false;
	});
}

/** True when the requested model spends the separate Spark meter. */
function isCodexSparkRequest(context?: CredentialRankingContext): boolean {
	return context?.modelId !== undefined && quotaTierFor("openai-codex", context.modelId) === "spark";
}

export const codexRankingStrategy: CredentialRankingStrategy = {
	planGate(context) {
		const requirement = resolveOpenAICodexPlanRequirement(context.modelId);
		return requirement === "none" ? undefined : codexPlanGate(requirement);
	},
	scopeLimits(report, context) {
		return scopeCodexLimitsForRequest(report, isCodexSparkRequest(context));
	},
	// A `usage_limit_reached` from a Spark request means the Spark meter is
	// spent, not the chat windows, so the two back off under separate scopes;
	// one shared block would let an exhausted Spark meter stop ordinary chat
	// requests, and the reverse.
	blockScope(context) {
		return isCodexSparkRequest(context) ? "spark" : "chat";
	},
	// "shared" is the scope earlier versions persisted under, and it meant "block
	// everything", so it stays honoured by every request and healed by
	// reconciliation. Without a context (reconciliation) this is the full set.
	blockScopes(context) {
		if (!context) return ["chat", "spark", "shared"];
		return [isCodexSparkRequest(context) ? "spark" : "chat", "shared"];
	},
	// Heal each scope against its own meter, including the legacy shared block.
	// Missing Spark metadata cannot establish recovery even if its limits are empty.
	healableBlockScopes(report) {
		const metadata = report.metadata;
		const meterStates = metadata?.meterStates;
		const spark = isRecord(meterStates) && isRecord(meterStates.spark) ? meterStates.spark : undefined;
		return [
			{
				blockScope: "chat",
				limits: scopeCodexLimitsForRequest(report, false),
				healthy: metadata?.allowed === true && metadata.limitReached === false,
			},
			{
				blockScope: "spark",
				limits: scopeCodexLimitsForRequest(report, true),
				healthy: spark?.allowed === true && spark.limitReached === false,
			},
			{
				blockScope: "shared",
				limits: report.limits,
				healthy: metadata?.allowed === true && metadata.limitReached === false,
			},
		];
	},
	findWindowLimits(report, context) {
		const limits = scopeCodexLimitsForRequest(report, isCodexSparkRequest(context));
		const findLimit = (key: "primary" | "secondary"): UsageLimit | undefined => {
			const direct = limits.find(l => l.id === `openai-codex:${key}`);
			if (direct) return direct;
			const byId = limits.find(l => l.id.toLowerCase().includes(key));
			if (byId) return byId;
			const windowId = key === "secondary" ? "7d" : "1h";
			return limits.find(l => l.scope.windowId?.toLowerCase() === windowId);
		};
		return { primary: findLimit("primary"), secondary: findLimit("secondary") };
	},
	windowDefaults: { primaryMs: 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
	hasPriorityBoost(primary, primaryUncapped = false, context) {
		// Chat plans can omit an uncapped primary window while retaining their
		// weekly window. Spark always has a capped primary meter, so a missing
		// Spark primary is incomplete rather than uncapped.
		if (!primary) return primaryUncapped && !isCodexSparkRequest(context);
		const windowId = primary.scope.windowId?.toLowerCase();
		const durationMs = primary.window?.durationMs;
		const isFiveHourWindow =
			windowId === "5h" ||
			(typeof durationMs === "number" &&
				Number.isFinite(durationMs) &&
				Math.abs(durationMs - 5 * HOUR_MS) <= 60_000);
		if (!isFiveHourWindow) return false;
		const usedFraction = primary.amount.usedFraction;
		return typeof usedFraction === "number" && Number.isFinite(usedFraction) && usedFraction === 0;
	},
};
