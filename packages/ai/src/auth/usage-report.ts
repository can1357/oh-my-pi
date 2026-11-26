import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { resolveUsedFraction } from "../usage";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageLimit,
	UsageLogger,
	UsageReport,
} from "../usage";
import type { OAuthAccountIdentity } from "./types";

/** Read a string identity field from report metadata. */
export function usageReportMetadataValue(report: UsageReport, key: string): string | undefined {
	const metadata = report.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const value = metadata[key];
	return typeof value === "string" ? value.trim() : undefined;
}

/** Resolve a single report-scoped account ID. */
export function usageReportScopeAccountId(report: UsageReport): string | undefined {
	return usageReportScopeId(report, "accountId") ?? undefined;
}

// Null distinguishes conflicting scopes from a report that supplies no scope ID.
function usageReportScopeId(report: UsageReport, key: "accountId" | "projectId"): string | null | undefined {
	let id: string | undefined;
	for (const limit of report.limits) {
		const value = limit.scope[key]?.trim();
		if (!value) continue;
		if (id !== undefined && id !== value) return null;
		id = value;
	}
	return id;
}

const MEMBER_ID_FIELDS: readonly ("email" | "accountId" | "projectId")[] = ["email", "accountId", "projectId"];

/**
 * Attribute usage only when every comparable member identifier agrees and at least one matches.
 * Account and project IDs fall back to the selected limit's scope, or a single common scope ID
 * when matching the whole report. A shared workspace or project cannot override an email mismatch.
 */
export function matchesUsageAccount(
	report: UsageReport,
	account: OAuthAccountIdentity & { provider?: string },
	options?: {
		/** Match a column instead of attributing the whole report. */
		limit?: UsageLimit;
		/** Block healing accepts legacy reports or credentials without an org ID. */
		allowMissingOrg?: boolean;
		/** Active markers may use an org-only session identity. */
		allowOrgOnly?: boolean;
	},
): boolean {
	if (account.provider !== undefined && report.provider !== account.provider) return false;
	const org = account.orgId?.trim().toLowerCase() || undefined;
	const reportOrg = usageReportMetadataValue(report, "orgId")?.toLowerCase() || undefined;
	if (org !== reportOrg && (!options?.allowMissingOrg || (org && reportOrg))) return false;

	let comparable = false;
	let hasMemberId = false;
	for (const field of MEMBER_ID_FIELDS) {
		const id = account[field]?.trim().toLowerCase();
		if (!id) continue;
		hasMemberId = true;

		let reportId = usageReportMetadataValue(report, field);
		if (!reportId && field === "accountId") reportId = usageReportMetadataValue(report, "account_id");
		if (!reportId && field !== "email") {
			const scoped = options?.limit ? options.limit.scope[field]?.trim() : usageReportScopeId(report, field);
			if (scoped === null) return false;
			reportId = scoped;
		}
		if (!reportId) continue;
		if (reportId.toLowerCase() !== id) return false;
		comparable = true;
	}
	if (!hasMemberId) return options?.allowOrgOnly === true && !!org && org === reportOrg;
	return comparable;
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
	const projectId = usageReportMetadataValue(report, "projectId") ?? usageReportScopeId(report, "projectId");
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
				} else if (key === "credentialId" && value !== mergedMetadata.credentialId) {
					// Two stored rows for the same account merged into one
					// report: keep every contributing row id so
					// credential-scoped attribution (the status-line usage
					// segment) still matches each pinned row.
					const ids = new Set<number>(
						Array.isArray(mergedMetadata.credentialIds)
							? [...(mergedMetadata.credentialIds as number[])]
							: typeof mergedMetadata.credentialId === "number"
								? [mergedMetadata.credentialId]
								: [],
					);
					if (typeof value === "number") ids.add(value);
					mergedMetadata.credentialIds = [...ids].sort((a, b) => a - b);
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
	const usedFractions = reserveUsageLimits(strategy, report, rankingContext)
		.filter(limit => {
			const resetsAt = limit.window?.resetsAt;
			return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
		})
		.map(resolveUsedFraction)
		.filter((fraction): fraction is number => fraction !== undefined);
	return usedFractions.length === 0 ? undefined : Math.max(0, 1 - Math.max(...usedFractions));
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
