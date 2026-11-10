import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { parseIsoTimestamp, usageStatus } from "./shared";

const MISTRAL_PROVIDER = "mistral";
const DEFAULT_API_BASE = "https://api.mistral.ai/v1";
const BUDGET_PATH = "/billing/budget";

/**
 * Budgets reported by `GET /v1/billing/budget`, the endpoint the Vibe Code CLI
 * reads for its footer usage gauge (mistralai/mistral-vibe,
 * `vibe/app_server/_billing.py`). Each budget is a monthly allowance:
 * `usage_percentage` (0-100, may exceed 100 with pay-as-you-go),
 * `initial_budget` in `currency`, `reset_at` (ISO), and `payg_enabled`.
 * Either budget may be absent or null, e.g. on organizations without Vibe.
 * The two are separate allowances, so distinct window ids keep them out of
 * one shared capacity bucket.
 */
const MISTRAL_BUDGETS = [
	{
		key: "vibe_budget",
		limitId: "mistral:vibe-code:monthly",
		windowId: "vibe-code-monthly",
		label: "Vibe Code Monthly",
	},
	{ key: "api_budget", limitId: "mistral:api:monthly", windowId: "api-monthly", label: "API Monthly" },
] as const;

function budgetUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return `${DEFAULT_API_BASE}${BUDGET_PATH}`;
	// Model base URLs carry the `/v1` API prefix; bare hosts get it appended.
	return /\/v1$/i.test(trimmed) ? `${trimmed}${BUDGET_PATH}` : `${trimmed}/v1${BUDGET_PATH}`;
}

function formatBudget(amount: number, currency: unknown): string {
	return typeof currency === "string" && currency ? `${amount} ${currency}` : String(amount);
}

function buildBudgetLimit(descriptor: (typeof MISTRAL_BUDGETS)[number], raw: unknown): UsageLimit | undefined {
	if (!isRecord(raw)) return undefined;
	const percent = raw.usage_percentage;
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const used = Math.max(0, percent);
	const usedFraction = used / 100;
	const payg = raw.payg_enabled === true;
	const resetsAt = parseIsoTimestamp(raw.reset_at);
	const notes: string[] = [];
	if (typeof raw.initial_budget === "number" && Number.isFinite(raw.initial_budget)) {
		notes.push(`Monthly budget: ${formatBudget(raw.initial_budget, raw.currency)}`);
	}
	if (payg) notes.push("Pay-as-you-go enabled: usage past the budget is billed");
	// With pay-as-you-go, a spent allowance bills instead of blocking requests.
	const status = payg && usedFraction >= 1 ? "warning" : usageStatus(usedFraction);
	return {
		id: descriptor.limitId,
		label: descriptor.label,
		scope: { provider: MISTRAL_PROVIDER, windowId: descriptor.windowId, shared: true },
		window: {
			id: "monthly",
			label: descriptor.label,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
		amount: {
			used,
			limit: 100,
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "percent",
		},
		status,
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function fetchMistralUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== MISTRAL_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const url = budgetUrl(params.baseUrl);
	let payload: unknown;
	try {
		const response = await ctx.fetch(url, {
			headers: { accept: "application/json", authorization: `Bearer ${credential.apiKey}` },
			signal: params.signal,
		});
		if (!response.ok) {
			// 401 rejects the key itself, so health checks must see it. 403 is a
			// workspace member without the `see_org_inference_usage` permission and
			// 404 a deployment without billing: neither invalidates the key.
			if (response.status === 401) {
				throw new ProviderHttpError(`Mistral billing endpoint returned ${response.status}`, response.status);
			}
			ctx.logger?.warn("Mistral usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = (await response.json()) as unknown;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Mistral usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;
	const limits: UsageLimit[] = [];
	for (const descriptor of MISTRAL_BUDGETS) {
		const limit = buildBudgetLimit(descriptor, payload[descriptor.key]);
		if (limit) limits.push(limit);
	}
	if (limits.length === 0) return null;

	return {
		provider: MISTRAL_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: url },
		raw: payload,
	};
}

export const mistralUsageProvider: UsageProvider = {
	id: MISTRAL_PROVIDER,
	fetchUsage: fetchMistralUsage,
	supports: params => params.provider === MISTRAL_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
