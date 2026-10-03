import type {
	CurrencyCode,
	EffectiveTokenCost,
	LongContextTokenCost,
	PeakPricingWindow,
	TimeBasedCost,
	TokenCost,
} from "./types";
import { isCurrencyCode } from "./types";
import { isRecord } from "./utils";

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRates(value: unknown): value is TokenCost {
	return (
		isRecord(value) &&
		nonnegative(value.input) &&
		nonnegative(value.output) &&
		nonnegative(value.cacheRead) &&
		nonnegative(value.cacheWrite)
	);
}

function isLongContext(value: unknown): value is LongContextTokenCost {
	return (
		isRecord(value) &&
		isRates(value) &&
		typeof value.inputThreshold === "number" &&
		Number.isFinite(value.inputThreshold) &&
		value.inputThreshold > 0 &&
		(value.inputThresholdInclusive === undefined || typeof value.inputThresholdInclusive === "boolean")
	);
}

/** Validate a serialized alternate-currency map before admitting a cached model row. */
function isCurrencyCards(value: unknown): value is Partial<Record<CurrencyCode, TokenCost>> {
	return (
		isRecord(value) &&
		Object.entries(value).every(([code, card]) => isCurrencyCode(code) && isRecord(card) && isRates(card))
	);
}

function isPeakWindow(value: unknown): value is PeakPricingWindow {
	return (
		isRecord(value) &&
		Array.isArray(value.weekdays) &&
		value.weekdays.length > 0 &&
		value.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) &&
		new Set(value.weekdays).size === value.weekdays.length &&
		typeof value.startMinute === "number" &&
		Number.isInteger(value.startMinute) &&
		typeof value.endMinute === "number" &&
		Number.isInteger(value.endMinute) &&
		value.startMinute >= 0 &&
		value.endMinute <= 1440 &&
		value.startMinute < value.endMinute
	);
}

function isEffectiveRate(value: unknown): value is EffectiveTokenCost {
	return (
		isRecord(value) &&
		isRates(value) &&
		typeof value.effectiveFrom === "number" &&
		Number.isSafeInteger(value.effectiveFrom) &&
		Math.abs(value.effectiveFrom) <= 8_640_000_000_000_000 &&
		(value.longContext === undefined || isLongContext(value.longContext)) &&
		(value.currencyCards === undefined || isCurrencyCards(value.currencyCards))
	);
}

/** Validate serialized schedules before admitting cached model rows. */
export function isTimeBasedCost(value: unknown): value is TimeBasedCost {
	if (
		!isRecord(value) ||
		!nonnegative(value.offPeakMultiplier) ||
		!Array.isArray(value.peakWindows) ||
		!value.peakWindows.every(isPeakWindow)
	) {
		return false;
	}
	if (value.effectiveRates === undefined) return true;
	if (!Array.isArray(value.effectiveRates) || !value.effectiveRates.every(isEffectiveRate)) return false;
	const dates = new Set<number>();
	for (const rate of value.effectiveRates) {
		if (dates.has(rate.effectiveFrom)) return false;
		dates.add(rate.effectiveFrom);
	}
	return true;
}

function payload(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) {
		throw new Error(`Invalid time-based-cost ${field}`);
	}
	return value;
}

function namedEntries(value: unknown, field: string): unknown[] {
	if (!isRecord(value)) throw new Error(`Invalid time-based-cost ${field}: expected named objects`);
	return Object.values(value);
}

/**
 * KDL `currency-cards` children are named records keyed by lowercase ISO code;
 * normalize each into an exact four-rate card and reject unsupported codes.
 * Cards are copied from the vendor's published table — never FX-derived.
 */
export function materializeCurrencyCards(value: unknown): Partial<Record<CurrencyCode, TokenCost>> {
	if (!isRecord(value)) throw new Error("Invalid currency-cards: expected named objects");
	const cards: Partial<Record<CurrencyCode, TokenCost>> = {};
	for (const [name, entry] of Object.entries(value)) {
		const code = name.toUpperCase();
		if (!isCurrencyCode(code)) throw new Error(`Invalid currency-cards: unsupported currency "${name}"`);
		const card = payload(entry, ["input", "output", "cacheRead", "cacheWrite"], "currency-card");
		if (!isRates(card)) throw new Error(`Invalid currency-card rates for ${code}`);
		cards[code] = { input: card.input, output: card.output, cacheRead: card.cacheRead, cacheWrite: card.cacheWrite };
	}
	return cards;
}

/** KDL object children are named records; normalize them once while constructing the model. */
export function materializeTimeBasedCost(value: unknown): TimeBasedCost {
	const source = payload(value, ["offPeakMultiplier", "peakWindows", "effectiveRates"], "schedule");
	const peakWindows = namedEntries(source.peakWindows, "peak-windows").map(entry => {
		const window = payload(entry, ["weekdays", "startMinute", "endMinute"], "peak-window");
		if (typeof window.weekdays !== "string" || !/^[0-6](,[0-6])*$/.test(window.weekdays)) {
			throw new Error("Invalid time-based-cost weekdays: expected comma-separated UTC weekday numbers");
		}
		return { ...window, weekdays: window.weekdays.split(",").map(Number) };
	});
	const effectiveRates =
		source.effectiveRates === undefined
			? undefined
			: namedEntries(source.effectiveRates, "effective-rates").map(entry => {
					const rate = payload(
						entry,
						["effectiveFrom", "input", "output", "cacheRead", "cacheWrite", "longContext", "currencyCards"],
						"effective-rate",
					);
					const date = rate.effectiveFrom;
					if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(date)) {
						throw new Error("Invalid time-based-cost effective-from: expected an ISO UTC timestamp");
					}
					const effectiveFrom = Date.parse(date);
					if (
						!Number.isFinite(effectiveFrom) ||
						new Date(effectiveFrom).toISOString() !== (date.includes(".") ? date : date.replace("Z", ".000Z"))
					) {
						throw new Error("Invalid time-based-cost effective-from: invalid UTC date");
					}
					if (rate.longContext !== undefined) {
						payload(
							rate.longContext,
							["inputThreshold", "inputThresholdInclusive", "input", "output", "cacheRead", "cacheWrite"],
							"long-context",
						);
					}
					const currencyCards =
						rate.currencyCards === undefined ? undefined : materializeCurrencyCards(rate.currencyCards);
					return { ...rate, effectiveFrom, ...(currencyCards && { currencyCards }) };
				});
	const schedule = {
		offPeakMultiplier: source.offPeakMultiplier,
		peakWindows,
		...(effectiveRates && { effectiveRates }),
	};
	if (!isTimeBasedCost(schedule))
		throw new Error("Invalid time-based-cost schedule: invalid windows, rates, or multiplier");
	return schedule;
}
