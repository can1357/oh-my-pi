/**
 * Fullscreen `/usage` dashboard (the /settings idiom): mounted as an overlay
 * on the alternate screen so it takes no transcript space. Shows a compact
 * subscriptions grid (one card per provider, worst window per quota bucket)
 * above a GitHub-style daily activity heatmap fed by the local stats DB.
 * Enter flips into the classic full per-account report, scrollable in place.
 */
import * as os from "node:os";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { type Component, matchesKey, replaceTabs, routeSgrMouseInput, truncateToWidth, visibleWidth } from "../index";
import { colorLuma, formatDuration, hexToRgb, rgbToHex, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatProviderName } from "../chrome/format";
import {
	accountLabel,
	accountLabelsFor,
	aggregationLimit,
	collapseSharedAccountReports,
	collapseSharedUsageReports,
	formatLimitTitle,
	isNonEmptyString,
	reportIdentityKey,
	summarizeUsageResetCredits,
	type UsageResetSummary,
} from "./usage-display";
import { colorToAnsi } from "../theme/color";
import { ensureThemeSync, theme } from "../theme/theme";
import { formatAbsoluteOnlyAmount } from "../prompt/usage-amounts";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";

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
	/** Combined used fraction (0..1, >1 = overage); undefined when unreported. */
	fraction: number | undefined;
	status: UsageLimit["status"];
	/** Reset countdown of the worst account, ms from now, when in the future. */
	resetMs?: number;
	/** Absolute one-sided amount (e.g. `$12.34 used`, `100 credits left`) for limits without a fraction. */
	usedText?: string;
	/** Number of account reports contributing to this combined row. */
	reportedAccounts?: number;
	/** Number of accounts eligible for this quota bucket. */
	eligibleAccounts?: number;
}
/** Per-account availability summary shown in the initial usage dashboard. */
export interface AccountAvailability {
	/** Human-readable account identity, with a positional fallback. */
	label: string;
	/** Worst reported used fraction across this account's quota windows. */
	fraction: number | undefined;
	/** Availability derived from the account's individual limits. */
	status: NonNullable<UsageLimit["status"]>;
	/** Quota windows reported by this account, when available. */
	windows?: CardWindowRow[];
}

/** Compact per-provider summary backing one card in the subscriptions grid. */
export interface ProviderCard {
	provider: string;
	name: string;
	/** Number of accounts reporting for this provider. */
	accounts: number;
	/** Availability for each account, in report order. */
	accountStatuses: AccountAvailability[];
	/** Window rows sorted most-pressing first. */
	windows: CardWindowRow[];
	/** True when every account reports no limits (e.g. enterprise plans). */
	unlimited: boolean;
	/** True when nothing is used anywhere (or there are no limits). */
	idle: boolean;
	resetCredits?: {
		bankedCount: number;
		redeemableCount: number;
		soonestExpiryMs?: number;
		unavailableReasons: string[];
	};
}

/**
 * Resolve a limit status when a provider omits its normalized status field.
 * The dashboard still needs to distinguish available and exhausted accounts
 * when it has enough quantitative usage data to do so.
 */
function resolveLimitStatus(limit: UsageLimit): NonNullable<UsageLimit["status"]> {
	if (limit.status !== undefined) return limit.status;
	const fraction = resolveUsedFraction(limit);
	if (fraction !== undefined) {
		if (fraction >= 1) return "exhausted";
		if (fraction >= 0.9) return "warning";
		return "ok";
	}
	if (limit.amount.remaining !== undefined) return limit.amount.remaining > 0 ? "ok" : "exhausted";
	return "unknown";
}

/**
 * Aggregate status across a bucket's limits, mirroring the classic report:
 * a mix of healthy and pressured accounts reads as a warning, not as the
 * worst account's status.
 */
function aggregateStatus(
	limits: readonly { status?: NonNullable<UsageLimit["status"]> }[],
): NonNullable<UsageLimit["status"]> {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
}

function usageLimitTitle(report: UsageReport, limit: UsageLimit, planType = planTypeKey(report)): string {
	const label = formatLimitTitle(limit);
	const isCodexLimit = report.provider === "openai-codex";
	if (!isCodexLimit || !isNonEmptyString(planType) || label.toLowerCase().includes(planType.toLowerCase())) {
		return label;
	}
	return `${label} (${planType})`;
}

function accountStatus(report: UsageReport): NonNullable<UsageLimit["status"]> {
	if (report.limits.length === 0) return "ok";
	return aggregateStatus(report.limits.map(limit => ({ status: resolveLimitStatus(limit) })));
}

function accountAvailability(report: UsageReport, label: string, nowMs: number): AccountAvailability {
	const windows = buildWindowRows([report], nowMs);
	const fractions = report.limits
		.map(limit => resolveUsedFraction(limit))
		.filter((value): value is number => value !== undefined);
	return {
		label,
		fraction: fractions.length > 0 ? Math.max(...fractions) : undefined,
		status: accountStatus(report),
		windows,
	};
}
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

type WindowBucket = {
	label: string;
	limits: UsageLimit[];
	reportedAccounts: number;
	eligibleAccounts: number;
};

function aggregateUsedFraction(limits: readonly UsageLimit[]): number | undefined {
	const absolute = limits.map(limit => ({
		limit: limit.amount.limit,
		used: limit.amount.used,
		unit: limit.amount.unit,
	}));
	const unit = absolute[0]?.unit;
	if (
		unit !== undefined &&
		absolute.every(
			entry =>
				entry.unit === unit &&
				entry.limit !== undefined &&
				Number.isFinite(entry.limit) &&
				entry.limit > 0 &&
				entry.used !== undefined &&
				Number.isFinite(entry.used),
		)
	) {
		const totalLimit = absolute.reduce((sum, entry) => sum + entry.limit!, 0);
		if (totalLimit > 0) return absolute.reduce((sum, entry) => sum + entry.used!, 0) / totalLimit;
	}

	const fractions = limits
		.map(limit => resolveUsedFraction(limit))
		.filter((value): value is number => value !== undefined);
	return fractions.length > 0 ? fractions.reduce((sum, value) => sum + value, 0) / fractions.length : undefined;
}

function planTypeKey(report: UsageReport): string | undefined {
	const planType = report.metadata?.planType;
	return isNonEmptyString(planType) ? planType.toLowerCase() : undefined;
}

type PlanCoverage = {
	byReport: Map<UsageReport, string | undefined>;
	counts: Map<string, number>;
	unknown: number;
};

function inferPlanTypes(reports: readonly UsageReport[]): Map<string, string | undefined> {
	const inferred = new Map<string, string | undefined>();
	for (const report of reports) {
		const identity = reportIdentityKey(report);
		const plan = planTypeKey(report);
		if (identity === undefined || plan === undefined) continue;
		const prior = inferred.get(identity);
		inferred.set(identity, inferred.has(identity) && prior !== plan ? undefined : plan);
	}
	return inferred;
}

function effectivePlanType(report: UsageReport, inferred: ReadonlyMap<string, string | undefined>): string | undefined {
	const direct = planTypeKey(report);
	if (direct !== undefined) return direct;
	const identity = reportIdentityKey(report);
	return identity === undefined ? undefined : inferred.get(identity);
}

function resolvePlanCoverage(reports: readonly UsageReport[]): PlanCoverage {
	const inferred = inferPlanTypes(reports);
	const byReport = new Map<UsageReport, string | undefined>();
	const counts = new Map<string, number>();
	let unknown = 0;
	for (const report of reports) {
		const plan = effectivePlanType(report, inferred);
		byReport.set(report, plan);
		if (plan === undefined) unknown++;
		else counts.set(plan, (counts.get(plan) ?? 0) + 1);
	}
	return { byReport, counts, unknown };
}

function eligibleAccountCount(coverage: PlanCoverage, report: UsageReport): number {
	const plan = coverage.byReport.get(report);
	return plan === undefined ? coverage.unknown : (coverage.counts.get(plan) ?? 1);
}

function windowBucketKey(
	report: UsageReport,
	limit: UsageLimit,
	planType: string | undefined,
): { key: string; label: string } {
	const label = usageLimitTitle(report, limit, planType);
	const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
	return { key: `${label}|${windowId}|${limit.scope.tier ?? ""}`, label };
}

function addLimitToBucket(
	buckets: Map<string, WindowBucket>,
	reportedKeys: Set<string>,
	report: UsageReport,
	limit: UsageLimit,
	planType: string | undefined,
	eligibleAccounts: number,
): void {
	const { key, label } = windowBucketKey(report, limit, planType);
	const entry = buckets.get(key) ?? {
		label,
		limits: [],
		reportedAccounts: 0,
		eligibleAccounts,
	};
	entry.limits.push(aggregationLimit(report, limit));
	if (!reportedKeys.has(key)) {
		entry.reportedAccounts++;
		reportedKeys.add(key);
	}
	buckets.set(key, entry);
}

function collectWindowBuckets(reports: readonly UsageReport[]): WindowBucket[] {
	const buckets = new Map<string, WindowBucket>();
	const coverage = resolvePlanCoverage(reports);
	for (const report of reports) {
		const planType = coverage.byReport.get(report);
		const eligibleAccounts = eligibleAccountCount(coverage, report);
		const reportedKeys = new Set<string>();
		for (const limit of report.limits) {
			addLimitToBucket(buckets, reportedKeys, report, limit, planType, eligibleAccounts);
		}
	}
	return [...buckets.values()];
}

function buildWindowRow(bucket: WindowBucket, nowMs: number): CardWindowRow {
	const fraction = aggregateUsedFraction(bucket.limits);
	const worst = bucket.limits.reduce((max, limit) =>
		(resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(max) ?? -1) ? limit : max,
	);
	const resetsAt = worst.window?.resetsAt;
	return {
		label: bucket.label,
		windowTag: worst.window ? compactWindowTag(worst.window) : undefined,
		fraction,
		status: aggregateStatus(bucket.limits.map(limit => ({ status: resolveLimitStatus(limit) }))),
		resetMs: resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined,
		usedText: fraction === undefined ? formatAbsoluteOnlyAmount(bucket.limits) : undefined,
		reportedAccounts: bucket.reportedAccounts,
		eligibleAccounts: bucket.eligibleAccounts,
	};
}

function clearUniqueWindowTags(windows: CardWindowRow[]): void {
	for (const window of windows) {
		const duplicated = windows.some(other => other !== window && other.label === window.label);
		if (!duplicated) window.windowTag = undefined;
	}
}

function buildWindowRows(reports: readonly UsageReport[], nowMs: number): CardWindowRow[] {
	const windows = collectWindowBuckets(reports).map(bucket => buildWindowRow(bucket, nowMs));
	windows.sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1));
	// The window tag earns its columns only when sibling rows would otherwise
	// be indistinguishable (e.g. Antigravity's daily vs weekly "Usage (Google)").
	clearUniqueWindowTags(windows);
	return windows;
}

/**
 * Collapse usage reports into one compact card per provider: limits grouped by
 * quota bucket (label + window), each bucket showing a capacity-weighted used
 * fraction when absolute used/limit values exist, otherwise the mean fraction
 * across reporting accounts. The most-used account supplies the reset countdown.
 * Cards also retain one availability row per account so the initial dashboard
 * never hides account-level capacity. Cards sort most-pressing first and retain
 * an idle marker for model consumers.
 */
export function buildProviderCards(reports: UsageReport[], nowMs: number): ProviderCard[] {
	const displayReports = collapseSharedAccountReports(collapseSharedUsageReports(reports));
	const grouped = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}

	const cards: ProviderCard[] = [];
	for (const [provider, providerReports] of grouped) {
		const windows = buildWindowRows(providerReports, nowMs);
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
		const labels = accountLabelsFor(providerReports);
		cards.push({
			provider,
			name: formatProviderName(provider),
			accounts: providerReports.length,
			accountStatuses: providerReports.map((report, index) =>
				accountAvailability(report, labels[index] ?? accountLabel(report, index), nowMs),
			),
			windows,
			unlimited: windows.length === 0,
			idle:
				!resetCredits && windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
			resetCredits,
		});
	}

	cards.sort((a, b) => {
		const aWorst = a.windows[0]?.fraction ?? -1;
		const bWorst = b.windows[0]?.fraction ?? -1;
		if (aWorst !== bWorst) return bWorst - aWorst;
		return a.name.localeCompare(b.name);
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
	};
}

// =============================================================================
// Component
// =============================================================================

/** Callbacks and data sources for {@link UsageDashboardComponent}. */
export interface UsageDashboardOptions {
	reports: UsageReport[];
	/**
	 * Full classic `/usage` report for the expanded detail view; re-invoked per
	 * terminal width.
	 */
	renderDetail: (width: number) => string;
	/**
	 * Stream daily activity into the heatmap: push cached DB rows immediately,
	 * then push again after an incremental session sync. Resolves when the sync
	 * settles; rejection renders as a dim unavailable note. `signal` aborts when
	 * the dashboard closes so an in-flight sync can stop early.
	 */
	loadActivity: (push: (points: DailyActivityPoint[]) => void, signal: AbortSignal) => Promise<void>;
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
const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 3;
const CARD_MAX_WINDOWS = 4;
const MIN_BAR_WIDTH = 8;

export class UsageDashboardComponent implements Component {
	#options: UsageDashboardOptions;
	#cards: ProviderCard[];
	#nowMs: number;
	#view: "overview" | "detail" = "overview";
	#scroll = 0;
	#activity: DailyActivityPoint[] | null = null;
	#activityError: string | null = null;
	#syncing = true;
	#detailCache: { width: number; lines: string[] } | null = null;
	#lastViewportRows = 10;
	#closed = false;
	readonly #panel: OverlayPanel;
	readonly #header: PanelRows;
	readonly #body: PanelRows;
	readonly #footer: PanelRows;
	readonly #closeController = new AbortController();

	constructor(options: UsageDashboardOptions) {
		ensureThemeSync();
		this.#options = options;
		this.#nowMs = Date.now();
		this.#cards = buildProviderCards(options.reports, this.#nowMs);
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

	async #loadActivity(): Promise<void> {
		try {
			await this.#options.loadActivity(points => {
				if (this.#closed) return;
				this.#activity = points;
				this.#options.requestRender();
			}, this.#closeController.signal);
		} catch (error) {
			this.#activityError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#syncing = false;
			if (!this.#closed) this.#options.requestRender();
		}
	}

	invalidate(): void {
		this.#detailCache = null;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#closeController.abort();
		this.#panel.dispose();
	}

	// ---------------------------------------------------------------------------
	// Subscriptions grid rendering
	// ---------------------------------------------------------------------------

	#statusIcon(status: UsageLimit["status"]): string {
		if (status === "exhausted") return theme.fg("error", theme.status.error);
		if (status === "warning") return theme.fg("warning", theme.status.warning);
		if (status === "ok") return theme.fg("success", theme.status.success);
		return theme.fg("dim", theme.status.info);
	}

	#statusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
		if (status === "exhausted") return "error";
		if (status === "warning") return "warning";
		if (status === "ok") return "success";
		return "dim";
	}
	#statusLabel(status: NonNullable<UsageLimit["status"]>): string {
		if (status === "ok") return "available";
		if (status === "warning") return "warning";
		if (status === "exhausted") return "exhausted";
		return "unknown";
	}

	#miniBar(fraction: number | undefined, status: UsageLimit["status"], width: number): string {
		if (fraction === undefined) return theme.fg("dim", "·".repeat(width));
		const clamped = Math.min(Math.max(fraction, 0), 1);
		const filled = Math.round(clamped * width);
		const bar = "█".repeat(filled);
		const empty = "░".repeat(width - filled);
		return `${theme.fg(this.#statusColor(status), bar)}${theme.fg("dim", empty)}`;
	}
	#resetColumnWidth(windows: CardWindowRow[]): number {
		let width = 0;
		for (const window of windows) {
			if (window.resetMs !== undefined) width = Math.max(width, formatDuration(window.resetMs).length);
		}
		return width;
	}

	#windowLabel(window: CardWindowRow, labelWidth: number): string {
		const tagPlain =
			window.windowTag && labelWidth >= 3
				? truncateToWidth(window.windowTag, Math.max(1, Math.floor(labelWidth / 2) - 1))
				: "";
		const baseWidth = tagPlain ? Math.max(1, labelWidth - visibleWidth(tagPlain) - 1) : labelWidth;
		const basePlain = truncateToWidth(sanitizeText(window.label), baseWidth);
		const paddedBase = basePlain + " ".repeat(Math.max(0, baseWidth - visibleWidth(basePlain)));
		return tagPlain ? `${theme.fg("muted", paddedBase)} ${theme.fg("dim", tagPlain)}` : theme.fg("muted", paddedBase);
	}

	#windowResetText(window: CardWindowRow, resetWidth: number): string {
		const resetPlain = window.resetMs !== undefined ? formatDuration(window.resetMs) : "";
		return resetWidth > 0 ? ` ${theme.fg("dim", resetPlain.padStart(resetWidth))}` : "";
	}

	#renderWindowLine(
		window: CardWindowRow,
		width: number,
		contentWidth: number,
		indent: string,
		labelWidth: number,
		barWidth: number,
		resetWidth: number,
		coverageWidth: number,
		totalAccounts: number,
	): string {
		const label = this.#windowLabel(window, labelWidth);
		const resetText = this.#windowResetText(window, resetWidth);
		const coverageAccounts = window.eligibleAccounts ?? totalAccounts;
		const coverageText =
			coverageAccounts > 1 && window.reportedAccounts !== undefined && window.reportedAccounts < coverageAccounts
				? ` ${window.reportedAccounts}/${coverageAccounts}`
				: "";
		const coverageDisplay = theme.fg("dim", coverageText.padEnd(coverageWidth));
		if (window.fraction === undefined) {
			const usedWidth = Math.max(
				1,
				contentWidth - labelWidth - 1 - coverageWidth - (resetWidth > 0 ? resetWidth + 1 : 0),
			);
			const text = truncateToWidth(window.usedText ?? "no data", usedWidth).padEnd(usedWidth);
			return truncateToWidth(`${indent}${label} ${theme.fg("dim", text)}${coverageDisplay}${resetText}`, width);
		}
		const freePct = Math.min(100, Math.max(0, Math.round((1 - window.fraction) * 100)));
		const pctText = theme.fg(this.#statusColor(window.status), `${freePct}%`.padStart(5));
		return truncateToWidth(
			`${indent}${label} ${this.#miniBar(window.fraction, window.status, barWidth)}${pctText}${coverageDisplay}${resetText}`,
			width,
		);
	}

	#renderWindowLines(
		windows: CardWindowRow[],
		width: number,
		indent: string,
		maxWindows: number = CARD_MAX_WINDOWS,
		totalAccounts: number = 1,
	): string[] {
		const contentWidth = Math.max(1, width - indent.length);
		const hidden = Math.max(0, windows.length - maxWindows);
		const visibleWindows = windows.slice(0, maxWindows);
		const resetWidth = this.#resetColumnWidth(visibleWindows);
		const coverageWidth = visibleWindows.reduce((width, window) => {
			const coverageAccounts = window.eligibleAccounts ?? totalAccounts;
			if (
				coverageAccounts <= 1 ||
				window.reportedAccounts === undefined ||
				window.reportedAccounts >= coverageAccounts
			) {
				return width;
			}
			return Math.max(width, ` ${window.reportedAccounts}/${coverageAccounts}`.length);
		}, 0);
		const fixedWidth = 1 + 5 + coverageWidth + (resetWidth > 0 ? resetWidth + 1 : 0);
		const labelWidth = Math.max(1, Math.min(16, contentWidth - fixedWidth - 1 - MIN_BAR_WIDTH));
		const barWidth = Math.max(0, contentWidth - labelWidth - fixedWidth - 1);
		const lines = visibleWindows.map(window =>
			this.#renderWindowLine(
				window,
				width,
				contentWidth,
				indent,
				labelWidth,
				barWidth,
				resetWidth,
				coverageWidth,
				totalAccounts,
			),
		);
		if (hidden > 0) lines.push(`${indent}${theme.fg("dim", `+${hidden} more`)}`);
		return lines;
	}

	#renderAccountLines(account: AccountAvailability, width: number): string[] {
		const freeText =
			account.fraction === undefined
				? ""
				: `· ${Math.round(Math.max(0, Math.min(100, (1 - account.fraction) * 100)))}% free`;
		const status = this.#statusLabel(account.status);
		const statusText = `${this.#statusIcon(account.status)} ${theme.fg(this.#statusColor(account.status), status)}`;
		const labelWidth = Math.max(1, width - 2 - visibleWidth(statusText) - freeText.length - 2);
		const label = truncateToWidth(sanitizeText(account.label), labelWidth);
		const accountWindows = account.windows ?? [];
		return [
			`  ${label} ${statusText}${freeText ? ` ${theme.fg("dim", freeText)}` : ""}`,
			...this.#renderWindowLines(accountWindows, width, "    ", accountWindows.length),
		];
	}

	#renderCardLines(card: ProviderCard, width: number): string[] {
		const lines: string[] = [];
		const cardStatus = card.unlimited ? "ok" : aggregateStatus(card.windows);
		const accountsText = card.accounts > 1 ? theme.fg("dim", `${card.accounts} accts`) : "";
		const titleBudget = width - 2 - visibleWidth(accountsText) - (accountsText ? 1 : 0);
		const title = theme.bold(truncateToWidth(card.name, Math.max(4, titleBudget)));
		const titlePad = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(accountsText));
		lines.push(`${this.#statusIcon(cardStatus)} ${title}${" ".repeat(titlePad)}${accountsText}`);
		for (const account of card.accountStatuses) lines.push(...this.#renderAccountLines(account, width));

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
				const reason = sanitizeText(resets.unavailableReasons.join(" • ").replace(/[\r\n\t]+/g, " "));
				lines.push(`  ${theme.fg("dim", truncateToWidth(`unavailable: ${reason}`, width - 2))}`);
			}
		}

		if (card.unlimited) {
			lines.push(`  ${theme.fg("dim", "no limits")}`);
			return lines;
		}

		lines.push(`  ${theme.fg("muted", "combined")}`);
		lines.push(...this.#renderWindowLines(card.windows, width, "    ", undefined, card.accounts));
		return lines;
	}

	#renderCardsGrid(innerWidth: number): string[] {
		if (this.#cards.length === 0) return [theme.fg("dim", "No usage data available.")];
		const active = this.#cards;
		const columns = Math.max(1, Math.floor((innerWidth + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER)));
		const cardWidth = Math.floor((innerWidth - (columns - 1) * CARD_GUTTER) / columns);
		const lines: string[] = [];
		for (let start = 0; start < active.length; start += columns) {
			const rowCards = active.slice(start, start + columns).map(card => this.#renderCardLines(card, cardWidth));
			const height = Math.max(...rowCards.map(card => card.length));
			for (let lineIdx = 0; lineIdx < height; lineIdx++) {
				const segments = rowCards.map(card => {
					const line = card[lineIdx] ?? "";
					return line + " ".repeat(Math.max(0, cardWidth - visibleWidth(line)));
				});
				lines.push(segments.join(" ".repeat(CARD_GUTTER)).trimEnd());
			}
			if (start + columns < active.length) lines.push("");
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
			const detail = formatActivityErrorDetail(this.#activityError);
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

	#overviewLines(innerWidth: number): string[] {
		const lines: string[] = [];
		lines.push(...this.#renderCardsGrid(innerWidth));
		lines.push("");
		lines.push(...this.#renderHeatmap(innerWidth));
		return lines;
	}

	#detailLines(innerWidth: number): string[] {
		if (this.#detailCache?.width !== innerWidth) {
			this.#detailCache = { width: innerWidth, lines: this.#options.renderDetail(innerWidth).split("\n") };
		}
		return this.#detailCache.lines;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(20, width - 4);

		const contentSource = this.#view === "detail" ? this.#detailLines(innerWidth) : this.#overviewLines(innerWidth);
		// Fixed chrome: top border, blank, content…, divider, hint, bottom border.
		const contentRows = Math.max(5, height - 5);
		this.#lastViewportRows = contentRows;
		const maxScroll = Math.max(0, contentSource.length - contentRows);
		if (this.#scroll > maxScroll) this.#scroll = maxScroll;

		const latestFetchedAt = Math.max(0, ...this.#options.reports.map(report => report.fetchedAt ?? 0));
		const checkedText = latestFetchedAt ? `checked ${formatDuration(this.#nowMs - latestFetchedAt)} ago` : "";
		const title = this.#view === "detail" ? "Usage · Details" : "Usage";

		const scrollHint = maxScroll > 0 ? "↑/↓ scroll · " : "";
		const hint = this.#view === "detail" ? `${scrollHint}Esc back` : `${scrollHint}↵ details · Esc close`;
		this.#panel.title = title;
		this.#header.setLines([checkedText ? theme.fg("dim", checkedText) : ""]);
		this.#body.setLines(contentSource.slice(this.#scroll, this.#scroll + contentRows));
		this.#body.setHeight(contentRows);
		this.#footer.setLines([theme.fg("dim", hint)]);
		return this.#panel.render(width);
	}

	#scrollBy(delta: number): void {
		this.#scroll = Math.max(0, this.#scroll + delta);
		this.#options.requestRender();
	}

	#setView(view: "overview" | "detail"): void {
		this.#view = view;
		this.#scroll = 0;
		this.#options.requestRender();
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
