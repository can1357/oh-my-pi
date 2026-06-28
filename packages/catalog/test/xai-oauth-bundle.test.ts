import { describe, expect, it } from "bun:test";
import MODELS_JSON from "@pk-nerdsaver-ai/pi-catalog/models.json" with { type: "json" };
import { buildXaiOAuthStaticSeed } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";

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

	// Absolute contract for the user-specified SuperGrok addition. The parity
	// loop above can't catch a value typo (e.g. 2_000_000) or a flipped
	// reasoning flag — both sides regenerate from the same seed together — so
	// pin the literal attributes here.
	it("exposes grok-composer-2.5-fast as a non-reasoning 200K text model", () => {
		const composer = seed.find(model => model.id === "grok-composer-2.5-fast");
		expect(composer, "grok-composer-2.5-fast must be in the SuperGrok curated seed").toBeDefined();
		expect(composer!.reasoning).toBe(false);
		expect(composer!.contextWindow).toBe(200_000);
		expect(composer!.input).toEqual(["text"]);
		// The bundled models.json entry is byte-identical to the generator's
		// deterministic xai-oauth output: gen:models pushes
		// buildXaiOAuthStaticSeed() (offline — xai-oauth has no upstream catalog
		// source) and applyGeneratedModelPolicies(), so a regen reproduces these
		// exact bytes; only unrelated other-provider network churn was excluded
		// to keep the diff scoped. Pin its zero-cost invariant (overlay-stable
		// for the SuperGrok subscription), which the parity loop above never
		// compares. (maxTokens is pinned by the maxTokens-equals-contextWindow
		// test below.)
		expect(bundled["grok-composer-2.5-fast"]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
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
