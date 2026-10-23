import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { Provider } from "../types";
import { resolveUsedFraction } from "../usage";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	ExtraUsageState,
	UsageLimit,
	UsageLogger,
	UsageReport,
} from "../usage";

import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type {
	AuthAccountPolicy,
	ExtraUsageAllowance,
	OAuthCredential,
	PaidUsageStop,
	PaidUsageView,
	UsageFundingTier,
} from "./types";

/** Funding standing for one account after plan allowance and paid capacity are evaluated. */
export interface FundingAssessment {
	tier: UsageFundingTier;
	extra: "available" | "past-floor" | "unavailable";
	allowanceResetsAt?: number;
}

/** Read a string identity field from report metadata. */
export function usageReportMetadataValue(report: UsageReport, key: string): string | undefined {
	const metadata = report.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const value = metadata[key];
	return typeof value === "string" ? value.trim() : undefined;
}

/** Resolve a single report-scoped account ID. */
export function usageReportScopeAccountId(report: UsageReport): string | undefined {
	const ids = new Set<string>();
	for (const limit of report.limits) {
		const accountId = limit.scope.accountId?.trim();
		if (accountId) ids.add(accountId);
	}
	if (ids.size === 1) return [...ids][0];
	return undefined;
}

function usageReportScopeProjectId(report: UsageReport): string | undefined {
	const ids = new Set<string>();
	for (const limit of report.limits) {
		const projectId = limit.scope.projectId?.trim();
		if (projectId) ids.add(projectId);
	}
	if (ids.size === 1) return [...ids][0];
	return undefined;
}

function usageReportIdentifiers(report: UsageReport): string[] {
	const identifiers: string[] = [];
	const email = usageReportMetadataValue(report, "email");
	if (email) identifiers.push(`email:${email.toLowerCase()}`);
	if (authPolicyFor(report.provider)?.orgScopedIdentity === true) {
		// One account email can hold several org-scoped subscriptions
		// (Anthropic organizations, ChatGPT workspaces). Reports from
		// different orgs must not merge — scope every identifier by org
		// when the report carries one; fall back to the account when the
		// email could not be recovered so no-email reports still merge
		// per org. Org-less reports (pre-upgrade caches) keep their bare
		// identifiers and only merge among themselves.
		if (identifiers.length === 0) {
			const accountId = usageReportMetadataValue(report, "accountId") ?? usageReportScopeAccountId(report);
			if (accountId) identifiers.push(`account:${accountId}`);
		}
		const orgId = usageReportMetadataValue(report, "orgId");
		if (orgId) {
			if (identifiers.length === 0) return [`${report.provider}:org:${orgId.toLowerCase()}`];
			return identifiers.map(
				identifier => `${report.provider}:org:${orgId.toLowerCase()}|${identifier.toLowerCase()}`,
			);
		}
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}
	const projectId = usageReportMetadataValue(report, "projectId") ?? usageReportScopeProjectId(report);
	// Only add project as a fallback when no email is available — two users
	// with different emails on the same GCP project must not merge.
	if (projectId && !email) identifiers.push(`project:${projectId}`);
	const accountId = usageReportMetadataValue(report, "accountId");
	if (accountId) identifiers.push(`account:${accountId}`);
	const account = usageReportMetadataValue(report, "account");
	if (account) identifiers.push(`account:${account}`);
	const user = usageReportMetadataValue(report, "user");
	if (user) identifiers.push(`account:${user}`);
	const username = usageReportMetadataValue(report, "username");
	if (username) identifiers.push(`account:${username}`);
	const scopeAccountId = usageReportScopeAccountId(report);
	if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
	return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
}

function mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
	if (reports.length === 1) return reports[0];
	const sorted = [...reports].sort((a, b) => {
		const limitDiff = b.limits.length - a.limits.length;
		if (limitDiff !== 0) return limitDiff;
		return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
	});
	const base = sorted[0];
	const mergedLimits = [...base.limits];
	const limitIds = new Set(mergedLimits.map(limit => limit.id));
	const mergedMetadata: Record<string, unknown> = { ...base.metadata };
	let fetchedAt = base.fetchedAt;

	for (const report of sorted.slice(1)) {
		fetchedAt = Math.max(fetchedAt, report.fetchedAt);
		for (const limit of report.limits) {
			if (!limitIds.has(limit.id)) {
				limitIds.add(limit.id);
				mergedLimits.push(limit);
			}
		}
		if (report.metadata) {
			for (const [key, value] of Object.entries(report.metadata)) {
				if (mergedMetadata[key] === undefined) {
					mergedMetadata[key] = value;
				}
			}
		}
	}

	return {
		...base,
		fetchedAt,
		limits: mergedLimits,
		metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
	};
}

/** Merge reports for the same account, logging a reduction when configured. */
export function dedupeUsageReports(reports: UsageReport[], logger?: UsageLogger): UsageReport[] {
	const groups: UsageReport[][] = [];
	const idToGroup = new Map<string, number>();

	for (const report of reports) {
		const identifiers = usageReportIdentifiers(report);
		let groupIndex: number | undefined;
		for (const identifier of identifiers) {
			const existing = idToGroup.get(identifier);
			if (existing !== undefined) {
				groupIndex = existing;
				break;
			}
		}
		if (groupIndex === undefined) {
			groupIndex = groups.length;
			groups.push([]);
		}
		groups[groupIndex].push(report);
		for (const identifier of identifiers) {
			idToGroup.set(identifier, groupIndex);
		}
	}

	const deduped = groups.map(group => mergeUsageReportGroup(group));
	if (deduped.length !== reports.length) {
		logger?.debug("Usage reports deduped", {
			before: reports.length,
			after: deduped.length,
		});
	}
	return deduped;
}

/** Determine whether a usage limit has exhausted its quota. */
export function isUsageLimitExhausted(limit: UsageLimit): boolean {
	if (limit.status !== undefined && limit.status !== "unknown") return limit.status === "exhausted";
	const amount = limit.amount;
	if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
	if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
	if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
	if (amount.remaining !== undefined && amount.remaining <= 0) return true;
	if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
	return false;
}

/** Return the usage limits that apply to the requested model for this strategy. */
export function scopedUsageLimits(
	strategy: CredentialRankingStrategy,
	report: UsageReport,
	context: CredentialRankingContext,
): UsageLimit[] {
	return strategy.scopeLimits?.(report, context) ?? report.limits;
}

/** Returns true if usage indicates rate limit has been reached. */
export function isUsageLimitReached(limits: UsageLimit[]): boolean {
	return limits.some(limit => isUsageLimitExhausted(limit));
}

/** Extracts when every currently exhausted window has reset (in ms). */
export function usageResetAtMs(limits: UsageLimit[], nowMs: number): number | undefined {
	const candidates: number[] = [];
	for (const limit of limits) {
		if (!isUsageLimitExhausted(limit)) continue;
		const window = limit.window;
		if (window?.resetsAt && window.resetsAt > nowMs) {
			candidates.push(window.resetsAt);
		}
	}
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
}

/** Remove usage windows whose reset invalidates a report fetched before it. */
export function currentUsageLimits(limits: readonly UsageLimit[], fetchedAt: number, nowMs: number): UsageLimit[] {
	return limits.filter(limit => {
		const resetsAt = limit.window?.resetsAt;
		return resetsAt === undefined || resetsAt > nowMs || fetchedAt >= resetsAt;
	});
}

function allowanceLimitIsExhausted(limit: UsageLimit): boolean {
	return isUsageLimitExhausted(limit) || (resolveUsedFraction(limit) ?? 0) >= 1;
}

function allowanceResetAtMs(limits: readonly UsageLimit[], nowMs: number): number | undefined {
	let latest: number | undefined;
	for (const limit of limits) {
		if (!allowanceLimitIsExhausted(limit)) continue;
		const resetsAt = windowResetAt(limit.window);
		if (resetsAt !== undefined && resetsAt > nowMs && (latest === undefined || resetsAt > latest)) {
			latest = resetsAt;
		}
	}
	return latest;
}

function remainingUsageFractionForLimits(limits: readonly UsageLimit[]): number | undefined {
	const usedFractions = limits
		.map(resolveUsedFraction)
		.filter((fraction): fraction is number => fraction !== undefined);
	return usedFractions.length === 0 ? undefined : Math.max(0, 1 - Math.max(...usedFractions));
}

/** Paid-usage standing before mapping it to a funding tier or display view. */
export interface ExtraUsageClassification {
	extra: FundingAssessment["extra"];
	stop?: PaidUsageStop;
}

/**
 * Classify provider-reported paid usage against the exact policy and paid-usage
 * block selection applies after plan allowance is spent.
 */
export function classifyExtraUsage(args: {
	extraUsage: ExtraUsageState | undefined;
	policy?: Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;
	extraUsageBlockedUntil?: number;
	nowMs: number;
}): ExtraUsageClassification {
	const { extraUsage, policy, extraUsageBlockedUntil, nowMs } = args;
	if (extraUsage === undefined) return { extra: "unavailable" };
	if (!extraUsage.enabled) return { extra: "unavailable", stop: "disabled" };
	if (extraUsage.exhausted) return { extra: "unavailable", stop: "cap-reached" };
	if (extraUsageBlockedUntil !== undefined && extraUsageBlockedUntil > nowMs) {
		return { extra: "unavailable", stop: "refused" };
	}
	if (!extraUsage.uncapped && extraUsage.remaining !== undefined && extraUsage.remaining <= 0) {
		return { extra: "unavailable", stop: "cap-reached" };
	}
	if (
		policy?.extraUsageFloor !== undefined &&
		policy.extraUsageFloor > 0 &&
		!extraUsage.uncapped &&
		(extraUsage.remaining === undefined || extraUsage.remaining <= policy.extraUsageFloor)
	) {
		return {
			extra: "past-floor",
			stop: extraUsage.remaining === undefined ? "floor-unreported" : "floor",
		};
	}
	if (policy?.extraUsageBudget !== undefined) {
		if (extraUsage.used === undefined) return { extra: "past-floor", stop: "budget-unreported" };
		if (extraUsage.used >= policy.extraUsageBudget) return { extra: "past-floor", stop: "budget" };
	}
	return { extra: "available" };
}

/**
 * Assess whether an account remains on its plan allowance or may serve through
 * provider-reported paid extra usage.
 */
export function assessFunding(args: {
	strategy?: CredentialRankingStrategy;
	report: UsageReport | null;
	context: CredentialRankingContext;
	nowMs: number;
	policy?: Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;
	extraUsageBlockedUntil?: number;
}): FundingAssessment | undefined {
	const { report, strategy, context, nowMs } = args;
	if (report === null) return undefined;

	const hard = currentUsageLimits(
		strategy ? scopedUsageLimits(strategy, report, context) : report.limits,
		report.fetchedAt,
		nowMs,
	);
	const remaining = remainingUsageFractionForLimits(hard);
	if (remaining !== 0 && !isUsageLimitReached(hard)) {
		return { tier: "allowance", extra: "unavailable" };
	}

	const extra = classifyExtraUsage({
		extraUsage: strategy?.extraUsage?.(report, context),
		policy: args.policy,
		extraUsageBlockedUntil: args.extraUsageBlockedUntil,
		nowMs,
	}).extra;

	return {
		tier: extra === "available" ? "extra" : extra === "past-floor" ? "extra-past-floor" : "spent",
		extra,
		allowanceResetsAt: allowanceResetAtMs(hard, nowMs),
	};
}

/** Describe paid usage even while plan allowance remains, using selection's exact policy rules. */
export function describePaidUsage(args: {
	strategy?: CredentialRankingStrategy;
	report: UsageReport;
	policy?: Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;
	extraUsageBlockedUntil?: number;
	nowMs: number;
}): PaidUsageView | undefined {
	const { strategy, report, policy, extraUsageBlockedUntil, nowMs } = args;
	const extraUsage = strategy?.extraUsage?.(report, {});
	if (extraUsage === undefined) return undefined;

	const classification = classifyExtraUsage({ extraUsage, policy, extraUsageBlockedUntil, nowMs });
	const floor = policy?.extraUsageFloor;
	const budget = policy?.extraUsageBudget;
	const floorApplies = floor !== undefined && floor > 0 && !extraUsage.uncapped;
	const floorIgnored = floor !== undefined && floor > 0 && extraUsage.uncapped;
	const used = extraUsage.used;
	const remaining = extraUsage.remaining;
	const budgetLeft = budget !== undefined && used !== undefined ? Math.max(0, budget - used) : undefined;
	const paidLimit =
		extraUsage.limitId === undefined ? undefined : report.limits.find(limit => limit.id === extraUsage.limitId);
	const cap =
		extraUsage.capacity === "spend-cap" &&
		!extraUsage.uncapped &&
		typeof paidLimit?.amount.limit === "number" &&
		Number.isFinite(paidLimit.amount.limit)
			? paidLimit.amount.limit
			: undefined;

	let headroom: number | undefined = classification.extra === "available" ? undefined : 0;
	let boundBy: PaidUsageView["boundBy"];
	if (classification.extra === "available") {
		if (floorApplies && remaining !== undefined) {
			headroom = Math.max(0, remaining - floor);
			boundBy = "floor";
		} else if (!extraUsage.uncapped && remaining !== undefined) {
			headroom = remaining;
			boundBy = "provider";
		}
		if (budgetLeft !== undefined && (headroom === undefined || budgetLeft < headroom)) {
			headroom = budgetLeft;
			boundBy = "budget";
		}
	}

	const metadata = report.metadata;
	const payloadFetchedAt = metadata?.payloadFetchedAt;
	const asOf =
		typeof payloadFetchedAt === "number" && Number.isFinite(payloadFetchedAt)
			? payloadFetchedAt
			: metadata?.headersUpdatedAt === undefined && Number.isFinite(report.fetchedAt)
				? report.fetchedAt
				: undefined;

	return {
		...(extraUsage.limitId === undefined ? {} : { limitId: extraUsage.limitId }),
		unit: extraUsage.unit,
		capacity: extraUsage.capacity,
		state: classification.extra,
		...(classification.stop === undefined ? {} : { stop: classification.stop }),
		...(used === undefined ? {} : { used }),
		...(cap === undefined ? {} : { cap }),
		...(remaining === undefined ? {} : { remaining }),
		uncapped: extraUsage.uncapped,
		...(floor === undefined ? {} : { floor }),
		floorIgnored,
		...(budget === undefined ? {} : { budget }),
		...(budgetLeft === undefined ? {} : { budgetLeft }),
		...(headroom === undefined ? {} : { headroom }),
		...(boundBy === undefined ? {} : { boundBy }),
		unbounded: classification.extra === "available" && extraUsage.uncapped && budget === undefined,
		...(classification.stop === "refused" && extraUsageBlockedUntil !== undefined
			? { blockedUntil: extraUsageBlockedUntil }
			: {}),
		...(asOf === undefined ? {} : { asOf }),
		stale: asOf !== undefined && nowMs - asOf > USAGE_REPORT_TTL_MS * 1.25,
	};
}

/** Sort order for account funding tiers, from plan allowance through spent capacity. */
export function fundingTierRank(tier: UsageFundingTier | undefined): number {
	switch (tier) {
		case "extra":
			return 1;
		case "extra-past-floor":
			return 2;
		case "spent":
			return 3;
		case "allowance":
		case undefined:
			return 0;
	}
}

/** Whether a funding tier may serve under the caller's paid-usage allowance. */
export function fundingTierAllowed(tier: UsageFundingTier | undefined, allowance: ExtraUsageAllowance): boolean {
	return tier !== "extra-past-floor" || allowance === "past-floor";
}

/** Read a finite reset deadline from a usage window. */
export function windowResetAt(window: UsageLimit["window"]): number | undefined {
	if (!window) return undefined;
	if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		return window.resetsAt;
	}
	return undefined;
}

/** Normalize a window’s used fraction for ranking. */
export function normalizeUsageFraction(limit: UsageLimit | undefined): number {
	const usedFraction = limit?.amount.usedFraction;
	if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
		return 0.5;
	}
	return Math.min(Math.max(usedFraction, 0), 1);
}

/** Select usage limits for account reserve evaluation. */
export function reserveUsageLimits(
	strategy: CredentialRankingStrategy | undefined,
	report: UsageReport,
	rankingContext: CredentialRankingContext,
): UsageLimit[] {
	if (strategy) {
		return (
			strategy.scopeLimitsForReserve?.(report, rankingContext) ?? scopedUsageLimits(strategy, report, rankingContext)
		);
	}
	return report.limits.filter(limit => {
		const modelId = limit.scope.modelId;
		return modelId === undefined || rankingContext.modelId === undefined || modelId === rankingContext.modelId;
	});
}

/** Measure currently available quota outside expired windows. */
export function remainingUsageFraction(
	strategy: CredentialRankingStrategy | undefined,
	report: UsageReport | null,
	rankingContext: CredentialRankingContext,
	nowMs: number,
): number | undefined {
	if (!report) return undefined;
	return remainingUsageFractionForLimits(
		currentUsageLimits(reserveUsageLimits(strategy, report, rankingContext), report.fetchedAt, nowMs),
	);
}

/**
 * Computes the required drain rate: `headroomFraction / remainingHours` —
 * how fast the window's remaining quota must be consumed to fully use it
 * before it resets and expires. Higher = more headroom at risk of expiring
 * unused = ranked first, so selection chases quota that is about to be
 * wasted ("use it or lose it"). Without a reset clock, the full window
 * duration is assumed to remain so clocked and clockless scores stay comparable.
 */
export function windowRequiredDrain(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
	const headroom = 1 - normalizeUsageFraction(limit);
	if (headroom <= 0) return 0;
	const resetAt = windowResetAt(limit?.window);
	const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
	let remainingMs = resetAt === undefined ? durationMs : resetAt - nowMs;
	if (Number.isFinite(durationMs) && durationMs > 0) {
		remainingMs = Math.min(remainingMs, durationMs);
	}
	// Floor at one minute: a stale report whose reset already passed must
	// not produce an unbounded urgency score.
	const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
	return headroom / remainingHours;
}

/**
 * Match an aggregate report to one OAuth credential by its account identity.
 * A provider's lone identity-free report can stand in for a lone credential.
 */
export function matchUsageReport(
	reports: readonly UsageReport[],
	provider: Provider,
	credential: OAuthCredential,
): UsageReport | null {
	const all = reports.filter(report => report.provider === provider);
	if (all.length === 0) return null;
	// Org precedence, decisive on EITHER side: an org-scoped credential may
	// only take its own org's report, and an org-less (legacy) credential may
	// only take org-less reports — the shared email/account would otherwise
	// hand one subscription the OTHER subscription's pool (e.g. mark healthy
	// Max exhausted via Team's report, or rank a legacy row on a sibling's
	// numbers).
	const orgId = credential.orgId?.trim().toLowerCase();
	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	if (orgId) {
		const sameOrg: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of all) {
			const metaOrg = readMetadataString((report.metadata ?? {}) as Record<string, unknown>, "orgId");
			if (metaOrg) {
				sawReportOrg = true;
				if (metaOrg.toLowerCase() === orgId) sameOrg.push(report);
			}
		}
		// Org-attributed reports exist: the shared org is a GATE, not a match.
		// Two Team members share the org id while drawing on per-user pools,
		// so the credential's own base identity must still line up inside the
		// same-org subset — a lone sibling report is NOT ours. An org-only
		// credential (no base identifiers) takes the lone same-org report and
		// treats several as ambiguous. None in our org → "no usage data"
		// rather than mis-attributing another org's pool.
		if (sawReportOrg) {
			if (accountId || email || projectId) {
				for (const report of sameOrg) {
					if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
				}
				return null;
			}
			return sameOrg.length === 1 ? sameOrg[0]! : null;
		}
		// No surviving report carries an org at all: presence mismatch is a
		// non-match too — the sole org-less report may be a legacy sibling
		// row's pool, and handing it to a scoped credential would rank/block
		// on the wrong quota. "No usage data" degrades gracefully instead.
		return null;
	}
	const candidates = all.filter(
		report => !readMetadataString((report.metadata ?? {}) as Record<string, unknown>, "orgId"),
	);
	if (candidates.length === 0) return null;
	// The sole report stands in for a credential it shares no identity field
	// with; otherwise identity decides, because a report naming another email,
	// account or project is a sibling's pool whose fetch succeeded where this
	// credential's failed.
	if (
		all.length === 1 &&
		candidates.length === 1 &&
		!reportHasComparableIdentity(candidates[0], accountId, email, projectId)
	) {
		return candidates[0];
	}
	for (const report of candidates) {
		if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
	}
	return null;
}

export function reportMatchesIdentity(
	report: UsageReport,
	accountId: string | undefined,
	email: string | undefined,
	projectId: string | undefined,
): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	const metaEmail = readMetadataString(metadata, "email")?.toLowerCase();
	// Email identifies the member within shared Team workspace account/org ids.
	// When both sides provide it, a mismatch is decisive.
	if (email && metaEmail) return metaEmail === email;
	if (accountId) {
		const metaAccount = readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id");
		if (metaAccount && metaAccount.toLowerCase() === accountId) return true;
		for (const limit of report.limits) {
			if (limit.scope.accountId?.trim().toLowerCase() === accountId) return true;
		}
	}
	if (projectId) {
		const metaProject = readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id");
		if (metaProject && metaProject.toLowerCase() === projectId) return true;
		for (const limit of report.limits) {
			if (limit.scope.projectId?.trim().toLowerCase() === projectId) return true;
		}
	}
	return false;
}

/** Whether the report names an email, account or project the caller can compare against. */
export function reportHasComparableIdentity(
	report: UsageReport,
	accountId: string | undefined,
	email: string | undefined,
	projectId: string | undefined,
): boolean {
	const metadata = report.metadata ?? {};
	if (email && readMetadataString(metadata, "email")) return true;
	if (accountId) {
		if (readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id")) return true;
		if (report.limits.some(limit => limit.scope.accountId?.trim())) return true;
	}
	if (projectId) {
		if (readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id")) return true;
		if (report.limits.some(limit => limit.scope.projectId?.trim())) return true;
	}
	return false;
}

export function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
