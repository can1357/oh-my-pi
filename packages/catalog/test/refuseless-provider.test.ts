import { describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { toModelSpec, toModelSpecPreservingRawCompat } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { createModelManager } from "../src/model-manager";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";
import { refuselessModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

function modelsResponse(rows: unknown[]): FetchImpl {
	return (async () =>
		new Response(JSON.stringify({ data: rows }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as FetchImpl;
}

describe("Refuseless provider support", () => {
	test("seeds carry vendor pricing, limits and reasoning", () => {
		const seeds = seedModels<"openai-completions">("refuseless").map(spec => buildModel(spec));
		expect(seeds).toHaveLength(5);
		for (const model of seeds) {
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(1048576);
			// Priced seeds must survive the build with nonzero legs: a
			// seedless generation bakes zeros that read as "unknown", not free.
			expect(model.cost.input).toBeGreaterThan(0);
			expect(model.cost.output).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.defaultLevel).toBe(Effort.Low);
		}
	});

	test("live rows win over a stale bundled reference for input modalities", async () => {
		// A same-id row on another host (or a stale snapshot) may claim image
		// input; the endpoint's own row is the deployment truth, so a text-only
		// Refuseless model must not regain image support through the merge.
		const spec = seedModels<"openai-completions">("refuseless").find(model => model.id === "minimax-m3.1-flash");
		if (!spec) throw new Error("missing minimax seed");
		const stale = { ...buildModel(spec), input: ["text", "image"] as ("text" | "image")[] };
		const manager = createModelManager({
			...refuselessModelManagerOptions({
				apiKey: "abl_test",
				fetch: modelsResponse([{ id: "minimax-m3.1-flash" }]),
			}),
			staticModels: [stale],
		});
		const result = await manager.refresh("online");
		expect(result.models.find(model => model.id === "minimax-m3.1-flash")?.input).toEqual(["text"]);
	});

	test("discovers models from the Refuseless Models API with key auth", async () => {
		const fetchMock: FetchImpl = vi.fn(
			modelsResponse([
				{
					id: "glm-5.3-abliterated",
					context_length: 1048576,
					reasoning_efforts: ["low", "high", "max"],
					reasoning_default: "low",
				},
				{
					id: "refuseless-future-1",
					context_length: 200000,
					max_completion_tokens: 64000,
					reasoning_efforts: ["low", "max"],
					reasoning_default: "max",
				},
				{
					id: "refuseless-oddball-1",
					context_length: 64000,
					reasoning_efforts: ["low", "max"],
					reasoning_default: "turbo",
				},
				{ id: "refuseless-plain-1", context_length: 128000 },
			]),
		) as unknown as FetchImpl;
		const options = refuselessModelManagerOptions({ apiKey: "abl_test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.refuseless.com/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer abl_test" }),
			}),
		);
		expect(models?.map(model => model.id).sort()).toEqual([
			"glm-5.3-abliterated",
			"refuseless-future-1",
			"refuseless-oddball-1",
			"refuseless-plain-1",
		]);

		// Seeded ids keep their reviewed surface instead of the live zeros:
		// the mock advertises no pricing, so nonzero legs prove the seed won.
		const discoveredSeed = models?.find(model => model.id === "glm-5.3-abliterated");
		expect(discoveredSeed?.cost?.input).toBeGreaterThan(0);
		expect(discoveredSeed?.maxTokens).toBeGreaterThan(0);

		// Unseeded ids keep their advertised ladder instead of collapsing to
		// a boolean; ids without a ladder do not reason.
		const future = buildModel(models!.find(model => model.id === "refuseless-future-1")!);
		expect(future.reasoning).toBe(true);
		expect(future.thinking?.efforts).toEqual([Effort.Low, Effort.Max]);
		expect(future.thinking?.defaultLevel).toBe(Effort.Max);
		// Advertised limits land on unseeded rows instead of staying null
		// until a later bundle supplies a reference.
		expect(future.contextWindow).toBe(200000);
		expect(future.maxTokens).toBe(64000);
		// Wire-authored ladders survive catalog generation instead of being
		// replaced by the generic deriver.
		expect(models!.find(model => model.id === "refuseless-future-1")!.compat).toMatchObject({
			trustExplicitThinkingOnly: true,
		});
		// The generator's projection keeps raw-spec compat; the built-model
		// projection still drops it in favor of an absent compatConfig.
		const raw = models!.find(model => model.id === "refuseless-future-1")! as Model<"openai-completions">;
		expect(toModelSpecPreservingRawCompat(raw).compat).toMatchObject({ trustExplicitThinkingOnly: true });
		expect(toModelSpec(raw).compat).toBeUndefined();
		// An unadvertised default never survives: no valid wire tier and no
		// bundled fallback inside the ladder means no default at all.
		const oddball = buildModel(models!.find(model => model.id === "refuseless-oddball-1")!);
		expect(oddball.reasoning).toBe(true);
		expect(oddball.thinking?.efforts).toEqual([Effort.Low, Effort.Max]);
		expect(oddball.thinking?.defaultLevel).toBeUndefined();
		const plain = buildModel(models!.find(model => model.id === "refuseless-plain-1")!);
		expect(plain.reasoning).toBe(false);
	});

	test("partitions the model cache by discovery endpoint", () => {
		const canonical = refuselessModelManagerOptions({}).cacheProviderId;
		const proxy = refuselessModelManagerOptions({ baseUrl: "https://proxy.example.com/v1" }).cacheProviderId;
		if (typeof canonical !== "string" || typeof proxy !== "string") throw new Error("expected cache namespaces");
		expect(proxy).not.toBe(canonical);
		// Trailing-slash spellings converge; a bare host is a different
		// request path (`/models` vs `/v1/models`) so it gets its own cache.
		expect(resolveModelCacheProviderId("refuseless", { baseUrl: "https://proxy.example.com/v1/" })).toBe(proxy);
		expect(resolveModelCacheProviderId("refuseless", { baseUrl: "https://proxy.example.com" })).not.toBe(proxy);
		expect(resolveModelCacheProviderId("refuseless", {})).toBe(canonical);
	});

	test("honours a custom base URL verbatim and stays inert without a key", async () => {
		const fetchMock: FetchImpl = vi.fn(
			modelsResponse([{ id: "glm-5.3-abliterated", context_length: 1048576 }]),
		) as unknown as FetchImpl;

		const options = refuselessModelManagerOptions({
			apiKey: "abl_test",
			baseUrl: "https://proxy.example.com/v1",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://proxy.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer abl_test" }),
			}),
		);

		const keyless = refuselessModelManagerOptions({ fetch: fetchMock });
		expect(keyless.fetchDynamicModels).toBeUndefined();
		expect(keyless.dynamicModelsAuthoritative).toBe(true);
	});
});
