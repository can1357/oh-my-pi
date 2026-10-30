import type {
	EffectiveTokenCost,
	LongContextTokenCost,
	ModelCost,
	PeakPricingWindow,
	TimeBasedCost,
	TokenCost,
} from "./types";
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
		(value.longContext === undefined || isLongContext(value.longContext))
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

/** Parse a KDL ISO UTC instant (`YYYY-MM-DDTHH:mm:ssZ`, optional milliseconds) to Unix ms. */
function parseUtcInstant(date: unknown, axis: string): number {
	if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(date)) {
		throw new Error(`Invalid ${axis} effective-from: expected an ISO UTC timestamp`);
	}
	const instant = Date.parse(date);
	if (
		!Number.isFinite(instant) ||
		new Date(instant).toISOString() !== (date.includes(".") ? date : date.replace("Z", ".000Z"))
	) {
		throw new Error(`Invalid ${axis} effective-from: invalid UTC date`);
	}
	return instant;
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
						["effectiveFrom", "input", "output", "cacheRead", "cacheWrite", "longContext"],
						"effective-rate",
					);
					const effectiveFrom = parseUtcInstant(rate.effectiveFrom, "time-based-cost");
					if (rate.longContext !== undefined) {
						payload(
							rate.longContext,
							["inputThreshold", "inputThresholdInclusive", "input", "output", "cacheRead", "cacheWrite"],
							"long-context",
						);
					}
					return { ...rate, effectiveFrom };
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

/**
 * The latest `effectiveRates` card of a materialized schedule due at
 * `timestamp`, or undefined before the first one (or without a schedule).
 */
export function dueEffectiveRate(
	schedule: TimeBasedCost | undefined,
	timestamp: number,
): EffectiveTokenCost | undefined {
	let due: EffectiveTokenCost | undefined;
	for (const candidate of schedule?.effectiveRates ?? []) {
		if (candidate.effectiveFrom <= timestamp && (due === undefined || candidate.effectiveFrom > due.effectiveFrom)) {
			due = candidate;
		}
	}
	return due;
}

const TOKEN_COST_LEGS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const DATED_CARD_KEYS: readonly string[] = ["effectiveFrom", ...TOKEN_COST_LEGS];

/** A `cost-patch`/`cost-fallback` dated card: the legs it overwrites from `effectiveFrom` (Unix ms). */
export interface DatedCostCard extends Partial<TokenCost> {
	effectiveFrom: number;
}

/**
 * Parse the compiled `effective-rates` block of a `cost-patch` or
 * `cost-fallback` payload into dated cards, ascending by date. Throws on a
 * malformed card, so a typo in a rule fails the build instead of silently
 * leaving the old price in force.
 */
export function parseDatedCostCards(costAxis: unknown, axis: "cost-patch" | "cost-fallback"): DatedCostCard[] {
	const effectiveRates = isRecord(costAxis) ? costAxis.effectiveRates : undefined;
	if (effectiveRates === undefined) return [];
	if (!isRecord(effectiveRates)) throw new Error(`Invalid ${axis} effective-rates: expected named objects`);
	const cards = Object.values(effectiveRates).map(entry => {
		if (!isRecord(entry) || Object.keys(entry).some(key => !DATED_CARD_KEYS.includes(key))) {
			throw new Error(`Invalid ${axis} effective-rate: unknown or malformed fields`);
		}
		const card: DatedCostCard = { effectiveFrom: parseUtcInstant(entry.effectiveFrom, axis) };
		for (const leg of TOKEN_COST_LEGS) {
			const value = entry[leg];
			if (value === undefined) continue;
			if (!nonnegative(value))
				throw new Error(`Invalid ${axis} effective-rate ${leg}: expected a nonnegative number`);
			card[leg] = value;
		}
		return card;
	});
	cards.sort((a, b) => a.effectiveFrom - b.effectiveFrom);
	for (let index = 1; index < cards.length; index++) {
		if (cards[index]!.effectiveFrom === cards[index - 1]!.effectiveFrom) {
			throw new Error(`Invalid ${axis} effective-rates: duplicate effective-from`);
		}
	}
	return cards;
}

/**
 * Earliest instant a rate card can name (the `Date` range minimum). A leading
 * card from here holds the price in force before the first dated change.
 */
export const EARLIEST_EFFECTIVE_FROM = -8_640_000_000_000_000;

/** A schedule of dated rate cards alone: no peak windows, no off-peak discount. */
export const NO_RECURRING_TARIFF: TimeBasedCost = { offPeakMultiplier: 1, peakWindows: [] };

/**
 * A flat card plus its dated overrides as a request-time `ModelCost`: the
 * card due at `now` in the scalar legs, and every period (a leading card for
 * the base price, then each dated card over the previous one) in a
 * `timeBased` schedule without a recurring tariff. The plain card when no
 * dated card exists.
 */
export function datedCost(base: TokenCost, cards: readonly DatedCostCard[], now = Date.now()): ModelCost {
	if (cards.length === 0) return base;
	const effectiveRates: EffectiveTokenCost[] = [{ effectiveFrom: EARLIEST_EFFECTIVE_FROM, ...base }];
	for (const card of cards) effectiveRates.push({ ...effectiveRates.at(-1)!, ...card });
	const timeBased = { ...NO_RECURRING_TARIFF, effectiveRates };
	const { effectiveFrom: _effectiveFrom, ...due } = dueEffectiveRate(timeBased, now)!;
	return { ...due, timeBased };
}

/**
 * Overwrite `cost` legs with the latest dated card due at `now`. Leaves
 * `cost` unchanged before the first card.
 */
export function applyDueDatedCostCard(cost: TokenCost, cards: readonly DatedCostCard[], now = Date.now()): void {
	let due: DatedCostCard | undefined;
	for (const card of cards) {
		if (card.effectiveFrom <= now) due = card;
	}
	if (due === undefined) return;
	for (const leg of TOKEN_COST_LEGS) {
		const value = due[leg];
		if (value !== undefined) cost[leg] = value;
	}
}
