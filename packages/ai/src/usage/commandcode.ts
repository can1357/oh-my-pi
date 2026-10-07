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
import { usageStatus } from "../usage";
import { HOUR_MS, parsePositiveTimestamp, WEEK_MS } from "./shared";

const PROVIDER = "commandcode";
const DEFAULT_ORIGIN = "https://api.commandcode.ai";
// The CLI also sends `?limits=1` for its org spend-limit panel; omp reads no
// field from that, so the plain identity route is enough.
const WHOAMI_PATH = "/alpha/whoami";
const CREDITS_PATH = "/alpha/billing/credits";

/**
 * Command Code's inference base carries `/provider` or `/provider/v1`, while the
 * account routes sit at the host root, so only the configured origin is kept.
 * A blank or unparseable override means "not configured".
 */
function resolveOrigin(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_ORIGIN;
	try {
		return new URL(trimmed).origin;
	} catch {
		return DEFAULT_ORIGIN;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns the unwrapped JSON body, or `null` for any failure that should read
 * as "no data", 403 included. Only a 401 throws, so a revoked key purges the
 * cached report instead of re-serving it.
 */
async function getJson(
	url: string,
	apiKey: string,
	signal: AbortSignal | undefined,
	ctx: UsageFetchContext,
): Promise<Record<string, unknown> | null> {
	try {
		const response = await ctx.fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			if (response.status === 401) {
				throw new ProviderHttpError(
					`Command Code usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Command Code usage fetch failed", {
				url,
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		const json: unknown = await response.json();
		if (!isRecord(json)) return null;
		return isRecord(json.data) ? json.data : json;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code usage fetch error", { url, error: String(error) });
		return null;
	}
}

interface WindowSpec {
	key: "fiveHour" | "weekly";
	id: "5h" | "7d";
	limitLabel: string;
	windowLabel: string;
	durationMs: number;
}

const WINDOWS: readonly WindowSpec[] = [
	{ key: "fiveHour", id: "5h", limitLabel: "5-hour limit", windowLabel: "5-hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", id: "7d", limitLabel: "Weekly limit", windowLabel: "Weekly", durationMs: WEEK_MS },
];

function buildWindowLimit(
	spec: WindowSpec,
	raw: unknown,
	accountId: string,
	orgId: string | undefined,
): UsageLimit | undefined {
	if (!isRecord(raw)) return undefined;
	const used = finiteNumber(raw.used);
	if (used === undefined) return undefined;
	const cap = finiteNumber(raw.cap);
	const usedFraction = cap !== undefined && cap > 0 ? used / cap : undefined;
	const resetsAt = parsePositiveTimestamp(raw.resetAt);
	// Absent fields are omitted, not set to `undefined`: the usage wire schema
	// rejects an explicit `undefined` for an optional key.
	return {
		id: `${PROVIDER}:${spec.id}`,
		label: spec.limitLabel,
		scope: { provider: PROVIDER, accountId, ...(orgId ? { orgId } : {}), windowId: spec.id, shared: true },
		window: {
			id: spec.id,
			label: spec.windowLabel,
			durationMs: spec.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			...(cap !== undefined ? { limit: cap } : {}),
			...(usedFraction !== undefined ? { usedFraction } : {}),
			unit: "credits",
		},
		status: raw.exceeded === true ? "exhausted" : usageStatus(usedFraction),
	};
}

/**
 * Reads the account routes that the Command Code CLI calls with the same API
 * key; the Provider API documents no usage endpoint. Pay-as-you-go accounts
 * carry no `windowLimits`, so they report only the credit balance. Credits
 * are queried per org, as the CLI does, so each limit records the org that
 * owns the pool alongside the user.
 */
async function fetchCommandCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	if (params.credential.type !== "api_key" || !params.credential.apiKey) return null;
	const origin = resolveOrigin(params.baseUrl);

	const whoami = await getJson(`${origin}${WHOAMI_PATH}`, params.credential.apiKey, params.signal, ctx);
	if (!whoami) return null;
	const user = isRecord(whoami.user) ? whoami.user : undefined;
	const org = isRecord(whoami.org) ? whoami.org : undefined;
	const userId = nonEmptyString(user?.id);
	if (!userId) return null;
	const orgId = nonEmptyString(org?.id);
	const orgLogin = nonEmptyString(org?.login);

	const creditsUrl = `${origin}${CREDITS_PATH}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`;
	const creditsBody = await getJson(creditsUrl, params.credential.apiKey, params.signal, ctx);
	if (!creditsBody) return null;
	const credits = isRecord(creditsBody.credits) ? creditsBody.credits : undefined;
	if (!credits) return null;
	const monthly = finiteNumber(credits.monthlyCredits);
	const purchased = finiteNumber(credits.purchasedCredits);
	const free = finiteNumber(credits.freeCredits);
	if (monthly === undefined && purchased === undefined && free === undefined) return null;

	const limits: UsageLimit[] = [];
	const windowLimits = isRecord(creditsBody.windowLimits) ? creditsBody.windowLimits : undefined;
	for (const spec of WINDOWS) {
		const limit = buildWindowLimit(spec, windowLimits?.[spec.key], userId, orgId);
		if (limit) limits.push(limit);
	}
	limits.push({
		id: `${PROVIDER}:balance`,
		label: "Credit balance",
		scope: { provider: PROVIDER, accountId: userId, ...(orgId ? { orgId } : {}), windowId: "balance", shared: true },
		amount: { remaining: (monthly ?? 0) + (purchased ?? 0) + (free ?? 0), unit: "credits" },
	});

	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			accountId: userId,
			email: nonEmptyString(user?.email),
			orgId,
			orgName: orgLogin,
			planType: nonEmptyString(credits.planId),
		},
		raw: { whoami, credits: creditsBody },
	};
}

export const commandCodeUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/** Ranks Command Code accounts by the 5-hour and weekly credit windows. */
export const commandCodeRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.window?.id === "5h"),
		secondary: report.limits.find(limit => limit.window?.id === "7d"),
	}),
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
