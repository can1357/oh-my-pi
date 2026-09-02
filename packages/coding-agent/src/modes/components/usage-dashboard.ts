/**
 * Fullscreen `/usage` dashboard (the /settings idiom): mounted as an overlay
 * on the alternate screen so it takes no transcript space. Shows a compact
 * subscriptions grid (one card per provider, worst window per quota bucket)
 * above a GitHub-style daily activity heatmap fed by the local stats DB.
 * Enter flips into the classic full per-account report, scrollable in place.
 */
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { type Component, matchesKey, routeSgrMouseInput, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { colorLuma, formatDuration, hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { colorToAnsi } from "../theme/color";
import { theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

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
	/** Absolute used amount (e.g. `$12.34 used`) for limits without a fraction. */
	usedText?: string;
}

/** Compact per-provider summary backing one card in the subscriptions grid. */
export interface ProviderCard {
	provider: string;
	name: string;
	/** Number of accounts reporting for this provider. */
	accounts: number;
	/** Window rows sorted most-pressing first. */
	windows: CardWindowRow[];
	/** True when every account reports no limits (e.g. enterprise plans). */
	unlimited: boolean;
	/** True when nothing is used anywhere (or there are no limits): collapses to a tick. */
	idle: boolean;
}

function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function isUsedOnlyAbsoluteAmount(limit: UsageLimit): boolean {
	const amount = limit.amount;
	return (
		amount.unit !== "percent" &&
		amount.unit !== "unknown" &&
		amount.used !== undefined &&
		Number.isFinite(amount.used) &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		resolveUsedFraction(limit) === undefined
	);
}

function formatUsedOnlyAmount(limit: UsageLimit): string {
	const used = limit.amount.used ?? 0;
	if (limit.amount.unit === "usd") return `$${used.toFixed(2)} used`;
	const formatted = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(used);
	return `${formatted} ${limit.amount.unit} used`;
}

/**
 * Aggregate status across a bucket's limits, mirroring the classic report:
 * a mix of healthy and pressured accounts reads as a warning, not as the
 * worst account's status.
 */
function aggregateStatus(limits: UsageLimit[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
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

/** Card-level status from its window rows, same mixing rules as {@link aggregateStatus}. */
function aggregateRowStatus(windows: CardWindowRow[]): UsageLimit["status"] {
	const hasOk = windows.some(window => window.status === "ok");
	const hasWarning = windows.some(window => window.status === "warning");
	const hasExhausted = windows.some(window => window.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
}

/**
 * Collapse usage reports into one compact card per provider: limits grouped by
 * quota bucket (label + window), each bucket showing the mean used fraction
 * across accounts (matching the classic report's aggregate "% free") with the
 * most-used account's reset countdown. Cards sort most-pressing first so
 * what's burning is on top-left; fully idle providers collapse into a tick.
 */
export function buildProviderCards(reports: UsageReport[], nowMs: number): ProviderCard[] {
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}

	const cards: ProviderCard[] = [];
	for (const [provider, providerReports] of grouped) {
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
				usedText:
					fraction === undefined && isUsedOnlyAbsoluteAmount(worst) ? formatUsedOnlyAmount(worst) : undefined,
			};
		});
		windows.sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1));
		// The window tag earns its columns only when sibling rows would otherwise
		// be indistinguishable (e.g. Antigravity's daily vs weekly "Usage (Google)").
		for (const window of windows) {
			const duplicated = windows.some(other => other !== window && other.label === window.label);
			if (!duplicated) window.windowTag = undefined;
		}

		cards.push({
			provider,
			name: formatProviderName(provider),
			accounts: providerReports.length,
			windows,
			unlimited: windows.length === 0,
			idle: windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
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
	 * settles; rejection renders as a dim unavailable note.
	 */
	loadActivity: (push: (points: DailyActivityPoint[]) => void) => Promise<void>;
	requestRender: () => void;
	onClose: () => void;
}

const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 3;
const CARD_MAX_WINDOWS = 4;

export class UsageDashboardComponent implements Component {
	#options: UsageDashboardOptions;
	#cards: ProviderCard[];
	#nowMs: number;
	#view: "overview" | "detail" = "overview";
	#scroll = 0;
	#activity: DailyActivityPoint[] | null = null;
	#activityError = false;
	#syncing = true;
	#detailCache: { width: number; lines: string[] } | null = null;
	#lastViewportRows = 10;
	#closed = false;

	constructor(options: UsageDashboardOptions) {
		this.#options = options;
		this.#nowMs = Date.now();
		this.#cards = buildProviderCards(options.reports, this.#nowMs);
		void this.#loadActivity();
	}

	async #loadActivity(): Promise<void> {
		try {
			await this.#options.loadActivity(points => {
				if (this.#closed) return;
				this.#activity = points;
				this.#options.requestRender();
			});
		} catch {
			this.#activityError = true;
		} finally {
			this.#syncing = false;
			if (!this.#closed) this.#options.requestRender();
		}
	}

	dispose(): void {
		this.#closed = true;
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

	#miniBar(fraction: number | undefined, status: UsageLimit["status"], width: number): string {
		if (fraction === undefined) return theme.fg("dim", "·".repeat(width));
		const clamped = Math.min(Math.max(fraction, 0), 1);
		const filled = Math.round(clamped * width);
		const bar = "█".repeat(filled);
		const empty = "░".repeat(width - filled);
		return `${theme.fg(this.#statusColor(status), bar)}${theme.fg("dim", empty)}`;
	}

	#renderCardLines(card: ProviderCard, width: number): string[] {
		const lines: string[] = [];
		const cardStatus = card.unlimited ? "ok" : aggregateRowStatus(card.windows);
		const accountsText = card.accounts > 1 ? theme.fg("dim", `${card.accounts} accts`) : "";
		const titleBudget = width - 2 - visibleWidth(accountsText) - (accountsText ? 1 : 0);
		const title = theme.bold(truncateToWidth(card.name, Math.max(4, titleBudget)));
		const titlePad = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(accountsText));
		lines.push(`${this.#statusIcon(cardStatus)} ${title}${" ".repeat(titlePad)}${accountsText}`);

		if (card.unlimited) {
			lines.push(`  ${theme.fg("dim", "no limits")}`);
			return lines;
		}

		const hidden = card.windows.length - CARD_MAX_WINDOWS;
		const visibleWindows = card.windows.slice(0, CARD_MAX_WINDOWS);
		// Fixed columns across every row of the card so bars all start and end
		// at the same x: label | bar | pct | reset. The reset column sizes to
		// the card's widest countdown instead of flexing per row.
		const resetWidth = visibleWindows.reduce(
			(max, window) => Math.max(max, window.resetMs !== undefined ? formatDuration(window.resetMs).length : 0),
			0,
		);
		const labelWidth = Math.min(16, Math.max(6, width - 24));
		const barWidth = Math.max(5, width - 2 - labelWidth - 1 - 5 - (resetWidth > 0 ? resetWidth + 1 : 0));
		for (const window of visibleWindows) {
			const tagPlain = window.windowTag
				? truncateToWidth(window.windowTag, Math.max(2, Math.floor(labelWidth / 2) - 1))
				: "";
			const baseWidth = tagPlain ? labelWidth - visibleWidth(tagPlain) - 1 : labelWidth;
			const basePlain = truncateToWidth(window.label, baseWidth).padEnd(baseWidth);
			const label = tagPlain
				? `${theme.fg("muted", basePlain)} ${theme.fg("dim", tagPlain)}`
				: theme.fg("muted", basePlain);
			if (window.fraction === undefined) {
				const text = theme.fg("dim", window.usedText ?? "no data");
				lines.push(truncateToWidth(`  ${label} ${text}`, width));
				continue;
			}
			const freePct = Math.max(0, Math.round((1 - window.fraction) * 100));
			const pctText = theme.fg(this.#statusColor(window.status), `${freePct}%`.padStart(5));
			const resetPlain = window.resetMs !== undefined ? formatDuration(window.resetMs) : "";
			const resetText = resetWidth > 0 ? ` ${theme.fg("dim", resetPlain.padStart(resetWidth))}` : "";
			lines.push(`  ${label} ${this.#miniBar(window.fraction, window.status, barWidth)}${pctText}${resetText}`);
		}
		if (hidden > 0) lines.push(`  ${theme.fg("dim", `+${hidden} more`)}`);
		return lines;
	}

	#renderCardsGrid(innerWidth: number): string[] {
		if (this.#cards.length === 0) return [theme.fg("dim", "No usage data available.")];
		const active = this.#cards.filter(card => !card.idle);
		const idle = this.#cards.filter(card => card.idle);
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
		// Untouched providers collapse into a single tick line: their windows
		// are all at 100% free (or have no limits), so per-window bars are noise.
		if (idle.length > 0) {
			if (active.length > 0) lines.push("");
			const names = idle.map(card => card.name).join(" · ");
			const prefix = `${theme.fg("success", theme.status.success)} `;
			lines.push(truncateToWidth(`${prefix}${theme.fg("dim", `untouched: ${names}`)}`, innerWidth));
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
			return [theme.fg("dim", "Usage history unavailable (stats database could not be read).")];
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

		const out: string[] = [];
		out.push(topBorder(width, title));
		out.push(row(checkedText ? theme.fg("dim", checkedText) : "", width));
		for (let i = 0; i < contentRows; i++) {
			out.push(row(contentSource[this.#scroll + i] ?? "", width));
		}
		out.push(divider(width));
		const scrollHint = maxScroll > 0 ? "↑/↓ scroll · " : "";
		const hint = this.#view === "detail" ? `${scrollHint}Esc back` : `${scrollHint}↵ details · Esc close`;
		out.push(row(theme.fg("dim", hint), width));
		out.push(bottomBorder(width));
		return out;
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
