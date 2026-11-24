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
