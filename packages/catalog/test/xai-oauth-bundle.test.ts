import { describe, expect, it } from "bun:test";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	buildXaiOAuthStaticSeed,
	xaiOAuthModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Pins the invariant: bundled `models.json` carries every entry the runtime
// xai-oauth KDL seed (surfaced via buildXaiOAuthStaticSeed) emits. Without
// this, editing the seed without regenerating `models.json` silently regresses
// the boot-time default-model resolver — the registry sees the runtime seed
// only after `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only `models.json`.
//
// Failure here means: run `bun run gen:models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)["xai-oauth"] ?? {};
	const seed = buildXaiOAuthStaticSeed();

	it("defaults SuperGrok selection to grok-4.6", () => {
		const entry = providerEntry("xai-oauth");
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

describe("xai-api-oauth routing contract", () => {
	const providerId = "xai-api-oauth";
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)[providerId] ?? {};
	const seed = buildXaiOAuthStaticSeed(undefined, providerId);

	it("requests API access without Grok Build access", () => {
		const auth = authPolicyFor(providerId);
		expect(auth?.login?.kind).toBe("device-code");
		if (auth?.login?.kind !== "device-code") throw new Error("Expected xAI API OAuth device-code login");
		expect(auth.login.scopes).toContain("api:access");
		expect(auth.login.scopes).not.toContain("grok-cli:access");
	});

	it("bundles grok-4.6 without Grok Build or SuperGrok Composer models", () => {
		expect(providerEntry(providerId)?.defaultModel).toBe("grok-4.6");
		expect(DEFAULT_MODEL_PER_PROVIDER[providerId]).toBe("grok-4.6");
		expect(seed.some(model => model.id === "grok-4.6")).toBe(true);
		expect(seed.some(model => model.id.startsWith("grok-build"))).toBe(false);
		expect(seed.some(model => model.id === "grok-composer-2.5-fast")).toBe(false);
		expect(Object.keys(bundled).sort()).toEqual(seed.map(model => model.id).sort());
	});

	it("prices API-only models from their public xAI peers", () => {
		expect(bundled["grok-4.6"]?.cost.input).toBeGreaterThan(0);
		expect(bundled["grok-4.20-multi-agent-0309"]?.cost.input).toBeGreaterThan(0);
	});

	it("filters non-API models and preserves per-model prices during live discovery", async () => {
		const options = xaiOAuthModelManagerOptions({
			providerId,
			apiKey: "oauth-token",
			fetch: async () =>
				Response.json({
					data: [
						{ id: "grok-build", object: "model", created: 0, owned_by: "xai" },
						{ id: "grok-composer-2.5-fast", object: "model", created: 0, owned_by: "xai" },
						{ id: "grok-imagine-1.0", object: "model", created: 0, owned_by: "xai" },
						{ id: "grok-4.6", object: "model", created: 0, owned_by: "xai" },
					],
				}),
		});

		const discovered = await options.fetchDynamicModels?.();
		expect(discovered?.map(model => model.id)).not.toContain("grok-build");
		expect(discovered?.map(model => model.id)).not.toContain("grok-composer-2.5-fast");
		expect(discovered?.map(model => model.id)).not.toContain("grok-imagine-1.0");
		expect(discovered?.map(model => model.id)).toContain("grok-4.6");
		expect(discovered?.find(model => model.id === "grok-4.3")?.cost).toEqual(bundled["grok-4.3"]?.cost);
	});
});
