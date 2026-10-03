import { formatNumber, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import type { CurrencyCode } from "@oh-my-pi/pi-catalog/types";
import type { Theme } from "../theme";

export { normalizePremiumRequests } from "@oh-my-pi/pi-utils";

const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = { USD: "$", CNY: "¥" };

/** Inputs whose differences are intentionally preserved between current status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly usingSubscription: boolean;
	readonly premiumRequests: number;
	readonly fractionDigits: number;
	readonly pricingPeriod?: "peak" | "off-peak";
	/** Subagent-tree spend, rendered `(+…)` after the session's own spend; `cost` excludes it. */
	readonly subagentCost?: number;
	/** ISO 4217 code shared by `cost` and `subagentCost`; omitted means `"USD"`. */
	readonly currency?: CurrencyCode;
	readonly advisor?: {
		readonly cost: number;
		readonly usingSubscription: boolean;
		/** ISO 4217 code of the advisor amount; omitted means the summary's `currency`. */
		readonly currency?: CurrencyCode;
	};
}

/**
 * Identity used by the print-the-unit-at-most-once rule. A metered amount's
 * unit is its currency code (so `$` and `¥` each print on their first amount),
 * while subscription spend has a single unit of its own.
 */
type BillingUnit = "subscription" | CurrencyCode;

/** `showUnit: false` omits the `$`/`¥`/subscription symbol when the summary already printed that unit. */
function formatSpend(
	amount: number,
	usingSubscription: boolean,
	fractionDigits: number,
	uiTheme: Theme,
	showUnit: boolean,
	currency: CurrencyCode,
): string {
	const formatted = amount.toFixed(fractionDigits);
	if (!showUnit) return formatted;
	if (!usingSubscription) return `${CURRENCY_SYMBOLS[currency]}${formatted}`;
	if (uiTheme.getSymbolPreset() === "nerd") {
		const icon = uiTheme.icon.subscription;
		return icon ? `${icon} ${formatted}` : `S${formatted}`;
	}
	return `S${formatted}`;
}

function formatAdvisorSpend(
	amount: number,
	usingSubscription: boolean,
	fractionDigits: number,
	uiTheme: Theme,
	showUnit: boolean,
	currency: CurrencyCode,
): string {
	const spend = formatSpend(amount, usingSubscription, fractionDigits, uiTheme, showUnit, currency);
	const icon = uiTheme.icon.advisor;
	return icon && icon !== "(adv)" ? `${icon} ${spend}` : `${spend} (adv)`;
}

/**
 * Shared billing metric presentation. Callers select precision explicitly so
 * the legacy footer keeps three decimals while current status segments keep two.
 * A unit symbol (`$`, `¥` or the subscription mark) is printed at most once per
 * unit; later amounts billed the same way render bare.
 */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const premiumRequests = normalizePremiumRequests(options.premiumRequests);
	const advisorCost = options.advisor?.cost ?? 0;
	const subagentCost = options.subagentCost ?? 0;
	if (
		!options.cost &&
		!subagentCost &&
		!advisorCost &&
		!options.usingSubscription &&
		!premiumRequests &&
		!options.pricingPeriod
	) {
		return undefined;
	}

	const parts: string[] = [];
	const currency = options.currency ?? "USD";
	let shownUnit: BillingUnit | undefined;
	const primaryUnit: BillingUnit = options.usingSubscription ? "subscription" : currency;
	if (options.cost || options.pricingPeriod || subagentCost) {
		parts.push(formatSpend(options.cost, options.usingSubscription, options.fractionDigits, uiTheme, true, currency));
		shownUnit = primaryUnit;
	} else if (options.usingSubscription) {
		parts.push(
			uiTheme.getSymbolPreset() === "nerd" && uiTheme.icon.subscription ? uiTheme.icon.subscription : "(sub)",
		);
		shownUnit = primaryUnit;
	}
	// Always follows the primary spend, which already carries the unit.
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(options.fractionDigits)})`);
	if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
	if (premiumRequests) parts.push(`★ ${formatNumber(premiumRequests)}`);
	if (advisorCost && options.advisor) {
		const prefix = parts.length > 0 ? "+ " : "";
		const advisorCurrency = options.advisor.currency ?? currency;
		const advisorUnit: BillingUnit = options.advisor.usingSubscription ? "subscription" : advisorCurrency;
		parts.push(
			`${prefix}${formatAdvisorSpend(
				advisorCost,
				options.advisor.usingSubscription,
				options.fractionDigits,
				uiTheme,
				shownUnit !== advisorUnit,
				advisorCurrency,
			)}`,
		);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}
