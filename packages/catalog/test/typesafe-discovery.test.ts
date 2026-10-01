import { describe, expect, test } from "bun:test";
import { fetchTypeSafeModels } from "../src/discovery/typesafe";
import { typesafeModelManagerOptions } from "../src/provider-models/special";
import type { FetchImpl } from "../src/types";

describe("TypeSafe model discovery", () => {
	test("authenticates GET /v1/models and maps the official envelope", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: FetchImpl = async (input, init) => {
			calls.push({ url: String(input), init });
			return Response.json({
				models: [
					{ name: "jev-latest", description: "TypeSafe jev", release_date: "2026-09-01" },
					{ name: "jev-fast", description: "TypeSafe jev Fast", release_date: "2026-09-12" },
				],
			});
		};

		const models = await fetchTypeSafeModels({ apiKey: "ts-secret", baseUrl: "https://typesafe.test/", fetch });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://typesafe.test/v1/models");
		expect(calls[0]?.init?.method).toBe("GET");
		expect(calls[0]?.init?.headers).toEqual({
			Accept: "application/json",
			Authorization: "Bearer ts-secret",
		});
		expect(models).toEqual([
			{
				id: "jev-latest",
				name: "TypeSafe jev",
				api: "typesafe",
				provider: "typesafe",
				baseUrl: "https://typesafe.test",
				kind: "judge",
				reasoning: false,
				input: ["text"],
				supportsTools: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
			},
			{
				id: "jev-fast",
				name: "TypeSafe jev Fast",
				api: "typesafe",
				provider: "typesafe",
				baseUrl: "https://typesafe.test",
				kind: "judge",
				reasoning: false,
				input: ["text"],
				supportsTools: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
			},
		]);
	});

	test("rejects failed and malformed discovery responses without inventing models", async () => {
		const unauthorized = await fetchTypeSafeModels({
			apiKey: "bad",
			fetch: async () => new Response("unauthorized", { status: 401 }),
		});
		const malformedEnvelope = await fetchTypeSafeModels({
			apiKey: "k",
			fetch: async () => Response.json({ data: [] }),
		});
		const malformedJson = await fetchTypeSafeModels({
			apiKey: "k",
			fetch: async () => new Response("not json"),
		});
		const malformedCard = await fetchTypeSafeModels({
			apiKey: "k",
			fetch: async () => Response.json({ models: [{ name: "jev-broken" }] }),
		});
		const transportFailure = await fetchTypeSafeModels({
			apiKey: "k",
			fetch: async () => {
				throw new Error("offline");
			},
		});

		expect(unauthorized).toBeNull();
		expect(malformedEnvelope).toBeNull();
		expect(malformedJson).toBeNull();
		expect(malformedCard).toBeNull();
		expect(transportFailure).toBeNull();
	});

	test("manager keeps the offline seed and enables authoritative live discovery with credentials", async () => {
		const options = typesafeModelManagerOptions({
			apiKey: "ts-key",
			baseUrl: "https://typesafe.internal/",
			fetch: async () =>
				Response.json({
					models: [{ name: "jev-enterprise", description: "Jev Enterprise", release_date: "2026-09-10" }],
				}),
		});
		expect(options.providerId).toBe("typesafe");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.staticModels?.map(model => ({ id: model.id, baseUrl: model.baseUrl }))).toEqual([
			{ id: "jev-latest", baseUrl: "https://typesafe.internal" },
		]);
		expect((await options.fetchDynamicModels?.())?.map(model => model.id)).toEqual(["jev-enterprise"]);
	});
});
