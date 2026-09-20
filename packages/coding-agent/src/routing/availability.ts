// src/routing/availability.ts
//
// Deterministic pre-filter. Runs BEFORE the judge. Costs $0. Cannot be wrong.
//
// ---------------------------------------------------------------------------
// Rule: never ask a decision model a question you can answer with arithmetic.

/** One routing tier as configured in `jevRouting.tiers` — model is a `provider/model` selector string. */
export interface ConfiguredTier {
	/** Stable tier id the judge names in its answer. */
	id: string;
	/** Model selector `provider/model` this tier binds to. */
	model: string;
	/** Free-text eligibility test handed to the judge — never a model name. */
	capability: string;
	/** Reporting only; the router never optimizes cost directly. */
	costHintUsdPerMTokOut?: number;
	availability?: TierAvailability;
}

/**
 * Narrow free-text `jevRouting.tiers` config (array settings arrive untyped) to
 * the configured-tier shape; entries missing required fields are dropped.
 */
export function toJevTiers(value: unknown): ConfiguredTier[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.model !== "string") return [];
		if (typeof record.capability !== "string") return [];
		const tier: ConfiguredTier = {
			id: record.id,
			model: record.model,
			capability: record.capability,
		};
		if (typeof record.costHintUsdPerMTokOut === "number") tier.costHintUsdPerMTokOut = record.costHintUsdPerMTokOut;
		if (record.availability && typeof record.availability === "object") {
			tier.availability = record.availability as TierAvailability;
		}
		return [tier];
	});
}
// ---------------------------------------------------------------------------
// Time-of-day windows, remaining quota, context ceilings and rate limits are
// FACTS. Handing them to the judge would:
//   - cost money on every turn instead of none
//   - add a failure mode to something that cannot fail
//   - burn the router's accuracy budget on cases that were never ambiguous
//
// The filter alone resolves most turns; the judge then only sees the genuinely
// ambiguous remainder — which shrinks both its cost and its error surface.

import type { TierSpec } from "./types";

export interface Window {
	/** Local hour the window opens, 0-23. May be > endHour (wraps midnight). */
	startHour: number;
	/** Local hour the window closes, 0-23. */
	endHour: number;
	/** Offset from UTC in minutes. Hanoi = +420. */
	utcOffsetMinutes: number;
}

export interface Quota {
	used: number;
	limit: number;
}

export interface TierAvailability {
	/** Tier is only eligible inside this local-time window. */
	window?: Window;
	/** Requests above this context size are ineligible. */
	maxContextTokens?: number;
	/** Budget for the current period. Omit for unmetered tiers. */
	quota?: Quota;
	/** Rolling request cap (free tiers often meter requests, not tokens). */
	rate?: Quota;
}

export interface TierCandidate extends TierSpec {
	availability?: TierAvailability;
}

export type ExclusionReason = "outside-window" | "context-too-large" | "quota-exhausted" | "rate-limited";

export interface Excluded {
	id: string;
	reason: ExclusionReason;
}

export interface AvailabilityResult {
	available: TierCandidate[];
	excluded: Excluded[];
}

/** Local hour in the window's timezone, as a float (22.5 = 22:30). */
export function localHour(now: Date, utcOffsetMinutes: number): number {
	const shifted = new Date(now.getTime() + utcOffsetMinutes * 60_000);
	return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

export function isWithinWindow(win: Window, now: Date): boolean {
	const h = localHour(now, win.utcOffsetMinutes);
	// Wrapping window (e.g. 22:00 -> 08:00): open if at/after start OR before end.
	if (win.startHour > win.endHour) return h >= win.startHour || h < win.endHour;
	return h >= win.startHour && h < win.endHour;
}

export interface AvailabilityContext {
	now?: Date;
	/** Estimated context size for this turn, including history. */
	contextTokens?: number;
}

export function filterAvailable(tiers: TierCandidate[], ctx: AvailabilityContext = {}): AvailabilityResult {
	const now = ctx.now ?? new Date();
	const available: TierCandidate[] = [];
	const excluded: Excluded[] = [];

	for (const t of tiers) {
		const a = t.availability;
		let reason: ExclusionReason | undefined;

		if (a?.window && !isWithinWindow(a.window, now)) reason = "outside-window";
		else if (
			a?.maxContextTokens !== undefined &&
			ctx.contextTokens !== undefined &&
			ctx.contextTokens > a.maxContextTokens
		)
			reason = "context-too-large";
		else if (a?.quota && a.quota.used >= a.quota.limit) reason = "quota-exhausted";
		else if (a?.rate && a.rate.used >= a.rate.limit) reason = "rate-limited";

		if (reason) excluded.push({ id: t.id, reason });
		else available.push(t);
	}

	return { available, excluded };
}

/**
 * The point of the whole module: if this returns 0 or 1, do NOT call the
 * judge. Zero means every tier is gated — surface it, don't guess. One means
 * the decision was already made by arithmetic.
 */
export function needsRouting(result: AvailabilityResult): boolean {
	return result.available.length > 1;
}
