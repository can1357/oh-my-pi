import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyCatalogMetrics, CatalogMetricsIndex } from "@oh-my-pi/pi-catalog/identity/metrics";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function model(provider: string, id: string, metrics?: { int?: number; tps?: number }): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...metrics,
	} as ModelSpec<Api>);
}

const scored = new CatalogMetricsIndex([
	model("anthropic", "claude-fable-5-1", { int: 65.7, tps: 66.2 }),
	model("anthropic", "claude-opus-4-1-20250805", { int: 50.2, tps: 40 }),
	model("anthropic", "claude-opus-4", { int: 44.1, tps: 42 }),
	model("openai", "gpt-5.6-sol", { int: 60.9, tps: 70.4 }),
	model("openai", "gpt-5.6-terra", { int: 56.6, tps: 97.7 }),
	model("openai", "gpt-5.5", { int: 56.3, tps: 79.4 }),
]);

describe("CatalogMetricsIndex", () => {
	test.each([
		["dot-spelled revision", "github-copilot", "claude-fable-5.1", 65.7],
		["bedrock region and vendor prefixes", "amazon-bedrock", "global.anthropic.claude-fable-5-1", 65.7],
		[
			"bedrock version suffix keeps the dated snapshot",
			"amazon-bedrock",
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			50.2,
		],
		["mantle vendor prefix with dotted revision", "bedrock-mantle", "openai.gpt-5.5", 56.3],
		["effort lane collapses to its base id", "cursor", "claude-fable-5-1-high", 65.7],
		["namespaced gateway id", "openrouter", "openai/gpt-5.6-terra", 56.6],
	])("resolves %s", (_label, provider, id, int) => {
		expect(scored.resolve(model(provider, id))?.int).toBe(int);
	});

	test("does not cross product lines that share a revision", () => {
		expect(scored.resolve(model("openai", "gpt-5.6-luna"))).toBeUndefined();
		expect(scored.resolve(model("openai", "gpt-5.5-pro"))).toBeUndefined();
	});

	test("does not strip a dated snapshot down to a sibling revision", () => {
		// `claude-opus-4-1-...` must never fall through to `claude-opus-4`.
		expect(scored.resolve(model("amazon-bedrock", "anthropic.claude-opus-4-1-20250805-v1:0"))?.int).toBe(50.2);
		expect(scored.resolve(model("anthropic", "claude-opus-4-1"))).toBeUndefined();
	});

	test("exact id wins over dialect matching and merges partial rows", () => {
		const index = new CatalogMetricsIndex([
			model("a", "gpt-5.5", { int: 10 }),
			model("b", "gpt-5.5", { tps: 20 }),
			model("c", "openai/gpt-5.5", { int: 99, tps: 99 }),
		]);
		expect(index.resolve(model("d", "GPT-5.5"))).toEqual({ int: 10, tps: 20 });
	});
});

describe("applyCatalogMetrics", () => {
	test("fills only unscored models and preserves array identity when nothing changes", () => {
		const already = model("openai", "gpt-5.5", { int: 1, tps: 2 });
		const unknown = model("ollama", "lfm2.5:2.6b");
		const untouched = [already, unknown];
		expect(applyCatalogMetrics(untouched, scored)).toBe(untouched);

		const filled = applyCatalogMetrics([already, model("openai-codex", "gpt-5.6-terra")], scored);
		expect(filled[0]).toBe(already);
		expect(filled[1].int).toBe(56.6);
		expect(filled[1].tps).toBe(97.7);
	});
});
