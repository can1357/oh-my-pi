import { afterAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { buildRequestBody, searchYouDotCom } from "@oh-my-pi/pi-coding-agent/web/search/providers/youdotcom";
import { parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const catalogAuthStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(catalogAuthStorage);
const youDotComModel = modelRegistry.find("web", "youdotcom");
if (!youDotComModel) throw new Error("Expected bundled web/youdotcom model");

afterAll(() => {
	catalogAuthStorage.close();
});

const authStorage = {
	keys: {
		get: async () => "test-ydc-key",
		resolver: vi.fn(() => async () => "test-ydc-key"),
		source: () => ({ kind: "runtime", concrete: true }),
	},
} as unknown as AuthStorage;

function makeParams(query: string, extras: Partial<SearchParams> = {}): SearchParams {
	return {
		...extras,
		query,
		parsedQuery: parseSearchQuery(query),
		authStorage,
		systemPrompt: "You.com test prompt",
		model: youDotComModel!,
		modelRegistry,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("You.com buildRequestBody", () => {
	it("keeps highlight extraction within its 50-result limit", () => {
		expect(buildRequestBody(makeParams("bun", { numSearchResults: 80 }))).toMatchObject({
			count: 50,
			extraction: { extraction_mode: "highlights" },
		});
	});

	it("maps site: to include_domains and drops -site: so the API does not reject both lists", () => {
		const body = buildRequestBody(makeParams("bun release site:bun.sh/blog -site:reddit.com"));
		expect(body.query).toBe("bun release");
		expect(body.include_domains).toEqual(["bun.sh"]);
		expect(body).not.toHaveProperty("exclude_domains");
	});

	it("maps -site: alone to exclude_domains", () => {
		const body = buildRequestBody(makeParams('"release notes" -site:reddit.com'));
		expect(body.query).toBe('"release notes"');
		expect(body.exclude_domains).toEqual(["reddit.com"]);
	});

	it("renders date bounds as a freshness range that wins over recency", () => {
		const body = buildRequestBody(makeParams("bun after:2026-01-01 before:2026-02-01", { recency: "day" }));
		expect(body.query).toBe("bun");
		expect(body.freshness).toBe("2026-01-01to2026-02-01");
	});

	it("passes recency through as freshness when the query has no date bounds", () => {
		expect(buildRequestBody(makeParams("bun", { recency: "week" })).freshness).toBe("week");
	});

	it.each([
		["lang:en-us", "EN"],
		["lang:zh-hant", "ZH-HANT"],
		["lang:pt", undefined],
	])("maps %s to an accepted language or omits it", (directive, language) => {
		expect(buildRequestBody(makeParams(`bun ${directive}`)).language).toBe(language);
	});
});

describe("You.com searchYouDotCom", () => {
	it("POSTs with X-API-Key and maps highlights, descriptions, and ids into sources", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return jsonResponse({
				results: {
					web: [
						{
							url: "https://bun.sh/blog/bun-v1.3",
							title: "Bun 1.3",
							description: "Generic description",
							page_age: "2026-04-09T00:00:00",
							contents: { highlights: ["First  passage", "Second passage"] },
						},
						{ url: "https://example.com/doc", title: "Doc", description: "Only a description" },
						{ url: "javascript:alert(1)", title: "Dropped" },
					],
				},
				metadata: { search_uuid: "uuid-123" },
			});
		};

		const response = await searchYouDotCom({ ...makeParams("bun 1.3"), fetch: fetchMock });

		expect(capturedUrl).toBe("https://ydc-index.io/v1/search");
		expect(capturedInit?.method).toBe("POST");
		expect(new Headers(capturedInit?.headers).get("X-API-Key")).toBe("test-ydc-key");
		expect(response).toMatchObject({
			provider: "youdotcom",
			requestId: "uuid-123",
			authMode: "api_key",
			sources: [
				{
					title: "Bun 1.3",
					url: "https://bun.sh/blog/bun-v1.3",
					snippet: "First passage\nSecond passage",
					publishedDate: "2026-04-09T00:00:00",
				},
				{ title: "Doc", url: "https://example.com/doc", snippet: "Only a description" },
			],
		});
		expect(response.sources).toHaveLength(2);
	});

	it("bounds upstream titles and drops oversized URLs before they reach tool output", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({
				results: {
					web: [
						{ url: `https://example.com/${"a".repeat(2_100)}`, title: "Oversized URL" },
						{ url: "https://example.com/long-title", title: "t".repeat(5_000) },
					],
				},
			});

		const { sources } = await searchYouDotCom({ ...makeParams("bun"), fetch: fetchMock });

		expect(sources.map(source => source.url)).toEqual(["https://example.com/long-title"]);
		expect(sources[0]?.title).toHaveLength(300);
	});

	it("surfaces API errors with the provider tag and status", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({ error: "include_domains and exclude_domains cannot be used together" }, 422);

		await expect(searchYouDotCom({ ...makeParams("bun"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "youdotcom",
				status: 422,
				message: expect.stringContaining("You.com API error (422)"),
			}) satisfies Partial<SearchProviderError>,
		);
	});
});
