import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface UpstreamRequest {
	url: string;
	authorization: string | null;
	body: unknown;
}

interface Harness {
	url: string;
	storage: AuthStorage;
	upstream: UpstreamRequest[];
	handle: AuthGatewayServerHandle;
	dir: string;
}

function embeddingModel(
	provider: string,
	id: string,
	api: Api = "openai-embeddings",
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
		cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: null,
		kind: "embedding",
		supportsTools: false,
	} satisfies ModelSpec<Api>);
}

async function boot(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-embeddings-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openai", "openai-secret");
	storage.setRuntimeApiKey("openrouter", "openrouter-secret");
	const direct = embeddingModel("openai", "text-embedding-3-small");
	const routed = embeddingModel("openrouter", "qwen/qwen3-embedding-8b");
	const wrongApi = embeddingModel("openai", "gpt-5.5", "openai-responses");
	const upstream: UpstreamRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const body: unknown = JSON.parse(String(init?.body));
		upstream.push({
			url: String(input),
			authorization: new Headers(init?.headers).get("authorization"),
			body,
		});
		if (body && typeof body === "object" && Reflect.get(body, "encoding_format") === "base64") {
			return Response.json({
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: "AACAPwAAAEA=" }],
				model: "qwen/qwen3-embedding-8b",
				usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.00000004 },
			});
		}
		return Response.json({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: [0.125, -0.25, 0.5] }],
			model: "text-embedding-3-small",
			usage: { prompt_tokens: 5, total_tokens: 5 },
		});
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => {
			if (id === direct.id || id === `openai/${direct.id}`) return direct;
			if (id === routed.id || id === `openrouter/${routed.id}`) return routed;
			if (id === wrongApi.id || id === `openai/${wrongApi.id}`) return wrongApi;
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

const HEADERS = { Authorization: "Bearer gw-token", "Content-Type": "application/json" };

describe("auth-gateway POST /v1/embeddings", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await close(harness);
		harness = undefined;
	});

	it("forwards OpenAI float requests and records calculated usage", async () => {
		harness = await boot();
		const observed: Array<{ provider: string; model: string; costUsd?: number; client?: { app?: string } }> = [];
		vi.spyOn(harness.storage, "recordObservedUsage").mockImplementation(entry => observed.push(entry));
		const response = await fetch(`${harness.url}/v1/embeddings`, {
			method: "POST",
			headers: { ...HEADERS, "x-omp-app": "vector-client" },
			body: JSON.stringify({
				model: "openai/text-embedding-3-small",
				input: "hello embeddings",
				encoding_format: "float",
				dimensions: 3,
				user: "test-user",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: [0.125, -0.25, 0.5] }],
			model: "openai/text-embedding-3-small",
			usage: { prompt_tokens: 5, total_tokens: 5 },
		});
		expect(harness.upstream).toEqual([
			{
				url: "https://api.openai.com/v1/embeddings",
				authorization: "Bearer openai-secret",
				body: {
					model: "text-embedding-3-small",
					input: "hello embeddings",
					encoding_format: "float",
					dimensions: 3,
					user: "test-user",
				},
			},
		]);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			provider: "openai",
			model: "text-embedding-3-small",
			costUsd: 0.0000001,
			client: { app: "vector-client" },
		});
	});

	it("passes OpenRouter base64 embeddings and provider-reported cost through", async () => {
		harness = await boot();
		const response = await fetch(`${harness.url}/v1/embeddings`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({
				model: "openrouter/qwen/qwen3-embedding-8b",
				input: [[101, 202, 303]],
				encoding_format: "base64",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: "AACAPwAAAEA=" }],
			model: "openrouter/qwen/qwen3-embedding-8b",
			usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.00000004 },
		});
		expect(harness.upstream).toEqual([
			{
				url: "https://openrouter.ai/api/v1/embeddings",
				authorization: "Bearer openrouter-secret",
				body: {
					model: "qwen/qwen3-embedding-8b",
					input: [[101, 202, 303]],
					encoding_format: "base64",
				},
			},
		]);
	});

	it("rejects unknown and non-embedding models before upstream dispatch", async () => {
		harness = await boot();
		const unknown = await fetch(`${harness.url}/v1/embeddings`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ model: "missing-model", input: "hello" }),
		});
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: { code: 404, type: "invalid_request_error" } });
		const wrongApi = await fetch(`${harness.url}/v1/embeddings`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ model: "openai/gpt-5.5", input: "hello" }),
		});
		expect(wrongApi.status).toBe(400);
		expect(await wrongApi.json()).toMatchObject({ error: { code: 400, type: "invalid_request_error" } });
		expect(harness.upstream).toHaveLength(0);
	});
});
