/**
 * Audio and video transcripts through `read`: the soundtrack is decoded by
 * system ffmpeg and cut into model-sized windows; each window's segment times
 * must land at the right place in the file. The speech model itself is
 * replaced by an energy detector so the timing path runs without weights.
 * Requires ffmpeg + ffprobe on PATH.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sttClient } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as sttDownloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import type { SttSegment } from "@oh-my-pi/pi-coding-agent/stt/transcript";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as videoUtils from "@oh-my-pi/pi-coding-agent/utils/video";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));
const SAMPLE_RATE = 16_000;

function makeSession(testDir: string, transcribeFiles = true): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => sessionFile.slice(0, -6),
		getSessionSpawns: () => null,
		getActiveModel: () => createMockModel({ id: "text-only" }),
		settings: Settings.isolated({ "stt.transcribeFiles": transcribeFiles }),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

async function ffmpeg(...args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
	expect(await proc.exited).toBe(0);
}

/** Stand-in for the speech model: one "tone" segment per run of loud 10 ms frames, timed within the window. */
async function detectTones(_modelKey: string, audio: Float32Array): Promise<SttSegment[]> {
	const frame = SAMPLE_RATE / 100;
	const segments: SttSegment[] = [];
	let runStart = -1;
	for (let at = 0; at <= audio.length; at += frame) {
		let peak = 0;
		for (let i = at; i < Math.min(audio.length, at + frame); i++) peak = Math.max(peak, Math.abs(audio[i]!));
		if (peak > 0.1 && runStart < 0) runStart = at;
		if (peak <= 0.1 && runStart >= 0) {
			segments.push({ start: runStart / SAMPLE_RATE, end: at / SAMPLE_RATE, text: "tone" });
			runStart = -1;
		}
	}
	return segments;
}

describe.skipIf(!hasFfmpeg)("read transcript", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-transcript-"));
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(testDir);
	});

	it("places segments from every window at their time in the video's soundtrack", async () => {
		// Tones at 2 s and 12 s fall in the first 30 s window; the one at 33.5 s only
		// lands at the right time if the second window's offset is applied.
		const clip = path.join(testDir, "talk.mkv");
		await ffmpeg(
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=40:size=160x120:rate=10",
			"-f",
			"lavfi",
			"-i",
			`aevalsrc='0.5*sin(2*PI*440*t)*(between(t,2,2.999)+between(t,12,12.999)+between(t,33.5,34.499))':s=${SAMPLE_RATE}:d=40`,
			"-c:v",
			"ffv1",
			"-c:a",
			"flac",
			clip,
		);
		spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(true);
		const transcribe = spyOn(sttClient, "transcribe").mockImplementation(detectTones);
		const tool = new ReadTool(makeSession(testDir));

		const full = textOf(await tool.execute("call", { path: `${clip}:transcript` }));
		expect(transcribe.mock.calls.length).toBe(2);
		expect(full).toContain("talk.mkv (0:40.0, 3 segments");
		expect(full).toContain("[0:02.0-0:03.0] tone\n[0:12.0-0:13.0] tone\n[0:33.5-0:34.5] tone");

		const second = textOf(await tool.execute("call", { path: `${clip}:transcript:2-2:raw` }));
		expect(second).toContain("[0:12.0-0:13.0] tone");
		expect(second).not.toContain("0:02.0");
		expect(second).not.toContain("0:33.5");
	});

	it("runs recognition once for parallel page reads of one file, and one reader's abort leaves the other intact", async () => {
		// Two 30 s windows: a 40 s tone track transcribes in exactly two model calls.
		const audio = path.join(testDir, "talk.flac");
		await ffmpeg(
			"-f",
			"lavfi",
			"-i",
			`aevalsrc='0.5*sin(2*PI*440*t)*(between(t,2,2.999)+between(t,33.5,34.499))':s=${SAMPLE_RATE}:d=40`,
			audio,
		);
		spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(true);
		// Hold the first model call until the abort has happened. By the time a window
		// reaches the model, ffprobe and the decode have run, so both reads have joined.
		const firstCall = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const transcribe = spyOn(sttClient, "transcribe").mockImplementation(async (key, samples) => {
			firstCall.resolve();
			await release.promise;
			return detectTones(key, samples);
		});
		const tool = new ReadTool(makeSession(testDir));

		const aborted = new AbortController();
		const first = tool.execute("call", { path: `${audio}:1-1:raw` }, aborted.signal);
		const second = tool.execute("call", { path: `${audio}:2-2:raw` });
		await firstCall.promise;
		aborted.abort();
		await expect(first).rejects.toThrow();
		release.resolve();

		expect(textOf(await second)).toContain("[0:33.5-0:34.5] tone");
		expect(transcribe.mock.calls.length).toBe(2);
	});

	it("points at `omp setup speech` when the speech model is not downloaded", async () => {
		const audio = path.join(testDir, "memo.wav");
		await ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", audio);
		spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(false);
		const transcribe = spyOn(sttClient, "transcribe");
		const tool = new ReadTool(makeSession(testDir));

		await expect(tool.execute("call", { path: audio })).rejects.toThrow("Run `omp setup speech`");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("rejects a transcript of a video without an audio stream", async () => {
		const clip = path.join(testDir, "silent.mp4");
		await ffmpeg("-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10", "-pix_fmt", "yuv420p", clip);
		const tool = new ReadTool(makeSession(testDir));

		await expect(tool.execute("call", { path: `${clip}:transcript` })).rejects.toThrow(
			"'silent.mp4' has no audio stream to transcribe.",
		);
	});

	it("reads audio as binary and runs no speech work while stt.transcribeFiles is off", async () => {
		const audio = path.join(testDir, "memo.wav");
		await ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", audio);
		const modelCheck = spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(true);
		const probe = spyOn(videoUtils, "probeVideo");
		const transcribe = spyOn(sttClient, "transcribe").mockResolvedValue([]);
		const tool = new ReadTool(makeSession(testDir, false));

		const text = textOf(await tool.execute("call", { path: audio }));
		expect(text).toContain("Cannot read binary file");
		expect(text).toContain("Use ':raw' to read bytes verbatim.");
		expect(text).not.toContain("transcri");
		expect(modelCheck).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("treats `:transcript` as part of the path while stt.transcribeFiles is off", async () => {
		const clip = path.join(testDir, "talk.mkv");
		await ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", clip);
		spyOn(sttDownloader, "isSttModelCached").mockResolvedValue(true);
		const transcribe = spyOn(sttClient, "transcribe").mockResolvedValue([]);
		const tool = new ReadTool(makeSession(testDir, false));

		await expect(tool.execute("call", { path: `${clip}:transcript` })).rejects.toThrow("not found");
		expect(transcribe).not.toHaveBeenCalled();
	});
});
