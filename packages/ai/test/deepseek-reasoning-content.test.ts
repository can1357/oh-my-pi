import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Model, ModelSpec, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

interface OpenAICompletionAssistantWireMessage {
	role: "assistant";
	content?: unknown;
	reasoning_content?: unknown;
	rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c?: unknown;
}

function isOpenAICompletionAssistantWireMessage(message: unknown): message is OpenAICompletionAssistantWireMessage {
	if (typeof message !== "object" || message === null) return false;
	return (message as { role?: unknown }).role === "assistant";
}

function findOpenAICompletionAssistantWireMessage(
	messages: readonly unknown[] | undefined,
): OpenAICompletionAssistantWireMessage | undefined {
	return messages?.find(isOpenAICompletionAssistantWireMessage);
}

function deepseekModel(overrides: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		reasoning: true,
		compat: base.compatConfig,
		...overrides,
	} as ModelSpec<"openai-completions">);
}

function assistantToolCall(
	model: Model<"openai-completions">,
	content?: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content: content ?? [
			{
				type: "toolCall",
				id: "call_test_1",
				name: "read",
				arguments: { path: "/tmp/test" },
			},
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("DeepSeek reasoning_content tool-call replay", () => {
	// ----------------------------------------------------------------
	// Fix 1: honest wire-exact ladders for DeepSeek-family on any provider —
	// V4 Flash and Pro expose [low, high, max] (#7668, #8405).
	// ----------------------------------------------------------------
	describe("thinking ladder (Fix 1)", () => {
		it("bakes the honest [low, high, max] flash ladder with no effortMap on opencode-go", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.effortMap).toBeUndefined();
		});

		it("bakes the honest [low, high, max] flash ladder with no effortMap on NVIDIA", () => {
			const model = deepseekModel({
				provider: "nvidia",
				baseUrl: "https://integrate.api.nvidia.com/v1",
				id: "deepseek-ai/deepseek-v4-flash",
			});
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.effortMap).toBeUndefined();
		});

		it("bakes the honest [low, high, max] ladder with no effortMap on the official endpoint", () => {
			const model = deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			});
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.effortMap).toBeUndefined();
		});

		it("does NOT map xhigh for non-DeepSeek models", () => {
			const model = deepseekModel({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				id: "gpt-4o-mini",
				reasoning: false,
			});
			expect(model.thinking?.effortMap?.xhigh).toBeUndefined();
		});
	});

	// ----------------------------------------------------------------
	// allowsSyntheticReasoningContentForToolCalls flag
	// ----------------------------------------------------------------
	describe("allowsSyntheticReasoningContentForToolCalls flag", () => {
		it("is false for DeepSeek-family reasoning models", () => {
			const compat = deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			}).compat;
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		});

		it("is false for DeepSeek-family on NVIDIA", () => {
			const compat = deepseekModel({
				provider: "nvidia",
				baseUrl: "https://integrate.api.nvidia.com/v1",
				id: "deepseek-ai/deepseek-v4-flash",
			}).compat;
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		});

		it("is true for non-DeepSeek reasoning models on OpenRouter", () => {
			const base = getBundledModel("openai", "gpt-4o-mini");
			const compat = buildModel({
				...base,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "qwen/qwq-32b",
				reasoning: true,
				compat: base.compatConfig,
			} as ModelSpec<"openai-completions">).compat;
			// Qwen is not isDeepseekFamily, so synthetic is allowed
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
		});
	});

	// ----------------------------------------------------------------
	// Fix 2: reasoning_content from empty thinking blocks with signature
	// ----------------------------------------------------------------
	describe("thinking-block signature recovery (Fix 2)", () => {
		it("recovers reasoning_content from empty thinking block with valid signature", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			// Simulate a tool-call turn with an empty thinking block that has a valid
			// signature — this happens when reasoning text was lost but the signature
			// (field name) is preserved.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_empty_thinking",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			// The reasoning_content field should be set from the signature, even if empty.
			expect(assistant?.reasoning_content).toBe("");
		});

		it("recovers reasoning_content from non-empty thinking block with signature", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I need to read the file first.",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_with_thinking",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("I need to read the file first.");
		});

		it("normalizes OpenRouter reasoning deltas to DeepSeek reasoning_content on replay", () => {
			const model = getBundledModel("openrouter", "deepseek/deepseek-v4-pro") as Model<"openai-completions">;
			const compat = model.compat;
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);

			const msg = assistantToolCall(model, [
				{
					type: "thinking",
					thinking: "I should inspect the requested file.",
					thinkingSignature: "reasoning",
				} as ThinkingContent,
				{
					type: "toolCall",
					id: "call_openrouter_deepseek",
					name: "read",
					arguments: { path: "package.json" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("I should inspect the requested file.");
		});
		it("does not use opaque signature as property name but still sets reasoning_content from thinking text", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			// Simulate a thinking block with an opaque signature from another provider
			// (e.g. Anthropic encrypted signature, OpenAI Responses JSON item).
			// The code should NOT write to a property named after the opaque signature.
			// It should still set reasoning_content from the thinking text via the
			// existing thinkingFormat="openai" path.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "some reasoning",
						thinkingSignature: "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_opaque_sig",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			// Should NOT have used the opaque signature as a property name.
			expect(assistant?.rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c).toBeUndefined();
			// Should have set reasoning_content from the thinking text via the openai path.
			expect(assistant?.reasoning_content).toBe("some reasoning");
		});
		it("demotes cross-api foreign thinking while satisfying tool-call reasoning_content schema", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			const msg = assistantToolCall(model, [
				{
					type: "thinking",
					thinking: "Need to preserve cross-api reasoning.",
					thinkingSignature: "sig_from_anthropic",
				},
				{
					type: "toolCall",
					id: "toolu_cross_api",
					name: "read",
					arguments: { path: "README.md" },
				},
			]);
			msg.api = "anthropic-messages";
			msg.provider = "zai";
			msg.model = "claude-compatible";

			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("");
			expect(assistant?.content).toBe(renderDemotedThinking(model.id, "Need to preserve cross-api reasoning."));
		});
		it("falls through to empty-string when thinking block has opaque signature and empty text", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			// Empty-text thinking block with opaque signature — Tier 1 should reject the
			// opaque signature, nonEmptyThinkingBlocks won't include it, and the openai path
			// won't set anything. Tier 2 should then emit empty reasoning_content.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: "rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
					} as ThinkingContent,
					{
						type: "toolCall",
						id: "call_empty_opaque",
						name: "read",
						arguments: { path: "/tmp/test" },
					} as ToolCall,
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.rs_6f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c).toBeUndefined();
			expect(assistant?.reasoning_content).toBe("");
		});
	});

	// ----------------------------------------------------------------
	// Fix 3: Empty-string fallback when NO thinking blocks exist
	// (matches the actual observed 400 failure: proxy-stripped reasoning)
	// ----------------------------------------------------------------
	describe("empty-string fallback for missing reasoning_content (Fix 3)", () => {
		it("sets reasoning_content to empty string when no thinking blocks exist for DeepSeek", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			// Tool-call turn with NO thinking blocks at all — matches the actual
			// observed 400 error pattern where proxy stripped reasoning_content.
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_no_thinking",
					name: "read",
					arguments: { path: "/tmp/test" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			// reasoning_content must be present (empty string) — not absent and not "."
			const rc = assistant?.reasoning_content;
			expect(rc).toBeDefined();
			expect(rc).toBe("");
		});

		it("sets reasoning_content to empty string for OpenCode Zen big-pickle tool-call turns", () => {
			const model = getBundledModel("opencode-zen", "big-pickle") as Model<"openai-completions">;
			const compat = model.compat;
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);

			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_big_pickle",
					name: "bash",
					arguments: { command: "git status --short" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("");
			expect(assistant?.content).toBe("");
		});

		it("sets content to empty string (not null) when reasoning_content is present", () => {
			const model = deepseekModel({
				provider: "nvidia",
				baseUrl: "https://integrate.api.nvidia.com/v1",
				id: "deepseek-ai/deepseek-v4-flash",
			});
			const compat = model.compat;
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_no_content",
					name: "list_files",
					arguments: { path: "." },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.content).toBe("");
		});
	});

	// ----------------------------------------------------------------
	// Fix 4: reasoning_content on ALL assistant turns, not just tool-call turns
	// DeepSeek V4 requires reasoning_content on every assistant message once any
	// prior turn included it — including plain text responses with no tool calls.
	// ----------------------------------------------------------------
	describe("reasoning_content on non-tool-call assistant turns (Fix 4)", () => {
		it("injects empty reasoning_content on plain text assistant turn for DeepSeek", () => {
			const model = deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			});
			const compat = model.compat;
			// Plain text assistant response — no tool calls, no thinking blocks.
			// This is the exact pattern from the observed 400 error.
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Here is the answer to your question." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			// reasoning_content must be present — even on non-tool-call turns
			const rc = assistant?.reasoning_content;
			expect(rc).toBeDefined();
			expect(rc).toBe("");
		});

		it("injects reasoning_content from thinking blocks on plain text assistant turn", () => {
			const model = deepseekModel({
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1",
				id: "deepseek-v4-flash",
			});
			const compat = model.compat;
			const msg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this.",
						thinkingSignature: "reasoning_content",
					} as ThinkingContent,
					{ type: "text", text: "The answer is 42." },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("Let me think about this.");
			expect(assistant?.content).toBe("The answer is 42.");
		});

		it("does NOT inject reasoning_content on non-tool-call turn for non-DeepSeek providers", () => {
			const base = getBundledModel("openai", "gpt-4o-mini");
			const model: Model<"openai-completions"> = buildModel({
				...base,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "qwen/qwq-32b",
				reasoning: true,
				compat: base.compatConfig,
			} as ModelSpec<"openai-completions">);
			const compat = model.compat;
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Plain answer." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			// OpenRouter reasoning models only need reasoning_content on tool-call turns
			expect(assistant?.reasoning_content).toBeUndefined();
		});
	});

	// ----------------------------------------------------------------
	// Tier 3: Synthetic placeholder for non-DeepSeek providers
	// ----------------------------------------------------------------
	describe("synthetic placeholder for non-DeepSeek providers (Tier 3)", () => {
		it('still uses "." placeholder for Kimi models that accept it', () => {
			const base = getBundledModel("openai", "gpt-4o-mini");
			const model: Model<"openai-completions"> = buildModel({
				...base,
				api: "openai-completions",
				provider: "moonshot",
				baseUrl: "https://api.moonshot.ai/v1",
				id: "kimi-k2.5",
				reasoning: true,
				compat: base.compatConfig,
			} as ModelSpec<"openai-completions">);
			const compat = model.compat;
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
			const msg = assistantToolCall(model, [
				{
					type: "toolCall",
					id: "call_kimi",
					name: "read",
					arguments: { path: "/tmp" },
				} as ToolCall,
			]);
			const messages = convertMessages(model, { messages: [msg] }, compat);
			const assistant = findOpenAICompletionAssistantWireMessage(messages);
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe(".");
		});
	});
});
