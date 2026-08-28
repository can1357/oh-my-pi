import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AuthStorage, CredentialOriginKind, FetchImpl } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { searchXAI, XAIProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

type FakeAuthProvider = "xai" | "xai-oauth";
type FakeAuthCredential = string | { key: string; kind: CredentialOriginKind };
type FakeAuthCredentials = Partial<Record<FakeAuthProvider, FakeAuthCredential>>;
type NormalizedFakeAuthCredential = { key: string; kind: CredentialOriginKind };

function makeAuthStorage(credentials: string | FakeAuthCredentials | undefined) {
	const credentialsByProvider: Partial<Record<FakeAuthProvider, NormalizedFakeAuthCredential>> = {};
	if (typeof credentials === "string") {
		credentialsByProvider.xai = { key: credentials, kind: "api_key" };
	} else if (credentials !== undefined) {
		const xaiCredential = credentials.xai;
		if (typeof xaiCredential === "string") {
			credentialsByProvider.xai = { key: xaiCredential, kind: "api_key" };
		} else if (xaiCredential) {
			credentialsByProvider.xai = xaiCredential;
		}
		const xaiOAuthCredential = credentials["xai-oauth"];
		if (typeof xaiOAuthCredential === "string") {
			credentialsByProvider["xai-oauth"] = { key: xaiOAuthCredential, kind: "oauth" };
		} else if (xaiOAuthCredential) {
			credentialsByProvider["xai-oauth"] = xaiOAuthCredential;
		}
	}

	return {
		resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }) {
			expect(options?.sessionId).toBe("session-xai-test");
			const credentialProvider = provider === "xai-oauth" || provider === "xai" ? provider : undefined;
			return async () => {
				if (credentialProvider === undefined) {
					return undefined;
				}
				return credentialsByProvider[credentialProvider]?.key;
			};
		},
		hasAuth(provider: string) {
			if (provider === "xai") {
				return Boolean(credentialsByProvider.xai) || Boolean(Bun.env.XAI_API_KEY);
			}
			if (provider === "xai-oauth") {
				return (
					Boolean(credentialsByProvider["xai-oauth"]) ||
					Boolean(Bun.env.XAI_OAUTH_TOKEN) ||
					Boolean(Bun.env.XAI_API_KEY)
				);
			}
			return false;
		},
		hasNonEnvCredential(provider: string) {
			if (provider === "xai-oauth" || provider === "xai") {
				const credential = credentialsByProvider[provider];
				return Boolean(credential && credential.kind !== "env");
			}
			return false;
		},
		getCredentialOrigin(provider: string) {
			if (provider === "xai-oauth" || provider === "xai") {
				const credential = credentialsByProvider[provider];
				if (credential) return { kind: credential.kind };
				if (provider === "xai-oauth" && (Bun.env.XAI_OAUTH_TOKEN || Bun.env.XAI_API_KEY)) return { kind: "env" };
				if (provider === "xai" && Bun.env.XAI_API_KEY) return { kind: "env" };
			}
			return undefined;
		},
	} as unknown as AuthStorage;
}

function makeParams(fetch: FetchImpl, authStorage: AuthStorage = makeAuthStorage("test-xai-key")) {
	return {
		query: "latest xAI web search",
		systemPrompt: "Use web search for current xAI facts.",
		authStorage,
		fetch,
		sessionId: "session-xai-test",
	} as const;
}

function captureFetch(responseBody: Record<string, unknown> | string, status = 200) {
	const capturedRequests: CapturedRequest[] = [];
	const fetchMock: FetchImpl = (input, init) => {
		capturedRequests.push({
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method,
			headers: init?.headers,
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		});
		return Promise.resolve(
			new Response(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
	return {
		fetchMock,
		capturedRequests,
		get capturedRequest() {
			return capturedRequests.at(-1) ?? null;
		},
	};
}

function citationUrls(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `https://example.com/${prefix}-${index + 1}`);
}

const proxyXaiRegistry = {
	getAll: () => [],
	find: () => undefined,
	getProviderBaseUrl: (provider: string) => (provider === "xai-oauth" ? "https://proxy.example/v1/" : undefined),
	getProviderHeaders: (provider: string) => (provider === "xai-oauth" ? { "X-Proxy-Tenant": "tenant-1" } : undefined),
} as unknown as ModelRegistry;

describe("xAI web search provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setSystemTime();
	});

	it("POSTs the Responses API with bearer auth and xAI web_search tool payload", async () => {
		const capture = captureFetch({ id: "resp_request", model: "grok-4.3", output_text: "xAI answer" });

		await searchXAI({
			...makeParams(capture.fetchMock),
			maxOutputTokens: 512,
			temperature: 0.2,
		});

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.url).toBe("https://api.x.ai/v1/responses");
		expect(capture.capturedRequest?.method).toBe("POST");
		expect(capture.capturedRequest?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer test-xai-key",
		});
		expect(capture.capturedRequest?.body).toMatchObject({
			model: "grok-4.5",
			input: [
				{ role: "system", content: "Use web search for current xAI facts." },
				{ role: "user", content: "latest xAI web search" },
			],
			tools: [{ type: "web_search" }],
			reasoning: { effort: "low" },
			max_output_tokens: 512,
			temperature: 0.2,
		});
		expect(capture.capturedRequest?.body?.tools).toEqual([{ type: "web_search" }]);
		expect(capture.capturedRequest?.body).not.toHaveProperty("search_parameters");
	});

	it("maps site: onto web_search allowed_domains and strips it from the query", async () => {
		const capture = captureFetch({ id: "resp_directives", model: "grok-4.3", output_text: "directive answer" });

		await searchXAI({
			...makeParams(capture.fetchMock),
			query: "grok api site:docs.x.ai after:2025-01-01",
		});

		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } }]);
		// The Responses web_search tool has no from_date/to_date, so the date
		// bound stays in the query text for the agent while site: is stripped.
		const input = body?.input as { role: string; content: string }[];
		expect(input[1]?.content).toBe("grok api after:2025-01-01");
	});

	it("maps -site: onto excluded_domains as bare hosts only when no allow list is present", async () => {
		const capture = captureFetch({ id: "resp_excludes", model: "grok-4.3", output_text: "exclude answer" });

		await searchXAI({
			...makeParams(capture.fetchMock),
			query: "grok changelog -site:reddit.com/r/grok -site:news.ycombinator.com",
		});

		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([
			{ type: "web_search", filters: { excluded_domains: ["reddit.com", "news.ycombinator.com"] } },
		]);
		const input = body?.input as { role: string; content: string }[];
		expect(input[1]?.content).toBe("grok changelog");

		await searchXAI({
			...makeParams(capture.fetchMock),
			query: "grok changelog site:docs.x.ai -site:reddit.com",
		});
		// allowed_domains and excluded_domains are mutually exclusive per
		// request: the allow list wins, exclusions fall to the central filter.
		expect(capture.capturedRequest?.body?.tools).toEqual([
			{ type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } },
		]);
	});

	it("uses dedicated xAI OAuth credentials for Responses API bearer auth", async () => {
		const capture = captureFetch({ id: "resp_xai_oauth", model: "grok-4.3", output_text: "xAI OAuth answer" });

		await searchXAI(
			makeParams(
				capture.fetchMock,
				makeAuthStorage({
					"xai-oauth": "test-xai-oauth-token",
				}),
			),
		);

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer test-xai-oauth-token",
		});
	});

	it("uses configured xai-oauth endpoint, API key, and headers together", async () => {
		const capture = captureFetch({ id: "resp_proxy", model: "grok-4.3", output_text: "proxy answer" });

		await searchXAI({
			...makeParams(
				capture.fetchMock,
				makeAuthStorage({
					"xai-oauth": { key: "proxy-key", kind: "config" },
				}),
			),
			modelRegistry: proxyXaiRegistry,
		});

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.url).toBe("https://proxy.example/v1/responses");
		expect(capture.capturedRequest?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer proxy-key",
			"X-Proxy-Tenant": "tenant-1",
		});
	});

	it("uses a supplied registry's auth storage with its xAI transport", async () => {
		const capture = captureFetch({ id: "resp_registry", model: "grok-4.3", output_text: "registry answer" });
		const authStorage = makeAuthStorage({
			"xai-oauth": { key: "registry-proxy-key", kind: "config" },
		});
		const modelRegistry = {
			...proxyXaiRegistry,
			authStorage,
		} as unknown as ModelRegistry;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(capture.fetchMock, { preconnect: originalFetch.preconnect });
		try {
			const result = await runSearchQuery(
				{ query: "registry search", provider: "xai" },
				{ modelRegistry, sessionId: "session-xai-test" },
			);

			expect(result.details.response.provider).toBe("xai");
			expect(capture.capturedRequest?.url).toBe("https://proxy.example/v1/responses");
			expect(capture.capturedRequest?.headers).toMatchObject({
				Authorization: "Bearer registry-proxy-key",
				"X-Proxy-Tenant": "tenant-1",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("never sends official xAI OAuth credentials to a configured custom endpoint", async () => {
		const capture = captureFetch({ id: "must_not_send", output_text: "unexpected" });

		try {
			await searchXAI({
				...makeParams(
					capture.fetchMock,
					makeAuthStorage({
						"xai-oauth": { key: "official-oauth-token", kind: "oauth" },
					}),
				),
				modelRegistry: proxyXaiRegistry,
			});
			expect.unreachable("official xAI OAuth credentials should be rejected for a custom endpoint");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toHaveProperty(
				"message",
				'Refusing to send official xAI OAuth credentials to custom endpoint https://proxy.example/v1. Configure an API key for provider "xai-oauth".',
			);
		}

		expect(capture.capturedRequests).toHaveLength(0);
	});

	it("prefers dedicated xAI OAuth credentials over xAI API keys", async () => {
		const capture = captureFetch({
			id: "resp_xai_oauth_priority",
			model: "grok-4.3",
			output_text: "xAI OAuth answer",
		});

		await searchXAI(
			makeParams(
				capture.fetchMock,
				makeAuthStorage({
					"xai-oauth": "test-xai-oauth-token",
					xai: "test-xai-api-key",
				}),
			),
		);

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer test-xai-oauth-token",
		});
	});

	it("reports available when only dedicated xAI OAuth credentials exist", () => {
		const provider = new XAIProvider();
		const authStorage = makeAuthStorage({
			"xai-oauth": "test-xai-oauth-token",
		});

		expect(provider.isAvailable(authStorage)).toBe(true);
	});

	it("routes through xai when only XAI_API_KEY is set and an xai credential exists", async () => {
		const capture = captureFetch({
			id: "resp_xai_env_only",
			model: "grok-4.3",
			output_text: "xAI env answer",
		});
		const originalOAuthToken = Bun.env.XAI_OAUTH_TOKEN;
		const originalApiKey = Bun.env.XAI_API_KEY;
		delete Bun.env.XAI_OAUTH_TOKEN;
		Bun.env.XAI_API_KEY = "shared-xai-env-key";
		try {
			await searchXAI(
				makeParams(
					capture.fetchMock,
					makeAuthStorage({ xai: { key: "explicit-xai-runtime-key", kind: "runtime" } }),
				),
			);
		} finally {
			if (originalOAuthToken === undefined) delete Bun.env.XAI_OAUTH_TOKEN;
			else Bun.env.XAI_OAUTH_TOKEN = originalOAuthToken;
			if (originalApiKey === undefined) delete Bun.env.XAI_API_KEY;
			else Bun.env.XAI_API_KEY = originalApiKey;
		}

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer explicit-xai-runtime-key",
		});
	});

	it("skips stored xai-oauth API keys when XAI_API_KEY would shadow them", async () => {
		const capture = captureFetch({
			id: "resp_xai_env_shadow",
			model: "grok-4.3",
			output_text: "xAI explicit account answer",
		});
		const originalOAuthToken = Bun.env.XAI_OAUTH_TOKEN;
		const originalApiKey = Bun.env.XAI_API_KEY;
		delete Bun.env.XAI_OAUTH_TOKEN;
		Bun.env.XAI_API_KEY = "shared-xai-env-key";
		try {
			await searchXAI(
				makeParams(
					capture.fetchMock,
					makeAuthStorage({
						"xai-oauth": { key: "stored-xai-oauth-api-key", kind: "api_key" },
						xai: { key: "explicit-xai-runtime-key", kind: "runtime" },
					}),
				),
			);
		} finally {
			if (originalOAuthToken === undefined) delete Bun.env.XAI_OAUTH_TOKEN;
			else Bun.env.XAI_OAUTH_TOKEN = originalOAuthToken;
			if (originalApiKey === undefined) delete Bun.env.XAI_API_KEY;
			else Bun.env.XAI_API_KEY = originalApiKey;
		}

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer explicit-xai-runtime-key",
		});
	});

	it("falls back to xai when unavailable xai-oauth OAuth resolves to the shared env key", async () => {
		const capture = captureFetch({
			id: "resp_xai_oauth_env_fallback",
			model: "grok-4.3",
			output_text: "xAI explicit account answer",
		});
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }) {
				expect(options?.sessionId).toBe("session-xai-test");
				return async () => {
					if (provider === "xai-oauth") return Bun.env.XAI_API_KEY;
					if (provider === "xai") return "explicit-xai-runtime-key";
					return undefined;
				};
			},
			hasAuth(provider: string) {
				return provider === "xai-oauth" || provider === "xai";
			},
			hasNonEnvCredential(provider: string) {
				return provider === "xai-oauth" || provider === "xai";
			},
			getCredentialOrigin(provider: string) {
				if (provider === "xai-oauth") return { kind: "oauth" };
				if (provider === "xai") return { kind: "runtime" };
				return undefined;
			},
		} as unknown as AuthStorage;
		const originalOAuthToken = Bun.env.XAI_OAUTH_TOKEN;
		const originalApiKey = Bun.env.XAI_API_KEY;
		delete Bun.env.XAI_OAUTH_TOKEN;
		Bun.env.XAI_API_KEY = "shared-xai-env-key";
		try {
			await searchXAI(makeParams(capture.fetchMock, authStorage));
		} finally {
			if (originalOAuthToken === undefined) delete Bun.env.XAI_OAUTH_TOKEN;
			else Bun.env.XAI_OAUTH_TOKEN = originalOAuthToken;
			if (originalApiKey === undefined) delete Bun.env.XAI_API_KEY;
			else Bun.env.XAI_API_KEY = originalApiKey;
		}

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer explicit-xai-runtime-key",
		});
	});

	it("reports xAI available through xai when only XAI_API_KEY is set", () => {
		const provider = new XAIProvider();
		const originalOAuthToken = Bun.env.XAI_OAUTH_TOKEN;
		const originalApiKey = Bun.env.XAI_API_KEY;
		delete Bun.env.XAI_OAUTH_TOKEN;
		Bun.env.XAI_API_KEY = "shared-xai-env-key";
		try {
			expect(provider.isAvailable(makeAuthStorage(undefined))).toBe(true);
		} finally {
			if (originalOAuthToken === undefined) delete Bun.env.XAI_OAUTH_TOKEN;
			else Bun.env.XAI_OAUTH_TOKEN = originalOAuthToken;
			if (originalApiKey === undefined) delete Bun.env.XAI_API_KEY;
			else Bun.env.XAI_API_KEY = originalApiKey;
		}
	});

	it("omits search_parameters for minimal web_search requests", async () => {
		const capture = captureFetch({ id: "resp_minimal", model: "grok-4.3", output_text: "minimal xAI answer" });

		await searchXAI(makeParams(capture.fetchMock));

		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body?.reasoning).toEqual({ effort: "low" });
		expect(body).not.toHaveProperty("search_parameters");
	});

	it.each([
		["limit", { limit: 6 }],
		["numSearchResults", { numSearchResults: 7 }],
		["recency", { recency: "week" }],
		["limit, numSearchResults, and recency", { limit: 0, numSearchResults: 30, recency: "day" }],
		["oversized numSearchResults", { numSearchResults: 99 }],
	] as const)("keeps %s local instead of sending xAI search_parameters", async (_caseName, searchParams) => {
		const capture = captureFetch({ id: "resp_agent_tools", model: "grok-4.3", output_text: "xAI answer" });

		await searchXAI({
			...makeParams(capture.fetchMock),
			...searchParams,
		});

		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("rejects deprecated live-search 410 responses without retrying", async () => {
		const capture = captureFetch("Live search is deprecated. Please use the Agent Tools API.", 410);

		try {
			await searchXAI({
				...makeParams(capture.fetchMock),
				limit: 2,
				numSearchResults: 5,
				recency: "week",
			});
			expect.unreachable("xAI HTTP 410 deprecation failure should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "xai",
				status: 410,
				message: "xAI Responses API error (410): Live search is deprecated. Please use the Agent Tools API.",
			});
		}

		expect(capture.capturedRequests).toHaveLength(1);
		const body = capture.capturedRequests[0]?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("maps output_text, URL citation annotations, top-level citations, id, model, usage, and auth mode", async () => {
		const capture = captureFetch({
			id: "resp_xai_123",
			model: "grok-4.3",
			output_text: "Top-level xAI answer",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/top-annotation",
					title: "Top Annotation",
					text: "Top annotation text",
				},
			],
			output: [
				{
					type: "message",
					annotations: [
						{
							type: "url_citation",
							url: "https://example.com/item-annotation",
							title: "Item Annotation",
							cited_text: "Item annotation text",
						},
					],
					content: [
						{
							type: "output_text",
							text: "Ignored because output_text wins",
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/annotated",
									title: "Annotated Source",
									cited_text: "Annotated cited text",
								},
							],
						},
					],
				},
			],
			citations: ["https://example.com/top-level-citation"],
			usage: {
				input_tokens: 12,
				output_tokens: 8,
				total_tokens: 20,
			},
		});

		const response = await searchXAI(makeParams(capture.fetchMock));

		expect(response).toMatchObject({
			provider: "xai",
			answer: "Top-level xAI answer",
			requestId: "resp_xai_123",
			model: "grok-4.3",
			authMode: "api_key",
			usage: {
				inputTokens: 12,
				outputTokens: 8,
				totalTokens: 20,
			},
			sources: [
				{
					title: "Top Annotation",
					url: "https://example.com/top-annotation",
					snippet: "Top annotation text",
				},
				{
					title: "Item Annotation",
					url: "https://example.com/item-annotation",
					snippet: "Item annotation text",
				},
				{
					title: "Annotated Source",
					url: "https://example.com/annotated",
					snippet: "Annotated cited text",
				},
				{
					title: "https://example.com/top-level-citation",
					url: "https://example.com/top-level-citation",
				},
			],
			citations: [
				{
					title: "Top Annotation",
					url: "https://example.com/top-annotation",
					citedText: "Top annotation text",
				},
				{
					title: "Item Annotation",
					url: "https://example.com/item-annotation",
					citedText: "Item annotation text",
				},
				{
					title: "Annotated Source",
					url: "https://example.com/annotated",
					citedText: "Annotated cited text",
				},
				{
					title: "https://example.com/top-level-citation",
					url: "https://example.com/top-level-citation",
				},
			],
		});
	});

	it("defaults xAI local cap to 10 sources and citations when no count is requested", async () => {
		const urls = citationUrls("default-cap", 12);
		const capture = captureFetch({
			id: "resp_default_cap",
			model: "grok-4.3",
			output_text: "Default capped xAI answer",
			citations: urls,
		});

		const response = await searchXAI(makeParams(capture.fetchMock));
		const expectedUrls = urls.slice(0, 10);

		expect(response.sources).toHaveLength(10);
		expect(response.citations).toHaveLength(10);
		expect(response.sources.map(source => source.url)).toEqual(expectedUrls);
		expect(response.citations?.map(citation => citation.url)).toEqual(expectedUrls);
		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("clamps oversized xAI local cap requests to 30 sources and citations", async () => {
		const urls = citationUrls("max-cap", 35);
		const capture = captureFetch({
			id: "resp_max_cap",
			model: "grok-4.3",
			output_text: "Max capped xAI answer",
			citations: urls,
		});

		const response = await searchXAI({
			...makeParams(capture.fetchMock),
			numSearchResults: 99,
		});
		const expectedUrls = urls.slice(0, 30);

		expect(response.sources).toHaveLength(30);
		expect(response.citations).toHaveLength(30);
		expect(response.sources.map(source => source.url)).toEqual(expectedUrls);
		expect(response.citations?.map(citation => citation.url)).toEqual(expectedUrls);
		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("caps parsed sources and citations locally without changing Agent Tools request shape", async () => {
		const capture = captureFetch({
			id: "resp_local_cap",
			model: "grok-4.3",
			output_text: "Capped xAI answer",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/annotation-1",
					title: "Annotation 1",
					text: "Annotation 1 text",
				},
			],
			output: [
				{
					annotations: [
						{
							type: "url_citation",
							url: "https://example.com/annotation-2",
							title: "Annotation 2",
							cited_text: "Annotation 2 text",
						},
					],
					content: [
						{
							type: "output_text",
							text: "Ignored because output_text wins",
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/annotation-3",
									title: "Annotation 3",
									cited_text: "Annotation 3 text",
								},
							],
						},
					],
				},
			],
			citations: ["https://example.com/top-level-4", "https://example.com/top-level-5"],
		});

		const response = await searchXAI({
			...makeParams(capture.fetchMock),
			limit: 4,
		});

		expect(response.sources).toHaveLength(4);
		expect(response.citations).toHaveLength(4);
		expect(response.sources.map(source => source.url)).toEqual([
			"https://example.com/annotation-1",
			"https://example.com/annotation-2",
			"https://example.com/annotation-3",
			"https://example.com/top-level-4",
		]);
		expect(response.citations?.map(citation => citation.url)).toEqual([
			"https://example.com/annotation-1",
			"https://example.com/annotation-2",
			"https://example.com/annotation-3",
			"https://example.com/top-level-4",
		]);
		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("uses numSearchResults before limit for the local xAI output cap", async () => {
		const capture = captureFetch({
			id: "resp_num_search_results_cap",
			model: "grok-4.3",
			output_text: "numSearchResults capped xAI answer",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/precedence-1",
					title: "Precedence 1",
				},
			],
			citations: [
				"https://example.com/precedence-2",
				"https://example.com/precedence-3",
				"https://example.com/precedence-4",
			],
		});

		const response = await searchXAI({
			...makeParams(capture.fetchMock),
			limit: 1,
			numSearchResults: 3,
		});
		expect(response.sources).toHaveLength(3);
		expect(response.citations).toHaveLength(3);

		expect(response.sources.map(source => source.url)).toEqual([
			"https://example.com/precedence-1",
			"https://example.com/precedence-2",
			"https://example.com/precedence-3",
		]);
		expect(response.citations?.map(citation => citation.url)).toEqual([
			"https://example.com/precedence-1",
			"https://example.com/precedence-2",
			"https://example.com/precedence-3",
		]);
		expect(capture.capturedRequest).not.toBeNull();
		const body = capture.capturedRequest?.body;
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body).not.toHaveProperty("search_parameters");
		expect(Object.keys(body ?? {}).sort()).toEqual(["input", "model", "reasoning", "tools"]);
	});

	it("falls back to output content parts when output_text is absent", async () => {
		const capture = captureFetch({
			id: "resp_content_parts",
			model: "grok-4.3",
			output: [
				{
					content: [
						{ type: "output_text", text: "First content part" },
						{ type: "text", output_text: "Second content part" },
					],
				},
			],
		});

		const response = await searchXAI(makeParams(capture.fetchMock));
		expect(response).toMatchObject({
			answer: "First content part\nSecond content part",
		});
	});

	it("extracts offset snippets and raw sources from web_search_call output", async () => {
		const answer = "Context before [cited source](https://example.com/cited) context after.";
		const start = answer.indexOf("[cited source]");
		const capture = captureFetch({
			id: "resp_raw_sources",
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: answer,
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/cited",
									title: "Cited result",
									start_index: start,
									end_index: start + "[cited source]".length,
								},
							],
						},
					],
				},
				{
					type: "web_search_call",
					action: {
						sources: [
							{ url: "https://example.com/raw", title: "Raw result" },
							{ source_website_url: "https://example.com/fallback", caption: "Fallback result" },
						],
					},
					results: [{ url: "https://example.com/cited", title: "Duplicate result" }],
				},
			],
		});

		const response = await searchXAI(makeParams(capture.fetchMock));

		expect(response.answer).toBe(answer);
		expect(response.sources).toEqual([
			{
				title: "Cited result",
				url: "https://example.com/cited",
				snippet: "Context before cited source context after.",
			},
			{ title: "Raw result", url: "https://example.com/raw", snippet: undefined },
			{ title: "Fallback result", url: "https://example.com/fallback", snippet: undefined },
		]);
	});

	it("rejects successful responses with no answer or sources", async () => {
		const capture = captureFetch({ id: "resp_empty", output: [] });

		await expect(searchXAI(makeParams(capture.fetchMock))).rejects.toMatchObject({
			provider: "xai",
			status: 502,
			message: "xAI web_search returned no answer or sources",
		});
	});

	it.each([
		[401, "xai: 401 unauthorized"],
		[402, "xai: 402 credits exhausted"],
	] as const)("maps HTTP %s failures to SearchProviderError", async (status, message) => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "request failed" }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);

		try {
			await searchXAI(makeParams(fetchMock));
			expect.unreachable(`xAI HTTP ${status} failure should reject`);
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "xai",
				status,
				message,
			});
		}
	});

	it("throws a clear missing-key error before fetch when credentials are unavailable", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as FetchImpl;

		try {
			await searchXAI(makeParams(fetchMock, makeAuthStorage({})));
			expect.unreachable("missing xAI credentials should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toHaveProperty(
				"message",
				'xAI credentials not found. Set XAI_API_KEY or configure an API key for provider "xai".',
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
