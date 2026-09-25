import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Theme } from "../theme";

/** Inputs whose differences are intentionally preserved between current status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly usingSubscription: boolean;
	readonly premiumRequests: number;
	readonly aiu: number;
	readonly fractionDigits: number;
	readonly startupPlaceholder?: boolean;
	readonly pricingPeriod?: "peak" | "off-peak";
	readonly advisor?: {
		readonly cost: number;
		readonly usingSubscription: boolean;
	};
}

/** Round premium-request counters without losing legitimate fractional requests. */
export function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
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

function formatAiu(amount: number): string {
	const rounded = amount.toFixed(2);
	return rounded === "0.00" ? amount.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") : rounded;
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
	return icon && icon !== "(adv)" ? `${icon} ${spend}` : `${spend} (adv)`;
}

/**
 * Shared billing metric presentation. Callers select precision explicitly so
 * the legacy footer keeps three decimals while current status segments keep two.
 */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const premiumRequests = normalizePremiumRequests(options.premiumRequests);
	const advisorCost = options.advisor?.cost ?? 0;
	const hasAiu = options.aiu > 0;
	if (
		!options.cost &&
		!advisorCost &&
		!options.usingSubscription &&
		!premiumRequests &&
		!options.pricingPeriod &&
		!hasAiu
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
	if (hasAiu) parts.push(`${placeholder ? "…" : formatAiu(options.aiu)} AIU`);
	if (advisorCost && options.advisor) {
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
