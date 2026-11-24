import type { KeyEvent } from "@oh-my-pi/pi-tui";

/** Consecutive mechanical (fast + steady) deltas that confirm a configured key is held and start
 *  recording. Needs a sustained metronomic cadence, so jittery typing and deliberate taps never
 *  reach it. */
export const SPACE_HOLD_MECHANICAL_RUN = 2;

/** What a recognized push-to-talk hold drives — the start and stop callbacks. */
export interface SpaceHoldHandler {
	/** Gate for the gesture. Returns false to let matching keys behave normally. */
	enabled(): boolean;
	/** A sustained hold was recognized; any safely typed candidate text has already been deleted. */
	onStart(): void;
	/** The held key was released (an idle gap with no further repeats, or any other key). */
	onEnd(): void;
}

/** Max gap (ms) between two presses of the key for the later one to count as OS auto-repeat. */
export const SPACE_REPEAT_MAX_GAP_MS = 120;
/** Absolute jitter two consecutive auto-repeat gaps may differ by. */
export const SPACE_REPEAT_JITTER_MS = 18;
/** Jitter, as a share of the smaller gap, slower repeat rates may show. */
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
/** Idle gap (ms) after the last repeat that counts as the key's release. */
export const SPACE_HOLD_RELEASE_MS = 250;
/** A release timer this late (ms) means the event loop stalled; wait one more window before ending. */
export const SPACE_HOLD_STALL_SLACK_MS = 100;

/** What the composer does with a key after {@link SpaceHoldGesture.process}: handle it, type its text now, or drop it. */
export type SpaceHoldStep = "pass" | "type" | "swallow";

/**
 * Text a push-to-talk candidate key types: a plain or shifted single character, or Space;
 * undefined for chords and non-printable keys (the gesture reserves those instead).
 */
export function holdText(key: KeyEvent): string | undefined {
	const base = key.id.startsWith("shift+") ? key.id.slice("shift+".length) : key.id;
	if (base !== "space" && [...base].length !== 1) return undefined;
	if (base === "space") return key.text === " " ? " " : undefined;
	return key.text;
}

/**
 * Push-to-talk on a held key. A held key auto-repeats at a steady fast cadence: the gesture
 * watches the gaps between presses of a configured key and recognizes a hold once
 * {@link SPACE_HOLD_MECHANICAL_RUN} consecutive gaps are fast and steady. Deliberate taps and
 * irregular fast typing stay typed; only the text typed during the recognized run is deleted.
 * The hold ends at the first other key or once repeats stop for {@link SPACE_HOLD_RELEASE_MS}.
 */
export class SpaceHoldGesture {
	/** Configured key ids; alternatives never combine into one run. */
	keys: readonly string[] = ["space"];
	/** Unset keeps the keys typing normally. */
	handler: SpaceHoldHandler | undefined;
	readonly #deleteTyped: (count: number) => void;
	readonly #allowed: () => boolean;
	/** Units typed during the current run (deleted when it turns into a hold). */
	#typed = 0;
	#lastTyped = 0;
	#runKey: string | undefined;
	#steady = 0;
	#prevGap: number | undefined;
	#lastAt: number | undefined;
	#activeKey: string | undefined;
	#releaseTimer: NodeJS.Timeout | undefined;

	constructor(deleteTyped: (count: number) => void, allowed: () => boolean = () => true) {
		this.#deleteTyped = deleteTyped;
		this.#allowed = allowed;
	}

	/** Feed one key press; `typedLength` is the length of the text it would type (0: not printable). */
	process(key: string, typedLength: number): SpaceHoldStep {
		const handler = this.handler;
		if (!handler?.enabled() || !this.#allowed()) {
			if (this.#activeKey !== undefined) this.#end();
			else this.#resetRun();
			return "pass";
		}
		const candidate = this.keys.includes(key) ? key : undefined;
		if (this.#activeKey !== undefined) {
			if (candidate === this.#activeKey) {
				this.#armRelease();
				return "swallow";
			}
			this.#end();
		}
		if (candidate === undefined) {
			this.#resetRun();
			return "pass";
		}
		if (this.#runKey !== undefined && candidate !== this.#runKey) this.#resetRun();
		const now = performance.now();
		const previousAt = this.#lastAt;
		this.#lastAt = now;
		this.#runKey = candidate;
		const step: SpaceHoldStep = typedLength > 0 ? "type" : "swallow";
		if (previousAt === undefined) {
			this.#steady = 0;
			this.#typed = 0;
			this.#lastTyped = 0;
			return step;
		}
		const gap = now - previousAt;
		const prevGap = this.#prevGap;
		this.#prevGap = gap;
		if (prevGap === undefined) {
			// The first interval: a slow one makes the first press final.
			this.#steady = 0;
			if (gap > SPACE_REPEAT_MAX_GAP_MS) {
				this.#typed = 0;
				this.#lastTyped = 0;
			}
			return step;
		}
		const fast = gap <= SPACE_REPEAT_MAX_GAP_MS && prevGap <= SPACE_REPEAT_MAX_GAP_MS;
		const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
		if (!fast || Math.abs(gap - prevGap) > tolerance) {
			this.#steady = 0;
			// A fast gap after a slow one may still roll back the previous press and this one.
			if (gap <= SPACE_REPEAT_MAX_GAP_MS && prevGap > SPACE_REPEAT_MAX_GAP_MS) this.#typed = this.#lastTyped;
			else {
				this.#typed = 0;
				this.#lastTyped = 0;
			}
			return step;
		}
		if (++this.#steady >= SPACE_HOLD_MECHANICAL_RUN) {
			this.#deleteTyped(this.#typed);
			this.#resetRun();
			this.#activeKey = candidate;
			this.#armRelease();
			handler.onStart();
		}
		return "swallow";
	}

	/** Record the length the composer actually typed for the preceding `"type"` step. */
	recordTyped(length: number): void {
		this.#typed += Math.max(0, length);
		this.#lastTyped = Math.max(0, length);
	}

	/** End any hold and stop its timer. */
	dispose(): void {
		this.#end();
		this.handler = undefined;
	}

	#resetRun(): void {
		this.#typed = 0;
		this.#lastTyped = 0;
		this.#runKey = undefined;
		this.#steady = 0;
		this.#prevGap = undefined;
		this.#lastAt = undefined;
	}

	#armRelease(): void {
		clearTimeout(this.#releaseTimer);
		const armedAt = performance.now();
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			if (performance.now() - armedAt > SPACE_HOLD_RELEASE_MS + SPACE_HOLD_STALL_SLACK_MS) this.#armRelease();
			else this.#end();
		}, SPACE_HOLD_RELEASE_MS);
		this.#releaseTimer.unref?.();
	}

	#end(): void {
		if (this.#activeKey === undefined) return;
		this.#activeKey = undefined;
		this.#resetRun();
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = undefined;
		this.handler?.onEnd();
	}
}
