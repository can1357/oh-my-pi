import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport, UsageUnit } from "../usage";
import { isRecord } from "../utils";

const AIAND_PROVIDER = "aiand";
const DEFAULT_ENDPOINT = "https://api.aiand.com";
const BALANCE_PATH = "/billing/balance";
const SUMMARY_PATH = "/analytics/summary";
const SUMMARY_RANGE = "24h";

/**
 * ai&'s management endpoints (`/billing`, `/analytics`) live at the site root,
 * while the inference base URL is mounted under `/v1`. Strip a trailing `/v1`
 * so the usage paths resolve on the root, preserving any path-mounted gateway
 * prefix (`https://gateway.example/team/aiand/v1` → `…/team/aiand`).
 */
function normalizeBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	const withoutTrailingSlash = baseUrl.trim().replace(/\/+$/, "");
	return withoutTrailingSlash.replace(/\/v1$/i, "") || DEFAULT_ENDPOINT;
}

type FetchOutcome =
	| { kind: "ok"; payload: unknown }
	| { kind: "http"; status: number; statusText: string }
	| { kind: "network"; error: unknown };

async function fetchJson(
	ctx: UsageFetchContext,
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
	try {
		const response = await ctx.fetch(url, { headers, signal });
		if (!response.ok) return { kind: "http", status: response.status, statusText: response.statusText };
		return { kind: "ok", payload: (await response.json()) as unknown };
	} catch (error) {
		return { kind: "network", error };
	}
}

/** `GET /billing/balance` → `{ balance: "42.75000000", currency: "usd" }`. */
function parseBalance(payload: unknown): { balance: number; currency: string } | undefined {
	if (!isRecord(payload)) return undefined;
	const balance = toNumber(payload.balance);
	if (balance === undefined) return undefined;
	const currency =
		typeof payload.currency === "string" && payload.currency.trim() ? payload.currency.trim().toLowerCase() : "usd";
	return { balance, currency };
}

/**
 * `GET /analytics/summary` aggregate over the queried range. The endpoint
 * documents a flat `{requests, cost_usd, errors, …}` shape but serves a
 * nested `{current: {requests, input_tokens, output_tokens}, previous, timeseries}`
 * object (verified live 2026-10-07); both are decoded, and only fields the
 * endpoint actually reported are kept — missing counters are dropped rather
 * than rendered as zero.
 */
function parseSummary(payload: unknown): Record<string, number> | undefined {
	const source = isRecord(payload) ? (isRecord(payload.current) ? payload.current : payload) : undefined;
	if (source === undefined) return undefined;
	const fields = [
		["requests", "requests"],
		["inputTokens", "input_tokens"],
		["outputTokens", "output_tokens"],
		["costUsd", "cost_usd"],
		["errors", "errors"],
	] as const;
	const summary: Record<string, number> = {};
	for (const [key, upstream] of fields) {
		const value = toNumber(source[upstream]);
		if (value !== undefined) summary[key] = value;
	}
	return Object.keys(summary).length > 0 ? summary : undefined;
}

async function fetchAiandUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== AIAND_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const root = normalizeBaseUrl(params.baseUrl);
	const headers = {
		accept: "application/json",
		authorization: `Bearer ${credential.apiKey}`,
		"User-Agent": USER_AGENT,
	};
	const balanceUrl = `${root}${BALANCE_PATH}`;
	const summaryUrl = `${root}${SUMMARY_PATH}?range=${SUMMARY_RANGE}`;
	const [balanceOutcome, summaryOutcome] = await Promise.all([
		fetchJson(ctx, balanceUrl, headers, params.signal),
		fetchJson(ctx, summaryUrl, headers, params.signal),
	]);

	// The balance is the primary window: without it there is no report at all.
	if (balanceOutcome.kind === "http") {
		// 401/403 must throw so credential checks flag the key as ok:false
		// rather than ok:null (unknown).
		if (balanceOutcome.status === 401 || balanceOutcome.status === 403) {
			throw new ProviderHttpError(`ai& balance endpoint returned ${balanceOutcome.status}`, balanceOutcome.status);
		}
		ctx.logger?.warn("ai& balance fetch failed", {
			status: balanceOutcome.status,
			statusText: balanceOutcome.statusText,
		});
		return null;
	}
	if (balanceOutcome.kind === "network") {
		ctx.logger?.warn("ai& balance fetch error", { error: String(balanceOutcome.error) });
		return null;
	}
	const balance = parseBalance(balanceOutcome.payload);
	if (!balance) {
		ctx.logger?.warn("ai& balance response missing a numeric balance");
		return null;
	}

	// The 24h aggregate is supplementary display info — a failure leaves the
	// balance-only report intact instead of dropping the whole report.
	const summary = summaryOutcome.kind === "ok" ? parseSummary(summaryOutcome.payload) : undefined;
	if (summaryOutcome.kind === "http") {
		ctx.logger?.warn("ai& summary fetch failed", { status: summaryOutcome.status });
	} else if (summaryOutcome.kind === "network") {
		ctx.logger?.warn("ai& summary fetch error", { error: String(summaryOutcome.error) });
	}

	// An org prepays credit in its own billing currency (USD or JPY, fixed at
	// org creation). Only a USD amount is a dollar figure; anything else is a
	// credit count the display must not label as USD.
	const unit: UsageUnit = balance.currency === "usd" ? "usd" : "credits";
	// No top limit is reported, so no used fraction is derivable. The pool is
	// org-wide: every key of the same org reports the same balance, so the
	// scope is shared — consumers collapse rather than sum it, and a zero
	// balance covers every ai& model on the account.
	const limit: UsageLimit = {
		id: "aiand-balance",
		label: "Credit balance",
		scope: { provider: AIAND_PROVIDER, windowId: "balance", shared: true },
		amount: { remaining: balance.balance, unit },
		status: balance.balance <= 0 ? "exhausted" : "ok",
	};

	return {
		provider: AIAND_PROVIDER,
		fetchedAt: Date.now(),
		limits: [limit],
		...(balance.currency === "jpy" ? { notes: ["Organization bills in JPY; balance shown in credits"] } : {}),
		metadata: {
			balance: balance.balance,
			currency: balance.currency,
			...(summary ? { summary24h: summary } : {}),
		},
		raw: {
			balance: balanceOutcome.payload,
			summary: summaryOutcome.kind === "ok" ? summaryOutcome.payload : undefined,
		},
	};
}

export const aiandUsageProvider: UsageProvider = {
	id: AIAND_PROVIDER,
	fetchUsage: fetchAiandUsage,
	supports: params => params.provider === AIAND_PROVIDER && params.credential.type === "api_key",
	// The balance endpoint authenticates the key, so a failed fetch is a real
	// credential signal.
	validatesCredentials: true,
};
