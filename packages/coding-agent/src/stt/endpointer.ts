/**
 * Speech endpointer for live transcription with utterance models.
 *
 * The sherpa-onnx transducers (Fluid Speech Pro, Parakeet) and the
 * transformers.js Whisper pipelines decode a complete waveform in one shot. To
 * transcribe *while the user is still speaking*, this cuts the continuous
 * 16 kHz mono stream into utterances at natural pauses: each utterance is
 * decoded and committed once it ends, and the in-progress utterance is
 * re-decoded periodically for a volatile live preview. Previews stop once
 * decoding them cannot keep up with their cadence.
 *
 * Pause detection is delegated to a neural voice activity detector (Silero VAD
 * through sherpa-onnx, see {@link SpeechDetector}). A loudness gate cannot do
 * this job: it tracks energy rather than speech, so a quiet microphone or music
 * in the room fragmented utterances into sub-second clips that decoded as noise.
 * The endpointer keeps the raw audio itself and pads each detected utterance
 * with pre-roll and tail so the first and last phonemes survive.
 *
 * Silero does not count singing as speech. A recording in which the detector
 * never heard speech is therefore not discarded: on {@link StreamEndpointer.flush}
 * it is committed whole, in fixed windows, skipping windows that are silent.
 */

/** A finished utterance reported by a {@link SpeechDetector}. */
export interface DetectedSpeech {
	/** Absolute index of the first sample, counted from the detector's first input. */
	start: number;
	samples: Float32Array;
}

/** Voice activity detector the endpointer drives (sherpa-onnx `Vad`). */
export interface SpeechDetector {
	acceptWaveform(samples: Float32Array): void;
	isEmpty(): boolean;
	/** Whether the detector is currently inside an utterance. */
	isDetected(): boolean;
	front(enableExternalBuffer?: boolean): DetectedSpeech;
	pop(): void;
	/** Finish the utterance in progress, if any, so it becomes poppable. */
	flush(): void;
}

/** Tunable padding and preview cadence for {@link StreamEndpointer}. All durations in ms. */
export interface EndpointerConfig {
	sampleRate: number;
	/** Audio kept before a detected onset so the first phoneme is never clipped. */
	preRollMs: number;
	/** Audio kept after a detected offset so the final word is never cut. */
	tailMs: number;
	/** How far before the moment the detector reports speech the live preview starts. */
	onsetLookbackMs: number;
	/** Cadence of volatile partial emissions for the in-progress utterance. */
	partialIntervalMs: number;
	/** Window length for committing a recording in which no speech was detected. */
	fallbackWindowMs: number;
	/** RMS below which a fallback window is silence and is not committed (decoding silence invites hallucinations). */
	fallbackMinRms: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
	sampleRate: 16_000,
	preRollMs: 240,
	tailMs: 120,
	onsetLookbackMs: 500,
	partialIntervalMs: 450,
	fallbackWindowMs: 20_000,
	// About −50 dBFS: below a quiet room heard through a desk microphone.
	fallbackMinRms: 0.003,
};

/**
 * Emitted by {@link StreamEndpointer.push} / {@link StreamEndpointer.flush}.
 * `partial` is the volatile in-progress utterance (decode and show as preview,
 * never commit); `segment` is a finished utterance (decode and commit once).
 */
export type EndpointerEvent = { kind: "partial"; audio: Float32Array } | { kind: "segment"; audio: Float32Array };

/** Append-growable Float32 buffer that can release its oldest samples. */
class FloatBuffer {
	#data = new Float32Array(1 << 14);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	push(samples: Float32Array): void {
		const needed = this.#len + samples.length;
		if (needed > this.#data.length) {
			const next = new Float32Array(Math.max(this.#data.length * 2, needed));
			next.set(this.#data.subarray(0, this.#len));
			this.#data = next;
		}
		this.#data.set(samples, this.#len);
		this.#len = needed;
	}

	/** Copy `[start, end)` into a fresh array the caller can retain. */
	slice(start: number, end: number): Float32Array {
		return this.#data.slice(start, end);
	}

	/** Drop the oldest `count` samples. */
	discard(count: number): void {
		this.#data.copyWithin(0, count, this.#len);
		this.#len -= count;
	}
}

export class StreamEndpointer {
	readonly #cfg: EndpointerConfig;
	readonly #detector: SpeechDetector;
	readonly #preRoll: number;
	readonly #tail: number;
	readonly #lookback: number;
	readonly #partialInterval: number;
	readonly #fallbackWindow: number;

	/** Retained audio; `#base` is the absolute index of its first sample. */
	readonly #audio = new FloatBuffer();
	#base = 0;
	/** Absolute end of the last committed utterance: later ones never re-include it. */
	#committedEnd = 0;
	/** Absolute start of the live preview, or -1 while the detector hears no speech. */
	#onset = -1;
	#samplesSincePartial = 0;
	#slowPartials = 0;
	/** Whether the detector committed any utterance; until then the whole recording is retained for the fallback. */
	#heardSpeech = false;

	constructor(detector: SpeechDetector, config: Partial<EndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
		this.#detector = detector;
		const samples = (ms: number) => Math.round((this.#cfg.sampleRate * ms) / 1000);
		this.#preRoll = samples(this.#cfg.preRollMs);
		this.#tail = samples(this.#cfg.tailMs);
		this.#lookback = samples(this.#cfg.onsetLookbackMs);
		this.#partialInterval = samples(this.#cfg.partialIntervalMs);
		this.#fallbackWindow = samples(this.#cfg.fallbackWindowMs);
	}

	/**
	 * Whether previews are produced: off after two consecutive decodes slower than
	 * their cadence (the first may be a cold model), back on when the utterance
	 * commits, since the next preview starts short again.
	 */
	get partialsEnabled(): boolean {
		return this.#slowPartials < 2;
	}

	/** Records how long a preview took to decode. */
	notePartialDecode(ms: number): void {
		this.#slowPartials = ms >= this.#cfg.partialIntervalMs ? this.#slowPartials + 1 : 0;
	}

	/** Feed newly-captured samples; returns ordered partial/segment events. */
	push(samples: Float32Array): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		this.#audio.push(samples);
		this.#detector.acceptWaveform(samples);
		this.#drain(events);
		const end = this.#base + this.#audio.length;
		if (!this.#detector.isDetected()) {
			// The detector reports an onset at most the lookback window late, so older
			// silence is dead once speech has been heard (before that, the fallback needs it).
			this.#onset = -1;
			if (this.#heardSpeech) this.#release(end - this.#lookback - this.#preRoll);
			return events;
		}
		if (this.#onset < 0) {
			this.#onset = Math.max(this.#committedEnd, end - this.#lookback);
			this.#samplesSincePartial = 0;
		}
		this.#samplesSincePartial += samples.length;
		if (this.partialsEnabled && this.#samplesSincePartial >= this.#partialInterval) {
			events.push({ kind: "partial", audio: this.#slice(this.#onset, end) });
			this.#samplesSincePartial = 0;
		}
		return events;
	}

	/**
	 * End the stream; returns the trailing utterance if one is in progress, or the
	 * whole recording in non-silent windows when no speech was ever detected.
	 */
	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		this.#detector.flush();
		this.#drain(events);
		this.#onset = -1;
		if (this.#heardSpeech) return events;
		const end = this.#base + this.#audio.length;
		for (let from = this.#base; from < end; from += this.#fallbackWindow) {
			const audio = this.#slice(from, Math.min(end, from + this.#fallbackWindow));
			let energy = 0;
			for (const sample of audio) energy += sample * sample;
			if (Math.sqrt(energy / audio.length) >= this.#cfg.fallbackMinRms) events.push({ kind: "segment", audio });
		}
		this.#committedEnd = end;
		this.#release(end);
		return events;
	}

	/** Commit every utterance the detector finished, padded and clipped to unreleased audio. */
	#drain(events: EndpointerEvent[]): void {
		const end = this.#base + this.#audio.length;
		while (!this.#detector.isEmpty()) {
			const speech = this.#detector.front(false);
			this.#detector.pop();
			const from = Math.max(this.#committedEnd, this.#base, speech.start - this.#preRoll);
			const to = Math.min(end, speech.start + speech.samples.length + this.#tail);
			if (to <= from) continue;
			events.push({ kind: "segment", audio: this.#slice(from, to) });
			this.#committedEnd = to;
			this.#onset = -1;
			this.#slowPartials = 0;
			this.#heardSpeech = true;
		}
		this.#release(this.#committedEnd);
	}

	/** Drop retained audio before absolute index `upTo`, and always before the commit point. */
	#release(upTo: number): void {
		const count = Math.max(this.#committedEnd, upTo) - this.#base;
		if (count <= 0) return;
		this.#audio.discard(count);
		this.#base += count;
	}

	#slice(from: number, to: number): Float32Array {
		return this.#audio.slice(from - this.#base, to - this.#base);
	}
}
