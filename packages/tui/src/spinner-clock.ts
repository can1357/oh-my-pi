/**
 * The shared spinner clock (`tui.spinnerInterval`): one period and one phase for every spinner the
 * TUI draws and for the host's terminal-title spinner. Dependency-free: the host's flag table
 * imports it during CLI bootstrap.
 */

/** Default spinner period, in milliseconds (the historical cadence). */
export const DEFAULT_SPINNER_INTERVAL_MS = 80;
/** Interval value for a static spinner: frame 0 is drawn and no spinner timer runs. */
export const SPINNER_INTERVAL_STATIC = 0;
const SPINNER_INTERVAL_MIN_MS = 50;

let intervalMs = DEFAULT_SPINNER_INTERVAL_MS;
const listeners = new Set<() => void>();

/** The live spinner period in milliseconds; {@link SPINNER_INTERVAL_STATIC} when spinners are still. */
export function spinnerInterval(): number {
	return intervalMs;
}

/** Whether spinners advance at all. */
export function spinnerAnimated(): boolean {
	return intervalMs !== SPINNER_INTERVAL_STATIC;
}

/** Set the period for every spinner; callers pass a value {@link parseSpinnerInterval} accepted. */
export function setSpinnerInterval(next: number): void {
	if (next === intervalMs) return;
	intervalMs = next;
	for (const listener of listeners) listener();
}

/** Observe period changes, for timers that would otherwise stay parked; returns the unsubscribe. */
export function onSpinnerIntervalChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Glyph index on the shared clock, or frame 0 when spinners are static. Every spinner reads
 * wall-clock time, so they share a phase as well as a period.
 */
export function sharedSpinnerFrame(frameCount: number, now: number = Date.now()): number {
	if (frameCount <= 0 || intervalMs === SPINNER_INTERVAL_STATIC) return 0;
	return Math.floor(now / intervalMs) % frameCount;
}

/**
 * Milliseconds until the next multiple of `periodMs` on the wall clock. Timers armed from this fire
 * together whoever owns them, so N spinners cost one frame per period instead of N.
 */
export function spinnerTickDelay(periodMs: number, now: number = Date.now()): number {
	// Slack for float residue at an exact boundary (100 ms is three periods of 1000/30, but
	// `100 % (1000/30)` reads as a full period), which would otherwise shorten the wait to 1 ms.
	const periods = Math.floor(now / periodMs + 1e-6);
	return Math.max(1, Math.ceil((periods + 1) * periodMs - now));
}

/**
 * Canonicalize a configured spinner interval: 0 (static) or an integer ≥ 50. Numeric strings are
 * accepted so one parser serves the CLI flag, the environment variable, and the setting.
 *
 * @throws Error on a non-numeric, negative, fractional, or too-small value.
 */
export function parseSpinnerInterval(value: unknown): number {
	const n = typeof value === "string" ? Number(value.trim() || Number.NaN) : value;
	if (
		typeof n === "number" &&
		Number.isInteger(n) &&
		(n === SPINNER_INTERVAL_STATIC || n >= SPINNER_INTERVAL_MIN_MS)
	) {
		return n;
	}
	throw new Error(
		`Spinner interval must be ${SPINNER_INTERVAL_STATIC} (static) or a whole number of milliseconds ≥ ${SPINNER_INTERVAL_MIN_MS}, got ${JSON.stringify(value)}.`,
	);
}
