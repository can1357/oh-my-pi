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
	body: object;
}

interface Harness {
	url: string;
	storage: AuthStorage;
	upstream: UpstreamRequest[];
	handle: AuthGatewayServerHandle;
	dir: string;
}

function rerankModel(provider: string, id: string, api: Api = "openrouter-rerank"): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: null,
		kind: "rerank",
	} satisfies ModelSpec<Api>);
}

async function boot(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-rerank-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "openrouter-secret");
	const model = rerankModel("openrouter", "cohere/rerank-v3.5");
	const wrongApi = rerankModel("openrouter", "not-rerank-wire", "openrouter");
	const upstream: UpstreamRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const body: unknown = JSON.parse(String(init?.body));
		if (body === null || typeof body !== "object") throw new Error("Expected upstream JSON object");
		upstream.push({
			url: String(input),
			authorization: new Headers(init?.headers).get("authorization"),
			body,
		});
		return Response.json({
			model: "cohere/rerank-v3.5",
			results: [
				{ index: 1, relevance_score: 0.98, document: { text: "Berlin is in Germany." } },
				{ index: 0, relevance_score: 0.41, document: { text: "Paris is in France." } },
			],
			usage: { search_units: 1, total_tokens: 17, cost: 0.004 },
		});
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => {
			if (id === model.id || id === `openrouter/${model.id}`) return model;
			if (id === wrongApi.id || id === `openrouter/${wrongApi.id}`) return wrongApi;
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

function headers(): Record<string, string> {
	return { Authorization: "Bearer gw-token", "Content-Type": "application/json", "x-omp-app": "search-client" };
}

describe("auth-gateway POST /v1/rerank", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await close(harness);
		harness = undefined;
	});

	it("normalizes documents, passes top_n, echoes requested documents, and records usage", async () => {
		harness = await boot();
		const observed: Array<{ provider: string; model: string; costUsd?: number; client?: { app?: string } }> = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));
		const response = await fetch(`${harness.url}/v1/rerank`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				model: "openrouter/cohere/rerank-v3.5",
				query: "European capitals",
				documents: ["Paris is in France.", { text: "Berlin is in Germany." }],
				top_n: 2,
				return_documents: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			model: "openrouter/cohere/rerank-v3.5",
			results: [
				{ index: 1, relevance_score: 0.98, document: { text: "Berlin is in Germany." } },
				{ index: 0, relevance_score: 0.41, document: { text: "Paris is in France." } },
			],
			usage: { total_tokens: 17, cost: 0.004 },
		});
		expect(harness.upstream).toEqual([
			{
				url: "https://openrouter.ai/api/v1/rerank",
				authorization: "Bearer openrouter-secret",
				body: {
					model: "cohere/rerank-v3.5",
					query: "European capitals",
					documents: ["Paris is in France.", "Berlin is in Germany."],
					top_n: 2,
					return_documents: true,
				},
			},
		]);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			provider: "openrouter",
			model: "cohere/rerank-v3.5",
			costUsd: 0.004,
			client: { app: "search-client" },
		});
	});

	it("omits returned documents when return_documents is false", async () => {
		harness = await boot();
		const response = await fetch(`${harness.url}/v1/rerank`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				model: "cohere/rerank-v3.5",
				query: "European capitals",
				documents: ["Paris is in France.", "Berlin is in Germany."],
				return_documents: false,
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			model: "cohere/rerank-v3.5",
			results: [
				{ index: 1, relevance_score: 0.98 },
				{ index: 0, relevance_score: 0.41 },
			],
			usage: { total_tokens: 17, cost: 0.004 },
		});
		expect(harness.upstream[0]?.body).toMatchObject({ return_documents: false });
	});

	it("rejects unknown models and models on the wrong API before dispatch", async () => {
		harness = await boot();
		const request = (model: string) =>
			fetch(`${harness?.url}/v1/rerank`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ model, query: "q", documents: ["d"] }),
			});
		const unknown = await request("missing-model");
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: { code: 404, type: "invalid_request_error" } });
		const wrongApi = await request("not-rerank-wire");
		expect(wrongApi.status).toBe(400);
		expect(await wrongApi.json()).toMatchObject({ error: { code: 400, type: "invalid_request_error" } });
		expect(harness.upstream).toHaveLength(0);
	});

	it("rejects request bodies larger than 8 MiB", async () => {
		harness = await boot();
		const response = await fetch(`${harness.url}/v1/rerank`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ model: "cohere/rerank-v3.5", query: "q", documents: ["x".repeat(8 * 1024 * 1024)] }),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error: { code: 413, type: "invalid_request_error" } });
		expect(harness.upstream).toHaveLength(0);
	});
});
