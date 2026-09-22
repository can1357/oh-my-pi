import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);
const UPSTREAM_RESULT = {
	text: "Hello from audio.",
	language: "en",
	duration: 4.25,
	segments: [{ id: 0, start: 0, end: 4.25, text: "Hello from audio." }],
	words: [{ word: "Hello", start: 0, end: 0.4 }],
	usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, cost: 0.0025, seconds: 4.25 },
};

interface UpstreamRequest {
	url: string;
	authorization: string | null;
	model: string | File | null;
	responseFormat: string | File | null;
	language: string | File | null;
	timestampGranularities: Array<string | File>;
	fileName: string;
	mimeType: string;
	audio: Uint8Array;
}

interface Harness {
	url: string;
	storage: AuthStorage;
	upstream: UpstreamRequest[];
	handle: AuthGatewayServerHandle;
	dir: string;
}

function transcriptionModel(
	provider: string,
	id: string,
	api: Api = "openai-transcriptions",
	baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	} satisfies ModelSpec<Api>);
}

async function boot(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-transcriptions-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openai", "openai-secret");
	storage.setRuntimeApiKey("openrouter", "openrouter-secret");
	const direct = transcriptionModel("openai", "whisper-1");
	const routed = transcriptionModel("openrouter", "openai/whisper-large-v3");
	const local = transcriptionModel("local", "whisper-small", "local-inference", "local://inference");
	const upstream: UpstreamRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		if (!(init?.body instanceof FormData)) throw new Error("Expected upstream multipart body");
		const file = init.body.get("file");
		if (!(file instanceof File)) throw new Error("Expected upstream audio file");
		upstream.push({
			url: String(input),
			authorization: new Headers(init.headers).get("authorization"),
			model: init.body.get("model"),
			responseFormat: init.body.get("response_format"),
			language: init.body.get("language"),
			timestampGranularities: init.body.getAll("timestamp_granularities[]"),
			fileName: file.name,
			mimeType: file.type,
			audio: new Uint8Array(await file.arrayBuffer()),
		});
		return Response.json(UPSTREAM_RESULT);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => {
			if (id === direct.id || id === `openai/${direct.id}`) return direct;
			if (id === routed.id || id === `openrouter/${routed.id}`) return routed;
			if (id === local.id || id === `local/${local.id}`) return local;
			return undefined;
		},
		version: "test",
		fetch: fetchImpl,
	});
	return { url: handle.url, storage, upstream, handle, dir };
}

async function close(harness: Harness | undefined): Promise<void> {
	if (!harness) return;
	await harness.handle.close();
	harness.storage.close();
	await fs.rm(harness.dir, { recursive: true, force: true });
}

function gatewayHeaders(contentType?: string): Record<string, string> {
	return {
		Authorization: "Bearer gw-token",
		...(contentType !== undefined && { "Content-Type": contentType }),
	};
}

describe("auth-gateway POST /v1/audio/transcriptions", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await close(harness);
		harness = undefined;
	});

	it("forwards multipart audio bytes and model through the broker credential", async () => {
		harness = await boot();
		const observed: Array<{ provider: string; model: string; costUsd?: number; client?: { app?: string } }> = [];
		vi.spyOn(harness.storage, "recordObservedUsage").mockImplementation(entry => observed.push(entry));
		const form = new FormData();
		form.append("model", "openai/whisper-1");
		form.append("file", new File([AUDIO], "sample.wav", { type: "audio/wav" }));
		form.append("language", "en");
		const response = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: { Authorization: "Bearer gw-token", "x-omp-app": "dictation-client" },
			body: form,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(UPSTREAM_RESULT);
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0]).toMatchObject({
			url: "https://api.openai.com/v1/audio/transcriptions",
			authorization: "Bearer openai-secret",
			model: "whisper-1",
			responseFormat: "json",
			language: "en",
			fileName: "sample.wav",
			mimeType: "audio/x-wav",
		});
		expect(harness.upstream[0]?.audio).toEqual(AUDIO);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			provider: "openai",
			model: "whisper-1",
			costUsd: 0.0025,
			client: { app: "dictation-client" },
		});
	});

	it("translates OpenRouter base64 JSON into the same upstream multipart contract", async () => {
		harness = await boot();
		const response = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: gatewayHeaders("application/json"),
			body: JSON.stringify({
				model: "openrouter/openai/whisper-large-v3",
				input_audio: { data: AUDIO.toBase64(), format: "wav" },
				language: "ja",
				response_format: "json",
			}),
		});

		expect(response.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0]).toMatchObject({
			url: "https://openrouter.ai/api/v1/audio/transcriptions",
			authorization: "Bearer openrouter-secret",
			model: "openai/whisper-large-v3",
			responseFormat: "json",
			language: "ja",
			fileName: "audio.wav",
			mimeType: "audio/wav",
		});
		expect(harness.upstream[0]?.audio).toEqual(AUDIO);
	});

	it("passes verbose transcript fields and timestamp controls through", async () => {
		harness = await boot();
		const form = new FormData();
		form.append("model", "whisper-1");
		form.append("file", new File([AUDIO], "speech.mp3"));
		form.append("response_format", "verbose_json");
		form.append("timestamp_granularities[]", "word");
		const response = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: gatewayHeaders(),
			body: form,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(UPSTREAM_RESULT);
		expect(harness.upstream[0]).toMatchObject({
			responseFormat: "verbose_json",
			timestampGranularities: ["word"],
			mimeType: "audio/mpeg",
		});
	});

	it("rejects unsupported response formats before upstream dispatch", async () => {
		harness = await boot();
		const form = new FormData();
		form.append("model", "whisper-1");
		form.append("file", new File([AUDIO], "speech.wav", { type: "audio/wav" }));
		form.append("response_format", "text");
		const response = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: gatewayHeaders(),
			body: form,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 400, type: "invalid_request_error" } });
		expect(harness.upstream).toHaveLength(0);
	});

	it("rejects local-only and unknown models with distinct client errors", async () => {
		harness = await boot();
		const body = (model: string) => {
			const form = new FormData();
			form.append("model", model);
			form.append("file", new File([AUDIO], "speech.wav", { type: "audio/wav" }));
			return form;
		};
		const local = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: gatewayHeaders(),
			body: body("local/whisper-small"),
		});
		expect(local.status).toBe(400);
		expect(await local.json()).toMatchObject({ error: { message: expect.stringContaining("on-device only") } });
		const unknown = await fetch(`${harness.url}/v1/audio/transcriptions`, {
			method: "POST",
			headers: gatewayHeaders(),
			body: body("missing-model"),
		});
		expect(unknown.status).toBe(404);
		expect(harness.upstream).toHaveLength(0);
	});
});
