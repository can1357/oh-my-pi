import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";

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

async function boot(trustProxyHeaders = false): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-embeddings-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openai", "openai-secret");
	storage.keys.setRuntime("openrouter", "openrouter-secret");
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
		trustProxyHeaders,
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
		vi.restoreAllMocks();
		await close(harness);
		harness = undefined;
	});

	it("forwards OpenAI float requests and records calculated usage", async () => {
		harness = await boot();
		const observed: Array<{ provider: string; model: string; costUsd?: number; client?: { app?: string } }> = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));
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

	it("confines the gateway bearer after authorization and before provider dispatch", async () => {
		harness = await boot();
		const credentialLookup = vi.spyOn(harness.storage.keys, "get");
		const request = (url: string, headers: Record<string, string>) =>
			fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
			});

		const inHeader = await request(`${harness.url}/v1/embeddings`, {
			...HEADERS,
			"openai-organization": "org-gw-token",
		});
		const inStainlessHeader = await request(`${harness.url}/v1/embeddings`, {
			...HEADERS,
			"x-stainless-custom": "gw-token",
		});
		const inIdentityHeader = await request(`${harness.url}/v1/embeddings`, {
			...HEADERS,
			"x-omp-install-id": "gw-token",
		});
		const inForwardedHeader = await request(`${harness.url}/v1/embeddings`, {
			...HEADERS,
			forwarded: "for=gw-token",
		});
		const inQuery = await request(`${harness.url}/v1/embeddings?client=gw-token`, HEADERS);
		const encodedQuery = await request(`${harness.url}/v1/embeddings?client=gw%2Dtoken`, HEADERS);
		const encodedQueryWithMalformedEscape = await request(
			`${harness.url}/v1/embeddings?client=gw%2Dtoken&junk=%zz`,
			HEADERS,
		);
		const inPath = await request(`${harness.url}/v1/gw-token`, HEADERS);
		const encodedPathWithMalformedEscape = await request(`${harness.url}/v1/videos/gw%2Dtoken%zz`, HEADERS);
		for (const response of [
			inHeader,
			inStainlessHeader,
			inIdentityHeader,
			inForwardedHeader,
			inQuery,
			encodedQuery,
			encodedQueryWithMalformedEscape,
			inPath,
			encodedPathWithMalformedEscape,
		]) {
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("gw-token");
		}
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);

		const allowed = await request(`${harness.url}/v1/embeddings`, { ...HEADERS, "user-agent": "gw-token" });
		expect(allowed.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
	});

	it("logs unauthorized requests without leaked credentials or untrusted paths", async () => {
		harness = await boot();
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.message === "auth-gateway request unauthorized") events.push(event);
		});
		try {
			for (const url of [`${harness.url}/v1/gw-token?client=gw-token`, `${harness.url}/v1/models?client=gw-token`]) {
				const response = await fetch(url, {
					headers: { Authorization: "Bearer wrong", "x-forwarded-for": "gw-token", "x-real-ip": "gw-token" },
				});
				expect(response.status).toBe(401);
			}
			expect(events).toHaveLength(2);
			expect(events[0]?.context?.path).toBe("<unrouted>");
			expect(events[1]?.context?.path).toBe("/v1/models");
			for (const event of events) {
				expect(event.context?.peer).toBe("127.0.0.1");
				expect(JSON.stringify(event)).not.toContain("gw-token");
			}
			expect(harness.upstream).toHaveLength(0);
		} finally {
			dispose();
		}
	});

	it("uses proxy peer headers for authenticated requests only with explicit trust", async () => {
		harness = await boot(true);
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.message === "auth-gateway request" || event.message === "auth-gateway request unauthorized")
				events.push(event);
		});
		try {
			const unauthorized = await fetch(`${harness.url}/v1/models`, {
				headers: { Authorization: "Bearer wrong", "x-forwarded-for": "203.0.113.42, 10.0.0.1" },
			});
			expect(unauthorized.status).toBe(401);
			expect(events.at(-1)?.context?.peer).toBe("127.0.0.1");
			const authorized = await fetch(`${harness.url}/v1/embeddings`, {
				method: "POST",
				headers: { ...HEADERS, "x-forwarded-for": "203.0.113.42, 10.0.0.1" },
				body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
			});
			expect(authorized.status).toBe(200);
			expect(events.at(-1)?.context?.peer).toBe("203.0.113.42");
		} finally {
			dispose();
		}
	});
});
