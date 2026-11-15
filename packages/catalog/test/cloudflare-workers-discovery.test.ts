import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { getBundledModels, getModelPricingStatus } from "../src/models";
import { toModelSpec } from "../src/provider-models/bundled-references";

const credential = serializeCloudflareCredential({ token: "token", accountId: "account", gatewayId: "gateway" });

function discover(fetchMock: typeof fetch) {
	return cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }).fetchDynamicModels?.();
}

describe("Cloudflare Workers AI live catalog", () => {
	test("maps explicit search capabilities and ignores ambiguous properties", async () => {
		const properties = (values: Record<string, unknown>) =>
			Object.entries(values).map(([property_id, value]) => ({ property_id, value }));
		const fetchMock = (async () => Response.json({
			success: true,
			result: [
				{
					name: "@cf/example/capable",
					task: "text-generation",
					properties: properties({ context_window: "131072", function_calling: "true", reasoning: "true", vision: "true" }),
				},
				{
					name: "@cf/example/explicit-false",
					task: "text-generation",
					properties: properties({ function_calling: "false", reasoning: "false", vision: "false" }),
				},
				{
					name: "@cf/example/ambiguous",
					task: "text-generation",
					properties: [
						...properties({ context_window: "0", function_calling: "yes", reasoning: null, vision: "true" }),
						{ property_id: "vision", value: "false" },
					],
				},
			],
		})) as typeof fetch;

		const models = await discover(fetchMock);
		expect(models?.find(model => model.id.endsWith("/capable"))).toMatchObject({
			contextWindow: 131072, supportsTools: true, reasoning: true, input: ["text", "image"],
		});
		expect(models?.find(model => model.id.endsWith("/explicit-false"))).toMatchObject({
			supportsTools: false, reasoning: false, input: ["text"],
		});
		const ambiguous = models?.find(model => model.id.endsWith("/ambiguous"));
		expect(ambiguous).toMatchObject({ contextWindow: null, reasoning: false, input: ["text"] });
		expect(ambiguous?.supportsTools).toBeUndefined();
	});

	test("preserves bundled capabilities when search properties are absent or invalid", async () => {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		);
		if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
		const spec = toModelSpec(reference);
		const fetchMock = (async () => Response.json({
			success: true,
			result: [{
				name: reference.id.slice("workers-ai/".length),
				task: "text-generation",
				properties: [
					{ property_id: "context_window", value: "-1" },
					{ property_id: "vision", value: null },
					{ property_id: "reasoning", value: "unknown" },
				],
			}],
		})) as typeof fetch;
		const model = (await discover(fetchMock))?.[0];
		expect(model?.contextWindow).toBe(spec.contextWindow);
		expect(model?.input).toEqual(spec.input);
		expect(model?.reasoning).toBe(spec.reasoning);
		expect(model?.supportsTools).toBe(spec.supportsTools);
	});

	test("publishes classified unbundled models without inferring tool support", async () => {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		);
		if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
		const name = reference.id.slice("workers-ai/".length);
		const fetchMock = (async () => Response.json({
			success: true,
			result: [
				{ name, task: { name: "Text Generation" } },
				{ name: "@cf/cloudflare/clef", task: "text-generation" },
				{ name: "@cf/cloudflare/clef-flash", task: { name: "Text Generation" } },
				{ name: "@cf/example/unknown-decision", task: "text-generation" },
				{ name: "@cf/example/new-chat", task: { name: "Text Generation" }, context_window: 999999 },
				{ name: "@cf/example/new-chat", task: "text-generation" },
				{ name: "@hf/example/another-chat", task: "text-generation" },
				{ name: "@partner/example/new-chat", task: "text-generation" },
				{ name: "@cf/example/embedding", task: { name: "Text Embeddings" } },
				{ name: "@cf/example/image", task: "text-to-image" },
				{ name: "@cf/example/audio", task: "automatic-speech-recognition" },
				{ name: "@cf/example/unclassified" },
				{ name: "@cf/example/old-chat", task: "text-generation", status: "deprecated" },
				{ name: "../../invalid", task: "text-generation" },
			],
		})) as typeof fetch;

		const models = await discover(fetchMock);
		expect(models?.find(model => model.id === reference.id)).toMatchObject({
			id: reference.id,
			api: reference.api,
			contextWindow: reference.contextWindow,
			maxTokens: reference.maxTokens,
		});
		for (const name of ["@cf/example/unknown-decision", "@cf/example/new-chat", "@hf/example/another-chat", "@partner/example/new-chat"]) {
			const matches = models?.filter(model => model.id === `workers-ai/${name}`) ?? [];
			expect(matches).toHaveLength(1);
			expect(matches[0]).toMatchObject({ api: "openai-completions", input: ["text"], contextWindow: null, maxTokens: null });
			expect(matches[0]?.pricingStatus).toBe("unknown");
			expect(matches[0]?.supportsTools).toBeUndefined();
		}
		for (const name of ["embedding", "image", "audio", "unclassified", "old-chat"]) {
			expect(models?.some(model => model.id === `workers-ai/@cf/example/${name}`)).toBe(false);
		}
		expect(models?.some(model => model.id.includes("../../invalid"))).toBe(false);
	});

	test("does not overwrite trusted tool support for an unbundled catalog model", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-catalog-"));
		try {
			const fallback = modelsDevCatalogFallback("cloudflare-ai-gateway");
			if (!fallback) throw new Error("Expected a gateway catalog fallback");
			const fetchMock = (async () => Response.json({
				success: true,
				result: [{ name: "@cf/example/new-chat", task: "text-generation" }],
			})) as typeof fetch;
			const result = await resolveProviderModels({
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [],
				cacheDbPath: path.join(dir, "models.db"),
				modelsDev: {
					...fallback,
					fetch: async () => ({
						"cloudflare-workers-ai": {
							models: { "@cf/example/new-chat": { name: "New Chat", tool_call: true, limit: { context: 12345 } } },
						},
					}),
				},
			}, "online");
			const model = result.models.find(model => model.id === "workers-ai/@cf/example/new-chat");
			expect(model).toBeDefined();
			expect(model?.contextWindow).toBe(12345);
			// models.dev represents tool-capable chat models by omitting supportsTools.
			expect(model?.supportsTools).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("uses pagination metadata even when a page is short and deduplicates across pages", async () => {
		const references = getBundledModels("cloudflare-ai-gateway").filter(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		).slice(0, 2);
		if (references.length < 2) throw new Error("Expected two bundled Workers AI gateway chat models");
		const [first, second] = references.map(model => model.id.slice("workers-ai/".length));
		const pages: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			if (new URL(String(input)).searchParams.has("format")) return Response.json({ data: [] });
			const page = new URL(String(input)).searchParams.get("page") ?? "";
			pages.push(page);
			return Response.json({
				success: true,
				result_info: { total_pages: 2 },
				result: page === "1"
					? [{ name: first, task: "text-generation" }]
					: [
						{ name: first, task: "text-generation" },
						{ name: second, task: "text-generation" },
					],
			});
		}) as typeof fetch;

		const models = await discover(fetchMock);
		expect(pages).toEqual(["1", "2"]);
		expect(models).toEqual(references.map(model => ({ ...toModelSpec(model), discoveryCostFields: [], discoveryMetadataFields: [] })));
	});

	test("returns null instead of a partial catalog on malformed later page", async () => {
		let calls = 0;
		const fetchMock = (async () => {
			calls++;
			return calls === 1
				? Response.json({ success: true, result_info: { total_pages: 2 }, result: [{ name: "@cf/example/first", task: "text-generation" }] })
				: new Response("not json", { status: 200 });
		}) as typeof fetch;
		expect(await discover(fetchMock)).toBeNull();
		expect(calls).toBe(2);
	});

	test("returns null on network errors and invalid pagination metadata", async () => {
		const networkError = (async () => { throw new Error("network error"); }) as typeof fetch;
		expect(await discover(networkError)).toBeNull();
		for (const totalPages of [-1, 1.5, "2"]) {
			const fetchMock = (async () => Response.json({ success: true, result: [], result_info: { total_pages: totalPages } })) as typeof fetch;
			expect(await discover(fetchMock)).toBeNull();
		}
	});

	test("maps USD per-million token prices from search properties", async () => {
		const fetchMock = (async () => Response.json({ success: true, result: [{
			name: "@cf/example/priced", task: "text-generation", properties: [{ property_id: "price", value: [
				{ unit: "per M input tokens", price: 0.3, currency: "USD" },
				{ unit: "per M output tokens", price: 1, currency: "USD" },
				{ unit: "per M cached input tokens", price: 0.1, currency: "USD" },
			] }],
		}] })) as typeof fetch;
		const models = await discover(fetchMock);
		expect(models?.[0]?.cost).toEqual({ input: 0.3, output: 1, cacheRead: 0.1, cacheWrite: 0 });
		expect(getModelPricingStatus(models![0])).toBe("fixed");
	});

	test("keeps incomplete and unsupported rates unknown without inventing output prices", async () => {
		const entries = [
			{ name: "@cf/example/missing", properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0, currency: "USD" }] }] },
			{ name: "@cf/example/unsupported", properties: [{ property_id: "price", value: [{ unit: "per request", price: 1, currency: "USD" }] }] },
			{ name: "@cf/example/invalid", properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 2, currency: "EUR" }] }] },
		];
		const fetchMock = (async () => Response.json({ success: true, result: entries.map(entry => ({ ...entry, task: "text-generation" })) })) as typeof fetch;
		for (const model of (await discover(fetchMock))!) {
			expect(model.cost.output).toBe(0);
			expect(getModelPricingStatus(model)).toBe("unknown");
		}
	});

	test("gives explicit unknown precedence without changing legacy free and fixed resolution", () => {
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const positive = { ...zero, input: 0.24 };
		expect(getModelPricingStatus({ cost: positive, pricingStatus: "unknown" })).toBe("unknown");
		expect(getModelPricingStatus({ cost: positive, pricingStatus: "free" })).toBe("fixed");
		expect(getModelPricingStatus({ cost: positive })).toBe("fixed");
		expect(getModelPricingStatus({ cost: zero, pricingStatus: "free" })).toBe("free");
		expect(getModelPricingStatus({ cost: zero })).toBe("unknown");
	});

	test("rejects ambiguous duplicate and malformed price cards", async () => {
		const price = { unit: "per M input tokens", price: 0.24, currency: "USD" };
		const fetchMock = (async () => Response.json({ success: true, result: [
			{ name: "@cf/example/duplicate-unit", task: "text-generation", properties: [{ property_id: "price", value: [price, price] }] },
			{ name: "@cf/example/duplicate-card", task: "text-generation", properties: [
				{ property_id: "price", value: [price] }, { property_id: "price", value: [price] },
			] },
			{ name: "@cf/example/malformed", task: "text-generation", properties: [{ property_id: "price", value: null }] },
		] })) as typeof fetch;
		for (const model of (await discover(fetchMock))!) {
			expect(model.cost.input).toBe(0);
			expect(getModelPricingStatus(model)).toBe("unknown");
		}
	});

	test("prices input-only Clef variants while keeping other incomplete cards unknown", async () => {
		const entries = [
			{ name: "@cf/cloudflare/clef", value: [{ unit: "per M input tokens", price: 0.24, currency: "USD" }], cost: [0.24, 0], status: "fixed" },
			{ name: "@cf/cloudflare/clef-flash", value: [{ unit: "per M input tokens", price: 0.08, currency: "USD" }], cost: [0.08, 0], status: "fixed" },
			{ name: "@cf/example/clef", value: [{ unit: "per M input tokens", price: 0.24, currency: "USD" }], cost: [0.24, 0], status: "unknown" },
			{ name: "@cf/cloudflare/clef-other", value: [{ unit: "per M input tokens", price: 0.24, currency: "USD" }], cost: [0.24, 0], status: "unknown" },
			{ name: "@cf/example/input-only", value: [{ unit: "per M input tokens", price: 0.3, currency: "USD" }], cost: [0.3, 0], status: "unknown" },
			{ name: "@cf/example/partial", value: [{ unit: "per M output tokens", price: 1, currency: "USD" }], cost: [0, 1], status: "unknown" },
			{ name: "@cf/example/extra", value: [
				{ unit: "per M input tokens", price: 0.3, currency: "USD" },
				{ unit: "per M output tokens", price: 1, currency: "USD" },
				{ unit: "per request", price: 1, currency: "USD" },
			], cost: [0.3, 1], status: "unknown" },
		];
		const fetchMock = (async () => Response.json({ success: true, result: entries.map(entry => ({
			name: entry.name, task: "text-generation", properties: [{ property_id: "price", value: entry.value }],
		})) })) as typeof fetch;
		const models = (await discover(fetchMock))!;
		for (const entry of entries) {
			const model = models.find(item => item.id === `workers-ai/${entry.name}`)!;
			expect([model.cost.input, model.cost.output]).toEqual(entry.cost);
			expect(getModelPricingStatus(model)).toBe(entry.status);
		}
	});

	test("does not treat malformed Clef price cards as complete", async () => {
		const entries = [
			{ name: "@cf/cloudflare/clef", value: [
				{ unit: "per M input tokens", price: 0.24, currency: "USD" },
				{ unit: "per request", price: 1, currency: "USD" },
			] },
			{ name: "@cf/cloudflare/clef-flash", value: [
				{ unit: "per M output tokens", price: 1, currency: "USD" },
			] },
		];
		const fetchMock = (async () => Response.json({ success: true, result: entries.map(entry => ({
			name: entry.name, task: "text-generation", properties: [{ property_id: "price", value: entry.value }],
		})) })) as typeof fetch;
		const models = (await discover(fetchMock))!;
		for (const entry of entries) {
			const model = models.find(item => item.id === `workers-ai/${entry.name}`)!;
			expect(getModelPricingStatus(model)).toBe("unknown");
		}
	});

	test("updates valid bundled rates while marking an incomplete live card unknown", async () => {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions" && model.cost.input > 0,
		);
		if (!reference) throw new Error("Expected a priced bundled Workers AI gateway chat model");
		const fetchMock = (async () => Response.json({ success: true, result: [{
			name: reference.id.slice("workers-ai/".length), task: "text-generation",
			properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 999, currency: "USD" }] }],
		}] })) as typeof fetch;
		const model = (await discover(fetchMock))![0];
		expect(model.cost).toEqual({ ...reference.cost, input: 999 });
		expect(getModelPricingStatus(model)).toBe("unknown");
	});

	test("retains an input-only Clef price and fixed status through merge and cache", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-pricing-"));
		try {
			const id = "workers-ai/@cf/cloudflare/clef";
			const reference = getBundledModels("cloudflare-ai-gateway").find(
				model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
			);
			if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
			const staticModel = { ...toModelSpec(reference), id, cost: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }, pricingStatus: "free" as const };
			const fetchMock = (async () => Response.json({ success: true, result: [{
				name: "@cf/cloudflare/clef", task: "text-generation",
				properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.24, currency: "USD" }] }],
			}] })) as typeof fetch;
			const options = {
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [staticModel],
				modelsDev: undefined,
				cacheDbPath: path.join(dir, "models.db"),
			};
			const online = await resolveProviderModels(options, "online");
			const cached = await resolveProviderModels(options, "offline");
			for (const result of [online, cached]) {
				const model = result.models.find(item => item.id === id);
				expect(model?.cost.input).toBe(0.24);
				expect(model?.cost.output).toBe(0);
				expect(model?.pricingStatus).not.toBe("unknown");
				expect(model && getModelPricingStatus(model)).toBe("fixed");
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("merges explicit zero prices without replacing omitted cached rates", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-sparse-pricing-"));
		try {
			const reference = getBundledModels("cloudflare-ai-gateway").find(
				model => model.id.startsWith("workers-ai/") && model.api === "openai-completions" &&
					model.cost.input > 0 && model.cost.output > 0,
			);
			if (!reference) throw new Error("Expected a priced bundled Workers AI gateway chat model");
			let prices = [
				{ unit: "per M input tokens", price: 11, currency: "USD" },
				{ unit: "per M output tokens", price: 12, currency: "USD" },
				{ unit: "per M cached input tokens", price: 13, currency: "USD" },
			];
			let includePrice = true;
			const fetchMock = (async () => Response.json({ success: true, result: [{
				name: reference.id.slice("workers-ai/".length), task: "text-generation",
				properties: includePrice ? [{ property_id: "price", value: prices }] : [],
			}] })) as typeof fetch;
			const options = {
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [toModelSpec(reference)],
				modelsDev: undefined,
				cacheDbPath: path.join(dir, "models.db"),
				alwaysRefetchDynamicModels: true,
			};
			await resolveProviderModels(options, "online");
			prices = [{ unit: "per M input tokens", price: 0, currency: "USD" }];
			const refreshed = await resolveProviderModels(options, "online");
			const cached = await resolveProviderModels(options, "offline");
			for (const result of [refreshed, cached]) {
				const model = result.models.find(item => item.id === reference.id);
				expect(model?.cost.input).toBe(0);
				expect(model?.cost.output).toBe(12);
				expect(model?.cost.cacheRead).toBe(13);
				expect(model?.pricingStatus).toBe("unknown");
				expect(model && getModelPricingStatus(model)).toBe("unknown");
			}
			includePrice = false;
			const withoutPrice = await resolveProviderModels(options, "online");
			const unchanged = withoutPrice.models.find(item => item.id === reference.id);
			expect(unchanged?.cost.input).toBe(0);
			expect(unchanged?.cost.output).toBe(12);
			expect(unchanged?.cost.cacheRead).toBe(13);
			expect(unchanged && getModelPricingStatus(unchanged)).toBe("unknown");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("retains sparse capability updates across refresh and static catalog changes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-capabilities-"));
		try {
			const reference = getBundledModels("cloudflare-ai-gateway").find(
				model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
			);
			if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
			let properties = [
				{ property_id: "context_window", value: "131072" },
				{ property_id: "function_calling", value: "false" },
				{ property_id: "reasoning", value: "false" },
				{ property_id: "vision", value: "false" },
			];
			const fetchMock = (async () => Response.json({ success: true, result: [{
				name: reference.id.slice("workers-ai/".length), task: "text-generation", properties,
			}] })) as typeof fetch;
			const staticModel = { ...toModelSpec(reference), reasoning: true, input: ["text", "image"] as ("text" | "image")[], supportsTools: true };
			const options = {
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [staticModel],
				modelsDev: undefined,
				cacheDbPath: path.join(dir, "models.db"),
				alwaysRefetchDynamicModels: true,
			};
			await resolveProviderModels(options, "online");
			properties = [];
			const refreshed = await resolveProviderModels(options, "online");
			const cached = await resolveProviderModels({
				...options,
				staticModels: [{ ...staticModel, contextWindow: 8192 }],
			}, "offline");
			for (const result of [refreshed, cached]) {
				expect(result.models.find(model => model.id === reference.id)).toMatchObject({
					contextWindow: 131072, input: ["text"], reasoning: false, supportsTools: false,
				});
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("retains only discovered fields on an online refresh after static catalog changes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-changed-static-"));
		try {
			const reference = getBundledModels("cloudflare-ai-gateway").find(
				model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
			);
			if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
			let properties: { property_id: string; value: unknown }[] = [
				{ property_id: "context_window", value: "4096" },
				{ property_id: "function_calling", value: "false" },
				{ property_id: "price", value: [{ unit: "per M input tokens", price: 0, currency: "USD" }] },
			];
			const fetchMock = (async () => Response.json({ success: true, result: [{
				name: reference.id.slice("workers-ai/".length), task: "text-generation", properties,
			}] })) as typeof fetch;
			const staticModel = {
				...toModelSpec(reference),
				contextWindow: 32768,
				supportsTools: true,
				cost: { ...reference.cost, input: 5, output: 6 },
			};
			const options = {
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [staticModel],
				modelsDev: undefined,
				cacheDbPath: path.join(dir, "models.db"),
				alwaysRefetchDynamicModels: true,
			};
			const first = await resolveProviderModels(options, "online");
			expect(first.models.find(model => model.id === reference.id)).toMatchObject({
				contextWindow: 4096, supportsTools: false, cost: { input: 0, output: 6 },
			});
			properties = [];
			const changed = {
				...staticModel,
				contextWindow: 65536,
				cost: { ...staticModel.cost, input: 7, output: 8 },
			};
			const refreshed = await resolveProviderModels({ ...options, staticModels: [changed] }, "online");
			expect(refreshed.models.find(model => model.id === reference.id)).toMatchObject({
				contextWindow: 4096, supportsTools: false, cost: { input: 0, output: 8 },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("does not restore dropped cached discovery fields after a fingerprint change", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workers-dropped-cache-"));
		try {
			const reference = getBundledModels("cloudflare-ai-gateway").find(
				model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
			);
			if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
			let properties: { property_id: string; value: unknown }[] = [
				{ property_id: "context_window", value: "4096" },
				{ property_id: "function_calling", value: "false" },
				{ property_id: "price", value: [{ unit: "per M input tokens", price: 0, currency: "USD" }] },
			];
			const fetchMock = (async () => Response.json({ success: true, result: [{
				name: reference.id.slice("workers-ai/".length), task: "text-generation", properties,
			}] })) as typeof fetch;
			const staticModel = {
				...toModelSpec(reference),
				contextWindow: 32768,
				supportsTools: true,
				cost: { ...reference.cost, input: 5 },
			};
			const options = {
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				staticModels: [staticModel],
				modelsDev: undefined,
				cacheDbPath: path.join(dir, "models.db"),
				alwaysRefetchDynamicModels: true,
			};
			await resolveProviderModels(options, "online");
			properties = [];
			const refreshed = await resolveProviderModels({
				...options,
				dropCachedModelIdsOnStaticMismatch: [reference.id],
			}, "online");
			expect(refreshed.models.find(model => model.id === reference.id)).toMatchObject({
				contextWindow: 32768, supportsTools: true, cost: { input: 5 },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("accepts an empty successful catalog without treating it as failure", async () => {
		const fetchMock = (async () => Response.json({ success: true, result: [] })) as typeof fetch;
		expect(await discover(fetchMock)).toEqual([]);
	});
});
