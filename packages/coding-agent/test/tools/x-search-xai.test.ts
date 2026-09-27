import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type FetchImpl, type Model, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { buildXSearchSpec } from "@oh-my-pi/pi-coding-agent/web/search/xsearch";
import { searchXAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

function xaiModel(id = "grok-4.5", provider = "xai", baseUrl = "https://api.x.ai/v1"): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
	});
}

function captureFetch(responseBody: Record<string, unknown> | string, status = 200) {
	const capturedRequests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
	const fetchMock: FetchImpl = (input, init) => {
		capturedRequests.push({
			url: typeof input === "string" ? input : input.toString(),
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		});
		return Promise.resolve(
			new Response(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
	return {
		fetchMock,
		get capturedRequest() {
			return capturedRequests.at(-1) ?? null;
		},
	};
}

describe("xAI x_search provider path", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.keys.setRuntime("xai", "test-xai-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	function makeParams(fetch: FetchImpl, xSearch: Record<string, unknown> = {}) {
		return {
			query: "latest grok release reaction",
			systemPrompt: "Use x_search for live X posts.",
			authStorage: modelRegistry.authStorage,
			model: xaiModel(),
			modelRegistry,
			fetch,
			sessionId: "session-x-search-test",
			xSearch,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	it("POSTs the Responses API with the x_search tool payload", async () => {
		const capture = captureFetch({ id: "resp_x", model: "grok-4.5", output_text: "posts about grok" });

		const result = await searchXAI(makeParams(capture.fetchMock));

		expect(capture.capturedRequest?.url).toBe("https://api.x.ai/v1/responses");
		expect(capture.capturedRequest?.body).toMatchObject({
			model: "grok-4.5",
			tools: [{ type: "x_search" }],
			reasoning: { effort: "low" },
			store: false,
		});
		expect(capture.capturedRequest?.body).not.toHaveProperty("search_parameters");
		expect(result.answer).toBe("posts about grok");
		expect(result.degraded).toBeUndefined();
	});

	it("maps handle, date, and media flags onto the x_search tool def", async () => {
		const capture = captureFetch({ id: "resp_x2", model: "grok-4.5", output_text: "filtered" });

		await searchXAI(
			makeParams(capture.fetchMock, {
				allowedHandles: ["@xaboratory", "gabor"],
				fromDate: "2026-09-01",
				toDate: "2026-09-10",
				enableImageUnderstanding: true,
				enableVideoUnderstanding: true,
			}),
		);

		expect(capture.capturedRequest?.body?.tools).toEqual([
			{
				type: "x_search",
				allowed_x_handles: ["xaboratory", "gabor"],
				from_date: "2026-09-01",
				to_date: "2026-09-10",
				enable_image_understanding: true,
				enable_video_understanding: true,
			},
		]);
	});

	it("rejects allowed and excluded handles together before any request", async () => {
		const capture = captureFetch({ output_text: "unreachable" });

		await expect(
			searchXAI(makeParams(capture.fetchMock, { allowedHandles: ["a"], excludedHandles: ["b"] })),
		).rejects.toThrow("cannot be used together");
		expect(capture.capturedRequest).toBeNull();
	});

	it("rejects malformed or impossible dates without a request", async () => {
		const capture = captureFetch({ output_text: "unreachable" });

		await expect(searchXAI(makeParams(capture.fetchMock, { fromDate: "next week" }))).rejects.toThrow(
			"from_date must be YYYY-MM-DD",
		);
		await expect(searchXAI(makeParams(capture.fetchMock, { fromDate: "2026-02-30" }))).rejects.toThrow(
			"from_date must be YYYY-MM-DD",
		);
		await expect(
			searchXAI(makeParams(capture.fetchMock, { fromDate: "2026-09-10", toDate: "2026-09-01" })),
		).rejects.toThrow("on or before to_date");
		expect(capture.capturedRequest).toBeNull();
	});

	it("maps after:/before: query directives onto x_search date fields", async () => {
		const capture = captureFetch({ id: "resp_x3", model: "grok-4.5", output_text: "date filtered" });
		const params = makeParams(capture.fetchMock);
		params.query = "grok benchmark after:2026-09-01 before:2026-09-20";

		await searchXAI(params);

		expect(capture.capturedRequest?.body?.tools).toEqual([
			{ type: "x_search", from_date: "2026-09-01", to_date: "2026-09-20" },
		]);
		const input = capture.capturedRequest?.body?.input as { role: string; content: string }[];
		expect(input[1]?.content).toBe("grok benchmark");
	});

	it("collects sources from x_search_call output items", async () => {
		const capture = captureFetch({
			id: "resp_x4",
			model: "grok-4.5",
			output: [
				{
					type: "x_search_call",
					action: {
						posts: [{ url: "https://x.com/xaboratory/status/1", title: "launch thread" }],
					},
				},
				{ type: "message", content: [{ type: "output_text", text: "xAI shipped it" }] },
			],
		});

		const result = await searchXAI(makeParams(capture.fetchMock));

		expect(result.sources).toEqual([{ title: "launch thread", url: "https://x.com/xaboratory/status/1" }]);
		expect(result.answer).toBe("xAI shipped it");
		expect(result.degraded).toBeUndefined();
	});

	it("flags filtered answers with no citations as degraded", async () => {
		const capture = captureFetch({ id: "resp_x5", model: "grok-4.5", output_text: "probably grok is fast" });

		const result = await searchXAI(makeParams(capture.fetchMock, { allowedHandles: ["xaboratory"] }));

		expect(result.degraded).toBe(true);
	});

	it("does not flag unfiltered citation-free answers as degraded", async () => {
		const capture = captureFetch({ id: "resp_x6", model: "grok-4.5", output_text: "no results found" });

		const result = await searchXAI(makeParams(capture.fetchMock));

		expect(result.degraded).toBeUndefined();
	});

	it("throws when the response has neither answer nor sources", async () => {
		const capture = captureFetch({ id: "resp_x7", model: "grok-4.5", output: [] });

		await expect(searchXAI(makeParams(capture.fetchMock))).rejects.toThrow(SearchProviderError);
		await expect(searchXAI(makeParams(capture.fetchMock))).rejects.toThrow(
			"xAI x_search returned no answer or sources",
		);
	});

	it("routes x_search through the xsearch role chain to the xAI provider", async () => {
		resetSettingsForTest();
		try {
			await Settings.init({ inMemory: true });
			const capture = captureFetch({
				id: "resp_x8",
				model: "grok-4.5",
				output: [
					{
						type: "x_search_call",
						action: { posts: [{ url: "https://x.com/xaboratory/status/1", title: "launch thread" }] },
					},
					{ type: "message", content: [{ type: "output_text", text: "grok launch posts" }] },
				],
			});

			const result = await runSearchQuery(
				{ query: "grok 4.5 launch" },
				{
					authStorage,
					modelRegistry,
					fetch: capture.fetchMock,
					xSearch: buildXSearchSpec({ query: "grok 4.5 launch" }),
				},
			);

			expect(capture.capturedRequest?.url).toBe("https://api.x.ai/v1/responses");
			expect(capture.capturedRequest?.body?.tools).toEqual([{ type: "x_search" }]);
			expect(capture.capturedRequest?.body?.model).toContain("grok");
			expect(result.content[0]?.text).toContain("grok launch posts");
			expect(result.details.error).toBeUndefined();
		} finally {
			resetSettingsForTest();
		}
	});

	it("fails closed on an explicit non-xAI model selector", async () => {
		resetSettingsForTest();
		try {
			await Settings.init({ inMemory: true });
			const capture = captureFetch({ output_text: "unreachable" });

			const result = await runSearchQuery(
				{ query: "grok launch", model: "web/exa" },
				{
					authStorage,
					modelRegistry,
					fetch: capture.fetchMock,
					xSearch: buildXSearchSpec({ query: "grok launch" }),
				},
			);

			expect(result.details.error).toContain("web/exa");
			expect(result.details.error).toContain("does not support x_search");
			expect(capture.capturedRequest).toBeNull();
		} finally {
			resetSettingsForTest();
		}
	});

	it("maps recency onto from_date, which explicit dates override", async () => {
		const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
		const fromRecency = buildXSearchSpec({ query: "q", recency: "week" });
		const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

		// ISO dates compare lexicographically; the window brackets a UTC-midnight tick.
		const fromDate = fromRecency.options.fromDate;
		if (!fromDate) throw new Error("recency:week should produce a from_date");
		expect(fromDate >= before && fromDate <= after).toBe(true);

		const explicit = buildXSearchSpec({ query: "q", recency: "year", from_date: "2026-01-02" });
		expect(explicit.options.fromDate).toBe("2026-01-02");
	});
});
