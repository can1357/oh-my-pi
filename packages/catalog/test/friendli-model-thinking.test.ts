import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { buildOpenAICompat } from "../src/compat/openai";

/**
 * Friendli reasoning surfaces resolve per MODEL, not per host: effort models
 * (a discovered `thinking.efforts` ladder, or GLM-5.2+ identity) take top-level
 * `reasoning_effort`, while toggle-only models 400 on it. A Friendli-hosted
 * spec with neither signal has an unclassified effort surface and must report
 * no thinking config rather than fabricate a default ladder whose tiers all
 * serialize to byte-identical bodies (`supportsReasoningEffort: false`
 * strips `reasoning_effort` from the wire).
 */
function createFriendliModel(overrides: {
	id: string;
	name?: string;
	thinking?: ModelSpec<"openai-completions">["thinking"];
}): Model<"openai-completions"> {
	return buildModel({
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		api: "openai-completions",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		reasoning: true,
		thinking: overrides.thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	});
}

function friendliSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id: "my-custom-reasoning-model",
		name: "My Custom Reasoning Model",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8192,
		contextWindow: 131072,
		reasoning: true,
		...overrides,
	};
}

describe("Friendli model thinking resolution", () => {
	it("reports no thinking surface for a sparse non-GLM custom spec instead of fabricating a tier ladder", () => {
		// reasoning: true, no thinking block, non-GLM id: the effort surface
		// is unclassified. Previously deriveThinking fabricated the default
		// minimal..high ladder while omitReasoningEffort stripped the wire
		// field, so every tier emitted a byte-identical body.
		const compat = buildOpenAICompat(friendliSpec());
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);

		const model = createFriendliModel({ id: "my-custom-reasoning-model" });
		expect(model.thinking).toBeUndefined();
	});

	it("keeps the GLM-5.2 identity fallback ladder intact", () => {
		// GLM-5.2 without discovery data falls back to the identity-derived
		// high/max ladder — the sparse guard must not suppress it.
		const model = createFriendliModel({ id: "zai-org/GLM-5.2", name: "GLM-5.2" });
		expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});

	it("keeps a sparse GLM-4.5 toggle-only spec without fabricated tiers", () => {
		// GLM-4.5 has no declared ladder and no effort-capable identity: no
		// controllable surface, matching the endpoint's toggle-only dialect.
		const spec = friendliSpec({ id: "zai-org/GLM-4.5", name: "GLM-4.5" });
		expect(buildOpenAICompat(spec).supportsReasoningEffort).toBe(false);
		expect(createFriendliModel({ id: "zai-org/GLM-4.5", name: "GLM-4.5" }).thinking).toBeUndefined();
	});

	it("does not suppress discovered effort ladders", () => {
		// A discovered `thinking.efforts` ladder is the authoritative wire
		// signal — the sparse guard must never override it.
		const model = createFriendliModel({
			id: "qwen3.8-max-thinking",
			name: "Qwen3.8 Max Thinking",
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
		});
		expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});

	it("enables the Friendli effort surface for a discovered ladder on a non-GLM-5.2 id", () => {
		// The discovered `thinking.efforts` ladder from Friendli's
		// `/v1/models` metadata (authoritative regardless of model id) feeds
		// both the compat gate and the thinking ladder: a future Friendli
		// model that declares an effort ladder via discovery gets
		// `reasoning_effort` without a model-specific code change.
		const spec = friendliSpec({
			id: "zai-org/GLM-5.3",
			name: "GLM-5.3",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		});
		expect(buildOpenAICompat(spec).supportsReasoningEffort).toBe(true);
		const model = createFriendliModel({
			id: "zai-org/GLM-5.3",
			name: "GLM-5.3",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		});
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	it("falls through to the GLM-5.2+ identity fallback for an undiscovered GLM-5.3 id", () => {
		// No discovered ladder, so the identity fallback decides:
		// `isGlm52ReasoningEffortModelId` matches `>=5.2` by design and
		// `getModelDefinedEfforts` short-circuits GLM-5.3+ to the uniform
		// low/high/max ladder before the Friendli branch fires, so the
		// transport gate stays enabled while the ladder values remain
		// wire-exact for 5.3+.
		const spec = friendliSpec({ id: "zai-org/GLM-5.3", name: "GLM-5.3" });
		const model = createFriendliModel({ id: "zai-org/GLM-5.3", name: "GLM-5.3" });
		expect(buildOpenAICompat(spec).supportsReasoningEffort).toBe(true);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});
});
