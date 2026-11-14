/**
 * Issue #18673 — regenerating the catalog marked reasoning models as non-reasoning.
 *
 * NanoGPT publishes a model's thinking route as a separate `<id>:thinking` row,
 * so its non-thinking base row carries `reasoning: false`. When that base row
 * has the largest limits it wins `createGlobalModelsDevReferenceMap`, and
 * `applyGlobalModelsDevFallback` copied `reasoning: false` onto same-id rows
 * from every other provider (NVIDIA, OpenRouter, Novita, …).
 *
 * Contract: a same-id row keeps its own `reasoning: true` when the winning
 * reference is a base row whose provider also lists a `:thinking` sibling.
 */
import { describe, expect, it } from "bun:test";
import { applyGlobalModelsDevFallback } from "../scripts/generate-models";
import type { Api, ModelSpec } from "../src/types";

function spec(
	provider: string,
	id: string,
	reasoning: boolean,
	contextWindow: number,
	maxTokens: number,
): ModelSpec<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

describe("models.dev reference selection with NanoGPT :thinking siblings (#18673)", () => {
	it("keeps a same-id row reasoning-capable when the reference base only loses to a :thinking sibling", () => {
		// NanoGPT's base row wins on limits; its `:thinking` sibling marks the
		// base as reasoning-capable, so NVIDIA's discovery value survives.
		const modelsDevModels = [
			spec("nanogpt", "qwen/qwen3.5-397b-a17b", false, 262_144, 65_536),
			spec("nanogpt", "qwen/qwen3.5-397b-a17b:thinking", true, 262_144, 65_536),
			spec("kilo", "qwen/qwen3.5-397b-a17b", true, 256_000, 64_000),
		];
		const liveModels = [spec("nvidia", "qwen/qwen3.5-397b-a17b", true, 262_144, 65_536)];

		const [row] = applyGlobalModelsDevFallback(liveModels, modelsDevModels);

		expect(row.reasoning).toBe(true);
	});

	it("recognizes leveled :thinking suffixes (:thinking:low) as siblings", () => {
		const modelsDevModels = [
			spec("nanogpt", "acme/model", false, 999_999, 65_536),
			spec("nanogpt", "acme/model:thinking:low", true, 999_999, 65_536),
		];
		const liveModels = [spec("nvidia", "acme/model", true, 999_999, 65_536)];

		const [row] = applyGlobalModelsDevFallback(liveModels, modelsDevModels);

		expect(row.reasoning).toBe(true);
	});

	it("does not let another provider's :thinking sibling promote the base", () => {
		const modelsDevModels = [
			spec("nanogpt", "acme/model", false, 999_999, 65_536),
			spec("other", "acme/model:thinking", true, 999_999, 65_536),
		];
		const liveModels = [spec("nvidia", "acme/model", true, 999_999, 65_536)];

		const [row] = applyGlobalModelsDevFallback(liveModels, modelsDevModels);

		expect(row.reasoning).toBe(false);
	});
});
