const WAV_HEADER_BYTES = 44;
const PCM16_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/**
 * Assemble a mono PCM16 WAV byte buffer from Float32 PCM samples (normalized
 * [-1, 1] amplitudes, as the local TTS worker emits them) at `sampleRate`.
 * No external encoder is involved — we write a canonical 44-byte RIFF/
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

/** Mono PCM decoded from a WAV file. */
export interface DecodedWav {
	pcm: Float32Array;
	sampleRate: number;
}

const FLOAT_FORMAT = 3;
const EXTENSIBLE_FORMAT = 0xfffe;

/**
 * Decode a RIFF/WAVE byte buffer (8/16/24/32-bit PCM, or 32-bit float) into
 * mono Float32 samples in [-1, 1], averaging the channels. Cloud speech
 * providers answer a `wav` request with such a file.
 *
 * @throws when the buffer is not a WAVE file in one of those sample formats.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 12 || readAscii(view, 0) !== "RIFF" || readAscii(view, 8) !== "WAVE") {
		throw new Error("Not a WAVE file");
	}
	let format: { tag: number; channels: number; sampleRate: number; bits: number } | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = readAscii(view, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		// A streamed file may declare more data than it holds.
		const end = Math.min(bytes.length, body + size);
		if (id === "fmt " && end - body >= 16) {
			let tag = view.getUint16(body, true);
			if (tag === EXTENSIBLE_FORMAT && end - body >= 26) tag = view.getUint16(body + 24, true);
			format = {
				tag,
				channels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bits: view.getUint16(body + 14, true),
			};
		} else if (id === "data") {
			if (!format) throw new Error("WAVE data precedes its format");
			const { tag, channels, sampleRate, bits } = format;
			const width = bits / 8;
			const read = wavSampleReader(view, tag, bits);
			if (!read || channels === 0) throw new Error(`Unsupported WAVE sample format (tag ${tag}, ${bits}-bit)`);
			const frames = Math.floor((end - body) / (width * channels));
			const pcm = new Float32Array(frames);
			for (let frame = 0; frame < frames; frame += 1) {
				let sum = 0;
				for (let channel = 0; channel < channels; channel += 1) {
					sum += read(body + (frame * channels + channel) * width);
				}
				pcm[frame] = sum / channels;
			}
			return { pcm, sampleRate };
		}
		offset = end + (size % 2);
	}
	throw new Error("WAVE file has no audio data");
}

/** Reader of one little-endian sample at a byte offset, normalized to [-1, 1]. */
function wavSampleReader(view: DataView, tag: number, bits: number): ((offset: number) => number) | undefined {
	if (tag === FLOAT_FORMAT) return bits === 32 ? offset => view.getFloat32(offset, true) : undefined;
	if (tag !== PCM16_FORMAT) return undefined;
	switch (bits) {
		case 8:
			// 8-bit PCM is unsigned.
			return offset => (view.getUint8(offset) - 128) / 128;
		case 16:
			return offset => view.getInt16(offset, true) / 32_768;
		case 24:
			return offset => ((view.getInt8(offset + 2) << 16) | view.getUint16(offset, true)) / 8_388_608;
		case 32:
			return offset => view.getInt32(offset, true) / 2_147_483_648;
		default:
			return undefined;
	}
}

function readAscii(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
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
