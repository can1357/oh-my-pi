/**
 * Speed-adaptive wheel scrolling for full-screen surfaces.
 *
 * A terminal wheel "event" is not a physical notch: trackpads and touch
 * scrolling emit a continuous stream of events whose density reflects how fast
 * the user is flinging. Scrolling a fixed line per event feels sluggish in a
 * fling and uncontrollable on a discrete notch, so scale the line count by the
 * gap between consecutive events.
 */

/** Events closer than this belong to one physical notch (Ghostty bursts ~4ms) and must not re-add lines. */
const BURST_GAP_MS = 5;
/** A gap at least this long is a discrete notch (or a post-pause restart): one line, no scaling. */
const NOTCH_GAP_MS = 100;
/** Lines per event in a fast fling (gap between 50 and 100ms). */
const FAST_LINES = 2;
/** Lines per event in a very fast fling (gap between 20 and 50ms). */
const FASTER_LINES = 5;
/** Lines per event in the fastest flings (gap below 20ms); also the ceiling, so a misbehaving terminal cannot jump pages. */
const MAX_AUTO_LINES = 6;

/** Multiplier applied on top of the auto-scaled lines when Alt is held. */
export const ALT_WHEEL_SCROLL_MULTIPLIER = 5;

export class WheelScrollAccelerator {
	#lastEventMs = Number.NEGATIVE_INFINITY;

	constructor(
		/** Injectable clock so tests can synthesize fling timings. */
		private readonly now: () => number = () => performance.now(),
	) {}

	/**
	 * Record one wheel event and return how many lines it should scroll.
	 * Zero means the event is a burst duplicate of a notch already counted.
	 */
	linesForEvent(): number {
		const now = this.now();
		const gap = now - this.#lastEventMs;
		this.#lastEventMs = now;
		if (gap <= BURST_GAP_MS) return 0;
		if (gap >= NOTCH_GAP_MS) return 1;
		if (gap >= 50) return FAST_LINES;
		if (gap >= 20) return FASTER_LINES;
		return MAX_AUTO_LINES;
	}
}
