import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { PerplexityProvider, searchPerplexity } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity";
import { getAvailableAuthMethods } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity-auth";

const API_URL = "https://api.perplexity.ai/chat/completions";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const RESPONSES_URL = "https://api.perplexity.ai/v1/responses";

// API-key path only: getOAuthAccess returns undefined so findPerplexityAuth
// falls through to PERPLEXITY_API_KEY (set per-test, restored in afterEach).
const apiKeyAuthStorage = {
	async getOAuthAccess() {
		return undefined;
	},
	async getApiKey(provider: string) {
		if (provider === "perplexity") return process.env.PERPLEXITY_API_KEY;
		if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
		return undefined;
	},
	getCredentialOrigin(provider: string) {
		// Env-backed key (not OAuth) — the direct api-key config must still be emitted.
		if (provider === "perplexity" && process.env.PERPLEXITY_API_KEY) return { kind: "env" };
		if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) return { kind: "env" };
		return undefined;
	},
	hasAuth() {
		return false;
	},
} as unknown as AuthStorage;

function sseResponse(events: Record<string, unknown>[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function mockApi(capture: (body: Record<string, unknown>) => void, events: Record<string, unknown>[]): FetchImpl {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === API_URL) {
			capture(JSON.parse(init?.body as string));
			return sseResponse(events);
		}
		return new Response("not mocked", { status: 500 });
	};
}

function baseResponse(extra: Record<string, unknown> = {}): Record<string, unknown>[] {
	return [
		{
			id: "req-1",
			model: "sonar-pro",
			choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }],
		},
		{
			id: "req-1",
			model: "sonar-pro",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			search_results: [{ title: "T", url: "https://example.com", snippet: "s" }],
			...extra,
		},
		{
			id: "req-1",
			model: "sonar-pro",
			choices: [],
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
		},
	];
}

describe("Perplexity API-key request shape", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;
	const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
	const savedCookies = process.env.PERPLEXITY_COOKIES;
	const savedResponsesMode = process.env.PI_PERPLEXITY_RESPONSES;
	const savedApiModel = process.env.PI_PERPLEXITY_API_MODEL;

	beforeEach(() => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
		delete process.env.PI_PERPLEXITY_RESPONSES;
		delete process.env.PI_PERPLEXITY_API_MODEL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
		if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
		if (savedResponsesMode === undefined) delete process.env.PI_PERPLEXITY_RESPONSES;
		else process.env.PI_PERPLEXITY_RESPONSES = savedResponsesMode;
		if (savedApiModel === undefined) delete process.env.PI_PERPLEXITY_API_MODEL;
		else process.env.PI_PERPLEXITY_API_MODEL = savedApiModel;
	});

	it("requests comprehensive defaults: 20 results, high context, related questions", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = mockApi(b => (body = b), baseResponse());
		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage, fetch: fetchMock });

		expect(body?.num_search_results).toBe(20);
		expect(body?.web_search_options).toMatchObject({ search_type: "pro", search_context_size: "high" });
		expect(body?.return_related_questions).toBe(true);
	});

	it("accepts a configured direct API model", async () => {
		process.env.PI_PERPLEXITY_API_MODEL = "sonar-deep-research";
		let body: Record<string, unknown> | undefined;
		await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: mockApi(b => (body = b), baseResponse()),
		});

		expect(body?.model).toBe("sonar-deep-research");
	});

	it("honors a caller-supplied num_search_results over the default", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = mockApi(b => (body = b), baseResponse());

		await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			num_search_results: 5,
			fetch: fetchMock,
		});

		expect(body?.num_search_results).toBe(5);
	});

	it("maps site:/-site:/after: directives onto native filters and strips them from the query", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = mockApi(b => (body = b), baseResponse());

		await searchPerplexity({
			query: "rust site:docs.rs -site:reddit.com after:2024-06-01",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(body?.search_domain_filter).toEqual(["docs.rs", "-reddit.com"]);
		expect(body?.search_after_date_filter).toBe("6/1/2024");
		const messages = body?.messages as { role: string; content: string }[];
		expect(messages.at(-1)?.content).toBe("rust");
	});

	it("parses related_questions into relatedQuestions, preserving order and dropping blanks", async () => {
		const fetchMock = mockApi(
			() => {},
			baseResponse({ related_questions: ["How does QUIC handle loss?", "  ", "What is 0-RTT?"] }),
		);

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(response.relatedQuestions).toEqual(["How does QUIC handle loss?", "What is 0-RTT?"]);
	});

	it("omits relatedQuestions when the API returns none", async () => {
		const fetchMock = mockApi(() => {}, baseResponse());

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(response.relatedQuestions).toBeUndefined();
	});
	it("falls back to OpenRouter with the selected API-key config after a non-retryable direct Perplexity failure", async () => {
		process.env.OPENROUTER_API_KEY = "openrouter-test-key";
		const urls: string[] = [];
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			urls.push(url);
			bodies.push(JSON.parse(init?.body as string));
			if (url === API_URL) return new Response("direct failed", { status: 400 });
			if (url === OPENROUTER_API_URL) return sseResponse(baseResponse());
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(urls).toEqual([API_URL, OPENROUTER_API_URL]);
		expect(bodies[0]?.model).toBe("sonar-pro");
		expect(bodies[1]?.model).toBe("perplexity/sonar-pro");
		expect(response.authMode).toBe("api_key");
		expect(response.answer).toBe("answer");
	});
	it("rejects with the classified upstream error instead of a generic 401 when the only method fails", async () => {
		delete process.env.OPENROUTER_API_KEY;
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === API_URL) {
				return new Response(JSON.stringify({ error: { message: "credits exhausted" } }), {
					status: 402,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await expect(
			searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage, fetch: fetchMock }),
		).rejects.toThrow(/credits exhausted/);
	});
	it("streams the Responses API and captures Perplexity search result events", async () => {
		process.env.PI_PERPLEXITY_RESPONSES = "1";
		let body: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url !== RESPONSES_URL) return new Response("not mocked", { status: 500 });
			body = JSON.parse(init?.body as string);
			return sseResponse([
				{
					type: "response.created",
					response: { id: "resp-1", status: "in_progress" },
				},
				{
					type: "response.reasoning.search_results",
					results: [{ title: "Responses source", url: "https://example.org", snippet: "rs" }],
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { id: "msg-1", type: "message", role: "assistant", content: [], status: "in_progress" },
				},
				{
					type: "response.output_text.delta",
					output_index: 0,
					item_id: "msg-1",
					content_index: 0,
					delta: "answer",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: "msg-1",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "answer", annotations: [] }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						model: "sonar-pro",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
					},
				},
			]);
		};

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(body?.num_search_results).toBe(20);
		expect(body?.max_output_tokens).toBe(8192);
		expect(response.answer).toBe("answer");
		expect(response.sources[0]).toMatchObject({
			title: "Responses source",
			url: "https://example.org",
			snippet: "rs",
		});
		expect(response.requestId).toBe("resp-1");
	});
});

const OAUTH_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";

// OAuth path: getOAuthAccess returns a bearer (no `.`-delimited exp claim, so it
// is treated as non-expiring), making findPerplexityAuth pick the oauth branch.
const oauthAuthStorage = {
	async getOAuthAccess() {
		return { accessToken: "test-oauth-token" };
	},
	async getApiKey() {
		return undefined;
	},
	getCredentialOrigin(provider: string) {
		return provider === "perplexity" ? { kind: "oauth" } : undefined;
	},
	hasAuth() {
		return true;
	},
} as unknown as AuthStorage;

const anonymousAuthStorage = {
	async getOAuthAccess() {
		return undefined;
	},
	async getApiKey() {
		return undefined;
	},
	getCredentialOrigin() {
		return undefined;
	},
	hasAuth() {
		return false;
	},
} as unknown as AuthStorage;

function mockOAuth(
	capture: (body: Record<string, unknown>, headers: Headers) => void,
	eventOverrides: Record<string, unknown> = {},
): FetchImpl {
	const event = {
		final: true,
		display_model: "turbo",
		uuid: "req-oauth",
		blocks: [
			{ intended_usage: "ask_text", markdown_block: { answer: "OAuth answer" } },
			{
				intended_usage: "web_results",
				web_result_block: { web_results: [{ name: "T", url: "https://example.com", snippet: "s" }] },
			},
		],
		...eventOverrides,
	};
	const sseBody = `data: ${JSON.stringify(event)}\n\n`;
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === OAUTH_ASK_URL) {
			capture(JSON.parse(init?.body as string), new Headers(init?.headers));
			return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}
		return new Response("not mocked", { status: 500 });
	};
}

function mockAnonymous(capture: (body: Record<string, unknown>, headers: Headers) => void): FetchImpl {
	const answerPayload = {
		answer: "Anonymous answer",
		web_results: [{ name: "Example", url: "https://example.com", snippet: "s" }],
		chunks: ["Anonymous ", "answer"],
		structured_answer: [{ type: "markdown", text: "Anonymous answer", chunks: ["Anonymous ", "answer"] }],
	};
	const event = {
		final: true,
		display_model: "turbo",
		uuid: "req-anon",
		text: JSON.stringify([{ step_type: "FINAL", content: { answer: JSON.stringify(answerPayload) }, uuid: "" }]),
	};
	const sseBody = `data: ${JSON.stringify(event)}\n\n`;
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === OAUTH_ASK_URL) {
			capture(JSON.parse(init?.body as string), new Headers(init?.headers));
			return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}
		return new Response("not mocked", { status: 500 });
	};
}

describe("Perplexity OAuth request shape", () => {
	const savedCookies = process.env.PERPLEXITY_COOKIES;
	const savedModel = process.env.PI_PERPLEXITY_MODEL;

	beforeEach(() => {
		delete process.env.PERPLEXITY_COOKIES; // cookies take precedence over oauth; keep them out
		delete process.env.PI_PERPLEXITY_MODEL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
		if (savedModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
		else process.env.PI_PERPLEXITY_MODEL = savedModel;
	});

	it("sends the bare query, never the API-style system prompt, to the ask endpoint", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const fetchMock = mockOAuth((b, h) => {
			body = b;
			headers = h;
		});

		const response = await searchPerplexity({
			query: "quic vs tcp",
			system_prompt: "Research assistant with web search. Synthesize comprehensive answers.",
			authStorage: oauthAuthStorage,
			fetch: fetchMock,
		});

		// The consumer ask endpoint has no system slot; prepending the prompt makes
		// the model refuse ("I don't have web-search tools in this turn").
		expect(body).toBeDefined();
		expect(body!.query_str).toBe("quic vs tcp");
		const params = body!.params as Record<string, unknown>;
		expect(params.query_str).toBe("quic vs tcp");
		expect(params.model_preference).toBe("experimental");
		// The ask endpoint authenticates via the next-auth session cookie; a bearer
		// header is ignored and silently downgrades to the anonymous `turbo` model.
		expect(headers?.get("cookie")).toBe("__Secure-next-auth.session-token=test-oauth-token");
		expect(headers?.has("authorization")).toBe(false);
		expect(response.authMode).toBe("oauth");
		expect(response.answer).toBe("OAuth answer");
		// Authenticated streams sometimes report only the generic `turbo` alias;
		// preserve the requested subscription model instead of misreporting it.
		expect(response.model).toBe("experimental");
	});

	it("accepts a subscription model preference and reports it when the stream returns turbo", async () => {
		let body: Record<string, unknown> | undefined;
		const response = await searchPerplexity({
			query: "latest model",
			subscription_model: "pplx_reasoning",
			authStorage: oauthAuthStorage,
			fetch: mockOAuth(b => (body = b)),
		});

		expect((body!.params as Record<string, unknown>).model_preference).toBe("pplx_reasoning");
		expect(response.model).toBe("pplx_reasoning");
	});

	it("prefers the concrete user-selected model over the generic display alias", async () => {
		const response = await searchPerplexity({
			query: "latest model",
			authStorage: oauthAuthStorage,
			fetch: mockOAuth(() => {}, { user_selected_model: "pplx_pro_upgraded" }),
		});

		expect(response.model).toBe("pplx_pro_upgraded");
	});

	it("deduplicates equivalent subscription source URLs", async () => {
		const response = await searchPerplexity({
			query: "latest model",
			authStorage: oauthAuthStorage,
			fetch: mockOAuth(() => {}, {
				blocks: [
					{ intended_usage: "ask_text", markdown_block: { answer: "OAuth answer" } },
					{
						intended_usage: "web_results",
						web_result_block: {
							web_results: [
								{ name: "First", url: "https://EXAMPLE.com/path/" },
								{ name: "Duplicate", url: "https://example.com/path" },
							],
						},
					},
				],
			}),
		});

		expect(response.sources).toHaveLength(1);
	});

	it("maps directives onto ask-endpoint native filters and rewrites query_str", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = mockOAuth(b => (body = b));

		await searchPerplexity({
			query: "rust site:docs.rs -site:reddit.com after:2024-06-01",
			search_recency_filter: "month",
			authStorage: oauthAuthStorage,
			fetch: fetchMock,
		});

		expect(body!.query_str).toBe("rust");
		const params = body!.params as Record<string, unknown>;
		expect(params.query_str).toBe("rust");
		expect(params.search_domain_filter).toEqual(["docs.rs", "-reddit.com"]);
		expect(params.search_after_date_filter).toBe("6/1/2024");
		// Absolute date bounds take precedence over recency.
		expect(params.search_recency_filter).toBeNull();
	});
});

describe("Perplexity OAuth transport failure (issue #5315)", () => {
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		delete process.env.PERPLEXITY_COOKIES; // cookies precede oauth; keep them out
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	// Mirrors production: an active OAuth session makes getApiKey("perplexity")
	// return the OAuth JWT itself, and getCredentialOrigin reports origin "oauth".
	const oauthOriginStorage = {
		async getOAuthAccess() {
			return { accessToken: "oauth-session-jwt" };
		},
		async getApiKey(provider: string) {
			if (provider === "perplexity") return "oauth-session-jwt";
			return undefined;
		},
		getCredentialOrigin(provider: string) {
			return provider === "perplexity" ? { kind: "oauth" } : undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
		hasAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	it("does not emit a direct api-key config from the OAuth session token", async () => {
		const methods = await getAvailableAuthMethods(oauthOriginStorage, undefined, undefined);
		expect(methods.some(m => m.type === "oauth")).toBe(true);
		// The OAuth JWT must never appear as a Perplexity api_key config — that is
		// what got sent as a Bearer to api.perplexity.ai and rejected with 401.
		expect(methods.some(m => m.type === "api_key" && m.provider === "perplexity")).toBe(false);
	});

	it("retries the ask endpoint once on transport failure and never falls through to /chat/completions", async () => {
		let askCalls = 0;
		let apiCalls = 0;
		const event = {
			final: true,
			display_model: "pplx_pro",
			uuid: "req-oauth",
			blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "OAuth answer" } }],
		};
		const askBody = `data: ${JSON.stringify(event)}\n\n`;
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === OAUTH_ASK_URL) {
				askCalls++;
				if (askCalls === 1) throw new TypeError("socket connection closed before an HTTP response");
				return new Response(askBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			if (url === API_URL) {
				apiCalls++;
				return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchPerplexity({
			query: "OpenAI official website",
			authStorage: oauthOriginStorage,
			fetch: fetchMock,
		});

		expect(askCalls).toBe(2); // first fails at transport, second succeeds
		expect(apiCalls).toBe(0); // the OAuth token is never sent to the api-key endpoint
		expect(response.authMode).toBe("oauth");
		expect(response.answer).toBe("OAuth answer");
	});

	it("does not retry once an HTTP response is received", async () => {
		let askCalls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === OAUTH_ASK_URL) {
				askCalls++;
				return new Response("nope", { status: 401 });
			}
			return new Response("not mocked", { status: 500 });
		};

		await expect(
			searchPerplexity({ query: "q", authStorage: oauthOriginStorage, fetch: fetchMock }),
		).rejects.toThrow();
		expect(askCalls).toBe(1); // a real HTTP error is final, not retried
	});
});

describe("Perplexity anonymous fallback", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;
	const savedPplxKey = process.env.PPLX_API_KEY;
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PPLX_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
		if (savedPplxKey === undefined) delete process.env.PPLX_API_KEY;
		else process.env.PPLX_API_KEY = savedPplxKey;
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	it("uses the browser ask endpoint without credential headers when no key is configured", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const fetchMock = mockAnonymous((b, h) => {
			body = b;
			headers = h;
		});

		const response = await searchPerplexity({
			query: "anonymous search",
			authStorage: anonymousAuthStorage,
			fetch: fetchMock,
		});
		const requestParams = body?.params as Record<string, unknown>;

		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.has("cookie")).toBe(false);
		expect(headers?.get("user-agent")).toContain("Mozilla/5.0");
		expect(requestParams.model_preference).toBe("experimental");
		expect(requestParams.send_back_text_in_streaming_api).toBe(true);
		expect(requestParams.source).toBe("default");
		expect(response.authMode).toBe("anonymous");
		expect(response.answer).toBe("Anonymous answer");
		expect(response.sources).toEqual([
			{
				title: "Example",
				url: "https://example.com",
				snippet: "s",
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("keeps anonymous Perplexity out of auto provider selection but allows explicit selection", () => {
		const provider = new PerplexityProvider();

		expect(provider.isAvailable(anonymousAuthStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(anonymousAuthStorage)).toBe(true);
	});
});

describe("Perplexity OpenRouter auto-chain admission (issue #3251)", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;
	const savedPplxKey = process.env.PPLX_API_KEY;
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PPLX_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
		if (savedPplxKey === undefined) delete process.env.PPLX_API_KEY;
		else process.env.PPLX_API_KEY = savedPplxKey;
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	it("keeps Perplexity out of the auto chain when only OpenRouter auth is configured", () => {
		const openrouterOnly = {
			async getOAuthAccess() {
				return undefined;
			},
			async getApiKey() {
				return undefined;
			},
			hasAuth(provider: string) {
				return provider === "openrouter";
			},
		} as unknown as AuthStorage;

		const provider = new PerplexityProvider();

		// Auto chain MUST skip Perplexity so downstream providers (Gemini, ...)
		// get a chance instead of silently routing through OpenRouter's
		// `perplexity/sonar-pro` and billing the user for an unrequested path.
		expect(provider.isAvailable(openrouterOnly)).toBe(false);
		// Explicit selection still admits the provider so `webSearch: perplexity`
		// can opt into the OpenRouter-backed path on purpose.
		expect(provider.isExplicitlyAvailable(openrouterOnly)).toBe(true);
	});

	it("admits Perplexity to the auto chain when a direct Perplexity credential exists", () => {
		const perplexityOnly = {
			async getOAuthAccess() {
				return undefined;
			},
			async getApiKey() {
				return undefined;
			},
			hasAuth(provider: string) {
				return provider === "perplexity";
			},
		} as unknown as AuthStorage;

		const provider = new PerplexityProvider();

		expect(provider.isAvailable(perplexityOnly)).toBe(true);
	});
});

describe("Perplexity Authentication order", () => {
	const savedCookies = Bun.env.PERPLEXITY_COOKIES || process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		process.env.PERPLEXITY_COOKIES = "user-browser-cookies";
		Bun.env.PERPLEXITY_COOKIES = "user-browser-cookies";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedCookies === undefined) {
			delete process.env.PERPLEXITY_COOKIES;
			delete Bun.env.PERPLEXITY_COOKIES;
		} else {
			process.env.PERPLEXITY_COOKIES = savedCookies;
			Bun.env.PERPLEXITY_COOKIES = savedCookies;
		}
	});

	it("prefers cookies over OAuth in search", async () => {
		let headers: Headers | undefined;
		const fetchMock = mockOAuth((_, h) => {
			headers = h;
		});

		const mixedAuthStorage = {
			async getOAuthAccess() {
				return { accessToken: "test-oauth-token" };
			},
			async getApiKey() {
				return undefined;
			},
			getCredentialOrigin(provider: string) {
				return provider === "perplexity" ? { kind: "oauth" } : undefined;
			},
			hasAuth() {
				return true;
			},
		} as unknown as AuthStorage;

		const response = await searchPerplexity({
			query: "cookies precedence test",
			authStorage: mixedAuthStorage,
			fetch: fetchMock,
		});

		expect(headers?.get("cookie")).toBe("user-browser-cookies");
		expect(response.authMode).toBe("oauth");
	});

	it("prefers OAuth over API key in getAvailableAuthMethods (for token command)", async () => {
		delete process.env.PERPLEXITY_COOKIES;
		delete Bun.env.PERPLEXITY_COOKIES;

		const oauthAndApiKeyAuthStorage = {
			async getOAuthAccess() {
				return { accessToken: "oauth-token" };
			},
			async getApiKey(provider: string) {
				if (provider === "perplexity") return "api-key";
				return undefined;
			},
			getCredentialOrigin(provider: string) {
				return provider === "perplexity" ? { kind: "oauth" } : undefined;
			},
			hasAuth() {
				return true;
			},
		} as unknown as AuthStorage;

		const methods = await getAvailableAuthMethods(oauthAndApiKeyAuthStorage, undefined, undefined);
		const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
		expect(printable?.type).toBe("oauth");
		expect(printable?.type === "oauth" ? printable.access.accessToken : undefined).toBe("oauth-token");
	});
});
