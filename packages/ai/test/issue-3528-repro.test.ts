/**
 * Regression guard for llama.cpp warm-prefix invalidation on auto-learn
 * capture-at-stop and any other assistant continuation (#3528).
 *
 * `omp-llm-request-15179edfab4dc557.json` plus the rr-session captures from the
 * reporter showed:
 *
 *  - System prompt and tool catalogue were byte-stable across requests 3–12.
 *  - Requests 4–11 fully reused the prefix (`cached_tokens` grew from ~36K to
 *    ~38K).
 *  - Request 12 — auto-learn capture-at-stop — added the prior assistant turn
 *    plus the synthetic user nudge, and `cached_tokens` collapsed to 0. Full
 *    prompt re-processing on llama.cpp.
 *
 * The prior assistant turn had streamed `reasoning_content` deltas (Qwen3
 * thinking output). The OMP-side `Context` preserved those as a
 * `{ type: "thinking", thinkingSignature: "reasoning_content" }` block on the
 * assistant message, but `convertMessages` dropped the field when re-serializing
 * for the next request because the llama.cpp compat profile carried none of the
 * existing `requires*ReasoningContent*` / `thinkingFormat === "zai"` flags.
 * Llama.cpp's chat template then re-rendered the assistant turn without
 * `<think>…</think>`, diverging from the slot's existing KV cache and forcing
 * full re-prefill.
 *
 * Two layered fixes ship under this file:
 *   1. `replayReasoningContent` (#3528) — auto-enabled for the four built-in
 *      local OpenAI-compatible providers and any provider pointed at a
 *      loopback / RFC1918 baseUrl, paired with a fourth branch in the
 *      `openai-completions` assistant encoder that surfaces preserved thinking
 *      as `reasoning_content` on every reasoning-engaged turn.
 *   2. `qwenPreserveThinking` (#3541) — pairs `enable_thinking: true` with
 *      `preserve_thinking: true` (both top-level AND under
 *      `chat_template_kwargs`) so the Qwen3.6+ chat template renders
 *      `<think>...</think>` for older assistant turns too. Without that flag
 *      the template strips think the moment a new user message (e.g. the
 *      auto-learn nudge) shifts prior assistants past `last_query_index`,
 *      and the next-turn re-render diverges from the slot's cached
 *      generation tokens — the exact symptom logged in #3541.
 *
 * This file pins the wire output across the relevant axes.
 */
import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyChatCompletionsReasoningParams,
	type OpenAICompletionsParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Message, Model, ModelSpec, ThinkingContent, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
	for (const message of messages) {
		if (isPlainObject(message) && message.role === "assistant") return message;
	}
	return undefined;
}

function llamaCppQwenModel(overrides?: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	// Mirrors the reporter's `qwen-27-mtp-vision-offload` setup: local
	// llama.cpp baseUrl, Qwen-family id, reasoning enabled. Per detectCompat
	// this resolves to `thinkingFormat: "qwen"`, none of the `requires*` flags,
	// and (with this fix) `replayReasoningContent: true`.
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		...overrides,
	} satisfies ModelSpec<"openai-completions">);
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantWithReasoning(reasoning: string, answer: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "llama.cpp",
		model: "qwen-3.6-27b",
		content: [
			{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning_content" } satisfies ThinkingContent,
			{ type: "text", text: answer },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("llama.cpp warm-prefix preservation (#3528)", () => {
	it("auto-enables replayReasoningContent for llama.cpp thinking models", () => {
		const compat = llamaCppQwenModel().compat;
		expect(compat.replayReasoningContent).toBe(true);
	});

	it("auto-enables replayReasoningContent for LM Studio and vLLM thinking models", () => {
		// Same `replayReasoningContent` semantics extend to the other built-in
		// local OpenAI-compatible providers — their llama.cpp-style backends
		// share the chat-template KV-cache reuse model.
		const lmStudio = llamaCppQwenModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }).compat;
		const vllm = llamaCppQwenModel({ provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" }).compat;
		expect(lmStudio.replayReasoningContent).toBe(true);
		expect(vllm.replayReasoningContent).toBe(true);
	});

	it("auto-enables replayReasoningContent for custom providers on loopback baseUrls", () => {
		// User-defined `provider: "custom"` pointed at a local sglang/Triton/etc.
		// inference server still benefits — KV-cache reuse is a property of the
		// server, not the provider id.
		const loopback = llamaCppQwenModel({ provider: "custom", baseUrl: "http://localhost:9000/v1" }).compat;
		const rfc1918 = llamaCppQwenModel({ provider: "custom", baseUrl: "http://10.0.0.42:8080/v1" }).compat;
		const mdns = llamaCppQwenModel({ provider: "custom", baseUrl: "http://workstation.local:8080/v1" }).compat;
		expect(loopback.replayReasoningContent).toBe(true);
		expect(rfc1918.replayReasoningContent).toBe(true);
		expect(mdns.replayReasoningContent).toBe(true);
	});

	it("leaves replayReasoningContent off for LiteLLM (local proxy, not a chat-template renderer)", () => {
		// LiteLLM defaults to http://localhost:4000/v1 but forwards every turn
		// to an unrelated upstream (OpenAI, Anthropic, …). Replaying
		// reasoning_content gains no KV-cache benefit and can 400 the upstream
		// on extra message fields, so the auto-detection MUST exclude proxy
		// providers from both the provider allow-list and the loopback
		// heuristic. Users running a custom proxy who do want the replay can
		// opt in via `compat.replayReasoningContent: true`.
		const defaults = llamaCppQwenModel({ provider: "litellm", baseUrl: "http://localhost:4000/v1" }).compat;
		const customLoopback = llamaCppQwenModel({ provider: "litellm", baseUrl: "http://127.0.0.1:9000/v1" }).compat;
		expect(defaults.replayReasoningContent).toBe(false);
		expect(customLoopback.replayReasoningContent).toBe(false);
	});

	it("honors an explicit replayReasoningContent override on a proxy provider", () => {
		// Escape hatch for a user who knows their LiteLLM deployment fronts a
		// llama.cpp-style backend that benefits from the replay.
		const optedIn = llamaCppQwenModel({
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			compat: { replayReasoningContent: true },
		}).compat;
		expect(optedIn.replayReasoningContent).toBe(true);
	});

	it("still auto-enables replayReasoningContent when spec.reasoning is false on local hosts", () => {
		// Runtime discovery for llama.cpp / lm-studio / openai-models-list
		// hardcodes `reasoning: false` because the upstream `/models` endpoints
		// don't advertise the capability — but the stream parser still records
		// any incoming `reasoning_content` deltas as thinking blocks. Gating
		// the flag on `spec.reasoning` would leave every discovered local Qwen
		// model reproducing #3528. The encoder's own
		// `nonEmptyThinkingBlocks.length > 0` guard makes the flag a no-op on
		// pure-text histories, so it's safe to enable unconditionally.
		const compat = llamaCppQwenModel({ reasoning: false }).compat;
		expect(compat.replayReasoningContent).toBe(true);
	});

	it("leaves replayReasoningContent off for cloud OpenAI-compatible providers", () => {
		// A regression that flipped this on for every reasoning provider would
		// pessimize wire payloads on hosts that don't reconstruct `<think>` from
		// `reasoning_content` and could even 400 on strict ones.
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

	it("replays reasoning_content on plain-text assistant turns for llama.cpp (no tool calls)", () => {
		// The reporter's request 12 had finish_reason=stop, no tool calls, just
		// text. The auto-learn nudge then arrived as the next user turn. Existing
		// `requires*ReasoningContent*` recovery paths gate on tool calls, so this
		// pin guards the new branch specifically: thinking blocks on a pure-text
		// assistant turn must still ride as `reasoning_content` for llama.cpp.
		const target = llamaCppQwenModel();
		const messages: Message[] = [
			userMessage("Review the unpushed commit."),
			assistantWithReasoning(
				"Let me review the unpushed changes comprehensively.",
				"## Review: 1 unpushed commit + 1 unstaged change",
			),
			userMessage("Before you finish: if this turn produced anything reusable, capture it now."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.content).toBe("## Review: 1 unpushed commit + 1 unstaged change");
		expect(assistant.reasoning_content).toBe("Let me review the unpushed changes comprehensively.");
	});

	it("replays reasoning_content for discovered local models that omit spec.reasoning", () => {
		// Mirrors the discovery setup: `discoverLlamaCppModels` builds specs
		// with `reasoning: false` regardless of the actual model behaviour.
		// When the model emits reasoning at runtime the stream parser still
		// records it as a thinking block; the encoder MUST replay it as
		// `reasoning_content` so llama.cpp's KV cache survives the next turn.
		const target = llamaCppQwenModel({ reasoning: false });
		const messages: Message[] = [
			userMessage("Plan a refactor."),
			assistantWithReasoning(
				"Trace the call graph through service.ts and the registry.",
				"Step 1: extract the loader. Step 2: rewire the factory.",
			),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");
		expect(assistant.reasoning_content).toBe("Trace the call graph through service.ts and the registry.");
	});

	it("demotes cross-API thinking into a discovered local target", () => {
		// `replayReasoningContent` is a same-wire cache concern. It keeps
		// llama.cpp turns cache-stable when the prior assistant already emitted an
		// OpenAI-compatible reasoning field, but it must not preserve foreign
		// Anthropic reasoning as native semantic context.
		const target = llamaCppQwenModel({ reasoning: false });
		const anthropicSourceTurn: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [
				{
					type: "thinking",
					thinking: "Cross-vendor reasoning chain that must survive the switch.",
					thinkingSignature: "EvAnthropicOpaqueContinuationBlob==",
				} satisfies ThinkingContent,
				{ type: "text", text: "Switched-in answer." },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{
				messages: [
					userMessage("Plan the migration."),
					anthropicSourceTurn,
					userMessage("Continue on the local box."),
				],
			},
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.content).toBe(
			`${renderDemotedThinking(target.id, "Cross-vendor reasoning chain that must survive the switch.")}\nSwitched-in answer.`,
		);
		expect("EvAnthropicOpaqueContinuationBlob==" in (found ?? {})).toBe(false);
	});

	it("honors the streamed signature when it identifies a recognized wire field", () => {
		// Some llama.cpp builds stream reasoning under `reasoning` rather than
		// `reasoning_content`. Round-trip into the same field so the chat
		// template sees the exact key the server emitted.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [
				{ type: "thinking", thinking: "trace A", thinkingSignature: "reasoning" } satisfies ThinkingContent,
				{ type: "text", text: "answer A" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning).toBe("trace A");
		expect(found?.reasoning_content).toBeUndefined();
	});

	it("falls back to reasoningContentField for opaque thinking signatures", () => {
		// Anthropic/OpenAI-Responses thinking blocks ride a binary continuation
		// signature that is meaningless as a chat-completions field name. Use
		// the configured `reasoningContentField` (default `reasoning_content`)
		// rather than synthesizing a key from the opaque signature.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [
				{
					type: "thinking",
					thinking: "trace B",
					thinkingSignature: "rs_0123456789abcdef",
				} satisfies ThinkingContent,
				{ type: "text", text: "answer B" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning_content).toBe("trace B");
		expect("rs_0123456789abcdef" in (found ?? {})).toBe(false);
	});

	it("does NOT replay reasoning_content when the target has no reasoning blocks", () => {
		// Pure-text turn with no thinking content stays minimal — the
		// replay branch only fires when there is actually something to preserve.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [{ type: "text", text: "plain answer" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.content).toBe("plain answer");
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.reasoning).toBeUndefined();
	});

	it("auto-enables qwenPreserveThinking for llama.cpp + Qwen", () => {
		// Pair to `replayReasoningContent`: without it the Qwen3.6+ template
		// strips `<think>...</think>` from older assistant turns the moment a
		// new user message (or auto-learn nudge) shifts them past
		// `last_query_index`, and the re-render diverges from the slot's KV
		// cache state.
		const compat = llamaCppQwenModel().compat;
		expect(compat.qwenPreserveThinking).toBe(true);
	});

	it("auto-enables qwenPreserveThinking for the other built-in local providers + Qwen", () => {
		const lmStudio = llamaCppQwenModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }).compat;
		const vllm = llamaCppQwenModel({ provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" }).compat;
		const ollama = llamaCppQwenModel({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }).compat;
		expect(lmStudio.qwenPreserveThinking).toBe(true);
		expect(vllm.qwenPreserveThinking).toBe(true);
		expect(ollama.qwenPreserveThinking).toBe(true);
	});

	it("auto-enables qwenPreserveThinking for custom providers on loopback baseUrls + Qwen", () => {
		const loopback = llamaCppQwenModel({ provider: "custom", baseUrl: "http://localhost:9000/v1" }).compat;
		const rfc1918 = llamaCppQwenModel({ provider: "custom", baseUrl: "http://10.0.0.42:8080/v1" }).compat;
		expect(loopback.qwenPreserveThinking).toBe(true);
		expect(rfc1918.qwenPreserveThinking).toBe(true);
	});

	it("leaves qwenPreserveThinking off for non-Qwen models on local llama.cpp", () => {
		// Non-Qwen templates ignore the param either way, but auto-detection
		// gates on the Qwen thinking dialect so the wire body stays minimal.
		const deepseek = llamaCppQwenModel({ id: "deepseek-r1-32b", name: "DeepSeek R1 32B" }).compat;
		expect(deepseek.qwenPreserveThinking).toBe(false);
	});

	it("leaves qwenPreserveThinking off for cloud Qwen hosts", () => {
		// Alibaba's Dashscope and Qwen Portal own the slot lifecycle on the
		// cloud side; OMP isn't responsible for KV-cache invalidation there,
		// and `preserve_thinking` is opt-in per the Alibaba docs. Stay
		// minimal on the wire unless the user opts in via `compat`.
		const dashscope = llamaCppQwenModel({
			provider: "alibaba",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		}).compat;
		expect(dashscope.qwenPreserveThinking).toBe(false);
	});

	it("emits preserve_thinking on the wire for local Qwen + thinking", () => {
		// End-to-end pin for the user's reported setup (#3541):
		// `enable_thinking: true` + `preserve_thinking: true` (twin top-level
		// + chat_template_kwargs) must both ride the body so the chat template
		// preserves `<think>...</think>` for older assistants. The twin
		// emission covers llama.cpp / vLLM / SGLang / Alibaba shapes without
		// per-host sniffing.
		const model = llamaCppQwenModel();
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: "medium" });
		expect(params.enable_thinking).toBe(true);
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("does NOT emit preserve_thinking for cloud Qwen + thinking", () => {
		const model = llamaCppQwenModel({
			provider: "alibaba",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: "medium" });
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
		const model = llamaCppQwenModel();
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { disableReasoning: true });
		expect(params.enable_thinking).toBe(false);
		expect(params.preserve_thinking).toBe(true);
		// Disable encoding rides the top-level `enable_thinking: false`
		// field for the `qwen` dialect; `chat_template_kwargs` only
		// carries the hoisted `preserve_thinking` mirror.
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("emits preserve_thinking for discovered local Qwen with spec.reasoning=false", () => {
		// `discoverOpenAICompatibleModels` stamps `reasoning: false` on
		// every model from a generic `/v1/models` endpoint, but Qwen3.6+
		// servers still emit `reasoning_content` deltas at runtime — captured
		// by the encoder's `replayReasoningContent` branch. Without
		// `preserve_thinking: true` on the request, the template strips
		// `<think>...</think>` from older assistants the moment a new user
		// message lands, and the local slot's KV cache invalidates on every
		// turn for the discovered-model variant. The emission must NOT be
		// gated on `reasoning.enabled` (which requires `model.reasoning`)
		// — same gotcha that #3532 fixed for `replayReasoningContent`.
		const compat = llamaCppQwenModel({ reasoning: false }).compat;
		expect(compat.qwenPreserveThinking).toBe(true);

		const model = llamaCppQwenModel({ reasoning: false });
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		// No `reasoning` option — mirrors a default request against a
		// discovered model whose spec hardcodes `reasoning: false`.
		applyChatCompletionsReasoningParams(params, model, model.compat, undefined);
		// Qwen's `enable_thinking` is unset here (model.reasoning false
		// short-circuits the reasoning encoder), so the server falls back
		// to its template default. `preserve_thinking` still rides so
		// HISTORY rendering keeps the `<think>` blocks intact.
		expect(params.enable_thinking).toBeUndefined();
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("emits preserve_thinking for discovered local Qwen even when caller passes disableReasoning", () => {
		// Same discovered-model case, but the caller also asks to disable
		// thinking. Neither branch of `resolveOpenAICompatPolicy` would
		// fire the reasoning encoder (model.reasoning false → both `enabled`
		// and `disabled` resolve false), yet `preserve_thinking` must still
		// ship so the local slot keeps reusing the prefix from prior
		// thinking-on turns.
		const model = llamaCppQwenModel({ reasoning: false });
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { disableReasoning: true });
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("omits top-level preserve_thinking for NVIDIA NIM Qwen (qwen-chat-template dialect)", () => {
		// NVIDIA NIM serves Qwen with the `qwen-chat-template` dialect:
		// `enable_thinking` and `preserve_thinking` both live under
		// `chat_template_kwargs` because NIM's request schema is
		// `additionalProperties: false` and rejects every unknown
		// top-level field (#2299 — same reason the catalog already
		// route-splits `enable_thinking` for this dialect). The
		// spread-merge in the encoder still has to keep both kwargs
		// alongside one another rather than clobbering `preserve_thinking`.
		const model = llamaCppQwenModel({
			provider: "nvidia",
			baseUrl: "http://localhost:8000/v1",
		});
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: "medium" });
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
		// Top-level field MUST stay unset or NIM rejects the whole request.
		expect(params.preserve_thinking).toBeUndefined();
		expect(params.enable_thinking).toBeUndefined();
	});

	it("honors an explicit qwenPreserveThinking override on cloud Qwen", () => {
		// Escape hatch for power users who run a cloud-fronted llama.cpp /
		// vLLM and know the template benefits from the replay.
		const model = llamaCppQwenModel({
			provider: "alibaba",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			compat: { qwenPreserveThinking: true },
		});
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: "medium" });
		expect(params.preserve_thinking).toBe(true);
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("honors an explicit qwenPreserveThinking opt-out on local Qwen", () => {
		const model = llamaCppQwenModel({ compat: { qwenPreserveThinking: false } });
		expect(model.compat.qwenPreserveThinking).toBe(false);
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsReasoningParams(params, model, model.compat, { reasoning: "medium" });
		expect(params.enable_thinking).toBe(true);
		expect(params.preserve_thinking).toBeUndefined();
	});
});
