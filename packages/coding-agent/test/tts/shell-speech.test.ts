import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import type { SpeechRequest, SpeechResult } from "@oh-my-pi/pi-ai/speech";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	ShellSpeechHost,
	type ShellSpeechServices,
	type ShellSpeechSession,
} from "@oh-my-pi/pi-coding-agent/tts/shell-speech";
import type { TtsStreamHandle, TtsStreamOptions } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import type { VocalizerPlayer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { encodeWav } from "@oh-my-pi/pi-coding-agent/tts/wav";
import { ShellSpeechOp } from "@oh-my-pi/pi-natives";

function requireModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model: ${provider}/${id}`);
	return model;
}

class FakePlayer implements VocalizerPlayer {
	events: string[] = [];
	written: number[] = [];
	start(sampleRate: number): void {
		this.events.push(`start:${sampleRate}`);
	}
	write(pcm: Float32Array): void {
		this.written.push(...pcm);
	}
	setGain(): void {}
	async end(): Promise<void> {
		this.events.push("end");
	}
	stop(): void {
		this.events.push("stop");
	}
}

interface StreamCall {
	modelKey: string;
	options: TtsStreamOptions;
	segments: string[];
}

/** Fake synthesis and playback: one chunk per pushed segment, emitted once the input closes. */
class FakeServices implements ShellSpeechServices {
	streams: StreamCall[] = [];
	players: FakePlayer[] = [];
	cloud: Array<{ model: Model; request: SpeechRequest }> = [];
	cached = false;
	/** When set, a stream never produces audio until its signal aborts. */
	stalled = false;
	cloudAnswer: (model: Model) => SpeechResult = () => {
		throw new Error("Cloud synthesis must not run");
	};
	idleWaits = 0;
	/** Resolves when playback of an utterance is about to start. */
	playerCreated = Promise.withResolvers<void>();

	synthesizeStream(modelKey: string, options: TtsStreamOptions): TtsStreamHandle {
		const call: StreamCall = { modelKey, options, segments: [] };
		this.streams.push(call);
		const ended = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		const stalled = this.stalled;
		return {
			push: text => {
				call.segments.push(text);
			},
			end: () => ended.resolve(),
			chunks: (async function* () {
				await ended.promise;
				if (stalled) {
					await aborted.promise;
					return;
				}
				for (const [index, text] of call.segments.entries()) {
					yield { index, text, pcm: new Float32Array([index + 1, -(index + 1)]), sampleRate: 24_000 };
				}
			})(),
		};
	}

	synthesizeCloud = async (model: Model, request: SpeechRequest): Promise<SpeechResult> => {
		this.cloud.push({ model, request });
		return this.cloudAnswer(model);
	};

	createPlayer(): VocalizerPlayer {
		const player = new FakePlayer();
		this.players.push(player);
		this.playerCreated.resolve();
		return player;
	}

	async isModelCached(): Promise<boolean> {
		return this.cached;
	}

	async speechIdle(): Promise<void> {
		this.idleWaits += 1;
	}
}

function createHost(session: ShellSpeechSession): { host: ShellSpeechHost; services: FakeServices } {
	const services = new FakeServices();
	return { host: new ShellSpeechHost(session, services), services };
}

const xai = requireModel("xai", "grok-tts");
const deepInfra = requireModel("deepinfra", "hexgrad/Kokoro-82M");

let authStorage: AuthStorage;
let tempDir: string;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shell-speech-"));
});

afterEach(() => {
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("say through the session's speech setup", () => {
	test("declines until speech is set up, and still speaks when the shell requires it", async () => {
		const { host, services } = createHost({ settings: Settings.isolated() });

		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "Hello." })).toEqual({ configured: false });
		expect(await host.handle({ op: ShellSpeechOp.Voices })).toEqual({ configured: false });
		expect(services.streams).toHaveLength(0);

		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 2, text: "Hello.", required: true })).toEqual({
			configured: true,
		});
		expect(services.streams.map(call => call.modelKey)).toEqual(["phonon-31m"]);
		expect(services.players[0]?.events).toEqual(["start:24000", "end"]);

		// An installed local model counts as set up.
		services.cached = true;
		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 3, text: "Again." })).toEqual({ configured: true });
	});

	test("maps the say voice and words-per-minute rate onto the local model", async () => {
		const settings = Settings.isolated({ "speech.enabled": true, "tts.localVoice": "maeve", "tts.localSpeed": 0.9 });
		const { host, services } = createHost({ settings });

		await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "One. Two.", voice: "Edwin", rate: 210 });
		await host.handle({ op: ShellSpeechOp.Speak, id: 2, text: "Three.", voice: "Samantha", rate: 500 });
		await host.handle({ op: ShellSpeechOp.Speak, id: 3, text: "Four." });

		expect(services.streams.map(call => [call.options.voice, call.options.speed])).toEqual([
			["edwin", 1.2],
			["maeve", 1.3],
			["maeve", 0.9],
		]);
		// Every segment is played, in order, after queued assistant speech.
		expect(services.streams[0]?.segments.join(" ")).toBe("One. Two.");
		expect(services.players[0]?.written).toEqual(
			services.streams[0]!.segments.flatMap((_, index) => [index + 1, -(index + 1)]),
		);
		expect(services.idleWaits).toBe(3);
	});

	test("returns the audio of a capture request instead of playing it", async () => {
		const { host, services } = createHost({ settings: Settings.isolated({ "speech.enabled": true }) });

		const response = await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "Saved.", capture: true });

		expect(response.configured).toBe(true);
		expect(response.sampleRate).toBe(24_000);
		expect(Array.from(response.samples ?? [])).toEqual([1, -1]);
		expect(services.players).toHaveLength(0);
	});

	test("a cancel stops the speech it names and aborts its synthesis", async () => {
		const { host, services } = createHost({ settings: Settings.isolated({ "speech.enabled": true }) });
		services.stalled = true;

		const speaking = host.handle({ op: ShellSpeechOp.Speak, id: 7, text: "A long story." });
		await services.playerCreated.promise;
		expect(await host.handle({ op: ShellSpeechOp.Cancel, id: 8 })).toEqual({ configured: true });
		expect(services.streams[0]?.options.signal?.aborted).toBe(false);
		await host.handle({ op: ShellSpeechOp.Cancel, id: 7 });

		expect(await speaking).toEqual({ configured: true });
		expect(services.streams[0]?.options.signal?.aborted).toBe(true);
		expect(services.players[0]?.events).toEqual(["stop"]);
	});

	test("lists the local model's voices with their locales", async () => {
		const { host } = createHost({ settings: Settings.isolated({ "speech.enabled": true }) });

		const response = await host.handle({ op: ShellSpeechOp.Voices });

		expect(response.voices).toContainEqual({ name: "harper", locale: "en_US", sample: "Harper (American female)" });
		expect(response.voices).toContainEqual({ name: "edwin", locale: "en_GB", sample: "Edwin (British male)" });
	});

	test("stays out of the way when the offline policy forbids the speech model", async () => {
		const settings = Settings.isolated({ "speech.enabled": true, "models.offline": true });
		const { host, services } = createHost({ settings, getSessionProvider: () => "anthropic" });

		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "Hello.", required: true })).toEqual({
			configured: false,
		});
		expect(services.streams).toHaveLength(0);
	});

	test("plays a configured cloud model's WAV with a voice that model has", async () => {
		await authStorage.credentials.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
		const settings = Settings.isolated({
			modelRoles: { speech: `${xai.provider}/${xai.id}` },
			"retry.fallbackChains": { speech: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const { host, services } = createHost({ settings, modelRegistry });
		services.cloudAnswer = () => ({
			audio: encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000),
			mimeType: "audio/wav",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } as SpeechResult["usage"],
		});

		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "Hi", voice: "Rex", rate: 300 })).toEqual({
			configured: true,
		});
		await host.handle({ op: ShellSpeechOp.Speak, id: 2, text: "Hi", voice: "Samantha" });

		// xAI has no speed control, and only its own voices are passed on.
		expect(services.cloud.map(call => call.request)).toEqual([
			{ text: "Hi", format: "wav", voice: "rex" },
			{ text: "Hi", format: "wav" },
		]);
		expect(services.players[0]?.events).toEqual(["start:16000", "end"]);
		expect(services.players[0]?.written.map(sample => Math.round(sample * 2) / 2)).toEqual([0, 0.5, -0.5]);
		expect(services.streams).toHaveLength(0);
	});

	test("moves to the next speech candidate when a cloud model has no credentials", async () => {
		await authStorage.credentials.set("deepinfra", [{ type: "api_key", key: "deepinfra-test-key" }]);
		const settings = Settings.isolated({
			modelRoles: { speech: `${deepInfra.provider}/${deepInfra.id}` },
			"retry.fallbackChains": { speech: ["local/phonon-31m"] },
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const { host, services } = createHost({ settings, modelRegistry });
		services.cloudAnswer = model => {
			throw new MissingApiKeyError(model.provider);
		};

		expect(await host.handle({ op: ShellSpeechOp.Speak, id: 1, text: "Hello.", rate: 350 })).toEqual({
			configured: true,
		});

		// The OpenAI-compatible endpoint takes the rate as a speed multiplier.
		expect(services.cloud.map(call => call.request.speed)).toEqual([2]);
		expect(services.streams.map(call => call.modelKey)).toEqual(["phonon-31m"]);
		expect(services.players[0]?.events).toEqual(["start:24000", "end"]);
	});
});
