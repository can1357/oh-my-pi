import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getFactoryDroidRegionBlocklistPath } from "@oh-my-pi/pi-utils";
import { buildFactoryDroidModel, fetchFactoryDroidModels } from "../src/discovery/factory-droid";
import {
	FACTORY_DROID_ANTHROPIC_BASE_URL,
	FACTORY_DROID_COMPLETIONS_BASE_URL,
	FACTORY_DROID_GOOGLE_BASE_URL,
	FACTORY_DROID_MODEL_META,
	FACTORY_DROID_MODELS,
	FACTORY_DROID_RESPONSES_BASE_URL,
	FACTORY_DROID_WIRE_BASE_URLS,
	factoryDroidEdgeRegion,
	factoryDroidWireBaseUrl,
	resolveFactoryDroidRotation,
} from "../src/discovery/factory-droid-models";
import {
	readFactoryDroidRegionBlockedIds,
	recordFactoryDroidRegionBlock,
} from "../src/discovery/factory-droid-region-blocks";
import { ANTHROPIC_THINKING, Effort } from "../src/effort";
import { getBundledModel } from "../src/models";
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
		// Factory retired Inkling in 0.203.0; advertising a model the proxy no
		// longer serves would fail at request time, not at selection time.
		expect(models.find(model => model.id === "inkling")).toBeUndefined();
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

	it("withdraws fast tiers only when the org explicitly disallows them", async () => {
		const flags = Object.fromEntries(
			FACTORY_DROID_MODELS.flatMap(m => (m.featureFlag ? [[m.featureFlag, true]] : [])),
		);
		const discover = async (modelPolicy: Record<string, unknown>): Promise<string[]> => {
			const fetchImpl: FetchImpl = async url =>
				new Response(
					JSON.stringify(String(url).includes("feature-flags") ? { flags } : { settings: { modelPolicy } }),
					{ status: 200 },
				);
			const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
			return models?.map(model => model.id) ?? [];
		};
		// `baseVariant` is what marks an entry as a fast tier; the gate is a
		// class switch, not a per-id policy.
		const fastIds = FACTORY_DROID_MODELS.filter(m => m.baseVariant !== undefined).map(m => m.id);
		expect(fastIds.length).toBeGreaterThan(0);

		// Allow-all is the CLI's default kind, and older servers omit the
		// field entirely: neither may withdraw a fast tier.
		const allowed = await discover({ allowAllFactoryModels: true, isFastModelsAllowed: true });
		const silent = await discover({ allowAllFactoryModels: true });
		for (const id of fastIds) {
			expect(allowed).toContain(id);
			expect(silent).toContain(id);
		}

		// Only an explicit false hides them, and it hides nothing else.
		const denied = await discover({ allowAllFactoryModels: true, isFastModelsAllowed: false });
		for (const id of fastIds) expect(denied).not.toContain(id);
		expect(denied).toContain("gpt-5.4");
		expect(denied.length).toBe(allowed.length - fastIds.length);
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
		// The WebSocket Responses transport is a resolved wire the provider
		// dispatches on, never a registry entry's, and shares the Responses
		// namespace on both hosts.
		expect(FACTORY_DROID_WIRE_BASE_URLS["openai-responses-ws"]).toBe(FACTORY_DROID_RESPONSES_BASE_URL);
		expect(factoryDroidWireBaseUrl("openai-responses-ws", "eu")).toBe("https://api.eu.factory.ai/api/llm/o/v1");
		expect(FACTORY_DROID_MODELS.some(model => model.wire === "openai-responses-ws")).toBe(false);
	});

	it("classifies reasoning replay per completions model family", () => {
		// capture-only: Kimi families replay only what was captured.
		expect(FACTORY_DROID_MODEL_META["kimi-k3"].reasoningReplay).toBe("capture-only");
		expect(FACTORY_DROID_MODEL_META["kimi-k2.5"].reasoningReplay).toBe("capture-only");
		// standard: GLM-5.1/5.2 and Nemotron mirror the captured content.
		expect(FACTORY_DROID_MODEL_META["glm-5.2"].reasoningReplay).toBe("standard");
		expect(FACTORY_DROID_MODEL_META["nemotron-3-ultra"].reasoningReplay).toBe("standard");
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

	it("wires upstream list prices and effective credit rates from the registry", () => {
		// Cost is inherited from the referenced bundled catalog entry, not inlined.
		const kimi = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["kimi-k2.7-code"]);
		expect(kimi.cost).toEqual(getBundledModel("fireworks", "kimi-k2.7-code").cost);
		expect(kimi.factoryDroidCredits).toEqual({ input: 0.38, output: 1.5998 });

		// Cache-read-metered models project the relative multiplier through the input rate.
		const grok = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["grok-4.5"]);
		expect(grok.cost).toEqual(getBundledModel("xai", "grok-4.5").cost);
		expect(grok.factoryDroidCredits).toEqual({ input: 0.8, output: 2.4, cacheRead: 0.12 });

		// No outputTokenMultiplier -> output billed at the input rate.
		const opus = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-opus-5"]);
		expect(opus.factoryDroidCredits).toEqual({ input: 2, output: 2 });
		expect(opus.cost).toEqual(getBundledModel("anthropic", "claude-opus-5").cost);

		// 0.203.0 repriced GLM-5.2 to 0.56 in / 3.15x out.
		const glm = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["glm-5.2"]);
		expect(glm.factoryDroidCredits).toEqual({ input: 0.56, output: 1.764 });
	});

	it("keeps Factory-only SKUs at zero cost with the credit badge only", () => {
		// Fast tiers are distinct SKUs with no upstream list price.
		const fast = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["claude-opus-4-8-fast"]);
		expect(fast.cost).toEqual(zeroCost);
		expect(fast.factoryDroidCredits).toEqual({ input: 4, output: 4 });

		// Preview codenames have no upstream catalog entry either.
		const atlas = buildFactoryDroidModel(FACTORY_DROID_MODEL_META["atlas-07-21"]);
		expect(atlas.cost).toEqual(zeroCost);
		expect(atlas.factoryDroidCredits).toEqual({ input: 2, output: 2 });
	});

	it("mirrors promo credit terms verbatim, expired ones included", () => {
		// The registry is a snapshot of Factory's table, not a live price
		// oracle: an elapsed promoExpiresAt stays recorded and the display
		// layer decides whether the promo still applies.
		expect(FACTORY_DROID_MODEL_META["gpt-5.6-sol"].credits).toEqual({
			input: 2,
			output: 5,
			promoDiscount: 0.2,
			promoExpiresAt: "2026-11-22T00:00:00Z",
			promoLabel: ", Promo Pricing",
		});
		expect(FACTORY_DROID_MODEL_META["gpt-5.6-sol-fast"].credits).toEqual({
			input: 4,
			output: 5,
			promoDiscount: 0.2,
			promoExpiresAt: "2026-11-22T00:00:00Z",
			promoLabel: ", Promo Pricing",
		});
		expect(FACTORY_DROID_MODEL_META["kimi-k3"].credits).toEqual({
			input: 1.2,
			output: 5,
			promoDiscount: 0.5,
			promoExpiresAt: "2026-08-10T00:00:00Z",
			promoLabel: ", 50% Off",
		});
		// The projection turns multipliers into rates but leaves promo terms
		// untouched and unfiltered — the badge needs the raw terms to decide.
		expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["kimi-k3"]).factoryDroidCredits).toEqual({
			input: 1.2,
			output: 6,
			promoDiscount: 0.5,
			promoExpiresAt: "2026-08-10T00:00:00Z",
			promoLabel: ", 50% Off",
		});
		// A model with no promo carries no promo fields at all.
		expect(buildFactoryDroidModel(FACTORY_DROID_MODEL_META["kimi-k2.6"]).factoryDroidCredits).toEqual({
			input: 0.4,
			output: 1.6,
		});
	});

	it("ships gemini-3.7-flash on the google ladder with no upstream list price yet", () => {
		const meta = FACTORY_DROID_MODEL_META["gemini-3.7-flash"];
		expect(meta.wire).toBe("google-generate");
		expect(meta.apiProviders).toEqual(["google"]);
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.maxTokens).toBe(65_536);
		expect(meta.featureFlag).toBe("gemini_3_7_flash");
		// Not in the bundled catalog: cost degrades to zero, credits carry it.
		expect(meta.priceRef).toBeUndefined();

		const model = buildFactoryDroidModel(meta);
		expect(model.baseUrl).toBe(FACTORY_DROID_GOOGLE_BASE_URL);
		expect(model.cost).toEqual(zeroCost);
		expect(model.thinking).toMatchObject({
			mode: "google-level",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			defaultLevel: Effort.High,
			requiresEffort: true,
		});
		expect(model.factoryDroidCredits).toEqual({
			input: 0.6,
			output: 3,
			promoDiscount: 0.5,
			promoExpiresAt: "2027-01-01T00:00:00Z",
			promoLabel: ", 50% Off",
		});
		// 3.6 lost its minimal rung in the same release; 3.7 never had one.
		expect(FACTORY_DROID_MODEL_META["gemini-3.6-flash"].supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
	});

	it("resolves every registry priceRef in the bundled catalog", () => {
		// A models.json regen that drops a referenced id must fail here, not
		// silently degrade the model's cost display to zero.
		let checked = 0;
		for (const meta of FACTORY_DROID_MODELS) {
			if (!meta.priceRef) continue;
			checked += 1;
			const reference = getBundledModel(meta.priceRef.provider, meta.priceRef.modelId) as unknown;
			expect(reference, `${meta.id} -> ${meta.priceRef.provider}/${meta.priceRef.modelId}`).toBeDefined();
		}
		expect(checked).toBeGreaterThan(30);
	});
});

describe("Factory Droid EU region", () => {
	const allFlagsOn = Object.fromEntries(
		FACTORY_DROID_MODELS.flatMap(m => (m.featureFlag ? [[m.featureFlag, true]] : [])),
	);
	const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

	it("resolves rotations from the region: override wins, filter is the fallback, global passes through", () => {
		const opus5 = FACTORY_DROID_MODELS.find(m => m.id === "claude-opus-5")!;
		const sonnet = FACTORY_DROID_MODELS.find(m => m.id === "claude-sonnet-4-5-20250929")!;
		const fable = FACTORY_DROID_MODELS.find(m => m.id === "claude-fable-5")!;
		const kimi = FACTORY_DROID_MODELS.find(m => m.id === "kimi-k3")!;

		// Explicit EU override (the CLI's regionOverrides.eu) wins verbatim.
		expect(resolveFactoryDroidRotation(opus5, "eu")).toEqual(["bedrock_anthropic"]);
		// An empty override means unavailable in the region.
		expect(resolveFactoryDroidRotation(fable, "eu")).toEqual([]);
		// No override: the default rotation is filtered to EU-serving upstreams.
		expect(resolveFactoryDroidRotation(sonnet, "eu")).toEqual(["vertex_anthropic", "bedrock_anthropic"]);
		// fireworks/baseten serve only the global region.
		expect(resolveFactoryDroidRotation(kimi, "eu")).toEqual([]);
		// Global and unknown regions keep the static rotation untouched.
		expect(resolveFactoryDroidRotation(opus5, undefined)).toEqual(opus5.apiProviders);
		expect(resolveFactoryDroidRotation(opus5, "global")).toEqual(opus5.apiProviders);
		expect(resolveFactoryDroidRotation(kimi, "global")).toEqual(["fireworks", "baseten"]);
	});

	it("keeps the 0.203.0 azure and mistral additions out of EU rotations", () => {
		const gpt52 = FACTORY_DROID_MODELS.find(m => m.id === "gpt-5.2")!;
		const gpt54 = FACTORY_DROID_MODELS.find(m => m.id === "gpt-5.4")!;
		const glm52 = FACTORY_DROID_MODELS.find(m => m.id === "glm-5.2")!;

		// azure_openai joined the GPT rotations in second position...
		expect(gpt52.apiProviders).toEqual(["openai", "azure_openai"]);
		expect(resolveFactoryDroidRotation(gpt52, "global")).toEqual(["openai", "azure_openai"]);
		// ...but serves the global region only, so EU accounts never route to it.
		expect(resolveFactoryDroidRotation(gpt52, "eu")).toEqual(["openai"]);
		// An explicit EU override still wins verbatim over that filter.
		expect(gpt54.apiProviders).toEqual(["openai", "azure_openai", "bedrock_openai"]);
		expect(resolveFactoryDroidRotation(gpt54, "eu")).toEqual(["openai"]);
		// mistral is global-only too, so GLM-5.2 stays EU-unavailable.
		expect(glm52.apiProviders).toEqual(["fireworks", "baseten", "mistral"]);
		expect(resolveFactoryDroidRotation(glm52, "eu")).toEqual([]);
	});

	it("queries the EU host and hides models with no EU-serving upstream", async () => {
		const urls: string[] = [];
		const fetchImpl: FetchImpl = async url => {
			urls.push(String(url));
			if (String(url).includes("feature-flags")) return okJson({ flags: allFlagsOn });
			return okJson({ settings: {} });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", region: "eu", fetch: fetchImpl });
		expect(models).not.toBeNull();
		const ids = models!.map(model => model.id);

		// Discovery endpoints follow the region.
		expect(urls[0]).toBe("https://api.eu.factory.ai/api/feature-flags");
		expect(urls[1]).toBe("https://api.eu.factory.ai/api/organization/managed-settings");

		// Hidden for EU: Droid Core (fireworks/baseten-only), Gemini (google-only),
		// grok (xai-only), and fable-5 (explicit empty EU override).
		expect(ids).not.toContain("kimi-k3");
		expect(ids).not.toContain("gemini-3.1-pro-preview");
		expect(ids).not.toContain("grok-4.5");
		expect(ids).not.toContain("claude-fable-5");
		// Available with region-resolved rotations and EU wire URLs.
		const opus5 = models!.find(model => model.id === "claude-opus-5")!;
		expect(opus5.factoryDroidApiProviders).toEqual(["bedrock_anthropic"]);
		expect(opus5.baseUrl).toBe("https://api.eu.factory.ai/api/llm/a");
		const sonnet = models!.find(model => model.id === "claude-sonnet-4-5-20250929")!;
		expect(sonnet.factoryDroidApiProviders).toEqual(["vertex_anthropic", "bedrock_anthropic"]);
		const gpt54 = models!.find(model => model.id === "gpt-5.4")!;
		expect(gpt54.factoryDroidApiProviders).toEqual(["openai"]);
		expect(gpt54.baseUrl).toBe("https://api.eu.factory.ai/api/llm/o/v1");
	});

	it("intersects live provider_routing with the EU rotation instead of resurrecting global upstreams", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return okJson({
					flags: allFlagsOn,
					configs: {
						provider_routing: {
							version: 1,
							models: {
								// US-centric entry: no EU upstream survives the intersection,
								// so the region-resolved rotation wins.
								"claude-opus-5": ["anthropic"],
								// Mixed entry narrows to the EU-serving subset.
								"claude-sonnet-4-5-20250929": ["anthropic", "bedrock_anthropic"],
							},
						},
					},
				});
			}
			return okJson({ settings: {} });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", region: "eu", fetch: fetchImpl });
		expect(models!.find(model => model.id === "claude-opus-5")?.factoryDroidApiProviders).toEqual([
			"bedrock_anthropic",
		]);
		expect(models!.find(model => model.id === "claude-sonnet-4-5-20250929")?.factoryDroidApiProviders).toEqual([
			"bedrock_anthropic",
		]);
	});

	it("keeps the global path byte-identical when no region is known", async () => {
		const urls: string[] = [];
		const fetchImpl: FetchImpl = async url => {
			urls.push(String(url));
			if (String(url).includes("feature-flags")) return okJson({ flags: allFlagsOn });
			return okJson({ settings: {} });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		expect(urls[0]).toBe("https://api.factory.ai/api/feature-flags");
		const opus5 = models!.find(model => model.id === "claude-opus-5")!;
		// No routing entry: the sparse field stays unset and the wire URL is the global host.
		expect(opus5.factoryDroidApiProviders).toBeUndefined();
		expect(opus5.baseUrl).toBe("https://api.factory.ai/api/llm/a");
		expect(models!.find(model => model.id === "kimi-k3")).toBeDefined();
	});
});

describe("Factory Droid serving edge", () => {
	const allFlagsOn = Object.fromEntries(
		FACTORY_DROID_MODELS.flatMap(m => (m.featureFlag ? [[m.featureFlag, true]] : [])),
	);

	it("parses the serving edge PoP from x-vercel-id", () => {
		expect(factoryDroidEdgeRegion(new Headers({ "x-vercel-id": "cdg1::sfo1::jsvsj-123" }))).toBe("eu");
		expect(factoryDroidEdgeRegion(new Headers({ "x-vercel-id": "FRA1::iad1::x" }))).toBe("eu");
		expect(factoryDroidEdgeRegion(new Headers({ "x-vercel-id": "sfo1::sfo1::x" }))).toBeUndefined();
		expect(factoryDroidEdgeRegion(new Headers({ "x-vercel-id": "cpt1::sfo1::x" }))).toBeUndefined();
		expect(factoryDroidEdgeRegion(new Headers())).toBeUndefined();
		expect(factoryDroidEdgeRegion(new Headers({ "x-vercel-id": "" }))).toBeUndefined();
	});

	it("hides global-only-upstream models and resolves EU rotations on an EU edge, keeping the global host", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags: allFlagsOn }), {
					status: 200,
					headers: { "x-vercel-id": "cdg1::sfo1::jsvsj-123" },
				});
			}
			return new Response(JSON.stringify({ settings: {} }), { status: 200 });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		const ids = models!.map(model => model.id);
		// No EU-serving upstream: hidden exactly as for an EU-resident account.
		expect(ids).not.toContain("kimi-k3");
		expect(ids).not.toContain("gemini-3.1-pro-preview");
		expect(ids).not.toContain("grok-4.5");
		expect(ids).not.toContain("claude-fable-5");
		// EU rotation override applies, but the host stays global (account has
		// no residency region; only the serving edge is European).
		const opus5 = models!.find(model => model.id === "claude-opus-5");
		expect(opus5?.factoryDroidApiProviders).toEqual(["bedrock_anthropic"]);
		expect(opus5?.baseUrl).toBe(FACTORY_DROID_ANTHROPIC_BASE_URL);
	});

	it("leaves the model list untouched on a US edge", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags: allFlagsOn }), {
					status: 200,
					headers: { "x-vercel-id": "sfo1::sfo1::jsvsj-123" },
				});
			}
			return new Response(JSON.stringify({ settings: {} }), { status: 200 });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		expect(models!.find(model => model.id === "kimi-k3")).toBeDefined();
	});

	it("lets an explicit account region win over a US edge", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags: allFlagsOn }), {
					status: 200,
					headers: { "x-vercel-id": "sfo1::sfo1::jsvsj-123" },
				});
			}
			return new Response(JSON.stringify({ settings: {} }), { status: 200 });
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", region: "eu", fetch: fetchImpl });
		const ids = models!.map(model => model.id);
		expect(ids).not.toContain("kimi-k3");
		expect(models!.find(model => model.id === "claude-opus-5")?.baseUrl).toContain("api.eu.factory.ai");
	});

	it("hides models excluded by the region blocklist", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags: allFlagsOn }), { status: 200 });
			}
			return new Response(JSON.stringify({ settings: {} }), { status: 200 });
		};
		const models = await fetchFactoryDroidModels({
			apiKey: "token",
			fetch: fetchImpl,
			excludeModelIds: ["claude-opus-5"],
		});
		const ids = models!.map(model => model.id);
		expect(ids).not.toContain("claude-opus-5");
		expect(ids).toContain("kimi-k3");
	});
});

describe("Factory Droid region blocklist", () => {
	it("round-trips blocked model ids and tolerates a missing or corrupt file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fd-region-blocks-"));
		expect(await readFactoryDroidRegionBlockedIds(dir)).toEqual([]);
		await recordFactoryDroidRegionBlock("deepseek-v4-flash-0731", dir);
		await recordFactoryDroidRegionBlock("kimi-k3", dir);
		// Re-recording keeps the entry idempotent.
		await recordFactoryDroidRegionBlock("kimi-k3", dir);
		expect([...(await readFactoryDroidRegionBlockedIds(dir))].sort()).toEqual(["deepseek-v4-flash-0731", "kimi-k3"]);
		await Bun.write(getFactoryDroidRegionBlocklistPath(dir), "not json");
		expect(await readFactoryDroidRegionBlockedIds(dir)).toEqual([]);
	});
});
