import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import type { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import {
	mergeSubagentModelAliases,
	resolveSubagentModelAlias,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/subagent-model-aliases";

function makeModel(provider: string, id: string, name: string): Model<Api> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function makeRegistry(models: Model<Api>[]): ModelRegistry {
	return {
		getAvailable: () => models,
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	} as unknown as ModelRegistry;
}

const registry = makeRegistry([
	makeModel("minimax-code", "MiniMax-M3", "MiniMax M3"),
	makeModel("openai", "gpt-4o", "GPT-4o"),
]);

describe("resolveSubagentModelAlias", () => {
	test("resolves an exact alias match", () => {
		const resolved = resolveSubagentModelAlias(
			"minimax-code",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBe("minimax-code/MiniMax-M3");
	});

	test("resolves aliases case-insensitively", () => {
		const resolved = resolveSubagentModelAlias(
			"MINIMAX-CODE",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBe("minimax-code/MiniMax-M3");
	});

	test("resolves aliases without distinguishing spaces and hyphens", () => {
		const resolved = resolveSubagentModelAlias("minimax m3", { "minimax-m3": "minimax-code/MiniMax-M3" }, registry);
		expect(resolved).toBe("minimax-code/MiniMax-M3");
	});

	test("falls back to model resolver when no alias matches", () => {
		const resolved = resolveSubagentModelAlias(
			"openai/gpt-4o",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBe("openai/gpt-4o");
	});

	test("returns null when neither alias nor model resolver matches", () => {
		const resolved = resolveSubagentModelAlias(
			"unknown-model",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBeNull();
	});

	test("resolves browser-fast from built-in aliases when 9router MiniMax M3 is available", () => {
		const customRegistry = makeRegistry([
			makeModel("9router", "minimax/MiniMax-M3", "9Router MiniMax M3 Direct"),
			makeModel("9router", "minimax-m3-rr", "9Router MiniMax M3 RR"),
		]);
		const aliases = mergeSubagentModelAliases({});
		const resolved = resolveSubagentModelAlias("browser-fast", aliases, customRegistry);
		expect(resolved).toBe("9router/minimax/MiniMax-M3");
	});

	test("preserves thinking suffixes through alias resolution", () => {
		const resolved = resolveSubagentModelAlias(
			"minimax-code:high",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBe("minimax-code/MiniMax-M3:high");
	});

	test("preserves thinking suffixes for case-insensitive alias matches", () => {
		const resolved = resolveSubagentModelAlias(
			"MINIMAX-CODE:medium",
			{ "minimax-code": "minimax-code/MiniMax-M3" },
			registry,
		);
		expect(resolved).toBe("minimax-code/MiniMax-M3:medium");
	});
});
