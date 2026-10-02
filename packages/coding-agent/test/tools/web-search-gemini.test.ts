import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { serializeCloudflareAiGatewayCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { GeminiProvider, searchGemini } from "@oh-my-pi/pi-coding-agent/web/search/providers/gemini";

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';
const DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}\n\n';
function geminiDeveloperModel(
	id: string,
	provider = "google",
	baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): Model<"google-generative-ai"> {
	return buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function geminiOAuthModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

const developerModel = geminiDeveloperModel("gemini-2.5-flash");
const oauthModel = geminiOAuthModel("gemini-2.5-flash");

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	let oauthAuthStorage: AuthStorage;
	let apiKeyAuthStorage: AuthStorage;
	let oauthRegistry: ModelRegistry;
	let apiKeyRegistry: ModelRegistry;

	beforeEach(() => {
		oauthAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		vi.spyOn(oauthAuthStorage.oauth, "access").mockResolvedValue({
			accessToken: "test-access-token",
			projectId: "test-project",
		});
		vi.spyOn(oauthAuthStorage.credentials, "hasOAuth").mockReturnValue(true);
		apiKeyAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		apiKeyAuthStorage.keys.setRuntime("google", "test-gemini-api-key");
		oauthRegistry = new ModelRegistry(oauthAuthStorage);
		apiKeyRegistry = new ModelRegistry(apiKeyAuthStorage);
	});

	function mockGeminiFetch(responseText = SSE_RESPONSE): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			const headers = new Headers(init?.headers);
			capturedRequest = {
				url: String(url),
				headers: Object.fromEntries(headers.entries()),
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseText, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		capturedRequest = null;
		vi.restoreAllMocks();
		oauthAuthStorage.close();
		apiKeyAuthStorage.close();
	});

	function makeParams(query: string, model: Model = oauthModel, modelRegistry = oauthRegistry) {
		return {
			query,
			authStorage: modelRegistry.authStorage,
			model,
			modelRegistry,
			system_prompt: "Gemini test prompt",
		};
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage, developerModel)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api", developerModel, apiKeyRegistry),
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["x-goog-api-key"]).toBe("test-gemini-api-key");
		expect(capturedRequest?.body).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(response).toMatchObject({
			answer: "Developer answer",
			sources: [{ title: "Bun", url: "https://bun.sh" }],
			searchQueries: ["latest Bun version"],
			usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
		});
	});

	it("rotates credentials for the selected developer model without changing its wire id", async () => {
		const authorizationHeaders: string[] = [];
		const requestUrls: string[] = [];
		let requestCount = 0;
		vi.spyOn(apiKeyRegistry, "getApiKeyWithCredentialForProvider")
			.mockResolvedValueOnce({ apiKey: "initial-gemini-key" })
			.mockResolvedValueOnce({ apiKey: "refreshed-gemini-key" })
			.mockResolvedValueOnce({ apiKey: "rotated-gemini-key" });
		const rotateSpy = vi.spyOn(apiKeyAuthStorage.limits, "rotate").mockResolvedValue({ switched: true });
		const fetchMock: FetchImpl = (url, init) => {
			requestCount += 1;
			requestUrls.push(String(url));
			authorizationHeaders.push(new Headers(init?.headers).get("x-goog-api-key") ?? "");
			if (requestCount < 3) return Promise.resolve(new Response("unauthorized", { status: 401 }));
			return Promise.resolve(
				new Response(DEVELOPER_SSE_RESPONSE, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
		const selectedModel = geminiDeveloperModel("gemini-selected");

		const response = await searchGemini({
			...makeParams("credential rotation", selectedModel, apiKeyRegistry),
			fetch: fetchMock,
		});

		expect(authorizationHeaders).toEqual(["initial-gemini-key", "refreshed-gemini-key", "rotated-gemini-key"]);
		expect(requestUrls).toEqual([
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-selected:streamGenerateContent?alt=sse",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-selected:streamGenerateContent?alt=sse",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-selected:streamGenerateContent?alt=sse",
		]);
		expect(rotateSpy).toHaveBeenCalledTimes(1);
		expect(response.answer).toBe("Developer answer");
	});

	it("routes Cloudflare AI Gateway auth through AuthStorage without leaking a Google API key", async () => {
		const gatewayAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		gatewayAuthStorage.keys.setRuntime(
			"cloudflare-ai-gateway",
			serializeCloudflareAiGatewayCredential("test-cloudflare-key", "account", "gateway"),
		);
		const gatewayRegistry = new ModelRegistry(gatewayAuthStorage);
		const gatewayModel = geminiDeveloperModel(
			"gemini-2.5-flash",
			"cloudflare-ai-gateway",
			"https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta",
		);
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);

		expect(new GeminiProvider().isAvailable(gatewayAuthStorage, gatewayModel)).toBe(true);
		await searchGemini({
			...makeParams("gateway", gatewayModel, gatewayRegistry),
			fetch: fetchMock,
		});
		gatewayAuthStorage.close();

		expect(capturedRequest?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["cf-aig-authorization"]).toBe("Bearer test-cloudflare-key");
		expect(capturedRequest?.headers["x-goog-api-key"]).toBeUndefined();
	});

	it("redacts the active credential from Gemini API errors", async () => {
		let thrown: unknown;
		try {
			await searchGemini({
				...makeParams("redaction", developerModel, apiKeyRegistry),
				fetch: () =>
					Promise.resolve(
						new Response("upstream echoed test-gemini-api-key", {
							status: 418,
						}),
					),
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("[redacted]");
		expect((thrown as Error).message).not.toContain("test-gemini-api-key");
	});

	it("normalizes query directive aliases to canonical Google forms in the grounding request", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("k8s domain:kubernetes.io since:2024"),
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		const request = capturedRequest?.body?.request as Record<string, unknown>;
		expect(request).toMatchObject({
			contents: [{ role: "user", parts: [{ text: "k8s site:kubernetes.io after:2024-01-01" }] }],
		});
	});

	it("leaves directive-free queries untouched in the developer API request", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		await searchGemini({
			...makeParams("plain query with no operators", developerModel, apiKeyRegistry),
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body).toMatchObject({
			contents: [{ role: "user", parts: [{ text: "plain query with no operators" }] }],
		});
	});

	it("uses the selected developer API model and reports it when modelVersion is absent", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL);
		const selectedModel = geminiDeveloperModel("gemini-3.5-flash");
		const response = await searchGemini({
			...makeParams("developer api configured", selectedModel, apiKeyRegistry),
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		);
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("uses the selected OAuth model in the Cloud Code request body", async () => {
		const fetchMock = mockGeminiFetch();
		const selectedModel = geminiOAuthModel("gemini-3.5-flash");
		await searchGemini({
			...makeParams("oauth configured", selectedModel),
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash",
		});
	});

	it("uses the collapsed OAuth model's default wire id", async () => {
		const fetchMock = mockGeminiFetch();
		const selectedModel = getBundledModel("google-antigravity", "gemini-3.8-flash");
		await searchGemini({
			...makeParams("collapsed OAuth model", selectedModel),
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.8-flash-low",
		});
	});

	it("routes an explicit thinking level to the matching OAuth wire id", async () => {
		const fetchMock = mockGeminiFetch();
		const selectedModel = getBundledModel("google-antigravity", "gemini-3.8-flash");
		await searchGemini({
			...makeParams("collapsed OAuth model", selectedModel),
			thinkingLevel: ThinkingLevel.High,
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.8-flash-high",
		});
	});

	it("clamps an unsupported thinking level onto the nearest routed wire id", async () => {
		const fetchMock = mockGeminiFetch();
		const selectedModel = getBundledModel("google-antigravity", "gemini-3.8-flash");
		await searchGemini({
			...makeParams("collapsed OAuth model", selectedModel),
			thinkingLevel: ThinkingLevel.XHigh,
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.8-flash-high",
		});
	});

	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-flash",
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});

	it("resolves Google grounding proxy URLs in both sources and citations", async () => {
		const proxyUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
		const responseText = `data: ${JSON.stringify({
			candidates: [
				{
					content: { role: "model", parts: [{ text: "Grounded answer" }] },
					groundingMetadata: {
						groundingChunks: [{ web: { uri: proxyUrl, title: "Example" } }],
						groundingSupports: [{ segment: { text: "Grounded answer" }, groundingChunkIndices: [0] }],
					},
				},
			],
		})}\n\n`;
		const methods: string[] = [];
		const fetchMock: FetchImpl = (_url, init) => {
			methods.push(init?.method ?? "GET");
			if (init?.method === "HEAD") {
				return Promise.resolve(
					new Response(null, {
						status: 302,
						headers: { location: "https://example.com/article" },
					}),
				);
			}
			return Promise.resolve(new Response(responseText, { status: 200 }));
		};

		const response = await searchGemini({
			...makeParams("grounding redirect", developerModel, apiKeyRegistry),
			fetch: fetchMock,
		});

		expect(methods).toEqual(["POST", "HEAD"]);
		expect(response.sources).toEqual([{ title: "Example", url: "https://example.com/article" }]);
		expect(response.citations).toEqual([
			{ title: "Example", url: "https://example.com/article", citedText: "Grounded answer" },
		]);
	});

	it("rejects a successful Gemini response with no answer or grounding results", async () => {
		await expect(
			searchGemini({
				...makeParams("empty", developerModel, apiKeyRegistry),
				fetch: mockGeminiFetch("data: {}\n\n"),
			}),
		).rejects.toThrow("Gemini API returned an empty grounded response");
	});
});
