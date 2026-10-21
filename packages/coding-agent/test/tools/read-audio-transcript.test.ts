/**
 * Audio files and video soundtracks read as timestamped transcripts from a model that hears
 * audio. Requires ffmpeg + ffprobe on PATH; the model call is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { completeSimple, Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { parseTranscriptLines } from "@oh-my-pi/pi-coding-agent/utils/media-transcript";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

const gemini = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const claude = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

// OpenRouter lists this model's input as text and audio; discovery keeps it.
const gptAudio = buildModel({
	id: "openai/gpt-audio-mini",
	name: "GPT Audio Mini",
	api: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text", "audio"],
	cost: { input: 0.6, output: 2.4, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

// Gemini on a host whose transport carries no audio: the catalog rule leaves its input alone.
const copilotGemini = buildModel({
	id: "gemini-2.5-pro",
	name: "Gemini 2.5 Pro",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 64_000,
});

function makeSession(cwd: string, available: Model[], settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModel: () => claude,
		getActiveModelString: () => `${claude.provider}/${claude.id}`,
		settings,
		modelRegistry: {
			getAvailable: () => available,
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	} as ToolSession;
}

function stubModel(reply: string, stopReason: "stop" | "length" = "stop") {
	const contexts: Context[] = [];
	const fn = (async (model: Model, context: Context) => {
		contexts.push(context);
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
			content: [{ type: "text", text: reply }],
		};
	}) as typeof completeSimple;
	return { contexts, fn };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

async function ffmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
	expect(await proc.exited).toBe(0);
}

describe.skipIf(!hasFfmpeg)("read audio transcripts", () => {
	let testDir: string;
	let audioPath: string;
	let clipPath: string;

	beforeAll(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-audio-"));
		audioPath = path.join(testDir, "talk.mp3");
		clipPath = path.join(testDir, "clip.mp4");
		await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", audioPath]);
		await ffmpeg([
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=6:size=160x120:rate=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=6",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			"-c:a",
			"aac",
			"-shortest",
			clipPath,
		]);
	});

	afterAll(async () => {
		await removeWithRetries(testDir);
	});

	it("reads an audio file as a timestamped transcript from a model that hears audio", async () => {
		const model = stubModel("[0:00.5] Good morning everyone.\n[0:03.2] The budget is approved.");
		const tool = new ReadTool(makeSession(testDir, [claude, gemini]), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain("Transcript of talk.mp3 (0:06.0, 2 lines, google/gemini-2.5-flash).");
		expect(text).toContain("[0:00.5-0:03.2] Good morning everyone.\n[0:03.2-0:06.0] The budget is approved.");
		const sent = model.contexts[0]?.messages[0]?.content;
		expect(Array.isArray(sent) && sent[0]?.type === "image" ? sent[0].mimeType : undefined).toBe("audio/ogg");
	});

	it("transcribes with any model the catalog says hears audio, in the encoding its transport takes", async () => {
		const model = stubModel("[0:00.5] Good morning everyone.");
		const tool = new ReadTool(makeSession(testDir, [claude, copilotGemini, gptAudio]), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain("Transcript of talk.mp3 (0:06.0, 1 line, openrouter/openai/gpt-audio-mini).");
		const sent = model.contexts[0]?.messages[0]?.content;
		expect(Array.isArray(sent) && sent[0]?.type === "image" ? sent[0].mimeType : undefined).toBe("audio/mpeg");
	});

	it("does not treat a model as hearing audio when its catalog input lacks it", async () => {
		const model = stubModel("unused");
		const tool = new ReadTool(makeSession(testDir, [claude, copilotGemini]), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain("No available model hears audio");
		expect(model.contexts).toHaveLength(0);
	});

	it("reads a video's soundtrack with :transcript and points at frame selectors", async () => {
		const model = stubModel("[0:01.0] Hello from the clip.");
		const tool = new ReadTool(makeSession(testDir, [gemini]), model.fn);

		const text = textOf(await tool.execute("call", { path: `${clipPath}:transcript` }));

		expect(text).toContain("Transcript of clip.mp4");
		expect(text).toContain("Read clip.mp4:<m:ss.s> for the frame at a time.");
		expect(text).toContain("[0:01.0-0:06.0] Hello from the clip.");
	});

	it("names :transcript on a bare read of a video with a soundtrack", async () => {
		const tool = new ReadTool(makeSession(testDir, [claude, gemini]));

		const text = textOf(await tool.execute("call", { path: clipPath }));

		expect(text).toContain("Soundtrack: read clip.mp4:transcript for a timestamped transcript");
	});

	it("ends a transcript cut by the model's output limit where its unfinished last line starts", async () => {
		const model = stubModel("[0:00.5] First line.\n[0:02.0] Second", "length");
		const tool = new ReadTool(makeSession(testDir, [gemini]), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain(
			"[0:00.5-0:02.0] First line.\n[Transcript stops at 0:02.0: the model reached its output limit.]",
		);
		expect(text).not.toContain("Second");
	});

	it("reports silence only when the model says so, and fails on an empty or untimed answer", async () => {
		const silent = textOf(
			await new ReadTool(makeSession(testDir, [gemini]), stubModel("(no speech)").fn).execute("call", {
				path: audioPath,
			}),
		);
		expect(silent).toContain("No speech detected.");

		const empty = await rejectionOf(
			new ReadTool(makeSession(testDir, [gemini]), stubModel("").fn).execute("call", { path: audioPath }),
		);
		expect(empty).toMatchObject({ message: "google/gemini-2.5-flash returned no transcript text." });
		const untimed = await rejectionOf(
			new ReadTool(makeSession(testDir, [gemini]), stubModel("Good morning everyone.").fn).execute("call", {
				path: audioPath,
			}),
		);
		expect(untimed).toMatchObject({
			message: expect.stringContaining("answered without timestamped lines: Good morning everyone."),
		});
	});

	it("keeps recordings from providers while images.blockImages is on", async () => {
		const model = stubModel("unused");
		const settings = Settings.isolated({ "images.blockImages": true });
		const tool = new ReadTool(makeSession(testDir, [claude, gemini], settings), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain("Audio: talk.mp3 (0:06.0, mp3,");
		expect(text).toContain("images.blockImages=true keeps media from model providers");
		expect(model.contexts).toHaveLength(0);
		expect(tool.description).not.toContain("Audio (mp3/wav/m4a");
	});

	it("shows metadata and how to get a transcript when no model hears audio", async () => {
		const model = stubModel("unused");
		const tool = new ReadTool(makeSession(testDir, [claude]), model.fn);

		const text = textOf(await tool.execute("call", { path: audioPath }));

		expect(text).toContain("Audio: talk.mp3 (0:06.0, mp3,");
		expect(text).toContain("No available model hears audio");
		expect(text).not.toContain("Cannot read binary file");
		expect(model.contexts).toHaveLength(0);
	});

	it("names transcripts in the tool prompt only while a model hears audio", () => {
		expect(new ReadTool(makeSession(testDir, [claude, gemini])).description).toContain("Audio (mp3/wav/m4a");
		expect(new ReadTool(makeSession(testDir, [claude])).description).not.toContain("Audio (mp3/wav/m4a");
	});

	it("keeps the tool prompt fixed when a model that hears audio appears mid-session", async () => {
		const available: Model[] = [claude];
		const model = stubModel("[0:00.5] Late login.");
		const tool = new ReadTool(makeSession(testDir, available), model.fn);
		const before = tool.description;

		available.push(gemini);

		expect(tool.description).toBe(before);
		expect(before).not.toContain("Audio (mp3/wav/m4a");
		expect(textOf(await tool.execute("call", { path: audioPath }))).toContain("[0:00.5-0:06.0] Late login.");
	});
});

describe("parseTranscriptLines", () => {
	it("reads the timestamp shapes models answer with", () => {
		expect(
			parseTranscriptLines(
				[
					"[0:01.000, 0:04.930] Welcome to the briefing.",
					"- **[1:13]** Oh, and the code name",
					"00:01:20,000 --> 00:01:24,500 is lighthouse.",
					"Here is the transcript:",
				].join("\n"),
				90,
			),
		).toEqual([
			{ start: 1, end: 4.93, text: "Welcome to the briefing." },
			{ start: 73, end: 80, text: "Oh, and the code name" },
			{ start: 80, end: 84.5, text: "is lighthouse." },
		]);
	});

	it("reads seconds some models answer with, but not prose starting with a number", () => {
		expect(
			parseTranscriptLines(
				[
					"1.06-7.61 | SPEAKER_00: Good morning, everyone.",
					"[7.61] Quick update on hiring.",
					"2.5 percent growth was reported.",
				].join("\n"),
				15,
			),
		).toEqual([
			{ start: 1.06, end: 7.61, text: "SPEAKER_00: Good morning, everyone." },
			{ start: 7.61, end: 15, text: "Quick update on hiring." },
		]);
	});

	it("folds one-word-per-line answers back into sentences", () => {
		const words = [
			"[0:00.0] We",
			"[0:00.4] choose",
			"[0:00.8] the",
			"[0:01.1] moon.",
			"[0:03.0] Not",
			"[0:03.3] easy.",
		];
		expect(parseTranscriptLines(words.join("\n"), 4)).toEqual([
			{ start: 0, end: 3, text: "We choose the moon." },
			{ start: 3, end: 4, text: "Not easy." },
		]);
	});
});
