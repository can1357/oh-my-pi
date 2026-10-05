/**
 * The shared spinner clock: one cadence for every animated glyph the TUI draws (Loader rows, live
 * tool blocks, the status-line brand spinner) and for the host's terminal-title spinner, so every
 * spinner shares one period and one setting (`tui.spinnerInterval`) slows or stills them all.
 *
 * Dependency-free on purpose: components, the status line, and the host's flag table and setting
 * declarations all import it during CLI bootstrap, before the first frame.
 */

/** Default spinner period, in milliseconds (the historical cadence). */
export const DEFAULT_SPINNER_INTERVAL_MS = 80;
/** Shortest permitted spinner period; faster frames cost the terminal more than they show. */
export const SPINNER_INTERVAL_MIN_MS = 50;
/** Interval value for a static spinner: frame 0 is drawn once and no spinner timer runs. */
export const SPINNER_INTERVAL_STATIC = 0;
/** Frame 0 of the default braille spinner: the glyph every static spinner shows, native ones included. */
export const STATIC_SPINNER_GLYPH = "⠋";

let intervalMs = DEFAULT_SPINNER_INTERVAL_MS;
const listeners = new Set<(intervalMs: number) => void>();

/** The live spinner period in milliseconds; {@link SPINNER_INTERVAL_STATIC} when spinners are still. */
export function spinnerInterval(): number {
	return intervalMs;
}

/** Whether spinners advance at all (false at {@link SPINNER_INTERVAL_STATIC}). */
export function spinnerAnimated(): boolean {
	return intervalMs !== SPINNER_INTERVAL_STATIC;
}

/**
 * Set the spinner period for every consumer of this clock. Callers pass a value the setting layer
 * already validated ({@link parseSpinnerInterval}); listeners re-arm their timers at the new cadence.
 */
export function setSpinnerInterval(next: number): void {
	if (next === intervalMs) return;
	intervalMs = next;
	for (const listener of listeners) listener(next);
}

/** Observe interval changes (for consumers that own a timer); returns the unsubscribe. */
export function onSpinnerIntervalChange(listener: (intervalMs: number) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Glyph index on the shared clock: `floor(now / interval) % frameCount`, or frame 0 when spinners are
 * static. Consumers that pass the same `now` source share a phase (live tool cards on
 * `performance.now()`; the status line on its `Date.now()` snapshot), and every consumer shares the
 * period.
 */
export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	if (frameCount <= 0 || intervalMs === SPINNER_INTERVAL_STATIC) return 0;
	return Math.floor(now / intervalMs) % frameCount;
}

/**
 * Milliseconds until the next multiple of `intervalMs` on the clock every spinner shares. Timers
 * armed from this fire together whoever owns them and whenever they started, so N spinners wake the
 * render scheduler in one turn and coalesce into one frame per period instead of N out-of-phase
 * frames. Rounded up so a timer never fires just before its boundary.
 */
export function spinnerTickDelay(intervalMs: number, now: number = performance.now()): number {
	// Count whole periods with a little slack: float residue at an exact boundary (100 ms is three
	// periods of 1000/30, but `100 % (1000/30)` reads as a full period) must not shorten the wait to 1 ms.
	const periods = Math.floor(now / intervalMs + 1e-6);
	return Math.max(1, Math.ceil((periods + 1) * intervalMs - now));
}

/**
 * Coarse clock tick that changes exactly when a spinner glyph would: `floor(now / interval)`, or a
 * constant 0 when spinners are static so a cache keyed on it stays valid indefinitely.
 */
export function spinnerClockTick(now: number): number {
	return intervalMs === SPINNER_INTERVAL_STATIC ? 0 : Math.floor(now / intervalMs);
}

/**
 * Canonicalize a configured spinner interval: {@link SPINNER_INTERVAL_STATIC} or an integer ≥
 * {@link SPINNER_INTERVAL_MIN_MS}. Numeric strings are accepted so one parser serves the CLI flag,
 * the environment variable, and the setting.
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
