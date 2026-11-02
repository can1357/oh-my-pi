import { describe, expect, test } from "bun:test";
import {
	applyChatCompletionsCompatPolicy,
	applyOpenAIExtraBody,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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

// Every expected value below was measured against
// https://bharatcode.ai/api/model/v1/chat/completions and is asserted literally,
// so a drift in the ladder or the disable mode fails the test instead of
// silently changing the wire.
describe("BharatCode reasoning request bodies", () => {
	test("qwen-3.8-27b: off is the wire-only `none`, the advertised rungs pass through", () => {
		const id = "qwen-3.8-27b";
		// `none` is what actually stops this model thinking: it returns no
		// reasoning_content at all, while minimal and above still think.
		expect(requestBody(id, "off")).toEqual({ reasoning_effort: "none" });
		expect(requestBody(id, Effort.Low)).toEqual({ reasoning_effort: "low" });
		expect(requestBody(id, Effort.Medium)).toEqual({ reasoning_effort: "medium" });
		expect(requestBody(id, Effort.High)).toEqual({ reasoning_effort: "high" });
		expect(requestBody(id, Effort.XHigh)).toEqual({ reasoning_effort: "xhigh" });
	});

	test("deepseek-v4.1-flash: off is `none`, full ladder passes through", () => {
		const id = "deepseek-v4.1-flash";
		expect(requestBody(id, "off")).toEqual({ reasoning_effort: "none" });
		expect(requestBody(id, Effort.Minimal)).toEqual({ reasoning_effort: "minimal" });
		expect(requestBody(id, Effort.Low)).toEqual({ reasoning_effort: "low" });
		expect(requestBody(id, Effort.Medium)).toEqual({ reasoning_effort: "medium" });
		expect(requestBody(id, Effort.High)).toEqual({ reasoning_effort: "high" });
		expect(requestBody(id, Effort.XHigh)).toEqual({ reasoning_effort: "xhigh" });
	});
});
