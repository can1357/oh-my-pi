/**
 * The frame-rate ceiling: how often the TUI may paint. The render scheduler coalesces every
 * component's repaint request into frames no closer than {@link minFrameIntervalMs}, and the
 * animation timers (Loader shimmer, the shared spinner ticker) never tick faster than a frame can
 * land, so lowering `tui.maxFps` cuts both terminal writes and CPU. Keystroke echo is paced
 * separately by the scheduler so the pane being typed in stays crisp at any ceiling.
 *
 * Dependency-free: the scheduler, components, and the host's flag table and setting declarations
 * import it during CLI bootstrap.
 */

/** Default ceiling, in frames per second (the historical scheduler cadence). */
export const DEFAULT_MAX_FPS = 30;
/** Slowest permitted ceiling; below one frame a second the UI reads as hung. */
export const MIN_MAX_FPS = 1;
/** Fastest permitted ceiling; the scheduler's adaptive backpressure still applies above 30. */
export const MAX_MAX_FPS = 120;

let fps = DEFAULT_MAX_FPS;
const listeners = new Set<(fps: number) => void>();

/** The live ceiling in frames per second. */
export function maxFps(): number {
	return fps;
}

/** Shortest interval between two frames at the live ceiling, in milliseconds. */
export function minFrameIntervalMs(): number {
	return 1000 / fps;
}

/**
 * Set the ceiling for every consumer of this module. Callers pass a value the setting layer
 * already validated ({@link parseMaxFps}); listeners re-arm their timers at the new cadence.
 */
export function setMaxFps(next: number): void {
	if (next === fps) return;
	fps = next;
	for (const listener of listeners) listener(next);
}

/** Observe ceiling changes (for consumers that own a timer); returns the unsubscribe. */
export function onMaxFpsChange(listener: (fps: number) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Canonicalize a configured ceiling: an integer from {@link MIN_MAX_FPS} to {@link MAX_MAX_FPS}.
 * Numeric strings are accepted so one parser serves the CLI flag, the environment variable, and the
 * setting.
 *
 * @throws Error on a non-numeric, fractional, or out-of-range value.
 */
export function parseMaxFps(value: unknown): number {
	const n = typeof value === "string" ? Number(value.trim() || Number.NaN) : value;
	if (typeof n === "number" && Number.isInteger(n) && n >= MIN_MAX_FPS && n <= MAX_MAX_FPS) {
		return n;
	}
	throw new Error(
		`Max frames per second must be a whole number from ${MIN_MAX_FPS} to ${MAX_MAX_FPS}, got ${JSON.stringify(value)}.`,
	);
}
