/**
 * Every non-chat gateway route (embeddings, images, rerank, speech,
 * transcriptions, System One judgments, video submit/poll/content) answers an
 * upstream failure the pi-ai client threw. That error carries the upstream
 * response's headers; the route's error response must restate their retry
 * wait as `retry-after-ms` / `Retry-After`, the headers the gateway's HTTP
 * clients read a wait from, instead of leaving the client the body text alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const GATEWAY_TOKEN = "gw-token";
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);
/** Short enough that clients which retry a 429 on their own sleep it out quickly. */
const UPSTREAM_RETRY_AFTER_MS = 7;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function spec(provider: string, id: string, api: Api, kind: ModelSpec<Api>["kind"], baseUrl: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind,
	} satisfies ModelSpec<Api>);
}

function bundled(provider: string, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`expected bundled ${provider}/${id}`);
	return model;
}

/** A gateway whose only upstream answers every request 429 with `upstreamHeaders`. */
async function bootGateway(model: Model<Api>, upstreamHeaders: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-retry-after-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime(model.provider, "upstream-secret");
	const fetchImpl: FetchImpl = async () =>
		Response.json(
			{ error: { message: "rate limited", type: "rate_limit_error" } },
			{ status: 429, headers: upstreamHeaders },
		);
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [GATEWAY_TOKEN],
		storage,
		resolveModel: () => model,
		version: "test",
		fetch: fetchImpl,
	});
	cleanups.push(async () => {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return handle.url;
}

function post(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function get(url: string): Promise<Response> {
	return fetch(url, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } });
}

const videoModel = spec("openrouter", "google/veo-3.1", "openrouter-video", "video", "https://openrouter.ai/api/v1");
const videoJobId = encodeGatewayJobId({ provider: "openrouter", modelId: videoModel.id, upstreamId: "job-1" });

type RouteCase = [label: string, model: Model<Api>, call: (gatewayUrl: string) => Promise<Response>];

const ROUTES: RouteCase[] = [
	[
		"embeddings",
		spec("openai", "text-embedding-3-small", "openai-embeddings", "embedding", "https://api.openai.com/v1"),
		url => post(`${url}/v1/embeddings`, { model: "text-embedding-3-small", input: "hello" }),
	],
	[
		"image generations",
		spec("openai", "gpt-image-test", "openai-images", "image", "https://openai.example/v1"),
		url =>
			post(`${url}/v1/images/generations`, {
				model: "gpt-image-test",
				prompt: "paint",
				response_format: "b64_json",
			}),
	],
	[
		"rerank",
		spec("openrouter", "cohere/rerank-v3.5", "openrouter-rerank", "rerank", "https://openrouter.ai/api/v1"),
		url => post(`${url}/v1/rerank`, { model: "cohere/rerank-v3.5", query: "q", documents: ["d"] }),
	],
	[
		"speech",
		bundled("deepinfra", "hexgrad/Kokoro-82M"),
		url =>
			post(`${url}/v1/audio/speech`, {
				model: "hexgrad/Kokoro-82M",
				input: "Hi",
				voice: "sky",
				response_format: "mp3",
			}),
	],
	[
		"transcriptions",
		spec("openrouter", "openai/whisper-large-v3", "openai-transcriptions", "stt", "https://openrouter.ai/api/v1"),
		url =>
			post(`${url}/v1/audio/transcriptions`, {
				model: "openai/whisper-large-v3",
				input_audio: { data: AUDIO.toBase64(), format: "wav" },
				response_format: "json",
			}),
	],
	[
		"System One judgments",
		bundled("typesafe", "jev-latest"),
		url =>
			post(`${url}/v1/systemone`, {
				model: "typesafe/jev-latest",
				state: "Help! My payouts have been failing for 3 days.",
				questions: { urgent: { type: "noul", instructions: { question: "Does this convey urgency?" } } },
			}),
	],
	[
		"video submit",
		videoModel,
		url => post(`${url}/v1/videos`, { model: "openrouter/google/veo-3.1", prompt: "A lighthouse in a storm" }),
	],
	["video poll", videoModel, url => get(`${url}/v1/videos/${videoJobId}`)],
	["video content", videoModel, url => get(`${url}/v1/videos/${videoJobId}/content`)],
];

describe("auth-gateway routes — a thrown upstream failure's header retry wait", () => {
	it.each(ROUTES)(
		"answers a failed %s request with the upstream wait as retry headers",
		async (_label, model, call) => {
			const url = await bootGateway(model, { "retry-after-ms": String(UPSTREAM_RETRY_AFTER_MS) });

			const response = await call(url);
			await response.arrayBuffer();

			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.get("retry-after-ms")).toBe(String(UPSTREAM_RETRY_AFTER_MS));
			expect(response.headers.get("retry-after")).toBe("1");
		},
	);

	it.each(ROUTES)(
		"names no wait on a failed %s request when the upstream headers named none",
		async (_label, model, call) => {
			const url = await bootGateway(model, {});

			const response = await call(url);
			await response.arrayBuffer();

			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.get("retry-after-ms")).toBeNull();
			expect(response.headers.get("retry-after")).toBeNull();
		},
	);
});
