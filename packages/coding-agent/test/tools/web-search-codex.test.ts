import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { hasCodexSearch, searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
	signal?: AbortSignal | null;
};

const originalCodexSearchModel = process.env.PI_CODEX_WEB_SEARCH_MODEL;

// A completed hosted web_search tool call. Real Codex searches always stream a
// `response.web_search_call.*` event; the provider now requires that evidence
// (#6988), so every success fixture must include it.
const WEB_SEARCH_CALL_EVENT = `data: ${JSON.stringify({
	type: "response.web_search_call.completed",
	item_id: "ws_test",
})}`;

function makeSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/article", title: "Example Article" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_test",
				model,
				usage: {
					input_tokens: 12,
					output_tokens: 7,
					total_tokens: 19,
				},
			},
		})}`,
		"",
	].join("\n");
}

function makeImagePlaceholderSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: "OpenAI Responses API defaults `store` to false unless you opt in.",
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "(see attached image)",
						annotations: [
							{ type: "url_citation", url: "https://platform.openai.com/docs/api-reference/responses" },
						],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_codex_placeholder_test",
				model,
			},
		})}`,
		"",
	].join("\n");
}

function makeMarkdownLinkSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Example Article](https://example.com/article) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Sources:\n- https://example.com/article\n- https://example.com/faq",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_test", model },
		})}`,
		"",
	].join("\n");
}

function makeMarkdownParenthesesSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "See [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) for details.",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_markdown_parentheses_test", model },
		})}`,
		"",
	].join("\n");
}

function makePlainUrlPunctuationSseResponse(model: string): string {
	return [
		WEB_SEARCH_CALL_EVENT,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Read https://example.com/article. Then compare https://example.com/faq), and keep https://en.wikipedia.org/wiki/Function_(mathematics).",
						annotations: [],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_plain_url_punctuation_test", model },
		})}`,
		"",
	].join("\n");
}

describe("searchCodex model selection", () => {
	const residencyPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-test",
				chatgpt_data_residency: "us",
			},
		}),
	).toString("base64url");
	const residencyToken = `header.${residencyPayload}.signature`;
	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: residencyToken,
				accountId: "acct-test",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;
	const proxyAuthStorage = {
		hasAuth(provider: string) {
			return provider === "openai-codex";
		},
		getCredentialOrigin() {
			return { kind: "config" as const };
		},
		resolver() {
			return async () => "test-proxy-key";
		},
	} as unknown as AuthStorage;
	const oauthOnlyAuthStorage = {
		...proxyAuthStorage,
		getCredentialOrigin() {
			return { kind: "oauth" as const };
		},
	} as unknown as AuthStorage;
	const proxyModelRegistry = {
		find(_provider: string, modelId: string) {
			return {
				provider: "openai-codex",
				id: modelId,
				api: "openai-codex-responses",
				baseUrl: "https://proxy.example/backend-api",
				headers: { "X-Proxy-Tenant": "tenant-1" },
			};
		},
		getProviderBaseUrl() {
			return "https://proxy.example/backend-api";
		},
		getProviderHeaders() {
			return { "X-Proxy-Tenant": "tenant-1" };
		},
		hasCommandBackedApiKey() {
			return false;
		},
		resolver() {
			return async () => "test-proxy-key";
		},
	} as unknown as ModelRegistry;
	let capturedRequest: CapturedRequest | null = null;

	function makeSearchParams(query: string, fetch?: FetchImpl): SearchParams {
		return {
			query,
			systemPrompt: "Codex test system prompt",
			authStorage: fakeAuthStorage,
			...(fetch ? { fetch } : {}),
		};
	}

	function mockCodexFetch(responseModel: string, responseBody?: string): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
				signal: init?.signal,
			};
			return Promise.resolve(
				new Response(responseBody ?? makeSseResponse(responseModel), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
		if (originalCodexSearchModel === undefined) {
			delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		} else {
			process.env.PI_CODEX_WEB_SEARCH_MODEL = originalCodexSearchModel;
		}
	});

	it("uses GPT-5.6 Luna as the first bundled default", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		const result = await searchCodex(makeSearchParams("default codex model", mockCodexFetch("gpt-5.6-luna")));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(new Headers(capturedRequest?.headers).get("x-openai-internal-codex-residency")).toBe("us");
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("applies the configured request timeout to Codex search", async () => {
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);

		await searchCodex({
			...makeSearchParams("slow codex search", mockCodexFetch("gpt-5.6-luna")),
			timeoutMs: 180_000,
		});

		expect(timeoutSpy).toHaveBeenCalledWith(180_000);
		expect(capturedRequest?.signal).toBe(timeoutSignal);
	});

	function sentUserText(): string | undefined {
		const input = capturedRequest?.body?.input as Array<Record<string, unknown>> | undefined;
		const userItem = input?.find(item => item.role === "user");
		const content = userItem?.content as Array<Record<string, unknown>> | undefined;
		return content?.[0]?.text as string | undefined;
	}

	it("re-emits directive queries with normalized Google-style operators", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		await searchCodex(
			makeSearchParams(
				'bun runtime site:bun.sh -site:reddit.com after:2024-01-01 "exact phrase"',
				mockCodexFetch("gpt-5.6-luna"),
			),
		);

		expect(capturedRequest).not.toBeNull();
		expect(sentUserText()).toBe('bun runtime "exact phrase" site:bun.sh -site:reddit.com after:2024-01-01');
		// Tool config stays untouched: the ChatGPT backend's filter support is
		// unverified, so no `filters` field is added to the web_search tool.
		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
	});

	it("sends directive-free queries byte-identical", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		const query = "how does the bun runtime schedule timers?";
		await searchCodex(makeSearchParams(query, mockCodexFetch("gpt-5.6-luna")));

		expect(sentUserText()).toBe(query);
	});

	it("uses configured Codex endpoint, API key, and headers without OAuth", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex({
			...makeSearchParams("proxy codex model", mockCodexFetch("gpt-5.4")),
			authStorage: proxyAuthStorage,
			modelRegistry: proxyModelRegistry,
		});

		expect(await hasCodexSearch(proxyAuthStorage)).toBe(true);
		expect(capturedRequest?.url).toBe("https://proxy.example/backend-api/codex/responses");
		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-proxy-key");
		expect(headers.get("x-proxy-tenant")).toBe("tenant-1");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(headers.has("x-openai-internal-codex-residency")).toBe(false);
		expect(result.answer).toBe("Codex answer");
	});

	it("refuses to send official OAuth credentials to a configured Codex endpoint", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const fetchMock = vi.fn();

		await expect(
			searchCodex({
				...makeSearchParams("unsafe proxy", fetchMock),
				authStorage: oauthOnlyAuthStorage,
				modelRegistry: proxyModelRegistry,
			}),
		).rejects.toThrow("Refusing to send official Codex OAuth credentials");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates the credential origin from the registry storage that supplies the key", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const fetchMock = vi.fn();
		const oauthBackedRegistry = {
			...proxyModelRegistry,
			authStorage: oauthOnlyAuthStorage,
			resolver() {
				return async () => "official-oauth-token";
			},
		} as unknown as ModelRegistry;

		await expect(
			searchCodex({
				...makeSearchParams("registry oauth leak", fetchMock),
				authStorage: proxyAuthStorage,
				modelRegistry: oauthBackedRegistry,
			}),
		).rejects.toThrow("Refusing to send official Codex OAuth credentials");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("prefers a command-backed proxy key over stored OAuth on a custom endpoint", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const commandBackedRegistry = {
			...proxyModelRegistry,
			authStorage: oauthOnlyAuthStorage,
			hasCommandBackedApiKey(provider: string) {
				return provider === "openai-codex";
			},
			resolver() {
				return async () => "command-proxy-key";
			},
		} as unknown as ModelRegistry;

		const result = await searchCodex({
			...makeSearchParams("command proxy key", mockCodexFetch("gpt-5.4")),
			authStorage: oauthOnlyAuthStorage,
			modelRegistry: commandBackedRegistry,
		});

		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer command-proxy-key");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(result.answer).toBe("Codex answer");
	});

	it("falls back to the default model when PI_CODEX_WEB_SEARCH_MODEL is blank", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "   ";
		const result = await searchCodex(makeSearchParams("blank codex model", mockCodexFetch("gpt-5.6-luna")));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
	});

	it("retries the next bundled default when Codex rejects a model for ChatGPT accounts", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		let calls = 0;
		capturedRequest = null;
		const fetchMock: FetchImpl = (url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			const requestedModel = capturedRequest.body?.model;
			if (calls === 1) {
				expect(requestedModel).toBe("gpt-5.6-luna");
				return Promise.resolve(
					new Response(
						JSON.stringify({
							detail: "The 'gpt-5.6-luna' model is not supported when using Codex with a ChatGPT account.",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			expect(requestedModel).toBe("gpt-5.6-terra");
			return Promise.resolve(
				new Response(makeSseResponse("gpt-5.6-terra"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};

		const result = await searchCodex(makeSearchParams("retry unsupported default", fetchMock));

		expect(calls).toBe(2);
		expect(result.model).toBe("gpt-5.6-terra");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("keeps hosted web_search top-level for explicit Responses-Lite catalog models (#7666)", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.6-sol";
		const result = await searchCodex(makeSearchParams("Sol web search", mockCodexFetch("gpt-5.6-sol")));

		expect(capturedRequest).not.toBeNull();
		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull();
		expect(capturedRequest?.body).toEqual(
			expect.objectContaining({
				model: "gpt-5.6-sol",
				tools: [{ type: "web_search", search_context_size: "high" }],
				tool_choice: { type: "web_search" },
				instructions: "Codex test system prompt",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Sol web search" }],
					},
				],
			}),
		);
		expect(result.model).toBe("gpt-5.6-sol");
	});

	it("does not retry default candidates when PI_CODEX_WEB_SEARCH_MODEL is explicitly unsupported", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.5";
		let calls = 0;
		capturedRequest = null;
		const fetchMock: FetchImpl = (url, init) => {
			calls += 1;
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};

			expect(capturedRequest.body?.model).toBe("gpt-5.5");
			return Promise.resolve(
				new Response(
					JSON.stringify({
						detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		await expect(searchCodex(makeSearchParams("explicit unsupported model", fetchMock))).rejects.toThrow("gpt-5.5");
		expect(calls).toBe(1);
	});

	it("forces web_search tool choice and extracts markdown link citations when annotations are absent", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams("markdown citations", mockCodexFetch("gpt-5.4", makeMarkdownLinkSseResponse("gpt-5.4"))),
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("requests and merges web-search action sources with citation metadata", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const answer = "The Responses API supports hosted web search.";
		const citationStart = answer.indexOf("hosted web search");
		const sse = [
			`data: ${JSON.stringify({
				type: "response.created",
				response: { id: "resp_created_id", model: "gpt-5.4" },
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					action: {
						sources: [
							{
								url: "https://example.com/article?utm_source=openai",
								title: "Search result title",
							},
						],
					},
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: answer,
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/article?utm_source=openai",
									title: "Example Article",
									start_index: citationStart,
									end_index: citationStart + "hosted web search".length,
								},
							],
						},
					],
				},
			})}`,
			"",
		].join("\n");

		const result = await searchCodex(makeSearchParams("action sources", mockCodexFetch("gpt-5.4", sse)));

		expect(capturedRequest?.body?.include).toEqual(["web_search_call.action.sources"]);
		expect(result.requestId).toBe("resp_created_id");
		expect(result.sources).toEqual([
			{
				title: "Search result title",
				url: "https://example.com/article",
				snippet: answer,
			},
		]);
	});

	it("extracts plain text URLs when annotations are absent", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams("plain url citations", mockCodexFetch("gpt-5.4", makePlainUrlSseResponse("gpt-5.4"))),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
		]);
	});

	it("preserves markdown URLs that contain balanced parentheses", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams(
				"markdown parentheses citations",
				mockCodexFetch("gpt-5.4", makeMarkdownParenthesesSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "Function", url: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
		]);
	});

	it("strips trailing prose punctuation from plain text URLs", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.4";
		const result = await searchCodex(
			makeSearchParams(
				"plain url punctuation",
				mockCodexFetch("gpt-5.4", makePlainUrlPunctuationSseResponse("gpt-5.4")),
			),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
			{
				title: "https://en.wikipedia.org/wiki/Function_(mathematics)",
				url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
			},
		]);
	});

	it("prefers streamed text when the final item only contains an image placeholder", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(makeImagePlaceholderSseResponse("gpt-5.4-mini"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);

		const result = await searchCodex(makeSearchParams("responses api store semantics", fetchMock));

		expect(result.answer).toBe("OpenAI Responses API defaults `store` to false unless you opt in.");
		expect(result.sources).toEqual([
			{
				title: "https://platform.openai.com/docs/api-reference/responses",
				url: "https://platform.openai.com/docs/api-reference/responses",
			},
		]);
	});

	it("throws to advance the chain when both streamed and final answers are image placeholders without sources", async () => {
		const sse = [
			WEB_SEARCH_CALL_EVENT,
			"",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "[Attached image]",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [{ type: "output_text", text: "See image above.", annotations: [] }],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_only", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("image only", fetchMock))).rejects.toThrow(/image-only response/);
	});

	it("drops placeholder prose from the answer but keeps annotation sources when both are placeholders", async () => {
		const sse = [
			WEB_SEARCH_CALL_EVENT,
			"",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "(see attached image)",
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: "(See attached image.)",
							annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Docs" }],
						},
					],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_codex_placeholder_with_sources", model: "gpt-5.5" },
			})}`,
			"",
		].join("\n");

		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		const result = await searchCodex(makeSearchParams("image with sources", fetchMock));
		expect(result.answer).toBeUndefined();
		expect(result.sources).toEqual([{ title: "Docs", url: "https://example.com/docs" }]);
	});

	it("fails a configured Responses-Lite model that answers without running web search (#6988)", async () => {
		process.env.PI_CODEX_WEB_SEARCH_MODEL = "gpt-5.6-terra";
		const sse = [
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					content: [
						{
							type: "output_text",
							text: "July 28, 2026 is still in the future, so OpenAI has not announced anything yet.",
						},
					],
				},
			})}`,
			"",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_no_search", model: "gpt-5.6-terra" },
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("no search performed", fetchMock))).rejects.toThrow(
			/without running web search/,
		);
	});

	it("advances to the next default candidate when a lite model skips web search (#6988)", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		let calls = 0;
		const noSearchSse = [
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: { type: "message", content: [{ type: "output_text", text: "stale answer, no search" }] },
			})}`,
			"",
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_skip", model: "gpt-5.6-luna" } })}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = (_url, init) => {
			calls += 1;
			const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
			if (calls === 1) {
				expect(body?.model).toBe("gpt-5.6-luna");
				return Promise.resolve(
					new Response(noSearchSse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
				);
			}
			expect(body?.model).toBe("gpt-5.6-terra");
			return Promise.resolve(
				new Response(makeSseResponse("gpt-5.6-terra"), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};

		const result = await searchCodex(makeSearchParams("advance past skipped search", fetchMock));
		expect(calls).toBe(2);
		expect(result.model).toBe("gpt-5.6-terra");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("preserves a nested type:error code and message instead of Unknown error (#7200)", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		const sse = [
			`data: ${JSON.stringify({
				type: "error",
				error: {
					code: "unsupported_region",
					message: "web_search is not available for this workspace's data residency region.",
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("nested error envelope", fetchMock))).rejects.toThrow(
			"Codex error (unsupported_region): web_search is not available for this workspace's data residency region.",
		);
	});

	it("preserves a structured response.failed error code and message (#7200)", async () => {
		delete process.env.PI_CODEX_WEB_SEARCH_MODEL;
		const sse = [
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					id: "resp_failed",
					error: { code: "model_snapshot_unavailable", message: "The requested model snapshot is unavailable." },
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("structured failure", fetchMock))).rejects.toThrow(
			"Codex request failed (model_snapshot_unavailable): The requested model snapshot is unavailable.",
		);
	});

	it("classifies rate-limit failures delivered inside a successful SSE response", async () => {
		const sse = [
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					error: { code: "rate_limit_exceeded", message: "Too many requests" },
				},
			})}`,
			"",
		].join("\n");
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

		await expect(searchCodex(makeSearchParams("rate-limited search", fetchMock))).rejects.toMatchObject({
			status: 429,
		});
	});
});
