/**
 * Energy-based speech endpointer for live transcription.
 *
 * The on-device ASR models we ship are non-streaming: the sherpa-onnx Parakeet
 * recognizer and the transformers.js Whisper pipelines both decode a complete
 * waveform in one shot. To transcribe *while the user is still speaking*, this
 * splits the continuous 16 kHz mono float stream into speech segments at natural
 * pauses — each segment is decoded and committed as it finalizes, and the
 * in-progress segment is re-decoded periodically for a volatile live preview.
 * Previews stop once decoding them falls behind both their cadence and real time.
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
	/**
	 * A preview decode counts as slow when it takes longer than the cadence and
	 * longer than this fraction of the audio it covers. Two slow decodes in a row
	 * stop previews. A model whose cost is fixed per call (Whisper's 30 s window)
	 * trips this on the first short previews. A model whose cost grows with the
	 * audio (Parakeet) keeps previewing long segments it decodes faster than real time.
	 */
	maxPartialDecodeRatio: number;
	/** Speech threshold is `max(minThreshold, noiseFloor * energyRatio)`. */
	energyRatio: number;
	/** EMA weight tracking the ambient noise floor on non-speech frames between segments. */
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
	maxPartialDecodeRatio: 0.5,
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

/** Fixed-capacity ring keeping the most recent `capacity` samples. */
class FloatRing {
	readonly #data: Float32Array;
	#start = 0;
	#len = 0;

	constructor(capacity: number) {
		this.#data = new Float32Array(capacity);
	}

	push(samples: Float32Array): void {
		const cap = this.#data.length;
		if (cap === 0) return;
		if (samples.length >= cap) {
			this.#data.set(samples.subarray(samples.length - cap));
			this.#start = 0;
			this.#len = cap;
			return;
		}
		const pos = (this.#start + this.#len) % cap;
		const first = Math.min(samples.length, cap - pos);
		this.#data.set(samples.subarray(0, first), pos);
		if (first < samples.length) this.#data.set(samples.subarray(first), 0);
		const total = this.#len + samples.length;
		if (total > cap) {
			this.#start = (this.#start + total - cap) % cap;
			this.#len = cap;
		} else {
			this.#len = total;
		}
	}

	/** Append the retained samples, oldest first, to `target`. */
	copyInto(target: FloatBuffer): void {
		const cap = this.#data.length;
		const end = this.#start + this.#len;
		target.push(this.#data.subarray(this.#start, Math.min(end, cap)));
		if (end > cap) target.push(this.#data.subarray(0, end - cap));
	}

	reset(): void {
		this.#start = 0;
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

	/** Partial frame carried to the next push; always shorter than one frame. */
	readonly #leftover: Float32Array;
	#leftoverLen = 0;
	#inSpeech = false;
	#noiseFloor: number;
	#silenceMs = 0;
	#segmentMs = 0;
	/** Pre-roll at the head of the current segment; it is context, not speech. */
	#leadMs = 0;
	#msSincePartial = 0;
	#partialDirty = false;
	#slowPartials = 0;

	readonly #segment = new FloatBuffer();
	/** Ring of the most recent pre-onset samples, used as segment pre-roll. */
	readonly #preRoll: FloatRing;

	constructor(config: Partial<EndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
		this.#frameSamples = Math.max(1, Math.round((this.#cfg.sampleRate * this.#cfg.frameMs) / 1000));
		this.#preRollSamples = Math.max(0, Math.round((this.#cfg.sampleRate * this.#cfg.preRollMs) / 1000));
		this.#leftover = new Float32Array(this.#frameSamples);
		this.#preRoll = new FloatRing(this.#preRollSamples);
		this.#noiseFloor = this.#cfg.minThreshold;
	}

	/** Whether previews are still produced: off after two consecutive slow decodes (the first may be a cold model). */
	get partialsEnabled(): boolean {
		return this.#slowPartials < 2;
	}

	/** Records how long a preview of `audioMs` of audio took to decode. */
	notePartialDecode(decodeMs: number, audioMs: number): void {
		const slow = decodeMs >= this.#cfg.partialIntervalMs && decodeMs >= audioMs * this.#cfg.maxPartialDecodeRatio;
		this.#slowPartials = slow ? this.#slowPartials + 1 : 0;
	}

	/** Feed newly-captured samples; returns ordered partial/segment events. */
	push(samples: Float32Array): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		const frame = this.#frameSamples;
		let offset = 0;
		// Complete the carried-over partial frame first, then consume whole frames in place.
		if (this.#leftoverLen > 0) {
			const fill = Math.min(frame - this.#leftoverLen, samples.length);
			this.#leftover.set(samples.subarray(0, fill), this.#leftoverLen);
			this.#leftoverLen += fill;
			offset = fill;
			if (this.#leftoverLen < frame) return events;
			this.#processFrame(this.#leftover, events);
			this.#leftoverLen = 0;
		}
		for (; offset + frame <= samples.length; offset += frame) {
			this.#processFrame(samples.subarray(offset, offset + frame), events);
		}
		if (offset < samples.length) {
			this.#leftover.set(samples.subarray(offset));
			this.#leftoverLen = samples.length - offset;
		}
		return events;
	}

	/** End the stream; returns a trailing committed segment if one is pending. */
	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		if (this.#inSpeech && this.#leftoverLen > 0) {
			this.#segment.push(this.#leftover.subarray(0, this.#leftoverLen));
			this.#segmentMs += (this.#leftoverLen / this.#cfg.sampleRate) * 1000;
		}
		this.#leftoverLen = 0;
		if (this.#inSpeech && this.#speechMs() >= this.#cfg.minSpeechMs) {
			events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
		}
		this.#reset();
		return events;
	}

	#processFrame(frame: Float32Array, events: EndpointerEvent[]): void {
		const energy = rms(frame);
		const threshold = Math.max(this.#cfg.minThreshold, this.#noiseFloor * this.#cfg.energyRatio);
		const voiced = energy > threshold;
		// Track ambient noise only between segments. Inside one, sub-threshold
		// frames are mostly quiet speech: feeding them in ratchets the floor up
		// until the speaker's own voice reads as silence, which ends the segment
		// mid-sentence and drops the rest of the utterance.
		if (!voiced && !this.#inSpeech) {
			this.#noiseFloor = this.#noiseFloor * (1 - this.#cfg.floorAttack) + energy * this.#cfg.floorAttack;
		}

		if (!this.#inSpeech) {
			if (voiced) this.#beginSegment(frame);
			else this.#preRoll.push(frame);
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
			this.#leadMs = 0;
			this.#silenceMs = 0;
			this.#msSincePartial = 0;
			this.#partialDirty = false;
			return;
		}
		// Preview only a run long enough to commit. Speech time never shrinks within a segment, so
		// a previewed segment always commits and replaces its preview; a click never shows one.
		if (
			this.partialsEnabled &&
			this.#partialDirty &&
			this.#msSincePartial >= this.#cfg.partialIntervalMs &&
			this.#speechMs() >= this.#cfg.minSpeechMs
		) {
			events.push({ kind: "partial", audio: this.#segment.take() });
			this.#msSincePartial = 0;
			this.#partialDirty = false;
		}
	}

	#beginSegment(onsetFrame: Float32Array): void {
		this.#inSpeech = true;
		this.#segment.reset();
		this.#preRoll.copyInto(this.#segment);
		this.#preRoll.reset();
		this.#leadMs = (this.#segment.length / this.#cfg.sampleRate) * 1000;
		this.#segment.push(onsetFrame);
		this.#segmentMs = this.#leadMs + this.#cfg.frameMs;
		this.#silenceMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = true;
	}

	#finalizeSegment(events: EndpointerEvent[]): void {
		if (this.#speechMs() >= this.#cfg.minSpeechMs) {
			events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
		}
		this.#inSpeech = false;
		this.#segment.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#leadMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
	}

	/** Onset frame through the last voiced frame: excludes the pre-roll and trailing silence. */
	#speechMs(): number {
		return this.#segmentMs - this.#leadMs - this.#silenceMs;
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
		this.#leadMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
		this.#noiseFloor = this.#cfg.minThreshold;
	}
}
