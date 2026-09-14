import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { KeenableProvider, searchKeenable } from "@oh-my-pi/pi-coding-agent/web/search/providers/keenable";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "keen_test_key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		async getApiKey() {
			return apiKey;
		},
		hasAuth(provider: string) {
			return provider === "keenable" && Boolean(apiKey);
		},
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("keenable");
			expect(options?.sessionId).toBe("session-keenable-test");
			return async () => apiKey;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;
}

/** `null` requests the keyless path; `undefined` would trigger the default parameter. */
function makeParams(query: string, apiKey: string | null = TEST_KEY) {
	return {
		query,
		authStorage: makeAuthStorage(apiKey ?? undefined),
		systemPrompt: "Keenable test prompt",
		sessionId: "session-keenable-test",
	} as const;
}

interface Captured {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function capturingFetch(responder: (call: Captured, index: number) => Response): {
	fetch: FetchImpl;
	calls: Captured[];
} {
	const calls: Captured[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const call: Captured = {
			url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>,
		};
		calls.push(call);
		return responder(call, calls.length - 1);
	};
	return { fetch: fetchImpl, calls };
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("Keenable web search provider", () => {
	it("maps keyed responses into SearchResponse and forwards recency as a relative delta", async () => {
		const { fetch, calls } = capturingFetch(() =>
			jsonResponse(
				{
					query: "latest ai news",
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							description: "Short summary",
							snippet: "Longer excerpt from the page",
							published_at: "2026-03-01T00:00:00Z",
						},
						{ url: "https://example.com/two", description: "Only a description" },
						{ title: "No URL", description: "dropped" },
					],
				},
				{ headers: { "Content-Type": "application/json", "x-request-id": "req-keen-1" } },
			),
		);

		const response = await searchKeenable({ ...makeParams("latest ai news"), recency: "week", limit: 5, fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.keenable.ai/v1/search");
		expect(calls[0].headers["X-API-Key"]).toBe(TEST_KEY);
		expect(calls[0].headers).not.toHaveProperty("X-Keenable-Title");
		expect(calls[0].body).toEqual({ query: "latest ai news", max_results: 5, published_after: "7d" });
		expect(response).toMatchObject({
			provider: "keenable",
			authMode: "api_key",
			requestId: "req-keen-1",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "Longer excerpt from the page",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{ title: "https://example.com/two", url: "https://example.com/two", snippet: "Only a description" },
			],
		});
		expect(response.sources[0].ageSeconds).toBeGreaterThan(0);
	});

	it("runs keyless against the public endpoint with the app title header when no credential resolves", async () => {
		const { fetch, calls } = capturingFetch(() =>
			jsonResponse({ results: [{ title: "Public", url: "https://example.com/public" }] }),
		);

		const response = await searchKeenable({ ...makeParams("plain query", null), fetch });

		expect(calls[0].url).toBe("https://api.keenable.ai/v1/search/public");
		expect(calls[0].headers["X-Keenable-Title"]).toBe("oh-my-pi");
		expect(calls[0].headers).not.toHaveProperty("X-API-Key");
		expect(response.authMode).toBe("keyless");
		expect(response.sources).toHaveLength(1);
	});

	it("maps a single site: and absolute date bounds to native filters, rewriting the query text", async () => {
		const { fetch, calls } = capturingFetch(() =>
			jsonResponse({ results: [{ title: "x", url: "https://github.com/x" }] }),
		);

		await searchKeenable({
			...makeParams(
				'"error handling" rust site:github.com/anthropics -site:gitlab.com after:2024-01-01 before:2024-06-01',
			),
			recency: "month",
			fetch,
		});

		expect(calls[0].body).toEqual({
			query: '"error handling" rust',
			max_results: 10,
			site: "github.com",
			published_after: "2024-01-01",
			published_before: "2024-06-01T00:00:00Z",
		});
	});

	it("leaves multiple site: hosts to the central post-filter", async () => {
		const { fetch, calls } = capturingFetch(() =>
			jsonResponse({ results: [{ title: "x", url: "https://a.example" }] }),
		);

		await searchKeenable({ ...makeParams("docs site:a.example site:b.example"), fetch });

		expect(calls[0].body).not.toHaveProperty("site");
		expect(calls[0].body.query).toBe("docs");
	});

	it("retries once without time filters when a filtered search returns nothing", async () => {
		const { fetch, calls } = capturingFetch((_call, index) =>
			jsonResponse({ results: index === 0 ? [] : [{ title: "Retry hit", url: "https://example.com/retry" }] }),
		);

		const response = await searchKeenable({ ...makeParams("obscure topic"), recency: "day", fetch });

		expect(calls).toHaveLength(2);
		expect(calls[0].body).toHaveProperty("published_after", "1d");
		expect(calls[1].body).not.toHaveProperty("published_after");
		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/retry"]);
	});

	it("does not retry an empty unfiltered search", async () => {
		const { fetch, calls } = capturingFetch(() => jsonResponse({ results: [] }));

		const response = await searchKeenable({ ...makeParams("nothing here"), fetch });

		expect(calls).toHaveLength(1);
		expect(response.sources).toEqual([]);
	});

	it("surfaces API errors as provider-tagged SearchProviderError with the upstream message", async () => {
		const { fetch } = capturingFetch(
			() => new Response(JSON.stringify({ error: "Missing app identifier" }), { status: 400 }),
		);

		const error = await searchKeenable({ ...makeParams("q"), fetch }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).provider).toBe("keenable");
		expect((error as SearchProviderError).status).toBe(400);
		expect((error as SearchProviderError).message).toContain("Missing app identifier");
	});

	it("admits the auto chain only with a credential but is always explicitly selectable", () => {
		const provider = new KeenableProvider();
		expect(provider.isAvailable(makeAuthStorage(undefined))).toBe(false);
		expect(provider.isExplicitlyAvailable(makeAuthStorage(undefined))).toBe(true);
		expect(provider.isAvailable(makeAuthStorage(TEST_KEY))).toBe(true);
	});
});
