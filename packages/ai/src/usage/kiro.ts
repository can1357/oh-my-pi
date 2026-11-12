/**
 * Kiro credit usage provider.
 *
 * `AmazonCodeWhispererService.GetUsageLimits` on the credential's management
 * region reports the monthly plan credits, any active bonus grants (e.g.
 * first-upgrade trial credits), and the account's overage configuration.
 * Timestamps arrive as epoch seconds; the `…WithPrecision` counters carry the
 * fractional credit amounts the dashboard shows.
 */
import { KiroManagementHttpError, kiroManagementRequest } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { parseKiroEndpoint, parseKiroProfileArn } from "@oh-my-pi/pi-catalog/wire/kiro";
import { decodeKiroCredential, type KiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { buildUsageAmount, DAY_MS, HOUR_MS, parsePositiveTimestamp, usageStatus } from "./shared";

const PROVIDER_ID = "kiro";
const PLAN_LIMIT_ID = `${PROVIDER_ID}:credits`;
const BONUS_LIMIT_PREFIX = `${PROVIDER_ID}:bonus:`;
const OVERAGE_LIMIT_ID = `${PROVIDER_ID}:overage`;
const EFFECTIVE_LIMIT_ID = `${PROVIDER_ID}:effective-credits`;
const MONTH_MS = 30 * DAY_MS;
const MAX_LABEL_LENGTH = 64;

/** Where and as whom to ask for usage. */
interface KiroUsageRoute {
	apiRegion: string;
	token: string;
	/** Sent for OAuth logins that carry one; API keys and Builder ID logins omit it. */
	profileArn?: string;
	apiKey: boolean;
}

/**
 * Resolve the management route. API keys decode through the Kiro credential
 * codec; OAuth rows route by their profile ARN (`kiroProfileArn`), or by the runtime
 * endpoint for Builder ID logins, which have no profile.
 */
function resolveUsageRoute(credential: UsageCredential): KiroUsageRoute | undefined {
	if (credential.type === "api_key") {
		if (!credential.apiKey) return undefined;
		let decoded: KiroCredential;
		try {
			decoded = decodeKiroCredential(credential.apiKey);
		} catch {
			return undefined;
		}
		if (decoded.kind !== "api_key") return undefined;
		// An env key with no `KIRO_API_REGION` has no route; usage never probes regions.
		const endpoint = parseKiroEndpoint(decoded.apiEndpoint);
		return endpoint ? { apiRegion: endpoint.apiRegion, token: decoded.token, apiKey: true } : undefined;
	}
	const token = credential.accessToken?.trim();
	if (!token) return undefined;
	if (credential.kiroProfileArn !== undefined) {
		const profile = parseKiroProfileArn(credential.kiroProfileArn);
		return profile
			? { apiRegion: profile.apiRegion, token, profileArn: profile.profileArn, apiKey: false }
			: undefined;
	}
	const endpoint = parseKiroEndpoint(credential.apiEndpoint);
	return endpoint ? { apiRegion: endpoint.apiRegion, token, apiKey: false } : undefined;
}

/** Server-provided display text, made safe and bounded for terminal labels. */
function displayText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = sanitizeText(value.replace(/[\r\n\t]+/g, " ")).trim();
	return text ? text.slice(0, MAX_LABEL_LENGTH) : undefined;
}

/** `KIRO PRO` → `Kiro Pro`. */
function titleCase(value: string): string {
	return value
		.toLowerCase()
		.split(/\s+/)
		.map(word => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
		.join(" ");
}

/** Prefer the fractional `…WithPrecision` counter over its rounded twin. */
function preciseNumber(record: Record<string, unknown>, key: string): number | undefined {
	return toNumber(record[`${key}WithPrecision`]) ?? toNumber(record[key]);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

interface ParsedBonus {
	slug: string;
	label: string;
	used: number;
	limit: number;
	expiresAt?: number;
}

function parseActiveBonuses(value: unknown): ParsedBonus[] {
	if (!Array.isArray(value)) return [];
	const bonuses: ParsedBonus[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry) || entry.status !== "ACTIVE") continue;
		const used = toNumber(entry.currentUsage);
		const limit = toNumber(entry.usageLimit);
		if (used === undefined || limit === undefined || limit <= 0) continue;
		const base = slugify(typeof entry.bonusType === "string" ? entry.bonusType : "") || "bonus";
		let slug = base;
		for (let n = 2; seen.has(slug); n += 1) slug = `${base}-${n}`;
		seen.add(slug);
		bonuses.push({
			slug,
			label: displayText(entry.displayName) ?? "Bonus credits",
			used,
			limit,
			expiresAt: parsePositiveTimestamp(entry.expiresAt),
		});
	}
	return bonuses;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * Parse a `GetUsageLimits` response into a usage report: the monthly plan
 * credits, one limit per active bonus grant, and — when overage billing is
 * enabled — the overage credits against their cap. Returns null when the
 * response carries no readable credit breakdown.
 */
export function parseKiroUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !Array.isArray(payload.usageBreakdownList)) return null;
	const credit = payload.usageBreakdownList.find(
		(entry): entry is Record<string, unknown> => isRecord(entry) && entry.resourceType === "CREDIT",
	);
	if (!credit) return null;
	const planUsed = preciseNumber(credit, "currentUsage");
	const planLimit = preciseNumber(credit, "usageLimit");
	if (planUsed === undefined || planLimit === undefined || planLimit < 0) return null;

	const subscription = isRecord(payload.subscriptionInfo) ? payload.subscriptionInfo : undefined;
	const planTitle = displayText(subscription?.subscriptionTitle);
	const planName = planTitle ? titleCase(planTitle) : "Kiro";
	const unitPlural = displayText(credit.displayNamePlural)?.toLowerCase() ?? "credits";
	const monthly: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		durationMs: MONTH_MS,
	};
	const resetsAt = parsePositiveTimestamp(credit.nextDateReset) ?? parsePositiveTimestamp(payload.nextDateReset);
	if (resetsAt !== undefined) monthly.resetsAt = resetsAt;

	const bonuses = parseActiveBonuses(credit.bonuses);
	const overageConfig = isRecord(payload.overageConfiguration) ? payload.overageConfiguration : undefined;
	const overageEnabled = overageConfig?.overageStatus === "ENABLED";
	const overageUsed = preciseNumber(credit, "currentOverages");
	const overageCap = preciseNumber(credit, "overageCap");

	const limits: UsageLimit[] = [];
	const planAmount = buildUsageAmount({
		used: planUsed,
		limit: planLimit,
		remaining: Math.max(0, planLimit - planUsed),
		// A zero-credit plan is fully used: there is nothing left to draw on.
		usedFraction: planLimit > 0 ? Math.min(planUsed / planLimit, 1) : 1,
		unit: "credits",
	});
	let planStatus: UsageStatus = usageStatus(planAmount.usedFraction);
	const planNotes: string[] = [];
	// Spent plan credits keep serving from an active bonus grant or, when
	// enabled, paid overage up to its cap; only then is the account out.
	const planSpent = planStatus === "exhausted";
	const bonusLeft = bonuses.some(bonus => bonus.used < bonus.limit);
	const overageLeft = overageEnabled && overageCap !== undefined && overageCap > 0 && (overageUsed ?? 0) < overageCap;
	if (planSpent && (bonusLeft || overageLeft)) {
		planStatus = "warning";
		if (bonusLeft) planNotes.push("Plan credits used up; drawing on bonus credits");
	}
	limits.push({
		id: PLAN_LIMIT_ID,
		label: `${planName} ${unitPlural}`,
		scope: { provider: PROVIDER_ID, windowId: monthly.id, shared: true },
		window: monthly,
		amount: planAmount,
		status: planStatus,
		...(planNotes.length > 0 ? { notes: planNotes } : {}),
	});

	for (const bonus of bonuses) {
		const window: UsageWindow = {
			id: `bonus-${bonus.slug}`,
			label: "Bonus",
			resetLabel: "expires",
			...(bonus.expiresAt !== undefined ? { resetsAt: bonus.expiresAt } : {}),
		};
		const amount = buildUsageAmount({
			used: bonus.used,
			limit: bonus.limit,
			remaining: Math.max(0, bonus.limit - bonus.used),
			unit: "credits",
		});
		limits.push({
			id: `${BONUS_LIMIT_PREFIX}${bonus.slug}`,
			label: bonus.label,
			scope: { provider: PROVIDER_ID, windowId: window.id, shared: true },
			window,
			amount,
			status: usageStatus(amount.usedFraction),
		});
	}

	if (overageEnabled && overageCap !== undefined && overageCap > 0) {
		const used = overageUsed ?? 0;
		const amount = buildUsageAmount({
			used,
			limit: overageCap,
			remaining: Math.max(0, overageCap - used),
			unit: "credits",
		});
		const charges = toNumber(credit.overageCharges);
		const rate = toNumber(credit.overageRate);
		const notes: string[] = planSpent && !bonusLeft ? ["Free credits used up; drawing paid overage"] : [];
		if (charges !== undefined) {
			notes.push(
				rate !== undefined
					? `Overage charges: ${formatUsd(charges)} (${formatUsd(rate)} per credit)`
					: `Overage charges: ${formatUsd(charges)}`,
			);
		}
		limits.push({
			id: OVERAGE_LIMIT_ID,
			label: "Overage credits",
			scope: { provider: PROVIDER_ID, windowId: monthly.id, shared: true },
			window: monthly,
			amount,
			status: usageStatus(amount.usedFraction),
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	return {
		provider: PROVIDER_ID,
		fetchedAt,
		limits,
		// Response `userInfo` (the account email) is deliberately not carried over.
		...(planTitle ? { metadata: { planType: planName } } : {}),
	};
}

export const kiroUsageProvider: UsageProvider = {
	id: PROVIDER_ID,

	supports(params: UsageFetchParams): boolean {
		if (params.provider !== PROVIDER_ID) return false;
		const { credential } = params;
		return credential.type === "oauth" ? Boolean(credential.accessToken) : Boolean(credential.apiKey);
	},

	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== PROVIDER_ID) return null;
		const { credential } = params;
		// An expired bearer whose refresh failed would only 401 and drop the last good report.
		if (credential.type === "oauth" && credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
			return null;
		}
		const route = resolveUsageRoute(credential);
		if (!route) {
			ctx.logger?.debug("Kiro usage skipped: credential has no management route", { provider: PROVIDER_ID });
			return null;
		}

		let payload: unknown;
		try {
			payload = await kiroManagementRequest({
				apiRegion: route.apiRegion,
				token: route.token,
				target: "GetUsageLimits",
				body: {
					origin: "KIRO_CLI",
					...(route.profileArn ? { profileArn: route.profileArn } : {}),
					resourceType: "AGENTIC_REQUEST",
				},
				fetch: ctx.fetch,
				signal: params.signal,
			});
		} catch (error) {
			// A rejected OAuth login has lost access: drop its cached quota. An
			// API key the usage route refuses simply has no report.
			if (
				!route.apiKey &&
				error instanceof KiroManagementHttpError &&
				(error.status === 401 || error.status === 403)
			) {
				throw new ProviderHttpError(`Kiro usage endpoint returned ${error.status}`, error.status);
			}
			ctx.logger?.warn("Kiro usage request failed", { provider: PROVIDER_ID, error: String(error) });
			return null;
		}

		const report = parseKiroUsage(payload);
		if (!report) {
			ctx.logger?.warn("Kiro usage response has no readable credit breakdown", { provider: PROVIDER_ID });
			return null;
		}
		// Attribute the report to the login it measured, so several logins that
		// share one profile stay separate accounts.
		if (credential.type === "oauth" && credential.accountId) {
			report.metadata = { ...report.metadata, accountId: credential.accountId };
		}
		return report;
	},
};

/**
 * The account's free allowance: plan credits plus active bonus grants that
 * have not expired. Enabled overage is paid ($ per credit), so like Codex
 * credits (#13889) it never counts as allowance: an account with only overage
 * left measures as spent (`allowanceSpent`, yielding to any sibling with free
 * credits) but stays a `warning`, never blocked, so it still serves when it is
 * the only account. Ranking-only; reports keep the plan meter.
 */
function effectiveCreditLimit(report: UsageReport): UsageLimit | undefined {
	const plan = report.limits.find(limit => limit.id === PLAN_LIMIT_ID);
	if (!plan) return undefined;
	const now = Date.now();
	let used = 0;
	let limit = 0;
	for (const entry of report.limits) {
		const isBonus = entry.id.startsWith(BONUS_LIMIT_PREFIX);
		if (!isBonus && entry.id !== PLAN_LIMIT_ID) continue;
		const expiresAt = entry.window?.resetsAt;
		if (isBonus && expiresAt !== undefined && expiresAt <= now) continue;
		const { used: entryUsed, limit: entryLimit } = entry.amount;
		if (entryUsed === undefined || entryLimit === undefined || entryLimit <= 0) continue;
		used += Math.min(entryUsed, entryLimit);
		limit += entryLimit;
	}
	const amount = buildUsageAmount({
		used,
		limit,
		remaining: Math.max(0, limit - used),
		usedFraction: limit > 0 ? Math.min(used / limit, 1) : 1,
		unit: "credits",
	});
	const overage = report.limits.find(entry => entry.id === OVERAGE_LIMIT_ID);
	let status = usageStatus(amount.usedFraction);
	if (status === "exhausted" && overage !== undefined && overage.status !== "exhausted") status = "warning";
	return { ...plan, id: EFFECTIVE_LIMIT_ID, amount, status };
}

/**
 * Gates and measures Kiro accounts by their free credit headroom (plan and
 * active bonuses); paid overage keeps a spent account serving but ranks it
 * behind siblings with free credits. Drain ranking stays on the renewable
 * monthly plan meter; Kiro reports no short window, so it maps to `secondary`.
 */
export const kiroRankingStrategy: CredentialRankingStrategy = {
	scopeLimits(report) {
		const effective = effectiveCreditLimit(report);
		return effective ? [effective] : [];
	},
	findWindowLimits(report) {
		return { secondary: report.limits.find(limit => limit.id === PLAN_LIMIT_ID) };
	},
	windowDefaults: {
		// Inert: findWindowLimits never reports a primary window.
		primaryMs: 5 * HOUR_MS,
		secondaryMs: MONTH_MS,
	},
};
