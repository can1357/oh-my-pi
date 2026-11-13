const WAV_HEADER_BYTES = 44;
const PCM16_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/**
 * Assemble a mono PCM16 WAV byte buffer from Float32 PCM samples (the shape
 * transformers.js `RawAudio` emits: normalized [-1, 1] amplitudes plus a sample
 * rate). No external encoder is involved — we write a canonical 44-byte RIFF/
 * WAVE header followed by little-endian signed 16-bit samples. Samples are
 * clamped before quantization so out-of-range float values do not wrap.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const channels = 1;
	const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8);
	const blockAlign = channels * (BITS_PER_SAMPLE / 8);
	const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);

	// RIFF chunk descriptor
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true); // file size minus the first 8 bytes
	writeAscii(view, 8, "WAVE");

	// fmt sub-chunk
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, PCM16_FORMAT, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);

	// data sub-chunk
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = WAV_HEADER_BYTES;
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		const quantized =
			clamped < 0
				? Math.max(INT16_MIN, Math.round(clamped * -INT16_MIN))
				: Math.min(INT16_MAX, Math.round(clamped * INT16_MAX));
		view.setInt16(offset, quantized, true);
		offset += 2;
	}

	return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Decode a PCM16 RIFF/WAVE byte buffer (what cloud speech endpoints return for
 * `response_format: wav`) into mono Float32 PCM. Walks the chunk list, so
 * `LIST`/`fact` chunks before `data` are skipped; a streamed `data` size of
 * 0xFFFFFFFF (or any size past the buffer) means "until the end". Multichannel
 * audio is downmixed by averaging. Throws on anything but 16-bit integer PCM.
 */
export function decodeWav(bytes: Uint8Array): { pcm: Float32Array; sampleRate: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 12 || readAscii(view, 0) !== "RIFF" || readAscii(view, 8) !== "WAVE") {
		throw new Error("Not a RIFF/WAVE audio buffer");
	}
	let channels = 0;
	let sampleRate = 0;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = readAscii(view, offset);
		const declared = view.getUint32(offset + 4, true);
		const start = offset + 8;
		const size = Math.min(declared, bytes.byteLength - start);
		if (id === "fmt ") {
			if (size < 16) throw new Error("Truncated WAV fmt chunk");
			const format = view.getUint16(start, true);
			const bits = view.getUint16(start + 14, true);
			if (format !== PCM16_FORMAT || bits !== BITS_PER_SAMPLE) {
				throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit); expected PCM16`);
			}
			channels = view.getUint16(start + 2, true);
			sampleRate = view.getUint32(start + 4, true);
		} else if (id === "data") {
			if (channels === 0 || sampleRate === 0) throw new Error("WAV data chunk precedes its fmt chunk");
			const frames = Math.floor(size / (2 * channels));
			const pcm = new Float32Array(frames);
			for (let frame = 0; frame < frames; frame += 1) {
				let sum = 0;
				for (let channel = 0; channel < channels; channel += 1) {
					sum += view.getInt16(start + (frame * channels + channel) * 2, true);
				}
				pcm[frame] = sum / channels / -INT16_MIN;
			}
			return { pcm, sampleRate };
		}
		// Chunks are word-aligned: an odd-sized chunk carries one pad byte.
		offset = start + declared + (declared & 1);
	}
	throw new Error("WAV buffer has no data chunk");
}

/**
 * Linearly resample mono Float32 PCM from `fromRate` to `toRate`. Speech only
 * needs this when a mid-utterance fail-over lands on a model with another rate,
 * so plain interpolation (no anti-aliasing filter) is enough. Returns `pcm`
 * itself when the rates match.
 */
export function resamplePcm(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || pcm.length === 0) return pcm;
	const out = new Float32Array(Math.max(1, Math.round((pcm.length * toRate) / fromRate)));
	const step = fromRate / toRate;
	const last = pcm.length - 1;
	for (let i = 0; i < out.length; i += 1) {
		const position = i * step;
		const lower = Math.floor(position);
		if (lower >= last) {
			out[i] = pcm[last]!;
			continue;
		}
		const fraction = position - lower;
		out[i] = pcm[lower]! + (pcm[lower + 1]! - pcm[lower]!) * fraction;
	}
	return out;
}

function readAscii(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}
