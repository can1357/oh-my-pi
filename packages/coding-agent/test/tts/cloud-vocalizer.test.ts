import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { ProviderHttpError, ValidationError } from "@oh-my-pi/pi-ai/error";
import * as speech from "@oh-my-pi/pi-ai/speech";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AudioChunkChannel, ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { resolveVocalizerSpeechChain, Vocalizer, type VocalizerPlayer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { encodeWav } from "@oh-my-pi/pi-coding-agent/tts/wav";
import { logger } from "@oh-my-pi/pi-utils";

let authStorage: AuthStorage;
let tempDir: string;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cloud-vocalizer-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function gatewayRegistry(settings: Settings): ModelRegistry {
	const modelsPath = path.join(tempDir, "models.yml");
	fs.writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				gw: {
					baseUrl: "https://gateway.example/v1",
					api: "openai-completions",
					apiKey: "gw-test-key",
					models: [
						{ id: "eleven", api: "openai-speech", voice: "alloy" },
						{ id: "gemini-tts", api: "openai-speech", voice: "kore", speechFormats: ["wav"] },
						{ id: "mp3-tts", api: "openai-speech", voice: "alloy", speechFormats: ["mp3"] },
					],
				},
			},
		}),
	);
	return new ModelRegistry(authStorage, modelsPath, { settings });
}

function cloudSettings(fallbacks: string[] = []): Settings {
	return Settings.isolated({
		"speech.enabled": true,
		"speech.cloud": true,
		modelRoles: { speech: "gw/eleven" },
		"retry.fallbackChains": { speech: fallbacks },
	});
}

function recordingPlayer(): { player: VocalizerPlayer; written: Float32Array[]; rates: number[] } {
	const written: Float32Array[] = [];
	const rates: number[] = [];
	return {
		written,
		rates,
		player: {
			start: sampleRate => rates.push(sampleRate),
			write: pcm => written.push(pcm),
			setGain() {},
			end: async () => {},
			stop() {},
		},
	};
}

function wavResult(samples: number[], sampleRate: number): speech.SpeechResult {
	return {
		audio: encodeWav(new Float32Array(samples), sampleRate),
		mimeType: "audio/wav",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Stand-in for the local worker stream: records the model and plays nothing. */
function stubLocalStream() {
	const channel = new AudioChunkChannel();
	channel.close();
	return spyOn(ttsClient, "synthesizeStream").mockReturnValue({
		push() {},
		end() {},
		chunks: channel.iterator(),
	});
}

async function speakEach(vocalizer: Vocalizer, ...utterances: string[]): Promise<void> {
	for (const text of utterances) {
		vocalizer.speak(text);
		await vocalizer.idle();
	}
}

describe("resolveVocalizerSpeechChain", () => {
	const ids = (settings: Settings, provider?: string) =>
		resolveVocalizerSpeechChain({
			settings,
			registry: gatewayRegistry(settings),
			getSessionProvider: () => provider,
		}).map(model => model.id);

	test("admits only explicitly configured WAV-capable cloud models, and only with speech.cloud on", () => {
		const cloudIds = (settings: Settings) =>
			ids(settings).filter(id => ["eleven", "gemini-tts", "mp3-tts"].includes(id));
		// Unconfigured cloud defaults never leave the device.
		expect(cloudIds(Settings.isolated({ "speech.cloud": true }))).toEqual([]);
		const configured = {
			modelRoles: { speech: "gw/mp3-tts" },
			"retry.fallbackChains": { speech: ["gw/eleven", "gw/gemini-tts"] },
		};
		expect(cloudIds(Settings.isolated(configured))).toEqual([]);
		expect(ids(Settings.isolated({ ...configured, "speech.cloud": true }))).toEqual(["eleven", "gemini-tts"]);
	});

	test("offline mode admits only the session provider's cloud models", () => {
		const settings = Settings.isolated({
			"models.offline": true,
			"speech.cloud": true,
			modelRoles: { speech: "gw/eleven" },
		});
		expect(ids(settings, "anthropic")).not.toContain("eleven");
		expect(ids(settings, "gw")).toContain("eleven");
	});
});

describe("cloud speech vocalizer", () => {
	test("fails over mid-utterance and resamples the fallback to the utterance's first rate", async () => {
		const settings = cloudSettings(["gw/gemini-tts"]);
		const localStream = stubLocalStream();
		const requests: Array<{ model: string; format: string }> = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async (model, request) => {
			requests.push({ model: model.id, format: request.format });
			if (model.id === "eleven") {
				if (requests.length > 1) throw new ProviderHttpError("gw/eleven speech API failed (503)", 503);
				return wavResult([0.1, 0.2, 0.3, 0.4], 24_000);
			}
			return wavResult([0, 0.5, 1, 0.5], 48_000);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry: gatewayRegistry(settings) });

		await speakEach(vocalizer, "Hello there. How are you?");

		expect(localStream).not.toHaveBeenCalled();
		expect(requests).toEqual([
			{ model: "eleven", format: "wav" },
			{ model: "eleven", format: "wav" },
			{ model: "gemini-tts", format: "wav" },
		]);
		expect(recording.rates).toEqual([24_000]);
		// The 48 kHz segment is halved to two samples (PCM16 round-trip: 1 decodes to just under 1).
		expect(recording.written.map(pcm => pcm.length)).toEqual([4, 2]);
		expect(recording.written[1]![1]).toBeCloseTo(1, 3);
	});

	test.each([
		{ name: "a 401", error: () => new ProviderHttpError("failed (401)", 401), requests: 1 },
		{ name: "a 503", error: () => new ProviderHttpError("failed (503)", 503), requests: 2 },
		{ name: "a 429", error: () => new ProviderHttpError("failed (429)", 429), requests: 2 },
		{ name: "a ValidationError", error: () => new ValidationError("input exceeds the limit"), requests: 2 },
	])("after $name, the next utterance sends $requests request(s) in total", async ({ error, requests }) => {
		const settings = cloudSettings();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		stubLocalStream();
		const sent: string[] = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async model => {
			sent.push(model.id);
			if (sent.length === 1) throw error();
			return wavResult([0.25], 24_000);
		});
		const vocalizer = new Vocalizer(() => recordingPlayer().player);
		vocalizer.setModelSource({ settings, registry: gatewayRegistry(settings) });

		await speakEach(vocalizer, "Hello there.", "Still there?");

		expect(sent.length).toBe(requests);
	});

	test("speaks locally while a permanently failed model cools down, then retries it", async () => {
		const settings = cloudSettings();
		const localStream = stubLocalStream();
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(message => {
			warnings.push(message);
		});
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const sent: string[] = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async model => {
			sent.push(model.id);
			throw new ProviderHttpError("gw/eleven speech API failed (401)", 401);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry: gatewayRegistry(settings) });

		await speakEach(vocalizer, "Hello there.", "Still there?");
		expect(sent).toEqual(["eleven"]);
		expect(localStream).toHaveBeenCalledTimes(1);
		expect(recording.written).toEqual([]);
		expect(warnings).toEqual([
			"vocalizer: speech model failed permanently",
			"vocalizer: every speech model failed; the rest of the utterance is silent",
		]);

		now.mockReturnValue(1_000_000 + 5 * 60_000);
		await speakEach(vocalizer, "Fixed now?");
		expect(sent).toEqual(["eleven", "eleven"]);
	});
});
