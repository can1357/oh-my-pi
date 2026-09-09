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
