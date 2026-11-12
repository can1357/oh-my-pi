import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchSofya } from "@oh-my-pi/pi-coding-agent/web/search/providers/sofya";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const TEST_KEY = "sofya_live_test_key";

const keyedStorage = createInMemoryAuthStorage();
keyedStorage.keys.setRuntime("sofya", TEST_KEY);
const keylessStorage = createInMemoryAuthStorage();

beforeEach(() => {
	// Hide any ambient SOFYA_API_KEY so the keyless storage really has no key.
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	keyedStorage.close();
	keylessStorage.close();
});

function makeParams(query: string, authStorage: AuthStorage) {
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("web", "sofya");
	if (!model) throw new Error("Expected bundled web/sofya model");
	return { query, authStorage, model, modelRegistry, systemPrompt: "Sofya test prompt" } as const;
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
	query: "bun",
	answer: null,
	results: [
		{
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			description: "Fixes 166 issues,\n  addressing 122 👍.",
			content: "Fixes 166 issues, addressing 122 👍. Full release notes follow.",
			published_date: "2026-10-30",
		},
		{ title: "", url: "https://bun.com/docs", content: "", published_date: null },
		{ title: "dup", url: "https://bun.com/blog/bun-v1.4.3", content: "duplicate" },
		{ title: "bad", url: "javascript:alert(1)", content: "dropped" },
	],
	credits_used: 1,
	credits_remaining: 99,
};

async function bodyFor(query: string, extra: { recency?: "week"; numSearchResults?: number } = {}) {
	const captured: Captured[] = [];
	await searchSofya({ ...makeParams(query, keyedStorage), ...extra, fetch: mockFetch(captured, RESULTS) });
	return captured[0].body;
}

describe("Sofya web search provider", () => {
	it("sends the key as a bearer token with a snippets-depth body", async () => {
		const captured: Captured[] = [];
		const response = await searchSofya({
			...makeParams("bun runtime release notes", keyedStorage),
			fetch: mockFetch(captured, RESULTS),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("https://sofya.co/v1/search");
		expect(captured[0].headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(captured[0].body).toEqual({
			query: "bun runtime release notes",
			search_depth: "snippets",
			max_results: 10,
		});
		expect(response.authMode).toBe("api_key");
	});

	it("fails without a key and never calls the API", async () => {
		const captured: Captured[] = [];
		await expect(
			searchSofya({ ...makeParams("bun", keylessStorage), fetch: mockFetch(captured, RESULTS) }),
		).rejects.toThrow("Sofya credentials not found");
		expect(captured).toHaveLength(0);
	});

	it("maps results, dedupes URLs, and drops non-http URLs", async () => {
		const response = await searchSofya({ ...makeParams("bun", keyedStorage), fetch: mockFetch([], RESULTS) });

		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]).toMatchObject({
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			snippet: "Fixes 166 issues, addressing 122 👍.",
			publishedDate: "2026-10-30",
		});
		expect(response.sources[0].ageSeconds).toBeGreaterThan(0);
		expect(response.sources[1]).toMatchObject({ title: "https://bun.com/docs", url: "https://bun.com/docs" });
		expect(response.sources[1].snippet).toBeUndefined();
		expect(response.sources[1].publishedDate).toBeUndefined();
	});

	it("maps site:, -site:, an exclusive before: bound, phrases, and exclusions onto native fields", async () => {
		expect(
			await bodyFor(
				'"error handling" rust -unsafe site:github.com -site:reddit.com after:2025-01-01 before:2026-01-01',
			),
		).toEqual({
			query: '"error handling" rust -unsafe',
			search_depth: "snippets",
			max_results: 10,
			include_domains: ["github.com"],
			exclude_domains: ["reddit.com"],
			freshness: "2025-01-01:2025-12-31",
		});
	});

	it("sends at most 10 hosts per domain list", async () => {
		const hosts = Array.from({ length: 12 }, (_, i) => `s${i}.example.com`);
		const body = await bodyFor(
			`bun ${hosts.map(h => `site:${h}`).join(" ")} ${hosts.map(h => `-site:x${h}`).join(" ")}`,
		);
		expect(body.include_domains).toEqual(hosts.slice(0, 10));
		expect(body.exclude_domains).toEqual(hosts.slice(0, 10).map(h => `x${h}`));
	});

	it("closes an open date bound and prefers it over recency", async () => {
		const today = new Date().toISOString().slice(0, 10);
		expect((await bodyFor("bun after:2025-01-01", { recency: "week" })).freshness).toBe(`2025-01-01:${today}`);
		expect((await bodyFor("bun before:2025-01-01")).freshness).toBe("1970-01-01:2024-12-31");
	});

	it("reports a query Sofya relaxed or corrected", async () => {
		const search = (payload: unknown) =>
			searchSofya({ ...makeParams("bun site:bun.com", keyedStorage), fetch: mockFetch([], payload) });
		expect((await search({ ...RESULTS, relaxed_query: "bun", altered_query: null })).searchQueries).toEqual(["bun"]);
		expect((await search({ ...RESULTS, altered_query: "bun js" })).searchQueries).toEqual(["bun js"]);
		expect((await search({ ...RESULTS, relaxed_query: null, altered_query: null })).searchQueries).toBeUndefined();
	});

	it("passes recency through as freshness and clamps the result count", async () => {
		expect(await bodyFor("bun release", { recency: "week", numSearchResults: 500 })).toEqual({
			query: "bun release",
			search_depth: "snippets",
			max_results: 20,
			freshness: "week",
		});
	});

	it("never sends search operators as keywords", async () => {
		expect((await bodyFor("site:github.com site:docs.rs")).query).toBe("github.com docs.rs");
	});

	it("rejects a date-only query without calling the API", async () => {
		const captured: Captured[] = [];
		await expect(
			searchSofya({ ...makeParams("after:2025-01-01", keyedStorage), fetch: mockFetch(captured, RESULTS) }),
		).rejects.toThrow("Sofya needs search terms");
		expect(captured).toHaveLength(0);
	});

	it("rejects an unexpected response shape", async () => {
		await expect(
			searchSofya({ ...makeParams("bun", keyedStorage), fetch: mockFetch([], { detail: "nope" }) }),
		).rejects.toThrow("unexpected response shape");
		await expect(searchSofya({ ...makeParams("bun", keyedStorage), fetch: mockFetch([], null) })).rejects.toThrow(
			"unexpected response shape",
		);
	});

	it("is auto-admitted only with a key", async () => {
		const provider = await getSearchProvider("sofya");
		expect(await provider.isAvailable(keylessStorage)).toBe(false);
		expect(await provider.isAvailable(keyedStorage)).toBe(true);
	});
});
