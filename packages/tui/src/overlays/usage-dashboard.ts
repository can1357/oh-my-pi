/**
 * Fullscreen `/usage` dashboard (the /settings idiom): mounted as an overlay
 * on the alternate screen so it takes no transcript space. Shows a symmetric
 * matrix of equal-size boxed cards (one per provider, or one per account when
 * unmerged) that scrolls on overflow, above a GitHub-style daily activity
 * heatmap pinned to the bottom. Enter flips into the classic full per-account
 * report. `p` toggles account privacy and `m` toggles merge/split for the
 * lifetime of the overlay only; both seed from settings on every open.
 */
import * as os from "node:os";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";

import {
	type Component,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { colorLuma, formatDuration, hexToRgb, rgbToHex, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatProviderName } from "../chrome/format";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
	type UsageResetSummary,
} from "./usage-display";
import { colorToAnsi } from "../theme/color";
import { theme } from "../theme/theme";
import { formatAbsoluteOnlyAmount } from "../prompt/usage-amounts";
import { truncateMiddleToWidth } from "../render/render-utils";
import { sanitizeDisplayLine } from "./extensions/display-text";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import {
	type AccountLabel,
	type AccountMasker,
	formatAccountLabelText,
	formatAccountQualifier,
	normalizeUsageAccountLabel,
	createAccountMasker,
	createUsageTextMasker,
	usageIdentityKey,
} from "./usage-mask";
import { renderFractionBar } from "./usage-bar";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import type { TspSpan, TspTableColumn, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { col, elapsed, node, span, text } from "../native/describe";
import { type DescribeContext, leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionButton } from "../native/overlay";

/** Local calendar-day activity consumed by the usage heatmap. */
export interface DailyActivityPoint {
	day: string;
	cost: number;
	requests: number;
}

// =============================================================================
// Subscriptions grid model
// =============================================================================

/** One quota bucket on a provider card: the account-aggregate of one window group. */
export interface CardWindowRow {
	/** Display label (limit label with tier folded in). */
	label: string;
	/** Window label/id shown dim after the label when sibling rows share a label. */
	windowTag?: string;
	/** Mean used fraction across accounts (0..1, >1 = overage); undefined when unreported. */
	fraction: number | undefined;
	status: UsageLimit["status"];
	/** Reset countdown of the worst account, ms from now, when in the future. */
	resetMs?: number;
	/** Absolute one-sided amount (e.g. `$12.34 used`, `100 credits left`) for limits without a fraction. */
	usedText?: string;
}

export interface UnavailableUsageAccount {
	provider: string;
	label: string;
	identity?: string;
	organizationName?: string;
	organizationId?: string;
	placeholder?: boolean;
}
export function formatUnavailableAccountLabel(account: UnavailableUsageAccount): AccountLabel {
	const identity = account.identity ?? account.label;
	return {
		identity,
		qualifier:
			account.identity && account.label.startsWith(account.identity)
				? account.label.slice(account.identity.length)
				: undefined,
		organizationName: account.organizationName,
		organizationId: account.organizationId,
		placeholder: account.placeholder,
		provider: account.provider,
	};
}

/** Compact per-provider (or per-account when unmerged) summary backing one card in the grid. */
export interface ProviderCard {
	provider: string;
	name: string;
	/** Account label (already privacy-masked) when cards are split per account. */
	account?: string;
	/** Metadata-attributed organization suffix, kept separate for narrow headers. */
	accountQualifier?: string;
	/** Number of accounts reporting for this provider. */
	accounts: number;
	unavailableAccounts: string[];
	/** Window rows sorted most-pressing first. */
	windows: CardWindowRow[];
	/** True when every account reports no limits (e.g. enterprise plans). */
	unlimited: boolean;
	/** True when nothing is used anywhere (or there are no limits): collapses to a tick. */
	idle: boolean;
	resetCredits?: {
		bankedCount: number;
		redeemableCount: number;
		soonestExpiryMs?: number;
		unavailableReasons: string[];
	};
	/** Labels of accounts with verified Daybreak access. */
	daybreakAccounts?: string[];
}

/**
 * Aggregate status across a bucket's limits, mirroring the classic report:
 * a mix of healthy and pressured accounts reads as a warning, not as the
 * worst account's status.
 */
function aggregateStatus(limits: readonly { status?: UsageLimit["status"] }[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
}

/**
 * Card status when some connected accounts reported no usage: the missing
 * report raises the card to a warning but never hides an exhausted quota.
 */
function statusWithUnavailableAccounts(windows: readonly { status?: UsageLimit["status"] }[]): UsageLimit["status"] {
	if (windows.length === 0) return "unknown";
	return aggregateStatus(windows) === "exhausted" ? "exhausted" : "warning";
}

/** Fraction below which a window counts as untouched (renders as 100% free). */
const IDLE_FRACTION = 0.005;
/**
 * Compact duration tag for a window (`7d`, `1d`, `5h`, `mo`), preferring the
 * declared duration and falling back to a short id. Kept terse because it
 * shares the label column with the limit name.
 */
function compactWindowTag(window: NonNullable<UsageLimit["window"]>): string {
	if (window.durationMs) {
		const hours = window.durationMs / 3_600_000;
		if (hours >= 28 * 24) return "mo";
		if (hours >= 24) return `${Math.round(hours / 24)}d`;
		return `${Math.round(hours)}h`;
	}
	const id = window.id.toLowerCase();
	return id.length <= 3 ? id : id.slice(0, 1);
}

/**
 * Collapse usage reports into one compact card per provider: limits grouped by
 * quota bucket (label + window), each bucket showing the mean used fraction
 * across accounts (matching the classic report's aggregate "% free") with the
 * most-used account's reset countdown. Cards sort most-pressing first so
 * what's burning is on top-left; fully idle providers collapse into a tick.
 */
export interface BuildCardsOptions {
	/** One card per provider (all accounts averaged) vs one card per account. */
	merge?: boolean;
	/** Privacy mask applied to account labels on split cards. */
	mask?: AccountMasker;
	maskOrganizationNames?: boolean;
	textMask?: (text: string) => string;
}

function sanitizeAccountLabelPart(value: string): string {
	return normalizeUsageAccountLabel(value);
}

/** Best-effort identity for one report's account: email, organization, account id, project id, or ordinal. */
export function formatReportAccountLabel(report: UsageReport, index: number): AccountLabel {
	const meta = report.metadata;
	const base =
		typeof meta?.email === "string" && meta.email
			? sanitizeAccountLabelPart(meta.email)
			: typeof meta?.accountId === "string" && meta.accountId
				? sanitizeAccountLabelPart(meta.accountId)
				: report.limits[0]?.scope.accountId
					? sanitizeAccountLabelPart(report.limits[0].scope.accountId)
					: typeof meta?.projectId === "string" && meta.projectId
						? sanitizeAccountLabelPart(meta.projectId)
						: report.limits[0]?.scope.projectId
							? sanitizeAccountLabelPart(report.limits[0].scope.projectId)
							: undefined;
	if (!base) return { identity: `account ${index + 1}`, placeholder: true, provider: report.provider };
	const organization =
		typeof meta?.orgName === "string" && meta.orgName
			? sanitizeAccountLabelPart(meta.orgName)
			: typeof meta?.orgId === "string" && meta.orgId
				? sanitizeAccountLabelPart(meta.orgId)
				: undefined;
	return {
		identity: base,
		qualifier: organization && organization !== base ? ` (${organization})` : undefined,
		organizationName: typeof meta?.orgName === "string" && meta.orgName ? meta.orgName : undefined,
		organizationId: typeof meta?.orgId === "string" ? meta.orgId : undefined,
		accountKey: usageIdentityKey(meta?.accountId, meta?.projectId, report.limits[0]?.scope, meta?.orgId),
		provider: report.provider,
	};
}

/** Stable split-card identity; display labels intentionally remain human-readable. */
function formatReportAccountKey(report: UsageReport, index: number): string {
	const meta = report.metadata;
	const base =
		typeof meta?.email === "string" && meta.email
			? meta.email
			: typeof meta?.accountId === "string" && meta.accountId
				? meta.accountId
				: report.limits[0]?.scope.accountId ||
					(typeof meta?.projectId === "string" && meta.projectId
						? meta.projectId
						: report.limits[0]?.scope.projectId) ||
					undefined;
	const organization =
		typeof meta?.orgId === "string" && meta.orgId
			? meta.orgId
			: typeof meta?.orgName === "string" && meta.orgName
				? meta.orgName
				: undefined;
	const accountId =
		typeof meta?.accountId === "string" && meta.accountId ? meta.accountId : report.limits[0]?.scope.accountId;
	const projectId =
		typeof meta?.projectId === "string" && meta.projectId ? meta.projectId : report.limits[0]?.scope.projectId;
	return base
		? JSON.stringify(["identity", base, accountId ?? "", projectId ?? "", organization ?? ""])
		: JSON.stringify(["anonymous", index]);
}

/** Providers may combine several account scopes in a single fetched report. */
function partitionAccountReports(reports: UsageReport[]): UsageReport[] {
	return reports.flatMap(report => {
		const groups = new Map<string | undefined, UsageLimit[]>();
		for (const limit of report.limits) {
			const key = usageIdentityKey(
				limit.scope.accountId || report.metadata?.accountId,
				limit.scope.projectId || report.metadata?.projectId,
				limit.scope,
				report.metadata?.orgId,
			);
			const limits = groups.get(key) ?? [];
			limits.push(limit);
			groups.set(key, limits);
		}
		if (groups.size === 0) return [report];
		return [...groups.values()].map(limits => ({
			...report,
			limits,
			metadata: {
				...report.metadata,
				accountId: limits[0]!.scope.accountId || report.metadata?.accountId,
				projectId: limits[0]!.scope.projectId || report.metadata?.projectId,
			},
		}));
	});
}

export function buildProviderCards(
	reports: UsageReport[],
	nowMs: number,
	options: BuildCardsOptions = {},
	unavailableAccounts: readonly UnavailableUsageAccount[] = [],
): ProviderCard[] {
	const { merge = true, mask = formatAccountLabelText, textMask = (text: string) => text } = options;
	const grouped = new Map<
		string,
		{
			provider: string;
			account?: AccountLabel;
			reports: UsageReport[];
			unavailable?: readonly UnavailableUsageAccount[];
		}
	>();
	(merge ? collapseSharedUsageReports(reports) : partitionAccountReports(reports)).forEach((report, index) => {
		const account = merge ? undefined : formatReportAccountLabel(report, index);
		const identity = merge ? undefined : formatReportAccountKey(report, index);
		const key = identity === undefined ? report.provider : `${report.provider}\u0000${identity}`;
		const entry = grouped.get(key) ?? { provider: report.provider, account, reports: [] };
		entry.reports.push(report);
		grouped.set(key, entry);
	});

	for (const [index, account] of unavailableAccounts.entries()) {
		if (merge) {
			const entry = grouped.get(account.provider) ?? { provider: account.provider, reports: [] };
			grouped.set(account.provider, { ...entry, unavailable: [...(entry.unavailable ?? []), account] });
		} else {
			grouped.set(`${account.provider}\u0000unavailable-${index}`, {
				provider: account.provider,
				account: formatUnavailableAccountLabel(account),
				reports: [],
				unavailable: [account],
			});
		}
	}
	const cards: ProviderCard[] = [];
	for (const { provider, account, reports: providerReports, unavailable: missing = [] } of grouped.values()) {
		const unavailable = missing.map(entry => mask(formatUnavailableAccountLabel(entry)));
		const buckets = new Map<string, { label: string; limits: UsageLimit[] }>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const label = formatLimitTitle(limit);
				const key = `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}`;
				const entry = buckets.get(key) ?? { label, limits: [] };
				entry.limits.push(limit);
				buckets.set(key, entry);
			}
		}

		const windows: CardWindowRow[] = [...buckets.values()].map(bucket => {
			const fractions = bucket.limits
				.map(limit => resolveUsedFraction(limit))
				.filter((value): value is number => value !== undefined);
			const fraction =
				fractions.length > 0 ? fractions.reduce((sum, value) => sum + value, 0) / fractions.length : undefined;
			const worst = bucket.limits.reduce((max, limit) =>
				(resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(max) ?? -1) ? limit : max,
			);
			const resetsAt = worst.window?.resetsAt;
			return {
				label: bucket.label,
				windowTag: worst.window ? compactWindowTag(worst.window) : undefined,
				fraction,
				status: aggregateStatus(bucket.limits),
				resetMs: resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined,
				usedText: fraction === undefined ? formatAbsoluteOnlyAmount(bucket.limits) : undefined,
			};
		});
		windows.sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1));
		// The window tag earns its columns only when sibling rows would otherwise
		// be indistinguishable (e.g. Antigravity's daily vs weekly "Usage (Google)").
		for (const window of windows) {
			const duplicated = windows.some(other => other !== window && other.label === window.label);
			if (!duplicated) window.windowTag = undefined;
		}

		const resetRows = providerReports
			.map(report => summarizeUsageResetCredits(report.resetCredits, nowMs))
			.filter((summary): summary is UsageResetSummary => summary !== undefined && summary.bankedCount > 0);
		const bankedCount = resetRows.reduce((total, summary) => total + summary.bankedCount, 0);
		const redeemableCount = resetRows.reduce((total, summary) => total + summary.redeemableCount, 0);
		const resetExpiries = resetRows
			.map(summary => summary.soonestExpiry)
			.filter((expiry): expiry is string => expiry !== undefined)
			.map(expiry => Date.parse(expiry))
			.filter(Number.isFinite)
			.sort((left, right) => left - right);
		const soonestResetExpiry = resetExpiries.find(expiry => expiry > nowMs) ?? resetExpiries.at(-1);
		const unavailableReasons = [
			...new Set(
				resetRows
					.map(summary => summary.unavailableReason)
					.filter((reason): reason is string => reason !== undefined),
			),
		];
		const resetCredits =
			bankedCount > 0
				? {
						bankedCount,
						redeemableCount,
						soonestExpiryMs: soonestResetExpiry === undefined ? undefined : soonestResetExpiry - nowMs,
						unavailableReasons,
					}
				: undefined;
		const daybreakAccounts = providerReports.flatMap((report, index) =>
			report.metadata?.daybreak === true ? [mask(formatReportAccountLabel(report, index))] : [],
		);
		cards.push({
			provider,
			name: formatProviderName(provider),
			...(account
				? {
						account: mask(account),
						accountQualifier: account.qualifier
							? textMask(formatAccountQualifier(account, options.maskOrganizationNames))
							: undefined,
					}
				: {}),
			accounts: providerReports.length + unavailable.length,
			unavailableAccounts: unavailable,
			windows,
			unlimited: windows.length === 0 && unavailable.length === 0,
			idle:
				unavailable.length === 0 &&
				!resetCredits &&
				daybreakAccounts.length === 0 &&
				windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
			resetCredits,
			...(daybreakAccounts.length > 0 ? { daybreakAccounts } : {}),
		});
	}

	cards.sort((a, b) => {
		const aWorst = a.windows[0]?.fraction ?? -1;
		const bWorst = b.windows[0]?.fraction ?? -1;
		if (aWorst !== bWorst) return bWorst - aWorst;
		return a.name.localeCompare(b.name) || (a.account ?? "").localeCompare(b.account ?? "");
	});
	return cards;
}

// =============================================================================
// Activity heatmap model
// =============================================================================

/** GitHub-style week-per-column heatmap grid derived from daily activity. */
export interface HeatmapLayout {
	/** Per week column: short month name when the column starts a new month. */
	monthLabels: (string | undefined)[];
	/** 7 rows (Mon..Sun) × N week columns; 0..4 intensity, null = future day. */
	cells: (number | null)[][];
	totalCost: number;
	totalRequests: number;
	/** Local midnight of the first cell (column 0, Monday). */
	start: Date;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const HEATMAP_DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function localIso(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Lay out daily activity into a Monday-first week grid ending at `today`'s
 * week. Intensity levels are magnitude-scaled against the busiest day
 * (square-root compressed so mid-size days stay distinguishable from
 * outliers), over per-day cost — falling back to request counts when nothing
 * in range has priced usage. Unlike GitHub's rank quartiles, intensity tracks
 * *how much* work a day carried.
 */
export function buildHeatmapLayout(points: DailyActivityPoint[], weeks: number, today = new Date()): HeatmapLayout {
	const byDay = new Map(points.map(point => [point.day, point]));
	const anyCost = points.some(point => point.cost > 0);
	const metric = (point: DailyActivityPoint): number => (anyCost ? point.cost : point.requests);

	const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const mondayOffset = (today0.getDay() + 6) % 7;
	const currentMonday = addDays(today0, -mondayOffset);
	const start = addDays(currentMonday, -(weeks - 1) * 7);
	const startIso = localIso(start);
	const todayIso = localIso(today0);

	const inRange = points.filter(point => point.day >= startIso && point.day <= todayIso);
	const max = inRange.reduce((acc, point) => Math.max(acc, metric(point)), 0);
	const level = (value: number): number => {
		if (value <= 0 || max <= 0) return 0;
		return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
	};

	const monthLabels: (string | undefined)[] = [];
	const cells: (number | null)[][] = Array.from({ length: 7 }, () =>
		Array.from({ length: weeks }, (): number | null => null),
	);
	let previousMonth = -1;
	for (let week = 0; week < weeks; week++) {
		const weekStart = addDays(start, week * 7);
		const month = weekStart.getMonth();
		monthLabels.push(month !== previousMonth ? MONTH_NAMES[month] : undefined);
		previousMonth = month;
		for (let day = 0; day < 7; day++) {
			const date = addDays(weekStart, day);
			if (date > today0) continue;
			const point = byDay.get(localIso(date));
			cells[day][week] = level(point ? metric(point) : 0);
		}
	}

	return {
		monthLabels,
		cells,
		totalCost: inRange.reduce((sum, point) => sum + point.cost, 0),
		totalRequests: inRange.reduce((sum, point) => sum + point.requests, 0),
		start,
	};
}

// =============================================================================
// Native description helpers
// =============================================================================

/** Weeks of history the native heatmap carries (a year, GitHub-style). */
const NATIVE_HEATMAP_WEEKS = 53;
/** Span tokens for heatmap intensity levels 1..4 (the `table` fallback). */
const HEAT_LEVEL_TOKENS = ["dim", "accent dim", "accent", "accent strong"];
/** Heatmap row labels, Monday first like omp's grid: M/W/F only. */
const HEATMAP_ROW_LABELS = ["M", "", "W", "", "F", "", ""];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Meter tone of a quota window: ok is the accent fill, pressure warns, exhaustion errors. */
function statusTone(status: UsageLimit["status"]): TspTone {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "accent";
	return "muted";
}

/** Status dot of a provider frame, toned by the card's aggregate status. */
function statusDot(status: UsageLimit["status"]): NativeNode {
	const token =
		status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "success" : "dim";
	const label =
		status === "exhausted"
			? "Exhausted"
			: status === "warning"
				? "Under pressure"
				: status === "ok"
					? "OK"
					: "Unknown";
	return text([span("●", token)], { title: label, aria: label });
}

/**
 * Used-fraction bar of a quota window, toned by status: a `meter` where the
 * terminal draws one, else a `progress` bar.
 */
function usageMeter(fraction: number, status: UsageLimit["status"], meter: boolean, label?: TspText): NativeNode {
	const value = Math.min(Math.max(fraction, 0), 1);
	const tone = statusTone(status);
	return meter
		? node("meter", { value, style: "bar", size: "md", tone, label })
		: node("progress", { value, tone, grow: 1, label });
}

/** `62% left` for a used fraction (overage reads as 0%). */
function leftText(fraction: number): string {
	return `${Math.max(0, Math.round((1 - fraction) * 100))}% left`;
}

/** `Mon 28 Sep` for a local date. */
function shortDate(date: Date): string {
	return `${WEEKDAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** `18:00` for a local time. */
function clockTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * When a window resets, relative to `nowMs`: `resets 18:00` today, `resets
 * Tue 18:00` within the week, `resets 3 Oct` beyond; the title carries the
 * absolute date and the countdown.
 */
function resetLabel(nowMs: number, resetMs: number): { text: string; title: string } {
	const at = new Date(nowMs + resetMs);
	const now = new Date(nowMs);
	const sameDay = at.toDateString() === now.toDateString();
	const text = sameDay
		? `resets ${clockTime(at)}`
		: resetMs < 6 * 86_400_000
			? `resets ${WEEKDAY_NAMES[at.getDay()]} ${clockTime(at)}`
			: `resets ${at.getDate()} ${MONTH_NAMES[at.getMonth()]}`;
	return {
		text,
		title: `Resets ${shortDate(at)} ${at.getFullYear()}, ${clockTime(at)} (in ${formatDuration(resetMs)})`,
	};
}

function mutedText(content: string, wrap = false): NativeNode {
	return text([span(content, "muted")], wrap ? { wrap: "word" } : { truncate: "end" });
}

/** Window qualifier worth showing after a limit title (none when the title already names it). */
function detailWindowLabel(label: string, limit: UsageLimit): string | undefined {
	const windowLabel = limit.window?.label ?? limit.window?.id ?? limit.scope.windowId;
	if (!windowLabel) return undefined;
	const normalized = windowLabel.toLowerCase();
	if (normalized === "quota window" || label.toLowerCase().includes(normalized)) return undefined;
	return sanitizeDisplayLine(windowLabel);
}

/** `$1,234 · 5.6K requests` totals for the activity summary. */
function formatActivityTotals(layout: HeatmapLayout): string {
	const cost =
		layout.totalCost >= 1
			? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(layout.totalCost)}`
			: `$${layout.totalCost.toFixed(2)}`;
	const requests = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
		layout.totalRequests,
	);
	return `${cost} · ${requests} requests`;
}

// =============================================================================
// Component
// =============================================================================

/** Callbacks and data sources for {@link UsageDashboardComponent}. */
export interface UsageDashboardOptions {
	reports: UsageReport[];
	unavailableAccounts?: readonly UnavailableUsageAccount[];
	/**
	 * Full classic `/usage` report for the expanded detail view; re-invoked per
	 * terminal width and per privacy toggle.
	 */
	renderDetail: (
		width: number,
		view: { maskAccountLabels: boolean; maskOrganizationNames: boolean },
		reports: UsageReport[],
	) => string;
	/** Privacy masker factory for the given toggle state (collision-aware ordinals). */
	createMasker?: (labels: Iterable<AccountLabel>, enabled: boolean, maskOrganizationNames?: boolean) => AccountMasker;
	/** Initial privacy state, read from settings on open; toggling never persists. */
	maskAccountLabels?: boolean;
	maskOrganizationNames?: boolean;
	/** Initial merge state (one card per provider), read from settings on open; toggling never persists. */
	mergeAccounts?: boolean;
	/** Percentage label placement, read from settings on open. */
	labelPlacement?: "moving" | "right";
	/**
	 * Stream daily activity into the heatmap: push cached DB rows immediately,
	 * then push again after an incremental session sync. Resolves when the sync
	 * settles; rejection renders as a dim unavailable note.
	 */
	loadActivity: (push: (points: DailyActivityPoint[]) => void, signal: AbortSignal) => Promise<void>;
	/** Re-fetch the usage reports (`r`); omitted when the host can't. Resolves null when nothing came back. */
	refresh?: () => Promise<UsageReport[] | null>;
	requestRender: () => void;
	onClose: () => void;
}

/**
 * Sanitize activity loading error text for safe single-line display in the TUI overlay.
 * Strips ANSI/control sequences, expands tabs, collapses whitespace runs/newlines,
 * shortens home directory paths to ~, and removes trailing dots.
 */
export function formatActivityErrorDetail(error: string, homeDir = os.homedir()): string {
	let text = replaceTabs(sanitizeText(error)).replace(/\s+/g, " ").trim();
	if (homeDir) {
		const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const forward = homeDir.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		text = text.replace(new RegExp(`${escaped}|${forward}`, "gi"), "~");
	}
	return text.replace(/\.+$/, "");
}

export function fitAccountLabel(label: string, width: number, qualifier = ""): string {
	if (width <= 0) return "";
	if (!qualifier || !label.endsWith(qualifier)) return truncateToWidth(label, width);
	const rawBase = label.slice(0, -qualifier.length);
	const ordinalMatch = rawBase.match(/^(.*) (\(\d+\))$/);
	const base = ordinalMatch?.[1] ?? rawBase;
	const ordinal = ordinalMatch?.[2] ?? "";
	const ordinalSuffix = ordinal ? ` ${ordinal}` : "";
	const mandatory = `${ordinalSuffix}${qualifier}`;
	const mandatoryWidth = visibleWidth(mandatory);
	if (mandatoryWidth >= width) {
		const prefix = ordinal ? `${ordinal} ` : "";
		const budget = Math.max(0, width - visibleWidth(prefix));
		if (budget < 3) return truncateToWidth(prefix || qualifier, width);
		const left = Math.ceil((budget - 1) / 2);
		const right = budget - left - 1;
		return `${prefix}${truncateToWidth(qualifier, left, "")}…${sliceWithWidth(qualifier, visibleWidth(qualifier) - right, right, true).text}`;
	}
	return `${truncateToWidth(base, Math.max(1, width - mandatoryWidth))}${mandatory}`;
}

const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 1;
const CARD_MAX_WINDOWS = 4;
/** Heatmap block: title, blank, month row, 7 day rows. */
const ACTIVITY_ROWS = 10;
/** Cards keep at least this many rows even on short terminals; activity yields below it. */
const CARDS_MIN_ROWS = 6;
const CARD_MIN_BAR_WIDTH = 12;
const CARD_MAX_LABEL_LINES = 2;

interface CardRowLayout {
	labelWidth: number;
	resetWidth: number;
	barWidth: number;
	stacked: boolean;
	labelHeights: number[];
}

export class UsageDashboardComponent implements Component {
	/** The terminal draws the sheet: a large glass overlay titled Usage. */
	readonly nativeOverlay = { role: "omp.overlay.usage", size: "lg", anchor: "center", head: "Usage" } as const;
	#options: UsageDashboardOptions;
	#cards: ProviderCard[] = [];
	#reports: UsageReport[];
	readonly #panel: OverlayPanel;
	readonly #header: PanelRows;
	readonly #body: PanelRows;
	readonly #footer: PanelRows;
	#nowMs: number;
	#refreshing = false;
	#refreshError: string | null = null;
	/** Bumped whenever anything the native description shows changes. */
	#revision = 0;
	#view: "overview" | "detail" = "overview";
	#scroll = 0;
	#activity: DailyActivityPoint[] | null = null;
	#activityError: string | null = null;
	#syncing = true;
	#detailCache: { width: number; masked: boolean; organizations: boolean; lines: string[] } | null = null;
	#lastViewportRows = 10;
	#closed = false;
	readonly #closeController = new AbortController();
	/** Session-local toggles: seeded from settings on open, never written back. */
	#mask: boolean;
	#maskOrganizations: boolean;
	#merge: boolean;
	#textMask: (text: string) => string = text => text;
	#accountMask: AccountMasker = formatAccountLabelText;
	#nativeCache: { revision: number; meter: boolean; chart: boolean; node: NativeNode } | undefined;

	constructor(options: UsageDashboardOptions) {
		this.#options = options;
		this.#reports = options.reports;
		this.#nowMs = Date.now();
		this.#mask = options.maskAccountLabels ?? false;
		this.#maskOrganizations = options.maskOrganizationNames ?? false;
		this.#merge = options.mergeAccounts ?? true;
		this.#rebuildCards();
		this.#panel = new OverlayPanel("Usage");
		this.#header = new PanelRows();
		this.#header.setHeight(1);
		this.#body = new PanelRows();
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		void this.#loadActivity();
	}

	#rebuildCards(): void {
		const organizations = (this.#options.unavailableAccounts ?? []).flatMap(account =>
			account.organizationName
				? [{ name: account.organizationName, id: account.organizationId, provider: account.provider }]
				: [],
		);
		const identifiers = this.#options.unavailableAccounts?.map(account => account.label);
		const identityMask = createUsageTextMasker(this.#reports, this.#mask, identifiers);
		this.#textMask = createUsageTextMasker(this.#reports, this.#mask, identifiers, undefined, {
			maskOrganizationNames: this.#maskOrganizations,
			organizations,
		});
		const reports = partitionAccountReports(this.#reports);
		const normalize = (label: AccountLabel): AccountLabel => ({
			...label,
			qualifier: label.organizationName
				? formatAccountQualifier(label, this.#maskOrganizations)
				: label.qualifier
					? identityMask(label.qualifier)
					: undefined,
		});
		const labels = [
			...reports.map((report, index) => formatReportAccountLabel(report, index)),
			...(this.#options.unavailableAccounts ?? []).map(formatUnavailableAccountLabel),
		].map(normalize);
		const masker = (this.#options.createMasker ?? createAccountMasker)(labels, this.#mask, this.#maskOrganizations);
		this.#accountMask = label => masker(normalize(label));
		this.#cards = buildProviderCards(
			this.#reports,
			this.#nowMs,
			{
				merge: this.#merge,
				maskOrganizationNames: this.#maskOrganizations,
				textMask: this.#textMask,
				mask: this.#accountMask,
			},
			this.#options.unavailableAccounts,
		);
	}

	/** Current temporary view toggles (for tests and the hint row). */
	get viewState(): {
		maskAccountLabels: boolean;
		maskOrganizationNames: boolean;
		mergeAccounts: boolean;
		view: "overview" | "detail";
	} {
		return {
			maskAccountLabels: this.#mask,
			maskOrganizationNames: this.#maskOrganizations,
			mergeAccounts: this.#merge,
			view: this.#view,
		};
	}

	#reportLabel(report: UsageReport, limit: UsageLimit | undefined, index: number): string {
		const scoped = limit
			? {
					...report,
					limits: [limit],
					metadata: {
						...report.metadata,
						accountId: limit.scope.accountId || report.metadata?.accountId,
						projectId: limit.scope.projectId || report.metadata?.projectId,
					},
				}
			: report;
		return this.#accountMask(formatReportAccountLabel(scoped, index));
	}

	async #loadActivity(): Promise<void> {
		try {
			await this.#options.loadActivity(points => {
				if (this.#closed) return;
				this.#activity = points;
				this.#changed();
			}, this.#closeController.signal);
		} catch (error) {
			if (!this.#closed) this.#activityError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#syncing = false;
			if (!this.#closed) this.#changed();
		}
	}

	dispose(): void {
		this.#closed = true;
		this.#closeController.abort();
	}

	// ---------------------------------------------------------------------------
	// Card rendering
	// ---------------------------------------------------------------------------

	#statusIcon(status: UsageLimit["status"]): string {
		if (status === "exhausted") return theme.fg("error", theme.status.error);
		if (status === "warning") return theme.fg("warning", theme.status.warning);
		if (status === "ok") return theme.fg("success", theme.status.success);
		return theme.fg("dim", "·");
	}

	#renderCardLines(card: ProviderCard, width: number, labels: string[][], layout: CardRowLayout): string[] {
		const lines: string[] = [];
		const cardStatus =
			card.unavailableAccounts.length > 0
				? statusWithUnavailableAccounts(card.windows)
				: card.unlimited
					? "ok"
					: aggregateStatus(card.windows);
		const accountsText =
			card.account !== undefined
				? theme.fg("dim", fitAccountLabel(card.account, Math.max(1, width - 8), card.accountQualifier))
				: card.accounts > 1
					? theme.fg("dim", `${card.accounts} accts`)
					: "";
		const titleBudget = width - 2 - visibleWidth(accountsText) - (accountsText ? 1 : 0);
		const title = theme.bold(truncateToWidth(card.name, Math.max(4, titleBudget)));
		const titlePad = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(accountsText));

		lines.push(`${this.#statusIcon(cardStatus)} ${title}${" ".repeat(titlePad)}${accountsText}`);
		for (const account of card.daybreakAccounts ?? []) {
			const label = sanitizeText(account.replace(/[\r\n\t]+/g, " "));
			lines.push(`  ${theme.fg("success", truncateToWidth(`daybreak · ${label}`, width - 2))}`);
		}

		if (card.resetCredits) {
			const resets = card.resetCredits;
			let resetText = `✦ ${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"}`;
			if (resets.redeemableCount !== resets.bankedCount) {
				resetText += ` · ${resets.redeemableCount} usable`;
			}
			if (resets.soonestExpiryMs !== undefined) {
				resetText +=
					resets.soonestExpiryMs > 0 ? ` · expires ${formatDuration(resets.soonestExpiryMs)}` : " · expired";
			}
			lines.push(
				`  ${theme.fg(resets.redeemableCount > 0 ? "success" : "warning", truncateToWidth(resetText, width - 2))}`,
			);
			if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0) {
				const reason = sanitizeText(
					this.#textMask(resets.unavailableReasons.join(" • ").replace(/[\r\n\t]+/g, " ")),
				);
				lines.push(`  ${theme.fg("dim", truncateToWidth(`unavailable: ${reason}`, width - 2))}`);
			}
		}

		for (const account of card.unavailableAccounts) {
			const text = sanitizeDisplayLine(`${account} — usage unavailable`);
			for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
				lines.push(`  ${theme.fg("dim", line)}`);
			}
		}
		if (card.unlimited) {
			lines.push(`  ${theme.fg("dim", "no limits")}`);
			return lines;
		}

		const hidden = card.windows.length - CARD_MAX_WINDOWS;
		const { labelWidth, resetWidth, barWidth, stacked, labelHeights } = layout;
		const contentWidth = Math.max(1, width - 2);
		for (let index = 0; index < Math.min(card.windows.length, CARD_MAX_WINDOWS); index++) {
			const window = card.windows[index]!;
			const labelLines = labels[index]!;
			const label = labelLines[0] ?? "";
			const prefix = stacked ? "" : `${label}${" ".repeat(labelWidth - visibleWidth(label))} `;
			if (stacked) {
				for (let line = 0; line < labelHeights[index]; line++) {
					lines.push(`  ${labelLines[line] ?? ""}`);
				}
			}
			if (window.fraction === undefined) {
				const text = theme.fg("dim", this.#textMask(window.usedText ?? "no data"));
				for (const line of wrapTextWithAnsi(`${prefix}${text}`, contentWidth)) lines.push(`  ${line}`);
				continue;
			}
			const resetPlain = window.resetMs !== undefined ? formatDuration(window.resetMs) : "";
			const resetText = resetWidth > 0 ? ` ${theme.fg("dim", resetPlain.padStart(resetWidth))}` : "";
			for (const line of wrapTextWithAnsi(
				`${prefix}${renderFractionBar(1 - window.fraction, barWidth, theme, this.#options.labelPlacement ?? "moving")}${resetText}`,
				contentWidth,
			)) {
				lines.push(`  ${line}`);
			}
		}
		if (hidden > 0) lines.push(`  ${theme.fg("dim", `+${hidden} more`)}`);
		return lines;
	}

	/** Wrap card lines in a rounded box; every box in the grid shares the same height. */
	#boxCard(inner: string[], width: number, height: number): string[] {
		const innerWidth = width - 2;
		const out: string[] = [theme.fg("dim", `╭${"─".repeat(innerWidth)}╮`)];
		for (let i = 0; i < height; i++) {
			const line = inner[i] ?? "";
			const body = truncateToWidth(line, innerWidth);
			out.push(
				`${theme.fg("dim", "│")}${body}${" ".repeat(Math.max(0, innerWidth - visibleWidth(body)))}${theme.fg("dim", "│")}`,
			);
		}
		out.push(theme.fg("dim", `╰${"─".repeat(innerWidth)}╯`));
		return out;
	}

	/**
	 * Symmetric matrix of equal-size boxed cards: as many columns as fit at
	 * {@link CARD_MIN_WIDTH} (never more than there are cards), every card the
	 * same width and height. Overflow scrolls; the activity strip never does.
	 */
	#renderCardsGrid(innerWidth: number): string[] {
		if (this.#cards.length === 0) return [theme.fg("dim", "No usage data available.")];
		const columns = Math.max(
			1,
			Math.min(this.#cards.length, Math.floor((innerWidth + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER))),
		);
		const cardWidth = Math.floor((innerWidth - (columns - 1) * CARD_GUTTER) / columns);
		const lines: string[] = [];
		const active = this.#cards;
		for (let start = 0; start < active.length; start += columns) {
			const cards = active.slice(start, start + columns);
			const windows = cards.map(card => card.windows.slice(0, CARD_MAX_WINDOWS));
			const labels = windows.map(rows =>
				rows.map(window => {
					const label = theme.fg("muted", sanitizeDisplayLine(this.#textMask(window.label)));
					const tag = window.windowTag ? sanitizeDisplayLine(this.#textMask(window.windowTag)) : "";
					return tag ? `${label} ${theme.fg("dim", tag)}` : label;
				}),
			);
			// One geometry per grid row: labels, bars, and resets share columns,
			// and every card stacks together when inline bars would be too short.
			const labelWidth = labels.reduce(
				(max, rows) => rows.reduce((width, label) => Math.max(width, visibleWidth(label)), max),
				0,
			);
			const resetWidth = windows.reduce(
				(max, rows) =>
					rows.reduce(
						(width, window) =>
							Math.max(width, window.resetMs !== undefined ? formatDuration(window.resetMs).length : 0),
						max,
					),
				0,
			);
			const contentWidth = Math.max(1, cardWidth - 4);
			const suffixWidth = resetWidth > 0 ? resetWidth + 1 : 0;
			const inlineBarWidth = contentWidth - labelWidth - 1 - suffixWidth;
			const stacked = inlineBarWidth < CARD_MIN_BAR_WIDTH + 5;
			const labelLines = labels.map(rows =>
				rows.map(label => {
					if (!stacked) return [label];
					// Bound wrapping work as well as height, keeping the suffix that
					// distinguishes model-specific quota buckets.
					const bounded = truncateMiddleToWidth(label, contentWidth * CARD_MAX_LABEL_LINES);
					const lines = wrapTextWithAnsi(bounded, contentWidth);
					if (lines.length <= CARD_MAX_LABEL_LINES) return lines;
					// Word wrapping can waste enough cells to create a third line even
					// when the label fits. Use a grapheme-safe column split in that case.
					const first = sliceWithWidth(bounded, 0, contentWidth, true);
					const rest = sliceWithWidth(bounded, first.width, visibleWidth(bounded) - first.width, true);
					return [first.text, truncateMiddleToWidth(rest.text, contentWidth)];
				}),
			);
			const labelHeights = Array.from({ length: CARD_MAX_WINDOWS }, (_, index) =>
				Math.max(0, ...labelLines.map(rows => rows[index]?.length ?? 0)),
			);
			const layout: CardRowLayout = {
				labelWidth,
				resetWidth,
				barWidth: Math.max(1, stacked ? contentWidth - suffixWidth : inlineBarWidth),
				stacked,
				labelHeights,
			};
			const rowCards = cards.map((card, index) =>
				this.#renderCardLines(card, cardWidth - 2, labelLines[index]!, layout),
			);
			const height = Math.max(...rowCards.map(card => card.length));
			const boxes = rowCards.map(card => this.#boxCard(card, cardWidth, height));
			for (let lineIdx = 0; lineIdx < height + 2; lineIdx++) {
				const segments = boxes.map(card => {
					const line = card[lineIdx] ?? "";
					return line + " ".repeat(Math.max(0, cardWidth - visibleWidth(line)));
				});
				lines.push(segments.join(" ".repeat(CARD_GUTTER)).trimEnd());
			}
		}
		return lines;
	}

	// ---------------------------------------------------------------------------
	// Heatmap rendering
	// ---------------------------------------------------------------------------

	/** Truecolor ramp from the theme's background side toward its accent: level 1
	 * sits near-invisible, level 4 is the full accent, so cell brightness reads
	 * as amount of work. Anchored to black or white by the text color's luma so
	 * the ramp keeps its direction on light themes. */
	#heatRamp(): string[] {
		const mode = theme.getColorMode();
		const darkBackground = (colorLuma(theme.getColorHex("text")) ?? 1) > 0.5;
		const from = darkBackground ? { r: 20, g: 20, b: 24 } : { r: 244, g: 244, b: 246 };
		const to = hexToRgb(theme.getColorHex("accent"));
		return [0.3, 0.5, 0.72, 1].map(t =>
			colorToAnsi(
				rgbToHex({
					r: Math.round(from.r + (to.r - from.r) * t),
					g: Math.round(from.g + (to.g - from.g) * t),
					b: Math.round(from.b + (to.b - from.b) * t),
				}),
				mode,
			),
		);
	}

	#renderHeatmap(innerWidth: number): string[] {
		const summary: string[] = [];
		if (this.#activityError) {
			const detail = this.#textMask(formatActivityErrorDetail(this.#activityError));
			return [theme.fg("dim", detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.")];
		}
		const points = this.#activity;
		if (!points) return [theme.fg("dim", "Loading usage history…")];

		const labelWidth = 2;
		const weeks = Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));
		const layout = buildHeatmapLayout(points, weeks);
		const ramp = this.#heatRamp();
		const reset = "\x1b[39m";

		const cost =
			layout.totalCost >= 1
				? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(layout.totalCost)}`
				: `$${layout.totalCost.toFixed(2)}`;
		const requests = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
			layout.totalRequests,
		);
		summary.push(
			`${theme.bold(theme.fg("accent", "Activity"))} ${theme.fg("dim", `${cost} · ${requests} requests · last ${weeks} weeks`)}${this.#syncing ? theme.fg("dim", " · syncing…") : ""}`,
		);
		summary.push("");

		let monthLine = " ".repeat(labelWidth);
		for (let week = 0; week < weeks; week++) {
			const label = layout.monthLabels[week];
			const targetCol = labelWidth + week * 2;
			if (label && targetCol >= visibleWidth(monthLine)) {
				monthLine = monthLine.padEnd(targetCol) + label;
			}
		}
		summary.push(theme.fg("dim", truncateToWidth(monthLine, innerWidth)));

		for (let day = 0; day < 7; day++) {
			let line = theme.fg("dim", HEATMAP_DAY_LABELS[day]) + " ";
			for (let week = 0; week < weeks; week++) {
				const cell = layout.cells[day][week];
				if (cell === null) line += "  ";
				else if (cell === 0) line += `${theme.fg("dim", "·")} `;
				else line += `${ramp[cell - 1]}■${reset} `;
			}
			summary.push(line.trimEnd());
		}
		return summary;
	}

	// ---------------------------------------------------------------------------
	// Frame
	// ---------------------------------------------------------------------------

	#detailLines(innerWidth: number): string[] {
		if (
			this.#detailCache?.width !== innerWidth ||
			this.#detailCache.masked !== this.#mask ||
			this.#detailCache.organizations !== this.#maskOrganizations
		) {
			this.#detailCache = {
				width: innerWidth,
				masked: this.#mask,
				organizations: this.#maskOrganizations,
				lines: this.#options
					.renderDetail(
						innerWidth,
						{ maskAccountLabels: this.#mask, maskOrganizationNames: this.#maskOrganizations },
						this.#reports,
					)
					.split("\n"),
			};
		}
		return this.#detailCache.lines;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(20, width - 4);
		// Fixed chrome: top border, status row, content…, divider, hint, bottom border.
		const contentRows = Math.max(5, height - 5);

		const latestFetchedAt = Math.max(0, ...this.#reports.map(report => report.fetchedAt ?? 0));
		const checkedText = this.#refreshing
			? "refreshing…"
			: latestFetchedAt
				? `checked ${formatDuration(this.#nowMs - latestFetchedAt)} ago`
				: "";
		const title = this.#view === "detail" ? "Usage · Details" : "Usage";

		const contentSource = this.#view === "detail" ? this.#detailLines(innerWidth) : this.#renderCardsGrid(innerWidth);
		const activityRows =
			this.#view === "overview" && contentRows - CARDS_MIN_ROWS >= ACTIVITY_ROWS + 1 ? ACTIVITY_ROWS + 1 : 0;
		const scrollRows = contentRows - activityRows;
		this.#lastViewportRows = scrollRows;
		const maxScroll = Math.max(0, contentSource.length - scrollRows);
		this.#scroll = Math.min(this.#scroll, maxScroll);
		const visible = contentSource.slice(this.#scroll, this.#scroll + scrollRows);
		while (visible.length < scrollRows) visible.push("");
		if (activityRows) visible.push("", ...this.#renderHeatmap(innerWidth).slice(0, ACTIVITY_ROWS));
		const scrollHint = maxScroll > 0 ? `${editorKeys("tui.select.up", "tui.select.down")} scroll · ` : "";
		const cancel = editorKey("tui.select.cancel");
		const refreshHint = this.#options.refresh ? "r refresh · " : "";
		const privacyHint = `p ${this.#mask ? "show" : "hide"} accounts · o ${this.#maskOrganizations ? "show" : "hide"} organizations · `;
		const groupingHint = `m ${this.#merge ? "split" : "merge"} accounts · `;
		const hint =
			this.#view === "detail"
				? `${scrollHint}${refreshHint}${privacyHint}${cancel} back`
				: `${scrollHint}${refreshHint}${formatKeyHint("enter")} details · ${privacyHint}${groupingHint}${cancel} close`;
		this.#panel.title = title;
		this.#header.setLines([checkedText ? theme.fg("dim", checkedText) : ""]);
		this.#body.setLines(visible);
		this.#body.setHeight(contentRows);
		this.#footer.setLines([theme.fg("dim", hint)]);
		return this.#panel.render(width);
	}

	// ---------------------------------------------------------------------------
	// Native description
	// ---------------------------------------------------------------------------

	/**
	 * The sheet body (the terminal's `lg` overlay is the frame): a head row
	 * (checked ago, Overview/Details tabs, Refresh), then either the provider
	 * grid of frames with window meters and the activity heatmap, or the
	 * per-provider detail tables. `meter`/`chart` fall back to
	 * `progress`/`table` on terminals without them. Rebuilt only when its
	 * inputs change.
	 */
	describe(cx: DescribeContext): NativeNode {
		const meter = cx.supports("meter");
		const chart = cx.supports("chart");
		const cache = this.#nativeCache;
		if (cache && cache.revision === this.#revision && cache.meter === meter && cache.chart === chart) {
			return cache.node;
		}
		const body = this.#view === "detail" ? this.#describeDetail() : this.#describeOverview(meter, chart);
		const root = col([this.#describeHead(), node("col", { gap: "lg" }, body, this.#view)], { gap: "lg" });
		this.#nativeCache = { revision: this.#revision, meter, chart, node: root };
		return root;
	}

	/** Tab clicks switch views like Enter/Esc; the Refresh button runs `r`. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			if (event.act === "refresh") void this.#refresh();
			if (event.act === "privacy") this.handleInput("p");
			if (event.act === "organization-privacy") this.handleInput("o");
			if (event.act === "grouping") this.handleInput("m");
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (leafKey(event.key) !== "tabs") return;
		if ((event.item === "overview" || event.item === "detail") && event.item !== this.#view) {
			this.#setView(event.item);
		}
	}

	#describeHead(): NativeNode {
		const checked: NativeChild[] = [];
		const latestFetchedAt = Math.max(0, ...this.#reports.map(report => report.fetchedAt ?? 0));
		if (this.#refreshing) {
			checked.push(node("spinner", { label: [span("Refreshing…", "dim")] }));
		} else if (this.#refreshError) {
			checked.push(
				text([span(`Refresh failed: ${sanitizeDisplayLine(this.#textMask(this.#refreshError))}`, "warning")], {
					truncate: "end",
				}),
			);
		} else if (latestFetchedAt) {
			checked.push(
				text([span("checked", "dim")]),
				elapsed(Date.now() - latestFetchedAt),
				text([span("ago", "dim")]),
			);
		}
		const children: NativeChild[] = [
			node("row", { gap: "xs", align: "baseline", shrink: 1 }, checked, "checked"),
			node("spacer", { grow: 1 }),
			node(
				"tabs",
				{
					items: [
						{ id: "overview", label: "Overview" },
						{ id: "detail", label: "Details" },
					],
					active: this.#view,
				},
				undefined,
				"tabs",
			),
		];
		children.push(actionButton(this.#mask ? "Show accounts" : "Hide accounts", "privacy", { keys: "p" }));
		children.push(
			actionButton(this.#maskOrganizations ? "Show organizations" : "Hide organizations", "organization-privacy", {
				keys: "o",
			}),
		);
		if (this.#view === "overview")
			children.push(actionButton(this.#merge ? "Split accounts" : "Merge accounts", "grouping", { keys: "m" }));
		if (this.#options.refresh) children.push(actionButton("Refresh", "refresh", { keys: "r" }));
		return node("row", { role: "omp.usage.head", gap: "sm", align: "center" }, children, "head");
	}

	#describeOverview(meter: boolean, chart: boolean): NativeChild[] {
		const children: NativeChild[] = [];
		if (this.#cards.length === 0) {
			children.push(
				node("text", { spans: [span("No usage data available.")], role: "omp.usage.untouched" }, undefined, "none"),
			);
		} else {
			// Unlimited providers keep a frame reading "No limits"; only untouched ones collapse.
			const active = this.#cards.filter(entry => !entry.idle || entry.unlimited || entry.account !== undefined);
			const idle = this.#cards.filter(entry => entry.idle && !entry.unlimited && entry.account === undefined);
			if (active.length > 0) {
				children.push(
					node(
						"row",
						{ wrap: true, gap: "md", role: "omp.usage.grid" },
						active.map((entry, index) => this.#describeCard(entry, meter, index)),
						"providers",
					),
				);
			}
			if (idle.length > 0) {
				children.push(
					node(
						"text",
						{
							spans: [span(`Untouched: ${idle.map(entry => entry.name).join(", ")}`)],
							wrap: "word",
							role: "omp.usage.untouched",
						},
						undefined,
						"idle",
					),
				);
			}
		}
		children.push(this.#describeActivity(chart));
		return children;
	}

	#describeCard(entry: ProviderCard, meter: boolean, index: number): NativeNode {
		const cardStatus =
			entry.unavailableAccounts.length > 0
				? statusWithUnavailableAccounts(entry.windows)
				: entry.unlimited
					? "ok"
					: aggregateStatus(entry.windows);
		const head: NativeChild[] = [text([span(entry.name, "strong")], { truncate: "end" })];
		if (entry.account) head.push(text([span(entry.account, "muted")], { truncate: "middle" }));
		if (entry.accounts > 1) head.push(text([span(`${entry.accounts} accounts`, "muted")]));
		head.push(node("spacer", { grow: 1 }), statusDot(cardStatus));
		const children: NativeChild[] = [
			node("row", { role: "omp.usage.provider.head", gap: "sm", align: "center" }, head, "title"),
		];
		for (const account of entry.daybreakAccounts ?? []) {
			children.push(text([span(`Daybreak · ${sanitizeDisplayLine(account)}`, "success")], { truncate: "end" }));
		}
		if (entry.resetCredits) {
			const resets = entry.resetCredits;
			const details: string[] = [];
			if (resets.redeemableCount !== resets.bankedCount) details.push(`${resets.redeemableCount} usable now`);
			if (resets.soonestExpiryMs !== undefined) {
				details.push(
					resets.soonestExpiryMs > 0 ? `expires in ${formatDuration(resets.soonestExpiryMs)}` : "expired",
				);
			}
			if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0) {
				details.push(`unavailable: ${sanitizeDisplayLine(this.#textMask(resets.unavailableReasons.join(" • ")))}`);
			}
			const label = `${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"} banked`;
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center" },
					[
						node("badge", {
							text: label,
							tone: resets.redeemableCount > 0 ? "success" : "warning",
							title: details.length > 0 ? `${label} · ${details.join(" · ")}` : label,
						}),
					],
					"resets",
				),
			);
		}
		for (const account of entry.unavailableAccounts) {
			children.push(mutedText(`${sanitizeDisplayLine(account)}: usage unavailable`, true));
		}
		if (entry.unlimited) {
			children.push(mutedText("No limits"));
		} else {
			for (const [index, window] of entry.windows.slice(0, CARD_MAX_WINDOWS).entries()) {
				const label: TspSpan[] = [span(sanitizeDisplayLine(this.#textMask(window.label)))];
				if (window.windowTag) label.push(span(` ${sanitizeDisplayLine(this.#textMask(window.windowTag))}`, "dim"));
				const cells: NativeChild[] = [
					text(label, {
						role: "omp.usage.label",
						truncate: "middle",
						title: sanitizeDisplayLine(this.#textMask(window.label)),
					}),
				];
				if (window.fraction === undefined) {
					cells.push(text([span(this.#textMask(window.usedText ?? "No data"), "muted")], { truncate: "end" }));
				} else {
					const token =
						window.status === "exhausted" ? "error" : window.status === "warning" ? "warning" : undefined;
					const embedded = (this.#options.labelPlacement ?? "moving") === "moving";
					cells.push(
						usageMeter(
							window.fraction,
							window.status,
							meter,
							embedded ? [span(leftText(window.fraction), token)] : undefined,
						),
					);
					if (!embedded) cells.push(text([span(leftText(window.fraction), token)], { role: "omp.usage.pct" }));
					if (window.resetMs !== undefined) {
						const reset = resetLabel(this.#nowMs, window.resetMs);
						cells.push(text([span(reset.text, "dim")], { role: "omp.usage.reset", title: reset.title }));
					}
				}
				children.push(node("row", { role: "omp.usage.window", gap: "sm", align: "center" }, cells, `w${index}`));
			}
			const hidden = entry.windows.length - CARD_MAX_WINDOWS;
			if (hidden > 0) children.push(mutedText(`+${hidden} more`));
		}
		return node(
			"card",
			{ role: "omp.usage.provider", grow: 1, min: { w: `${CARD_MIN_WIDTH}ch` } },
			children,
			entry.account ? `${entry.provider}-${index}` : entry.provider,
		);
	}

	#describeActivity(chart: boolean): NativeNode {
		const head: NativeChild[] = [text([span("Activity", "strong")])];
		if (this.#syncing && this.#activity) head.push(node("spinner", { label: [span("Syncing", "dim")] }));
		const children: NativeChild[] = [node("row", { gap: "sm", align: "center" }, head, "head")];
		const points = this.#activity;
		if (this.#activityError) {
			const detail = this.#textMask(formatActivityErrorDetail(this.#activityError));
			children.push(
				mutedText(detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.", true),
			);
		} else if (!points) {
			children.push(node("spinner", { label: [span("Loading usage history…", "muted")] }));
		} else {
			const layout = buildHeatmapLayout(points, NATIVE_HEATMAP_WEEKS);
			const summary =
				layout.totalRequests > 0 || layout.totalCost > 0
					? `${formatActivityTotals(layout)} · last ${NATIVE_HEATMAP_WEEKS} weeks`
					: `No activity in the last ${NATIVE_HEATMAP_WEEKS} weeks`;
			children.push(chart ? this.#heatmapChart(layout, points, summary) : this.#heatmapTable(layout, summary));
		}
		return node("col", { role: "omp.usage.activity", gap: "sm" }, children, "activity");
	}

	/** The heatmap as a `chart`: 0–1 intensities, month columns, M/W/F rows, per-day tooltips. */
	#heatmapChart(layout: HeatmapLayout, points: readonly DailyActivityPoint[], summary: string): NativeNode {
		const byDay = new Map(points.map(point => [point.day, point]));
		const cells = layout.cells.map(days => days.map(level => (level === null ? null : level / 4)));
		const tips = layout.cells.map((days, day) =>
			days.map((level, week) => {
				if (level === null) return null;
				const date = addDays(layout.start, week * 7 + day);
				const point = byDay.get(localIso(date));
				if (!point || (point.cost <= 0 && point.requests <= 0)) return `${shortDate(date)} · No activity`;
				const requests = `${point.requests} request${point.requests === 1 ? "" : "s"}`;
				const cost = point.cost >= 100 ? `$${Math.round(point.cost)}` : `$${point.cost.toFixed(2)}`;
				return `${shortDate(date)} · ${cost} · ${requests}`;
			}),
		);
		// A month label needs room: drop one whose successor starts within two columns (GitHub's rule).
		const starts = layout.monthLabels.flatMap((label, at) => (label ? [{ at, label }] : []));
		const cols = starts.filter((entry, index) => {
			const next = starts[index + 1];
			return !next || next.at - entry.at > 2;
		});
		return node(
			"chart",
			{ kind: "heatmap", cells, cols, rows: HEATMAP_ROW_LABELS, tips, token: "accent", summary, size: "md" },
			undefined,
			"heatmap",
		);
	}

	/** The heatmap as a `table` of glyph cells, for terminals without `chart`. */
	#heatmapTable(layout: HeatmapLayout, summary: string): NativeNode {
		const cols: TspTableColumn[] = [{ id: "day", priority: NATIVE_HEATMAP_WEEKS }];
		for (let week = 0; week < NATIVE_HEATMAP_WEEKS; week++) {
			cols.push({ id: `w${week}`, align: "center", priority: week });
		}
		const rows = HEATMAP_DAY_LABELS.map((label, day) => {
			const cells: Record<string, TspText> = { day: [span(label, "dim")] };
			for (let week = 0; week < NATIVE_HEATMAP_WEEKS; week++) {
				const level = layout.cells[day][week];
				if (level === null) continue;
				cells[`w${week}`] = level === 0 ? [span("·", "dim")] : [span("■", HEAT_LEVEL_TOKENS[level - 1])];
			}
			return { id: `d${day}`, cells };
		});
		return node(
			"col",
			{ gap: "sm" },
			[mutedText(summary), node("table", { cols, rows }, undefined, "table")],
			"heatmap",
		);
	}

	/** Per provider: notes and saved resets as a `kv`, the limit buckets as a `table` (one row per account). */
	#describeDetail(): NativeChild[] {
		const nowMs = this.#nowMs;
		const grouped = new Map<string, UsageReport[]>();
		for (const report of collapseSharedUsageReports(this.#reports)) {
			const list = grouped.get(report.provider) ?? [];
			list.push(report);
			grouped.set(report.provider, list);
		}
		const unavailable = this.#options.unavailableAccounts ?? [];
		const sections: NativeChild[] = [];
		for (const entry of this.#cards.filter(
			(card, index, cards) => cards.findIndex(peer => peer.provider === card.provider) === index,
		)) {
			const reports = grouped.get(entry.provider) ?? [];
			const children: NativeChild[] = [];
			for (const account of unavailable) {
				if (account.provider !== entry.provider) continue;
				children.push(
					mutedText(
						`${sanitizeDisplayLine(this.#accountMask(formatUnavailableAccountLabel(account)))}: usage unavailable`,
						true,
					),
				);
			}

			const facts: { k: TspText; v: TspText }[] = [];
			const notes = [...new Set(reports.flatMap(report => report.notes ?? []))];
			if (notes.length > 0)
				facts.push({ k: [span("Notes", "muted")], v: sanitizeDisplayLine(this.#textMask(notes.join(" • "))) });
			for (const [index, report] of reports.entries()) {
				const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
				if (!resets || resets.bankedCount <= 0) continue;
				const value: TspSpan[] = [
					span(
						`${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}`,
						resets.redeemableCount > 0 ? "success" : "warning",
					),
				];
				if (resets.redeemableCount !== resets.bankedCount) {
					value.push(span(` · ${resets.redeemableCount} usable now`, "muted"));
				}
				if (resets.soonestExpiry) {
					const remaining = Date.parse(resets.soonestExpiry) - nowMs;
					const date = resets.soonestExpiry.slice(0, 10);
					value.push(
						span(
							remaining > 0 ? ` · expires in ${formatDuration(remaining)} (${date})` : ` · expired (${date})`,
							"muted",
						),
					);
				}
				if (resets.redeemableCount === 0 && resets.unavailableReason) {
					value.push(
						span(` · unavailable: ${sanitizeDisplayLine(this.#textMask(resets.unavailableReason))}`, "muted"),
					);
				}
				facts.push({
					k: [span(`Resets · ${this.#reportLabel(report, report.limits[0], index)}`, "muted")],
					v: value,
				});
			}
			if (facts.length > 0) children.push(node("kv", { items: facts, layout: "grid" }, undefined, "facts"));

			const buckets = new Map<string, { label: string; window?: string; rows: Record<string, TspText>[] }>();
			const limitNotes: string[] = [];
			for (const [index, report] of reports.entries()) {
				for (const limit of report.limits) {
					const label = sanitizeDisplayLine(formatLimitTitle(limit));
					const key = `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}`;
					let bucket = buckets.get(key);
					if (!bucket) {
						bucket = { label, window: detailWindowLabel(label, limit), rows: [] };
						buckets.set(key, bucket);
					}
					const fraction = resolveUsedFraction(limit);
					const token =
						limit.status === "exhausted" ? "error" : limit.status === "warning" ? "warning" : undefined;
					const resetsAt = limit.window?.resetsAt;
					bucket.rows.push({
						account: [span(this.#reportLabel(report, limit, index), "muted")],
						left:
							fraction === undefined
								? [span(this.#textMask(formatAbsoluteOnlyAmount([limit]) ?? "No data"), "muted")]
								: [span(leftText(fraction), token)],
						reset:
							resetsAt !== undefined && resetsAt > nowMs
								? [
										span(
											`${limit.window?.resetLabel ?? "resets"} in ${formatDuration(resetsAt - nowMs)}`,
											"dim",
										),
									]
								: "",
					});
					for (const note of limit.notes ?? []) limitNotes.push(sanitizeDisplayLine(this.#textMask(note)));
				}
			}
			if (buckets.size > 0) {
				const rows: { id: string; cells: Record<string, TspText> }[] = [];
				for (const bucket of buckets.values()) {
					for (const [index, cells] of bucket.rows.entries()) {
						const limitCell: TspSpan[] =
							index === 0
								? [
										span(this.#textMask(bucket.label)),
										...(bucket.window ? [span(` ${this.#textMask(bucket.window)}`, "dim")] : []),
									]
								: [];
						rows.push({ id: `r${rows.length}`, cells: { limit: limitCell, ...cells } });
					}
				}
				const cols: TspTableColumn[] = [
					{ id: "limit", head: "Limit", grow: 1, priority: 4 },
					{ id: "account", head: "Account", truncate: "middle", priority: 1 },
					{ id: "left", head: "Left", align: "end", priority: 3 },
					{ id: "reset", head: "Resets", align: "end", priority: 2 },
				];
				children.push(node("table", { cols, rows }, undefined, "limits"));
				for (const note of new Set(limitNotes)) children.push(mutedText(note, true));
			} else if (unavailable.every(account => account.provider !== entry.provider)) {
				children.push(mutedText("No limits"));
			}
			sections.push(
				node(
					"section",
					{ head: [span(entry.name, "strong")], role: "omp.usage.report" },
					[col(children, { gap: "sm" })],
					entry.provider,
				),
			);
		}
		if (sections.length === 0) sections.push(mutedText("No usage data available."));
		return sections;
	}

	/** Re-fetch the reports (`r` / Refresh); the last reports stay on failure, with the error in the head. */
	async #refresh(): Promise<void> {
		const refresh = this.#options.refresh;
		if (!refresh || this.#refreshing || this.#closed) return;
		this.#refreshing = true;
		this.#refreshError = null;
		this.#changed();
		try {
			const reports = await refresh();
			if (this.#closed) return;
			if (reports) {
				this.#reports = reports;
				this.#nowMs = Date.now();
				this.#rebuildCards();
				this.#detailCache = null;
			}
		} catch (error) {
			this.#refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#refreshing = false;
			if (!this.#closed) this.#changed();
		}
	}

	/** Invalidate the native description and repaint. */
	#changed(): void {
		this.#revision++;
		this.#options.requestRender();
	}

	#scrollBy(delta: number): void {
		this.#scroll = Math.max(0, this.#scroll + delta);
		this.#options.requestRender();
	}

	#setView(view: "overview" | "detail"): void {
		this.#view = view;
		this.#scroll = 0;
		this.#changed();
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#scrollBy(event.wheel * 2);
				return true;
			})
		) {
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "q")) {
			if (this.#view === "detail") {
				this.#setView("overview");
				return;
			}
			this.dispose();
			this.#options.onClose();
			return;
		}
		if (matchesKey(data, "r")) {
			void this.#refresh();
			return;
		}
		if (matchesKey(data, "o")) {
			this.#maskOrganizations = !this.#maskOrganizations;
			this.#rebuildCards();
			this.#changed();
			return;
		}
		if (matchesKey(data, "p")) {
			this.#mask = !this.#mask;
			this.#rebuildCards();
			this.#changed();
			return;
		}
		if (this.#view === "overview" && matchesKey(data, "m")) {
			this.#merge = !this.#merge;
			this.#scroll = 0;
			this.#rebuildCards();
			this.#changed();
			return;
		}
		if (
			this.#view === "overview" &&
			(matchesKey(data, "return") || matchesKey(data, "tab") || matchesKey(data, "d"))
		) {
			this.#setView("detail");
			return;
		}
		if (matchesSelectUp(data)) this.#scrollBy(-1);
		else if (matchesSelectDown(data)) this.#scrollBy(1);
		else if (matchesSelectPageUp(data)) this.#scrollBy(-this.#lastViewportRows);
		else if (matchesSelectPageDown(data)) this.#scrollBy(this.#lastViewportRows);
		else if (matchesKey(data, "home")) {
			this.#scroll = 0;
			this.#options.requestRender();
		} else if (matchesKey(data, "end")) this.#scrollBy(Number.MAX_SAFE_INTEGER);
	}
}
