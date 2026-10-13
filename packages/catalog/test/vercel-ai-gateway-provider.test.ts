import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import * as providersModule from "@oh-my-pi/pi-catalog/compat/providers";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

function mockModelsList(data: unknown[]): typeof fetch {
	return (async () =>
		Response.json({
			object: "list",
			data,
		})) as unknown as typeof fetch;
}

function byId<T extends { id: string }>(models: readonly T[] | null | undefined): Map<string, T> {
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("Vercel AI Gateway provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: contributorId,
					object: "model",
					owned_by: "meta",
					tags: ["tool-use", "reasoning", "vision"],
					context_window: 1_048_576,
					max_tokens: 1_048_576,
					pricing: { input: 0.0000001, output: 0.0000002 },
				},
				{
					id: controlId,
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use", "reasoning"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const map = byId(models);

		const contributor = map.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = map.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});

	test("strips a trailing /v1 from custom eval base URLs so the route does not double-prefix", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			baseUrl: "https://proxy.example/v1",
			fetch: mockModelsList([{ id: "typesafe-ai/jev", type: "evaluation" }]),
		});
		const models = await options.fetchDynamicModels?.();
		const jev = byId(models).get("typesafe-ai/jev");
		expect(jev?.baseUrl).toBe("https://proxy.example");
		// Appended unbundled seeds must rebase too, or a proxied consumer
		// would send credential + request to the public gateway. (The four
		// stable seeds are bundled, so they dedupe out of the append; laya is
		// live-only and exercises the append path.)
	});

	test("rebases appended unbundled seeds onto a custom gateway root", async () => {
		// All four stable seeds are bundled, so none appends; simulate an
		// unbundled seed by spying seedModels to return an extra eval row.
		const extraSeed = {
			id: "typesafe-ai/future-jev",
			name: "Future Jev",
			api: "typesafe",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: false,
			input: ["text"],
			supportsTools: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4096,
		};
		const realSeeds = seedModels("vercel-ai-gateway");
		const seedSpy = vi.spyOn(providersModule, "seedModels").mockReturnValue([...realSeeds, extraSeed] as never);
		try {
			const options = vercelAiGatewayModelManagerOptions({
				baseUrl: "https://proxy.example/v1",
				fetch: mockModelsList([{ id: "some-chat-model", tags: ["tool-use"] }]),
			});
			const models = await options.fetchDynamicModels?.();
			const appended = byId(models).get("typesafe-ai/future-jev");
			expect(appended?.baseUrl).toBe("https://proxy.example");
			expect(appended?.kind).toBe("judge");
		} finally {
			seedSpy.mockRestore();
		}
	});

	test("maps type:evaluation rows to api typesafe kind judge beside chat rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const jevId = "typesafe-ai/jev";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: chatId,
					name: "Claude Sonnet 4.5",
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
				{
					id: jevId,
					name: "Jev",
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 32_000,
					pricing: { input: 0.000000042, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const map = byId(models);

		const chat = map.get(chatId);
		expect(chat?.api).toBe("anthropic-messages");
		expect(chat?.kind ?? "chat").toBe("chat");

		const jev = map.get(jevId);
		expect(jev).toBeDefined();
		expect(jev?.api).toBe("typesafe");
		expect(jev?.kind).toBe("judge");
		expect(jev?.name).toBe("Jev");
		expect(jev?.reasoning).toBe(false);
		expect(jev?.input).toEqual(["text"]);
		expect(jev?.supportsTools).toBe(false);
		expect(jev?.cost?.input).toBeCloseTo(0.042, 9);
		expect(jev?.cost?.output).toBe(0);
		expect(jev?.contextWindow).toBe(32_000);
		// The mapper carries no judgment: the vercel-ai-gateway KDL default
		// supplies the /v1/evaluate wire contract through buildModel.
		expect(jev).not.toHaveProperty("judgment");
		// The judgment defaults must survive discovery → buildModel so ChainJudge routes at /v1/evaluate.
		if (!jev) throw new Error("expected the jev evaluation row");
		expect(buildModel(jev).judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
		// Spec (user modelOverrides merged pre-rebuild) replaces catalog keys shallowly.
		expect(buildModel({ ...jev, judgment: { route: "/v1/custom", typeMap: { score: "number" } } }).judgment).toEqual({
			route: "/v1/custom",
			typeMap: { score: "number" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("chat filter drops non-tool-use rows while keeping evaluation rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const droppedChatId = "anthropic/claude-haiku-4-5-20251001";
		const jevId = "typesafe-ai/jev";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: chatId,
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
				{
					id: droppedChatId,
					object: "model",
					owned_by: "anthropic",
					tags: ["reasoning"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000001, output: 0.000005 },
				},
				{
					id: jevId,
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 32_000,
					pricing: { input: 0.000000042, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get(chatId)).toBeDefined();
		expect(map.get(droppedChatId)).toBeUndefined();
		expect(map.get(jevId)).toBeDefined();
	});

	test("detects image capability on evaluation rows via modalities.input or vision tag", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/modal-jev",
					object: "model",
					type: "evaluation",
					modalities: { input: ["text", "image"] },
				},
				{
					id: "typesafe-ai/tagged-jev",
					object: "model",
					type: "evaluation",
					tags: ["vision"],
				},
				{
					id: "typesafe-ai/plain-jev",
					object: "model",
					type: "evaluation",
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get("typesafe-ai/modal-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/tagged-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/plain-jev")?.input).toEqual(["text"]);
	});

	test("applies kind judge to non-listed evaluation ids via wildcard and resolves judgment contract", async () => {
		const evalId = "scaledown/scaledown-classify-1";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: evalId,
					name: "Scaledown Classify 1",
					object: "model",
					owned_by: "scaledown",
					type: "evaluation",
					context_window: 32_000,
					pricing: { input: 0.000000042, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const map = byId(models);
		const scaledown = map.get(evalId);
		expect(scaledown).toBeDefined();
		expect(scaledown?.api).toBe("typesafe");
		expect(scaledown?.kind).toBe("judge");

		const specWithoutKind = {
			id: evalId,
			provider: "vercel-ai-gateway",
			api: "typesafe" as const,
			name: "Scaledown Classify 1",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 8192,
		};
		const built = buildModel(specWithoutKind);
		expect(built.kind).toBe("judge");
		expect(built.judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("resolves luna image capability via KDL correction even with text-only live shape", async () => {
		const lunaId = "openai/gpt-6-luna-decisions";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: lunaId,
					name: "GPT-6 Luna Decisions",
					object: "model",
					owned_by: "openai",
					type: "evaluation",
					modalities: { input: ["text"] },
					context_window: 32_000,
					pricing: { input: 0.0000001, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		const lunaSpec = map.get(lunaId);
		expect(lunaSpec).toBeDefined();
		expect(lunaSpec?.input).toEqual(["text"]);

		if (!lunaSpec) throw new Error("expected luna evaluation row");
		const built = buildModel(lunaSpec);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.kind).toBe("judge");
	});
	test.each(["typesafe-ai/jev", "microsoft/microsoft-decision-1", "liquid/d1", "openai/gpt-6-luna-decisions"])(
		"forces refetch of stale cached eval row %s on static fingerprint mismatch",
		async id => {
			await using tempDir = await TempDir.create("@pi-catalog-vercel-cache-");
			const cacheDbPath = tempDir.join("models.db");
			const staleRow = {
				...buildModel({
					id,
					name: `${id} (stale)`,
					provider: "vercel-ai-gateway",
					api: "anthropic-messages",
					baseUrl: "https://ai-gateway.vercel.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 2_048,
				}),
				kind: "chat" as const,
				judgment: undefined,
			};

			writeModelCache(
				"vercel-ai-gateway",
				Date.now(),
				[staleRow],
				true,
				"mismatched-static-fingerprint",
				cacheDbPath,
			);

			let fetches = 0;
			const fetchMock = mockModelsList([
				{
					id,
					name: `${id} (Discovered)`,
					object: "model",
					type: "evaluation",
					context_window: 64_000,
				},
			]);

			const result = await resolveProviderModels(
				{
					...vercelAiGatewayModelManagerOptions({
						fetch: (async (...args: Parameters<typeof fetch>) => {
							fetches++;
							return fetchMock(...args);
						}) as unknown as typeof fetch,
					}),
					cacheDbPath,
				},
				"online-if-uncached",
			);

			// The stale cached id is listed in dropCachedModelIdsOnStaticMismatch,
			// so the fingerprint mismatch forces a refetch instead of serving stale cache.
			expect(fetches).toBe(1);
			expect(result.source).toBe("provider");

			const row = result.models.find(model => model.id === id);
			expect(row).toBeDefined();
			expect(row?.kind).toBe("judge");
			expect(row?.api).toBe("typesafe");

			const updatedCache = readModelCache("vercel-ai-gateway", Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
			const cachedRow = updatedCache?.models.find(model => model.id === id);
			expect(cachedRow?.kind).toBe("judge");
			expect(updatedCache?.models.some(model => model.id === id && model.kind === "chat")).toBe(false);
		},
	);

	test("bundled seed resolves with kind judge and KDL judgment contract", () => {
		const seededIds = [
			"typesafe-ai/jev",
			"microsoft/microsoft-decision-1",
			"liquid/d1",
			"openai/gpt-6-luna-decisions",
		];
		const seeds = seedModels("vercel-ai-gateway");
		expect(seeds.length).toBeGreaterThanOrEqual(seededIds.length);
		for (const id of seededIds) {
			const seed = seeds.find(model => model.id === id);
			expect(seed).toBeDefined();
			if (!seed) continue;
			const built = buildModel(seed);
			expect(built.kind).toBe("judge");
			expect(built.api).toBe("typesafe");
			expect(built.supportsTools).toBe(false);
			expect(built.judgment).toEqual({
				route: "/v1/evaluate",
				typeMap: { noul: "boolean" },
				valueMap: { noul: "probability" },
				usageMap: { input: "inputTokens", output: "outputTokens" },
			});
		}
	});

	test("offline manager returns bundled judges with kind judge and KDL judgment contract", async () => {
		const seededIds = [
			"typesafe-ai/jev",
			"microsoft/microsoft-decision-1",
			"liquid/d1",
			"openai/gpt-6-luna-decisions",
		];
		const failingFetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const result = await resolveProviderModels(
			{ ...vercelAiGatewayModelManagerOptions({ fetch: failingFetch }), cacheDbPath: ":memory:" },
			"offline",
		);
		for (const id of seededIds) {
			const model = result.models.find(m => m.id === id);
			expect(model).toBeDefined();
			if (!model) continue;
			expect(model.kind).toBe("judge");
			expect(model.api).toBe("typesafe");
			expect(model.supportsTools).toBe(false);
			expect(model.judgment).toEqual({
				route: "/v1/evaluate",
				typeMap: { noul: "boolean" },
				valueMap: { noul: "probability" },
				usageMap: { input: "inputTokens", output: "outputTokens" },
			});
		}
		expect(result.source).toBe("bundled");
	});

	test("seeded id is replaced cleanly by live discovery row (explicitKindModels replace, not dup)", async () => {
		const seeds = seedModels("vercel-ai-gateway").map(seed => buildModel(seed));
		const jevSeed = seeds.find(model => model.id === "typesafe-ai/jev");
		expect(jevSeed).toBeDefined();

		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/jev",
					name: "Jev (Discovered)",
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 64_000,
					pricing: { input: 0.00000005, output: 0 },
				},
			]),
		});

		const result = await resolveProviderModels(
			{
				...options,
				staticModels: seeds,
				cacheDbPath: ":memory:",
			},
			"online",
		);

		const jevRows = result.models.filter(model => model.id === "typesafe-ai/jev");
		expect(jevRows).toHaveLength(1);
		const jev = jevRows[0];
		expect(jev?.name).toBe("Jev (Discovered)");
		expect(jev?.kind).toBe("judge");
		expect(jev?.contextWindow).toBe(64_000);
		expect(jev?.cost?.input).toBeCloseTo(0.05, 9);
		expect(jev?.judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("preserves transient empty discovery without appending seeds, leaving cache non-authoritative", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).toEqual([]);

		await using tempDir = await TempDir.create("@pi-catalog-vercel-cache-");
		const cacheDbPath = tempDir.join("models.db");

		const result = await resolveProviderModels(
			{
				...options,
				cacheDbPath,
			},
			"online",
		);

		expect(result.source).toBe("provider");
		const cached = readModelCache("vercel-ai-gateway", Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
		expect(cached).toBeDefined();
		expect(cached?.authoritative).toBe(false);
	});

	test("preserves explicit spec judgment when provider has no KDL judgment axis", () => {
		const explicitSpec = {
			id: "example-judge",
			name: "Example Judge",
			baseUrl: "https://example.com",
			provider: "example-gateway",
			api: "typesafe" as const,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 4096,
			judgment: {
				route: "/v1/evaluate",
			},
		};
		const built = buildModel(explicitSpec);
		expect(built.judgment).toEqual({
			route: "/v1/evaluate",
		});
	});

	test("drops stale judgment policy on api-switched rebuild", () => {
		const evalSpec = {
			id: "typesafe-ai/jev",
			name: "Jev",
			baseUrl: "https://ai-gateway.vercel.sh",
			provider: "vercel-ai-gateway",
			api: "typesafe" as const,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 8192,
		};
		const built = buildModel(evalSpec);
		expect(built.judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});

		// Production rebuilds spread the prior model (mergeDynamicModel spreads
		// existing+dynamic), so judgment arrives as an own spec property; the
		// merge site gates it on api equality instead.
		const rebuiltAnthropic = buildModel({
			...toModelSpec(built),
			api: "anthropic-messages" as const,
			judgment: undefined,
		});
		expect(rebuiltAnthropic.judgment).toBeUndefined();

		const rebuiltOpenRouter = buildModel({
			...toModelSpec(built),
			api: "openrouter-decisions" as const,
			judgment: undefined,
		});
		expect(rebuiltOpenRouter.judgment).toBeUndefined();

		const explicitRebuild = buildModel({
			...toModelSpec(built),
			api: "anthropic-messages",
			judgment: {
				route: "/v1/custom-evaluate",
			},
		});
		expect(explicitRebuild.judgment).toEqual({
			route: "/v1/custom-evaluate",
		});
	});
});
