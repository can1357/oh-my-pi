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

function buildBharatCode(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "bharatcode",
		baseUrl: "https://bharatcode.ai/api/model/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32000,
	});
}

/** The Chat Completions body omp sends for `id` with thinking at `effort`, or off. */
function requestBody(id: string, effort: Effort | "off"): Record<string, unknown> {
	const model = buildBharatCode(id);
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

// Expected bodies are the ones measured against https://bharatcode.ai/api/model/v1:
// the gateway takes the plain Chat Completions `reasoning_effort` field and
// answers with reasoning_content plus completion_tokens_details.reasoning_tokens.
describe("BharatCode reasoning request bodies", () => {
	test("thinking on sends reasoning_effort, and off encodes the floor rung", () => {
		for (const id of ["qwen-3.8-27b", "deepseek-v4.1-flash"]) {
			const model = buildBharatCode(id);
			expect(requestBody(id, Effort.High)).toEqual({ reasoning_effort: "high" });
			// The provider always speaks `reasoning_effort`, so "off" is encoded as the
			// lowest advertised rung rather than dropped from the body.
			const floor = defaultSupportedEffort(model);
			expect(requestBody(id, "off")).toEqual({ reasoning_effort: floor });
		}
	});
});
