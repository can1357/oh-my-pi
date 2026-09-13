import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyMCPEnvironment, isExaEnvHelperInjected } from "@oh-my-pi/pi-coding-agent/mcp/reload";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	buildExaRequestBody,
	ExaProvider,
	normalizeSearchType,
	resetExaSearchThrottleForTest,
	searchExa,
	synthesizeAnswer,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { mockFetch as wrapFetch } from "../helpers/fetch-mock";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-exa-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

// ────────────────────────────────────────────────────────────
// Unit tests for pure helpers (no mocking needed)
// ────────────────────────────────────────────────────────────

describe("normalizeSearchType", () => {
	it("returns 'auto' for undefined input", () => {
		expect(normalizeSearchType(undefined)).toBe("auto");
	});

	it("maps 'keyword' to 'fast'", () => {
		expect(normalizeSearchType("keyword")).toBe("fast");
	});

	it("passes through 'neural' unchanged", () => {
		expect(normalizeSearchType("neural")).toBe("neural");
	});

	it("passes through 'deep' unchanged", () => {
		expect(normalizeSearchType("deep")).toBe("deep");
	});

	it("passes through 'auto' unchanged", () => {
		expect(normalizeSearchType("auto")).toBe("auto");
	});

	it("passes through 'fast' unchanged", () => {
		expect(normalizeSearchType("fast")).toBe("fast");
	});
});

describe("buildExaRequestBody", () => {
	it("builds correct minimal body with defaults", () => {
		const body = buildExaRequestBody({ query: "test query" });
		expect(body).toEqual({
			query: "test query",
			numResults: 10,
			type: "auto",
			contents: { summary: { query: "test query" } },
		});
	});

	it("applies num_results override", () => {
		const body = buildExaRequestBody({ query: "q", num_results: 5 });
		expect(body.numResults).toBe(5);
	});

	it("normalizes keyword type to fast", () => {
		const body = buildExaRequestBody({ query: "q", type: "keyword" });
		expect(body.type).toBe("fast");
	});

	it("includes domain filters when specified", () => {
		const body = buildExaRequestBody({
			query: "q",
			include_domains: ["example.com"],
			exclude_domains: ["bad.com"],
		});
		expect(body.includeDomains).toEqual(["example.com"]);
		expect(body.excludeDomains).toEqual(["bad.com"]);
	});

	it("omits domain filters when arrays are empty", () => {
		const body = buildExaRequestBody({
			query: "q",
			include_domains: [],
			exclude_domains: [],
		});
		expect(body.includeDomains).toBeUndefined();
		expect(body.excludeDomains).toBeUndefined();
	});

	it("includes date filters when specified", () => {
		const body = buildExaRequestBody({
			query: "q",
			start_published_date: "2024-01-01",
			end_published_date: "2024-12-31",
		});
		expect(body.startPublishedDate).toBe("2024-01-01");
		expect(body.endPublishedDate).toBe("2024-12-31");
	});
});

describe("synthesizeAnswer", () => {
	it("returns undefined when results array is empty", () => {
		expect(synthesizeAnswer([])).toBeUndefined();
	});

	it("returns undefined when no result has a summary", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: null },
			{ title: "B", url: "https://b.com", summary: undefined },
			{ title: "C", url: "https://c.com" },
		];
		expect(synthesizeAnswer(results)).toBeUndefined();
	});

	it("returns undefined when summaries are empty strings", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: "" },
			{ title: "B", url: "https://b.com", summary: "   " },
		];
		expect(synthesizeAnswer(results)).toBeUndefined();
	});

	it("synthesizes answer from a single summary", () => {
		const results = [{ title: "Page One", url: "https://one.com", summary: "Summary of page one." }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**Page One**: Summary of page one.");
	});

	it("synthesizes answer from multiple summaries joined by double newlines", () => {
		const results = [
			{ title: "A", url: "https://a.com", summary: "Summary A" },
			{ title: "B", url: "https://b.com", summary: "Summary B" },
		];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**A**: Summary A\n\n**B**: Summary B");
	});

	it("skips results with missing summaries but includes ones that have them", () => {
		const results = [
			{ title: "NoSummary", url: "https://no.com", summary: null },
			{ title: "HasSummary", url: "https://yes.com", summary: "Good stuff" },
		];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**HasSummary**: Good stuff");
	});

	it("uses url as fallback title when title is missing", () => {
		const results = [{ url: "https://notitle.com", summary: "Content here" }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**https://notitle.com**: Content here");
	});

	it("uses 'Untitled' when both title and url are missing", () => {
		const results = [{ summary: "Orphan content" }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**Untitled**: Orphan content");
	});

	it("trims whitespace from summaries", () => {
		const results = [{ title: "T", url: "https://t.com", summary: "  padded summary  " }];
		const answer = synthesizeAnswer(results);
		expect(answer).toBe("**T**: padded summary");
	});
});

// ────────────────────────────────────────────────────────────
// Integration tests for searchExa (mock fetch + env)
// ────────────────────────────────────────────────────────────

function makeMockExaResponse(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "req-123",
		resolvedSearchType: "auto",
		results: [
			{
				title: "Page Alpha",
				url: "https://alpha.com",
				author: "Author A",
				publishedDate: "2024-06-01",
				text: "Full text of alpha",
				highlights: ["highlight alpha"],
				summary: "Alpha is about X.",
			},
			{
				title: "Page Beta",
				url: "https://beta.com",
				author: null,
				publishedDate: null,
				text: null,
				highlights: null,
				summary: "Beta covers Y.",
			},
			{
				title: "Page Gamma",
				url: "https://gamma.com",
				author: "Author G",
				publishedDate: "2024-07-15",
				text: "Gamma text",
				highlights: ["gamma hl"],
				summary: "Gamma discusses Z.",
			},
		],
		...overrides,
	};
}

describe("searchExa", () => {
	let capturedRequestBody: Record<string, unknown> | null = null;

	beforeEach(async () => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 0 } });
		capturedRequestBody = null;
		process.env.EXA_API_KEY = "test-key-123";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetExaSearchThrottleForTest();
		resetSettingsForTest();
		delete process.env.EXA_API_KEY;
	});

	function mockFetch(responseBody: unknown, status = 200): FetchImpl {
		return (_url, init) => {
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify(responseBody), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};
	}

	it("populates answer from per-result summaries", async () => {
		const result = await searchExa({ query: "test query", fetch: mockFetch(makeMockExaResponse()) });
		expect(result.provider).toBe("exa");
		expect(result.answer).toBeDefined();
		expect(result.answer).toContain("**Page Alpha**: Alpha is about X.");
		expect(result.answer).toContain("**Page Beta**: Beta covers Y.");
		expect(result.answer).toContain("**Page Gamma**: Gamma discusses Z.");
		expect(result.requestId).toBe("req-123");
	});

	it("returns answer=undefined when no summaries are present", async () => {
		const result = await searchExa({
			query: "no answer query",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [{ title: "No Summary", url: "https://nosummary.com", text: "some text" }],
				}),
			),
		});
		expect(result.provider).toBe("exa");
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(1);
	});

	it("returns answer=undefined when results array is empty", async () => {
		const result = await searchExa({ query: "empty", fetch: mockFetch(makeMockExaResponse({ results: [] })) });
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(0);
	});

	it("returns answer=undefined when results is missing from response", async () => {
		const result = await searchExa({ query: "nothing", fetch: mockFetch({ requestId: "req-empty" }) });
		expect(result.answer).toBeUndefined();
		expect(result.sources).toHaveLength(0);
	});

	it("sends contents.summary in request body", async () => {
		await searchExa({ query: "check body", fetch: mockFetch(makeMockExaResponse()) });
		expect(capturedRequestBody).toBeDefined();
		expect(capturedRequestBody!.contents).toEqual({ summary: { query: "check body" } });
	});

	it("sends correct full request shape", async () => {
		await searchExa({ query: "shape test", num_results: 5, type: "neural", fetch: mockFetch(makeMockExaResponse()) });
		expect(capturedRequestBody).toEqual({
			query: "shape test",
			numResults: 5,
			type: "neural",
			contents: { summary: { query: "shape test" } },
		});
	});
	it("maps site:/before: directives to native Exa params with an operator-free query", async () => {
		await withLocalAuthStorage(authStorage =>
			new ExaProvider().search({
				query: "vector db benchmarks site:qdrant.tech before:2025-01-01",
				systemPrompt: "",
				authStorage,
				fetch: mockFetch(makeMockExaResponse()),
			}),
		);
		expect(capturedRequestBody!.query).toBe("vector db benchmarks");
		expect(capturedRequestBody!.includeDomains).toEqual(["qdrant.tech"]);
		expect(capturedRequestBody!.endPublishedDate).toBe("2025-01-01");
		expect(capturedRequestBody!.startPublishedDate).toBeUndefined();
		expect(capturedRequestBody!.excludeDomains).toBeUndefined();
	});

	it("sends directive-free queries byte-identical with no domain/date params", async () => {
		await withLocalAuthStorage(authStorage =>
			new ExaProvider().search({
				query: "plain natural language question",
				systemPrompt: "",
				authStorage,
				fetch: mockFetch(makeMockExaResponse()),
			}),
		);
		expect(capturedRequestBody).toEqual({
			query: "plain natural language question",
			numResults: 10,
			type: "auto",
			contents: { summary: { query: "plain natural language question" } },
		});
	});

	it("paces consecutive Exa API requests by the configured delay", async () => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 25 } });
		const requestTimes: number[] = [];
		const fetchMock: FetchImpl = (_url, init) => {
			requestTimes.push(Date.now());
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify(makeMockExaResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchExa({ query: "first paced request", fetch: fetchMock });
		await searchExa({ query: "second paced request", fetch: fetchMock });

		expect(requestTimes).toHaveLength(2);
		expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(20);
	});

	it("aborts while waiting for the configured Exa request delay", async () => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 1_000 } });
		let fetchCount = 0;
		const fetchMock: FetchImpl = () => {
			fetchCount += 1;
			return Promise.resolve(
				new Response(JSON.stringify(makeMockExaResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchExa({ query: "first request", fetch: fetchMock });
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = searchExa({ query: "cancelled request", fetch: fetchMock, signal: controller.signal });
		await Bun.sleep(0);
		controller.abort(new Error("cancelled Exa throttle wait"));

		await expect(pending).rejects.toThrow("cancelled Exa throttle wait");
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(fetchCount).toBe(1);
	});

	it("aborts while queued behind another Exa throttle wait", async () => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 1_000 } });
		let fetchCount = 0;
		const fetchMock: FetchImpl = () => {
			fetchCount += 1;
			return Promise.resolve(
				new Response(JSON.stringify(makeMockExaResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchExa({ query: "first request", fetch: fetchMock });
		const secondController = new AbortController();
		const thirdController = new AbortController();
		const second = searchExa({ query: "second request", fetch: fetchMock, signal: secondController.signal });
		const startedAt = Date.now();
		const third = searchExa({ query: "third request", fetch: fetchMock, signal: thirdController.signal });
		await Bun.sleep(0);
		thirdController.abort(new Error("cancelled queued Exa throttle wait"));

		await expect(third).rejects.toThrow("cancelled queued Exa throttle wait");
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(fetchCount).toBe(1);

		secondController.abort(new Error("cleanup second Exa throttle wait"));
		await expect(second).rejects.toThrow("cleanup second Exa throttle wait");
	});

	it("prefers summary over text for snippet field", async () => {
		const result = await searchExa({
			query: "snippet test",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [
						{ title: "Has Both", url: "https://both.com", text: "full text here", summary: "summary here" },
					],
				}),
			),
		});
		expect(result.sources[0].snippet).toBe("summary here");
	});

	it("caps snippets at 500 characters", async () => {
		const result = await searchExa({
			query: "bounded snippet",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [{ title: "Long", url: "https://long.example", summary: "x".repeat(800) }],
				}),
			),
		});

		expect(result.sources[0].snippet).toHaveLength(500);
	});

	it("falls back to text when summary is null", async () => {
		const result = await searchExa({
			query: "fallback",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [{ title: "Text Only", url: "https://text.com", text: "fallback text", summary: null }],
				}),
			),
		});
		expect(result.sources[0].snippet).toBe("fallback text");
	});

	it("falls back to highlights when both summary and text are null", async () => {
		const result = await searchExa({
			query: "highlights",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [
						{
							title: "Highlight Only",
							url: "https://hl.com",
							text: null,
							summary: null,
							highlights: ["hl1", "hl2"],
						},
					],
				}),
			),
		});
		expect(result.sources[0].snippet).toBe("hl1 hl2");
	});

	it("skips results without url", async () => {
		const result = await searchExa({
			query: "url filter",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [
						{ title: "No URL", url: null, summary: "orphan" },
						{ title: "Has URL", url: "https://valid.com", summary: "valid" },
					],
				}),
			),
		});
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0].url).toBe("https://valid.com");
	});

	it("falls back to text when summary is empty string (not just null)", async () => {
		const result = await searchExa({
			query: "empty summary fallback",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [{ title: "Empty Summary", url: "https://empty.com", text: "real text", summary: "" }],
				}),
			),
		});
		expect(result.sources[0].snippet).toBe("real text");
	});

	it("does not include url-less results in synthesized answer", async () => {
		const result = await searchExa({
			query: "url filter answer",
			fetch: mockFetch(
				makeMockExaResponse({
					results: [
						{ title: "No URL", url: null, summary: "ghost summary" },
						{ title: "Has URL", url: "https://valid.com", summary: "real summary" },
					],
				}),
			),
		});
		expect(result.answer).toBeDefined();
		expect(result.answer).not.toContain("ghost summary");
		expect(result.answer).toContain("**Has URL**: real summary");
	});

	it("uses Exa MCP when API key is missing", async () => {
		delete process.env.EXA_API_KEY;
		let calledUrl = "";
		const fetchMock: FetchImpl = (url, init) => {
			calledUrl = String(url);
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ jsonrpc: "2.0", id: "mcp-1", result: makeMockExaResponse() }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		const result = await searchExa({ query: "no key", fetch: fetchMock });

		expect(result.provider).toBe("exa");
		expect(result.sources).toHaveLength(3);
		expect(calledUrl).toContain("https://mcp.exa.ai/mcp");
		expect(calledUrl).toContain("tools=web_search_exa");
		expect(calledUrl).not.toContain("exaApiKey=");
		expect(capturedRequestBody?.method).toBe("tools/call");
		expect(capturedRequestBody?.params).toEqual({
			name: "web_search_exa",
			arguments: { query: "no key" },
		});
	});

	it("encodes MCP filters in the basic query, uses camel-case result count, and tags the request source", async () => {
		delete process.env.EXA_API_KEY;
		let headers: Record<string, string> | undefined;
		const fetchMock: FetchImpl = (_url, init) => {
			headers = init?.headers as Record<string, string> | undefined;
			if (init?.body) capturedRequestBody = JSON.parse(init.body as string);
			return Promise.resolve(
				new Response(JSON.stringify({ jsonrpc: "2.0", id: "mcp-filtered", result: makeMockExaResponse() }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await searchExa({
			query: "vector databases",
			num_results: 4,
			include_domains: [" qdrant.tech "],
			exclude_domains: ["spam.example"],
			start_published_date: "2024-01-01",
			end_published_date: "2025-01-01",
			fetch: fetchMock,
		});

		expect(headers?.["x-exa-source"]).toBe("oh-my-pi");
		expect(capturedRequestBody?.params).toEqual({
			name: "web_search_exa",
			arguments: {
				query: "vector databases site:qdrant.tech -site:spam.example after:2024-01-01 before:2025-01-01",
				numResults: 4,
			},
		});
	});

	it("explains how to escape the keyless MCP rate limit", async () => {
		delete process.env.EXA_API_KEY;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("too many requests", { status: 429, statusText: "Too Many Requests" }));

		await expect(searchExa({ query: "rate limited", fetch: fetchMock })).rejects.toThrow(
			"exa: MCP rate limit reached (429); configure an Exa API key for higher limits",
		);
	});

	it("surfaces MCP tool-level errors", async () => {
		delete process.env.EXA_API_KEY;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "mcp-error",
						result: { isError: true, content: [{ type: "text", text: "tool quota exceeded" }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		await expect(searchExa({ query: "tool error", fetch: fetchMock })).rejects.toThrow("tool quota exceeded");
	});

	it("parses Exa MCP plain-text payloads when API key is missing", async () => {
		delete process.env.EXA_API_KEY;
		const fetchMock: FetchImpl = () => {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "mcp-text",
						result: {
							content: [
								{
									type: "text",
									text: "Title: Plain Result\nURL: https://plain.example\nAuthor: Reporter\nPublished Date: 2024-06-01\nText: Plain text body",
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const result = await searchExa({ query: "plain text", fetch: fetchMock });

		expect(result.provider).toBe("exa");
		expect(result.sources).toEqual([
			{
				title: "Plain Result",
				url: "https://plain.example",
				snippet: "Plain text body",
				publishedDate: "2024-06-01",
				ageSeconds: expect.any(Number),
				author: "Reporter",
			},
		]);
	});

	it("uses AuthStorage credentials when EXA_API_KEY is unset", async () => {
		delete process.env.EXA_API_KEY;
		let receivedKey: string | undefined;
		const fetchMock: FetchImpl = (_url, init) => {
			receivedKey = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
			return Promise.resolve(
				new Response(JSON.stringify(makeMockExaResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await withLocalAuthStorage(async authStorage => {
			authStorage.setRuntimeApiKey("exa", "stored-key-xyz");
			const result = await searchExa({ query: "from auth storage", authStorage, fetch: fetchMock });
			expect(result.provider).toBe("exa");
			expect(result.sources).toHaveLength(3);
		});
		expect(receivedKey).toBe("stored-key-xyz");
	});

	it("reports unavailable for the auto chain without EXA_API_KEY or stored credentials", async () => {
		delete process.env.EXA_API_KEY;
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage)),
		);
		expect(available).toBe(false);
	});

	it("reports explicitly available without credentials so the MCP fallback runs", async () => {
		delete process.env.EXA_API_KEY;
		const explicit = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isExplicitlyAvailable(authStorage)),
		);
		expect(explicit).toBe(true);
	});

	it("reports available with EXA_API_KEY", async () => {
		process.env.EXA_API_KEY = "test-key-123";
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage)),
		);
		expect(available).toBe(true);
	});

	it("reports available when AuthStorage holds a credential", async () => {
		delete process.env.EXA_API_KEY;
		const available = await withLocalAuthStorage(authStorage => {
			authStorage.setRuntimeApiKey("exa", "stored-key");
			return Promise.resolve(new ExaProvider().isAvailable(authStorage));
		});
		expect(available).toBe(true);
	});

	it("reports available for the auto chain on the session's own discovered key alone", async () => {
		// `search()` accepts `sessionExaApiKey`, so a session holding one can
		// service the request with the environment empty and no broker
		// credential — the state left behind when the session that injected
		// `EXA_API_KEY` removes it. Without the key in the availability check the
		// auto chain skips Exa and falls through to another provider.
		delete process.env.EXA_API_KEY;
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: "my-own-session-key" })),
		);
		expect(available).toBe(true);
	});

	it("stays unavailable when no session key accompanies the empty environment", async () => {
		// The context is not a blanket yes: an absent or empty session key must
		// leave the verdict exactly where it was.
		delete process.env.EXA_API_KEY;
		const verdicts = await withLocalAuthStorage(authStorage =>
			Promise.resolve([
				new ExaProvider().isAvailable(authStorage, {}),
				new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: undefined }),
				new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: "" }),
			]),
		);
		expect(verdicts).toEqual([false, false, false]);
	});

	it("keeps the settings kill switch ahead of a session key", async () => {
		// `exa.enabled: false` is an operator refusal; a per-request credential
		// must not reopen the provider.
		delete process.env.EXA_API_KEY;
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": false, "exa.searchDelayMs": 0 } });
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: "my-own-session-key" })),
		);
		expect(available).toBe(false);
	});

	it("throws SearchProviderError on non-ok HTTP response", async () => {
		await expect(searchExa({ query: "forbidden", fetch: mockFetch("Forbidden", 403) })).rejects.toThrow(
			"exa: 403 forbidden",
		);
	});
});

// `EXA_API_KEY` is process-global while Exa credentials are per-session MCP
// config, so the session key must outrank an environment value ANOTHER session
// injected — otherwise every later session authenticates as whichever one
// injected first. But it must NOT outrank the OPERATOR's own export:
// `applyMCPEnvironment` deliberately refuses to overwrite a foreign value to
// honor that documented override, while still recording the config-discovered
// key for the session. Ranking the recorded key first therefore defeated the
// override silently.
describe("searchExa: EXA_API_KEY vs the session's MCP-discovered key", () => {
	// `Bun.env` is a string map at runtime, but TypeScript pins a deleted
	// property's type to `undefined`, so read/write through a widened alias.
	const env: Record<string, string | undefined> = Bun.env;

	beforeEach(async () => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 0 } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetExaSearchThrottleForTest();
		resetSettingsForTest();
		delete env.EXA_API_KEY;
	});

	/** Runs one search and reports the `x-api-key` the native Exa client sent. */
	async function keyUsedForSearch(sessionExaApiKey?: string): Promise<string | undefined> {
		let sent: string | undefined;
		const result = await searchExa({
			query: "precedence probe",
			sessionExaApiKey,
			fetch: wrapFetch((_url, init) => {
				sent = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
				return new Response(JSON.stringify(makeMockExaResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		});
		expect(result.provider).toBe("exa");
		return sent;
	}

	it("keeps an operator-exported EXA_API_KEY ahead of a discovered session key", async () => {
		env.EXA_API_KEY = "operator-exported-key";
		// The operator's value is FOREIGN to the injection helper: it never
		// installed it, so a reload leaves it alone. Discovery still recorded the
		// MCP-configured key for this session.
		expect(isExaEnvHelperInjected()).toBe(false);

		// Pre-fix the recorded key was picked unconditionally, so search
		// authenticated to the MCP-configured account despite the export.
		expect(await keyUsedForSearch("mcp-configured-key")).toBe("operator-exported-key");
	});

	it("prefers the session key over an EXA_API_KEY the harness itself injected", async () => {
		// A peer top-level session's reload put its own key in the environment.
		// That is not an operator override, and reading it would make THIS session
		// authenticate as the peer.
		const owner = {};
		applyMCPEnvironment({ exaApiKeys: ["peer-injected-key"] }, owner);
		expect(env.EXA_API_KEY).toBe("peer-injected-key");
		expect(isExaEnvHelperInjected()).toBe(true);

		expect(await keyUsedForSearch("my-own-session-key")).toBe("my-own-session-key");
	});

	it("is unavailable to the auto chain when only a peer-injected key exists", async () => {
		// Admission has to agree with `searchExa`: it refuses a helper-owned key,
		// so admitting on one sent the session into the keyless MCP fallback —
		// documented as explicit-selection-only — instead of its next provider.
		const owner = {};
		applyMCPEnvironment({ exaApiKeys: ["peer-injected-key"] }, owner);
		expect(env.EXA_API_KEY).toBe("peer-injected-key");

		const authStorage = await AuthStorage.create(":memory:");
		try {
			expect(new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: undefined })).toBe(false);
			// Its own key still admits, and so does an operator export.
			expect(new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: "my-own-key" })).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	it("stays available to the auto chain on an operator-exported key", async () => {
		// The distinction the fix turns on: a foreign export is a deliberate
		// process-wide credential, so it must keep admitting.
		env.EXA_API_KEY = "operator-exported-key";
		expect(isExaEnvHelperInjected()).toBe(false);

		const authStorage = await AuthStorage.create(":memory:");
		try {
			expect(new ExaProvider().isAvailable(authStorage, { sessionExaApiKey: undefined })).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	it("does not borrow a peer-injected EXA_API_KEY when this session discovered no key", async () => {
		// The gap between the two tests above: helper-owned environment AND no
		// session key. Falling back to the environment here bills the peer's
		// account, so the keyless MCP path is the correct answer.
		const owner = {};
		applyMCPEnvironment({ exaApiKeys: ["peer-injected-key"] }, owner);
		expect(env.EXA_API_KEY).toBe("peer-injected-key");
		expect(isExaEnvHelperInjected()).toBe(true);

		// Both transports have to be covered: the native path selected the key
		// directly, and the MCP path re-reads the environment through
		// `findApiKey()`, so a fix to one alone still leaked on the other.
		const urls: string[] = [];
		let nativeApiKeyHeader: string | undefined;
		await searchExa({
			query: "precedence probe",
			sessionExaApiKey: undefined,
			fetch: wrapFetch((url, init) => {
				urls.push(String(url));
				nativeApiKeyHeader ??= (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "1",
						result: { content: [{ type: "text", text: JSON.stringify(makeMockExaResponse()) }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		});

		// Pre-fix the native `?? envKey` fallback sent the peer's key as a header,
		// and `callExaMcpSearch` put it in `exaApiKey` on the query.
		expect(nativeApiKeyHeader).toBeUndefined();
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) expect(url).not.toContain("peer-injected-key");
	});

	it("does not authenticate through AuthStorage with a peer-injected EXA_API_KEY", async () => {
		// One layer under the fallback above: `AuthStorage.getApiKey` resolves the
		// dedicated env var ITSELF, so a session holding its own key still had the
		// peer's key returned as `storedKey`, took the resolver branch, and billed
		// the peer's account — the session key never got a say.
		const owner = {};
		applyMCPEnvironment({ exaApiKeys: ["peer-injected-key"] }, owner);
		expect(isExaEnvHelperInjected()).toBe(true);

		const authStorage = await AuthStorage.create(":memory:");
		try {
			let sent: string | undefined;
			await searchExa({
				query: "precedence probe",
				sessionExaApiKey: "my-own-session-key",
				authStorage,
				fetch: wrapFetch((_url, init) => {
					sent = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
					return new Response(JSON.stringify(makeMockExaResponse()), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}),
			});
			expect(sent).toBe("my-own-session-key");
		} finally {
			authStorage.close();
		}
	});

	it("still authenticates through AuthStorage with an operator-exported key", async () => {
		// Positive control for the exclusion: a deliberate process-wide export
		// must keep resolving, or the fix would simply disable the env path.
		env.EXA_API_KEY = "operator-exported-key";
		expect(isExaEnvHelperInjected()).toBe(false);

		const authStorage = await AuthStorage.create(":memory:");
		try {
			let sent: string | undefined;
			await searchExa({
				query: "precedence probe",
				sessionExaApiKey: "my-own-session-key",
				authStorage,
				fetch: wrapFetch((_url, init) => {
					sent = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
					return new Response(JSON.stringify(makeMockExaResponse()), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}),
			});
			expect(sent).toBe("operator-exported-key");
		} finally {
			authStorage.close();
		}
	});

	it("falls back to EXA_API_KEY when this session discovered no key", async () => {
		env.EXA_API_KEY = "operator-exported-key";
		expect(await keyUsedForSearch(undefined)).toBe("operator-exported-key");
	});

	it("uses the session key when the environment carries nothing at all", async () => {
		delete env.EXA_API_KEY;
		expect(await keyUsedForSearch("my-own-session-key")).toBe("my-own-session-key");
	});
});
