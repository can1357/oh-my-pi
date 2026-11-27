import { describe, expect, it } from "bun:test";
import type { ResponseCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsReasoningParams,
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

function localQwenModel(overrides: Partial<ModelSpec<"openai-completions">> = {}): Model<"openai-completions"> {
	const id = overrides.id ?? "qwen-3.6-27b";
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
		...overrides,
	} satisfies ModelSpec<"openai-completions">);
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

	it("routes local Qwen3.8 effort selections onto the chat template (llama.cpp qwen dialect)", () => {
		// Regression: the qwen dialects used to emit only `enable_thinking: true`,
		// so every effort selection ran at the template's xhigh default.
		const model = localQwenModel({ id: "qwen3.8-27b" });
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
		const model = localQwenModel({ id: "qwen3.8-27b", provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" });
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
		const model = localQwenModel({ id: "qwen3.8-27b", compat: { qwenTemplateReasoningEffort: false } });
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
		const model = localQwenModel();
		const params = chatParams();
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
		// Twin emission: top-level and kwargs, so llama.cpp / vLLM / SGLang /
		// Alibaba template shapes all preserve `<think>` for older assistants.
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});
});

describe("local chat-template history replay compat", () => {
	// Local chat-template servers (llama.cpp & co.) reuse the slot's KV cache
	// only when prior assistant turns re-render byte-identically, `<think>`
	// included. `replayReasoningContent` replays preserved thinking as
	// `reasoning_content`; `qwenPreserveThinking` pairs `enable_thinking` with
	// `preserve_thinking` so the Qwen3.6+ template keeps `<think>` for assistants
	// that a new user message shifted past `last_query_index`.
	it("auto-enables replayReasoningContent for LM Studio and vLLM thinking models", () => {
		// Their llama.cpp-style backends share the chat-template KV-cache reuse model.
		const lmStudio = localQwenModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }).compat;
		const vllm = localQwenModel({ provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" }).compat;
		expect(lmStudio.replayReasoningContent).toBe(true);
		expect(vllm.replayReasoningContent).toBe(true);
	});

	it("auto-enables replayReasoningContent for custom providers on loopback baseUrls", () => {
		// User-defined `provider: "custom"` pointed at a local sglang/Triton/etc.
		// inference server still benefits — KV-cache reuse is a property of the
		// server, not the provider id.
		const loopback = localQwenModel({ provider: "custom", baseUrl: "http://localhost:9000/v1" }).compat;
		const rfc1918 = localQwenModel({ provider: "custom", baseUrl: "http://10.0.0.42:8080/v1" }).compat;
		const mdns = localQwenModel({ provider: "custom", baseUrl: "http://workstation.local:8080/v1" }).compat;
		expect(loopback.replayReasoningContent).toBe(true);
		expect(rfc1918.replayReasoningContent).toBe(true);
		expect(mdns.replayReasoningContent).toBe(true);
	});

	it("honors an explicit replayReasoningContent override on a proxy provider", () => {
		// Escape hatch for a user who knows their LiteLLM deployment fronts a
		// llama.cpp-style backend that benefits from the replay.
		const optedIn = localQwenModel({
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			compat: { replayReasoningContent: true },
		}).compat;
		expect(optedIn.replayReasoningContent).toBe(true);
	});

	it("leaves replayReasoningContent off for cloud OpenAI-compatible providers", () => {
		// Hosts that don't reconstruct `<think>` from `reasoning_content` gain
		// nothing from the replay, and strict ones can 400 on the extra field.
		const openai = buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} satisfies ModelSpec<"openai-completions">).compat;
		expect(openai.replayReasoningContent).toBe(false);
	});

	it("auto-enables qwenPreserveThinking for the other built-in local providers + Qwen", () => {
		const lmStudio = localQwenModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }).compat;
		const vllm = localQwenModel({ provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" }).compat;
		const ollama = localQwenModel({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }).compat;
		expect(lmStudio.qwenPreserveThinking).toBe(true);
		expect(vllm.qwenPreserveThinking).toBe(true);
		expect(ollama.qwenPreserveThinking).toBe(true);
	});

	it("auto-enables qwenPreserveThinking for custom providers on loopback baseUrls + Qwen", () => {
		const loopback = localQwenModel({ provider: "custom", baseUrl: "http://localhost:9000/v1" }).compat;
		const rfc1918 = localQwenModel({ provider: "custom", baseUrl: "http://10.0.0.42:8080/v1" }).compat;
		expect(loopback.qwenPreserveThinking).toBe(true);
		expect(rfc1918.qwenPreserveThinking).toBe(true);
	});

	it("leaves qwenPreserveThinking off for non-Qwen models on local llama.cpp", () => {
		// Non-Qwen templates ignore the param either way, but auto-detection
		// gates on the Qwen thinking dialect so the wire body stays minimal.
		const deepseek = localQwenModel({ id: "deepseek-r1-32b", name: "DeepSeek R1 32B" }).compat;
		expect(deepseek.qwenPreserveThinking).toBe(false);
	});

	it("does NOT emit preserve_thinking for cloud Qwen + thinking", () => {
		const model = localQwenModel({
			provider: "alibaba",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: Effort.Medium });
		expect(params.enable_thinking).toBe(true);
		expect(params.preserve_thinking).toBeUndefined();
		// `chat_template_kwargs` stays unset — Alibaba's qwen dialect rides
		// only the top-level `enable_thinking`.
		expect(params.chat_template_kwargs).toBeUndefined();
	});

	it("emits preserve_thinking even when reasoning is disabled on local Qwen (history-only knob)", () => {
		// `preserve_thinking` controls how PRIOR assistant turns render in
		// the template, not whether THIS turn thinks. When the caller
		// disables reasoning (e.g. `/think off`), the slot still holds
		// `<think>...</think>` tokens from earlier thinking turns; strip
		// them in re-render and llama.cpp invalidates at the first
		// historic `<think>`. Keep the kwarg on for every Qwen + local
		// request the compat flag covers.
		const model = localQwenModel();
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { disableReasoning: true });
		expect(params.enable_thinking).toBe(false);
		expect(params.preserve_thinking).toBe(true);
		// Disable encoding rides the top-level `enable_thinking: false`
		// field for the `qwen` dialect; `chat_template_kwargs` only
		// carries the hoisted `preserve_thinking` mirror.
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("repairs discovered local Qwen with spec.reasoning=false via upgrade-neutral", () => {
		// `discoverOpenAICompatibleModels` stamps `reasoning: false` on
		// every model from a generic `/v1/models` endpoint, but the reviewed
		// `thinking-upgrade-neutral` policy repairs stale capability metadata
		// for the llama.cpp Qwen class: the built model reports reasoning
		// support with the reviewed effort ladder, so default requests behave
		// exactly like explicitly-declared thinking models.
		const compat = localQwenModel({ reasoning: false }).compat;
		expect(compat.qwenPreserveThinking).toBe(true);

		const model = localQwenModel({ reasoning: false });
		expect(model.reasoning).toBe(true);
		const params = chatParams();
		// No `reasoning` option — mirrors a default request against a
		// discovered model whose spec hardcodes `reasoning: false`.
		applyChatCompletionsReasoningParams(params, model, model.compat, undefined);
		// No effort requested, so the thinking-off default rides; the server
		// template default would think. `preserve_thinking` still rides so
		// HISTORY rendering keeps the `<think>` blocks intact.
		expect(params.enable_thinking).toBe(false);
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("emits preserve_thinking for discovered local Qwen even when caller passes disableReasoning", () => {
		// The explicit thinking-off toggle rides alongside the history knob so
		// the local slot keeps reusing the prefix from prior thinking-on turns.
		const model = localQwenModel({ reasoning: false });
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { disableReasoning: true });
		expect(params.enable_thinking).toBe(false);
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("omits top-level preserve_thinking for NVIDIA NIM Qwen (qwen-chat-template dialect)", () => {
		// NVIDIA NIM serves Qwen with the `qwen-chat-template` dialect:
		// `enable_thinking` and `preserve_thinking` both live under
		// `chat_template_kwargs` because NIM's request schema is
		// `additionalProperties: false` and rejects every unknown
		// top-level field (#2299). The spread-merge in the encoder still has
		// to keep both kwargs alongside one another rather than clobbering
		// `preserve_thinking`.
		const model = localQwenModel({
			provider: "nvidia",
			baseUrl: "http://localhost:8000/v1",
		});
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: Effort.Medium });
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
		// Top-level field MUST stay unset or NIM rejects the whole request.
		expect(params.preserve_thinking).toBeUndefined();
		expect(params.enable_thinking).toBeUndefined();
	});

	it("honors an explicit qwenPreserveThinking override on cloud Qwen", () => {
		// Escape hatch for power users who run a cloud-fronted llama.cpp /
		// vLLM and know the template benefits from the replay.
		const model = localQwenModel({
			provider: "alibaba",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			compat: { qwenPreserveThinking: true },
		});
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: Effort.Medium });
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("honors an explicit qwenPreserveThinking opt-out on local Qwen", () => {
		const model = localQwenModel({ compat: { qwenPreserveThinking: false } });
		expect(model.compat.qwenPreserveThinking).toBe(false);
		const params = chatParams();
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: Effort.Medium });
		expect(params.enable_thinking).toBe(true);
		expect(params.preserve_thinking).toBeUndefined();
	});
});
