import { describe, expect, it } from "bun:test";
import { buildFactoryDroidModel, fetchFactoryDroidModels } from "../src/discovery/factory-droid";
import {
	FACTORY_DROID_ANTHROPIC_BASE_URL,
	FACTORY_DROID_COMPLETIONS_BASE_URL,
	FACTORY_DROID_GOOGLE_BASE_URL,
	FACTORY_DROID_MODEL_META,
	FACTORY_DROID_MODELS,
	FACTORY_DROID_RESPONSES_BASE_URL,
} from "../src/discovery/factory-droid-models";
import { ANTHROPIC_THINKING, Effort } from "../src/effort";
import { factoryDroidModelManagerOptions } from "../src/provider-models/special";
import type { FetchImpl } from "../src/types";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("Factory Droid catalog", () => {
	it("builds Kimi K3 with wire defaults, the off-switch, and its default upstream", () => {
		const model = buildFactoryDroidModel({
			id: "kimi-k3",
			name: "Kimi K3 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 196_608,
			maxTokens: 65_536,
			apiProviders: ["fireworks", "baseten"],
			supportedReasoningEfforts: ["off", Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
		});

		expect(model).toMatchObject({
			id: "kimi-k3",
			api: "factory-droid-agent",
			provider: "factory-droid",
			baseUrl: FACTORY_DROID_COMPLETIONS_BASE_URL,
			input: ["text", "image"],
			cost: zeroCost,
			contextWindow: 196_608,
			maxTokens: 65_536,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				requiresEffort: false,
				defaultLevel: Effort.High,
			},
		});
		// The registry's first rotation entry is the default upstream the
		// provider sends as `x-api-provider` when routing is not live.
		expect(FACTORY_DROID_MODEL_META["kimi-k3"].apiProviders[0]).toBe("fireworks");
	});

	it("marks text-only models and forces effort when off is unsupported", () => {
		const model = buildFactoryDroidModel({
			id: "text-model",
			name: "Text model",
			wire: "openai-completions",
			contextWindow: 100_000,
			maxTokens: 10_000,
			apiProviders: ["baseten"],
			noImageSupport: true,
			supportedReasoningEfforts: [Effort.High],
			defaultReasoningEffort: Effort.High,
		});

		expect(model.input).toEqual(["text"]);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High],
			requiresEffort: true,
			defaultLevel: Effort.High,
		});
	});

	it("omits thinking config for models without a controllable ladder", () => {
		const model = buildFactoryDroidModel({
			id: "glm-4.6",
			name: "GLM-4.6 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 128_000,
			apiProviders: ["baseten"],
			supportedReasoningEfforts: ["none"],
			defaultReasoningEffort: "none",
			noImageSupport: true,
		});

		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});

	it("ships the static registry through the model manager", () => {
		const manager = factoryDroidModelManagerOptions();
		expect(manager.providerId).toBe("factory-droid");
		const models = manager.staticModels ?? [];
		expect(models.length).toBeGreaterThanOrEqual(50);
		// Every static model comes from the bundled registry's entries.
		for (const model of models) {
			expect(FACTORY_DROID_MODEL_META[model.id]).toBeDefined();
		}
		expect(models.find(model => model.id === "kimi-k3")).toBeDefined();
	});

	it("filters the static registry by feature flags and org model policy", async () => {
		const flags = Object.fromEntries(
			FACTORY_DROID_MODELS.flatMap(m => (m.featureFlag ? [[m.featureFlag, true]] : [])),
		);
		flags.kimi_k3 = false; // account gate off -> kimi-k3 hidden
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags }), { status: 200 });
			}
			return new Response(
				JSON.stringify({
					settings: { modelPolicy: { allowAllFactoryModels: false, allowedModelIds: ["kimi-k2.6"] } },
				}),
				{ status: 200 },
			);
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		expect(models?.map(model => model.id)).toEqual(["kimi-k2.6"]);
	});

	it("applies the live provider_routing config to the model spec", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(
					JSON.stringify({
						flags: { kimi_k3: true },
						configs: { provider_routing: { version: 1, models: { "kimi-k3": ["baseten", "fireworks"] } } },
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ settings: {} }), { status: 200 });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		const kimi = models?.find(model => model.id === "kimi-k3");
		expect(kimi?.factoryDroidApiProviders).toEqual(["baseten", "fireworks"]);
		// Models without a routing entry keep the registry's static order.
		const glm = models?.find(model => model.id === "glm-5.2");
		expect(glm?.factoryDroidApiProviders).toBeUndefined();
	});

	it("falls back to null without credentials so the static list stays", async () => {
		const fetchImpl: FetchImpl = async () => {
			throw new Error("network down");
		};
		expect(await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl })).toBeNull();
	});

	it("exposes requiresEffort explicitly: false on off/none ladders, true otherwise", () => {
		// The registry keeps the CLI's raw rungs; the builder strips them from
		// efforts and derives requiresEffort from their absence, so users can
		// disable thinking on every model the CLI allows it for. Explicit
		// false wins over the model-thinking backfill for kimi-k3.
		const offLadders = [
			"claude-sonnet-4-5-20250929",
			"claude-opus-4-5-20251101",
			"claude-haiku-4-5-20251001",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
			"claude-opus-4-6",
			"claude-opus-4-6-fast",
			"claude-opus-4-7",
			"claude-opus-4-7-fast",
			"claude-opus-4-8",
			"claude-opus-4-8-fast",
			"claude-opus-5",
			"claude-opus-5-fast",
			"claude-fable-5",
			"atlas-07-21",
			"aster-07-15",
			"amber-07-09",
			"agate-07-11",
			"gpt-5.2",
			"kimi-k2.5",
			"kimi-k2.6",
			"kimi-k2.7-code",
			"kimi-k3",
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"glm-5.1",
			"glm-5.2",
			"glm-5.2-fast",
			"inkling",
			"nemotron-3-ultra",
		];
		const noneLadders = ["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-terra", "gpt-5.6-luna"];
		for (const id of [...offLadders, ...noneLadders]) {
			const meta = FACTORY_DROID_MODEL_META[id];
			const ladder = meta.supportedReasoningEfforts ?? [];
			expect(ladder[0] === "off" || ladder[0] === "none").toBe(true);
			const thinking = buildFactoryDroidModel(meta).thinking;
			expect(thinking?.requiresEffort).toBe(false);
			// The raw off/none rung is stripped from the exposed effort ladder.
			expect(thinking?.efforts).toEqual(ladder.filter((e): e is Effort => e !== "off" && e !== "none"));
		}
		// A ladder without an off/none rung forces thinking on.
		expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["gpt-5.1-codex-max"]).thinking?.requiresEffort).toBe(true);
	});

	it("bakes the shared anthropic budget ladder for budget-style thinking", () => {
		for (const id of ["claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"]) {
			const thinking = buildFactoryDroidModel(FACTORY_DROID_MODEL_META[id]).thinking;
			expect(thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
			expect(thinking?.effortBudgets).toEqual(ANTHROPIC_THINKING);
			expect(thinking?.requiresEffort).toBe(false);
			expect(thinking).not.toHaveProperty("defaultLevel");
		}
		// 'none'-only ladders are not reasoning models: no thinking config is built.
		for (const id of ["glm-4.7", "glm-5"]) {
			expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META[id]).reasoning).toBe(false);
			expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META[id]).thinking).toBeUndefined();
		}
	});

	it("maps each wire family to its base URL", () => {
		const base = {
			contextWindow: 100_000,
			maxTokens: 10_000,
			apiProviders: ["fireworks"] as const,
			supportedReasoningEfforts: [Effort.Low, Effort.High],
		};
		const cases: Array<
			[string, "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generate", string]
		> = [
			["completions", "openai-completions", FACTORY_DROID_COMPLETIONS_BASE_URL],
			["responses", "openai-responses", FACTORY_DROID_RESPONSES_BASE_URL],
			["anthropic", "anthropic-messages", FACTORY_DROID_ANTHROPIC_BASE_URL],
			["google", "google-generate", FACTORY_DROID_GOOGLE_BASE_URL],
		];
		for (const [label, wire, expected] of cases) {
			const model = buildFactoryDroidModel({ id: `m-${label}`, name: label, wire, ...base });
			expect(model.baseUrl).toBe(expected);
		}
	});

	it("classifies reasoning replay per completions model family", () => {
		// capture-only: Kimi families replay only what was captured.
		expect(FACTORY_DROID_MODEL_META["kimi-k3"].reasoningReplay).toBe("capture-only");
		expect(FACTORY_DROID_MODEL_META["kimi-k2.5"].reasoningReplay).toBe("capture-only");
		// standard: GLM-5.1/5.2, Inkling, Nemotron mirror the captured content.
		expect(FACTORY_DROID_MODEL_META["glm-5.2"].reasoningReplay).toBe("standard");
		expect(FACTORY_DROID_MODEL_META["inkling"].reasoningReplay).toBe("standard");
		// placeholder: DeepSeek V4 forces a synthetic placeholder on tool calls.
		expect(FACTORY_DROID_MODEL_META["deepseek-v4-flash-0731"].reasoningReplay).toBe("placeholder");
		expect(FACTORY_DROID_MODEL_META["deepseek-v4-pro"].reasoningReplay).toBe("placeholder");
		// Non-completions models carry no replay classification.
		expect(FACTORY_DROID_MODEL_META["gpt-5.2"].reasoningReplay).toBeUndefined();
		// Every completions-reasoning-shaped model is classified, and vice versa.
		for (const meta of FACTORY_DROID_MODELS) {
			expect((meta.completionsReasoning !== undefined) === (meta.reasoningReplay !== undefined)).toBe(true);
		}
	});

	it("bakes the adaptive-summarized display flag for opus 4.7 fast mode", () => {
		expect(FACTORY_DROID_MODEL_META["claude-opus-4-7-fast"].thinkingStyle).toBe("adaptive-summarized");
		expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-opus-4-7-fast"]).thinking).toMatchObject({
			mode: "anthropic-adaptive",
			supportsDisplay: true,
		});
	});
});
