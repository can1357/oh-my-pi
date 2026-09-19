import { formatNumber } from "@oh-my-pi/pi-utils";
import { type Theme, theme } from "../theme";

/** Inputs whose differences are intentionally preserved between current status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly usingSubscription: boolean;
	readonly premiumRequests: number;
	readonly fractionDigits: number;
	readonly startupPlaceholder?: boolean;
	readonly pricingPeriod?: "peak" | "off-peak";
	readonly advisor?: {
		readonly cost: number;
		readonly usingSubscription: boolean;
	};
	/**
	 * Provider-reported subscription windows for the advisor's own account.
	 * When either window is present the advisor slot shows the real quota
	 * instead of the token-imputed dollar amount.
	 */
	readonly advisorUsage?: {
		readonly fiveHour?: { readonly percent: number; readonly resetMinutes?: number };
		readonly sevenDay?: { readonly percent: number; readonly resetHours?: number };
	};
}

/** Round premium-request counters without losing legitimate fractional requests. */
export function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Percent display: muted until 50%, then warning, then error at 80%. */
export function pickUsageColor(percent: number): "muted" | "warning" | "error" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

/** Compact reset countdown: minutes under an hour, else hours, else days. */
export function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// Short-window reset timers retain minute precision.
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export interface QuotaWindowOptions {
	readonly label: string;
	readonly percent: number;
	readonly reset: number | undefined;
	readonly resetUnit: "m" | "h";
	readonly integer: "round" | "floor";
	readonly startupPlaceholder?: boolean;
}

/**
 * One quota window (`5h`, `1d`, `7d`, `mo`). The integer policy (round vs
 * floor) and the reset unit (minutes vs hours) stay explicit at each call site:
 * monthly floors like the Cursor/OpenCode dashboards, the rest round, and
 * short windows reset in minutes while long windows reset in hours.
 */
export function formatQuotaWindow(options: QuotaWindowOptions): string {
	const placeholder = options.startupPlaceholder === true;
	const whole = options.integer === "floor" ? Math.floor(options.percent) : Math.round(options.percent);
	const pctText = theme.fg(pickUsageColor(options.percent), `${placeholder ? "…" : `${whole}`}%`);
	const resetText =
		options.reset !== undefined
			? theme.fg("muted", placeholder ? " (…)" : ` (${formatUsageReset(options.reset, options.resetUnit)})`)
			: "";
	return `${options.label} ${pctText}${resetText}`;
}

function formatSpend(amount: number, usingSubscription: boolean, fractionDigits: number, uiTheme: Theme): string {
	const formatted = amount.toFixed(fractionDigits);
	if (!usingSubscription) return `$${formatted}`;
	if (uiTheme.getSymbolPreset() === "nerd") {
		const icon = uiTheme.icon.subscription;
		return icon ? `${icon} ${formatted}` : `S${formatted}`;
	}
	return `S${formatted}`;
}

function formatSpendPlaceholder(usingSubscription: boolean, uiTheme: Theme): string {
	if (!usingSubscription) return "$…";
	if (uiTheme.getSymbolPreset() === "nerd" && uiTheme.icon.subscription) {
		return `${uiTheme.icon.subscription} …`;
	}
	return "S…";
}

function formatAdvisorSpend(
	amount: number,
	usingSubscription: boolean,
	fractionDigits: number,
	placeholder: boolean,
	uiTheme: Theme,
): string {
	const spend = placeholder
		? formatSpendPlaceholder(usingSubscription, uiTheme)
		: formatSpend(amount, usingSubscription, fractionDigits, uiTheme);
	const icon = uiTheme.icon.advisor;
	// The "(adv)" tag survives every preset: the glyph-only presets still need a
	// textual marker so advisor spend never reads as primary spend.
	return icon && icon !== "(adv)" ? `${icon} ${spend} (adv)` : `${spend} (adv)`;
}

/**
 * Shared billing metric presentation. Callers select precision explicitly so
 * the legacy footer keeps three decimals while current status segments keep two.
 */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const premiumRequests = normalizePremiumRequests(options.premiumRequests);
	const advisorCost = options.advisor?.cost ?? 0;
	const advisorUsage = options.advisorUsage;
	// The advisor's dollar figure is imputed from token counts at list price and
	// is meaningless on a subscription; the real gate is the account's
	// provider-reported usage windows. When the advisor's provider reports them,
	// they replace the dollar amount entirely (so non-quota advisors keep their
	// only cost signal).
	const advisorWindows = advisorUsage && (advisorUsage.fiveHour || advisorUsage.sevenDay) ? advisorUsage : undefined;
	if (
		!options.cost &&
		!advisorCost &&
		!advisorWindows &&
		!options.usingSubscription &&
		!premiumRequests &&
		!options.pricingPeriod
	) {
		return undefined;
	}

	const placeholder = options.startupPlaceholder === true;
	const parts: string[] = [];
	if (options.cost || options.pricingPeriod) {
		parts.push(
			placeholder
				? formatSpendPlaceholder(options.usingSubscription, uiTheme)
				: formatSpend(options.cost, options.usingSubscription, options.fractionDigits, uiTheme),
		);
	} else if (options.usingSubscription) {
		parts.push(
			uiTheme.getSymbolPreset() === "nerd" && uiTheme.icon.subscription ? uiTheme.icon.subscription : "(sub)",
		);
	}
	if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
	if (premiumRequests) parts.push(`★ ${placeholder ? "…" : formatNumber(premiumRequests)}`);
	if (advisorWindows) {
		const windows: string[] = [];
		if (advisorWindows.fiveHour) {
			windows.push(
				formatQuotaWindow({
					label: "5h",
					percent: advisorWindows.fiveHour.percent,
					reset: advisorWindows.fiveHour.resetMinutes,
					resetUnit: "m",
					integer: "round",
					startupPlaceholder: placeholder,
				}),
			);
		}
		if (advisorWindows.sevenDay) {
			windows.push(
				formatQuotaWindow({
					label: "7d",
					percent: advisorWindows.sevenDay.percent,
					reset: advisorWindows.sevenDay.resetHours,
					resetUnit: "h",
					integer: "round",
					startupPlaceholder: placeholder,
				}),
			);
		}
		parts.push(`${parts.length > 0 ? "+ " : ""}${windows.join(uiTheme.sep.dot)} (adv)`);
	} else if (advisorCost && options.advisor) {
		const prefix = parts.length > 0 ? "+ " : "";
		parts.push(
			`${prefix}${formatAdvisorSpend(
				advisorCost,
				options.advisor.usingSubscription,
				options.fractionDigits,
				placeholder,
				uiTheme,
			)}`,
		);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}
