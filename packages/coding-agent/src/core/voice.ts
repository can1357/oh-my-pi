import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { nanoid } from "nanoid";
import voiceSummaryPrompt from "../prompts/voice-summary.md" with { type: "text" };
import { logger } from "./logger";
import type { ModelRegistry } from "./model-registry";
import { findSmolModel } from "./model-resolver";
import type { VoiceSettings } from "./settings-manager";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS = 16;
const SUMMARY_MAX_CHARS = 6000;

export interface VoiceRecordingHandle {
	filePath: string;
	stop: () => Promise<void>;
	cancel: () => Promise<void>;
	cleanup: () => void;
}

export interface VoiceTranscriptionResult {
	text: string;
}

export interface VoiceSynthesisResult {
	audio: Uint8Array;
	format: "wav" | "mp3" | "opus" | "aac" | "flac";
}

function buildRecordingCommand(filePath: string, sampleRate: number, channels: number): string[] | null {
	const soxPath = Bun.which("sox") ?? Bun.which("rec");
	if (soxPath) {
		return [soxPath, "-d", "-r", String(sampleRate), "-c", String(channels), "-b", String(DEFAULT_BITS), filePath];
	}

	const arecordPath = Bun.which("arecord");
	if (arecordPath) {
		return [arecordPath, "-f", "S16_LE", "-r", String(sampleRate), "-c", String(channels), filePath];
	}

	const ffmpegPath = Bun.which("ffmpeg");
	if (ffmpegPath) {
		const platform = process.platform;
		if (platform === "darwin") {
			// avfoundation default input device; users can override by installing sox for reliability.
			return [
				ffmpegPath,
				"-f",
				"avfoundation",
				"-i",
				":0",
				"-ac",
				String(channels),
				"-ar",
				String(sampleRate),
				"-y",
				filePath,
			];
		}
		if (platform === "linux") {
			// alsa default input device (commonly "default").
			return [
				ffmpegPath,
				"-f",
				"alsa",
				"-i",
				"default",
				"-ac",
				String(channels),
				"-ar",
				String(sampleRate),
				"-y",
				filePath,
			];
		}
		if (platform === "win32") {
			// dshow default input device name varies; "audio=default" is a best-effort fallback.
			return [
				ffmpegPath,
				"-f",
				"dshow",
				"-i",
				"audio=default",
				"-ac",
				String(channels),
				"-ar",
				String(sampleRate),
				"-y",
				filePath,
			];
		}
	}

	return null;
}

export async function startVoiceRecording(_settings: VoiceSettings): Promise<VoiceRecordingHandle> {
	const sampleRate = DEFAULT_SAMPLE_RATE;
	const channels = DEFAULT_CHANNELS;
	const filePath = join(tmpdir(), `omp-voice-${nanoid()}.wav`);
	const command = buildRecordingCommand(filePath, sampleRate, channels);
	if (!command) {
		throw new Error("No audio recorder found (install sox, arecord, or ffmpeg).");
	}

	logger.debug("voice: starting recorder", { command });
	const proc = Bun.spawn(command, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});

	const stop = async (): Promise<void> => {
		try {
			proc.kill();
		} catch {
			// ignore
		}
		await proc.exited;
	};

	const cleanup = (): void => {
		try {
			unlinkSync(filePath);
		} catch {
			// ignore cleanup errors
		}
	};

	const cancel = async (): Promise<void> => {
		await stop();
		cleanup();
	};

	return { filePath, stop, cancel, cleanup };
}

export async function transcribeAudio(
	filePath: string,
	apiKey: string,
	settings: VoiceSettings,
): Promise<VoiceTranscriptionResult> {
	const file = Bun.file(filePath);
	const buffer = await file.arrayBuffer();
	const blob = new File([buffer], "speech.wav", { type: "audio/wav" });
	const form = new FormData();
	form.append("file", blob);
	form.append("model", settings.transcriptionModel ?? "whisper-1");
	if (settings.transcriptionLanguage) {
		form.append("language", settings.transcriptionLanguage);
	}

	const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`Whisper transcription failed: ${response.status} ${errText}`);
	}

	const data = (await response.json()) as { text?: string };
	return { text: (data.text ?? "").trim() };
}

export async function synthesizeSpeech(
	text: string,
	apiKey: string,
	settings: VoiceSettings,
): Promise<VoiceSynthesisResult> {
	const format = settings.ttsFormat ?? "wav";
	const response = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: settings.ttsModel ?? "tts-1",
			voice: settings.ttsVoice ?? "alloy",
			format,
			input: text,
		}),
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`TTS synthesis failed: ${response.status} ${errText}`);
	}

	const audio = new Uint8Array(await response.arrayBuffer());
	return { audio, format };
}

function getPlayerCommand(filePath: string, format: VoiceSynthesisResult["format"]): string[] | null {
	const platform = process.platform;
	if (platform === "darwin") {
		const afplay = Bun.which("afplay");
		if (afplay) return [afplay, filePath];
	}

	if (platform === "linux") {
		const paplay = Bun.which("paplay");
		if (paplay) return [paplay, filePath];
		const aplay = Bun.which("aplay");
		if (aplay) return [aplay, filePath];
		const ffplay = Bun.which("ffplay");
		if (ffplay) return [ffplay, "-autoexit", "-nodisp", filePath];
		const play = Bun.which("play");
		if (play) return [play, filePath];
	}

	if (platform === "win32") {
		if (format !== "wav") {
			return null;
		}
		const ps = Bun.which("powershell");
		if (ps) {
			return [
				ps,
				"-NoProfile",
				"-Command",
				`(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`,
			];
		}
	}

	return null;
}

export async function playAudio(audio: Uint8Array, format: VoiceSynthesisResult["format"]): Promise<void> {
	const filePath = join(tmpdir(), `omp-tts-${nanoid()}.${format}`);
	await Bun.write(filePath, audio);

	const command = getPlayerCommand(filePath, format);
	if (!command) {
		throw new Error("No audio player available for playback.");
	}

	const proc = Bun.spawn(command, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	await proc.exited;

	try {
		unlinkSync(filePath);
	} catch {
		// ignore cleanup errors
	}
}

function extractTextFromResponse(response: { content: Array<{ type: string; text?: string }> }): string {
	let text = "";
	for (const content of response.content) {
		if (content.type === "text" && content.text) {
			text += content.text;
		}
	}
	return text.trim();
}

export async function summarizeForVoice(
	text: string,
	registry: ModelRegistry,
	savedSmolModel?: string,
): Promise<string | null> {
	const model = await findSmolModel(registry, savedSmolModel);
	if (!model) {
		logger.debug("voice: no smol model found for summary");
		return null;
	}

	const apiKey = await registry.getApiKey(model);
	if (!apiKey) {
		logger.debug("voice: no API key for summary model", { provider: model.provider, id: model.id });
		return null;
	}

	const truncated = text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}...` : text;
	const request = {
		model: `${model.provider}/${model.id}`,
		systemPrompt: voiceSummaryPrompt,
		userMessage: `<assistant_response>\n${truncated}\n</assistant_response>`,
	};
	logger.debug("voice: summary request", request);

	try {
		const response = await completeSimple(
			model as Model<any>,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
			},
			{ apiKey, maxTokens: 120 },
		);
		const summary = extractTextFromResponse(response);
		return summary || null;
	} catch (error) {
		logger.debug("voice: summary error", { error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}
