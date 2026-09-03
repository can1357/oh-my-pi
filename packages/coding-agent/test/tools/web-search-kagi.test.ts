import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { type KagiSearchRequest, searchWithKagi } from "@oh-my-pi/pi-coding-agent/web/kagi";
import { KagiProvider, searchKagi } from "@oh-my-pi/pi-coding-agent/web/search/providers/kagi";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		return process.env.KAGI_API_KEY ?? undefined;
	},
	resolver() {
		return async () => process.env.KAGI_API_KEY ?? undefined;
	},
	hasAuth() {
		return Boolean(process.env.KAGI_API_KEY);
	},
} as unknown as AuthStorage;

describe("Kagi web search error handling", () => {
	beforeEach(() => {
		process.env.KAGI_API_KEY = "test-kagi-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
	});

	it("maps auth failures to a compact provider-tagged error", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ error: [{ code: 401, message: "Invalid API key or access denied." }] }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});

		try {
			await searchKagi({ query: "kagi test", authStorage: fakeAuthStorage, fetch: fetchMock });
			expect.unreachable("expected searchKagi to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "kagi", status: 401 });
			expect((error as Error).message).toBe("kagi: 401 unauthorized");
		}
	});

	it("falls back to plain text for non-JSON error bodies", async () => {
		const fetchMock: FetchImpl = async () => new Response("service unavailable", { status: 503 });

		await expect(searchWithKagi("plain text error", { fetch: fetchMock }, fakeAuthStorage)).rejects.toThrow(
			"Kagi API error (503): service unavailable",
		);
	});

	it("maps HTTP 5xx errors with empty body", async () => {
		const fetchMock: FetchImpl = async () => new Response("", { status: 502 });

		await expect(searchWithKagi("empty error", { fetch: fetchMock }, fakeAuthStorage)).rejects.toThrow(
			"Kagi API error (502)",
		);
	});

	it("reports malformed success responses as Kagi API errors", async () => {
		const invalidJsonFetch: FetchImpl = async () => new Response("<html>not json</html>", { status: 200 });
		const invalidEnvelopeFetch: FetchImpl = async () =>
			new Response(JSON.stringify(["unexpected"]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		await expect(searchWithKagi("invalid json", { fetch: invalidJsonFetch }, fakeAuthStorage)).rejects.toThrow(
			"Kagi API returned an invalid response: invalid JSON",
		);
		await expect(
			searchWithKagi("invalid envelope", { fetch: invalidEnvelopeFetch }, fakeAuthStorage),
		).rejects.toThrow("Kagi API returned an invalid response: expected an object envelope");
	});

	it("recognizes errors plural in a successful HTTP envelope", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ errors: [{ code: 429, message: "quota exceeded" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		await expect(searchWithKagi("envelope error", { fetch: fetchMock }, fakeAuthStorage)).rejects.toThrow(
			"Kagi API error (429): quota exceeded",
		);
	});
	it("applies the configured timeout at the provider fetch boundary", async () => {
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
		let fetchSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			fetchSignal = init?.signal;
			return new Response(JSON.stringify({ meta: { trace: "req-timeout" }, data: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await new KagiProvider().search({
			query: "slow kagi search",
			systemPrompt: "",
			authStorage: fakeAuthStorage,
			timeoutMs: 180_000,
			fetch: fetchMock,
		});

		expect(timeoutSpy).toHaveBeenCalledWith(180_000);
		expect(fetchSignal).toBe(timeoutSignal);
	});
});

describe("Kagi search result parsing", () => {
	beforeEach(() => {
		process.env.KAGI_API_KEY = "test-kagi-key";
		setSystemTime(new Date("2026-05-25T00:00:00Z"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
		setSystemTime();
	});

	it("parses categorized response with search + video + news + related_search", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					meta: { trace: "req-success" },
					data: {
						search: [
							{
								url: "https://example.com/article",
								title: "Example Article",
								snippet: "Example snippet text",
								time: "2025-06-01T00:00:00Z",
							},
						],
						video: [
							{
								url: "https://example.com/video",
								title: "Example Video",
								snippet: "Video description",
								time: "2025-06-02T00:00:00Z",
							},
						],
						news: [
							{
								url: "https://example.com/news",
								title: "Breaking News",
								snippet: "News snippet",
								time: "2025-06-03T00:00:00Z",
							},
						],
						related_search: [
							{
								title: "Related One",
								url: "https://example.com/rs1",
								props: { question: "related query one" },
							},
							{
								title: "Related Two",
								url: "https://example.com/rs2",
								props: { question: "related query two" },
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await searchWithKagi("success case", { fetch: fetchMock }, fakeAuthStorage);

		expect(result.requestId).toBe("req-success");
		expect(result.sources).toHaveLength(3);
		expect(result.sources[0]).toMatchObject({
			title: "Example Article",
			url: "https://example.com/article",
			snippet: "Example snippet text",
			publishedDate: "2025-06-01T00:00:00Z",
		});
		expect(result.sources[1]).toMatchObject({ title: "[Video] Example Video", url: "https://example.com/video" });
		expect(result.sources[2]).toMatchObject({ title: "[News] Breaking News", url: "https://example.com/news" });
		expect(result.relatedQuestions).toEqual(["related query one", "related query two"]);
		expect(result.answer).toBeUndefined();
	});

	it("accepts documented result aliases and skips malformed items", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: {
						search: [
							null,
							{ title: "Missing URL" },
							{
								href: "https://example.com/alias",
								name: "Alias Result",
								description: "Alias description",
							},
						],
						related_search: { invalid: true },
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await searchWithKagi("aliases", { fetch: fetchMock }, fakeAuthStorage);

		expect(result.sources).toEqual([
			{
				title: "Alias Result",
				url: "https://example.com/alias",
				snippet: "Alias description",
				publishedDate: undefined,
			},
		]);
		expect(result.relatedQuestions).toEqual([]);
	});

	it("parses direct_answer into the answer field", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					meta: { trace: "req-answer" },
					data: {
						search: [{ url: "https://example.com", title: "Result", snippet: "Snippet" }],
						direct_answer: [
							{
								url: "https://example.com/answer",
								title: "Direct Answer",
								snippet: "This is a direct answer.",
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await searchWithKagi("question", { fetch: fetchMock }, fakeAuthStorage);

		expect(result.answer).toBe("This is a direct answer.");
	});

	it("returns empty results for an empty data object", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ meta: { trace: "req-empty" }, data: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const result = await searchWithKagi("no results", { fetch: fetchMock }, fakeAuthStorage);

		expect(result.sources).toHaveLength(0);
		expect(result.relatedQuestions).toHaveLength(0);
		expect(result.answer).toBeUndefined();
	});

	it.each([
		["day", "2026-05-24"],
		["week", "2026-05-18"],
		["month", "2026-04-25"],
		["year", "2025-05-25"],
	] as const)("maps recency %s to filters.after %s", async (recency, expected) => {
		let requestBody: KagiSearchRequest | undefined;

		const fetchMock: FetchImpl = async (input, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				requestBody = JSON.parse(init?.body as string) as KagiSearchRequest;
				return new Response(JSON.stringify({ meta: { trace: "req-recency" }, data: { search: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchWithKagi("recency test", { recency, fetch: fetchMock }, fakeAuthStorage);

		expect(requestBody?.filters?.after).toBe(expected);
	});

	it("canonicalizes Google-style directives into the upstream query", async () => {
		let requestBody: KagiSearchRequest | undefined;

		const fetchMock: FetchImpl = async (input, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				requestBody = JSON.parse(init?.body as string) as KagiSearchRequest;
				return new Response(JSON.stringify({ meta: { trace: "req-directives" }, data: { search: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchKagi({
			query: "x domain:kagi.com until:2025",
			authStorage: fakeAuthStorage,
			fetch: fetchMock,
		});
		expect(requestBody?.query).toBe("x site:kagi.com before:2025-01-01");

		await searchKagi({ query: "plain kagi query", authStorage: fakeAuthStorage, fetch: fetchMock });
		expect(requestBody?.query).toBe("plain kagi query");
	});

	it("uses a Bearer authorization header", async () => {
		let capturedAuth: string | null = null;
		const fetchMock: FetchImpl = async (input, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				capturedAuth =
					init?.headers instanceof Headers
						? init.headers.get("Authorization")
						: typeof init?.headers === "object" && init?.headers !== null
							? (init.headers as Record<string, string>).Authorization
							: null;
				return new Response(JSON.stringify({ meta: { trace: "req-auth" }, data: { search: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchWithKagi("auth test", { fetch: fetchMock }, fakeAuthStorage);

		expect(capturedAuth ?? "null").toBe("Bearer test-kagi-key");
	});
});

describe("KagiProvider.isAvailable", () => {
	afterEach(() => {
		delete process.env.KAGI_API_KEY;
	});

	it("returns true when a credential is present", () => {
		process.env.KAGI_API_KEY = "test-key";
		expect(new KagiProvider().isAvailable(fakeAuthStorage)).toBe(true);
	});

	it("returns false when no credential is present", () => {
		delete process.env.KAGI_API_KEY;
		expect(new KagiProvider().isAvailable(fakeAuthStorage)).toBe(false);
	});
});
