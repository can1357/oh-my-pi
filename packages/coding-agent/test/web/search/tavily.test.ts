import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	buildRequestBody,
	searchTavily,
	type TavilySearchParams,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/tavily";

describe("Tavily buildRequestBody", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits topic entirely so Tavily uses its default general index", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("topic");
	});

	it("does not send time_range when recency is unset", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("time_range");
	});

	it("sends time_range when recency is set, without switching topic to news", () => {
		const body = buildRequestBody({
			query: "Bun 1.3 release notes",
			recency: "week",
		});
		expect(body.time_range).toBe("week");
		expect(body).not.toHaveProperty("topic");
	});

	it.each(["day", "week", "month", "year"] as const)("passes %s through as time_range verbatim", recency => {
		const body = buildRequestBody({ query: "q", recency });
		expect(body.time_range).toBe(recency);
		expect(body).not.toHaveProperty("topic");
	});

	it("always includes query, max_results, search_depth, and include_answer", () => {
		const body = buildRequestBody({ query: "q", num_results: 7 });
		expect(body.query).toBe("q");
		expect(body.max_results).toBe(7);
		expect(body.search_depth).toBe("basic");
		expect(body.include_answer).toBe("advanced");
		expect(body.include_raw_content).toBe(false);
	});

	it("prefers explicit start_date/end_date over time_range", () => {
		const body = buildRequestBody({ query: "q", recency: "week", start_date: "2026-01-01", end_date: "2026-02-01" });
		expect(body.start_date).toBe("2026-01-01");
		expect(body.end_date).toBe("2026-02-01");
		expect(body).not.toHaveProperty("time_range");
	});
});

describe("Tavily searchTavily request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.TAVILY_API_KEY ?? undefined;
		},
		resolver: vi.fn(() => async () => process.env.TAVILY_API_KEY ?? undefined),
		hasAuth() {
			return Boolean(process.env.TAVILY_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<TavilySearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Tavily integration test prompt",
			...extras,
		};
	}

	it("does not send topic=news to the upstream API when recency is set", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						answer: "test answer",
						results: [
							{
								title: "Bun v1.3.12",
								url: "https://bun.com/blog/bun-v1.3.12",
								content: "release notes",
								published_date: "2026-04-09",
							},
						],
						request_id: "req-123",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchTavily({
			...makeParams("Bun runtime latest release notes", { recency: "week" }),
			fetch: fetchMock,
		});

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody?.time_range).toBe("week");
		expect(capturedBody?.query).toBe("Bun runtime latest release notes");

		expect(response.provider).toBe("tavily");
		expect(response.answer).toBe("test answer");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.url).toBe("https://bun.com/blog/bun-v1.3.12");
	});

	it("omits time_range entirely when recency is not provided", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(JSON.stringify({ answer: "", results: [], request_id: "req-0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchTavily({ ...makeParams("bun sqlite"), fetch: fetchMock });

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody).not.toHaveProperty("time_range");
	});

	it("maps site: directives to include/exclude_domains and strips them from the query", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						answer: "test answer",
						results: [{ title: "Pricing", url: "https://tavily.com/pricing", content: "plans" }],
						request_id: "req-1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchTavily({
			...makeParams("pricing site:tavily.com -site:reddit.com"),
			fetch: fetchMock,
		});

		expect(capturedBody).toBeDefined();
		expect(capturedBody?.include_domains).toEqual(["tavily.com"]);
		expect(capturedBody?.exclude_domains).toEqual(["reddit.com"]);
		expect(capturedBody?.query).toBe("pricing");
	});

	it("maps after:/before: to start_date/end_date and retries without them on empty results", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		const capturedBodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBodies.push(JSON.parse(init?.body as string));
				const empty = capturedBodies.length === 1;
				return new Response(
					JSON.stringify({
						answer: "",
						results: empty ? [] : [{ title: "Post", url: "https://example.com/post", content: "text" }],
						request_id: `req-${capturedBodies.length}`,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchTavily({
			...makeParams('"llm agents" after:2026-01-01 before:2026-06-01'),
			fetch: fetchMock,
		});

		expect(capturedBodies).toHaveLength(2);
		expect(capturedBodies[0]?.start_date).toBe("2026-01-01");
		expect(capturedBodies[0]?.end_date).toBe("2026-06-01");
		expect(capturedBodies[0]?.query).toBe('"llm agents"');
		expect(capturedBodies[1]).not.toHaveProperty("start_date");
		expect(capturedBodies[1]).not.toHaveProperty("end_date");
		expect(response.sources).toHaveLength(1);
	});

	it("ignores malformed response fields while preserving valid results", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					answer: 42,
					results: [
						null,
						{ title: 7, url: "https://example.com/valid", content: 99, published_date: false },
						{ title: "Missing URL" },
					],
					request_id: 123,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchTavily({ ...makeParams("robust parsing"), fetch: fetchMock });

		expect(response.answer).toBeUndefined();
		expect(response.requestId).toBeUndefined();
		expect(response.sources).toEqual([
			{
				title: "https://example.com/valid",
				url: "https://example.com/valid",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});
});
