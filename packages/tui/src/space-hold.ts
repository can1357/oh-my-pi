/** Max gap (ms) between two spaces for the later one to count as OS key auto-repeat rather than a
 *  deliberate press. OS auto-repeat is fast; a deliberate tap (even a fast one) is slower. */
export const SPACE_REPEAT_MAX_GAP_MS = 120;
/** Two consecutive inter-space gaps are "mechanical" (machine-driven auto-repeat) when both are
 *  within {@link SPACE_REPEAT_MAX_GAP_MS} and differ by no more than this — an absolute jitter floor
 *  or, for slower repeat rates, {@link SPACE_REPEAT_JITTER_RATIO} of the smaller gap. OS key-repeat
 *  is metronomic; a human smashing the bar is fast but irregular, so its deltas never stay this
 *  steady. */
export const SPACE_REPEAT_JITTER_MS = 18;
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
/** Consecutive mechanical (fast + steady) deltas that confirm the space bar is held and start
 *  recording. Needs a sustained metronomic cadence, so jittery smashing and deliberate taps never
 *  reach it. */
export const SPACE_HOLD_MECHANICAL_RUN = 2;
/** Idle gap (ms) after the last repeated space that counts as the space bar being released, ending
 *  the push-to-talk recording. Must comfortably exceed the OS key-repeat interval. */
export const SPACE_HOLD_RELEASE_MS = 250;

/** Whether two consecutive inter-space gaps look machine-driven: both within the auto-repeat band
 *  and steady enough (small absolute or proportional difference). OS key-repeat is metronomic, so
 *  its successive deltas match closely; human smashing is fast but irregular and deliberate taps are
 *  too slow, so neither passes. */
function gapsAreMechanical(gap: number, prevGap: number): boolean {
	if (gap > SPACE_REPEAT_MAX_GAP_MS || prevGap > SPACE_REPEAT_MAX_GAP_MS) return false;
	const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
	return Math.abs(gap - prevGap) <= tolerance;
}

/** What a recognized space-bar hold drives — the push-to-talk start and stop. */
export interface SpaceHoldHandler {
	/** Gate for the gesture. Returns false to keep the space bar inserting spaces normally, so
	 *  disabling push-to-talk restores plain space behavior. */
	enabled(): boolean;
	/** A sustained hold was recognized. The optimistically-typed spaces have already been deleted. */
	onStart(): void;
	/** The held space bar was released (an idle gap with no further repeated spaces, or any other key). */
	onEnd(): void;
}

/** What the host must do with a keypress after {@link SpaceHoldGesture.process} has seen it:
 *  `"pass"` — handle it normally; `"type"` — insert the space now (it is tracked back out if the run
 *  turns into a hold); `"swallow"` — drop it, the gesture consumed it. */
export type SpaceHoldStep = "pass" | "type" | "swallow";

/** Space-hold push-to-talk state machine. A held space bar emits OS auto-repeat: a *steady* stream
 *  of spaces at a fixed fast interval. We watch the inter-space deltas and only recognize a hold once
 *  {@link SPACE_HOLD_MECHANICAL_RUN} consecutive deltas are "mechanical" — both auto-repeat-fast and
 *  near-identical (see {@link gapsAreMechanical}). Smashing the bar is fast but jittery and deliberate
 *  taps are too slow, so neither escalates and both keep typing real spaces; the few spaces typed
 *  before a real hold is recognized are tracked back out of the host input. */
export class SpaceHoldGesture {
	/** Unset (the default) keeps the space bar typing spaces. */
	handler: SpaceHoldHandler | undefined;
	/** Deletes the given number of characters before the host input's cursor. */
	readonly #deleteTyped: (count: number) => void;
	/** Host input state that rules the gesture out, e.g. an editor mode where space is not text. */
	readonly #allowed: () => boolean;
	/** Spaces the host typed in the current run; tracked back out when a hold is recognized. */
	#typed = 0;
	/** Consecutive "mechanical" deltas (fast + steady); a sustained run of these confirms a held bar. */
	#mechanicalRun = 0;
	/** Inter-space gap (ms) of the previous space pair, compared against the next to judge steadiness. */
	#prevGap: number | undefined;
	/** Monotonic timestamp (ms) of the last space, to measure the gap to the next one. */
	#lastSpaceAt = Number.NEGATIVE_INFINITY;
	/** True while a recognized space-hold push-to-talk recording is in progress. */
	#active = false;
	/** Idle timer that ends the hold once repeated spaces stop arriving. */
	#releaseTimer: NodeJS.Timeout | undefined;

	constructor(deleteTyped: (count: number) => void, allowed: () => boolean = () => true) {
		this.#deleteTyped = deleteTyped;
		this.#allowed = allowed;
	}

	/** Feed one keypress, `isSpace` when it is a plain space bar press. */
	process(isSpace: boolean): SpaceHoldStep {
		if (this.#active) {
			if (isSpace) {
				// Auto-repeat while held: swallow it and keep the release timer alive.
				this.#armReleaseTimer();
				return "swallow";
			}
			// Any non-space means the bar was released — stop recording, then let the key through.
			this.#end();
			return "pass";
		}
		if (!isSpace) {
			this.#resetRun();
			return "pass";
		}
		if (!(this.handler?.enabled() && this.#allowed())) return "pass";
		const now = performance.now();
		const gap = now - this.#lastSpaceAt;
		const prevGap = this.#prevGap;
		this.#lastSpaceAt = now;
		this.#prevGap = gap;
		if (prevGap === undefined || !gapsAreMechanical(gap, prevGap)) {
			// First space, a deliberate tap, or jittery smashing: not a steady machine cadence yet, so
			// type a real space and reset the mechanical run.
			this.#mechanicalRun = 0;
			this.#typed++;
			return "type";
		}
		// Steady fast repeat: swallow it. Once the cadence has held for SPACE_HOLD_MECHANICAL_RUN
		// deltas it's a held bar — track back the few pre-burst spaces already typed and start.
		if (++this.#mechanicalRun >= SPACE_HOLD_MECHANICAL_RUN) {
			this.#deleteTyped(this.#typed);
			this.#resetRun();
			this.#active = true;
			this.#armReleaseTimer();
			this.handler?.onStart();
		}
		return "swallow";
	}

	#resetRun(): void {
		this.#typed = 0;
		this.#mechanicalRun = 0;
		this.#prevGap = undefined;
		this.#lastSpaceAt = Number.NEGATIVE_INFINITY;
	}

	#armReleaseTimer(): void {
		if (this.#releaseTimer) clearTimeout(this.#releaseTimer);
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			this.#end();
		}, SPACE_HOLD_RELEASE_MS);
		this.#releaseTimer.unref?.();
	}

	#end(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#resetRun();
		if (this.#releaseTimer) {
			clearTimeout(this.#releaseTimer);
			this.#releaseTimer = undefined;
		}
		this.handler?.onEnd();
	}
}
