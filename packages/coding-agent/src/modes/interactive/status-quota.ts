/**
 * The `usage` segment's quota: the active account's subscription windows
 * (5-hour, daily, 7-day, monthly) and its banked reset credits, picked out of
 * the session's usage reports.
 *
 * Limits are filtered to the active provider, account and model; among the
 * remaining model/tier scopes, exact-model groups outrank provider-wide ones
 * and untiered groups outrank tiered ones.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { summarizeUsageResetCredits } from "../../session/usage-display";
import type { StatusQuota } from "../../ui/status/facts";
import type { CodexResetUsageSnapshot } from "../view-model/overlays/codex-reset-fireworks";
import type { StatusAccountIdentity, StatusLineHost } from "../view-model/status-line/host";

/**
 * Providers whose subscription quota is a single monthly bucket. Providers that
 * merely report a monthly side-counter (GitHub Copilot premium requests) stay out.
 */
const MONTHLY_SUBSCRIPTION_PROVIDERS: Readonly<Record<string, true>> = {
	"alibaba-token-plan": true,
	cursor: true,
	"opencode-go": true,
};

type WindowClass = "5h" | "daily" | "7d" | "monthly";

interface WindowCandidate {
	readonly id?: string;
	readonly windowClass: WindowClass;
	readonly fraction: number;
	readonly resetsAt?: number;
}

interface ScopeGroup {
	readonly priority: number;
	readonly tier?: string;
	readonly candidates: WindowCandidate[];
}

/** Lowercased trimmed string, or undefined for blanks and non-strings. */
export function normalizeScopeValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Whether `report` belongs to exactly `identity`: every identifier the identity
 * carries must be present on the report and equal.
 */
export function reportMatchesExactIdentity(report: UsageReport, identity: StatusAccountIdentity | undefined): boolean {
	if (!identity) return false;
	const accountId = normalizeScopeValue(identity.accountId);
	const email = normalizeScopeValue(identity.email);
	const projectId = normalizeScopeValue(identity.projectId);
	const orgId = normalizeScopeValue(identity.orgId);
	if (!accountId && !email && !projectId && !orgId) return false;
	const metadata = report.metadata ?? {};
	const reportAccountId = normalizeScopeValue(metadata.accountId) ?? normalizeScopeValue(metadata.account_id);
	const reportProjectId = normalizeScopeValue(metadata.projectId) ?? normalizeScopeValue(metadata.project_id);
	if (accountId && reportAccountId !== accountId) return false;
	if (email && normalizeScopeValue(metadata.email) !== email) return false;
	if (projectId && reportProjectId !== projectId) return false;
	if (orgId && normalizeScopeValue(metadata.orgId) !== orgId) return false;
	return true;
}

function windowClassOf(
	windowId: unknown,
	durationMs: number | undefined,
	monthlyProvider: boolean,
): WindowClass | undefined {
	if (windowId === "5h" || windowId === "7d") return windowId;
	if (windowId === "daily" || windowId === "24h" || windowId === "1d") return "daily";
	if (durationMs !== undefined) {
		if (Math.abs(durationMs - 5 * 3_600_000) <= 60_000) return "5h";
		if (Math.abs(durationMs - 86_400_000) <= 60_000) return "daily";
		if (Math.abs(durationMs - 7 * 86_400_000) <= 60_000) return "7d";
	}
	if (monthlyProvider && (windowId === "monthly" || windowId === "30d")) return "monthly";
	return undefined;
}

/** Cursor's monthly rails: the personal dashboard ones win over legacy per-model fractions. */
function cursorMonthlyPriority(limitId: string | undefined): number {
	if (limitId === "cursor:usd:individual-auto") return 0;
	if (limitId === "cursor:usd:individual-plan" || limitId === "cursor:usd:individual-overall") return 1;
	if (limitId?.startsWith("cursor:usd:individual-")) return 2;
	return 3;
}

function isUsageReport(value: unknown): value is UsageReport {
	return (
		!!value && typeof value === "object" && "provider" in value && "limits" in value && Array.isArray(value.limits)
	);
}

/** The quota the `usage` segment shows, or undefined when the reports carry none for the active account. */
export function quotaFromReports(
	reports: unknown,
	context: { readonly provider?: string; readonly modelId?: string; readonly identity?: StatusAccountIdentity },
	host: Pick<StatusLineHost, "limitMatchesActiveAccount" | "classifyResetExpiry">,
	now: number,
): StatusQuota | undefined {
	if (!Array.isArray(reports)) return undefined;
	const activeModelId = normalizeScopeValue(context.modelId);
	const monthlyProvider = context.provider !== undefined && MONTHLY_SUBSCRIPTION_PROVIDERS[context.provider] === true;
	const groups = new Map<string, ScopeGroup>();
	const resetReports: UsageReport[] = [];
	for (const report of reports) {
		if (!isUsageReport(report)) continue;
		if (context.provider && report.provider !== context.provider) continue;
		if (report.resetCredits && (!context.identity || reportMatchesExactIdentity(report, context.identity))) {
			resetReports.push(report);
		}
		for (const limit of report.limits) {
			if (!limit?.scope || !limit.amount) continue;
			if (context.identity && !host.limitMatchesActiveAccount(report, limit, context.identity)) continue;
			const fraction = limit.amount.usedFraction;
			if (typeof fraction !== "number") continue;
			const durationMs = typeof limit.window?.durationMs === "number" ? limit.window.durationMs : undefined;
			const windowClass = windowClassOf(limit.scope.windowId, durationMs, monthlyProvider);
			if (!windowClass) continue;
			const modelId = normalizeScopeValue(limit.scope.modelId);
			if (modelId && modelId !== activeModelId) continue;
			const rawTier = limit.scope.tier;
			const planType = report.metadata?.planType;
			// Scoped tiers win; plan-wide tiers label otherwise-untiered windows.
			const tier =
				(typeof rawTier === "string" && rawTier.trim() ? rawTier.trim() : undefined) ??
				(typeof planType === "string" && planType.trim() ? planType.trim() : undefined);
			const normalizedTier = normalizeScopeValue(tier);
			const key = `${modelId ?? ""}\0${normalizedTier ?? ""}`;
			const priority = modelId ? (normalizedTier ? 1 : 0) : normalizedTier ? 3 : 2;
			const resetsAt = typeof limit.window?.resetsAt === "number" ? limit.window.resetsAt : undefined;
			const candidate: WindowCandidate = { id: limit.id, windowClass, fraction, resetsAt };
			const group = groups.get(key);
			if (group) group.candidates.push(candidate);
			else groups.set(key, { priority, tier, candidates: [candidate] });
		}
	}

	let selected: ScopeGroup | undefined;
	for (const group of groups.values()) if (!selected || group.priority < selected.priority) selected = group;

	const resetReport =
		resetReports.length === 1
			? resetReports[0]
			: context.identity
				? resetReports.find(report => reportMatchesExactIdentity(report, context.identity))
				: undefined;
	const summary = summarizeUsageResetCredits(resetReport?.resetCredits, now);
	const expiring =
		summary && summary.bankedCount > 0 && resetReport ? host.classifyResetExpiry?.(resetReport, now) : undefined;
	const expiryMs = expiring
		? expiring.expiresAtMs - now
		: summary?.soonestExpiry
			? Date.parse(summary.soonestExpiry) - now
			: undefined;
	const resetCredits =
		summary && summary.bankedCount > 0
			? {
					bankedCount: summary.bankedCount,
					redeemableCount: summary.redeemableCount,
					...(expiryMs !== undefined && expiryMs > 0
						? { expiryHours: Math.max(1, Math.ceil(expiryMs / 3_600_000)) }
						: {}),
					...(expiryMs !== undefined && expiryMs <= 0 ? { expired: true } : {}),
					...(summary.unavailableReason ? { unavailableReason: summary.unavailableReason } : {}),
					...(expiring ? { expiring: { tier: expiring.tier, count: expiring.count } } : {}),
				}
			: undefined;
	if (!selected) return resetCredits ? { resetCredits } : undefined;

	const minutes = (at: number | undefined) =>
		at === undefined ? undefined : Math.max(0, Math.round((at - now) / 60_000));
	const hours = (at: number | undefined) =>
		at === undefined ? undefined : Math.max(0, Math.round((at - now) / 3_600_000));
	let fiveHour: StatusQuota["fiveHour"];
	let daily: StatusQuota["daily"];
	let sevenDay: StatusQuota["sevenDay"];
	let monthly: StatusQuota["monthly"];
	let monthlyPriority = Number.POSITIVE_INFINITY;
	for (const candidate of selected.candidates) {
		const percent = candidate.fraction * 100;
		if (candidate.windowClass === "5h" && !fiveHour)
			fiveHour = withReset(percent, "resetMinutes", minutes(candidate.resetsAt));
		else if (candidate.windowClass === "daily" && !daily)
			daily = withReset(percent, "resetMinutes", minutes(candidate.resetsAt));
		else if (candidate.windowClass === "7d" && !sevenDay)
			sevenDay = withReset(percent, "resetHours", hours(candidate.resetsAt));
		else if (candidate.windowClass === "monthly") {
			const priority = cursorMonthlyPriority(candidate.id);
			if (priority < monthlyPriority) {
				monthly = withReset(percent, "resetHours", hours(candidate.resetsAt));
				monthlyPriority = priority;
			}
		}
	}
	if (!fiveHour && !daily && !sevenDay && !monthly && !resetCredits) return undefined;
	return {
		...(selected.tier ? { tier: selected.tier } : {}),
		...(fiveHour ? { fiveHour } : {}),
		...(daily ? { daily } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(monthly ? { monthly } : {}),
		...(resetCredits ? { resetCredits } : {}),
	};
}

function withReset<K extends "resetMinutes" | "resetHours">(
	percent: number,
	key: K,
	value: number | undefined,
): { percent: number } & Partial<Record<K, number>> {
	return (value === undefined ? { percent } : { percent, [key]: value }) as { percent: number } & Partial<
		Record<K, number>
	>;
}

/**
 * The active Codex account's weekly usage and saved-reset balance from `reports`, for spotting an
 * early reset or a banked credit between two refreshes; null when no report matches the account.
 */
export function codexResetSnapshot(
	reports: readonly UsageReport[],
	identity: StatusAccountIdentity | undefined,
): CodexResetUsageSnapshot | null {
	const report = reports.find(
		candidate =>
			candidate?.provider === "openai-codex" &&
			Array.isArray(candidate.limits) &&
			reportMatchesExactIdentity(candidate, identity),
	);
	if (!report) return null;
	const planType = report.metadata?.planType;
	const plan = typeof planType === "string" && planType ? planType : undefined;
	let sevenDay: CodexResetUsageSnapshot["sevenDay"];
	let sevenDayTier: string | undefined;
	for (const limit of report.limits) {
		const fraction = limit?.amount?.usedFraction;
		if (limit?.scope?.windowId !== "7d" || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
		const tier = limit.scope.tier || undefined;
		// A tiered window wins over an untiered one; the first of each kind is kept.
		if (sevenDay && (sevenDayTier === undefined || tier)) continue;
		const resetsAt = limit.window?.resetsAt;
		sevenDay = {
			percent: fraction * 100,
			resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
			tier,
			plan,
		};
		sevenDayTier = tier;
	}
	const fetchedAt = report.fetchedAt;
	const available = report.resetCredits?.availableCount;
	const savedResets =
		typeof available === "number" && Number.isFinite(available) ? Math.max(0, Math.trunc(available)) : undefined;
	if (!sevenDay && savedResets === undefined) return null;
	return {
		observedAt: typeof fetchedAt === "number" && Number.isFinite(fetchedAt) ? fetchedAt : undefined,
		sevenDay,
		savedResets,
	};
}
