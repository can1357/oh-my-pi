import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { serializeCloudflareAiGatewayCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { GeminiProvider, searchGemini } from "@oh-my-pi/pi-coding-agent/web/search/providers/gemini";

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';
const DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}\n\n';
const ORIGINAL_GEMINI_SEARCH_MODEL = Bun.env.GEMINI_SEARCH_MODEL;
const ORIGINAL_GEMINI_BASE_URL = Bun.env.GOOGLE_GEMINI_BASE_URL;

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	const apiKeyAuthStorage = {
		async getOAuthAccess() {
			return undefined;
		},
		hasOAuth() {
			return false;
		},
		hasAuth(provider: string) {
			return provider === "google";
		},
		async getApiKey(provider: string) {
			return provider === "google" ? "test-gemini-api-key" : undefined;
		},
	} as unknown as AuthStorage;

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
		if (ORIGINAL_GEMINI_SEARCH_MODEL === undefined) {
			delete Bun.env.GEMINI_SEARCH_MODEL;
		} else {
			Bun.env.GEMINI_SEARCH_MODEL = ORIGINAL_GEMINI_SEARCH_MODEL;
		}
		if (ORIGINAL_GEMINI_BASE_URL === undefined) {
			delete Bun.env.GOOGLE_GEMINI_BASE_URL;
		} else {
			Bun.env.GOOGLE_GEMINI_BASE_URL = ORIGINAL_GEMINI_BASE_URL;
		}
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api"),
			authStorage: apiKeyAuthStorage,
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

	it("routes Cloudflare AI Gateway auth through AuthStorage without leaking a Google API key", async () => {
		Bun.env.GOOGLE_GEMINI_BASE_URL = "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio";
		const gatewayAuthStorage = {
			async getOAuthAccess() {
				return undefined;
			},
			hasOAuth() {
				return false;
			},
			hasAuth(provider: string) {
				return provider === "cloudflare-ai-gateway";
			},
			async getApiKey(provider: string) {
				return provider === "cloudflare-ai-gateway"
					? serializeCloudflareAiGatewayCredential("test-cloudflare-key", "account", "gateway")
					: undefined;
			},
		} as unknown as AuthStorage;
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);

		expect(new GeminiProvider().isAvailable(gatewayAuthStorage)).toBe(true);
		await searchGemini({
			...makeParams("gateway"),
			authStorage: gatewayAuthStorage,
			fetch: fetchMock,
		});

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
				...makeParams("redaction"),
				authStorage: apiKeyAuthStorage,
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
			...makeParams("plain query with no operators"),
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body).toMatchObject({
			contents: [{ role: "user", parts: [{ text: "plain query with no operators" }] }],
		});
	});

	it("uses configured developer API model and reports it when modelVersion is absent", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL);
		const response = await searchGemini({
			...makeParams("developer api configured"),
			authStorage: apiKeyAuthStorage,
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		);
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("uses configured OAuth model in the Cloud Code request body", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("oauth configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash",
		});
	});

	it("lets GEMINI_SEARCH_MODEL override the configured Gemini model", async () => {
		Bun.env.GEMINI_SEARCH_MODEL = "gemini-2.5-pro";
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("env configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-pro",
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
			...makeParams("grounding redirect"),
			authStorage: apiKeyAuthStorage,
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
				...makeParams("empty"),
				authStorage: apiKeyAuthStorage,
				fetch: mockGeminiFetch("data: {}\n\n"),
			}),
		).rejects.toThrow("Gemini API returned an empty grounded response");
	});
});
