/**
 * Energy-based speech endpointer for live transcription.
 *
 * The on-device ASR models we ship are non-streaming: the sherpa-onnx Parakeet
 * recognizer and the transformers.js Whisper pipelines both decode a complete
 * waveform in one shot. To transcribe *while the user is still speaking*, this
 * splits the continuous 16 kHz mono float stream into speech segments at natural
 * pauses — each segment is decoded and committed as it finalizes, and the
 * in-progress segment is re-decoded periodically for a volatile live preview.
 *
 * Segmentation is pure short-time-energy VAD with an adaptive noise floor, so it
 * needs no extra model and is engine-agnostic (it runs the same way whether the
 * downstream model is sherpa or transformers). It is deliberately simple and
 * fully deterministic so it can be unit-tested with synthetic signals.
 */

/** Tunable thresholds for {@link StreamEndpointer}. All durations in ms. */
export interface EndpointerConfig {
	/** Input sample rate (the recorder always delivers 16 kHz mono). */
	sampleRate: number;
	/** Short-time analysis frame size. */
	frameMs: number;
	/** Trailing silence inside a segment that finalizes (commits) it. */
	endSilenceMs: number;
	/** Shortest speech run that is committed; shorter runs are discarded as noise. */
	minSpeechMs: number;
	/** Hard cap on segment length so long pause-free speech still commits periodically. */
	maxSegmentMs: number;
	/** Audio retained before onset so the first phoneme of a segment is never clipped. */
	preRollMs: number;
	/** Cadence of volatile partial emissions for the in-progress segment. */
	partialIntervalMs: number;
	/** Speech threshold is `max(minThreshold, noiseFloor * energyRatio)`. */
	energyRatio: number;
	/** EMA weight tracking the ambient noise floor on non-speech frames. */
	floorAttack: number;
	/** Absolute RMS floor so a near-silent room never trips speech detection. */
	minThreshold: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
	sampleRate: 16_000,
	frameMs: 30,
	endSilenceMs: 600,
	minSpeechMs: 200,
	maxSegmentMs: 12_000,
	preRollMs: 240,
	partialIntervalMs: 450,
	energyRatio: 2.5,
	floorAttack: 0.05,
	minThreshold: 0.008,
};

/**
 * Emitted by {@link StreamEndpointer.push} / {@link StreamEndpointer.flush}.
 * `partial` is the volatile in-progress segment (decode and show as preview,
 * never commit); `segment` is a finalized run (decode and commit once).
 */
export type EndpointerEvent = { kind: "partial"; audio: Float32Array } | { kind: "segment"; audio: Float32Array };

/** Append-growable Float32 buffer (amortized O(1) push, no per-frame realloc). */
class FloatBuffer {
	#data = new Float32Array(0);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	push(samples: Float32Array): void {
		const needed = this.#len + samples.length;
		if (needed > this.#data.length) {
			const next = new Float32Array(Math.max(this.#data.length * 2, needed, 1 << 14));
			next.set(this.#data.subarray(0, this.#len));
			this.#data = next;
		}
		this.#data.set(samples, this.#len);
		this.#len += samples.length;
	}

	/** Copy `[0, end)` into a fresh array the caller can retain. */
	take(end = this.#len): Float32Array {
		return this.#data.slice(0, Math.max(0, Math.min(end, this.#len)));
	}

	reset(): void {
		this.#len = 0;
	}
}

function rms(frame: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
	return Math.sqrt(sum / Math.max(1, frame.length));
}

export class StreamEndpointer {
	readonly #cfg: EndpointerConfig;
	readonly #frameSamples: number;
	readonly #preRollSamples: number;

	#leftover = new Float32Array(0);
	#inSpeech = false;
	#noiseFloor: number;
	#silenceMs = 0;
	#segmentMs = 0;
	#msSincePartial = 0;
	#partialDirty = false;

	readonly #segment = new FloatBuffer();
	/** Ring of the most recent pre-onset frames, used as segment pre-roll. */
	readonly #preRoll = new FloatBuffer();

	constructor(config: Partial<EndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
		this.#frameSamples = Math.max(1, Math.round((this.#cfg.sampleRate * this.#cfg.frameMs) / 1000));
		this.#preRollSamples = Math.max(0, Math.round((this.#cfg.sampleRate * this.#cfg.preRollMs) / 1000));
		this.#noiseFloor = this.#cfg.minThreshold;
	}

	/** Feed newly-captured samples; returns ordered partial/segment events. */
	push(samples: Float32Array): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		// Prepend the carried-over tail, then consume whole frames.
		let buf: Float32Array;
		if (this.#leftover.length === 0) {
			buf = samples;
		} else {
			buf = new Float32Array(this.#leftover.length + samples.length);
			buf.set(this.#leftover, 0);
			buf.set(samples, this.#leftover.length);
		}
		let offset = 0;
		for (; offset + this.#frameSamples <= buf.length; offset += this.#frameSamples) {
			this.#processFrame(buf.subarray(offset, offset + this.#frameSamples), events);
		}
		this.#leftover = buf.slice(offset);
		return events;
	}

	/** End the stream; returns a trailing committed segment if one is pending. */
	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		if (this.#inSpeech && this.#leftover.length > 0) {
			this.#segment.push(this.#leftover);
			this.#segmentMs += (this.#leftover.length / this.#cfg.sampleRate) * 1000;
		}
		this.#leftover = new Float32Array(0);
		if (this.#inSpeech) {
			const speechMs = this.#segmentMs - this.#silenceMs;
			if (speechMs >= this.#cfg.minSpeechMs) {
				events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
			}
		}
		this.#reset();
		return events;
	}

	#processFrame(frame: Float32Array, events: EndpointerEvent[]): void {
		const energy = rms(frame);
		const threshold = Math.max(this.#cfg.minThreshold, this.#noiseFloor * this.#cfg.energyRatio);
		const voiced = energy > threshold;
		// Track ambient noise on non-speech frames only, so loud speech never
		// inflates the floor (which would make the tail of an utterance read as
		// silence and clip the segment short).
		if (!voiced) {
			this.#noiseFloor = this.#noiseFloor * (1 - this.#cfg.floorAttack) + energy * this.#cfg.floorAttack;
		}

		if (!this.#inSpeech) {
			this.#preRoll.push(frame);
			// Keep only the most recent pre-roll window.
			if (this.#preRoll.length > this.#preRollSamples) {
				const tail = this.#preRoll.take().slice(this.#preRoll.length - this.#preRollSamples);
				this.#preRoll.reset();
				this.#preRoll.push(tail);
			}
			if (voiced) this.#beginSegment(frame);
			return;
		}

		this.#segment.push(frame);
		this.#segmentMs += this.#cfg.frameMs;
		this.#msSincePartial += this.#cfg.frameMs;
		if (voiced) {
			this.#silenceMs = 0;
			this.#partialDirty = true;
		} else {
			this.#silenceMs += this.#cfg.frameMs;
		}

		if (this.#silenceMs >= this.#cfg.endSilenceMs) {
			this.#finalizeSegment(events);
			return;
		}
		if (this.#segmentMs >= this.#cfg.maxSegmentMs) {
			// Pause-free long speech: commit what we have and continue a fresh
			// segment so output keeps flowing.
			events.push({ kind: "segment", audio: this.#segment.take() });
			this.#segment.reset();
			this.#segmentMs = 0;
			this.#silenceMs = 0;
			this.#msSincePartial = 0;
			this.#partialDirty = false;
			return;
		}
		if (this.#partialDirty && this.#msSincePartial >= this.#cfg.partialIntervalMs) {
			events.push({ kind: "partial", audio: this.#segment.take() });
			this.#msSincePartial = 0;
			this.#partialDirty = false;
		}
	}

	#beginSegment(onsetFrame: Float32Array): void {
		this.#inSpeech = true;
		this.#segment.reset();
		const preRoll = this.#preRoll.take();
		if (preRoll.length > 0) this.#segment.push(preRoll);
		this.#segment.push(onsetFrame);
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = (this.#segment.length / this.#cfg.sampleRate) * 1000;
		this.#msSincePartial = 0;
		this.#partialDirty = true;
	}

	#finalizeSegment(events: EndpointerEvent[]): void {
		const speechMs = this.#segmentMs - this.#silenceMs;
		if (speechMs >= this.#cfg.minSpeechMs) {
			events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
		}
		this.#inSpeech = false;
		this.#segment.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
	}

	/** Samples to keep when committing on silence: drop most of the trailing
	 *  silence but leave a short tail so the final word is not cut. */
	#endpointKeep(): number {
		const tailMs = Math.min(this.#silenceMs, 120);
		const dropMs = Math.max(0, this.#silenceMs - tailMs);
		const drop = Math.round((this.#cfg.sampleRate * dropMs) / 1000);
		return Math.max(0, this.#segment.length - drop);
	}

	#reset(): void {
		this.#inSpeech = false;
		this.#segment.reset();
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
		this.#noiseFloor = this.#cfg.minThreshold;
	}
}
