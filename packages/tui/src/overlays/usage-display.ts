import type { UsageLimit, UsageReport, UsageResetCredits } from "@oh-my-pi/pi-ai";

/** Include the usage tier in a limit title unless its label already names it. */
export function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function collapseSharedLimits(limits: UsageLimit[]): UsageLimit[] {
	const seenGroups = new Set<string>();
	let collapsed: UsageLimit[] | undefined;

	for (let index = 0; index < limits.length; index++) {
		const limit = limits[index]!;
		const group = limit.scope.sharedGroup;
		if (group !== undefined && seenGroups.has(group)) {
			collapsed ??= limits.slice(0, index);
			continue;
		}
		if (group !== undefined) seenGroups.add(group);
		collapsed?.push(limit);
	}

	return collapsed ?? limits;
}

/** Human-readable quota scope for a normalized saved-reset window ID. */
export function formatUsageResetWindow(windowId: string): string {
	switch (windowId) {
		case "anthropic:5h":
			return "Claude 5h";
		case "anthropic:7d":
			return "Claude weekly";
		case "anthropic:7d:opus":
			return "Claude Opus weekly";
		case "anthropic:7d:sonnet":
			return "Claude Sonnet weekly";
		default:
			return windowId;
	}
}

/** Saved inventory and current eligibility shared by every usage display. */
export interface UsageResetSummary {
	bankedCount: number;
	redeemableCount: number;
	soonestExpiry?: string;
	unavailableReason?: string;
}

/**
 * Normalize old count-only and current provider reset metadata for display.
 * `availableCount` is banked inventory; `redeemableCount` is the subset that
 * may be spent now. Older providers used `availableCount` for both.
 */
export function summarizeUsageResetCredits(
	reset: UsageResetCredits | undefined,
	nowMs = Date.now(),
): UsageResetSummary | undefined {
	if (!reset) return undefined;
	const bankedCount = Math.max(0, Math.trunc(reset.availableCount));
	const redeemableCount = Math.max(0, Math.trunc(reset.redeemableCount ?? reset.availableCount));
	let soonestExpiry: string | undefined;
	let soonestExpiryMs = Number.POSITIVE_INFINITY;
	let latestExpired: string | undefined;
	let latestExpiredMs = Number.NEGATIVE_INFINITY;
	for (const credit of reset.credits ?? []) {
		if (!credit.expiresAt || credit.remainingCount === 0 || credit.status === "redeemed") continue;
		const expiryMs = Date.parse(credit.expiresAt);
		if (!Number.isFinite(expiryMs)) continue;
		if (expiryMs > nowMs && expiryMs < soonestExpiryMs) {
			soonestExpiryMs = expiryMs;
			soonestExpiry = credit.expiresAt;
		} else if (expiryMs <= nowMs && expiryMs > latestExpiredMs) {
			latestExpiredMs = expiryMs;
			latestExpired = credit.expiresAt;
		}
	}
	soonestExpiry ??= latestExpired;
	const selectedCredit = reset.nextCreditId
		? reset.credits?.find(credit => credit.id === reset.nextCreditId)
		: (reset.credits?.find(credit => credit.usable !== false) ?? reset.credits?.[0]);
	const unavailableReason =
		reset.reason ??
		(reset.cooldownUntil ? `cooldown until ${reset.cooldownUntil}` : undefined) ??
		(selectedCredit?.blocking?.length
			? `blocked by ${selectedCredit.blocking.map(formatUsageResetWindow).join(", ")}`
			: undefined) ??
		(selectedCredit?.status && selectedCredit.status !== "available" ? selectedCredit.status : undefined) ??
		(reset.eligible === false ? "not eligible" : undefined) ??
		(bankedCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined);
	return {
		bankedCount,
		redeemableCount,
		soonestExpiry,
		unavailableReason,
	};
}

/** Collapse routing-specific copies of a shared quota for user-facing usage views. */
export function collapseSharedUsageReports(reports: UsageReport[]): UsageReport[] {
	let collapsed: UsageReport[] | undefined;

	for (let index = 0; index < reports.length; index++) {
		const report = reports[index]!;
		const limits = collapseSharedLimits(report.limits);
		const displayReport = limits === report.limits ? report : { ...report, limits };
		if (displayReport !== report) {
			collapsed ??= reports.slice(0, index);
		}
		collapsed?.push(displayReport);
	}

	return collapsed ?? reports;
}

// ---------------------------------------------------------------------------
// Usage report presenter
//
// Theme-free facts shared by every usage surface (themed TUI grid, ACP plain
// text, `omp usage` CLI). Surfaces keep only their color, prefix, and padding;
// the strings and precedence below are the already-agreed rendering rules.
// ---------------------------------------------------------------------------

/**
 * Window label worth showing beside a limit title, or `undefined` when the title
 * already names the window, the provider only reports a generic quota window, or
 * there is no window at all.
 */
export function usageWindowSuffix(label: string, windowLabel: string | undefined): string | undefined {
	if (!windowLabel) return undefined;
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window" || normalizedLabel.includes(normalizedWindow)) return undefined;
	return windowLabel;
}

/** Organization or workspace an account belongs to, when the provider reports one. */
export function usageAccountOrg(report: UsageReport): string | undefined {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	return typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" && orgId ? orgId : undefined;
}

/** Which account a limit row belongs to, and whether an organization may qualify it. */
export interface UsageAccountIdentity {
	identity: string;
	/** Set when the identity itself names the account, so an org qualifies it. */
	orgQualifies: boolean;
}

/**
 * Resolve the account a limit belongs to: provider metadata first, then the
 * limit's own scope, then a positional `account N` label. `limit` is omitted for
 * reports that carry no limits.
 */
export function resolveUsageAccountIdentity(
	report: UsageReport,
	limit: UsageLimit | undefined,
	index: number,
): UsageAccountIdentity {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return { identity: email, orgQualifies: true };
	const metaAccountId = report.metadata?.accountId;
	const accountId = typeof metaAccountId === "string" && metaAccountId ? metaAccountId : limit?.scope.accountId;
	if (typeof accountId === "string" && accountId) return { identity: accountId, orgQualifies: true };
	const metaProjectId = report.metadata?.projectId;
	const projectId = typeof metaProjectId === "string" && metaProjectId ? metaProjectId : limit?.scope.projectId;
	if (typeof projectId === "string" && projectId) return { identity: projectId, orgQualifies: false };
	return { identity: `account ${index + 1}`, orgQualifies: false };
}

/** When an account's oldest saved reset credits lapse, split for per-surface formatting. */
export interface UsageResetExpiry {
	remainingMs: number;
	/** `YYYY-MM-DD` portion of the expiry timestamp. */
	date: string;
}

/** Soonest expiry of a reset summary, or `undefined` when nothing is pending. */
export function usageResetExpiry(resets: UsageResetSummary, nowMs: number): UsageResetExpiry | undefined {
	if (!resets.soonestExpiry) return undefined;
	return { remainingMs: Date.parse(resets.soonestExpiry) - nowMs, date: resets.soonestExpiry.slice(0, 10) };
}

/** Reset-credit inventory of one account, before any color or line prefix. */
export interface UsageResetCreditView {
	/** Account the credits belong to: metadata email/account id, else `account`. */
	identity: string;
	/** Organization qualifying `identity`, only when it differs from it. */
	org?: string;
	bankedCount: number;
	redeemableCount: number;
	expiry?: UsageResetExpiry;
	unavailableReason?: string;
}

/** Reset-credit summary for a report, or `undefined` when it has nothing banked. */
export function usageResetCreditView(report: UsageReport, nowMs: number): UsageResetCreditView | undefined {
	const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
	if (!resets || resets.bankedCount <= 0) return undefined;
	const email = report.metadata?.email;
	const accountId = report.metadata?.accountId;
	const identity =
		typeof email === "string" && email ? email : typeof accountId === "string" && accountId ? accountId : "account";
	const org = usageAccountOrg(report);
	return {
		identity,
		org: org && org !== identity ? org : undefined,
		bankedCount: resets.bankedCount,
		redeemableCount: resets.redeemableCount,
		expiry: usageResetExpiry(resets, nowMs),
		unavailableReason: resets.unavailableReason,
	};
}
