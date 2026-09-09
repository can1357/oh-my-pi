import { describe, expect, it } from "bun:test";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { CATALOG_PROVIDERS, DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { buildXaiOAuthStaticSeed } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Pins the invariant: bundled `models.json` carries every entry the runtime
// curated catalog (XAI_OAUTH_CURATED_MODELS, surfaced via
// buildXaiOAuthStaticSeed) emits. Without this, editing the curated list
// without regenerating `models.json` silently regresses the boot-time
// default-model resolver — the registry sees the runtime seed only after
// `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only `models.json`.
//
// Failure here means: run `bun run gen:models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)["xai-oauth"] ?? {};
	const seed = buildXaiOAuthStaticSeed();

	it("defaults SuperGrok selection to grok-4.6", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai-oauth");
		expect(entry?.defaultModel).toBe("grok-4.6");
		expect(DEFAULT_MODEL_PER_PROVIDER["xai-oauth"]).toBe("grok-4.6");
		expect(bundled["grok-4.6"], "xai-oauth/grok-4.6 must be bundled for the default").toBeDefined();
	});

	it("bundles every curated id", () => {
		const seededIds = seed.map(model => model.id).sort();
		const bundledIds = Object.keys(bundled).sort();
		expect(bundledIds).toEqual(seededIds);
	});

	for (const seededModel of seed) {
		it(`matches contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `xai-oauth/${seededModel.id} missing from models.json`).toBeDefined();
			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("xai-oauth");
			expect(bundledEntry.api).toBe("openai-responses");
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			expect(bundledEntry.reasoning).toBe(seededModel.reasoning);
			// Input modality must survive both the curated seed and the bundle.
			// Without this the static fallback used on offline boot strips
			// vision capability silently (Codex PR #1127 review).
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(bundledEntry.compat?.supportsReasoningEffort).toBe(seededModel.compat?.supportsReasoningEffort);
		});
	}

	// SuperGrok's `grok-4.20-multi-agent-0309` mirrors the paid catalog's
	// `grok-4.20-multi-agent-beta-latest` under a different ID; the price
	// fallback must bridge the alias so the bundle carries its public rate card
	// (including the inclusive 200K tier) instead of the subscription zero.
	it("prices the multi-agent SuperGrok alias from its public xAI equivalent", () => {
		expect(bundled["grok-4.20-multi-agent-0309"]?.cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.2,
			cacheWrite: 0,
			longContext: {
				inputThreshold: 200_000,
				inputThresholdInclusive: true,
				input: 4,
				output: 12,
				cacheRead: 0.4,
				cacheWrite: 0,
			},
		});
	});

	// The OAuth surface's /v1/models reports no per-request output limit, so the
	// curated catalog owns maxTokens — set to mirror each model's contextWindow
	// (the openai-responses wire still clamps the actual request to
	// OPENAI_MAX_OUTPUT_TOKENS). Pin maxTokens === contextWindow on both the
	// static-seed and bundled paths so a null placeholder can
	// never silently leak back into the bundle.
	it("sets maxTokens equal to contextWindow for every xai-oauth model", () => {
		for (const model of seed) {
			expect(model.maxTokens, `seed ${model.id} maxTokens`).toBe(model.contextWindow);
			expect(bundled[model.id]?.maxTokens, `bundled ${model.id} maxTokens`).toBe(model.contextWindow);
		}
	});
});
