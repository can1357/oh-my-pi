/**
 * The frame-rate ceiling (`tui.maxFps`): the render scheduler paints no closer than
 * {@link minFrameIntervalMs}, except frames a keystroke is waiting on. Dependency-free: the host's
 * flag table imports it during CLI bootstrap.
 */

/** Default ceiling, in frames per second (the historical scheduler cadence). */
export const DEFAULT_MAX_FPS = 30;
const MIN_MAX_FPS = 1;
const MAX_MAX_FPS = 120;

let fps = DEFAULT_MAX_FPS;

/** Shortest interval between two frames at the live ceiling, in milliseconds. */
export function minFrameIntervalMs(): number {
	return 1000 / fps;
}

/** Set the ceiling; callers pass a value {@link parseMaxFps} accepted. Applies from the next scheduled frame. */
export function setMaxFps(next: number): void {
	fps = next;
}

/**
 * Canonicalize a configured ceiling: an integer from 1 to 120. Numeric strings are accepted so one
 * parser serves the CLI flag, the environment variable, and the setting.
 *
 * @throws Error on a non-numeric, fractional, or out-of-range value.
 */
export function parseMaxFps(value: unknown): number {
	const n = typeof value === "string" ? Number(value.trim() || Number.NaN) : value;
	if (typeof n === "number" && Number.isInteger(n) && n >= MIN_MAX_FPS && n <= MAX_MAX_FPS) return n;
	throw new Error(
		`Max frames per second must be a whole number from ${MIN_MAX_FPS} to ${MAX_MAX_FPS}, got ${JSON.stringify(value)}.`,
	);
}
