import { describe, expect, it } from "bun:test";
import type { Api, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";
import { applyCanonicalLimitFallback } from "../scripts/generated-policies";

function spec(overrides: {
	id: string;
	provider: Provider;
	contextWindow: number | null;
	maxTokens: number | null;
	cost?: ModelSpec<"openai-completions">["cost"];
}): ModelSpec<"openai-completions"> {
	return {
		id: overrides.id,
		name: overrides.id,
		api: "openai-completions",
		provider: overrides.provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: overrides.cost ?? { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow,
		maxTokens: overrides.maxTokens,
	};
}

function find(models: ModelSpec<Api>[], provider: Provider, id: string): ModelSpec<Api> {
	const model = models.find(m => m.provider === provider && m.id === id);
	if (!model) throw new Error(`missing ${provider}/${id}`);
	return model;
}

describe("applyCanonicalLimitFallback", () => {
	it("fills a proxy's null maxTokens from the canonical first-party reference (gpt-5.4 family)", () => {
		const models: ModelSpec<Api>[] = [
			spec({ id: "gpt-5.4-mini", provider: "openai", contextWindow: 400000, maxTokens: 128000 }),
			// Venice's mangled id with a maxTokens hole; contextWindow is provider-supplied.
			spec({ id: "openai-gpt-54-mini", provider: "venice", contextWindow: 400000, maxTokens: null }),
		];

		applyCanonicalLimitFallback(models);

		const venice = find(models, "venice", "openai-gpt-54-mini");
		expect(venice.maxTokens).toBe(128000);
		// Provider-supplied contextWindow is left intact, not overwritten by the reference.
		expect(venice.contextWindow).toBe(400000);
	});

	it("fills both null limits when the proxy reports neither", () => {
		const models: ModelSpec<Api>[] = [
			spec({ id: "gpt-5.4-pro", provider: "openai", contextWindow: 1050000, maxTokens: 128000 }),
			spec({ id: "openai-gpt-54-pro", provider: "venice", contextWindow: null, maxTokens: null }),
		];

		applyCanonicalLimitFallback(models);

		const venice = find(models, "venice", "openai-gpt-54-pro");
		expect(venice.contextWindow).toBe(1050000);
		expect(venice.maxTokens).toBe(128000);
	});

	it("never sources limits from zero-cost xai-oauth subscription entries", () => {
		const models: ModelSpec<Api>[] = [
			// Inflated subscription entry: zero cost, oversized limits. Must be ignored.
			spec({
				id: "grok-4.3",
				provider: "xai-oauth",
				contextWindow: 2000000,
				maxTokens: 1000000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
			// Public paid entry: the legitimate reference.
			spec({ id: "grok-4.3", provider: "xai", contextWindow: 1000000, maxTokens: 30000 }),
			spec({ id: "x-ai/grok-4-3", provider: "aimlapi", contextWindow: null, maxTokens: null }),
		];

		applyCanonicalLimitFallback(models);

		const proxy = find(models, "aimlapi", "x-ai/grok-4-3");
		expect(proxy.maxTokens).toBe(30000);
		expect(proxy.contextWindow).toBe(1000000);
	});
	it("fills across org-namespace variance via the bare model segment", () => {
		const models: ModelSpec<Api>[] = [
			// Donor and hole share no exact id (alibaba/ vs qwen/ namespace) and no
			// compact-version relationship — only the `qwen3-32b` segment unifies them.
			spec({ id: "qwen/qwen3-32b", provider: "groq", contextWindow: 131072, maxTokens: 40960 }),
			spec({ id: "alibaba/qwen3-32b", provider: "aimlapi", contextWindow: null, maxTokens: null }),
		];

		applyCanonicalLimitFallback(models);

		const proxy = find(models, "aimlapi", "alibaba/qwen3-32b");
		expect(proxy.contextWindow).toBe(131072);
		expect(proxy.maxTokens).toBe(40960);
	});

	it("leaves holes null when no canonical-family reference exists", () => {
		const models: ModelSpec<Api>[] = [
			spec({ id: "some-bespoke-model-xyz", provider: "custom", contextWindow: null, maxTokens: null }),
		];

		applyCanonicalLimitFallback(models);

		const model = find(models, "custom", "some-bespoke-model-xyz");
		expect(model.contextWindow).toBeNull();
		expect(model.maxTokens).toBeNull();
	});
});
