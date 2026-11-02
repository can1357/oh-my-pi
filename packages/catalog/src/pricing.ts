import { type } from "@oh-my-pi/omptype";
import type { EffectiveTokenCost, ModelCost, TimeBasedCost, TokenCost } from "./types";
import { isRecord } from "./utils";

// Schedules are also checked on in-memory discovery output, where absent optionals may be explicit `undefined`.
const Rate = type("number >= 0");
const Rates = type({ input: Rate, output: Rate, cacheRead: Rate, cacheWrite: Rate });
const LongContext = Rates.and({ inputThreshold: "number > 0", "inputThresholdInclusive?": "boolean | undefined" });
const PeakWindow = type({
	weekdays: type("0 <= number.integer <= 6").array().atLeastLength(1),
	startMinute: "number.integer >= 0",
	endMinute: "number.integer <= 1440",
}).narrow(window => new Set(window.weekdays).size === window.weekdays.length && window.startMinute < window.endMinute);
const EffectiveRate = Rates.and({
	// The `Date` range.
	effectiveFrom: "-8640000000000000 <= number.integer <= 8640000000000000",
	"longContext?": LongContext.or("undefined"),
});
/** Serialized time-based pricing schedule, as cached model rows carry it. */
export const TimeBasedCostShape = type({
	offPeakMultiplier: Rate,
	peakWindows: PeakWindow.array(),
	"effectiveRates?": EffectiveRate.array().or("undefined"),
}).narrow(
	cost =>
		cost.effectiveRates === undefined ||
		new Set(cost.effectiveRates.map(rate => rate.effectiveFrom)).size === cost.effectiveRates.length,
);

/** Validate serialized schedules before admitting cached model rows. */
export function isTimeBasedCost(value: unknown): value is TimeBasedCost {
	return TimeBasedCostShape.allows(value);
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
			if (!Rate.allows(value))
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
