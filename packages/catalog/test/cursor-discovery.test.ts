import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import type * as net from "node:net";
import * as zlib from "node:zlib";
import { Effort } from "../src/effort";
import { buildModel } from "../src/build";
import { cursorCatalogModels, fetchCursorUsableModels, resolveCursorInput } from "../src/discovery/cursor";
import { createModelManager } from "../src/model-manager";
import { isCredentialScopedModelCacheProvider } from "../src/provider-models/cache-provider-id";
import { cursorModelManagerOptions } from "../src/provider-models/special";
import type { AvailableModelsResponse_ModelVariantConfig, ModelDetails } from "../src/discovery/cursor-proto";
import {
	AvailableModelsResponse_AvailableModelSchema,
	AvailableModelsResponse_ModelVariantConfigSchema,
	AvailableModelsResponseSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
	RequestedModel_ModelParameterValueSchema,
} from "../src/discovery/cursor-proto";
import { create, toBinary } from "../src/discovery/protobuf";
import { resolveWireModelId } from "../src/model-thinking";

const servers = new Set<http2.Http2Server>();

afterEach(async () => {
	await Promise.all(
		[...servers].map(server => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close(error => (error ? reject(error) : resolve()));
			return promise;
		}),
	);
	servers.clear();
});

function requireTcpAddress(address: string | net.AddressInfo | null): net.AddressInfo {
	if (!address || typeof address === "string") throw new Error("HTTP/2 test server did not bind to a TCP address");
	return address;
}

function model(id: string, fields: Partial<ModelDetails> = {}) {
	return create(ModelDetailsSchema, { modelId: id, displayName: id, ...fields });
}

function parameter(id: string, value: string) {
	return create(RequestedModel_ModelParameterValueSchema, { id, value });
}

function variant(
	context: string | undefined,
	options: { readonly max?: boolean; readonly defaultNormal?: boolean; readonly defaultMax?: boolean },
) {
	return create(AvailableModelsResponse_ModelVariantConfigSchema, {
		parameterValues: context === undefined ? [] : [parameter("context", context)],
		isMaxMode: options.max ?? false,
		isDefaultNonMaxConfig: options.defaultNormal,
		isDefaultMaxConfig: options.defaultMax,
	});
}

function routedVariant(
	legacySlug: string,
	values: Readonly<Record<string, string>>,
	options: { readonly max?: boolean; readonly defaultNormal?: boolean; readonly defaultMax?: boolean } = {},
) {
	return create(AvailableModelsResponse_ModelVariantConfigSchema, {
		legacySlug,
		parameterValues: Object.entries(values).map(([id, value]) => parameter(id, value)),
		isMaxMode: options.max ?? false,
		isDefaultNonMaxConfig: options.defaultNormal,
		isDefaultMaxConfig: options.defaultMax,
	});
}

function available(
	name: string,
	options: {
		readonly displayName?: string;
		readonly aliases?: string[];
		readonly legacySlugs?: string[];
		readonly thinking?: boolean;
		readonly images?: boolean;
		readonly supportsMax?: boolean;
		readonly supportsNonMax?: boolean;
		readonly context?: number;
		readonly maxContext?: number;
		readonly variants?: AvailableModelsResponse_ModelVariantConfig[];
	} = {},
) {
	return create(AvailableModelsResponse_AvailableModelSchema, {
		name,
		clientDisplayName: options.displayName,
		idAliases: options.aliases ?? [],
		legacySlugs: options.legacySlugs ?? [],
		supportsThinking: options.thinking,
		supportsImages: options.images,
		supportsMaxMode: options.supportsMax,
		supportsNonMaxMode: options.supportsNonMax,
		contextTokenLimit: options.context,
		contextTokenLimitForMaxMode: options.maxContext,
		variants: options.variants ?? [],
	});
}

function catalogFixture() {
	const usable = create(GetUsableModelsResponseSchema, {
		models: [
			model("composer-2.5"),
			model("gemini-3.7-flash-low"),
			model("gemini-3.7-flash-medium"),
			model("gemini-3.7-flash-high"),
			model("cursor-grok-4.6-low"),
			model("cursor-grok-4.6-medium"),
			model("cursor-grok-4.6-high"),
			model("cursor-grok-4.6-xhigh"),
			model("gpt-5.6-sol-none"),
			model("gpt-5.6-sol-low"),
			model("gpt-5.6-sol-medium"),
			model("gpt-5.6-sol-high"),
			model("gpt-5.6-sol-xhigh"),
			model("claude-opus-5-thinking-low"),
			model("claude-opus-5-thinking-medium"),
			model("claude-opus-5-thinking-high"),
		],
	});
	const availableModels = create(AvailableModelsResponseSchema, {
		models: [
			available("composer-2.5", {
				displayName: "Composer 2.5",
				thinking: true,
				context: 200_000,
				variants: [routedVariant("composer-2.5", { fast: "false" }, { defaultNormal: true })],
			}),
			available("gemini-3.7-flash", {
				displayName: "Gemini 3.7 Flash",
				thinking: true,
				images: true,
				context: 1_000_000,
				variants: ["low", "medium", "high"].map(effort =>
					routedVariant(`gemini-3.7-flash-${effort}`, { effort }, { defaultNormal: effort === "medium" }),
				),
			}),
			available("grok-4.6", {
				displayName: "Cursor Grok 4.6",
				legacySlugs: [
					"cursor-grok-4.6-low",
					"cursor-grok-4.6-medium",
					"cursor-grok-4.6-high",
					"cursor-grok-4.6-xhigh",
				],
				thinking: true,
				images: true,
				supportsMax: true,
				supportsNonMax: true,
				context: 256_000,
				maxContext: 256_000,
				variants: ["low", "medium", "high", "xhigh"].map(effort =>
					routedVariant(
						`cursor-grok-4.6-${effort}`,
						{ effort, fast: "false" },
						{ defaultNormal: effort === "medium" },
					),
				),
			}),
			available("gpt-5.6-sol", {
				displayName: "GPT-5.6 Sol",
				thinking: true,
				images: true,
				supportsMax: true,
				supportsNonMax: true,
				context: 272_000,
				maxContext: 1_000_000,
				variants: [
					...["none", "low", "medium", "high", "xhigh"].map(reasoning =>
						routedVariant(
							`gpt-5.6-sol-${reasoning}`,
							{ context: "272k", reasoning, fast: "false" },
							{ defaultNormal: reasoning === "medium" },
						),
					),
					...["none", "low", "medium", "high", "xhigh"].map(reasoning =>
						routedVariant(
							`gpt-5.6-sol-${reasoning}`,
							{ context: "1m", reasoning, fast: "false" },
							{ max: true, defaultMax: reasoning === "medium" },
						),
					),
				],
			}),
			available("claude-opus-5-thinking", {
				displayName: "Claude Opus 5",
				thinking: true,
				images: true,
				supportsMax: true,
				supportsNonMax: true,
				context: 300_000,
				maxContext: 1_000_000,
				variants: [variant("300k", { defaultNormal: true }), variant("1m", { max: true, defaultMax: true })],
			}),
		],
	});
	const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[1] });
	return { availableModels, usable, defaultModel };
}

function builtCatalog() {
	const fixture = catalogFixture();
	return cursorCatalogModels(
		fixture.availableModels,
		fixture.usable,
		fixture.defaultModel,
		"https://api2.cursor.sh",
		new Map(),
	).map(spec => buildModel(spec));
}

async function startCursorDiscoveryServer(): Promise<string> {
	const fixture = catalogFixture();
	const payloads = new Map([
		["/aiserver.v1.AiService/AvailableModels", toBinary(AvailableModelsResponseSchema, fixture.availableModels)],
		["/agent.v1.AgentService/GetUsableModels", toBinary(GetUsableModelsResponseSchema, fixture.usable)],
		[
			"/agent.v1.AgentService/GetDefaultModelForCli",
			toBinary(GetDefaultModelForCliResponseSchema, fixture.defaultModel),
		],
	]);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const server = http2.createServer();
	servers.add(server);
	server.once("error", reject);
	server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
		const payload = payloads.get(String(headers[":path"]));
		if (payload === undefined) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		stream.end(Buffer.from(payload));
	});
	server.listen(0, "127.0.0.1", () => {
		resolve(`http://127.0.0.1:${requireTcpAddress(server.address()).port}`);
	});
	return await promise;
}

describe("Cursor complete catalog join", () => {
	it("scopes the authoritative catalog cache by credential and endpoint", () => {
		const first = cursorModelManagerOptions({ apiKey: "first-token" });
		const second = cursorModelManagerOptions({ apiKey: "second-token" });
		const alternate = cursorModelManagerOptions({ apiKey: "first-token", baseUrl: "https://cursor.example" });
		expect(first.cacheProviderId?.startsWith("cursor:complete-catalog-v8:")).toBe(true);
		expect(second.cacheProviderId).not.toBe(first.cacheProviderId);
		expect(alternate.cacheProviderId).not.toBe(first.cacheProviderId);
		expect(first.dynamicModelsAuthoritative).toBe(true);
		expect(first.dynamicModelCapabilitiesAuthoritative).toBe(true);
		expect(first.dynamicModelLimitsAuthoritative).toBe(true);
		expect(isCredentialScopedModelCacheProvider("cursor")).toBe(true);
	});

	it("applies explicitly authoritative discovered capabilities and limits without provider-specific branches", async () => {
		const base = {
			id: "account-scoped-route",
			name: "Account-scoped Route",
			provider: "account-catalog-test",
			api: "cursor-agent" as const,
			baseUrl: "https://catalog.example.test",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		};
		const manager = createModelManager({
			providerId: "account-catalog-test",
			staticModels: [{ ...base, reasoning: true, input: ["text", "image"] }],
			fetchDynamicModels: async () => [{ ...base, reasoning: false, input: ["text"], maxTokens: null }],
			dynamicModelsAuthoritative: true,
			dynamicModelCapabilitiesAuthoritative: true,
			dynamicModelLimitsAuthoritative: true,
			cacheDbPath: ":memory:",
		});

		const { models } = await manager.refresh("online");
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ input: ["text"], reasoning: false, maxTokens: null });
		expect(models[0]?.thinking).toBeUndefined();
	});

	it("uses the authoritative 1M Gemini window instead of the 200k fallback", () => {
		const gemini = builtCatalog().find(candidate => candidate.id === "gemini-3.7-flash");
		expect(gemini).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: null,
			input: ["text", "image"],
			reasoning: true,
			requestModelId: "gemini-3.7-flash-medium",
		});
		expect(gemini?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(gemini?.cursorMaxMode).toBe(false);
	});

	it("preserves every fetched supported effort for the live-tested model families", () => {
		const models = builtCatalog();
		const expected = [
			{
				id: "composer-2.5",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				routes: ["composer-2.5", "composer-2.5", "composer-2.5", "composer-2.5"],
				targetModelId: "composer-2.5",
				parameters: () => [{ id: "fast", value: "false" }],
			},
			{
				id: "gemini-3.7-flash",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				routes: ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"],
				targetModelId: "gemini-3.7-flash",
				parameters: (effort: Effort) => [{ id: "effort", value: effort }],
			},
			{
				id: "grok-4.6",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				routes: ["cursor-grok-4.6-low", "cursor-grok-4.6-medium", "cursor-grok-4.6-high", "cursor-grok-4.6-xhigh"],
				targetModelId: "grok-4.6",
				parameters: (effort: Effort) => [
					{ id: "effort", value: effort },
					{ id: "fast", value: "false" },
				],
			},
			{
				id: "gpt-5.6-sol",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				routes: ["gpt-5.6-sol-low", "gpt-5.6-sol-medium", "gpt-5.6-sol-high", "gpt-5.6-sol-xhigh"],
				targetModelId: "gpt-5.6-sol",
				parameters: (effort: Effort) => [
					{ id: "context", value: "272k" },
					{ id: "reasoning", value: effort },
					{ id: "fast", value: "false" },
				],
			},
		] as const;

		for (const fixture of expected) {
			const model = models.find(candidate => candidate.id === fixture.id);
			expect(model?.thinking?.efforts).toEqual(fixture.efforts);
			const routes = fixture.efforts.map(effort => (model ? resolveWireModelId(model, effort) : undefined));
			expect(routes).toEqual([...fixture.routes]);
			expect(routes.map(route => (route === undefined ? undefined : model?.cursorModelRoutes?.[route]))).toEqual(
				fixture.efforts.map(effort => ({ modelId: fixture.targetModelId, parameters: fixture.parameters(effort) })),
			);
		}
	});

	it("does not invent a redundant Grok Max row when both catalog modes are equivalent", () => {
		const grok = builtCatalog().filter(candidate => candidate.id.startsWith("grok-4.6"));
		expect(grok).toHaveLength(1);
		expect(grok[0]).toMatchObject({ contextWindow: 256_000, cursorMaxMode: false });
	});

	it("derives Max row IDs from authoritative context metadata", () => {
		const usable = create(GetUsableModelsResponseSchema, {
			models: [model("future-max-route")],
		});
		const availableModels = create(AvailableModelsResponseSchema, {
			models: [
				available("future-max-route", {
					supportsMax: true,
					supportsNonMax: true,
					context: 128_000,
					maxContext: 256_000,
					variants: [variant("128k", { defaultNormal: true }), variant("256k", { max: true, defaultMax: true })],
				}),
			],
		});
		const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[0] });
		const models = cursorCatalogModels(availableModels, usable, defaultModel, "https://api2.cursor.sh", new Map());

		expect(models.map(candidate => candidate.id)).toEqual(["future-max-route", "future-max-route-256k"]);
		expect(models[1]).toMatchObject({ contextWindow: 256_000, cursorContext: "256k", cursorMaxMode: true });
	});

	it("does not collapse undeclared effort-looking model families", () => {
		const usable = create(GetUsableModelsResponseSchema, {
			models: [model("future-model-low"), model("future-model-high")],
		});
		const availableModels = create(AvailableModelsResponseSchema, {
			models: [available("future-model-low"), available("future-model-high")],
		});
		const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[1] });
		const models = cursorCatalogModels(availableModels, usable, defaultModel, "https://api2.cursor.sh", new Map());
		expect(models.map(candidate => candidate.id)).toEqual(["future-model-low", "future-model-high"]);
	});

	it("collapses an available legacy family without a hard-coded route", () => {
		const usable = create(GetUsableModelsResponseSchema, {
			models: [model("claude-4.6-opus-low"), model("claude-4.6-opus-high")],
		});
		const availableModels = create(AvailableModelsResponseSchema, {
			models: [available("claude-4.6-opus", { thinking: true, images: true, context: 300_000 })],
		});
		const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[1] });
		const models = cursorCatalogModels(availableModels, usable, defaultModel, "https://api2.cursor.sh", new Map());
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "claude-4.6-opus",
			requestModelId: "claude-4.6-opus-high",
			thinking: {
				efforts: [Effort.Low, Effort.High],
				effortRouting: {
					[Effort.Low]: "claude-4.6-opus-low",
					[Effort.High]: "claude-4.6-opus-high",
				},
			},
		});
	});

	it("maps selector legacy slugs through their complete base-model variants", () => {
		const slugs = [
			"claude-opus-5-low",
			"claude-opus-5-medium",
			"claude-opus-5-high",
			"claude-opus-5-thinking-low",
			"claude-opus-5-thinking-medium",
			"claude-opus-5-thinking-high",
		];
		const usable = create(GetUsableModelsResponseSchema, { models: slugs.map(id => model(id)) });
		const variants = [false, true].flatMap(maxMode =>
			slugs.map(slug => {
				const thinking = slug.includes("-thinking-");
				const effort = slug.endsWith("-low") ? "low" : slug.endsWith("-medium") ? "medium" : "high";
				return routedVariant(
					slug,
					{ thinking: String(thinking), context: maxMode ? "1m" : "300k", effort, fast: "false" },
					{
						max: maxMode,
						defaultNormal: !maxMode && thinking && effort === "high",
						defaultMax: maxMode && thinking && effort === "high",
					},
				);
			}),
		);
		const availableModels = create(AvailableModelsResponseSchema, {
			models: [
				available("claude-opus-5", {
					displayName: "Claude Opus 5",
					legacySlugs: slugs,
					thinking: true,
					images: true,
					supportsMax: true,
					supportsNonMax: true,
					context: 300_000,
					maxContext: 1_000_000,
					variants,
				}),
			],
		});
		const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[5] });
		const models = cursorCatalogModels(availableModels, usable, defaultModel, "https://api2.cursor.sh", new Map());
		expect(models.map(candidate => candidate.id)).toEqual(["claude-opus-5", "claude-opus-5-1m"]);
		expect(models[0]).toMatchObject({
			requestModelId: "claude-opus-5-thinking-high",
			thinking: {
				effortRouting: {
					off: "claude-opus-5-high",
					low: "claude-opus-5-thinking-low",
					medium: "claude-opus-5-thinking-medium",
					high: "claude-opus-5-thinking-high",
				},
			},
			cursorModelRoutes: {
				"claude-opus-5-medium": {
					modelId: "claude-opus-5",
					parameters: [
						{ id: "thinking", value: "false" },
						{ id: "context", value: "300k" },
						{ id: "effort", value: "medium" },
						{ id: "fast", value: "false" },
					],
				},
				"claude-opus-5-thinking-medium": {
					modelId: "claude-opus-5",
					parameters: [
						{ id: "thinking", value: "true" },
						{ id: "context", value: "300k" },
						{ id: "effort", value: "medium" },
						{ id: "fast", value: "false" },
					],
				},
			},
		});
		const built = buildModel(models[0]!);
		const thinkingEfforts = [Effort.Low, Effort.Medium, Effort.High];
		const thinkingRoutes = [
			"claude-opus-5-thinking-low",
			"claude-opus-5-thinking-medium",
			"claude-opus-5-thinking-high",
		];
		expect(built.thinking?.efforts).toEqual(thinkingEfforts);
		expect(thinkingEfforts.map(effort => resolveWireModelId(built, effort))).toEqual(thinkingRoutes);
		expect(thinkingRoutes.map(route => built.cursorModelRoutes?.[route])).toEqual(
			thinkingEfforts.map(effort => ({
				modelId: "claude-opus-5",
				parameters: [
					{ id: "thinking", value: "true" },
					{ id: "context", value: "300k" },
					{ id: "effort", value: effort },
					{ id: "fast", value: "false" },
				],
			})),
		);
		expect(models[1]?.cursorModelRoutes?.["claude-opus-5-thinking-medium"]?.parameters).toContainEqual({
			id: "context",
			value: "1m",
		});
	});

	it("strips KDL-authored effort labels from fallback display names", () => {
		const usable = create(GetUsableModelsResponseSchema, {
			models: [
				model("claude-opus-5-thinking-xhigh-fast", {
					displayName: "Claude Opus 5 Extra High Fast",
				}),
			],
		});
		const availableModels = create(AvailableModelsResponseSchema, {
			models: [available("claude-opus-5-thinking-fast", { thinking: true, context: 300_000 })],
		});
		const defaultModel = create(GetDefaultModelForCliResponseSchema, { model: usable.models[0] });
		const models = cursorCatalogModels(availableModels, usable, defaultModel, "https://api2.cursor.sh", new Map());
		expect(models[0]?.name).toBe("Claude Opus 5 Fast");
	});

	it("publishes distinct normal and Max rows with exact context parameters", () => {
		const models = builtCatalog();
		expect(models.find(candidate => candidate.id === "gpt-5.6-sol")).toMatchObject({
			contextWindow: 272_000,
			cursorContext: "272k",
			cursorMaxMode: false,
		});
		expect(models.find(candidate => candidate.id === "gpt-5.6-sol-1m")).toMatchObject({
			contextWindow: 1_000_000,
			cursorContext: "1m",
			cursorMaxMode: true,
		});
		expect(models.find(candidate => candidate.id === "claude-opus-5-thinking")).toMatchObject({
			contextWindow: 300_000,
			cursorContext: "300k",
			cursorMaxMode: false,
		});
		expect(models.find(candidate => candidate.id === "claude-opus-5-thinking-1m")).toMatchObject({
			contextWindow: 1_000_000,
			cursorContext: "1m",
			cursorMaxMode: true,
		});
	});

	it("fetches and joins all three catalog surfaces", async () => {
		const baseUrl = await startCursorDiscoveryServer();
		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 1_000 });
		expect(models).not.toBeNull();
		expect(models?.find(candidate => candidate.id === "gemini-3.7-flash")?.contextWindow).toBe(1_000_000);
		expect(models?.find(candidate => candidate.id === "gpt-5.6-sol-1m")?.cursorMaxMode).toBe(true);
	});

	it.each(["gzip", "br"] as const)(
		"rejects a %s catalog response that expands beyond the size limit",
		async encoding => {
			const fixture = catalogFixture();
			const oversizedAvailable = create(AvailableModelsResponseSchema, {
				models: [
					available("gemini-3.7-flash", {
						displayName: "x".repeat(4 * 1024 * 1024),
						thinking: true,
						context: 1_000_000,
					}),
				],
			});
			const payloads = new Map([
				["/aiserver.v1.AiService/AvailableModels", toBinary(AvailableModelsResponseSchema, oversizedAvailable)],
				["/agent.v1.AgentService/GetUsableModels", toBinary(GetUsableModelsResponseSchema, fixture.usable)],
				[
					"/agent.v1.AgentService/GetDefaultModelForCli",
					toBinary(GetDefaultModelForCliResponseSchema, fixture.defaultModel),
				],
			]);
			const { promise, resolve } = Promise.withResolvers<string>();
			const server = http2.createServer();
			servers.add(server);
			server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
				const path = String(headers[":path"]);
				const payload = payloads.get(path);
				if (payload === undefined) {
					stream.respond({ ":status": 404 });
					stream.end();
					return;
				}
				if (path === "/aiserver.v1.AiService/AvailableModels") {
					const compressed = encoding === "gzip" ? zlib.gzipSync(payload) : zlib.brotliCompressSync(payload);
					stream.respond({ ":status": 200, "content-type": "application/proto", "content-encoding": encoding });
					stream.end(compressed);
					return;
				}
				stream.respond({ ":status": 200, "content-type": "application/proto" });
				stream.end(payload);
			});
			server.listen(0, "127.0.0.1", () => {
				resolve(`http://127.0.0.1:${requireTcpAddress(server.address()).port}`);
			});

			expect(
				await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: await promise, timeoutMs: 2_000 }),
			).toBeNull();
		},
	);

	it("fails closed when any required catalog surface is unavailable", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		const server = http2.createServer();
		servers.add(server);
		server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 503 });
				stream.end();
				return;
			}
			const fixture = catalogFixture();
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(toBinary(GetUsableModelsResponseSchema, fixture.usable));
		});
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${requireTcpAddress(server.address()).port}`));
		expect(
			await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: await promise, timeoutMs: 1_000 }),
		).toBeNull();
	});

	it("does not inherit an unfetched output ceiling from bundled references", () => {
		const fixture = catalogFixture();
		const reference = {
			id: "gemini-3.7-flash",
			name: "Stale bundled reference",
			provider: "cursor" as const,
			api: "cursor-agent" as const,
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"] as ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		};
		const models = cursorCatalogModels(
			fixture.availableModels,
			fixture.usable,
			fixture.defaultModel,
			"https://api2.cursor.sh",
			new Map([[reference.id, reference]]),
		);
		expect(models.find(candidate => candidate.id === reference.id)?.maxTokens).toBeNull();
	});
});

describe("Cursor fallback input classification", () => {
	it("keeps known multimodal classes and unknown models conservative", () => {
		expect(resolveCursorInput("gemini-4-pro-exp")).toEqual(["text", "image"]);
		expect(resolveCursorInput("claude-opus-9")).toEqual(["text", "image"]);
		expect(resolveCursorInput("gpt-5.6-sol")).toEqual(["text", "image"]);
		expect(resolveCursorInput("unknown-cursor-model")).toEqual(["text"]);
	});
});
