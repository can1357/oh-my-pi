export const WAV_HEADER_BYTES = 44;
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
	const pcm = encodePcm16(samples);
	const header = createWavHeader(samples.length, sampleRate);
	const output = new Uint8Array(header.byteLength + pcm.byteLength);
	output.set(header);
	output.set(pcm, header.byteLength);
	return output;
}

export function encodePcm16(samples: Float32Array): Uint8Array {
	const buffer = new ArrayBuffer(samples.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		const quantized =
			clamped < 0
				? Math.max(INT16_MIN, Math.round(clamped * -INT16_MIN))
				: Math.min(INT16_MAX, Math.round(clamped * INT16_MAX));
		view.setInt16(i * 2, quantized, true);
	}
	return new Uint8Array(buffer);
}

export function createWavHeader(sampleCount: number, sampleRate: number): Uint8Array {
	const bytesPerSample = BITS_PER_SAMPLE / 8;
	const dataBytes = sampleCount * bytesPerSample;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
	const view = new DataView(buffer);
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, PCM16_FORMAT, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);
	return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
