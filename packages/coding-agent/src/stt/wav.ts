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
		for (const sample of chunk) {
			const clamped = Math.max(-1, Math.min(1, sample));
			view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
			offset += bytesPerSample;
		}
	}
	return wav;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index++) target[offset + index] = text.charCodeAt(index);
}
