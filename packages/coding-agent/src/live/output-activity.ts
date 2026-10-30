/** RMS above which a native output-level window counts as assistant speech. */
export const OUTPUT_ACTIVE_LEVEL = 0.015;

/** Quiet time after the last loud window before assistant speech counts as over. */
export const OUTPUT_RELEASE_MS = 400;

/**
 * Debounced assistant-speech detector over native output-level windows (~50 ms each).
 *
 * Rises on the first loud window and falls only after {@link OUTPUT_RELEASE_MS} without
 * another, so pauses between words do not flip the live phase between `speaking` and
 * `listening`. Used by `LiveSessionController`, which re-derives its phase on `onRelease`.
 */
export class OutputActivity {
	readonly #onRelease: () => void;
	#releaseTimer: NodeJS.Timeout | undefined;

	constructor(onRelease: () => void) {
		this.#onRelease = onRelease;
	}

	/** Whether the assistant is speaking, including the release hold. */
	get active(): boolean {
		return this.#releaseTimer !== undefined;
	}

	/** Records one output-level window; loud windows restart the release hold. */
	observe(level: number): void {
		if (level <= OUTPUT_ACTIVE_LEVEL) return;
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			this.#onRelease();
		}, OUTPUT_RELEASE_MS);
	}

	/** Cancels a pending release without notifying. */
	dispose(): void {
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = undefined;
	}
}
