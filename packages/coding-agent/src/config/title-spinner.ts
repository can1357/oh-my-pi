// Shared by the `tui.titleSpinnerInterval` setting, the `--title-spinner-interval` flag, and the
// terminal-title runtime. Kept dependency-free: setting declarations and flag tables load during CLI
// bootstrap, before the first frame, so this must not pull `utils/title-generator` in.

/**
 * Default working-state spinner period, in milliseconds. Every tick is an OSC title write that the
 * host terminal must parse, re-evaluate its title formula for, and repaint a tab for — and under tmux
 * control mode that happens once per attached client. 4 frames/s reads as motion at a fraction of
 * the cost of the historical 80 ms (12.5/s).
 */
export const TITLE_SPINNER_INTERVAL_MS = 250;
/** Shortest permitted spinner period; faster writes cost the host more than they show. */
export const TITLE_SPINNER_INTERVAL_MIN_MS = 50;
/** Interval value for a static working separator (`:`): no animation, no timer. */
export const TITLE_SPINNER_INTERVAL_STATIC = 0;

/**
 * Canonicalize a configured spinner interval: `0` (static) or an integer ≥
 * {@link TITLE_SPINNER_INTERVAL_MIN_MS}. Numeric strings are accepted so the same parser serves the
 * CLI flag and the setting.
 *
 * @throws Error on a non-numeric, negative, fractional, or too-small value.
 */
export function parseTitleSpinnerInterval(value: unknown): number {
	const n = typeof value === "string" ? Number(value.trim() || Number.NaN) : value;
	if (
		typeof n === "number" &&
		Number.isInteger(n) &&
		(n === TITLE_SPINNER_INTERVAL_STATIC || n >= TITLE_SPINNER_INTERVAL_MIN_MS)
	) {
		return n;
	}
	throw new Error(
		`Title spinner interval must be ${TITLE_SPINNER_INTERVAL_STATIC} (static) or a whole number of milliseconds ≥ ${TITLE_SPINNER_INTERVAL_MIN_MS}, got ${JSON.stringify(value)}.`,
	);
}
