/**
 * Timed transcripts from the on-device speech models: the segment shape the
 * speech worker returns, how each engine's raw output maps onto it, how long
 * audio is cut into model-sized windows, and the text form `read` shows.
 *
 * Everything here is pure so the timing math is unit-testable without a model.
 */

/** A span of recognized speech. Times are seconds from the start of the audio the model saw. */
export interface SttSegment {
	start: number;
	end: number;
	text: string;
}

/**
 * The timing fields of a sherpa-onnx offline result. NeMo transducers emit one
 * entry per BPE token; a token that begins a word carries a leading space.
 */
export interface TimedTokens {
	tokens: readonly string[];
	/** Token start times in seconds. */
	timestamps: readonly number[];
	/** Per-token durations in seconds (TDT models); absent for other transducers. */
	durations?: readonly number[];
}

/** One transformers.js Whisper `return_timestamps` chunk; the final end is null when the model never closed it. */
export interface WhisperTimedChunk {
	text: string;
	timestamp: readonly [number, number | null];
}

const SENTENCE_END_RE = /[.!?。！？]$/;
const PUNCTUATION_ONLY_RE = /^\p{P}+$/u;
/** A pause this long between words starts a new segment even mid-sentence. */
const SEGMENT_PAUSE_S = 1;
/**
 * Sentence punctuation only closes a segment at least this long, so an
 * abbreviation (`Mr.`) or a clipped fragment joins the words that follow it.
 */
const SENTENCE_MIN_S = 2;
/** A segment this long breaks at the next word so timestamps stay useful in run-on speech. */
const SEGMENT_MAX_S = 12;

function clampSegment(start: number, end: number, text: string, durationS: number): SttSegment {
	const clampedStart = Math.min(Math.max(0, start), durationS);
	return { start: clampedStart, end: Math.min(Math.max(clampedStart, end), durationS), text };
}

/**
 * Group sherpa-onnx token timings into sentence-sized segments. A segment ends
 * after sentence-final punctuation once it spans {@link SENTENCE_MIN_S},
 * before a pause of {@link SEGMENT_PAUSE_S}, or at the first word boundary
 * past {@link SEGMENT_MAX_S}. Punctuation tokens never extend a segment's end:
 * Parakeet often emits the final period well into the following silence.
 */
export function segmentTimedTokens(result: TimedTokens, audioDurationS: number): SttSegment[] {
	const segments: SttSegment[] = [];
	let text = "";
	let start = -1;
	let end = 0;
	const flush = (): void => {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (start >= 0 && normalized.length > 0) segments.push(clampSegment(start, end, normalized, audioDurationS));
		text = "";
		start = -1;
	};
	const count = Math.min(result.tokens.length, result.timestamps.length);
	for (let index = 0; index < count; index++) {
		const token = result.tokens[index]!;
		const at = result.timestamps[index]!;
		const trimmed = token.trim();
		const startsWord = token.startsWith(" ");
		if (start >= 0 && startsWord && (at - end >= SEGMENT_PAUSE_S || at - start >= SEGMENT_MAX_S)) flush();
		if (start < 0) {
			if (trimmed.length === 0) continue;
			start = at;
		}
		text += token;
		if (!PUNCTUATION_ONLY_RE.test(trimmed)) end = at + (result.durations?.[index] ?? 0);
		const nextStartsWord = index + 1 >= count || result.tokens[index + 1]!.startsWith(" ");
		if (SENTENCE_END_RE.test(trimmed) && nextStartsWord && end - start >= SENTENCE_MIN_S) flush();
	}
	flush();
	return segments;
}

/** Map Whisper `return_timestamps` chunks onto segments; an unclosed final chunk ends with the audio. */
export function segmentWhisperChunks(chunks: readonly WhisperTimedChunk[], audioDurationS: number): SttSegment[] {
	const segments: SttSegment[] = [];
	for (const chunk of chunks) {
		const text = chunk.text.replace(/\s+/g, " ").trim();
		if (text.length === 0) continue;
		const [start, end] = chunk.timestamp;
		segments.push(clampSegment(start, end ?? audioDurationS, text, audioDurationS));
	}
	return segments;
}

const TRIM_FRAME_S = 0.03;
/** Kept before the first and after the last voiced frame so soft onsets and tails are not clipped. */
const TRIM_PAD_S = 0.1;
/** The window's quiet level is this percentile of its frame energies. */
const TRIM_QUIET_PERCENTILE = 0.1;

/**
 * Shrink each segment to the voiced audio inside it. Whisper stretches a
 * segment over the silence around it and Parakeet's token times run a few
 * frames early; the window's own energy says where the speech is. A frame is
 * voiced above `energyRatio` times the window's quiet level, floored at
 * `minThreshold` (the dictation endpointer's test). A segment's end is looked
 * for only before the next segment starts, since Whisper runs one segment up
 * to the next onset. Segments never grow, and one with no voiced frame keeps
 * its times.
 */
export function trimSegmentsToSpeech(
	segments: readonly SttSegment[],
	audio: Float32Array,
	sampleRate: number,
	voicing: { energyRatio: number; minThreshold: number },
): SttSegment[] {
	const frame = Math.max(1, Math.round(sampleRate * TRIM_FRAME_S));
	const frameCount = Math.floor(audio.length / frame);
	if (frameCount === 0) return [...segments];
	const rms = new Float64Array(frameCount);
	for (let index = 0; index < frameCount; index++) {
		let sum = 0;
		for (let i = index * frame; i < (index + 1) * frame; i++) sum += audio[i]! * audio[i]!;
		rms[index] = Math.sqrt(sum / frame);
	}
	const quiet = Float64Array.from(rms).sort()[Math.floor(frameCount * TRIM_QUIET_PERCENTILE)]!;
	const threshold = Math.max(voicing.minThreshold, quiet * voicing.energyRatio);
	const frameS = frame / sampleRate;
	return segments.map((segment, index) => {
		const first = Math.max(0, Math.floor(segment.start / frameS));
		let last = Math.min(frameCount - 1, Math.ceil(segment.end / frameS) - 1);
		const next = segments[index + 1];
		if (next) last = Math.min(last, Math.floor((next.start - TRIM_PAD_S) / frameS) - 1);
		let on = first;
		while (on <= last && rms[on]! <= threshold) on++;
		if (on > last) return segment;
		let off = last;
		while (rms[off]! <= threshold) off--;
		return {
			start: Math.max(segment.start, on * frameS - TRIM_PAD_S),
			end: Math.min(segment.end, (off + 1) * frameS + TRIM_PAD_S),
			text: segment.text,
		};
	});
}

/** A window of the decoded stream; `offset` is its first sample's index in the whole stream. */
export interface AudioChunk {
	offset: number;
	audio: Float32Array;
}

export interface AudioChunkerConfig {
	sampleRate: number;
	/** Longest window handed to the model. Whisper's receptive field is 30 s. */
	maxChunkS: number;
	/** How far back from the window end to look for a quiet place to cut. */
	searchS: number;
	/** Energy analysis frame. */
	frameMs: number;
	/** Frames averaged when ranking cut points, so a pause beats a momentary dip inside a word. */
	smoothFrames: number;
}

export const DEFAULT_AUDIO_CHUNKER_CONFIG: AudioChunkerConfig = {
	sampleRate: 16_000,
	maxChunkS: 30,
	searchS: 8,
	frameMs: 30,
	smoothFrames: 7,
};

/**
 * Sample index in `[from, to)` at the centre of the quietest run of
 * `smoothFrames` analysis frames. Ties keep the latest run so windows stay long.
 */
export function quietestCut(
	audio: Float32Array,
	from: number,
	to: number,
	frameSamples: number,
	smoothFrames: number,
): number {
	const frameCount = Math.floor((to - from) / frameSamples);
	if (frameCount <= 0) return to;
	const energy = new Float64Array(frameCount);
	for (let frame = 0; frame < frameCount; frame++) {
		const base = from + frame * frameSamples;
		let sum = 0;
		for (let i = base; i < base + frameSamples; i++) sum += audio[i]! * audio[i]!;
		energy[frame] = sum;
	}
	const run = Math.min(smoothFrames, frameCount);
	let windowSum = 0;
	for (let frame = 0; frame < run; frame++) windowSum += energy[frame]!;
	let best = windowSum;
	let bestStart = 0;
	for (let frame = run; frame < frameCount; frame++) {
		windowSum += energy[frame]! - energy[frame - run]!;
		if (windowSum <= best) {
			best = windowSum;
			bestStart = frame - run + 1;
		}
	}
	return from + Math.round((bestStart + run / 2) * frameSamples);
}

/**
 * Cuts a stream of 16 kHz mono samples into windows of at most `maxChunkS`,
 * ending each window at the quietest point in its last `searchS` seconds so
 * a cut rarely lands inside a word. Chunks are contiguous and cover every
 * sample exactly once.
 */
export class AudioChunker {
	readonly #maxSamples: number;
	readonly #searchSamples: number;
	readonly #frameSamples: number;
	readonly #smoothFrames: number;
	#buffer: Float32Array;
	#length = 0;
	#offset = 0;

	constructor(config: Partial<AudioChunkerConfig> = {}) {
		const cfg = { ...DEFAULT_AUDIO_CHUNKER_CONFIG, ...config };
		this.#maxSamples = Math.round(cfg.sampleRate * cfg.maxChunkS);
		this.#searchSamples = Math.min(this.#maxSamples - 1, Math.round(cfg.sampleRate * cfg.searchS));
		this.#frameSamples = Math.max(1, Math.round((cfg.sampleRate * cfg.frameMs) / 1000));
		this.#smoothFrames = Math.max(1, cfg.smoothFrames);
		this.#buffer = new Float32Array(this.#maxSamples * 2);
	}

	/** Append samples; returns every window that is now complete. */
	push(samples: Float32Array): AudioChunk[] {
		const needed = this.#length + samples.length;
		if (needed > this.#buffer.length) {
			const grown = new Float32Array(Math.max(needed, this.#buffer.length * 2));
			grown.set(this.#buffer.subarray(0, this.#length));
			this.#buffer = grown;
		}
		this.#buffer.set(samples, this.#length);
		this.#length = needed;
		const chunks: AudioChunk[] = [];
		while (this.#length >= this.#maxSamples) {
			const cut = quietestCut(
				this.#buffer,
				this.#maxSamples - this.#searchSamples,
				this.#maxSamples,
				this.#frameSamples,
				this.#smoothFrames,
			);
			chunks.push(this.#take(cut));
		}
		return chunks;
	}

	/** End of stream: the remaining samples as a final window, if any. */
	flush(): AudioChunk | null {
		return this.#length > 0 ? this.#take(this.#length) : null;
	}

	#take(count: number): AudioChunk {
		const chunk = { offset: this.#offset, audio: this.#buffer.slice(0, count) };
		this.#buffer.copyWithin(0, count, this.#length);
		this.#length -= count;
		this.#offset += count;
		return chunk;
	}
}

/**
 * Format seconds as `m:ss.s` (`h:mm:ss.s` from an hour), rounded to a tenth.
 * The form is also a valid video timestamp selector, so a transcript time can
 * be read back as the matching frame (`clip.mp4:1:05.3`).
 */
export function formatTranscriptTime(seconds: number): string {
	const tenths = Math.max(0, Math.round(seconds * 10));
	const hours = Math.floor(tenths / 36_000);
	const minutes = Math.floor((tenths % 36_000) / 600);
	const secs = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** One `[start-end] text` line per segment. */
export function formatTranscriptLines(segments: readonly SttSegment[]): string {
	return segments
		.map(segment => `[${formatTranscriptTime(segment.start)}-${formatTranscriptTime(segment.end)}] ${segment.text}`)
		.join("\n");
}
