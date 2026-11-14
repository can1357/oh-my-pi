import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchKeenable } from "@oh-my-pi/pi-coding-agent/web/search/providers/keenable";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const TEST_KEY = "keen_test_key";
const savedEnvKey = process.env.KEENABLE_API_KEY;

const keyedStorage = createInMemoryAuthStorage();
keyedStorage.keys.setRuntime("keenable", TEST_KEY);
const keylessStorage = createInMemoryAuthStorage();

beforeEach(() => {
	delete process.env.KEENABLE_API_KEY;
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedEnvKey === undefined) delete process.env.KEENABLE_API_KEY;
	else process.env.KEENABLE_API_KEY = savedEnvKey;
});

afterAll(() => {
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
		return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
	};
}

const RESULTS = {
	results: [
		{
			title: "Bun v1.4.3",
			url: "https://bun.com/blog/bun-v1.4.3",
			snippet: "Fixes 166 issues,\n  addressing 122 👍.",
			published_at: "2026-10-30T10:00:00Z",
		},
		{ title: "", url: "https://bun.com/docs", snippet: "" },
		{ title: "dup", url: "https://bun.com/blog/bun-v1.4.3", snippet: "duplicate" },
		{ title: "bad", url: "javascript:alert(1)", snippet: "dropped" },
	],
};

async function bodyFor(query: string, extra: { recency?: "week"; numSearchResults?: number } = {}) {
	const captured: Captured[] = [];
	await searchKeenable({ ...makeParams(query, keylessStorage), ...extra, fetch: mockFetch(captured, RESULTS) });
	return captured[0].body;
}

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

	it("refuses anonymous search when a configured credential does not resolve", async () => {
		vi.spyOn(keyedStorage.keys, "resolver").mockImplementation(() => async () => undefined);
		const captured: Captured[] = [];

		await expect(
			searchKeenable({ ...makeParams("bun", keyedStorage), fetch: mockFetch(captured, RESULTS) }),
		).rejects.toThrow("Keenable credentials could not be resolved");
		expect(captured).toHaveLength(0);
	});

	it("retries with a rotated credential after the first key is rejected", async () => {
		const resolvedKeys = ["stale-keenable-key", "rotated-keenable-key"];
		vi.spyOn(keyedStorage.keys, "resolver").mockImplementation(() => async () => resolvedKeys.shift());
		const sentKeys: (string | null)[] = [];
		const fetchImpl: FetchImpl = async (_input, init) => {
			sentKeys.push(new Headers(init?.headers).get("X-API-Key"));
			return sentKeys.length === 1
				? new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })
				: new Response(JSON.stringify(RESULTS), { status: 200 });
		};

		const result = await searchKeenable({ ...makeParams("bun", keyedStorage), fetch: fetchImpl });

		expect(sentKeys).toEqual(["stale-keenable-key", "rotated-keenable-key"]);
		expect(result.authMode).toBe("api_key");
		expect(result.sources).toHaveLength(2);
	});

	it("maps results, dedupes URLs, and drops non-http URLs", async () => {
		const response = await searchKeenable({ ...makeParams("bun", keylessStorage), fetch: mockFetch([], RESULTS) });

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
		expect(await bodyFor('"error handling" rust site:github.com after:2025-01-01 before:2026-01-01')).toEqual({
			query: '"error handling" rust',
			max_results: 10,
			site: "github.com",
			published_after: "2025-01-01",
			published_before: "2026-01-01",
		});
	});

	it("maps recency to a relative published_after and clamps the result count", async () => {
		expect(await bodyFor("bun release", { recency: "week", numSearchResults: 500 })).toEqual({
			query: "bun release",
			max_results: 50,
			published_after: "7d",
		});
	});

	it("never sends search operators as keywords", async () => {
		expect(await bodyFor("tokio site:github.com site:docs.rs")).toEqual({ query: "tokio", max_results: 10 });
		expect(await bodyFor("site:github.com site:docs.rs")).toEqual({
			query: "github.com docs.rs",
			max_results: 10,
		});
		expect(await bodyFor("site:docs.rs/tokio")).toEqual({
			query: "docs.rs/tokio",
			max_results: 10,
			site: "docs.rs",
		});
	});

	it("rejects a date-only query without calling the API", async () => {
		const captured: Captured[] = [];
		await expect(
			searchKeenable({ ...makeParams("after:2025-01-01", keylessStorage), fetch: mockFetch(captured, RESULTS) }),
		).rejects.toThrow("Keenable needs search terms");
		expect(captured).toHaveLength(0);
	});

	it("rejects an unexpected response shape", async () => {
		await expect(
			searchKeenable({ ...makeParams("bun", keylessStorage), fetch: mockFetch([], { results: "nope" }) }),
		).rejects.toThrow("unexpected response shape");
	});

	it("is explicitly available without a key but auto-admitted only with one", async () => {
		const provider = await getSearchProvider("keenable");
		expect(await provider.isAvailable(keylessStorage)).toBe(false);
		expect(await provider.isExplicitlyAvailable(keylessStorage)).toBe(true);
		expect(await provider.isAvailable(keyedStorage)).toBe(true);
	});
});
