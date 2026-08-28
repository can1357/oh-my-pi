import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelTokenizer } from "@oh-my-pi/pi-catalog/model-tokenizer";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("resolveModelTokenizer", () => {
	test("routes only tokenizer generations covered by embedded vocabularies", () => {
		expect(resolveModelTokenizer("anthropic/claude-opus-4-7")).toBe("claude-v47");
		expect(resolveModelTokenizer("claude-sonnet-5")).toBe("claude-v5-sonnet");
		expect(resolveModelTokenizer("Qwen/Qwen3.8-27B")).toBe("qwen3");
		expect(resolveModelTokenizer("qwen3-32b")).toBeUndefined();
		expect(resolveModelTokenizer("deepseek-chat")).toBe("deepseek-v3");
		expect(resolveModelTokenizer("deepseek-r1-0528")).toBe("deepseek-v3");
		expect(resolveModelTokenizer("deepseek-r1-distill-qwen-32b")).toBeUndefined();
		expect(resolveModelTokenizer("moonshotai/Kimi-K3")).toBe("kimi-k2");
		expect(resolveModelTokenizer("moonshot-v1-128k")).toBeUndefined();
		expect(resolveModelTokenizer("glm-5.2")).toBe("glm5");
		expect(resolveModelTokenizer("glm-4.7")).toBeUndefined();
	});
	test("buildModel materializes wire-model tokenizer policy and preserves explicit policy", () => {
		expect(buildModel(spec("deepseek-v4-pro")).tokenizer).toBe("deepseek-v3");
		expect(buildModel({ ...spec("alias"), requestModelId: "deepseek-v4-pro" }).tokenizer).toBe("deepseek-v3");
		expect(buildModel({ ...spec("deepseek-v4-pro"), tokenizer: "qwen3" }).tokenizer).toBe("qwen3");
	});
});
