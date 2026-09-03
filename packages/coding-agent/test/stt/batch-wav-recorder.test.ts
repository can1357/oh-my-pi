import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BATCH_RECORDING, BatchWavRecorder } from "@oh-my-pi/pi-coding-agent/stt";
import { getSpeechToTextCacheDir } from "@oh-my-pi/pi-utils";

const createdPaths = new Set<string>();

afterEach(async () => {
	await Promise.all([...createdPaths].map(filePath => fs.promises.rm(filePath, { force: true })));
	createdPaths.clear();
});

describe("BatchWavRecorder", () => {
	it("writes PCM16 WAV data in the resolved OMP cache", async () => {
		const recorder = await BatchWavRecorder.create();
		createdPaths.add(recorder.filePath);
		expect(path.dirname(recorder.filePath)).toBe(getSpeechToTextCacheDir());
		expect(await recorder.append(new Float32Array([0, 0.5, -0.5]))).toBe(false);
		await recorder.finalize();
		const wav = new Uint8Array(await fs.promises.readFile(recorder.filePath));
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(42);
		expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
		expect(new TextDecoder().decode(wav.subarray(12, 16))).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint32(28, true)).toBe(32_000);
		expect(view.getUint16(32, true)).toBe(2);
		expect(view.getUint16(34, true)).toBe(16);
		expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe("data");
		expect(view.getUint32(40, true)).toBe(6);
		expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 16_384, -16_384]);
		await recorder.dispose();
		createdPaths.delete(recorder.filePath);
	});

	it("reclaims recordings abandoned by dead processes", async () => {
		const cacheDir = getSpeechToTextCacheDir();
		await fs.promises.mkdir(cacheDir, { recursive: true });
		const abandonedPath = path.join(cacheDir, `record-2147483647-${crypto.randomUUID()}.wav`);
		await Bun.write(abandonedPath, "private audio");
		createdPaths.add(abandonedPath);
		const recorder = await BatchWavRecorder.create();
		createdPaths.add(recorder.filePath);
		expect(await Bun.file(abandonedPath).exists()).toBe(false);
		await recorder.dispose();
		createdPaths.delete(recorder.filePath);
		createdPaths.delete(abandonedPath);
	});

	it("reclaims expired recordings whose PID has been reused", async () => {
		const cacheDir = getSpeechToTextCacheDir();
		await fs.promises.mkdir(cacheDir, { recursive: true });
		const abandonedPath = path.join(cacheDir, `record-${process.pid}-${crypto.randomUUID()}.wav`);
		await Bun.write(abandonedPath, "private audio");
		const expired = new Date(Date.now() - 25 * 60 * 60_000);
		await fs.promises.utimes(abandonedPath, expired, expired);
		createdPaths.add(abandonedPath);
		const recorder = await BatchWavRecorder.create();
		createdPaths.add(recorder.filePath);
		expect(await Bun.file(abandonedPath).exists()).toBe(false);
		await recorder.dispose();
		createdPaths.delete(recorder.filePath);
		createdPaths.delete(abandonedPath);
	});

	it("warns once at the configured threshold without truncating subsequent audio", async () => {
		const recorder = await BatchWavRecorder.create();
		createdPaths.add(recorder.filePath);
		expect(await recorder.append(new Float32Array(BATCH_RECORDING.warningSamples - 1))).toBe(false);
		expect(await recorder.append(new Float32Array([0.25, 0.5]))).toBe(true);
		expect(await recorder.append(new Float32Array([0.75]))).toBe(false);
		expect(recorder.sampleCount).toBe(BATCH_RECORDING.warningSamples + 2);
		await recorder.dispose();
		createdPaths.delete(recorder.filePath);
	});
});
