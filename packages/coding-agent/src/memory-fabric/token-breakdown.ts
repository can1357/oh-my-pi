/**
 * Token / context breakdown projection — read-only.
 *
 * Folds a snapshot of `TokenTelemetryEvent`s (emitted by
 * `token-accounting/token-accounting.ts`) into an aggregated
 * before/after/saved breakdown, both overall and grouped by pipeline stage
 * and fidelity class, so a later surface can answer "where did the tokens
 * go, and which stage saved the most?" — without wiring a sink or touching
 * the hot path.
 *
 * Discipline: pure (reads a snapshot array; never subscribes to a sink,
 * never writes, never mutates inputs); observe-only (`mode: "observe"`,
 * carrying no authority); fail-open (malformed events are skipped; the
 * function never throws); additive (no new dependencies, no hot-path edits,
 * no sink registration).
 *
 * Honesty about the source model: a `TokenTelemetryEvent` carries `stage`,
 * optional `fidelityClass`, and before/after/saved token counts — but NOT any
 * cache-hit / cache-miss signal. So this projection groups only by the
 * dimensions the events actually record (stage and fidelity class) and never
 * fabricates a cache split or per-category breakdown the telemetry cannot
 * back.
 */

import type { TokenTelemetryEvent } from "./token-accounting/token-accounting";
import { TOKEN_TELEMETRY_KIND } from "./token-accounting/token-accounting";

/** An aggregated rollup for one group key (a stage, or a fidelity class). */
export interface TokenGroupBreakdown {
	/** The group key (stage name or fidelity class). */
	key: string;
	eventCount: number;
	/** Summed pre-transform tokens. */
	before: number;
	/** Summed post-transform tokens. */
	after: number;
	/** Summed tokens saved (before - after; negative on net growth). */
	saved: number;
	/** Rounded percent saved for the group (0 when `before` is 0). */
	percentSaved: number;
	/** Mean of per-event `ratio` for the group. */
	avgRatio: number;
	/** Number of events in the group where the transform GREW the content. */
	grewCount: number;
	/** Number of events in the group that fell back to the heuristic counter. */
	failedOpenCount: number;
}

export interface TokenBreakdown {
	mode: "observe";
	/** Total events counted (after filtering). */
	eventCount: number;
	totalBefore: number;
	totalAfter: number;
	totalSaved: number;
	/** Rounded overall percent saved (0 when `totalBefore` is 0). */
	percentSaved: number;
	/** Events where the transform grew the content. */
	grewCount: number;
	/** Events that fell back to the heuristic counter. */
	failedOpenCount: number;
	/** Mean of per-event `ratio` across all counted events (0 when empty). */
	avgRatio: number;
	/** Rollups grouped by pipeline `stage`, sorted by key. */
	byStage: TokenGroupBreakdown[];
	/** Rollups grouped by `fidelityClass` (events without one are skipped). */
	byFidelity: TokenGroupBreakdown[];
}

export interface TokenBreakdownOptions {
	/** Only include events for these stages. Omit for all. */
	stages?: readonly string[];
	/** Only include events for these fidelity classes. Omit for all. */
	fidelityClasses?: readonly string[];
}

const EMPTY: TokenBreakdown = {
	mode: "observe",
	eventCount: 0,
	totalBefore: 0,
	totalAfter: 0,
	totalSaved: 0,
	percentSaved: 0,
	grewCount: 0,
	failedOpenCount: 0,
	avgRatio: 0,
	byStage: [],
	byFidelity: [],
};

function isEvent(value: unknown): value is TokenTelemetryEvent {
	if (!value || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	return (
		e.kind === TOKEN_TELEMETRY_KIND &&
		typeof e.stage === "string" &&
		Number.isFinite(e.before) &&
		Number.isFinite(e.after) &&
		Number.isFinite(e.saved)
	);
}

function percentSaved(saved: number, before: number): number {
	return before === 0 ? 0 : Math.round((saved / before) * 100);
}

interface GroupAccumulator {
	key: string;
	eventCount: number;
	before: number;
	after: number;
	saved: number;
	grewCount: number;
	failedOpenCount: number;
	ratioSum: number;
}

function rollup(
	events: readonly TokenTelemetryEvent[],
	keyOf: (e: TokenTelemetryEvent) => string | null,
): TokenGroupBreakdown[] {
	const groups = new Map<string, GroupAccumulator>();
	for (const e of events) {
		const key = keyOf(e);
		if (key === null) continue;
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				eventCount: 0,
				before: 0,
				after: 0,
				saved: 0,
				grewCount: 0,
				failedOpenCount: 0,
				ratioSum: 0,
			};
			groups.set(key, g);
		}
		g.eventCount += 1;
		g.before += e.before;
		g.after += e.after;
		g.saved += e.saved;
		if (e.grew) g.grewCount += 1;
		if (e.failedOpen) g.failedOpenCount += 1;
		g.ratioSum += Number.isFinite(e.ratio) ? e.ratio : 1;
	}

	// Every group holds at least one event, so the mean is always defined.
	return [...groups.values()]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map(g => ({
			key: g.key,
			eventCount: g.eventCount,
			before: g.before,
			after: g.after,
			saved: g.saved,
			percentSaved: percentSaved(g.saved, g.before),
			avgRatio: g.ratioSum / g.eventCount,
			grewCount: g.grewCount,
			failedOpenCount: g.failedOpenCount,
		}));
}

/**
 * Project a snapshot of token-telemetry events into an aggregated breakdown.
 * Pure and fail-open; the input array is never mutated. Returns an inert,
 * all-zero report when there is nothing to summarize.
 */
export function projectTokenBreakdown(
	events: readonly TokenTelemetryEvent[] | undefined,
	options: TokenBreakdownOptions = {},
): TokenBreakdown {
	try {
		const source = Array.isArray(events) ? events.filter(isEvent) : [];
		const stageFilter = options.stages ? new Set(options.stages) : null;
		const fidelityFilter = options.fidelityClasses ? new Set(options.fidelityClasses) : null;

		const matchesFidelity = (e: TokenTelemetryEvent): boolean => {
			if (!fidelityFilter) return true;
			return e.fidelityClass !== undefined && fidelityFilter.has(e.fidelityClass);
		};
		const filtered = source.filter(e => (stageFilter ? stageFilter.has(e.stage) : true)).filter(matchesFidelity);

		if (filtered.length === 0) return EMPTY;

		let totalBefore = 0;
		let totalAfter = 0;
		let totalSaved = 0;
		let grewCount = 0;
		let failedOpenCount = 0;
		let ratioSum = 0;
		for (const e of filtered) {
			totalBefore += e.before;
			totalAfter += e.after;
			totalSaved += e.saved;
			if (e.grew) grewCount += 1;
			if (e.failedOpen) failedOpenCount += 1;
			ratioSum += Number.isFinite(e.ratio) ? e.ratio : 1;
		}

		return {
			mode: "observe",
			eventCount: filtered.length,
			totalBefore,
			totalAfter,
			totalSaved,
			percentSaved: percentSaved(totalSaved, totalBefore),
			grewCount,
			failedOpenCount,
			avgRatio: ratioSum / filtered.length,
			byStage: rollup(filtered, e => e.stage),
			byFidelity: rollup(filtered, e => e.fidelityClass ?? null),
		};
	} catch {
		return EMPTY;
	}
}
