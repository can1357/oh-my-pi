/**
 * `/usage` data: provider quota cards (one per provider, one row per quota
 * bucket), the daily activity calendar and its headline figures, and the
 * dashboard's state (view, scroll, activity load, refresh). The native tree
 * (`usage-dashboard.tsx`) and the terminal look (`styles/panels/usage-dashboard.ts`)
 * both read {@link UsageDashboardModel}.
 */
import * as os from "node:os";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { signal, untrack } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { UnavailableUsageAccount } from "../../../modes/view-model/overlays/usage-dashboard";
import { formatProviderName } from "../../../modes/view-model/chrome/format";
import { formatRemainingOnlyTotal, isUsedOnlyAbsoluteAmount } from "../../../slash-commands/helpers/usage-amounts";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
	type UsageResetSummary,
} from "../../../session/usage-display";
import { listKeyId } from "../../../config/keybindings/matchers";

export type { UnavailableUsageAccount };

/** One local calendar day of activity (`day` is `YYYY-MM-DD`). */
export interface DailyActivityPoint {
	day: string;
	cost: number;
	requests: number;
}

export type LimitStatus = UsageLimit["status"];

// ─── Provider cards ──────────────────────────────────────────────────────────

/** One quota bucket of a provider: the mean across its accounts. */
export interface QuotaRow {
	readonly label: string;
	/** Short window tag (`5h`, `7d`, `mo`), kept only when sibling rows share the label. */
	readonly windowTag?: string;
	/** Mean used fraction (0..1, above 1 = overage); undefined when no account reports one. */
	readonly fraction: number | undefined;
	readonly status: LimitStatus;
	/** Countdown of the fullest account's reset, when in the future. */
	readonly resetMs?: number;
	/** One-sided amount (`$12.34 used`, `100 credits left`) of a bucket without a fraction. */
	readonly amount?: string;
}

export interface ResetCredits {
	readonly bankedCount: number;
	readonly redeemableCount: number;
	readonly soonestExpiryMs?: number;
	readonly unavailableReasons: readonly string[];
}

/** One provider's quota summary. */
export interface ProviderCard {
	readonly provider: string;
	readonly name: string;
	/** Accounts represented, unavailable lookups included. */
	readonly accounts: number;
	readonly unavailableAccounts: readonly string[];
	/** Rows in declared order with the fullest {@link CARD_MAX_WINDOWS} first. */
	readonly windows: readonly QuotaRow[];
	/** No account reports any limit (and none is unavailable). */
	readonly unlimited: boolean;
	readonly notes: readonly string[];
	/** Nothing used anywhere: collapses into the "untouched" line. */
	readonly idle: boolean;
	readonly resetCredits?: ResetCredits;
	readonly daybreakAccounts?: readonly string[];
}

/** Quota rows a card shows before "+N more". */
export const CARD_MAX_WINDOWS = 4;
/** Below this a window counts as untouched. */
const IDLE_FRACTION = 0.005;

/** Status of a bucket over its accounts: healthy beside pressured reads as a warning. */
export function aggregateStatus(limits: readonly { status?: LimitStatus }[]): LimitStatus {
	const has = (status: LimitStatus) => limits.some(limit => limit.status === status);
	if (has("ok")) return has("warning") || has("exhausted") ? "warning" : "ok";
	if (has("warning")) return "warning";
	if (has("exhausted")) return "exhausted";
	return "unknown";
}

/** A card's status: unavailable accounts raise it to a warning (never hiding exhaustion). */
export function cardStatus(card: ProviderCard): LimitStatus {
	if (card.unavailableAccounts.length > 0) {
		if (card.windows.length === 0) return "unknown";
		return aggregateStatus(card.windows) === "exhausted" ? "exhausted" : "warning";
	}
	return card.unlimited ? "ok" : aggregateStatus(card.windows);
}

/** Tone of a bar-less amount from its status (none when informational). */
export function pressureTone(status: LimitStatus): "error" | "warning" | undefined {
	return status === "exhausted" ? "error" : status === "warning" ? "warning" : undefined;
}

/** A bar-less bucket's text: its amount, else exhausted/no data. */
export function amountText(amount: string | undefined, status: LimitStatus, capitalized: boolean): string {
	if (amount !== undefined) return amount;
	if (status === "exhausted") return capitalized ? "Exhausted" : "exhausted";
	return capitalized ? "No data" : "no data";
}

function windowTag(window: NonNullable<UsageLimit["window"]>): string {
	if (window.durationMs) {
		const hours = window.durationMs / 3_600_000;
		if (hours >= 28 * 24) return "mo";
		return hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
	}
	const id = window.id.toLowerCase();
	return id.length <= 3 ? id : id.slice(0, 1);
}

/** Spend-to-date (the highest across accounts) or prepaid headroom of limits without a fraction. */
export function absoluteAmount(limits: readonly UsageLimit[]): string | undefined {
	const first = limits[0];
	if (!first) return undefined;
	if (limits.every(isUsedOnlyAbsoluteAmount)) {
		const unit = first.amount.unit;
		if (!limits.every(limit => limit.amount.unit === unit)) return undefined;
		const used = Math.max(0, ...limits.map(limit => limit.amount.used ?? 0));
		if (unit === "usd") return `$${used.toFixed(2)} used`;
		return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(used)} ${unit} used`;
	}
	return formatRemainingOnlyTotal(limits);
}

/** Bucket key: the shared group, else label + window + id (distinct buckets may share label and window). */
export function bucketKey(label: string, limit: UsageLimit): string {
	return limit.scope.sharedGroup ?? `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}|${limit.id}`;
}

function accountIdentity(report: UsageReport, index: number): string {
	const metadata = report.metadata;
	const pick = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	return pick(metadata?.email) ?? pick(metadata?.accountId) ?? `account ${index + 1}`;
}

function resetCreditsOf(reports: readonly UsageReport[], nowMs: number): ResetCredits | undefined {
	const summaries = reports
		.map(report => summarizeUsageResetCredits(report.resetCredits, nowMs))
		.filter((summary): summary is UsageResetSummary => summary !== undefined && summary.bankedCount > 0);
	const bankedCount = summaries.reduce((total, summary) => total + summary.bankedCount, 0);
	if (bankedCount <= 0) return undefined;
	const expiries = summaries
		.map(summary => (summary.soonestExpiry === undefined ? Number.NaN : Date.parse(summary.soonestExpiry)))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const soonest = expiries.find(expiry => expiry > nowMs) ?? expiries.at(-1);
	return {
		bankedCount,
		redeemableCount: summaries.reduce((total, summary) => total + summary.redeemableCount, 0),
		soonestExpiryMs: soonest === undefined ? undefined : soonest - nowMs,
		unavailableReasons: [
			...new Set(summaries.flatMap(summary => (summary.unavailableReason ? [summary.unavailableReason] : []))),
		],
	};
}

/**
 * One card per provider: limits grouped into buckets (mean fraction across
 * accounts, the fullest account's reset), declared order with the fullest
 * buckets leading; cards ordered fullest first, then by name.
 */
export function buildProviderCards(
	reports: readonly UsageReport[],
	nowMs: number,
	unavailable: readonly UnavailableUsageAccount[] = [],
): ProviderCard[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of collapseSharedUsageReports([...reports])) {
		let list = byProvider.get(report.provider);
		if (!list) byProvider.set(report.provider, (list = []));
		list.push(report);
	}
	for (const account of unavailable) if (!byProvider.has(account.provider)) byProvider.set(account.provider, []);

	const cards: { card: ProviderCard; fullest: number }[] = [];
	for (const [provider, providerReports] of byProvider) {
		const missing = unavailable.filter(account => account.provider === provider).map(account => account.label);
		const buckets = new Map<string, { label: string; limits: UsageLimit[] }>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const label = formatLimitTitle(limit);
				const key = bucketKey(label, limit);
				let bucket = buckets.get(key);
				if (!bucket) buckets.set(key, (bucket = { label, limits: [] }));
				bucket.limits.push(limit);
			}
		}
		const declared = [...buckets.values()].map(({ label, limits }) => {
			const fractions = limits.map(resolveUsedFraction).filter((value): value is number => value !== undefined);
			const fraction = fractions.length > 0 ? fractions.reduce((a, b) => a + b, 0) / fractions.length : undefined;
			let fullest = limits[0]!;
			for (const limit of limits) {
				if ((resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(fullest) ?? -1)) fullest = limit;
			}
			const resetsAt = fullest.window?.resetsAt;
			return {
				label,
				tag: fullest.window ? windowTag(fullest.window) : undefined,
				fraction,
				status: aggregateStatus(limits),
				resetMs: resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined,
				amount: fraction === undefined ? absoluteAmount(limits) : undefined,
			};
		});
		const leading = new Set(
			[...declared].sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1)).slice(0, CARD_MAX_WINDOWS),
		);
		const ordered = [...declared.filter(row => leading.has(row)), ...declared.filter(row => !leading.has(row))];
		const windows: QuotaRow[] = ordered.map(row => ({
			label: row.label,
			windowTag: ordered.some(other => other !== row && other.label === row.label) ? row.tag : undefined,
			fraction: row.fraction,
			status: row.status,
			resetMs: row.resetMs,
			amount: row.amount,
		}));
		const resetCredits = resetCreditsOf(providerReports, nowMs);
		const daybreak = providerReports.flatMap((report, index) =>
			report.metadata?.daybreak === true ? [accountIdentity(report, index)] : [],
		);
		const card: ProviderCard = {
			provider,
			name: formatProviderName(provider),
			accounts: providerReports.length + missing.length,
			unavailableAccounts: missing,
			windows,
			unlimited: windows.length === 0 && missing.length === 0,
			notes: [...new Set(providerReports.flatMap(report => report.notes ?? []))],
			idle:
				missing.length === 0 &&
				!resetCredits &&
				daybreak.length === 0 &&
				windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
			resetCredits,
			...(daybreak.length > 0 ? { daybreakAccounts: daybreak } : {}),
		};
		cards.push({ card, fullest: Math.max(-1, ...windows.map(window => window.fraction ?? -1)) });
	}
	cards.sort((a, b) => (a.fullest !== b.fullest ? b.fullest - a.fullest : a.card.name.localeCompare(b.card.name)));
	return cards.map(entry => entry.card);
}

// ─── Activity calendar ───────────────────────────────────────────────────────

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localIso(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfDay(ms: number): Date {
	const date = new Date(ms);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `Mon 28 Sep`. */
export function shortDate(date: Date): string {
	return `${WEEKDAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** Monday-first week columns ending with today's week. */
export interface Calendar {
	/** Month name on the first column of each month. */
	readonly monthLabels: readonly (string | undefined)[];
	/** 7 rows (Mon..Sun) × weeks; level 0..4, null for days after today. */
	readonly cells: readonly (readonly (number | null)[])[];
	readonly totalCost: number;
	readonly totalRequests: number;
	/** Monday of the first column. */
	readonly start: Date;
	readonly today: Date;
}

/**
 * Lay out `weeks` week columns ending at today's. A day's level grows with
 * the square root of its share of the busiest day's cost (request counts when
 * nothing in range is priced).
 */
export function buildCalendar(points: readonly DailyActivityPoint[], weeks: number, nowMs: number): Calendar {
	const byDay = new Map(points.map(point => [point.day, point]));
	const priced = points.some(point => point.cost > 0);
	const metric = (point: DailyActivityPoint) => (priced ? point.cost : point.requests);
	const today = startOfDay(nowMs);
	const start = addDays(today, -((today.getDay() + 6) % 7) - (weeks - 1) * 7);
	const first = localIso(start);
	const last = localIso(today);
	const inRange = points.filter(point => point.day >= first && point.day <= last);
	const max = Math.max(0, ...inRange.map(metric));
	const level = (value: number) =>
		value <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
	const monthLabels: (string | undefined)[] = [];
	const cells = Array.from({ length: 7 }, () => Array.from({ length: weeks }, (): number | null => null));
	let month = -1;
	for (let week = 0; week < weeks; week++) {
		const monday = addDays(start, week * 7);
		monthLabels.push(monday.getMonth() !== month ? MONTH_NAMES[monday.getMonth()] : undefined);
		month = monday.getMonth();
		for (let day = 0; day < 7; day++) {
			const date = addDays(monday, day);
			if (date > today) continue;
			const point = byDay.get(localIso(date));
			cells[day]![week] = level(point ? metric(point) : 0);
		}
	}
	return {
		monthLabels,
		cells,
		totalCost: inRange.reduce((sum, point) => sum + point.cost, 0),
		totalRequests: inRange.reduce((sum, point) => sum + point.requests, 0),
		start,
		today,
	};
}

export interface ActivityDay {
	readonly date: Date;
	readonly cost: number;
	readonly requests: number;
}

/** Days behind the "Last 30 days" figure and spark. */
const MONTH_DAYS = 30;

/** Headline figures of the calendar's range. */
export interface ActivityFigures {
	/** Any day is priced (else figures count requests). */
	readonly priced: boolean;
	readonly month: readonly ActivityDay[];
	readonly monthCost: number;
	readonly monthRequests: number;
	readonly busiest?: ActivityDay;
	readonly activeDays: number;
	readonly longestStreak: number;
}

export function activityFigures(points: readonly DailyActivityPoint[], calendar: Calendar): ActivityFigures {
	const byDay = new Map(points.map(point => [point.day, point]));
	const priced = calendar.totalCost > 0;
	const weight = (day: ActivityDay) => (priced ? day.cost : day.requests);
	const month: ActivityDay[] = [];
	for (let back = MONTH_DAYS - 1; back >= 0; back--) {
		const date = addDays(calendar.today, -back);
		const point = byDay.get(localIso(date));
		month.push({ date, cost: point?.cost ?? 0, requests: point?.requests ?? 0 });
	}
	let busiest: ActivityDay | undefined;
	let activeDays = 0;
	let streak = 0;
	let longestStreak = 0;
	for (let date = calendar.start; date <= calendar.today; date = addDays(date, 1)) {
		const point = byDay.get(localIso(date));
		if (!point || (point.cost <= 0 && point.requests <= 0)) {
			streak = 0;
			continue;
		}
		activeDays++;
		longestStreak = Math.max(longestStreak, ++streak);
		const day = { date, cost: point.cost, requests: point.requests };
		if (!busiest || weight(day) > weight(busiest)) busiest = day;
	}
	return {
		priced,
		month,
		monthCost: month.reduce((sum, day) => sum + day.cost, 0),
		monthRequests: month.reduce((sum, day) => sum + day.requests, 0),
		busiest,
		activeDays,
		longestStreak,
	};
}

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const COMPACT_COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** `$1,234 · 5.6K requests`. */
export function activityTotals(calendar: Calendar): string {
	const cost =
		calendar.totalCost >= 1 ? `$${WHOLE_DOLLARS.format(calendar.totalCost)}` : `$${calendar.totalCost.toFixed(2)}`;
	return `${cost} · ${COMPACT_COUNT.format(calendar.totalRequests)} requests`;
}

/** `$1,234`, `$84.20`, `$0`: cents below $100. */
export function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	return cost >= 100 ? `$${WHOLE_DOLLARS.format(cost)}` : `$${cost.toFixed(2)}`;
}

export function requestsText(requests: number): string {
	return `${COMPACT_COUNT.format(requests)} request${requests === 1 ? "" : "s"}`;
}

/** An activity error on one line: no controls, tabs or runs of space, home as `~`, no trailing dots. */
export function activityErrorDetail(error: string, home = os.homedir()): string {
	let text = replaceTabs(sanitizeText(error)).replace(/\s+/g, " ").trim();
	if (home) {
		const pattern = `${RegExp.escape(home)}|${RegExp.escape(home.replaceAll("\\", "/"))}`;
		text = text.replace(new RegExp(pattern, "gi"), "~");
	}
	return text.replace(/\.+$/, "");
}

/** `resets in 2h30m` and its `Resets Tue 14 Nov 2023, 23:13` title. */
export function resetLabel(nowMs: number, resetMs: number): { text: string; title: string } {
	const at = new Date(nowMs + resetMs);
	const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	return {
		text: `resets in ${formatDuration(resetMs)}`,
		title: `Resets ${shortDate(at)} ${at.getFullYear()}, ${clock}`,
	};
}

// ─── Dashboard state ─────────────────────────────────────────────────────────

export type UsageView = "overview" | "detail";

export interface UsageDashboardOptions {
	readonly reports: UsageReport[];
	readonly unavailableAccounts?: readonly UnavailableUsageAccount[];
	/** Whether a report belongs to the OAuth identity serving this session. */
	readonly isActiveAccount?: (report: UsageReport) => boolean;
	/** The full `/usage` report of `reports` for Details, per content width. */
	readonly renderDetail: (width: number, reports: UsageReport[]) => string;
	/**
	 * Stream daily activity: push stored rows at once, again after a sync.
	 * Rejecting before any push shows the history as unavailable; after one,
	 * keeps the rows marked not synced. `signal` aborts on close.
	 */
	readonly loadActivity: (push: (points: DailyActivityPoint[]) => void, signal: AbortSignal) => Promise<void>;
	/** Re-fetch the reports (`r`); null when nothing came back. */
	readonly refresh?: () => Promise<UsageReport[] | null>;
	readonly onClose: () => void;
	/** Terminal rows (the sheet fills them). */
	readonly terminalRows: () => number;
	/** Wall clock (ms). */
	readonly now?: () => number;
}

export class UsageDashboardModel {
	/** Bumped on every change either face shows. */
	readonly rev = signal(0);
	reports: UsageReport[];
	cards: ProviderCard[];
	nowMs: number;
	view: UsageView = "overview";
	/** Terminal scroll of the body (clamped by the painter per width). */
	scroll = 0;
	/** Body rows of the last paint (paging). */
	viewportRows = 10;
	activity: DailyActivityPoint[] | null = null;
	activityError: string | null = null;
	/** Why the sync after painted rows failed (they stay, marked stale). */
	syncError: string | null = null;
	syncing = true;
	refreshing = false;
	refreshError: string | null = null;
	#detail: { width: number; lines: string[] } | null = null;
	#closed = false;
	readonly #abort = new AbortController();
	/** Settles when the activity load does. */
	readonly loaded: Promise<void>;

	constructor(readonly options: UsageDashboardOptions) {
		this.reports = options.reports;
		this.nowMs = this.now();
		this.cards = buildProviderCards(this.reports, this.nowMs, options.unavailableAccounts);
		this.loaded = this.#load();
	}

	now(): number {
		return this.options.now?.() ?? Date.now();
	}

	touch(): void {
		this.rev.set(untrack(this.rev) + 1);
	}

	async #load(): Promise<void> {
		try {
			await this.options.loadActivity(points => {
				if (this.#closed) return;
				this.activity = points;
				this.touch();
			}, this.#abort.signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.activity) this.syncError = message;
			else this.activityError = message;
		} finally {
			this.syncing = false;
			if (!this.#closed) this.touch();
		}
	}

	/** `not synced (busy)`: the shown history predates a failed sync. */
	staleNote(): string {
		const detail = activityErrorDetail(this.syncError ?? "");
		return detail ? `not synced (${detail})` : "not synced";
	}

	/** Newest report time (0 without reports). */
	fetchedAt(): number {
		return Math.max(0, ...this.reports.map(report => report.fetchedAt ?? 0));
	}

	detailLines(width: number): string[] {
		if (this.#detail?.width !== width) {
			this.#detail = { width, lines: this.options.renderDetail(width, this.reports).split("\n") };
		}
		return this.#detail.lines;
	}

	setView(view: UsageView): void {
		this.view = view;
		this.scroll = 0;
		this.touch();
	}

	scrollBy(delta: number): void {
		this.scroll = Math.max(0, this.scroll + delta);
		this.touch();
	}

	async refresh(): Promise<void> {
		const refresh = this.options.refresh;
		if (!refresh || this.refreshing || this.#closed) return;
		this.refreshing = true;
		this.refreshError = null;
		this.touch();
		try {
			const reports = await refresh();
			if (this.#closed) return;
			if (reports) {
				this.reports = reports;
				this.nowMs = this.now();
				this.cards = buildProviderCards(reports, this.nowMs, this.options.unavailableAccounts);
				this.#detail = null;
			}
		} catch (error) {
			this.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.#closed) this.touch();
		}
	}

	/** Esc/q: Details back to Overview, else close. */
	back(): void {
		if (this.view === "detail") this.setView("overview");
		else this.close();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort();
		this.options.onClose();
	}

	/** Terminal keys; true when handled. */
	key(id: string): boolean {
		switch (listKeyId(id)) {
			case "escape":
			case "q":
				this.back();
				return true;
			case "r":
				void this.refresh();
				return true;
			case "tab":
				this.setView(this.view === "overview" ? "detail" : "overview");
				return true;
			case "enter":
			case "d":
				if (this.view !== "overview") return false;
				this.setView("detail");
				return true;
			case "up":
				this.scrollBy(-1);
				return true;
			case "down":
				this.scrollBy(1);
				return true;
			case "pageUp":
				this.scrollBy(-this.viewportRows);
				return true;
			case "pageDown":
				this.scrollBy(this.viewportRows);
				return true;
			case "home":
				this.scroll = 0;
				this.touch();
				return true;
			case "end":
				this.scrollBy(Number.MAX_SAFE_INTEGER);
				return true;
			default:
				return false;
		}
	}
}
