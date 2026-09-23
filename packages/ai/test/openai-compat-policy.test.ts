import { describe, expect, it } from "bun:test";
import type { ResponseCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	applyChatCompletionsCompatPolicy,
	applyOpenAIExtraBody,
	applyResponsesCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function chatModel(compat: OpenAICompat): Model<"openai-completions"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-completions">);
}

function responsesModel(compat: OpenAICompat): Model<"openai-responses"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-responses">);
}

function chatParams(): OpenAICompletionsParams {
	return { model: "compat-reasoner", messages: [], stream: true };
}

function responsesParams(): ResponseCreateParamsStreaming {
	return { model: "compat-reasoner", input: [], stream: true };
}

describe("OpenAI compat policy", () => {
	it("suppresses reasoning on forced tool choice for both endpoints", () => {
		const compat: OpenAICompat = {
			disableReasoningOnForcedToolChoice: true,
			thinkingFormat: "openrouter",
			reasoningDisableMode: "openrouter-enabled-false",
		};
		const toolChoice = { type: "function", name: "search" };
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), {
			endpoint: "chat-completions",
			reasoning: Effort.High,
			toolChoice,
		});
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), {
			endpoint: "responses",
			reasoning: Effort.High,
			toolChoice,
		});

		expect(chatPolicy.reasoning.enabled).toBe(false);
		expect(responsesPolicy.reasoning.enabled).toBe(false);
		expect(chatPolicy.reasoning.disableReason).toBe("forced-tool-choice");
		expect(responsesPolicy.reasoning.disableReason).toBe("forced-tool-choice");
	});

	it("encodes OpenRouter disabled reasoning through both wire adapters", () => {
		const compat: OpenAICompat = {
			thinkingFormat: "openrouter",
			reasoningDisableMode: "openrouter-enabled-false",
		};
		const chatBody = chatParams();
		const responseBody = responsesParams();

		applyChatCompletionsCompatPolicy(
			chatBody,
			resolveOpenAICompatPolicy(chatModel(compat), {
				endpoint: "chat-completions",
				disableReasoning: true,
			}),
		);
		applyResponsesCompatPolicy(
			responseBody,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses", disableReasoning: true }),
			undefined,
		);

		expect(chatBody.reasoning).toEqual({ enabled: false });
		expect(responseBody.reasoning as unknown).toEqual({ enabled: false });
	});

	it("omits effort for both wire adapters from one catalog flag", () => {
		const compat: OpenAICompat = { omitReasoningEffort: true };
		const chatBody = chatParams();
		const responseBody = responsesParams();

		applyChatCompletionsCompatPolicy(
			chatBody,
			resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		applyResponsesCompatPolicy(
			responseBody,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses", reasoning: Effort.High }),
			undefined,
		);

		expect(chatBody.reasoning_effort).toBeUndefined();
		expect(responseBody.reasoning).toBeUndefined();
	});

	it("leaves Responses input unchanged when reasoning is not requested", () => {
		const responseBody = responsesParams();

		applyResponsesCompatPolicy(
			responseBody,
			resolveOpenAICompatPolicy(responsesModel({}), { endpoint: "responses" }),
			undefined,
		);

		expect(responseBody.reasoning).toBeUndefined();
		expect(responseBody.input).toEqual([]);
	});

	it("exposes reasoning replay constraints independent of endpoint", () => {
		const compat: OpenAICompat = {
			requiresReasoningContentForToolCalls: true,
			requiresReasoningContentForAllAssistantTurns: true,
			allowsSyntheticReasoningContentForToolCalls: false,
			reasoningContentField: "reasoning_content",
		};
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions" });
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses" });

		expect(chatPolicy.reasoning.requiresReasoningContentForToolCalls).toBe(true);
		expect(responsesPolicy.reasoning.requiresReasoningContentForToolCalls).toBe(true);
		expect(chatPolicy.reasoning.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(responsesPolicy.reasoning.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(chatPolicy.reasoning.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(responsesPolicy.reasoning.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("exposes tool id and cumulative reasoning stream constraints for both endpoints", () => {
		const compat: OpenAICompat = { requiresMistralToolIds: true, reasoningDeltasMayBeCumulative: true };
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions" });
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses" });

		expect(chatPolicy.tools.toolCallIdKind).toBe("mistral-9-alnum");
		expect(responsesPolicy.tools.toolCallIdKind).toBe("mistral-9-alnum");
		expect(chatPolicy.stream.reasoningDeltasMayBeCumulative).toBe(true);
		expect(responsesPolicy.stream.reasoningDeltasMayBeCumulative).toBe(true);
	});

	it("routes Token Plan qwen3.8-max effort selections onto the wire", () => {
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.8-max");
		for (const effort of [Effort.Low, Effort.Medium, Effort.XHigh]) {
			const params = chatParams();
			const policy = resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: effort });
			applyChatCompletionsCompatPolicy(params, policy);
			applyOpenAIExtraBody(params, policy.compat.extraBody);
			expect(params.reasoning_effort).toBe(effort);
			expect(params.enable_thinking).toBe(true);
			expect(params.chat_template_kwargs).toBeUndefined();
		}

		const disabledParams = chatParams();
		const disabledPolicy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		applyChatCompletionsCompatPolicy(disabledParams, disabledPolicy);
		applyOpenAIExtraBody(disabledParams, disabledPolicy.compat.extraBody);
		expect(disabledParams.reasoning_effort).toBeUndefined();
		expect(disabledParams.enable_thinking).toBe(false);
	});

	it("keeps Token Plan qwen3.8-max-preview on the enable_thinking dialect", () => {
		// The preview rides Alibaba's binary enable_thinking toggle, not the
		// OpenAI reasoning_effort control, so effort selections must not leak an
		// unsupported reasoning_effort onto the wire.
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.8-max-preview");
		const params = chatParams();
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
	});

	function localQwenModel(
		id: string,
		provider: string,
		baseUrl: string,
		compat?: OpenAICompat,
	): Model<"openai-completions"> {
		return buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
			compat,
		} satisfies ModelSpec<"openai-completions">);
	}

	it("routes local Qwen3.8 effort selections onto the chat template (llama.cpp qwen dialect)", () => {
		// Regression: the qwen dialects used to emit only `enable_thinking: true`,
		// so every effort selection ran at the template's xhigh default.
		const model = localQwenModel("qwen3.8-27b", "llama.cpp", "http://127.0.0.1:8080/v1");
		for (const effort of [Effort.Low, Effort.Medium, Effort.XHigh]) {
			const params = chatParams();
			applyChatCompletionsCompatPolicy(
				params,
				resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: effort }),
			);
			// Twin emission: top-level for newer llama.cpp builds, kwargs for
			// older builds — and the preserve_thinking kwarg must survive.
			expect(params.enable_thinking).toBe(true);
			expect(params.reasoning_effort).toBe(effort);
			expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, reasoning_effort: effort });
			expect(params.preserve_thinking).toBe(true);
		}
	});

	it("routes local Qwen3.8 effort selections via chat_template_kwargs only on vLLM", () => {
		// vLLM's renderer reads chat_template_kwargs; NIM-style schemas reject
		// unknown top-level fields, so nothing may ride top-level here.
		const model = localQwenModel("qwen3.8-27b", "vllm", "http://127.0.0.1:8000/v1");
		const params = chatParams();
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.Medium }),
		);
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.chat_template_kwargs).toEqual({
			preserve_thinking: true,
			enable_thinking: true,
			reasoning_effort: Effort.Medium,
		});
	});

	it("honors a user compat override disabling the template effort dialect", () => {
		// Escape hatch for strict local servers (Ninfer-style) that reject
		// unknown chat_template_kwargs: `qwenTemplateReasoningEffort: false` in
		// models.yml must suppress the kwarg and revert to the pre-effort wire
		// shape without disturbing thinking or preserve_thinking.
		const model = localQwenModel("qwen3.8-27b", "llama.cpp", "http://127.0.0.1:8080/v1", {
			qwenTemplateReasoningEffort: false,
		});
		const params = chatParams();
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.Medium }),
		);
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("keeps pre-3.8 local Qwen on the bare enable_thinking toggle", () => {
		// Qwen 3.6 templates have no reasoning_effort kwarg; leaking one would
		// inject an undefined template variable for zero benefit.
		const model = localQwenModel("qwen-3.6-27b", "llama.cpp", "http://127.0.0.1:8080/v1");
		const params = chatParams();
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});
});
