import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSpeechCandidates, ttsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";

function requireModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model: ${provider}/${id}`);
	return model;
}

function createContext(
	settings: Settings,
	modelRegistry: ModelRegistry,
	cwd: string,
	fetchImpl: FetchImpl,
): CustomToolContext {
	return {
		sessionManager: SessionManager.create(cwd, cwd),
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort() {},
		settings,
		fetch: fetchImpl,
	};
}

const local = requireModel("local", "kokoro");
const xai = requireModel("xai", "grok-tts");
const deepInfra = requireModel("deepinfra", "hexgrad/Kokoro-82M");

let authStorage: AuthStorage;
let tempDir: string;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tts-chain-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("speech role candidate ordering", () => {
	test("hoists available default cloud candidates ahead of local for MP3 only", async () => {
		await authStorage.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });

		expect(resolveSpeechCandidates(settings, registry, false).map(candidate => candidate.model)).toEqual([
			local,
			xai,
		]);
		expect(resolveSpeechCandidates(settings, registry, true).map(candidate => candidate.model)).toEqual([xai, local]);
	});

	test("keeps an explicitly configured local candidate ahead of paid MP3 candidates", async () => {
		await authStorage.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
		const settings = Settings.isolated({ modelRoles: { speech: "local/kokoro" } });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });

		const candidates = resolveSpeechCandidates(settings, registry, true);
		expect(candidates.map(candidate => candidate.model)).toEqual([local, xai]);
		expect(candidates.map(candidate => candidate.explicit)).toEqual([true, false]);
	});
});

describe("tts speech chain execution", () => {
	test("uses the default local model for WAV output", async () => {
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0, 0.25, -0.25]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => {
			throw new Error("Cloud fetch must not run for default WAV output");
		};

		const result = await ttsTool.execute(
			"tts-local",
			{ text: "Hello locally", language: "en", output_path: "voice.wav" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "local-inference", voiceId: "kokoro/af_heart", codec: "wav" });
		expect(localSynthesis).toHaveBeenCalledWith("kokoro", "Hello locally", {
			voice: "af_heart",
			signal: undefined,
		});
		expect(fs.existsSync(path.join(tempDir, "voice.wav"))).toBe(true);
	});

	test("uses the selected openai-speech endpoint and model id", async () => {
		await authStorage.set("deepinfra", [{ type: "api_key", key: "deepinfra-test-key" }]);
		const settings = Settings.isolated({
			modelRoles: { speech: `${deepInfra.provider}/${deepInfra.id}` },
			"retry.fallbackChains": { speech: [] },
		});
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		let requestedUrl = "";
		let requestedBody: string | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			requestedUrl = String(input);
			if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
			requestedBody = init.body;
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		};

		const result = await ttsTool.execute(
			"tts-cloud",
			{ text: "Hello cloud", voice_id: "sky", language: "en", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(requestedUrl).toBe(`${deepInfra.baseUrl}/audio/speech`);
		expect(requestedBody).toBe(
			JSON.stringify({ model: deepInfra.id, input: "Hello cloud", response_format: "mp3", voice: "sky" }),
		);
		expect(result.details).toMatchObject({ backend: "openai-speech", codec: "mp3" });
	});

	test("does not fall back when the explicit speech fallback chain is empty", async () => {
		await authStorage.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
		const settings = Settings.isolated({
			modelRoles: { speech: `${xai.provider}/${xai.id}` },
			"retry.fallbackChains": { speech: [] },
		});
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => new Response("temporarily unavailable", { status: 503 });

		const result = await ttsTool.execute(
			"tts-explicit",
			{ text: "No fallback", language: "en", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).toBe(true);
		expect(localSynthesis).not.toHaveBeenCalled();
	});

	test("advances from a cloud HTTP error to the next local candidate", async () => {
		await authStorage.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0, 0.5, -0.5]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => new Response("rate limited", { status: 429 });

		const result = await ttsTool.execute(
			"tts-fallback",
			{ text: "Fall back locally", language: "en", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "local-inference", codec: "wav" });
		expect(localSynthesis).toHaveBeenCalledWith("kokoro", "Fall back locally", {
			voice: "af_heart",
			signal: undefined,
		});
		expect(fs.existsSync(path.join(tempDir, "voice.wav"))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "voice.mp3"))).toBe(false);
	});
});
