import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { hasCodexSearch, searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
	signal?: AbortSignal | null;
};

function codexModel(id: string, baseUrl = "https://chatgpt.com/backend-api"): Model<"openai-codex-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

const selectedCodexModel = codexModel("gpt-5.4");
const proxyCodexModel = {
	...selectedCodexModel,
	baseUrl: "https://proxy.example/backend-api",
	headers: { "X-Proxy-Tenant": "tenant-1" },
};

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
	let oauthAuthStorage: AuthStorage;
	let emailOnlyAuthStorage: AuthStorage;
	let proxyAuthStorage: AuthStorage;
	let oauthOnlyAuthStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let proxyModelRegistry: ModelRegistry;
	let oauthModelRegistry: ModelRegistry;
	let capturedRequest: CapturedRequest | null = null;

	function createAuthStorage(): AuthStorage {
		return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	}

	beforeEach(() => {
		oauthAuthStorage = createAuthStorage();
		vi.spyOn(oauthAuthStorage.oauth, "access").mockResolvedValue({
			accessToken: residencyToken,
			accountId: "acct-test",
		});
		emailOnlyAuthStorage = createAuthStorage();
		vi.spyOn(emailOnlyAuthStorage.oauth, "access").mockResolvedValue({
			accessToken: "email-only-access-token",
			email: "user@example.com",
		});
		proxyAuthStorage = createAuthStorage();
		proxyAuthStorage.keys.setRuntime("openai-codex", "test-proxy-key");
		oauthOnlyAuthStorage = createAuthStorage();
		oauthOnlyAuthStorage.keys.setRuntime("openai-codex", "official-oauth-token");
		vi.spyOn(oauthOnlyAuthStorage.keys, "source").mockReturnValue({ kind: "oauth", concrete: true });
		modelRegistry = new ModelRegistry(oauthAuthStorage);
		proxyModelRegistry = new ModelRegistry(proxyAuthStorage);
		oauthModelRegistry = new ModelRegistry(oauthOnlyAuthStorage);
	});

	function makeSearchParams(
		query: string,
		fetch?: FetchImpl,
		model: Model<"openai-codex-responses"> = selectedCodexModel,
	): SearchParams {
		return {
			query,
			systemPrompt: "Codex test system prompt",
			authStorage: oauthAuthStorage,
			model,
			modelRegistry,
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
		oauthAuthStorage.close();
		emailOnlyAuthStorage.close();
		proxyAuthStorage.close();
		oauthOnlyAuthStorage.close();
	});

	it("sends the selected Codex model id on the wire", async () => {
		const model = codexModel("gpt-5.6-luna");
		const result = await searchCodex(makeSearchParams("selected codex model", mockCodexFetch("gpt-5.6-luna"), model));

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(new Headers(capturedRequest?.headers).get("x-openai-internal-codex-residency")).toBe("us");
		expect(capturedRequest?.body?.model).toBe("gpt-5.6-luna");
		expect(result.model).toBe("gpt-5.6-luna");
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("uses email-only OAuth credentials without an account header", async () => {
		const result = await searchCodex({
			...makeSearchParams("email-only Codex search", mockCodexFetch("gpt-5.6-luna")),
			authStorage: emailOnlyAuthStorage,
			modelRegistry: new ModelRegistry(emailOnlyAuthStorage),
		});

		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer email-only-access-token");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(result.answer).toBe("Codex answer");
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
		const query = "how does the bun runtime schedule timers?";
		await searchCodex(makeSearchParams(query, mockCodexFetch("gpt-5.6-luna")));

		expect(sentUserText()).toBe(query);
	});

	it("uses configured Codex endpoint, API key, and headers without OAuth", async () => {
		const result = await searchCodex({
			...makeSearchParams("proxy codex model", mockCodexFetch("gpt-5.4"), proxyCodexModel),
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
		let fetchCalled = false;
		const fetchMock: FetchImpl = () => {
			fetchCalled = true;
			return Promise.resolve(new Response("unexpected"));
		};

		await expect(
			searchCodex({
				...makeSearchParams("unsafe proxy", fetchMock, proxyCodexModel),
				authStorage: oauthOnlyAuthStorage,
				modelRegistry: oauthModelRegistry,
			}),
		).rejects.toThrow("Refusing to send official Codex OAuth credentials");
		expect(fetchCalled).toBe(false);
	});

	it("validates the credential origin from the registry storage that supplies the key", async () => {
		let fetchCalled = false;
		const fetchMock: FetchImpl = () => {
			fetchCalled = true;
			return Promise.resolve(new Response("unexpected"));
		};
		await expect(
			searchCodex({
				...makeSearchParams("registry oauth leak", fetchMock, proxyCodexModel),
				authStorage: proxyAuthStorage,
				modelRegistry: oauthModelRegistry,
			}),
		).rejects.toThrow("Refusing to send official Codex OAuth credentials");
		expect(fetchCalled).toBe(false);
	});

	it("prefers a command-backed proxy key over stored OAuth on a custom endpoint", async () => {
		vi.spyOn(oauthModelRegistry, "hasCommandBackedApiKey").mockReturnValue(true);
		vi.spyOn(oauthModelRegistry, "resolver").mockReturnValue(async () => "command-proxy-key");

		const result = await searchCodex({
			...makeSearchParams("command proxy key", mockCodexFetch("gpt-5.4"), proxyCodexModel),
			authStorage: oauthOnlyAuthStorage,
			modelRegistry: oauthModelRegistry,
		});

		const headers = new Headers(capturedRequest?.headers);
		expect(headers.get("authorization")).toBe("Bearer command-proxy-key");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(result.answer).toBe("Codex answer");
	});

	it("keeps hosted web_search top-level for selected Responses-Lite catalog models (#7666)", async () => {
		const solModel = codexModel("gpt-5.6-sol");
		const result = await searchCodex(makeSearchParams("Sol web search", mockCodexFetch("gpt-5.6-sol"), solModel));

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

	it("forces web_search tool choice and extracts markdown link citations when annotations are absent", async () => {
		const result = await searchCodex(
			makeSearchParams("markdown citations", mockCodexFetch("gpt-5.4", makeMarkdownLinkSseResponse("gpt-5.4"))),
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.tool_choice).toEqual({ type: "web_search" });
		expect(result.sources).toEqual([{ title: "Example Article", url: "https://example.com/article" }]);
	});

	it("requests and merges web-search action sources with citation metadata", async () => {
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
		const result = await searchCodex(
			makeSearchParams("plain url citations", mockCodexFetch("gpt-5.4", makePlainUrlSseResponse("gpt-5.4"))),
		);

		expect(result.sources).toEqual([
			{ title: "https://example.com/article", url: "https://example.com/article" },
			{ title: "https://example.com/faq", url: "https://example.com/faq" },
		]);
	});

	it("preserves markdown URLs that contain balanced parentheses", async () => {
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

	it("fails a selected Responses-Lite model that answers without running web search (#6988)", async () => {
		const terraModel = codexModel("gpt-5.6-terra");
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

		await expect(searchCodex(makeSearchParams("no search performed", fetchMock, terraModel))).rejects.toThrow(
			/without running web search/,
		);
	});

	it("preserves a nested type:error code and message instead of Unknown error (#7200)", async () => {
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
