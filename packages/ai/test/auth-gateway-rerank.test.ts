import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { rerankOpenRouter } from "@oh-my-pi/pi-ai/rerank";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface UpstreamRequest {
	url: string;
	headers: Headers;
	body: object;
}

interface Harness {
	url: string;
	storage: AuthStorage;
	upstream: UpstreamRequest[];
	handle: AuthGatewayServerHandle;
	dir: string;
}

function rerankModel(
	provider: string,
	id: string,
	api: Api = "openrouter-rerank",
	headers?: Record<string, string>,
): Model<Api> {
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
		...(headers && { headers }),
	} satisfies ModelSpec<Api>);
}

function rerankAnswer(): Response {
	return Response.json({
		model: "cohere/rerank-v3.5",
		results: [
			{ index: 1, relevance_score: 0.98, document: { text: "Berlin is in Germany." } },
			{ index: 0, relevance_score: 0.41, document: { text: "Paris is in France." } },
		],
		usage: { search_units: 1, total_tokens: 17, cost: 0.004 },
	});
}

async function boot(modelHeaders?: Record<string, string>): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-rerank-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "openrouter-secret");
	const model = rerankModel("openrouter", "cohere/rerank-v3.5", "openrouter-rerank", modelHeaders);
	const wrongApi = rerankModel("openrouter", "not-rerank-wire", "openrouter");
	const upstream: UpstreamRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const body: unknown = JSON.parse(String(init?.body));
		if (body === null || typeof body !== "object") throw new Error("Expected upstream JSON object");
		upstream.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		return rerankAnswer();
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
		expect(harness.upstream.map(request => request.url)).toEqual(["https://openrouter.ai/api/v1/rerank"]);
		expect(harness.upstream[0]?.headers.get("authorization")).toBe("Bearer openrouter-secret");
		expect(harness.upstream[0]?.body).toEqual({
			model: "cohere/rerank-v3.5",
			query: "European capitals",
			documents: ["Paris is in France.", "Berlin is in Germany."],
			top_n: 2,
			return_documents: true,
		});
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			provider: "openrouter",
			model: "cohere/rerank-v3.5",
			costUsd: 0.004,
			client: { app: "search-client" },
		});
	});

	it("sends the model's configured headers upstream, and a configured Authorization replaces the bearer", async () => {
		harness = await boot({ "X-Tenant": "t1", authorization: "Token custom-secret" });
		const response = await fetch(`${harness.url}/v1/rerank`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ model: "cohere/rerank-v3.5", query: "q", documents: ["d"] }),
		});
		expect(response.status).toBe(200);
		expect(harness.upstream[0]?.headers.get("x-tenant")).toBe("t1");
		expect(harness.upstream[0]?.headers.get("authorization")).toBe("Token custom-secret");
	});

	it("never sends a keyless provider's sentinel as a bearer", async () => {
		const sent: Array<string | null> = [];
		const fetchImpl: FetchImpl = async (_input, init) => {
			sent.push(new Headers(init?.headers).get("authorization"));
			return rerankAnswer();
		};
		const request = { query: "q", documents: ["d"] };
		const keyless = rerankModel("local-rerank", "cohere/rerank-v3.5");
		const customAuth = rerankModel("local-rerank", "cohere/rerank-v3.5", "openrouter-rerank", {
			authorization: "Token custom-secret",
		});
		await rerankOpenRouter(keyless, request, { apiKey: "N/A", fetch: fetchImpl });
		await rerankOpenRouter(customAuth, request, { apiKey: "N/A", fetch: fetchImpl });
		expect(sent).toEqual([null, "Token custom-secret"]);
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

describe("rerankOpenRouter", () => {
	it("reports the requested model when the answer carries no model field", async () => {
		const fetchImpl: FetchImpl = async () =>
			Response.json({
				id: "rerank-1",
				results: [{ index: 1, relevance_score: 0.9 }],
				meta: { billed_units: { search_units: 1 } },
			});
		const model = rerankModel("cohere", "rerank-v3.5");
		const result = await rerankOpenRouter(
			model,
			{ query: "q", documents: ["a", "b"] },
			{ apiKey: "key", fetch: fetchImpl },
		);
		expect(result.model).toBe("rerank-v3.5");
		expect(result.results).toEqual([{ index: 1, relevanceScore: 0.9 }]);
	});
});
