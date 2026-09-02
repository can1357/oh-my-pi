import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { applyGlobalModelsDevFallback, rebakeBundledModel } from "../scripts/generate-models";
import type { ModelSpec } from "../src/types";

describe("provider-local model rebakes", () => {
	test("rederives stale serialized thinking metadata", () => {
		const rebaked = rebakeBundledModel({
			id: "claude-opus-4-5",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			thinking: { mode: "budget", efforts: [Effort.High] },
		});

		expect(rebaked.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	test("materializes newly derived thinking metadata", () => {
		const rebaked = rebakeBundledModel({
			id: "claude-opus-4-5",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});

		expect(rebaked.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	test("materializes a newly derived tokenizer", () => {
		const rebaked = rebakeBundledModel({
			id: "claude-opus-4-5",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});

		expect(rebaked.tokenizer).toBe("claude-v3");
	});
});

describe("global catalog fallbacks", () => {
	test("preserves live gateway reasoning and input metadata", () => {
		const liveGatewayModel: ModelSpec<"openai-completions"> = {
			id: "mistral-large-3",
			name: "Mistral Large 3",
			api: "openai-completions",
			provider: "eurouter",
			baseUrl: "https://api.eurouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
			catalogFallback: {
				liveInputModalities: true,
				liveReasoning: true,
			},
		};
		const globalReference: ModelSpec<"openai-completions"> = {
			...liveGatewayModel,
			provider: "stencil.so",
			reasoning: true,
			input: ["text", "image"],
			catalogFallback: undefined,
		};

		const [resolved] = applyGlobalModelsDevFallback([liveGatewayModel], [globalReference]);

		expect(resolved?.reasoning).toBe(false);
		expect(resolved?.input).toEqual(["text"]);
	});
});
