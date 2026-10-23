import type {
	PaidUsageView,
	UsageLimit,
	UsageReport,
	UsageResetCreditDetail,
	UsageResetCredits,
} from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";

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

/** Expiry (epoch ms) of a credit that still banks a reset, whether or not it can be spent now. */
export function bankedResetCreditExpiryMs(credit: UsageResetCreditDetail): number | undefined {
	if (!credit.expiresAt || credit.remainingCount === 0 || credit.status === "redeemed") return undefined;
	const expiryMs = Date.parse(credit.expiresAt);
	return Number.isFinite(expiryMs) ? expiryMs : undefined;
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
		const expiryMs = bankedResetCreditExpiryMs(credit);
		if (expiryMs === undefined) continue;
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

// =============================================================================
// Paid extra usage
// =============================================================================

/** Status tone of a paid-usage line or summary; each surface maps it onto its own colors. */
export type PaidUsageTone = "success" | "warning" | "error" | "dim";

/** One account's paid extra usage, worded the same on every usage surface. */
export interface PaidUsageLine {
	/** The figure, each configured limit, then the verdict, e.g. `$50.00 left of $200.00 cap · floor $10.00 → $40.00 usable before floor`. */
	text: string;
	tone: PaidUsageTone;
	/** How old the paid figures are; absent while they are 90 s old or less. */
	age?: { text: string; tone: PaidUsageTone };
}

/** Paid figures this old or newer print no age, the same threshold `omp usage` uses for its freshness note. */
const PAID_USAGE_FRESH_MS = 90_000;

const CREDIT_AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** `$12.34` for USD, `489.25 credits` for credits. */
export function formatPaidUsageAmount(value: number, unit: PaidUsageView["unit"]): string {
	return unit === "usd" ? `$${value.toFixed(2)}` : `${CREDIT_AMOUNT.format(value)} credits`;
}

/** What the provider reports: room under a spend cap, a credit balance, or why there is none. */
function paidUsageFigure(view: PaidUsageView): string {
	const amount = (value: number): string => formatPaidUsageAmount(value, view.unit);
	if (view.capacity === "spend-cap") {
		if (view.stop === "disabled") return "paid usage off";
		if (view.stop === "cap-reached") {
			return view.cap === undefined ? "spend cap reached" : `${amount(view.cap)} cap reached`;
		}
		if (view.uncapped) {
			return view.used === undefined
				? "spend not reported, no cap reported"
				: `${amount(view.used)} spent, no cap reported`;
		}
		if (view.remaining !== undefined) {
			return view.cap === undefined
				? `${amount(view.remaining)} left under cap`
				: `${amount(view.remaining)} left of ${amount(view.cap)} cap`;
		}
		return view.cap === undefined ? "remaining not reported" : `${amount(view.cap)} cap, remaining not reported`;
	}
	if (view.stop === "disabled") return "no credits";
	if (view.stop === "cap-reached") {
		// A balance at or below zero says so itself; a positive one means the
		// provider's credit limit is what stopped it.
		if (view.remaining !== undefined && view.remaining <= 0) return `${amount(view.remaining)} left`;
		return view.remaining === undefined
			? "credit limit reached"
			: `credit limit reached, ${amount(view.remaining)} left`;
	}
	if (view.uncapped) return "unlimited credits";
	return view.remaining === undefined ? "balance not reported" : `${amount(view.remaining)} left`;
}

/** The account's configured floor and budget, in the provider's unit. */
function paidUsageSettings(view: PaidUsageView): string[] {
	const amount = (value: number): string => formatPaidUsageAmount(value, view.unit);
	const settings: string[] = [];
	if (view.floor !== undefined) {
		settings.push(
			view.floorIgnored
				? `floor ${amount(view.floor)} not applied (no cap reported)`
				: `floor ${amount(view.floor)}`,
		);
	}
	if (view.budget !== undefined) {
		settings.push(
			view.budgetLeft === undefined
				? `budget ${amount(view.budget)}`
				: `budget ${amount(view.budget)}, ${amount(view.budgetLeft)} left`,
		);
	}
	return settings;
}

const HELD_VERDICT: Readonly<Record<string, string>> = {
	floor: "held at floor",
	budget: "held at budget",
	"floor-unreported": "held, remaining not reported",
	"budget-unreported": "held, spend not reported",
};

/**
 * Selection's answer for the account once plan allowance is spent: shown when
 * paid usage is held or refused, or when a floor or budget is configured.
 */
function paidUsageVerdict(view: PaidUsageView, nowMs: number): { text: string; tone: PaidUsageTone } | undefined {
	if (view.stop === "refused") {
		const heldMs = view.blockedUntil === undefined ? 0 : view.blockedUntil - nowMs;
		return {
			text: heldMs > 0 ? `refused by provider, held ${formatDuration(heldMs)}` : "refused by provider",
			tone: "error",
		};
	}
	if (view.state === "unavailable") return undefined;
	if (view.state === "past-floor") {
		return { text: (view.stop !== undefined ? HELD_VERDICT[view.stop] : undefined) ?? "held", tone: "warning" };
	}
	if (view.floor === undefined && view.budget === undefined) return undefined;
	if (view.unbounded) return { text: "no omp limit", tone: "success" };
	if (view.headroom === undefined) return { text: "usable amount not reported", tone: "success" };
	const usable = formatPaidUsageAmount(view.headroom, view.unit);
	if (view.boundBy === "floor") return { text: `${usable} usable before floor`, tone: "success" };
	if (view.boundBy === "budget") return { text: `${usable} usable before budget`, tone: "success" };
	return {
		text: view.capacity === "spend-cap" ? `${usable} usable before cap` : `${usable} usable`,
		tone: "success",
	};
}

/** `as of 4m ago`, `stale, as of 2h ago` or `age unknown`; nothing while the figures are fresh. */
function paidUsageAge(view: PaidUsageView, nowMs: number): PaidUsageLine["age"] {
	if (view.asOf === undefined) return { text: "age unknown", tone: "dim" };
	const ageMs = nowMs - view.asOf;
	if (ageMs <= PAID_USAGE_FRESH_MS) return undefined;
	const asOf = `as of ${formatDuration(ageMs)} ago`;
	return view.stale ? { text: `stale, ${asOf}`, tone: "warning" } : { text: asOf, tone: "dim" };
}

/**
 * One account's paid extra usage: the figure, then each configured limit,
 * then `→` and selection's verdict, toned by that verdict. An account with no
 * view (it reports no paid usage at all) reads `not reported`.
 */
export function formatPaidUsageLine(view: PaidUsageView | undefined, nowMs: number): PaidUsageLine {
	if (!view) return { text: "not reported", tone: "dim" };
	const verdict = paidUsageVerdict(view, nowMs);
	const text = [paidUsageFigure(view), ...paidUsageSettings(view)].join(" · ");
	const tone: PaidUsageTone =
		verdict?.tone ?? (view.stop === "disabled" ? "dim" : view.stop === "cap-reached" ? "error" : "success");
	const age = paidUsageAge(view, nowMs);
	return {
		text: verdict ? `${text} → ${verdict.text}` : text,
		tone,
		...(age ? { age } : {}),
	};
}

/** The whole line as plain text, age included. */
export function paidUsageLineText(line: PaidUsageLine): string {
	return line.age ? `${line.text} · ${line.age.text}` : line.text;
}

/**
 * The once-per-provider note that paid figures are cached provider metering,
 * so nothing on screen reads as a hard spending limit. `heldServeLast` is
 * `retry.extraUsageBelowFloor`.
 */
export function formatPaidUsageCaveat(heldServeLast: boolean): string {
	const caveat =
		"Paid figures are provider-reported and refresh about every 5 minutes, so spend between refreshes can pass a floor or budget.";
	return heldServeLast ? `${caveat} Held accounts still serve when no fallback model remains.` : caveat;
}

/** One provider's paid extra usage, for its usage card. */
export interface PaidUsageSummary {
	/** Parts in display order: what omp may still spend (when anything is), then the account counts. */
	parts: string[];
	tone: PaidUsageTone;
}

/**
 * Summarize one provider's accounts: what omp may still spend automatically,
 * then how many accounts are unbounded, held, refused, at cap, off, or did not
 * report. `undefined` when no account reports paid usage. An account selection
 * would spend from without a reported amount counts as not reported.
 */
export function summarizePaidUsage(views: readonly (PaidUsageView | undefined)[]): PaidUsageSummary | undefined {
	const first = views.find((view): view is PaidUsageView => view !== undefined);
	if (!first) return undefined;
	let left = 0;
	let funded = 0;
	let unbounded = 0;
	let held = 0;
	let refused = 0;
	let atCap = 0;
	let off = 0;
	let notReported = 0;
	for (const view of views) {
		if (!view) notReported++;
		else if (view.stop === "disabled") off++;
		else if (view.stop === "cap-reached") atCap++;
		else if (view.stop === "refused") refused++;
		else if (view.state === "past-floor") held++;
		else if (view.state !== "available") notReported++;
		else if (view.unbounded) unbounded++;
		else if (view.headroom === undefined) notReported++;
		else {
			left += view.headroom;
			funded++;
		}
	}
	const balance = first.capacity === "balance";
	const counted = (count: number, label: string): string[] => (count > 0 ? [`${count} ${label}`] : []);
	const parts = [
		...(funded > 0 ? [`${formatPaidUsageAmount(left, first.unit)} left`] : []),
		...counted(unbounded, balance ? "unlimited" : "uncapped"),
		...counted(held, "held"),
		...counted(refused, "refused"),
		...counted(atCap, balance ? "empty" : "at cap"),
		...counted(off, balance ? "no credits" : "off"),
		...counted(notReported, "not reported"),
	];
	const tone: PaidUsageTone =
		funded > 0 || unbounded > 0 ? "success" : held > 0 ? "warning" : refused > 0 || atCap > 0 ? "error" : "dim";
	return { parts, tone };
}

/** The lead every summary starts with; continuation lines indent to its width. */
const PAID_SUMMARY_LEAD = "paid ";

/** `paid $90.00 left · 1 uncapped · 1 held` on one line. */
export function formatPaidUsageSummary(summary: PaidUsageSummary): string {
	return `${PAID_SUMMARY_LEAD}${summary.parts.join(" · ")}`;
}

/**
 * The summary wrapped to `width`, breaking only between parts so no amount or
 * count is split or dropped. Continuation lines indent under the first part:
 *
 *     paid $90.00 left · 1 uncapped · 1 held
 *          1 refused · 1 at cap · 1 off
 *
 * Only a single part wider than the whole line is truncated.
 */
export function wrapPaidUsageSummary(summary: PaidUsageSummary, width: number): string[] {
	const indent = " ".repeat(PAID_SUMMARY_LEAD.length);
	const lines: string[] = [];
	let line = "";
	for (const part of summary.parts) {
		const joined = line ? `${line} · ${part}` : `${PAID_SUMMARY_LEAD}${part}`;
		if (!line || visibleWidth(joined) <= width) {
			line = joined;
			continue;
		}
		lines.push(line);
		line = `${indent}${part}`;
	}
	if (line) lines.push(line);
	return lines.map(text =>
		visibleWidth(text) > width ? truncateToWidth(text, Math.max(0, width), Ellipsis.Unicode) : text,
	);
}

/**
 * Pair paid views with the reports {@link collapseSharedUsageReports} returned
 * for the same input. It keeps one output per input, in order, so
 * `collapsed[i]` belongs to `paid[i]`. No views pairs nothing, which leaves
 * every row a plan row.
 */
export function pairPaidUsage(
	collapsed: readonly UsageReport[],
	paid: readonly (PaidUsageView | undefined)[],
): Map<UsageReport, PaidUsageView> {
	const pairs = new Map<UsageReport, PaidUsageView>();
	for (let index = 0; index < collapsed.length; index++) {
		const view = paid[index];
		if (view) pairs.set(collapsed[index]!, view);
	}
	return pairs;
}

/** The report's paid row: the limit whose id is `view.limitId`. */
export function paidUsageLimit(report: UsageReport, view: PaidUsageView | undefined): UsageLimit | undefined {
	const paidId = view?.limitId;
	return paidId === undefined ? undefined : report.limits.find(limit => limit.id === paidId);
}

/** Every row except the paid one: what plan remaining, reserve state, capacity and quota rows read. */
export function planUsageLimits(report: UsageReport, view: PaidUsageView | undefined): UsageLimit[] {
	const paid = paidUsageLimit(report, view);
	return paid ? report.limits.filter(limit => limit !== paid) : report.limits;
}

/** The report with its plan rows only; the same object when it has no paid row. */
export function withPlanUsageLimits(report: UsageReport, view: PaidUsageView | undefined): UsageReport {
	const limits = planUsageLimits(report, view);
	return limits === report.limits ? report : { ...report, limits };
}
