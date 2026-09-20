import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { searchXAI, XAIProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

function xaiModel(id = "grok-4.5", provider = "xai", baseUrl = "https://api.x.ai/v1"): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
	});
}

const selectedXaiModel = xaiModel();

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

describe("xAI web search provider", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.setRuntimeApiKey("xai", "test-xai-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	function makeParams(
		fetch: FetchImpl,
		model: Model<"openai-responses"> = selectedXaiModel,
		registry: ModelRegistry = modelRegistry,
	) {
		return {
			query: "latest xAI web search",
			systemPrompt: "Use web search for current xAI facts.",
			authStorage: registry.authStorage,
			model,
			modelRegistry: registry,
			fetch,
			sessionId: "session-xai-test",
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	it("POSTs the Responses API with the selected model and xAI web_search tool payload", async () => {
		const capture = captureFetch({ id: "resp_request", model: "grok-selected", output_text: "xAI answer" });
		const model = xaiModel("grok-selected");

		await searchXAI({
			...makeParams(capture.fetchMock, model),
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
			model: "grok-selected",
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

	it("uses credentials for the selected xAI OAuth model provider", async () => {
		const capture = captureFetch({ id: "resp_xai_oauth", model: "grok-4.3", output_text: "xAI OAuth answer" });
		const oauthAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		oauthAuthStorage.setRuntimeApiKey("xai-oauth", "test-xai-oauth-token");
		const oauthRegistry = new ModelRegistry(oauthAuthStorage);
		const oauthModel = xaiModel("grok-oauth-selected", "xai-oauth");

		await searchXAI(makeParams(capture.fetchMock, oauthModel, oauthRegistry));

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.body?.model).toBe("grok-oauth-selected");
		expect(capture.capturedRequest?.headers).toMatchObject({
			Authorization: "Bearer test-xai-oauth-token",
		});
		oauthAuthStorage.close();
	});

	it("uses the selected model endpoint, API key, and headers together", async () => {
		const capture = captureFetch({ id: "resp_proxy", model: "grok-4.3", output_text: "proxy answer" });
		const proxyAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		proxyAuthStorage.setRuntimeApiKey("xai-oauth", "proxy-key");
		const proxyRegistry = new ModelRegistry(proxyAuthStorage);
		const proxyModel = {
			...xaiModel("grok-proxy", "xai-oauth", "https://proxy.example/v1/"),
			headers: { "X-Proxy-Tenant": "tenant-1" },
		};

		await searchXAI(makeParams(capture.fetchMock, proxyModel, proxyRegistry));

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.url).toBe("https://proxy.example/v1/responses");
		expect(capture.capturedRequest?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer proxy-key",
			"X-Proxy-Tenant": "tenant-1",
		});
		proxyAuthStorage.close();
	});

	it("never sends official xAI OAuth credentials to a selected custom endpoint", async () => {
		const capture = captureFetch({ id: "must_not_send", output_text: "unexpected" });
		const oauthAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		oauthAuthStorage.setRuntimeApiKey("xai-oauth", "official-oauth-token");
		vi.spyOn(oauthAuthStorage, "getCredentialOrigin").mockReturnValue({ kind: "oauth" });
		const oauthRegistry = new ModelRegistry(oauthAuthStorage);
		const proxyModel = xaiModel("grok-oauth-proxy", "xai-oauth", "https://proxy.example/v1/");

		try {
			await searchXAI(makeParams(capture.fetchMock, proxyModel, oauthRegistry));
			expect.unreachable("official xAI OAuth credentials should be rejected for a custom endpoint");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toHaveProperty(
				"message",
				'Refusing to send official xAI OAuth credentials to custom endpoint https://proxy.example/v1/. Configure an API key for provider "xai-oauth".',
			);
		}

		expect(capture.capturedRequests).toHaveLength(0);
		oauthAuthStorage.close();
	});

	it("reports availability for the selected model provider", () => {
		const provider = new XAIProvider();
		const oauthAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		oauthAuthStorage.setRuntimeApiKey("xai-oauth", "test-xai-oauth-token");

		expect(provider.isAvailable(oauthAuthStorage, xaiModel("grok-oauth", "xai-oauth"))).toBe(true);
		expect(provider.isAvailable(oauthAuthStorage, selectedXaiModel)).toBe(false);
		oauthAuthStorage.close();
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
							text: "Message-level xAI answer",
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
			answer: "Message-level xAI answer",
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

	it("rotates selected-provider credentials after refresh authentication fails", async () => {
		const authorizationHeaders: string[] = [];
		const wireModels: unknown[] = [];
		let requestCount = 0;
		vi.spyOn(modelRegistry, "getApiKeyForProvider")
			.mockResolvedValueOnce("initial-xai-key")
			.mockResolvedValueOnce("refreshed-xai-key")
			.mockResolvedValueOnce("rotated-xai-key");
		const rotateSpy = vi.spyOn(authStorage, "rotateSessionCredential").mockResolvedValue(true);
		const fetchMock: FetchImpl = (_input, init) => {
			requestCount += 1;
			authorizationHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
			const requestBody: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
			wireModels.push(
				typeof requestBody === "object" && requestBody !== null ? Reflect.get(requestBody, "model") : undefined,
			);
			if (requestCount < 3) {
				return Promise.resolve(new Response("unauthorized", { status: 401 }));
			}
			return Promise.resolve(
				new Response(JSON.stringify({ id: "resp_rotated", output_text: "rotated answer" }), { status: 200 }),
			);
		};

		const response = await searchXAI(makeParams(fetchMock));

		expect(authorizationHeaders).toEqual([
			"Bearer initial-xai-key",
			"Bearer refreshed-xai-key",
			"Bearer rotated-xai-key",
		]);
		expect(wireModels).toEqual(["grok-4.5", "grok-4.5", "grok-4.5"]);
		expect(rotateSpy).toHaveBeenCalledTimes(1);
		expect(response.answer).toBe("rotated answer");
	});

	it("propagates caller aborts to the selected model transport", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		let transportSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = (_input, init) => {
			transportSignal = init?.signal;
			started.resolve();
			const pending = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), { once: true });
			return pending.promise;
		};

		const request = searchXAI({ ...makeParams(fetchMock), signal: controller.signal });
		await started.promise;
		controller.abort(new Error("cancelled selected xAI request"));

		await expect(request).rejects.toThrow("cancelled selected xAI request");
		expect(transportSignal?.aborted).toBe(true);
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

	it("throws a clear missing-key error before fetch when selected-provider credentials are unavailable", async () => {
		let fetchCalled = false;
		const fetchMock: FetchImpl = () => {
			fetchCalled = true;
			return Promise.resolve(new Response("{}", { status: 200 }));
		};
		const emptyAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const emptyRegistry = new ModelRegistry(emptyAuthStorage);

		try {
			await searchXAI(makeParams(fetchMock, selectedXaiModel, emptyRegistry));
			expect.unreachable("missing xAI credentials should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toHaveProperty("message", 'xAI credentials not found for selected provider "xai".');
		}
		expect(fetchCalled).toBe(false);
		emptyAuthStorage.close();
	});
});
