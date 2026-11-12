/**
 * Mistral plan budgets, read the way the Mistral Vibe CLI reads them
 * (mistralai/mistral-vibe, vibe/app_server/_billing.py):
 *  - GET {base}/billing/budget       -> { vibe_budget, api_budget }: monthly allowance, % used, reset
 *  - GET {base}/billing/subscription -> { plan_name, payg_enabled, vibe_payg_enabled, enterprise }
 *
 * Both are public `beta.billing` routes in Mistral's OpenAPI spec and accept the same key as
 * inference. `/budget` needs the `see_org_inference_usage` permission, so an organization member
 * without it gets 403; that reads as "no usage to show", not as a bad key. Only a 401 (invalid or
 * revoked key) throws, so the cached report is purged instead of re-served.
 */
import { ProviderHttpError } from "../error";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
} from "../usage";
import { isRecord } from "../utils";
import { buildUsageAmount, DAY_MS, parseIsoTimestamp, usageStatus } from "./shared";

const PROVIDER = "mistral";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const BUDGET_PATH = "/billing/budget";
const SUBSCRIPTION_PATH = "/billing/subscription";
const MONTHLY_WINDOW = { id: "monthly", label: "Monthly", durationMs: 30 * DAY_MS } as const;

/** Display titles for `plan_name`, as the Vibe CLI shows them. */
const PLAN_TITLES: Record<string, string> = {
	FREE: "Free",
	INDIVIDUAL: "Pro",
	EDU: "Student",
	TEAM: "Team",
};

interface BudgetKind {
	key: "vibe_budget" | "api_budget";
	id: string;
	label: string;
}

const VIBE_BUDGET: BudgetKind = { key: "vibe_budget", id: "vibe", label: "Vibe Code" };
const API_BUDGET: BudgetKind = { key: "api_budget", id: "api", label: "API" };

interface Subscription {
	planName?: string;
	enterprise: boolean;
	paygEnabled?: boolean;
	vibePaygEnabled?: boolean;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseSubscription(payload: unknown): Subscription | undefined {
	if (!isRecord(payload)) return undefined;
	const planName =
		typeof payload.plan_name === "string" && payload.plan_name.trim() ? payload.plan_name.trim() : undefined;
	return {
		planName,
		enterprise: payload.enterprise === true,
		paygEnabled: optionalBoolean(payload.payg_enabled),
		vibePaygEnabled: optionalBoolean(payload.vibe_payg_enabled),
	};
}

function planTitle(subscription: Subscription | undefined): string | undefined {
	if (!subscription) return undefined;
	if (subscription.enterprise) return "Enterprise";
	const name = subscription.planName;
	if (!name) return undefined;
	return PLAN_TITLES[name.toUpperCase()] ?? name;
}

function budgetAmount(usedFraction: number, budget: number, currency: string | undefined): UsageAmount {
	// No non-USD money unit exists; show the share and name the currency in a note.
	const usd = currency === "USD";
	const limit = usd ? budget : 100;
	const used = usedFraction * limit;
	return buildUsageAmount({
		used,
		limit,
		remaining: Math.max(0, limit - used),
		usedFraction,
		unit: usd ? "usd" : "percent",
	});
}

/**
 * One budget from `/billing/budget`. A zero `initial_budget` means the organization has no
 * allowance of that kind (e.g. no Vibe Code budget on an API-only plan); it is skipped, as Vibe does.
 */
function parseBudget(
	raw: unknown,
	kind: BudgetKind,
	payg: boolean,
	provider: UsageFetchParams["provider"],
): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const percentage = raw.usage_percentage;
	const budget = raw.initial_budget;
	if (typeof percentage !== "number" || !Number.isFinite(percentage)) return null;
	if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return null;

	const usedFraction = Math.max(0, percentage) / 100;
	const currency = typeof raw.currency === "string" && raw.currency ? raw.currency.toUpperCase() : undefined;
	const resetsAt = parseIsoTimestamp(raw.reset_at);
	const notes: string[] = [];
	if (currency !== "USD") notes.push(`${budget} ${currency ?? "(unknown currency)"} monthly budget`);
	if (payg) notes.push("pay-as-you-go past the allowance");
	// With pay-as-you-go, usage past 100% is billed instead of stopped.
	const status: UsageStatus = payg && usedFraction >= 1 ? "warning" : usageStatus(usedFraction);

	return {
		id: `${PROVIDER}:${kind.id}:${MONTHLY_WINDOW.id}`,
		label: kind.label,
		scope: { provider, windowId: MONTHLY_WINDOW.id, shared: true },
		window: { ...MONTHLY_WINDOW, ...(resetsAt !== undefined ? { resetsAt } : {}) },
		amount: budgetAmount(usedFraction, budget, currency),
		status,
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function getJson(
	url: string,
	headers: Record<string, string>,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<unknown> {
	try {
		const response = await ctx.fetch(url, { headers, signal: params.signal });
		if (!response.ok) {
			if (response.status === 401) {
				throw new ProviderHttpError(`Mistral billing read returned ${response.status}`, response.status);
			}
			// 403: a member without `see_org_inference_usage`; 404: a platform without billing.
			const log = response.status === 403 || response.status === 404 ? ctx.logger?.debug : ctx.logger?.warn;
			log?.call(ctx.logger, "Mistral billing read failed", { url, status: response.status });
			return undefined;
		}
		return await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Mistral billing read error", { url, error: String(error) });
		return undefined;
	}
}

async function fetchMistralUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = (params.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const budgetUrl = `${baseUrl}${BUDGET_PATH}`;
	const headers = { Accept: "application/json", Authorization: `Bearer ${credential.apiKey}` };
	const [budgets, subscriptionPayload] = await Promise.all([
		getJson(budgetUrl, headers, params, ctx),
		getJson(`${baseUrl}${SUBSCRIPTION_PATH}`, headers, params, ctx),
	]);
	if (!isRecord(budgets)) return null;

	const subscription = parseSubscription(subscriptionPayload);
	const vibeBudget = budgets[VIBE_BUDGET.key];
	const vibePayg =
		(isRecord(vibeBudget) ? optionalBoolean(vibeBudget.payg_enabled) : undefined) ??
		subscription?.vibePaygEnabled ??
		false;
	const limits = [
		parseBudget(vibeBudget, VIBE_BUDGET, vibePayg, params.provider),
		parseBudget(budgets[API_BUDGET.key], API_BUDGET, subscription?.paygEnabled ?? false, params.provider),
	].filter((limit): limit is UsageLimit => limit !== null);
	if (limits.length === 0) return null;

	const planType = planTitle(subscription);
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: budgetUrl, ...(planType ? { planType } : {}) },
		raw: { budget: budgets, subscription: subscriptionPayload },
	};
}

export const mistralUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchMistralUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
};
