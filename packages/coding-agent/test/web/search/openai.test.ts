import { describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getGroundedSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchOpenAIResponses } from "@oh-my-pi/pi-coding-agent/web/search/providers/openai";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const API_KEY = "selected-openai-api-key";

interface OpenAITestFixture {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model<Api>;
}

interface OpenAITestModelOptions {
	provider?: string;
	requestModelId?: string;
	reasoningMode?: "pro";
	compat?: { supportsNamedToolChoice: boolean };
}

function createFixture(modelOptions: OpenAITestModelOptions = {}) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(modelOptions.provider ?? "openai", API_KEY);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const model = buildModel({
		id: "gpt-5.6-luna",
		name: "Selected OpenAI API model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://openai-grounding.example.test/v1/",
		headers: { "X-Selected-Route": "catalog-model" },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...modelOptions,
	});
	return { authStorage, modelRegistry, model };
}

function makeParams(fixture: OpenAITestFixture, fetch: FetchImpl, query = "Bun latest release"): SearchParams {
	return {
		query,
		systemPrompt: "Use hosted web search and cite sources.",
		authStorage: fixture.authStorage,
		modelRegistry: fixture.modelRegistry,
		model: fixture.model,
		fetch,
	};
}

describe("OpenAI API-billed Responses web search", () => {
	it("dispatches OpenAI grounding through the selected model and maps search sources, citations, and usage", async () => {
		const fixture = createFixture();
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					id: "resp-openai-search-1",
					model: "gpt-5.6-luna",
					output: [
						{
							type: "web_search_call",
							status: "completed",
							action: {
								type: "search",
								query: '"Responses web search" -legacy site:docs.openai.com after:2026-01-01',
								sources: [{ type: "url", url: "https://docs.openai.com/search", title: "OpenAI Search Docs" }],
							},
						},
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: "Bun v1.2 launched.",
									annotations: [
										{
											type: "url_citation",
											url: "https://docs.openai.com/search",
											title: "OpenAI Search Docs",
											start_index: 0,
											end_index: 18,
										},
									],
								},
							],
						},
					],
					usage: { input_tokens: 120, output_tokens: 35, total_tokens: 155 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			const provider = await getGroundedSearchProvider("openai");
			expect(provider.id).toBe("openai");
			const result = await provider.search(
				makeParams(fixture, fetch, 'site:docs.openai.com "Responses web search" -legacy after:2026-01-01'),
			);

			expect(requestUrl).toBe("https://openai-grounding.example.test/v1/responses");
			expect(requestHeaders?.get("authorization")).toBe(`Bearer ${API_KEY}`);
			expect(requestHeaders?.get("x-selected-route")).toBe("catalog-model");
			expect(requestBody).toMatchObject({
				model: "gpt-5.6-luna",
				instructions: "Use hosted web search and cite sources.",
				input: '"Responses web search" -legacy site:docs.openai.com after:2026-01-01',
				tools: [{ type: "web_search", filters: { allowed_domains: ["docs.openai.com"] } }],
				tool_choice: { type: "web_search" },
				include: ["web_search_call.action.sources"],
				store: false,
			});
			expect(result).toMatchObject({
				provider: "openai",
				answer: "Bun v1.2 launched.",
				sources: [
					{
						title: "OpenAI Search Docs",
						url: "https://docs.openai.com/search",
						snippet: "Bun v1.2 launched.",
					},
				],
				citations: [
					{
						title: "OpenAI Search Docs",
						url: "https://docs.openai.com/search",
						citedText: "Bun v1.2 launched.",
					},
				],
				searchQueries: ['"Responses web search" -legacy site:docs.openai.com after:2026-01-01'],
				usage: { inputTokens: 120, outputTokens: 35, totalTokens: 155, searchRequests: 1 },
				model: "gpt-5.6-luna",
				requestId: "resp-openai-search-1",
				authMode: "api_key",
			});
		} finally {
			fixture.authStorage.close();
		}
	});

	it("sends a string tool_choice to hosts that reject named tool choices and still maps the search response", async () => {
		const fixture = createFixture({ compat: { supportsNamedToolChoice: false } });
		let requestBody: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "web_search_call",
							status: "completed",
							action: {
								type: "search",
								query: "string-only host lookup",
								sources: [
									{ type: "url", url: "https://search.example.test/string-only", title: "String-only result" },
								],
							},
						},
						{ type: "message", content: [{ type: "output_text", text: "Found it." }] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			const result = await searchOpenAIResponses(makeParams(fixture, fetch));
			expect(requestBody).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "required" });
			expect(result).toMatchObject({
				answer: "Found it.",
				sources: [{ url: "https://search.example.test/string-only", title: "String-only result" }],
				usage: { searchRequests: 1 },
			});
		} finally {
			fixture.authStorage.close();
		}
	});

	it("labels a LiteLLM search with the conversation session header", async () => {
		const fixture = createFixture({ provider: "litellm" });
		const sessionHeaders: (string | null)[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			sessionHeaders.push(new Headers(init?.headers).get("x-litellm-session-id"));
			return Response.json({
				output: [
					{
						type: "web_search_call",
						status: "completed",
						action: { type: "search", query: "Bun latest release" },
					},
					{ type: "message", content: [{ type: "output_text", text: "Found it." }] },
				],
			});
		};

		try {
			await searchOpenAIResponses({ ...makeParams(fixture, fetch), sessionId: "session-1" });
			expect(sessionHeaders).toEqual(["session-1"]);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("counts search actions without counting page actions in a valid response", async () => {
		const fixture = createFixture();
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					output: [
						{
							type: "web_search_call",
							status: "completed",
							action: {
								type: "search",
								query: "mixed-action lookup",
								sources: [{ type: "url", url: "https://search.example.test/result", title: "Search result" }],
							},
						},
						{
							type: "web_search_call",
							status: "completed",
							action: { type: "open_page", url: "https://search.example.test/result" },
						},
						{
							type: "web_search_call",
							status: "completed",
							action: {
								type: "find_in_page",
								url: "https://search.example.test/result",
								pattern: "result",
							},
						},
						{ type: "message", content: [{ type: "output_text", text: "The page contains the result." }] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		try {
			const result = await searchOpenAIResponses(makeParams(fixture, fetch));
			expect(result).toMatchObject({
				answer: "The page contains the result.",
				sources: [{ url: "https://search.example.test/result", title: "Search result" }],
				usage: { searchRequests: 1 },
			});
		} finally {
			fixture.authStorage.close();
		}
	});

	it("uses the upstream wire id and reasoning mode metadata for a Pro alias", async () => {
		const fixture = createFixture({ requestModelId: "gpt-5.6-pro", reasoningMode: "pro" });
		let requestBody: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					id: "resp-openai-pro-alias",
					output: [
						{
							type: "web_search_call",
							status: "completed",
							action: { query: "grounded model", sources: [{ url: "https://source.test", title: "Source" }] },
						},
						{ type: "message", content: [{ type: "output_text", text: "Alias answer." }] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			await searchOpenAIResponses(makeParams(fixture, fetch));
			expect(requestBody).toMatchObject({
				model: "gpt-5.6-pro",
				reasoning: { mode: "pro" },
				store: false,
			});
		} finally {
			fixture.authStorage.close();
		}
	});

	it("hard-caps sources while keeping annotated answer URLs ahead of consulted sources", async () => {
		const fixture = createFixture();
		const citedUrl = "https://cited.example.test/11";
		const consultedSources = Array.from({ length: 10 }, (_, index) => ({
			url: `https://results.example.test/${index + 1}`,
			title: `Result ${index + 1}`,
		}));
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					output: [
						{ type: "web_search_call", action: { query: "source cap", sources: consultedSources } },
						{
							type: "message",
							content: [
								{
									type: "output_text",
									text: "The answer cites a source beyond the consulted-result cap.",
									annotations: [{ type: "url_citation", url: citedUrl, title: "Answer citation" }],
								},
							],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		try {
			const result = await searchOpenAIResponses({
				...makeParams(fixture, fetch),
				numSearchResults: 10,
			});
			expect(result.sources).toHaveLength(10);
			expect(result.sources[0]).toMatchObject({ url: citedUrl, title: "Answer citation" });
			expect(result.sources.some(source => source.url === "https://results.example.test/10")).toBe(false);
			expect(result.citations).toHaveLength(10);
			expect(result.citations).toContainEqual({ url: citedUrl, title: "Answer citation" });
		} finally {
			fixture.authStorage.close();
		}
	});

	it("rejects a generated answer that contains no actual web_search_call", async () => {
		const fixture = createFixture();
		try {
			const provider = await getGroundedSearchProvider("openai");
			await expect(
				provider.search(
					makeParams(
						fixture,
						async () =>
							new Response(
								JSON.stringify({
									id: "resp-answer-only",
									output: [
										{ type: "message", content: [{ type: "output_text", text: "An unsupported answer." }] },
									],
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
					),
				),
			).rejects.toMatchObject({
				provider: "openai",
				status: 502,
				message: expect.stringContaining("no web_search_call"),
			});
		} finally {
			fixture.authStorage.close();
		}
	});
	it("rejects a search call that returned no answer or sources", async () => {
		const fixture = createFixture();
		try {
			await expect(
				searchOpenAIResponses(
					makeParams(
						fixture,
						async () =>
							new Response(
								JSON.stringify({
									output: [{ type: "web_search_call", action: { query: "search with no results" } }],
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
					),
				),
			).rejects.toMatchObject({
				provider: "openai",
				status: 502,
				message: expect.stringContaining("no answer or sources"),
			});
		} finally {
			fixture.authStorage.close();
		}
	});

	it("signals API request failures for fallback without exposing credential-bearing error bodies", async () => {
		const fixture = createFixture();
		try {
			for (const [status, message] of [
				[400, "OpenAI Responses API rejected the request (400)"],
				[401, "OpenAI API key was rejected (401)"],
				[429, "OpenAI API rate limit reached (429)"],
			] as const) {
				let error: unknown;
				try {
					await searchOpenAIResponses(
						makeParams(fixture, async () => new Response(`API key ${API_KEY} was rejected`, { status })),
					);
				} catch (caught) {
					error = caught;
				}
				expect(error).toMatchObject({ provider: "openai", status, message });
				expect(error instanceof Error ? error.message : String(error)).not.toContain(API_KEY);
			}

			let structured: unknown;
			try {
				await searchOpenAIResponses(
					makeParams(
						fixture,
						async () =>
							new Response(
								JSON.stringify({
									error: {
										message: `Incorrect API key provided: ${API_KEY}`,
										type: "invalid_request_error",
										code: "invalid_api_key",
										param: null,
									},
								}),
								{ status: 401, headers: { "Content-Type": "application/json" } },
							),
					),
				);
			} catch (caught) {
				structured = caught;
			}
			expect(structured).toMatchObject({
				provider: "openai",
				status: 401,
				message: "OpenAI API key was rejected (401): type=invalid_request_error, code=invalid_api_key",
			});
		} finally {
			fixture.authStorage.close();
		}
	});
});
