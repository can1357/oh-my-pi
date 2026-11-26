import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchSpecStream } from "@oh-my-pi/pi-coding-agent/web/search/providers/specstream";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const TEST_KEY = "ss-test-key";

function makeParams(query: string, authStorage: AuthStorage) {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("web", "specstream");
	if (!model) throw new Error("Expected bundled web/specstream model");
	return { query, authStorage, model, modelRegistry, systemPrompt: "SpecStream test prompt" } as const;
}

interface Captured {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function mockFetch(captured: Captured[], payload: unknown, status = 200): FetchImpl {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.push({
			url,
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
	};
}

const RESULTS = {
	sources: [
		{
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			snippet: "Fixes 166 issues.",
			excerpt: "Fixes 166 issues, addressing 122 bugs. Full release notes follow.",
			published: "2026-10-30",
		},
		{ title: "", url: "https://bun.com/docs", snippet: "Bun documentation" },
		{ title: "dup", url: "https://bun.com/blog/bun-v1.4.3", snippet: "duplicate" },
		{ title: "bad", url: "javascript:alert(1)", snippet: "dropped" },
	],
};

describe("SpecStream web search provider", () => {
	let keyedStorage: AuthStorage;

	beforeEach(() => {
		keyedStorage = createInMemoryAuthStorage();
		keyedStorage.keys.setRuntime("specstream", TEST_KEY);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers specstream in the provider registry and checks availability", async () => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		const provider = await getSearchProvider("specstream");
		expect(provider.id).toBe("specstream");
		expect(provider.label).toBe("SpecStream");
		expect(provider.isAvailable(keyedStorage)).toBe(true);
		expect(provider.isAvailable(createInMemoryAuthStorage())).toBe(false);
	});

	it("posts bearer auth with passages and normalizes deduplicated sources", async () => {
		const captured: Captured[] = [];
		const response = await searchSpecStream({
			...makeParams("bun runtime release notes", keyedStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("https://api.specstream.ai/v1/web-search");
		expect(captured[0].headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(captured[0].body).toEqual({
			q: "bun runtime release notes",
			num: 10,
			passages: true,
		});
		expect(response.provider).toBe("specstream");
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]?.title).toBe("Bun v1.4.3");
		expect(response.sources[0]?.snippet).toBe("Fixes 166 issues, addressing 122 bugs. Full release notes follow.");
		expect(response.sources[0]?.publishedDate).toBe("2026-10-30");
		expect(response.sources[1]?.title).toBe("https://bun.com/docs");
		expect(response.sources[1]?.snippet).toBe("Bun documentation");
	});

	it("formats site: paths and exclusions via formatQuery without switching recency to news mode", async () => {
		const captured: Captured[] = [];
		await searchSpecStream({
			...makeParams("bun docs site:bun.com/docs -site:example.org", keyedStorage),
			recency: "week",
			numSearchResults: 5,
			fetch: mockFetch(captured, { sources: [] }),
		});
		await searchSpecStream({
			...makeParams("site:bun.com", keyedStorage),
			fetch: mockFetch(captured, { sources: [] }),
		});

		expect(captured[0].body).toEqual({
			q: "bun docs site:bun.com/docs -site:example.org",
			num: 5,
			passages: true,
		});
		expect(captured[1].body).toEqual({
			q: "site:bun.com",
			num: 10,
			passages: true,
		});
	});

	it("rejects date-only queries without calling the API", async () => {
		const captured: Captured[] = [];
		await expect(
			searchSpecStream({
				...makeParams("after:2025-01-01", keyedStorage),
				fetch: mockFetch(captured, RESULTS),
			}),
		).rejects.toThrow("SpecStream needs search terms");
		expect(captured).toHaveLength(0);
	});

	it("throws SearchProviderError with HTTP status on rate limit and errors on missing credentials", async () => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		await expect(
			searchSpecStream({
				...makeParams("bun", createInMemoryAuthStorage()),
				fetch: mockFetch([], RESULTS),
			}),
		).rejects.toThrow("SpecStream credentials not found");

		let caught: unknown;
		try {
			await searchSpecStream({
				...makeParams("bun", keyedStorage),
				fetch: mockFetch([], { error: "rate limited" }, 429),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SearchProviderError);
		expect((caught as SearchProviderError).provider).toBe("specstream");
		expect((caught as SearchProviderError).status).toBe(429);
	});
});
