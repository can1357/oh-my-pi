import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, parseIsoTimestamp, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const COMMANDCODE_PROVIDER = "commandcode";
const DEFAULT_ENDPOINT = "https://api.commandcode.ai";
const WHOAMI_PATH = "/alpha/whoami";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBSCRIPTIONS_PATH = "/alpha/billing/subscriptions";
const SUMMARY_PATH = "/alpha/usage/summary";

function normalizeCommandCodeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	try {
		// The catalog discovery base is `${origin}/provider` (optionally with
		// `/v1`); usage lives at `${origin}/alpha/*`, so only the origin survives.
		return new URL(baseUrl.trim()).origin;
	} catch {
		return DEFAULT_ENDPOINT;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Unwrap a `{ data: ... }` envelope; tolerates a top-level payload. */
function unwrapData(payload: unknown): unknown {
	if (isRecord(payload) && payload.data !== undefined) return payload.data;
	return payload;
}

/** Unwrap `{ data: ... }`, tolerating a single-element list envelope. */
function firstNode(payload: unknown): unknown {
	const node = unwrapData(payload);
	return Array.isArray(node) ? node[0] : node;
}

interface CommandCodeIdentity {
	orgId?: string;
	login?: string;
	keyName?: string;
}

function parseWhoami(payload: unknown): CommandCodeIdentity {
	const root = unwrapData(payload);
	if (!isRecord(root)) return {};
	const org = isRecord(root.org) ? root.org : undefined;
	const user = isRecord(root.user) ? root.user : undefined;
	const rawOrgId = org?.id;
	const orgId =
		nonEmptyString(rawOrgId) ??
		(typeof rawOrgId === "number" && Number.isFinite(rawOrgId) ? String(rawOrgId) : undefined);
	const login =
		nonEmptyString(org?.login) ?? nonEmptyString(user?.userName) ?? nonEmptyString(user?.name);
	const keyName = nonEmptyString(user?.keyName) ?? nonEmptyString(user?.displayName);
	return {
		...(orgId ? { orgId } : {}),
		...(login ? { login } : {}),
		...(keyName ? { keyName } : {}),
	};
}

interface CommandCodeWindowState {
	used?: number;
	cap?: number;
	resetsAt?: number;
}

function parseWindowState(value: unknown): CommandCodeWindowState | null {
	if (!isRecord(value)) return null;
	const used = toNumber(value.used);
	const cap = toNumber(value.cap);
	// An untouched window reports 0/0 (or omits both); surfacing it would read
	// as an exhausted quota, so skip it.
	if (!used && !cap) return null;
	const resetsAt = parsePositiveTimestamp(value.resetAt);
	return {
		...(used !== undefined ? { used } : {}),
		...(cap !== undefined ? { cap } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

interface CommandCodeCredits {
	remainingCredits?: number;
	fiveHour?: CommandCodeWindowState;
	weekly?: CommandCodeWindowState;
}

function parseCredits(payload: unknown): CommandCodeCredits {
	const root = unwrapData(payload);
	if (!isRecord(root)) return {};
	const credits = isRecord(root.credits) ? root.credits : undefined;
	const parts = [
		toNumber(credits?.monthlyCredits),
		toNumber(credits?.purchasedCredits),
		toNumber(credits?.freeCredits),
	].filter((value): value is number => value !== undefined);
	const windowLimits = isRecord(root.windowLimits) ? root.windowLimits : undefined;
	const fiveHour = parseWindowState(windowLimits?.fiveHour);
	const weekly = parseWindowState(windowLimits?.weekly);
	return {
		...(parts.length > 0 ? { remainingCredits: parts.reduce((total, part) => total + part, 0) } : {}),
		...(fiveHour ? { fiveHour } : {}),
		...(weekly ? { weekly } : {}),
	};
}

interface CommandCodeSubscription {
	planId?: string;
	status?: string;
	/** Raw period start, passed through as the usage-summary `since` cursor. */
	startRaw?: string;
	startMs?: number;
	endMs?: number;
}

function parsePeriodTimestamp(value: unknown): number | undefined {
	return parsePositiveTimestamp(value) ?? parseIsoTimestamp(value);
}

function parseSubscription(payload: unknown): CommandCodeSubscription {
	const node = firstNode(payload);
	if (!isRecord(node)) return {};
	const planId = nonEmptyString(node.planId);
	const status = nonEmptyString(node.status);
	const rawStart = node.currentPeriodStart;
	const startRaw =
		typeof rawStart === "string" && rawStart
			? rawStart
			: typeof rawStart === "number" && Number.isFinite(rawStart)
				? String(rawStart)
				: undefined;
	const startMs = parsePeriodTimestamp(node.currentPeriodStart);
	const endMs = parsePeriodTimestamp(node.currentPeriodEnd);
	return {
		...(planId ? { planId } : {}),
		...(status ? { status } : {}),
		...(startRaw ? { startRaw } : {}),
		...(startMs !== undefined ? { startMs } : {}),
		...(endMs !== undefined ? { endMs } : {}),
	};
}

interface CommandCodeSummary {
	totalCost?: number;
	totalCount?: number;
	totalTokens?: number;
}

function parseSummary(payload: unknown): CommandCodeSummary {
	const node = firstNode(payload);
	if (!isRecord(node)) return {};
	const totalCost = toNumber(node.totalCost);
	const totalCount = toNumber(node.totalCount);
	const totalTokens = toNumber(node.totalTokens) ?? toNumber(node.tokens);
	return {
		...(totalCost !== undefined ? { totalCost } : {}),
		...(totalCount !== undefined ? { totalCount } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
	};
}

function buildCreditWindowLimit(args: {
	provider: UsageFetchParams["provider"];
	id: string;
	label: string;
	windowId: string;
	durationMs: number;
	state: CommandCodeWindowState;
}): UsageLimit {
	const { used, cap, resetsAt } = args.state;
	const remaining = used !== undefined && cap !== undefined ? cap - used : undefined;
	const usedFraction =
		used !== undefined && cap !== undefined && cap > 0 ? Math.min(used / cap, 1) : undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		id: args.id,
		label: args.label,
		scope: { provider: args.provider, windowId: args.windowId, shared: true },
		window: {
			id: args.windowId,
			label: args.windowId,
			durationMs: args.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			...(used !== undefined ? { used } : {}),
			...(cap !== undefined ? { limit: cap } : {}),
			...(remaining !== undefined ? { remaining } : {}),
			...(usedFraction !== undefined ? { usedFraction } : {}),
			...(remainingFraction !== undefined ? { remainingFraction } : {}),
			unit: "credits",
		},
		status: usageStatus(usedFraction),
	};
}

function buildRemainingLimit(args: {
	provider: UsageFetchParams["provider"];
	remainingCredits: number;
	totalCost?: number;
	periodStartMs?: number;
	periodEndMs?: number;
}): UsageLimit {
	const used = args.totalCost;
	const limit = used !== undefined ? args.remainingCredits + used : undefined;
	const usedFraction =
		used !== undefined && limit !== undefined && limit > 0 ? Math.min(used / limit, 1) : undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	const durationMs =
		args.periodStartMs !== undefined &&
		args.periodEndMs !== undefined &&
		args.periodEndMs > args.periodStartMs
			? args.periodEndMs - args.periodStartMs
			: undefined;
	return {
		id: "commandcode:credits:remaining",
		label: "Command Code Credits",
		scope: {
			provider: args.provider,
			shared: true,
			...(args.periodEndMs !== undefined ? { windowId: "billing-period" } : {}),
		},
		...(args.periodEndMs !== undefined
			? {
					window: {
						id: "billing-period",
						label: "Billing period",
						...(durationMs !== undefined ? { durationMs } : {}),
						resetsAt: args.periodEndMs,
					},
				}
			: {}),
		amount: {
			...(used !== undefined ? { used } : {}),
			...(limit !== undefined ? { limit } : {}),
			remaining: args.remainingCredits,
			...(usedFraction !== undefined ? { usedFraction } : {}),
			...(remainingFraction !== undefined ? { remainingFraction } : {}),
			// The credits balance is dollar-denominated, so the pool meters spend in USD.
			unit: "usd",
		},
		status: usageStatus(usedFraction),
	};
}

function authError(label: string, response: Response): ProviderHttpError {
	return new ProviderHttpError(
		`Command Code ${label} endpoint returned ${response.status} ${response.statusText}`.trim(),
		response.status,
	);
}

async function fetchOptionalPayload(
	url: string,
	label: string,
	headers: Record<string, string>,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<unknown> {
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			// Auth failures are fatal even on optional endpoints: a rotated key
			// must surface as bad credentials, not as silently missing quotas.
			if (response.status === 401 || response.status === 403) throw authError(label, response);
			ctx.logger?.warn(`Command Code ${label} fetch failed`, {
				status: response.status,
				statusText: response.statusText,
			});
			return undefined;
		}
		return (await response.json()) as unknown;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn(`Command Code ${label} fetch error`, { error: String(error) });
		return undefined;
	}
}

async function fetchCommandCodeUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== COMMANDCODE_PROVIDER) return null;
	const credential = params.credential;
	const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
	if (!token) return null;

	const origin = normalizeCommandCodeBaseUrl(params.baseUrl);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		accept: "application/json",
	};

	let whoamiPayload: unknown;
	try {
		const response = await ctx.fetch(`${origin}${WHOAMI_PATH}`, { headers, signal: params.signal });
		if (!response.ok) {
			// Auth failures must throw so checkCredentials flags the bad key as
			// ok:false rather than ok:null (unknown). Other non-ok statuses are
			// transient — return null so the probe reports "no data".
			if (response.status === 401 || response.status === 403) throw authError("whoami", response);
			ctx.logger?.warn("Command Code whoami fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		whoamiPayload = (await response.json()) as unknown;
	} catch (error) {
		// Re-throw auth errors so the credential-health probe can surface them.
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code whoami fetch error", { error: String(error) });
		return null;
	}

	const identity = parseWhoami(whoamiPayload);

	const withQuery = (path: string, extra?: Record<string, string | undefined>): string => {
		const search = new URLSearchParams();
		if (identity.orgId) search.set("orgId", identity.orgId);
		for (const [key, value] of Object.entries(extra ?? {})) {
			if (value) search.set(key, value);
		}
		const query = search.toString();
		return `${origin}${path}${query ? `?${query}` : ""}`;
	};

	const creditsPayload = await fetchOptionalPayload(
		withQuery(CREDITS_PATH),
		"credits",
		headers,
		params,
		ctx,
	);
	const subscriptionsPayload = await fetchOptionalPayload(
		withQuery(SUBSCRIPTIONS_PATH),
		"subscriptions",
		headers,
		params,
		ctx,
	);

	const credits: CommandCodeCredits =
		creditsPayload === undefined ? {} : parseCredits(creditsPayload);
	const subscription: CommandCodeSubscription =
		subscriptionsPayload === undefined ? {} : parseSubscription(subscriptionsPayload);

	// Spend should cover the current billing period when the subscription tells
	// us where it started; otherwise fall back to trailing 30 days.
	const since = subscription.startRaw ?? new Date(Date.now() - 30 * DAY_MS).toISOString();
	const summaryPayload = await fetchOptionalPayload(
		withQuery(SUMMARY_PATH, { since }),
		"usage summary",
		headers,
		params,
		ctx,
	);
	const summary: CommandCodeSummary =
		summaryPayload === undefined ? {} : parseSummary(summaryPayload);

	const limits: UsageLimit[] = [];
	if (credits.fiveHour) {
		limits.push(
			buildCreditWindowLimit({
				provider: params.provider,
				id: "commandcode:credits:5h",
				label: "Command Code 5h Credit Quota",
				windowId: "5h",
				durationMs: 5 * HOUR_MS,
				state: credits.fiveHour,
			}),
		);
	}
	if (credits.weekly) {
		limits.push(
			buildCreditWindowLimit({
				provider: params.provider,
				id: "commandcode:credits:7d",
				label: "Command Code Weekly Credit Quota",
				windowId: "7d",
				durationMs: WEEK_MS,
				state: credits.weekly,
			}),
		);
	}
	if (credits.remainingCredits !== undefined) {
		limits.push(
			buildRemainingLimit({
				provider: params.provider,
				remainingCredits: credits.remainingCredits,
				...(summary.totalCost !== undefined ? { totalCost: summary.totalCost } : {}),
				...(subscription.startMs !== undefined ? { periodStartMs: subscription.startMs } : {}),
				...(subscription.endMs !== undefined ? { periodEndMs: subscription.endMs } : {}),
			}),
		);
	}

	if (limits.length === 0) return null;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: origin,
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.email ? { email: credential.email } : {}),
			...(identity.login ? { login: identity.login } : {}),
			...(identity.orgId ? { orgId: identity.orgId } : {}),
			...(identity.keyName ? { keyName: identity.keyName } : {}),
			...(subscription.planId ? { planType: subscription.planId } : {}),
		},
		raw: {
			whoami: whoamiPayload,
			...(creditsPayload !== undefined ? { credits: creditsPayload } : {}),
			...(subscriptionsPayload !== undefined ? { subscriptions: subscriptionsPayload } : {}),
			...(summaryPayload !== undefined ? { summary: summaryPayload } : {}),
		},
	};
}

function commandCodeCreditLimits(report: UsageReport): UsageLimit[] {
	return report.limits.filter(limit => limit.id.startsWith("commandcode:credits:"));
}

export const commandcodeUsageProvider: UsageProvider = {
	id: COMMANDCODE_PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params =>
		params.provider === COMMANDCODE_PROVIDER &&
		(params.credential.type === "oauth"
			? Boolean(params.credential.accessToken)
			: Boolean(params.credential.apiKey)),
	validatesCredentials: true,
};

export const commandcodeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const windows = commandCodeCreditLimits(report);
		return {
			primary: windows.find(limit => limit.id === "commandcode:credits:5h"),
			secondary: windows.find(limit => limit.id === "commandcode:credits:7d"),
		};
	},
	scopeLimits(report) {
		return commandCodeCreditLimits(report);
	},
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
