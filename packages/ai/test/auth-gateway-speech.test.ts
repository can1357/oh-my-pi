import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startAuthGateway, type AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

interface UpstreamCall {
	url: string;
	authorization: string | null;
	body: unknown;
}

const openaiSpeech = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");
const xaiSpeech = getBundledModel("xai", "grok-tts");
const models: Record<string, Model> = {
	[openaiSpeech.id]: openaiSpeech,
	[xaiSpeech.id]: xaiSpeech,
};

let storage: AuthStorage;
let gateway: AuthGatewayServerHandle;
let calls: UpstreamCall[];
let upstreamAudio: Uint8Array<ArrayBuffer>;

beforeEach(async () => {
	storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime("deepinfra", "deepinfra-secret");
	storage.keys.setRuntime("xai", "xai-secret");
	calls = [];
	upstreamAudio = new Uint8Array([1, 3, 3, 7]);
	const fetchImpl: FetchImpl = async (input, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected a JSON speech request body");
		const headers = new Headers(init.headers);
		calls.push({
			url: String(input),
			authorization: headers.get("authorization"),
			body: JSON.parse(init.body),
		});
		return new Response(upstreamAudio, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
	};
	gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gateway-token"],
		storage,
		resolveModel: modelId => models[modelId],
		version: "test",
		fetch: fetchImpl,
	});
});

afterEach(async () => {
	await gateway.close();
	storage.close();
});

describe("auth-gateway speech", () => {
	it("translates OpenAI speech JSON and returns raw MP3 bytes", async () => {
		const response = await fetch(`${gateway.url}/v1/audio/speech`, {
			method: "POST",
			headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				model: openaiSpeech.id,
				input: "Speak warmly",
				voice: "sky",
				response_format: "mp3",
				speed: 1.2,
				instructions: "Sound welcoming",
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamAudio);
		expect(calls).toEqual([
			{
				url: `${openaiSpeech.baseUrl}/audio/speech`,
				authorization: "Bearer deepinfra-secret",
				body: {
					model: openaiSpeech.id,
					input: "Speak warmly",
					response_format: "mp3",
					voice: "sky",
					speed: 1.2,
					instructions: "Sound welcoming",
				},
			},
		]);
	});

	it("maps OpenAI speech fields to the xAI TTS payload", async () => {
		const response = await fetch(`${gateway.url}/v1/audio/speech`, {
			method: "POST",
			headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				model: xaiSpeech.id,
				input: "Hello from xAI",
				voice: "ara",
				response_format: "wav",
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/wav");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamAudio);
		expect(calls).toEqual([
			{
				url: `${xaiSpeech.baseUrl}/tts`,
				authorization: "Bearer xai-secret",
				body: {
					text: "Hello from xAI",
					voice_id: "ara",
					output_format: { codec: "wav", sample_rate: 24_000 },
				},
			},
		]);
	});

	it("rejects an unsupported response_format before dispatch", async () => {
		const response = await fetch(`${gateway.url}/v1/audio/speech`, {
			method: "POST",
			headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: openaiSpeech.id, input: "No OGG", response_format: "ogg" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 400, type: "invalid_request_error" },
		});
		expect(calls).toHaveLength(0);
	});

	it("returns 404 for an unknown speech model", async () => {
		const response = await fetch(`${gateway.url}/v1/audio/speech`, {
			method: "POST",
			headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: "missing-voice-model", input: "Hello" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: 404, type: "invalid_request_error", message: "Unknown model: missing-voice-model" },
		});
		expect(calls).toHaveLength(0);
	});
});
