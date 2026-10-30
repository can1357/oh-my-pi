import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { kimiCodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const LIVE_K3 = {
	id: "k3",
	display_name: "K3",
	context_length: 1_048_576,
	supports_reasoning: true,
	supports_thinking_type: "only",
	think_efforts: {
		support: true,
		valid_efforts: ["low", "high", "max"],
		default_effort: "max",
	},
	protocol: null,
};

async function discover(models: readonly Record<string, unknown>[]) {
	const fetchImpl: FetchImpl = async () => Response.json({ data: models });
	const fetchDynamicModels = kimiCodeModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl }).fetchDynamicModels;
	if (!fetchDynamicModels) throw new Error("Kimi Code dynamic discovery is not configured");
	return (await fetchDynamicModels())?.map(buildModel) ?? [];
}

describe("Kimi Code provider catalog", () => {
	it("replaces bundled-only rows with live discovery and keeps that authoritative cache offline", async () => {
		await using temp = await TempDir.create("@kimi-code-authoritative-");
		const options = {
			...kimiCodeModelManagerOptions({
				apiKey: "test-key",
				fetch: async () => Response.json({ data: [{ ...LIVE_K3, id: "k3.1-pro" }] }),
			}),
			cacheDbPath: temp.join("models.db"),
		};
		const online = await resolveProviderModels(options, "online");
		expect(online.models.map(model => model.id)).toEqual(["k3.1-pro"]);
		const offline = await resolveProviderModels(options, "offline");
		expect(offline.models.map(model => model.id)).toEqual(["k3.1-pro"]);
	});

	it("scopes the authoritative discovery cache to the credential", async () => {
		await using temp = await TempDir.create("@kimi-code-credential-cache-");
		const cacheDbPath = temp.join("models.db");
		const fetched: string[] = [];
		const planOptions = (apiKey: string, id: string) => ({
			...kimiCodeModelManagerOptions({
				apiKey,
				fetch: async () => {
					fetched.push(apiKey);
					return Response.json({ data: [{ ...LIVE_K3, id }] });
				},
			}),
			cacheDbPath,
		});
		const planA = planOptions("plan-a-key", "k3.1-pro");
		const planB = planOptions("plan-b-key", "kimi-for-coding");

		const a = await resolveProviderModels(planA, "online-if-uncached");
		expect(a.models.map(model => model.id)).toEqual(["k3.1-pro"]);
		const b = await resolveProviderModels(planB, "online-if-uncached");
		expect(b.models.map(model => model.id)).toEqual(["kimi-for-coding"]);
		expect(fetched).toEqual(["plan-a-key", "plan-b-key"]);

		const offlineA = await resolveProviderModels(planA, "offline");
		expect(offlineA.models.map(model => model.id)).toEqual(["k3.1-pro"]);
		const offlineB = await resolveProviderModels(planB, "offline");
		expect(offlineB.models.map(model => model.id)).toEqual(["kimi-for-coding"]);
	});

	it("preserves live Kimi thinking ladders during catalog regeneration", async () => {
		const options = kimiCodeModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				Response.json({
					data: [
						LIVE_K3,
						{ ...LIVE_K3, id: "k3.1-pro" },
						{ ...LIVE_K3, id: "k3.1-pro-highspeed" },
						{ ...LIVE_K3, id: "kimi-for-coding" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		if (!models) throw new Error("Kimi Code dynamic discovery did not return models");
		applyGeneratedModelPolicies([...models]);
		for (const spec of models) {
			expect(spec.thinking).toMatchObject({
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				defaultLevel: Effort.Max,
				requiresEffort: true,
			});
			expect(buildModel(spec).thinking).toMatchObject(spec.thinking!);
		}
	});

	it("does not invent an effort ladder for mandatory-thinking Highspeed without live controls", async () => {
		const models = await discover([{ ...LIVE_K3, id: "kimi-for-coding-highspeed", think_efforts: undefined }]);
		expect(models[0]?.reasoning).toBe(true);
		expect(models[0]?.thinking?.efforts ?? []).toEqual([]);
	});

	it("uses live K3 effort, mandatory-thinking, and native-protocol metadata", async () => {
		const models = await discover([LIVE_K3]);
		const model = models.find(candidate => candidate.id === "k3");

		expect(model).toMatchObject({
			id: "k3",
			name: "K3",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				defaultLevel: Effort.Max,
				requiresEffort: true,
			},
			compat: {
				thinkingFormat: "kimi",
				kimiApiFormat: "openai",
			},
		});
	});

	it("uses server protocol while preserving legacy K2 discovery defaults", async () => {
		const models = await discover([
			{ ...LIVE_K3, id: "k3-anthropic", protocol: "anthropic" },
			{
				id: "kimi-for-coding",
				display_name: "K2.7 Code",
				context_length: 262_144,
				supports_reasoning: true,
			},
		]);
		const anthropic = models.find(candidate => candidate.id === "k3-anthropic");
		const legacy = models.find(candidate => candidate.id === "kimi-for-coding");

		expect(anthropic?.compat.kimiApiFormat).toBe("anthropic");
		expect(legacy?.compat).toMatchObject({ thinkingFormat: "zai" });
		// Unreported protocol resolves the provider-root KDL default (kimi-api-format "anthropic").
		expect(legacy?.compat.kimiApiFormat).toBe("anthropic");
		expect(legacy?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("derives per-family output caps instead of a blanket constant (#6711)", async () => {
		const models = await discover([
			LIVE_K3,
			{ ...LIVE_K3, id: "k3.1-pro", display_name: "K3.1 Pro", context_length: 1_048_576 },
			{ ...LIVE_K3, id: "k3.1-pro-highspeed", display_name: "K3.1 Pro Highspeed", context_length: 1_048_576 },
			{ ...LIVE_K3, id: "k3-256k", display_name: "K3 256k", context_length: 262_144 },
			{ id: "kimi-for-coding", display_name: "K2.7 Code", context_length: 262_144, supports_reasoning: true },
			{
				id: "kimi-for-coding-highspeed",
				display_name: "K2.7 Code Highspeed",
				context_length: 262_144,
				supports_reasoning: true,
			},
			{ id: "kimi-k2", display_name: "Kimi K2", context_length: 262_144 },
		]);
		const maxTokensFor = (id: string) => models.find(model => model.id === id)?.maxTokens;

		expect(maxTokensFor("k3.1-pro")).toBe(131_072);
		expect(maxTokensFor("k3.1-pro-highspeed")).toBe(131_072);
		expect(maxTokensFor("k3")).toBe(131_072);
		expect(maxTokensFor("k3-256k")).toBe(131_072);
		expect(maxTokensFor("kimi-for-coding")).toBe(32_768);
		expect(maxTokensFor("kimi-for-coding-highspeed")).toBe(32_768);
		expect(maxTokensFor("kimi-k2")).toBe(32_000);
	});

	it("lets supports_thinking_type override the legacy reasoning flag", async () => {
		const models = await discover([
			{ ...LIVE_K3, id: "non-thinking", supports_thinking_type: "no", think_efforts: undefined },
		]);

		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinking).toBeUndefined();
	});

	it("prices $0-discovered rows instead of recording $0 in usage stats", async () => {
		// /coding/v1/models carries no pricing: rows take their
		// cost-fallback (k3 and k3.1-pro at the public K3/K3.1 list, including
		// their 5m cache write; kimi-k2 at the K2 list; kimi-for-coding at the
		// K2.7 Code line rate because K2.8 Preview has no public SKU).
		const models = await discover([
			{ ...LIVE_K3, id: "k3.1-pro" },
			{ ...LIVE_K3, id: "k3.1-pro-highspeed" },
			LIVE_K3,
			{ ...LIVE_K3, id: "kimi-for-coding" },
			{ ...LIVE_K3, id: "kimi-k2" },
		]);

		expect(models.find(candidate => candidate.id === "k3.1-pro")?.cost).toMatchObject({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2,
		});
		expect(models.find(candidate => candidate.id === "k3.1-pro-highspeed")?.cost).toMatchObject({
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite: 4,
		});
		expect(models.find(candidate => candidate.id === "k3")?.cost).toMatchObject({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3,
		});
		expect(models.find(candidate => candidate.id === "kimi-for-coding")?.cost).toMatchObject({
			input: 0.95,
			output: 4,
			cacheRead: 0.19,
		});
		expect(models.find(candidate => candidate.id === "kimi-k2")?.cost).toMatchObject({
			input: 0.6,
			output: 2.5,
			cacheRead: 0.15,
		});
	});

	it("bills K3 and K3.1 Pro cache writes from the cold offline and failed-discovery catalogs", async () => {
		await using temp = await TempDir.create("@kimi-code-cache-write-");
		for (const strategy of ["offline", "online"] as const) {
			const { models } = await resolveProviderModels(
				{
					...kimiCodeModelManagerOptions({
						apiKey: "test-key",
						fetch: async () => new Response(null, { status: 503 }),
					}),
					cacheDbPath: temp.join(`${strategy}.db`),
				},
				strategy,
			);
			for (const [id, expectedCost] of [
				["k3", 3],
				["k3-256k", 3],
				["k3.1-pro", 2],
				["k3.1-pro-highspeed", 4],
				["kimi-for-coding", 0],
			] as const) {
				const model = models.find(candidate => candidate.id === id);
				if (!model) throw new Error(`Missing ${id} in ${strategy} catalog`);
				const cost = calculateCost(model, {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 1_000_000,
					totalTokens: 1_000_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				});
				expect(cost.cacheWrite).toBe(expectedCost);
				expect(cost.total).toBe(expectedCost);
			}
		}
	});
});
