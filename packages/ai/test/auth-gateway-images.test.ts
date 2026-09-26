import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { generateImage } from "@oh-my-pi/pi-ai/images";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const IMAGE_DATA = Buffer.from("gateway-image").toString("base64");

function imageModel(provider: string, id: string, api: Api): Model<Api> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		provider,
		api,
		kind: "image",
		baseUrl: `https://${provider}.example/v1`,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	});
}

async function withGateway(
	models: Model<Api>[],
	fetchImpl: FetchImpl,
	test: (url: string, storage: AuthStorage) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-images-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	for (const model of models) storage.keys.setRuntime(model.provider, `key-${model.provider}`);
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gateway-token"],
		storage,
		resolveModel: requested =>
			models.find(model => requested === model.id || requested === `${model.provider}/${model.id}`),
		version: "test",
		fetch: fetchImpl,
	});
	try {
		await test(handle.url, storage);
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function gatewayRequest(
	url: string,
	pathName: string,
	body: unknown,
	headers?: Record<string, string>,
): Promise<Response> {
	return fetch(`${url}${pathName}`, {
		method: "POST",
		headers: {
			Authorization: "Bearer gateway-token",
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

describe("auth gateway images", () => {
	it("translates OpenAI generations and returns the OpenAI image wire response", async () => {
		const model = imageModel("openai", "gpt-image-test", "openai-images");
		let upstream: { url: string; authorization: string | null; body: unknown } | undefined;
		const fetchStub: FetchImpl = async (input, init) => {
			upstream = {
				url: input.toString(),
				authorization: new Headers(init?.headers).get("authorization"),
				body: JSON.parse(String(init?.body)) as unknown,
			};
			return new Response(
				JSON.stringify({
					created: 1,
					data: [{ b64_json: IMAGE_DATA }],
					usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		await withGateway([model], fetchStub, async url => {
			const response = await gatewayRequest(url, "/v1/images/generations", {
				model: "openai/gpt-image-test",
				prompt: "paint a lighthouse",
				n: 2,
				size: "1536x1024",
				response_format: "b64_json",
			});
			expect(response.status).toBe(200);
			expect(upstream).toEqual({
				url: "https://openai.example/v1/images/generations",
				authorization: "Bearer key-openai",
				body: {
					model: "gpt-image-test",
					prompt: "paint a lighthouse",
					n: 2,
					response_format: "b64_json",
					size: "1536x1024",
				},
			});
			const body = (await response.json()) as {
				data: Array<{ b64_json: string }>;
				usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number };
			};
			expect(body.data).toEqual([{ b64_json: IMAGE_DATA }]);
			expect(body.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
		});
	});

	it("serves minimax-images models and forwards the native envelope upstream", async () => {
		const model = imageModel("minimax", "image-01", "minimax-images");
		let upstream: { url: string; body: Record<string, unknown> } | undefined;
		const fetchStub: FetchImpl = async (input, init) => {
			upstream = {
				url: input.toString(),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			return new Response(JSON.stringify({ data: { image_base64: [IMAGE_DATA] } }), {
				headers: { "content-type": "application/json" },
			});
		};
		await withGateway([model], fetchStub, async url => {
			const response = await gatewayRequest(url, "/v1/images/generations", {
				model: "minimax/image-01",
				prompt: "paint a lighthouse",
				n: 1,
			});
			expect(response.status).toBe(200);
			expect(upstream).toEqual({
				url: "https://minimax.example/v1/image_generation",
				body: {
					model: "image-01",
					prompt: "paint a lighthouse",
					n: 1,
					response_format: "base64",
					aspect_ratio: "1:1",
				},
			});
			const body = (await response.json()) as { data: Array<{ b64_json: string }> };
			expect(body.data).toEqual([{ b64_json: IMAGE_DATA }]);
		});
	});

	it("accepts OpenAI multipart edits and forwards a multipart edit upstream", async () => {
		const model = imageModel("openai", "gpt-image-edit", "openai-images");
		let upstream:
			| {
					url: string;
					authorization: string | null;
					contentType: string | null;
					prompt?: string | File | null;
					image?: string | File | null;
			  }
			| undefined;
		const fetchStub: FetchImpl = async (input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart upstream body");
			upstream = {
				url: input.toString(),
				authorization: new Headers(init.headers).get("authorization"),
				contentType: new Headers(init.headers).get("content-type"),
				prompt: init.body.get("prompt"),
				image: init.body.get("image"),
			};
			return new Response(JSON.stringify({ data: [{ b64_json: IMAGE_DATA }] }), {
				headers: { "content-type": "application/json" },
			});
		};
		await withGateway([model], fetchStub, async url => {
			const form = new FormData();
			form.set("model", "gpt-image-edit");
			form.set("prompt", "replace the sky");
			form.set("size", "1024x1024");
			form.set("n", "1");
			form.set("image", new File([new TextEncoder().encode("source-image")], "source.png", { type: "image/png" }));
			const response = await fetch(`${url}/v1/images/edits`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token" },
				body: form,
			});
			expect(response.status).toBe(200);
			expect(upstream?.url).toBe("https://openai.example/v1/images/edits");
			expect(upstream?.authorization).toBe("Bearer key-openai");
			expect(upstream?.contentType).toBeNull();
			expect(upstream?.prompt).toBe("replace the sky");
			const upstreamImage = upstream?.image;
			expect(upstreamImage).toBeInstanceOf(File);
			if (!(upstreamImage instanceof File)) throw new Error("Expected an upstream image file");
			expect(upstreamImage.type).toBe("image/png");
		});
	});

	it("translates OpenRouter fields and attributes observed usage to the caller", async () => {
		const model = imageModel("openrouter", "router-image-test", "openrouter-images");
		let upstream: { url: string; authorization: string | null; body: unknown } | undefined;
		const fetchStub: FetchImpl = async (input, init) => {
			upstream = {
				url: input.toString(),
				authorization: new Headers(init?.headers).get("authorization"),
				body: JSON.parse(String(init?.body)) as unknown,
			};
			return new Response(
				JSON.stringify({
					created: 1,
					data: [{ b64_json: IMAGE_DATA, media_type: "image/webp" }],
					usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, cost: 0.42 },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		await withGateway([model], fetchStub, async (url, storage) => {
			const recorded: Parameters<AuthStorage["usage"]["observe"]>[0][] = [];
			vi.spyOn(storage.usage, "observe").mockImplementation(entry => recorded.push(entry));
			const response = await gatewayRequest(
				url,
				"/v1/images",
				{
					model: "router-image-test",
					prompt: "paint a forest",
					n: 1,
					aspect_ratio: "16:9",
					image_size: "1536x1024",
					response_format: "b64_json",
				},
				{
					"x-omp-install-id": "image-client",
					"x-omp-hostname": "render-box",
					"x-omp-app": "image-suite",
				},
			);
			expect(response.status).toBe(200);
			expect(upstream).toEqual({
				url: "https://openrouter.example/v1/images",
				authorization: "Bearer key-openrouter",
				body: {
					model: "router-image-test",
					prompt: "paint a forest",
					n: 1,
					response_format: "b64_json",
					aspect_ratio: "16:9",
					image_size: "1536x1024",
				},
			});
			await response.json();
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toMatchObject({
				provider: "openrouter",
				model: "router-image-test",
				usage: { input: 5, output: 9, cacheRead: 0, cacheWrite: 0 },
				costUsd: 0.42,
				client: { installId: "image-client", hostname: "render-box", app: "image-suite" },
			});
		});
	});

	it("rejects URL responses before dispatch and reports unknown models", async () => {
		const model = imageModel("openai", "gpt-image-test", "openai-images");
		let upstreamCalls = 0;
		const fetchStub: FetchImpl = async () => {
			upstreamCalls++;
			throw new Error("unexpected upstream call");
		};
		await withGateway([model], fetchStub, async url => {
			const unsupported = await gatewayRequest(url, "/v1/images/generations", {
				model: "gpt-image-test",
				prompt: "paint",
				response_format: "url",
			});
			expect(unsupported.status).toBe(400);
			expect(await unsupported.json()).toMatchObject({
				error: { code: 400, type: "invalid_request_error" },
			});

			const missing = await gatewayRequest(url, "/v1/images/generations", {
				model: "missing-image-model",
				prompt: "paint",
				response_format: "b64_json",
			});
			expect(missing.status).toBe(404);
			expect(await missing.json()).toEqual({
				error: {
					code: 404,
					type: "invalid_request_error",
					message: "Unknown model: missing-image-model",
				},
			});
			expect(upstreamCalls).toBe(0);
		});
	});

	it("downloads URL image responses into canonical inline bytes", async () => {
		const model = imageModel("openai", "url-image-test", "openai-images");
		const bytes = new TextEncoder().encode("downloaded-image");
		const fetchStub: FetchImpl = async input => {
			if (input.toString() === "https://cdn.example/result.webp") {
				return new Response(bytes, { headers: { "content-type": "image/webp" } });
			}
			return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/result.webp" }] }), {
				headers: { "content-type": "application/json" },
			});
		};
		const result = await generateImage(model, { prompt: "paint" }, { apiKey: "test-key", fetch: fetchStub });
		expect(result.images).toEqual([{ data: bytes.toBase64(), mimeType: "image/webp" }]);
	});
});
