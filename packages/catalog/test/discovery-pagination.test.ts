import { describe, expect, it } from "bun:test";
import { fetchGeminiModels } from "../src/discovery/gemini";
import { fetchOpenAICompatibleModels } from "../src/discovery/openai-compatible";
import type { FetchImpl } from "../src/types";

const baseUrl = "https://catalog.example/v1";

function sequence(pages: unknown[], requests: string[] = []): FetchImpl {
	return async input => {
		requests.push(String(input));
		const payload = pages.shift();
		return payload instanceof Response ? payload : Response.json(payload);
	};
}

describe("complete OpenAI-compatible enumeration", () => {
	it("collects Anthropic pages using encoded after_id on the original endpoint", async () => {
		const requests: string[] = [];
		const models = await fetchOpenAICompatibleModels({
			api: "anthropic-messages",
			provider: "custom",
			baseUrl,
			apiKey: "secret",
			fetch: sequence(
				[
					{ data: [{ id: "a/b?c" }], has_more: true, last_id: "a/b?c" },
					{ data: [{ id: "z" }], has_more: false },
				],
				requests,
			),
		});
		expect(models?.map(model => model.id)).toEqual(["a/b?c", "z"]);
		expect(requests).toEqual([`${baseUrl}/models`, `${baseUrl}/models?after_id=a%2Fb%3Fc`]);
	});

	it("discards earlier pages when a later request fails", async () => {
		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "custom",
			baseUrl,
			fetch: sequence([{ data: [{ id: "a" }], has_more: true, last_id: "a" }, new Response(null, { status: 503 })]),
		});
		expect(models).toBeNull();
	});

	it("rejects cursor cycles", async () => {
		const requests: string[] = [];
		const page = { data: [{ id: "a" }], has_more: true, last_id: "a" };
		expect(
			await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "custom",
				baseUrl,
				fetch: sequence([page, page], requests),
			}),
		).toBeNull();
		expect(requests).toEqual([`${baseUrl}/models`, `${baseUrl}/models?after=a`]);
	});

	it.each([
		{ data: [{ id: "ok" }, {}] },
		{ data: [{ id: " " }] },
		{ data: "invalid", models: [] },
		{ data: [], has_more: true },
		{ data: [], next: "https://untrusted.example/steal" },
		{ data: [], pagination: { page: 1, total_pages: 2 } },
		{ data: [], has_more: "false" },
	])("rejects malformed or unsupported partial envelopes: %j", async payload => {
		const requests: string[] = [];
		expect(
			await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "custom",
				baseUrl,
				apiKey: "secret",
				fetch: sequence([payload], requests),
			}),
		).toBeNull();
		expect(requests).toEqual([`${baseUrl}/models`]);
	});

	it("retains intentional mapper and filter exclusions after enumeration", async () => {
		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "custom",
			baseUrl,
			fetch: sequence([{ result: { items: [{ id: "mapped-out" }, { id: "filtered-out" }, { id: "kept" }] } }]),
			mapModel: (entry, defaults) => (entry.id === "mapped-out" ? null : defaults),
			filterModel: entry => entry.id !== "filtered-out",
		});
		expect(models?.map(model => model.id)).toEqual(["kept"]);
	});
});

describe("complete Gemini enumeration", () => {
	it("collects all pages while excluding non-generation models", async () => {
		const models = await fetchGeminiModels({
			apiKey: "secret",
			baseUrl,
			fetch: sequence([
				{
					models: [{ name: "models/gemini-one", supportedGenerationMethods: ["generateContent"] }],
					nextPageToken: "second",
				},
				{
					models: [
						{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
						{ name: "models/gemini-two", supportedGenerationMethods: ["generateContent"] },
					],
				},
			]),
		});
		expect(models?.map(model => model.id)).toEqual(["gemini-one", "gemini-two"]);
	});

	it("rejects exhausted page bounds and cursor cycles", async () => {
		const page = { models: [{ name: "models/gemini-one" }], nextPageToken: "again" };
		expect(await fetchGeminiModels({ apiKey: "secret", baseUrl, maxPages: 1, fetch: sequence([page]) })).toBeNull();
		expect(await fetchGeminiModels({ apiKey: "secret", baseUrl, fetch: sequence([page, page]) })).toBeNull();
	});

	it.each([{}, { models: [{}] }, { models: [{ name: "models/" }] }, { models: [], nextPageToken: 42 }])(
		"rejects malformed Gemini membership: %j",
		async payload => {
			expect(await fetchGeminiModels({ apiKey: "secret", baseUrl, fetch: sequence([payload]) })).toBeNull();
		},
	);
});
