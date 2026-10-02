import { resolveUsedFraction } from "../usage";
import type { UsageLimit, UsageWindow } from "../usage";
import type { AuthAccountPolicy } from "./types";
import { windowResetAt } from "./usage-report";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Remaining quota protected on one account, optionally released as each usage
 * window approaches its reset so the reserve is spent instead of expiring.
 */
export interface UsageReserve {
	/** Protected remaining fraction (0–1) while a window is at least `taperMs` from its reset. */
	readonly fraction: number;
	/** Lead time before a window's reset over which the reserve releases linearly to 0; 0 keeps it static. */
	readonly taperMs: number;
}

/**
 * Resolve the reserve for one account: a per-account `reservePct` / `taperHours`
 * override wins over the supplied global fallbacks. Returns `undefined` when
 * no reserve applies (no per-account `reservePct` and no fallback fraction).
 */
export function resolveUsageReserve(
	policy: AuthAccountPolicy | undefined,
	fallbackFraction: number | undefined,
	fallbackTaperHours: number,
): UsageReserve | undefined {
	const configuredPct = policy?.reservePct;
	const fraction =
		configuredPct !== undefined && Number.isFinite(configuredPct) ? configuredPct / 100 : fallbackFraction;
	if (fraction === undefined || !Number.isFinite(fraction)) return undefined;
	const configuredTaper = policy?.taperHours;
	const taperHours =
		configuredTaper !== undefined && Number.isFinite(configuredTaper) ? configuredTaper : fallbackTaperHours;
	return {
		fraction: Math.max(0, Math.min(1, fraction)),
		taperMs: Number.isFinite(taperHours) && taperHours > 0 ? taperHours * HOUR_MS : 0,
	};
}

/**
 * Effective reserve for one usage window: `fraction × min(1, msToReset / taperMs)`,
 * reaching 0 at the reset. The taper never exceeds the window's own duration, so a
 * window shorter than the taper still protects its full reserve when it opens.
 * Windows without a known reset, and rolling windows whose timestamp is only an
 * incremental regeneration step (`resetLabel` other than "resets"), keep the
 * static reserve: nothing guarantees their quota expires at that timestamp.
 */
export function windowReserveFraction(reserve: UsageReserve, window: UsageWindow | undefined, nowMs: number): number {
	if (reserve.taperMs <= 0 || reserve.fraction <= 0 || !window) return reserve.fraction;
	if (window.resetLabel !== undefined && window.resetLabel !== "resets") return reserve.fraction;
	const resetAt = windowResetAt(window);
	if (resetAt === undefined) return reserve.fraction;
	const msToReset = resetAt - nowMs;
	if (msToReset <= 0) return 0;
	const durationMs = window.durationMs;
	const taperMs =
		typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
			? Math.min(reserve.taperMs, durationMs)
			: reserve.taperMs;
	return reserve.fraction * Math.min(1, msToReset / taperMs);
}

/**
 * Whether any measured window's remaining quota sits inside that window's
 * effective reserve. Returns `undefined` when no limit carries a usable
 * used fraction.
 */
export function usageLimitsInReserve(
	limits: readonly UsageLimit[],
	reserve: UsageReserve,
	nowMs: number,
): boolean | undefined {
	let measured = false;
	for (const limit of limits) {
		const usedFraction = resolveUsedFraction(limit);
		if (usedFraction === undefined || !Number.isFinite(usedFraction)) continue;
		measured = true;
		if (Math.max(0, 1 - usedFraction) <= windowReserveFraction(reserve, limit.window, nowMs)) return true;
	}
	return measured ? false : undefined;
}
