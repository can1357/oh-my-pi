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
