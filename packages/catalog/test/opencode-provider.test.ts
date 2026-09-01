import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	fetchWellKnownModels,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	modelsDevCatalogFallback,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { mergePreviousSnapshotModels } from "../scripts/generate-models";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

describe("Shared models.dev catalog fallback", () => {
	test("adds newly published models for a bundled provider and reuses the cached snapshot", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-models-dev-fallback-"));
		try {
			const bundledModels = getBundledModels("zai");
			const bundledModel = bundledModels[0];
			if (!bundledModel) throw new Error("ZAI bundled catalog is empty");
			const bundledModelId = bundledModel.id;
			// Must stay un-bundled: the fallback contract below is about models.dev
			// publishing a model the bundled catalog does not carry yet.
			const newlyPublishedId = "glm-experimental-probe";
			if (bundledModels.some(model => model.id === newlyPublishedId)) {
				throw new Error(`${newlyPublishedId} is bundled; pick a new un-bundled fixture id`);
			}
			let fetches = 0;
			const fallback = modelsDevCatalogFallback("zai");
			if (!fallback) throw new Error("ZAI did not configure a models.dev fallback");
			const modelsDev = {
				...fallback,
				fetch: async () => {
					fetches++;
					return {
						zai: {
							models: {
								[newlyPublishedId]: {
									id: newlyPublishedId,
									name: "GLM Experimental Probe",
									tool_call: true,
									reasoning: true,
									limit: { context: 1_000_000, output: 131_072 },
									modalities: { input: ["text", "image"], output: ["text"] },
									provider: { npm: "@ai-sdk/anthropic" },
								},
								[bundledModelId]: {
									id: bundledModelId,
									name: "Untrusted remote override",
									tool_call: false,
									reasoning: false,
									limit: { context: 1, output: 1 },
									modalities: { input: ["text"], output: ["text"] },
									provider: { npm: "@ai-sdk/anthropic" },
								},
							},
						},
					};
				},
			};
			const options = {
				providerId: "zai" as const,
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: bundledModels,
				modelsDev,
			};

			const online = await resolveProviderModels(options, "online");
			expect(online.stale).toBe(false);
			expect(online.source).toBe("models.dev");
			expect(online.updatedAt).toBeNumber();
			expect(online.models.find(model => model.id === bundledModelId)).toMatchObject({
				name: bundledModel.name,
				contextWindow: bundledModel.contextWindow,
				maxTokens: bundledModel.maxTokens,
				reasoning: bundledModel.reasoning,
				input: bundledModel.input,
			});
			expect(online.models.find(model => model.id === newlyPublishedId)).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.z.ai/api/anthropic",
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				reasoning: true,
				input: ["text", "image"],
			});

			const cached = await resolveProviderModels(options, "online-if-uncached");
			expect(cached.stale).toBe(false);
			expect(cached.source).toBe("cache");
			expect(cached.updatedAt).toBe(online.updatedAt);
			expect(cached.models.some(model => model.id === newlyPublishedId)).toBe(true);

			const staleFallback = await resolveProviderModels(
				{
					...options,
					now: () => Date.now() + 3 * 60 * 60 * 1000,
					modelsDev: {
						...modelsDev,
						fetch: async () => {
							throw new Error("models.dev unavailable");
						},
					},
				},
				"online",
			);
			expect(staleFallback.stale).toBe(true);
			expect(staleFallback.source).toBe("cache");
			expect(staleFallback.updatedAt).toBe(online.updatedAt);
			expect(staleFallback.models.some(model => model.id === newlyPublishedId)).toBe(true);
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("filters generation-rejected rows before runtime resolution and caching", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-runtime-policy-"));
		const rawModel = (id: string, npm: string) => ({
			id,
			name: id,
			tool_call: true,
			reasoning: true,
			limit: { context: 128_000, output: 32_000 },
			modalities: { input: ["text"], output: ["text"] },
			provider: { npm },
		});
		const cases = [
			{
				providerId: "zai",
				invalidId: "glm-5.2[1m]",
				validId: "glm-5.3-flash",
				npm: "@ai-sdk/anthropic",
			},
			{
				providerId: "amazon-bedrock",
				invalidId: "openai.gpt-5.4",
				validId: "openai.gpt-oss-120b",
				npm: "@ai-sdk/openai-compatible",
			},
		] as const;
		try {
			for (const { providerId, invalidId, validId, npm } of cases) {
				const fallback = modelsDevCatalogFallback(providerId);
				if (!fallback) throw new Error(`${providerId} did not configure a models.dev fallback`);
				const options = {
					providerId,
					cacheDbPath: path.join(tempDir, `${providerId}.db`),
					staticModels: [],
					modelsDev: {
						...fallback,
						fetch: async () => ({
							[providerId]: {
								models: {
									[invalidId]: rawModel(invalidId, npm),
									[validId]: rawModel(validId, npm),
								},
							},
						}),
					},
				};

				const online = await resolveProviderModels(options, "online");
				expect(online.models.some(model => model.id === invalidId)).toBe(false);
				expect(online.models.some(model => model.id === validId)).toBe(true);

				const cached = await resolveProviderModels(options, "offline");
				expect(cached.models.some(model => model.id === invalidId)).toBe(false);
				expect(cached.models.some(model => model.id === validId)).toBe(true);
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("keeps upgraded bundled metadata authoritative over an older same-id cache row", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-additive-cache-upgrade-"));
		try {
			const bundledModel = getBundledModels("zai")[0];
			if (!bundledModel) throw new Error("ZAI bundled catalog is empty");
			const staticV1 = { ...bundledModel, name: "Bundled before upgrade" };
			const cachedOverride = {
				...staticV1,
				name: "Untrusted cached override",
				contextWindow: 1,
				maxTokens: 1,
			};
			const cacheDbPath = path.join(tempDir, "models.db");
			const legacyModelsDev = {
				fetch: async () => [cachedOverride],
				map: (payload: Array<typeof cachedOverride>) => payload,
			};
			const seeded = await resolveProviderModels(
				{
					providerId: "zai" as const,
					cacheDbPath,
					staticModels: [staticV1],
					modelsDev: legacyModelsDev,
				},
				"online",
			);
			expect(seeded.models.find(model => model.id === bundledModel.id)).toMatchObject({
				name: "Untrusted cached override",
				contextWindow: 1,
				maxTokens: 1,
			});

			const staticV2 = {
				...bundledModel,
				name: "Bundled after upgrade",
				contextWindow: 1_000_001,
				maxTokens: 131_073,
			};
			const upgraded = await resolveProviderModels(
				{
					providerId: "zai" as const,
					cacheDbPath,
					staticModels: [staticV2],
					modelsDev: {
						...legacyModelsDev,
						additiveOnly: true,
						fetch: async () => {
							throw new Error("offline");
						},
					},
				},
				"offline",
			);
			expect(upgraded.models.find(model => model.id === bundledModel.id)).toMatchObject({
				name: "Bundled after upgrade",
				contextWindow: staticV2.contextWindow,
				maxTokens: staticV2.maxTokens,
			});
			expect(upgraded.source).toBe("bundled");
			expect(upgraded.updatedAt).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("sanitizes a fresh matching cache when additive mode is enabled", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-additive-fresh-cache-"));
		try {
			const bundledModel = getBundledModels("zai")[0];
			if (!bundledModel) throw new Error("ZAI bundled catalog is empty");
			const cachedOverride = {
				...bundledModel,
				name: "Untrusted cached override",
				contextWindow: 1,
				maxTokens: 1,
			};
			const cacheDbPath = path.join(tempDir, "models.db");
			const legacyModelsDev = {
				fetch: async () => [cachedOverride],
				map: (payload: Array<typeof cachedOverride>) => payload,
			};
			await resolveProviderModels(
				{
					providerId: "zai" as const,
					cacheDbPath,
					staticModels: [bundledModel],
					modelsDev: legacyModelsDev,
				},
				"online",
			);

			let additiveFetches = 0;
			const resolved = await resolveProviderModels(
				{
					providerId: "zai" as const,
					cacheDbPath,
					staticModels: [bundledModel],
					modelsDev: {
						...legacyModelsDev,
						additiveOnly: true,
						fetch: async () => {
							additiveFetches++;
							return [];
						},
					},
				},
				"online-if-uncached",
			);

			expect(additiveFetches).toBe(0);
			expect(resolved.models.find(model => model.id === bundledModel.id)).toMatchObject({
				name: bundledModel.name,
				contextWindow: bundledModel.contextWindow,
				maxTokens: bundledModel.maxTokens,
			});
			expect(resolved.source).toBe("bundled");
			expect(resolved.updatedAt).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("retains one source's cached slice when the other source refreshes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-partial-source-refresh-"));
		try {
			const existingModel = getBundledModels("zai")[0];
			if (!existingModel) throw new Error("ZAI bundled catalog is empty");
			const sharedModel = {
				...existingModel,
				id: "shared-only",
				name: "Shared only",
				requestModelId: undefined,
			};
			let endpointModel = {
				...existingModel,
				id: "endpoint-only",
				name: "Endpoint v1",
				requestModelId: undefined,
			};
			let sharedCatalogAvailable = true;
			const modelsDev = {
				additiveOnly: true,
				fetch: async () => {
					if (!sharedCatalogAvailable) throw new Error("models.dev unavailable");
					return [sharedModel];
				},
				map: (payload: Array<typeof sharedModel>) => payload,
			};
			const options = {
				providerId: "zai" as const,
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: [existingModel],
				modelsDev,
				fetchDynamicModels: async () => [endpointModel],
			};

			const initial = await resolveProviderModels(options, "online");
			expect(initial.models.map(model => model.id).sort()).toEqual(
				[existingModel.id, "shared-only", "endpoint-only"].sort(),
			);

			sharedCatalogAvailable = false;
			endpointModel = { ...endpointModel, name: "Endpoint v2" };
			const partial = await resolveProviderModels(options, "online");
			expect(partial.models.map(model => model.id).sort()).toEqual(
				[existingModel.id, "shared-only", "endpoint-only"].sort(),
			);
			expect(partial.models.find(model => model.id === "endpoint-only")?.name).toBe("Endpoint v2");
			expect(partial.source).toBe("provider");
			expect(partial.stale).toBe(true);

			const cached = await resolveProviderModels(options, "offline");
			expect(cached.models.map(model => model.id).sort()).toEqual(
				[existingModel.id, "shared-only", "endpoint-only"].sort(),
			);
			expect(cached.stale).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("isolates conditional catalog sessions by fetch context", async () => {
		let firstFetches = 0;
		let secondFetches = 0;
		const firstFetch: FetchImpl = async () => {
			firstFetches++;
			return Response.json({ source: "first" }, { headers: { etag: '"first"' } });
		};
		const secondFetch: FetchImpl = async () => {
			secondFetches++;
			return Response.json({ source: "second" }, { headers: { etag: '"second"' } });
		};

		const [first, second] = await Promise.all([fetchWellKnownModels(firstFetch), fetchWellKnownModels(secondFetch)]);
		expect(first).toEqual({ source: "first" });
		expect(second).toEqual({ source: "second" });
		expect(firstFetches).toBe(1);
		expect(secondFetches).toBe(1);
	});

	test("reports a stale cache when conditional catalog revalidation fails", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-revalidation-fallback-"));
		try {
			const bundledModels = getBundledModels("zai");
			let catalogAvailable = true;
			let fetches = 0;
			const fetchImpl: FetchImpl = async () => {
				fetches++;
				if (!catalogAvailable) throw new Error("models.dev unavailable");
				return Response.json(
					{
						zai: {
							models: {
								"shared-only": {
									id: "shared-only",
									name: "Shared Only",
									tool_call: true,
									reasoning: false,
									limit: { context: 128_000, output: 8_192 },
									modalities: { input: ["text"], output: ["text"] },
									provider: { npm: "@ai-sdk/anthropic" },
								},
							},
						},
					},
					{ headers: { etag: '"catalog-v1"' } },
				);
			};
			const fallback = modelsDevCatalogFallback("zai", fetchImpl);
			if (!fallback) throw new Error("ZAI did not configure a models.dev fallback");
			const options = {
				providerId: "zai" as const,
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: bundledModels,
				modelsDev: fallback,
			};

			const initial = await resolveProviderModels(options, "online");
			expect(initial.source).toBe("models.dev");
			expect(initial.stale).toBe(false);
			expect(initial.models.some(model => model.id === "shared-only")).toBe(true);

			catalogAvailable = false;
			const failedRevalidation = await resolveProviderModels(options, "online");
			expect(failedRevalidation.source).toBe("cache");
			expect(failedRevalidation.stale).toBe(true);
			expect(failedRevalidation.updatedAt).toBe(initial.updatedAt);
			expect(failedRevalidation.models.some(model => model.id === "shared-only")).toBe(true);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("applies subscriber deadlines without aborting a joined catalog request", async () => {
		let aborted = false;
		let fetches = 0;
		const transport = Promise.withResolvers<Response>();
		const stalledFetch: FetchImpl = (_input, init) => {
			fetches++;
			const signal = init?.signal;
			if (!signal) throw new Error("catalog fetch did not receive an abort signal");
			const rejectAborted = () => {
				aborted = true;
				transport.reject(signal.reason);
			};
			if (signal.aborted) {
				rejectAborted();
			} else {
				signal.addEventListener("abort", rejectAborted, { once: true });
			}
			return transport.promise;
		};
		const shortFallback = modelsDevCatalogFallback("zai", stalledFetch, 5);
		const longFallback = modelsDevCatalogFallback("zai", stalledFetch, 5_000);
		if (!shortFallback || !longFallback) throw new Error("ZAI did not configure a models.dev fallback");

		const shortRequest = shortFallback.fetch();
		const longRequest = longFallback.fetch();
		await expect(shortRequest).rejects.toThrow(/timed out/i);
		expect(aborted).toBe(false);
		expect(fetches).toBe(1);

		const payload = { source: "shared-transport" };
		transport.resolve(Response.json(payload));
		expect(await longRequest).toEqual(payload);
		expect(aborted).toBe(false);
	});
});

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});

	test("invalidates cached GLM-5.3 Flash effort metadata on upgrade (issue #9960)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-glm53-flash-cache-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		const discoveredFlash: ModelSpec<"openai-completions"> = {
			id: "glm-5.3-flash",
			name: "GLM-5.3-Flash",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			// GLM-5.3 Flash is multimodal; image input coexists with the
			// reasoning-effort ladder (the `glm.vision` SKU flag matches only the
			// `…v` shape, never image capability).
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		};

		try {
			const options = opencodeGoModelManagerOptions({ apiKey: "go-account-key" });
			const cacheProviderId = options.cacheProviderId;
			if (!cacheProviderId) throw new Error("OpenCode Go cache provider id is missing");
			const priorDropIds = options.dropCachedModelIdsOnStaticMismatch?.filter(id => id !== discoveredFlash.id);
			await resolveProviderModels(
				{
					...options,
					cacheDbPath,
					modelsDev: undefined,
					dropCachedModelIdsOnStaticMismatch: priorDropIds,
					fetchDynamicModels: async () => [discoveredFlash],
				},
				"online",
			);
			const priorCache = readModelCache(cacheProviderId, Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
			if (!priorCache) throw new Error("OpenCode Go cache was not written");

			// Rebuild under the pre-fix identity, then persist it with the prior
			// migration-policy fingerprint to simulate an upgraded installation.
			const staleFlash = {
				...buildModel({ ...discoveredFlash, id: "glm-5.2-flash" }),
				id: discoveredFlash.id,
				name: discoveredFlash.name,
			};
			writeModelCache(
				cacheProviderId,
				priorCache.updatedAt,
				[staleFlash],
				true,
				priorCache.staticFingerprint,
				cacheDbPath,
			);

			let fetches = 0;
			const upgraded = await resolveProviderModels(
				{
					...options,
					cacheDbPath,
					modelsDev: undefined,
					fetchDynamicModels: async () => {
						fetches++;
						return [discoveredFlash];
					},
				},
				"online-if-uncached",
			);
			const flash = upgraded.models.find(model => model.id === discoveredFlash.id);
			expect(fetches).toBe(1);
			expect(flash?.input).toEqual(["text", "image"]);
			expect(flash?.thinking).toEqual({
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				defaultLevel: Effort.Max,
				requiresEffort: true,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("routes opencode-go deepseek-v4-flash to the responses API", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// stencil.so lists deepseek-v4-flash without provider.npm, so it would
		// fall through to openai-completions — but the Go gateway does not serve
		// this model at /zen/go/v1/chat/completions while /zen/go/v1/responses
		// works (user-verified against the live gateway, 2026-08-08).
		expect(descriptor?.resolveApi?.("deepseek-v4-flash", { tool_call: true })).toEqual({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		// Flash only: deepseek-v4-pro serves fine on chat completions.
		expect(descriptor?.resolveApi?.("deepseek-v4-pro", { tool_call: true })).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
	});

	test("routes opencode-go muse-spark-1.2 to the responses API (#8957)", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// The Go /zen/go/v1/models discovery drops the provider.npm hint for the
		// muse-spark ids, so without an override they fall through to
		// openai-completions even though the gateway only serves them at
		// /zen/go/v1/responses. Sending completions requests closes the stream
		// with no finish_reason on every tool-call turn.
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(descriptor?.resolveApi?.(id, { tool_call: true })).toEqual({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
	});

	test("pins gateway-only muse-spark ids to responses in live discovery (#8957)", async () => {
		// models.dev omits muse-spark-1.2[-contributor] under opencode-go, so
		// there is no bundled reference row. Without the discovery-side pin the
		// mapper defaults them to openai-completions and every tool-call turn
		// fails with "stream closed before a finish_reason was received".
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor", "kimi-k3"]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(byId.get(id)).toMatchObject({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
		// Contrast: an unpinned id with a bundled reference keeps its route.
		expect(byId.get("kimi-k3")).toMatchObject({ api: "openai-completions" });
		// Upgrade path: pinned ids invalidate caches written before the pin,
		// otherwise 17.3.7-era rows keep the completions route until TTL.
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("muse-spark-1.2-contributor");
	});

	test("routes gateway-first ids via sibling catalog and variant-base hints", async () => {
		// The Go gateway ships models before models.dev lists them under
		// opencode-go (muse-spark-1.2[-contributor] did exactly this, #8957).
		// With no same-provider metadata, the mapper borrows the
		// openai-responses route from the sibling Zen catalog or the
		// billing-variant base id — responses only, never anthropic-messages
		// (cross-gateway transports genuinely diverge there).
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				modelListResponse([
					"gpt-5.5", // zen bundles it as openai-responses; absent from the go bundle
					"deepseek-v4-flash-free", // base id is pinned to responses on go
					"minimax-m2.5-free", // anthropic hints only -> must keep the completions default
					"brand-new-model", // no hint anywhere -> completions default
				]),
		});
		const models = await options.fetchDynamicModels?.();
		const apiById = new Map((models ?? []).map(model => [model.id, model.api]));
		expect(apiById.get("gpt-5.5")).toBe("openai-responses");
		expect(apiById.get("deepseek-v4-flash-free")).toBe("openai-responses");
		expect(apiById.get("minimax-m2.5-free")).toBe("openai-completions");
		expect(apiById.get("brand-new-model")).toBe("openai-completions");
	});

	test("enriches gateway-first ids from stencil without changing their route", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-gateway-first-"));
		try {
			const options = opencodeZenModelManagerOptions({
				apiKey: "zen-account-key",
				fetch: async () => modelListResponse(["brand-new-stencil-model"]),
			});
			const modelsDev = options.modelsDev;
			if (!modelsDev) throw new Error("OpenCode model manager did not configure stencil fallback");
			const catalog = {
				opencode: {
					models: {
						"brand-new-stencil-model": {
							id: "brand-new-stencil-model",
							name: "Gateway First Test Model",
							tool_call: true,
							reasoning: true,
							limit: { context: 1_000_000, output: 131_072 },
							modalities: { input: ["text", "image", "video"], output: ["text"] },
							provider: { npm: "@ai-sdk/anthropic" },
						},
					},
				},
			};
			const managerOptions = {
				...options,
				cacheDbPath: path.join(tempDir, "models.db"),
				modelsDev: { ...modelsDev, fetch: async () => catalog },
			};
			const online = await resolveProviderModels(managerOptions, "online");
			const model = online.models.find(candidate => candidate.id === "brand-new-stencil-model");
			expect(model).toMatchObject({
				name: "Gateway First Test Model",
				api: "openai-completions",
				baseUrl: "https://opencode.ai/zen/v1",
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				reasoning: true,
				input: ["text", "image"],
			});
			if (!model) throw new Error("Gateway-first model was not resolved");
			expect(getSupportedEfforts(model)).toEqual([
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
			]);

			const cached = await resolveProviderModels(managerOptions, "online-if-uncached");
			expect(cached.models.find(candidate => candidate.id === model.id)).toMatchObject({
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				reasoning: true,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("recovers muse-spark thinking levels from live OpenCode Go discovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-go-muse-"));
		try {
			const options = opencodeGoModelManagerOptions({
				apiKey: "go-account-key",
				fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor"]),
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);
			const expected = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
			for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
				const model = result.models.find(item => item.id === id);
				expect(model?.api).toBe("openai-responses");
				expect(model?.reasoning).toBe(true);
				expect(model?.thinking?.efforts).toEqual(expected);
				expect(model?.thinking?.requiresEffort).toBeUndefined();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("replaces stale bundled Zen models with each credential's live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			let freeFetches = 0;
			const freeOptions = opencodeZenModelManagerOptions({
				apiKey: "free-account-key",
				fetch: async input => {
					if (String(input).includes("catalog.stencil.so")) return Response.json({});
					freeFetches++;
					return modelListResponse(LIVE_FREE_MODEL_IDS);
				},
			});
			const freeResult = await resolveProviderModels(
				{ ...freeOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			let paidFetches = 0;
			const paidOptions = opencodeZenModelManagerOptions({
				apiKey: "paid-account-key",
				fetch: async input => {
					if (String(input).includes("catalog.stencil.so")) return Response.json({});
					paidFetches++;
					return modelListResponse(LIVE_PAID_MODEL_IDS);
				},
			});
			const paidResult = await resolveProviderModels(
				{ ...paidOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			expect(freeOptions.cacheProviderId).not.toBe(paidOptions.cacheProviderId);
			expect(freeResult.stale).toBe(false);
			expect(freeResult.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
			expect(paidResult.stale).toBe(false);
			expect(paidResult.models.map(model => model.id).sort()).toEqual([...LIVE_PAID_MODEL_IDS].sort());
			expect([freeFetches, paidFetches]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("resolves the OpenCode Go long-usage fallback policy from KDL", () => {
		const policy = resolveModelPolicy({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		expect(policy.catalog).toMatchObject({ longUsageLimitFallback: true });
	});
});

describe("issue #10416 — retired bare opencode provider", () => {
	// #309 split `opencode` into `opencode-go` / `opencode-zen`, and models.dev's
	// `opencode` key is remapped to `opencode-zen`. The legacy `opencode` rows
	// survived as previous-snapshot zombies and surfaced in the picker as a dead
	// provider with no descriptor/auth path.
	test("prunes bare `opencode` rows while restoring live previous-snapshot providers", () => {
		const staleModel = buildModel({
			id: "legacy-opencode-model",
			name: "Legacy OpenCode Model",
			api: "openai-completions",
			provider: "opencode",
			baseUrl: "https://legacy.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		const liveModel = buildModel({
			id: "live-fallback-model",
			name: "Live Fallback Model",
			api: "openai-completions",
			provider: "fixture-provider",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const merged = mergePreviousSnapshotModels(
			[],
			{
				opencode: { [staleModel.id]: staleModel },
				"fixture-provider": { [liveModel.id]: liveModel },
			},
			new Set(),
		);

		expect(merged.map(model => `${model.provider}/${model.id}`)).toEqual(["fixture-provider/live-fallback-model"]);
	});

	test("the split OpenCode providers remain populated", () => {
		expect(getBundledModels("opencode-go").length).toBeGreaterThan(0);
		expect(getBundledModels("opencode-zen").length).toBeGreaterThan(0);
	});
});
