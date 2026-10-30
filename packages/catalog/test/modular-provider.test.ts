import { describe, expect, test } from "bun:test";
import {
	applyChatCompletionsCompatPolicy,
	applyOpenAIExtraBody,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { defaultSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "@oh-my-pi/pi-catalog/types";

function buildModular(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "modular",
		baseUrl: "https://api.modular.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: null,
	});
}

/** The Chat Completions body omp sends for `id` with thinking at `effort`, or off. */
function requestBody(id: string, effort: Effort | "off"): Record<string, unknown> {
	const model = buildModular(id);
	const params: OpenAICompletionsParams = { model: id, messages: [], stream: true };
	const policy = resolveOpenAICompatPolicy(
		model,
		effort === "off"
			? { endpoint: "chat-completions", disableReasoning: true }
			: { endpoint: "chat-completions", reasoning: effort },
	);
	applyChatCompletionsCompatPolicy(params, policy);
	applyOpenAIExtraBody(params, policy.compat.extraBody);
	const { model: _model, messages: _messages, stream: _stream, ...reasoningFields } = params;
	return reasoningFields;
}

// Expected bodies are the ones measured against https://api.modular.com/v1.
describe("Modular reasoning request bodies", () => {
	test("MiniMax M3.1 Flash sends a nested effort and cannot turn reasoning off", () => {
		const id = "MiniMaxAI/MiniMax-M3.1-Flash";
		const model = buildModular(id);
		expect(requestBody(id, Effort.High)).toEqual({ reasoning: { effort: "high" } });
		// Off is clamped before encoding (stream.ts normalizeMandatoryReasoningOptions)
		// to the lowest supported effort, so the wire carries `effort: "low"`.
		expect(model.thinking?.requiresEffort).toBe(true);
		const floor = defaultSupportedEffort(model);
		expect(floor).toBe(Effort.Low);
		expect(requestBody(id, floor!)).toEqual({ reasoning: { effort: "low" } });
	});

	test("MiniMax M3 and Gemma 4 toggle reasoning.enabled with no leftover effort", () => {
		for (const id of ["minimax/minimax-m3", "google/gemma-4-31b-it"]) {
			expect(requestBody(id, Effort.High)).toEqual({ reasoning: { enabled: true } });
			expect(requestBody(id, "off")).toEqual({ reasoning: { enabled: false } });
		}
	});

	test("a model without its own rule, such as DeepSeek V4.1 Flash 1017, uses the provider's reasoning object", () => {
		const id = "deepseek/deepseek-v4.1-flash-1017";
		expect(requestBody(id, Effort.High)).toEqual({ reasoning: { effort: "high" } });
		expect(requestBody(id, "off")).toEqual({ reasoning: { enabled: false } });
	});
});
