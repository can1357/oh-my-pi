import { CLINEPASS_API_BASE_URL, clinePassClientHeaders } from "@oh-my-pi/pi-catalog/wire/cline-pass";
import { ProviderHttpError } from "../error";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
} from "../usage";
import { isRecord } from "../utils";

const PROVIDER = "cline-pass";
const DEFAULT_BASE_URL = CLINEPASS_API_BASE_URL;
// Dashboard quota route. It accepts the same API key as inference; account OAuth is not required.
const USAGE_LIMITS_PATH = "/users/me/plan/usage-limits";
const ACCOUNT_PATH = "/users/me";

const WINDOW_CONFIG = {
	five_hour: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1_000 },
	weekly: { id: "7d", label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1_000 },
	monthly: { id: "30d", label: "Monthly", durationMs: 30 * 24 * 60 * 60 * 1_000 },
} as const;

type WindowType = keyof typeof WINDOW_CONFIG;

function parseResetTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function usageStatus(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function parseLimit(raw: unknown, provider: UsageFetchParams["provider"]): UsageLimit | null {
	if (!isRecord(raw) || typeof raw.type !== "string" || !(raw.type in WINDOW_CONFIG)) return null;
	if (typeof raw.percentUsed !== "number" || !Number.isFinite(raw.percentUsed)) return null;

	const config = WINDOW_CONFIG[raw.type as WindowType];
	const used = Math.max(0, raw.percentUsed);
	const usedFraction = used / 100;
	const resetsAt = parseResetTime(raw.resetsAt);

	return {
		id: `${PROVIDER}:${config.id}`,
		label: "ClinePass",
		scope: { provider, windowId: config.id, shared: true },
		window: {
			id: config.id,
			label: config.label,
			durationMs: config.durationMs,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			limit: 100,
			remaining: Math.max(0, 100 - used),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "percent",
		},
		status: usageStatus(usedFraction),
	};
}

interface AccountIdentity {
	email?: string;
	accountId?: string;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function fetchAccountIdentity(
	url: string,
	headers: Record<string, string>,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<AccountIdentity> {
	if (params.credential.email || params.credential.accountId) {
		return {
			email: params.credential.email,
			accountId: params.credential.accountId,
		};
	}
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) return {};
		const payload: unknown = await response.json();
		if (!isRecord(payload)) return {};
		const data = isRecord(payload.data) ? payload.data : payload;
		return {
			email: nonEmptyString(data.email),
			accountId: nonEmptyString(data.id),
		};
	} catch (error) {
		ctx.logger?.debug("ClinePass account identity fetch failed", { error: String(error) });
		return {};
	}
}

async function fetchClinePassUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = (params.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const usageUrl = `${baseUrl}${USAGE_LIMITS_PATH}`;
	const headers = {
		...clinePassClientHeaders(),
		Accept: "application/json",
		Authorization: `Bearer ${credential.apiKey}`,
	};
	let payload: unknown;
	try {
		const response = await ctx.fetch(usageUrl, { headers, signal: params.signal });
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`ClinePass usage endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("ClinePass usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("ClinePass usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;
	const data = isRecord(payload.data) ? payload.data : payload;
	if (!Array.isArray(data.limits)) return null;

	const limits = data.limits
		.map(limit => parseLimit(limit, params.provider))
		.filter((limit): limit is UsageLimit => limit !== null);
	if (limits.length === 0) return null;

	const identity = await fetchAccountIdentity(`${baseUrl}${ACCOUNT_PATH}`, headers, params, ctx);

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: usageUrl, ...identity },
		raw: payload,
	};
}

export const clinePassUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchClinePassUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
