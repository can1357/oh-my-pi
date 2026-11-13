import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as speech from "@oh-my-pi/pi-ai/speech";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { resolveVocalizerSpeechChain, Vocalizer, type VocalizerPlayer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { decodeWav, encodeWav, resamplePcm } from "@oh-my-pi/pi-coding-agent/tts/wav";
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

describe("decodeWav", () => {
	test("skips a LIST chunk and reads a streamed (0xFFFFFFFF) data size to the end", () => {
		const encoded = encodeWav(new Float32Array([0, 0.5, -0.5]), 24_000);
		const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 2, 0, 0, 0, 0x61, 0x62]);
		const bytes = new Uint8Array(encoded.length + list.length);
		bytes.set(encoded.subarray(0, 36));
		bytes.set(list, 36);
		bytes.set(encoded.subarray(36), 36 + list.length);
		new DataView(bytes.buffer).setUint32(36 + list.length + 4, 0xffffffff, true);

		const { pcm, sampleRate } = decodeWav(bytes);
		expect(sampleRate).toBe(24_000);
		expect(pcm.length).toBe(3);
		expect(pcm[1]).toBeCloseTo(0.5, 3);
		expect(pcm[2]).toBeCloseTo(-0.5, 3);
	});

	test("rejects a non-WAV buffer such as MP3", () => {
		expect(() => decodeWav(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow("RIFF");
	});
});

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

describe("resamplePcm", () => {
	test("halves a 48 kHz buffer to 24 kHz by interpolating, and returns matching rates untouched", () => {
		const pcm = new Float32Array([0, 0.5, 1, 0.5]);
		expect(Array.from(resamplePcm(pcm, 48_000, 24_000))).toEqual([0, 1]);
		expect(resamplePcm(pcm, 24_000, 24_000)).toBe(pcm);
	});
});

describe("cloud speech vocalizer", () => {
	test("keeps unconfigured cloud defaults out of the chain so speech stays local", () => {
		const settings = Settings.isolated({ "speech.cloud": true });
		const chain = resolveVocalizerSpeechChain({ settings, registry: gatewayRegistry(settings) });
		expect(chain.every(model => model.api === "local-inference")).toBe(true);
	});

	test("stays local when the speech role names a cloud model but speech.cloud is off", () => {
		const settings = Settings.isolated({ modelRoles: { speech: "gw/eleven" } });
		const chain = resolveVocalizerSpeechChain({ settings, registry: gatewayRegistry(settings) });
		expect(chain.map(model => model.id)).not.toContain("eleven");
		expect(chain.every(model => model.api === "local-inference")).toBe(true);
	});

	test("drops a configured MP3-only model and keeps WAV-capable ones in order", () => {
		const settings = Settings.isolated({
			"speech.cloud": true,
			modelRoles: { speech: "gw/mp3-tts" },
			"retry.fallbackChains": { speech: ["gw/eleven", "gw/gemini-tts"] },
		});
		const chain = resolveVocalizerSpeechChain({ settings, registry: gatewayRegistry(settings) });
		expect(chain.map(model => model.id)).toEqual(["eleven", "gemini-tts"]);
	});

	test("offline mode keeps cloud models from other providers out of the chain", () => {
		const settings = Settings.isolated({
			"speech.cloud": true,
			"models.offline": true,
			modelRoles: { speech: "gw/eleven" },
		});
		const registry = gatewayRegistry(settings);
		expect(
			resolveVocalizerSpeechChain({ settings, registry, getSessionProvider: () => "anthropic" }).map(m => m.id),
		).not.toContain("eleven");
		expect(
			resolveVocalizerSpeechChain({ settings, registry, getSessionProvider: () => "gw" }).map(m => m.id),
		).toContain("eleven");
	});

	test("speaks through the cloud chain, failing over to the next model", async () => {
		const settings = Settings.isolated({
			"speech.enabled": true,
			"speech.cloud": true,
			modelRoles: { speech: "gw/eleven" },
			"retry.fallbackChains": { speech: ["gw/gemini-tts"] },
		});
		const registry = gatewayRegistry(settings);
		const localStream = spyOn(ttsClient, "synthesizeStream");
		const requests: Array<{ model: string; format: string }> = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async (model, request) => {
			requests.push({ model: model.id, format: request.format });
			if (model.id === "eleven") throw new ProviderHttpError("gw/eleven speech API failed (503)", 503);
			return wavResult([0.25, -0.25], 24_000);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry });

		vocalizer.speak("Hello there. How are you?");
		await vocalizer.idle();

		expect(localStream).not.toHaveBeenCalled();
		// The failed model is dropped for the utterance: later segments go straight to the fallback.
		expect(requests[0]).toEqual({ model: "eleven", format: "wav" });
		expect(requests.slice(1).every(request => request.model === "gemini-tts")).toBe(true);
		expect(recording.rates[0]).toBe(24_000);
		expect(recording.written.length).toBeGreaterThan(0);
		expect(recording.written[0]![0]).toBeCloseTo(0.25, 3);
	});

	test("resamples a fallback model's audio to the rate the utterance started at", async () => {
		const settings = Settings.isolated({
			"speech.enabled": true,
			"speech.cloud": true,
			modelRoles: { speech: "gw/eleven" },
			"retry.fallbackChains": { speech: ["gw/gemini-tts"] },
		});
		const registry = gatewayRegistry(settings);
		let elevenCalls = 0;
		spyOn(speech, "synthesizeSpeech").mockImplementation(async model => {
			if (model.id === "eleven") {
				elevenCalls += 1;
				if (elevenCalls > 1) throw new ProviderHttpError("gw/eleven speech API failed (503)", 503);
				return wavResult([0.1, 0.2, 0.3, 0.4], 24_000);
			}
			// Twice the first model's rate: four samples here last as long as two at 24 kHz.
			return wavResult([0, 0.5, 1, 0.5], 48_000);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry });

		vocalizer.speak("Hello there. How are you?");
		await vocalizer.idle();

		expect(recording.rates).toEqual([24_000]);
		expect(recording.written.length).toBe(2);
		expect(recording.written[0]!.length).toBe(4);
		// The 48 kHz segment is halved to two samples (PCM16 round-trip: 1 decodes to just under 1).
		expect(recording.written[1]!.length).toBe(2);
		expect(recording.written[1]![1]).toBeCloseTo(1, 3);
	});

	test("skips a model that failed with 401 for the rest of the session and warns when the chain is exhausted", async () => {
		const settings = Settings.isolated({
			"speech.enabled": true,
			"speech.cloud": true,
			modelRoles: { speech: "gw/eleven" },
			"retry.fallbackChains": { speech: [] },
		});
		const registry = gatewayRegistry(settings);
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(message => {
			warnings.push(message);
		});
		const requests: string[] = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async model => {
			requests.push(model.id);
			throw new ProviderHttpError("gw/eleven speech API failed (401)", 401);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry });

		vocalizer.speak("Hello there.");
		await vocalizer.idle();
		vocalizer.speak("Still there?");
		await vocalizer.idle();

		expect(requests).toEqual(["eleven"]);
		expect(recording.written.length).toBe(0);
		expect(warnings).toContain("vocalizer: speech model failed permanently; skipping it for this session");
		expect(warnings).toContain("vocalizer: every speech model failed; the rest of the utterance is silent");

		// A new session (model source) tries the model again.
		vocalizer.setModelSource({ settings, registry });
		vocalizer.speak("Hello again.");
		await vocalizer.idle();
		expect(requests).toEqual(["eleven", "eleven"]);
	});

	test("retries a model that failed transiently on the next utterance", async () => {
		const settings = Settings.isolated({
			"speech.enabled": true,
			"speech.cloud": true,
			modelRoles: { speech: "gw/eleven" },
			"retry.fallbackChains": { speech: [] },
		});
		const registry = gatewayRegistry(settings);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const requests: string[] = [];
		spyOn(speech, "synthesizeSpeech").mockImplementation(async model => {
			requests.push(model.id);
			if (requests.length === 1) throw new ProviderHttpError("gw/eleven speech API failed (503)", 503);
			return wavResult([0.25], 24_000);
		});
		const recording = recordingPlayer();
		const vocalizer = new Vocalizer(() => recording.player);
		vocalizer.setModelSource({ settings, registry });

		vocalizer.speak("Hello there.");
		await vocalizer.idle();
		vocalizer.speak("Still there?");
		await vocalizer.idle();

		expect(requests).toEqual(["eleven", "eleven"]);
		expect(recording.written.length).toBe(1);
	});
});
