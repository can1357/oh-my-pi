import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchKeenable } from "@oh-my-pi/pi-coding-agent/web/search/providers/keenable";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const TEST_KEY = "keen_test_key";
const savedEnvKey = process.env.KEENABLE_API_KEY;

const keyedStorage = createInMemoryAuthStorage();
keyedStorage.keys.setRuntime("keenable", TEST_KEY);
const keylessStorage = createInMemoryAuthStorage();

beforeEach(() => {
	delete process.env.KEENABLE_API_KEY;
});

afterAll(() => {
	if (savedEnvKey === undefined) delete process.env.KEENABLE_API_KEY;
	else process.env.KEENABLE_API_KEY = savedEnvKey;
	keyedStorage.close();
	keylessStorage.close();
});

function makeParams(query: string, authStorage: AuthStorage) {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("web", "keenable");
	if (!model) throw new Error("Expected bundled web/keenable model");
	return { query, authStorage, model, modelRegistry, systemPrompt: "Keenable test prompt" } as const;
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
		return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
}

const RESULTS = {
	query: "q",
	mode: "pro",
	results: [
		{
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			description: "",
			snippet: "Fixes 166 issues,\n  addressing 122 👍.",
			published_at: "2026-10-30T10:00:00Z",
		},
		{ title: "", url: "https://bun.com/docs", description: "", snippet: "" },
		{ title: "dup", url: "https://bun.com/blog/bun-v1.4.3", snippet: "duplicate" },
		{ title: "bad", url: "javascript:alert(1)", snippet: "dropped" },
	],
};

describe("Keenable web search provider", () => {
	it("uses the keyed endpoint and X-API-Key when a key is stored", async () => {
		const captured: Captured[] = [];
		const response = await searchKeenable({
			...makeParams("bun runtime release notes", keyedStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("https://api.keenable.ai/v1/search");
		expect(captured[0].headers.get("X-API-Key")).toBe(TEST_KEY);
		expect(captured[0].headers.has("X-Keenable-Title")).toBe(false);
		expect(captured[0].body).toEqual({ query: "bun runtime release notes", max_results: 10 });
		expect(response.provider).toBe("keenable");
		expect(response.authMode).toBe("api_key");
	});

	it("falls back to the keyless public endpoint without a key", async () => {
		const captured: Captured[] = [];
		const response = await searchKeenable({
			...makeParams("bun runtime release notes", keylessStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured[0].url).toBe("https://api.keenable.ai/v1/search/public");
		expect(captured[0].headers.get("X-Keenable-Title")).toBe("oh-my-pi");
		expect(captured[0].headers.has("X-API-Key")).toBe(false);
		expect(response.authMode).toBe("anonymous");
	});

	it("maps results, dedupes URLs, and drops non-http URLs", async () => {
		const response = await searchKeenable({
			...makeParams("bun", keylessStorage),
			fetch: mockFetch([], RESULTS),
		});

		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]).toMatchObject({
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			snippet: "Fixes 166 issues, addressing 122 👍.",
			publishedDate: "2026-10-30T10:00:00Z",
		});
		expect(response.sources[0].ageSeconds).toBeGreaterThan(0);
		expect(response.sources[1]).toMatchObject({ title: "https://bun.com/docs", url: "https://bun.com/docs" });
		expect(response.sources[1].snippet).toBeUndefined();
	});

	it("maps a single site:, date bounds, and phrases onto native fields", async () => {
		const captured: Captured[] = [];
		await searchKeenable({
			...makeParams('"error handling" rust site:github.com after:2025-01-01 before:2026-01-01', keylessStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured[0].body).toEqual({
			query: '"error handling" rust',
			max_results: 10,
			site: "github.com",
			published_after: "2025-01-01",
			published_before: "2026-01-01",
		});
	});

	it("leaves multiple site: hosts to the post-filter", async () => {
		const captured: Captured[] = [];
		await searchKeenable({
			...makeParams("tokio site:github.com site:docs.rs", keylessStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured[0].body.query).toBe("tokio");
		expect(captured[0].body.site).toBeUndefined();
	});

	it("maps recency to a relative published_after and clamps the result count", async () => {
		const captured: Captured[] = [];
		await searchKeenable({
			...makeParams("bun release", keylessStorage),
			recency: "week",
			numSearchResults: 500,
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured[0].body).toEqual({ query: "bun release", max_results: 50, published_after: "7d" });
	});

	it("classifies quota errors and reports other HTTP failures", async () => {
		const quota = searchKeenable({
			...makeParams("bun", keyedStorage),
			fetch: mockFetch([], { detail: "Credits exhausted" }, 402),
		});
		await expect(quota).rejects.toBeInstanceOf(SearchProviderError);
		await expect(quota).rejects.toThrow("keenable: credits exhausted");

		const missingTitle = searchKeenable({
			...makeParams("bun", keylessStorage),
			fetch: mockFetch([], { detail: "Missing app identifier" }, 400),
		});
		await expect(missingTitle).rejects.toThrow("Keenable search API error (400)");
	});

	it("rejects an unexpected response shape", async () => {
		await expect(
			searchKeenable({ ...makeParams("bun", keylessStorage), fetch: mockFetch([], { results: "nope" }) }),
		).rejects.toThrow("unexpected response shape");
	});

	it("is explicitly available without a key but auto-admitted only with one", async () => {
		const provider = await getSearchProvider("keenable");
		expect(provider.label).toBe("Keenable");
		expect(await provider.isAvailable(keylessStorage)).toBe(false);
		expect(await provider.isExplicitlyAvailable(keylessStorage)).toBe(true);
		expect(await provider.isAvailable(keyedStorage)).toBe(true);
	});
});
