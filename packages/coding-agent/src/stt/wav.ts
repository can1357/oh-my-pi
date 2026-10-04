/** Encode 16 kHz mono float PCM chunks as a 16-bit little-endian WAV file. */
export function encodePcm16Wav(chunks: readonly Float32Array[], sampleRate = 16_000): Uint8Array {
	let sampleCount = 0;
	for (const chunk of chunks) sampleCount += chunk.length;

	const channelCount = 1;
	const bytesPerSample = 2;
	const dataBytes = sampleCount * bytesPerSample;
	const wav = new Uint8Array(44 + dataBytes);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

	writeAscii(wav, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(wav, 8, "WAVE");
	writeAscii(wav, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channelCount, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
	view.setUint16(32, channelCount * bytesPerSample, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeAscii(wav, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (const chunk of chunks) {
		offset = writePcm16(chunk, view, offset);
	}
	return wav;
}

/** Encode mono normalized floats as raw signed 16-bit little-endian PCM. */
export function encodePcm16(samples: Float32Array): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	writePcm16(samples, new DataView(bytes.buffer), 0);
	return bytes;
}

function writePcm16(samples: Float32Array, view: DataView, offset: number): number {
	for (const sample of samples) {
		const clamped = Math.max(-1, Math.min(1, sample));
		view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
		offset += 2;
	}
	return offset;
}

/** Decode raw signed 16-bit little-endian PCM for native floating-point playback. */
export function decodePcm16(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength % 2 !== 0) throw new Error("PCM16 audio has an incomplete sample");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Float32Array(bytes.byteLength / 2);
	for (let index = 0; index < samples.length; index++) {
		samples[index] = view.getInt16(index * 2, true) / 0x8000;
	}
	return samples;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index++) target[offset + index] = text.charCodeAt(index);
}
