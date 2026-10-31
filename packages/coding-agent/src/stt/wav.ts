/** Convert float PCM (`[-1, 1]`) to 16-bit PCM samples, clamping out-of-range input. */
export function floatToPcm16(samples: Float32Array, target = new Int16Array(samples.length)): Int16Array {
	for (let index = 0; index < samples.length; index++) {
		const clamped = Math.max(-1, Math.min(1, samples[index]!));
		target[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
	}
	return target;
}

/**
 * Encode 16 kHz mono PCM chunks as a 16-bit little-endian WAV file. Float chunks are
 * converted with {@link floatToPcm16}; `Int16Array` chunks are copied as-is.
 */
export function encodePcm16Wav(chunks: readonly (Float32Array | Int16Array)[], sampleRate = 16_000): Uint8Array {
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

	// Every supported host is little-endian, so the Int16 view writes WAV byte order directly.
	const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, sampleCount);
	let offset = 0;
	for (const chunk of chunks) {
		if (chunk instanceof Int16Array) pcm.set(chunk, offset);
		else floatToPcm16(chunk, pcm.subarray(offset, offset + chunk.length));
		offset += chunk.length;
	}
	return wav;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index++) target[offset + index] = text.charCodeAt(index);
}
