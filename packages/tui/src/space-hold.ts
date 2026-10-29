import { addKeyAliases, canonicalKeyId } from "./keybindings";
import { extractPrintableText, type KeyId, parseKey } from "./keys";

/** Printable text a push-to-talk candidate key types (plain or shifted single characters and Space),
 *  or undefined for non-printable keys and chords, which the gesture reserves instead of typing. */
export function getSpaceHoldText(data: string, canonical: string | undefined): string | undefined {
	if (canonical === undefined) return undefined;
	const shifted = canonical.startsWith("shift+");
	const base = shifted ? canonical.slice("shift+".length) : canonical;
	if (base !== "space" && base.length !== 1) return undefined;
	if (base === "space" && canonical !== "space" && !shifted) return undefined;
	const text = extractPrintableText(data);
	return text && (base !== "space" || text === " ") ? text : undefined;
}

/** Max gap (ms) between two configured-key presses for a later one to count as OS key auto-repeat
 *  rather than a deliberate press. OS auto-repeat is fast; a deliberate tap (even a fast one) is slower. */
export const SPACE_REPEAT_MAX_GAP_MS = 120;
/** Two consecutive inter-key gaps are "mechanical" (machine-driven auto-repeat) when both are
 *  within {@link SPACE_REPEAT_MAX_GAP_MS} and differ by no more than this — an absolute jitter floor
 *  or, for slower repeat rates, {@link SPACE_REPEAT_JITTER_RATIO} of the smaller gap. OS key-repeat
 *  is metronomic; human typing is irregular, so its deltas do not stay this steady. */
export const SPACE_REPEAT_JITTER_MS = 18;
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
/** Consecutive mechanical (fast + steady) deltas that confirm a configured key is held and start
 *  recording. Needs a sustained metronomic cadence, so jittery typing and deliberate taps never
 *  reach it. */
export const SPACE_HOLD_MECHANICAL_RUN = 2;
/** Idle gap (ms) after the last repeated configured-key press that counts as release and ends
 *  push-to-talk. Must comfortably exceed the OS key-repeat interval. */
export const SPACE_HOLD_RELEASE_MS = 250;
/** A release timer firing more than this (ms) past its deadline means the event loop stalled (a
 *  synchronous microphone open, GC, a heavy render) while the bar may still be held: the repeats
 *  emitted during the stall are queued but unread, so the stall must not read as a release. */
export const SPACE_HOLD_STALL_SLACK_MS = 100;

/** Whether two consecutive inter-key gaps look machine-driven: both within the auto-repeat band
 *  and steady enough (small absolute or proportional difference). OS key-repeat is metronomic, so
 *  its successive deltas match closely; human smashing is fast but irregular and deliberate taps are
 *  too slow, so neither passes. */
function gapsAreMechanical(gap: number, prevGap: number): boolean {
	if (gap > SPACE_REPEAT_MAX_GAP_MS || prevGap > SPACE_REPEAT_MAX_GAP_MS) return false;
	const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
	return Math.abs(gap - prevGap) <= tolerance;
}

/** What a recognized push-to-talk hold drives — the start and stop callbacks. */
export interface SpaceHoldHandler {
	/** Gate for the gesture. Returns false to let matching keys behave normally. */
	enabled(): boolean;
	/** A sustained hold was recognized; any safely typed candidate text has already been deleted. */
	onStart(): void;
	/** The held key was released (an idle gap with no further repeats, or any other key). */
	onEnd(): void;
}

/** What the host must do with a keypress after {@link SpaceHoldGesture.process} has seen it:
 *  `"pass"` — handle it normally; `"type"` — insert its safely decoded printable text now (it is
 *  tracked back out if the run turns into a hold); `"swallow"` — drop it, the gesture consumed it. */
export type SpaceHoldStep = "pass" | "type" | "swallow";

/** Push-to-talk key-hold state machine. A held key emits OS auto-repeat at a steady fast interval.
 *  We watch inter-key deltas and only recognize a hold once {@link SPACE_HOLD_MECHANICAL_RUN}
 *  consecutive deltas are mechanical (see {@link gapsAreMechanical}). Deliberate taps and jittery
 *  runs stay typed; only text typed during the current steady run is removed on recognition. */
export class SpaceHoldGesture {
	/** Canonical aliases of {@link keys}, rebuilt only when the bindings change (not per keystroke). */
	#keyAliases = new Set<string>(["space"]);
	#keys: readonly KeyId[] = ["space"];
	/** Configured alternative keys. Alternatives are tracked independently and never combine into one run. */
	get keys(): readonly KeyId[] {
		return this.#keys;
	}
	set keys(keys: readonly KeyId[]) {
		this.#keys = keys;
		const aliases = new Set<string>();
		for (const key of keys) addKeyAliases(aliases, key);
		this.#keyAliases = aliases;
	}
	/** Unset (the default) keeps configured keys behaving normally. */
	handler: SpaceHoldHandler | undefined;
	/** Deletes the given number of characters before the host input's cursor. */
	readonly #deleteTyped: (count: number) => void;
	/** Host input state that rules the gesture out, e.g. an editor mode where keys are not text. */
	readonly #allowed: () => boolean;
	/** Safely inserted text units in the current mechanical run; removed if a hold is recognized. */
	#typed = 0;
	/** Length of the most recent candidate event actually typed into the host. */
	#lastTypedLength = 0;
	/** Canonical key in the current run, preventing alternate bindings from combining. */
	#runKey: string | undefined;
	/** Consecutive mechanical (fast + steady) deltas; a sustained run confirms a held key. */
	#mechanicalRun = 0;
	/** Inter-key gap (ms) of the previous pair, compared against the next to judge steadiness. */
	#prevGap: number | undefined;
	/** Monotonic timestamp (ms) of the last configured keypress. */
	#lastKeyAt = Number.NEGATIVE_INFINITY;
	/** Canonical key while a recognized push-to-talk recording is in progress. */
	#activeKey: string | undefined;
	/** True while a recognized key-hold push-to-talk recording is in progress. */
	#active = false;
	/** Idle timer that ends the hold once repeated keypresses stop arriving. */
	#releaseTimer: NodeJS.Timeout | undefined;

	constructor(deleteTyped: (count: number) => void, allowed: () => boolean = () => true) {
		this.#deleteTyped = deleteTyped;
		this.#allowed = allowed;
	}

	/** Pure focused-owner preflight on raw input: whether the key must reach the host before
	 *  TUI-wide input listeners. Only non-printable bindings are claimed — they would otherwise
	 *  trigger app shortcuts mid-hold; printable candidates keep the normal listener path so
	 *  raw-input observers (e.g. extensions) still see typed text, as they did before remapping. */
	shouldRoute(data: string): boolean {
		if (!(this.handler?.enabled() && this.#allowed())) return false;
		const parsedKey = parseKey(data);
		if (parsedKey === undefined) return false;
		const key = canonicalKeyId(parsedKey);
		return this.#keyAliases.has(key) && getSpaceHoldText(data, key) === undefined;
	}

	/** Feed one canonical keypress and, when safely printable, its decoded text length. The host
	 *  records the actual inserted length with {@link recordTyped} after applying normal typing. */
	process(key: string | undefined, insertedCharacterLength = 0): SpaceHoldStep {
		const handler = this.handler;
		if (!(handler?.enabled() && this.#allowed())) {
			if (this.#active) this.#end();
			else this.#resetRun();
			return "pass";
		}

		const candidateKey = key !== undefined && this.#keyAliases.has(key) ? key : undefined;

		if (this.#active) {
			if (candidateKey === this.#activeKey) {
				// Auto-repeat while the same configured key is held: keep the release timer alive.
				this.#armReleaseTimer();
				return "swallow";
			}
			// Any other key means the active key was released. End this recording, then treat a
			// different configured alternative as a fresh gesture rather than merging the keys.
			this.#end();
		}

		if (candidateKey === undefined) {
			this.#resetRun();
			return "pass";
		}

		if (this.#runKey !== undefined && candidateKey !== this.#runKey) this.#resetRun();
		const now = performance.now();
		const hasPreviousKey = this.#lastKeyAt !== Number.NEGATIVE_INFINITY;
		const gap = now - this.#lastKeyAt;
		const prevGap = this.#prevGap;
		this.#lastKeyAt = now;
		this.#runKey = candidateKey;
		const printable = insertedCharacterLength > 0;

		if (!hasPreviousKey) {
			this.#mechanicalRun = 0;
			this.#typed = 0;
			this.#lastTypedLength = 0;
			return printable ? "type" : "swallow";
		}

		this.#prevGap = gap;
		if (prevGap === undefined) {
			// The second event establishes the first interval. A fast gap keeps earlier literal
			// typing eligible for rollback; a slow gap makes that first tap final.
			this.#mechanicalRun = 0;
			if (gap > SPACE_REPEAT_MAX_GAP_MS) {
				this.#typed = 0;
				this.#lastTypedLength = 0;
			}
			return printable ? "type" : "swallow";
		}

		if (!gapsAreMechanical(gap, prevGap)) {
			// A fast interval after a slow gap may roll back the previous event and this one.
			// Slow current gaps and jitter breaks keep prior text final.
			this.#mechanicalRun = 0;
			if (gap <= SPACE_REPEAT_MAX_GAP_MS && prevGap > SPACE_REPEAT_MAX_GAP_MS) {
				this.#typed = this.#lastTypedLength;
			} else {
				this.#typed = 0;
				this.#lastTypedLength = 0;
			}
			return printable ? "type" : "swallow";
		}

		// Steady fast repeat: swallow it. Once the cadence confirms a held key, remove only the
		// literal candidate text from the current uninterrupted run and start recording.
		if (++this.#mechanicalRun >= SPACE_HOLD_MECHANICAL_RUN) {
			this.#deleteTyped(this.#typed);
			this.#resetRun();
			this.#active = true;
			this.#activeKey = candidateKey;
			this.#armReleaseTimer();
			handler.onStart();
		}
		return "swallow";
	}

	/** Account for text the host actually inserted for the preceding `"type"` step. */
	recordTyped(insertedCharacterLength: number): void {
		const insertedLength = Math.max(0, insertedCharacterLength);
		this.#typed += insertedLength;
		this.#lastTypedLength = insertedLength;
	}

	#resetRun(): void {
		this.#lastTypedLength = 0;
		this.#typed = 0;
		this.#runKey = undefined;
		this.#mechanicalRun = 0;
		this.#prevGap = undefined;
		this.#lastKeyAt = Number.NEGATIVE_INFINITY;
	}

	#armReleaseTimer(): void {
		clearTimeout(this.#releaseTimer);
		const armedAt = performance.now();
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			// Late firing means input went unobserved; wait one more window so queued repeats can
			// re-arm the timer before deciding the key was released.
			if (performance.now() - armedAt > SPACE_HOLD_RELEASE_MS + SPACE_HOLD_STALL_SLACK_MS) {
				this.#armReleaseTimer();
				return;
			}
			this.#end();
		}, SPACE_HOLD_RELEASE_MS);
		this.#releaseTimer.unref?.();
	}

	#end(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#activeKey = undefined;
		this.#resetRun();
		if (this.#releaseTimer) {
			clearTimeout(this.#releaseTimer);
			this.#releaseTimer = undefined;
		}
		this.handler?.onEnd();
	}
}
