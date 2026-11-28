/**
 * Wire output for prior-turn thinking replayed through the `openai-completions`
 * assistant encoder.
 *
 * Cross-API switches: a prior assistant turn whose native reasoning slot was
 * authored by a different provider. Unsigned foreign reasoning is only
 * semantically carried by Z.AI-format OpenAI-compatible targets; schema
 * requirements such as `requiresReasoningContentForToolCalls` and local
 * llama.cpp cache-prefix replay do not make the reasoning meaningful.
 * Non-allowlisted targets demote the reasoning into canonical visible text so
 * the next model can still read it.
 *
 * Local chat-template hosts: `replayReasoningContent` is auto-enabled for the
 * built-in local OpenAI-compatible providers and any provider on a loopback /
 * RFC1918 baseUrl. The encoder surfaces preserved thinking as
 * `reasoning_content` on every reasoning-engaged turn so the server's chat
 * template re-renders `<think>…</think>` and the slot's KV-cache prefix stays
 * valid across continuations.
 */
import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec, ThinkingContent, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
	for (const message of messages) {
		if (isPlainObject(message) && message.role === "assistant") return message;
	}
	return undefined;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

describe("cross-API thinking-block replay into chat-completions targets", () => {
	const ZAI_OPAQUE_SIGNATURE = "Ev0CCkYIBhgCKkArbase64sigfromzai==";

	function zaiAnthropicMessage(thinkingText: string): AssistantMessage {
		// Z.AI's Anthropic-format 3p endpoint (api.z.ai/api/anthropic). The source
		// signature looks like an Anthropic continuation hint but is opaque to any
		// other API — the cross-API path MUST strip it before the encoder reads it.
		return {
			role: "assistant",
			api: "anthropic-messages",
			provider: "zai",
			model: "glm-5.2",
			content: [
				{ type: "thinking", thinking: thinkingText, thinkingSignature: ZAI_OPAQUE_SIGNATURE },
				{ type: "text", text: "Done." },
			],
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: 0,
		};
	}

	function zaiOpenAITarget(): Model<"openai-completions"> {
		// Z.AI's OpenAI-format endpoint (same vendor catalog entry as the Anthropic
		// source above). thinkingFormat resolves to "zai";
		// requiresReasoningContentForToolCalls is false.
		return buildModel({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 131_072,
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		} satisfies ModelSpec<"openai-completions">);
	}

	function deepseekReasoningTarget(): Model<"openai-completions"> {
		// DeepSeek-family reasoning targets require `reasoning_content` for schema
		// validity, but measured foreign reasoning in that slot is inert. Cross-API
		// foreign thinking must demote to text; the encoder may still emit an empty
		// schema placeholder where required.
		return buildModel({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
	}

	function opencodeGoKimiTarget(): Model<"openai-completions"> {
		// OpenCode Go's reasoning-enabled Kimi. Base compat keeps
		// `requiresReasoningContentForToolCalls: false` to dodge the
		// `Extra inputs are not permitted` 400 (#1071); only the resolved
		// `whenThinking` policy reactivates it (#1484). That schema requirement must
		// not preserve foreign non-tool-call reasoning as native semantic context.
		return buildModel({
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 16_384,
		} satisfies ModelSpec<"openai-completions">);
	}

	function openAIGpt4oTarget(): Model<"openai-completions"> {
		// Official OpenAI Chat Completions, non-reasoning. Thinking blocks must
		// still demote to text — this target can't usefully emit `reasoning_content`.
		return buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} satisfies ModelSpec<"openai-completions">);
	}

	it("emits reasoning_content on Z.AI Anthropic → Z.AI OpenAI cross-API switch", () => {
		const target = zaiOpenAITarget();
		const messages: Message[] = [
			userMessage("Build a plan"),
			zaiAnthropicMessage("Step 1 explore. Step 2 patch. Step 3 verify."),
			userMessage("Continue the same plan on the other endpoint."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		// The reasoning chain rides as structured `reasoning_content` on the
		// next request, not folded into the visible `content` text.
		expect(assistant.reasoning_content).toBe("Step 1 explore. Step 2 patch. Step 3 verify.");
		expect(assistant.content).toBe("Done.");
	});

	it("strips the source signature on the preserved cross-API thinking block", () => {
		// The Z.AI Anthropic signature is bound to the Anthropic wire-format and
		// useless to the OpenAI target. The preserved block surfaces only the
		// reasoning text; no opaque signature may leak onto the wire as a stray
		// field name.
		const target = zaiOpenAITarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("opaque continuation metadata payload"),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(ZAI_OPAQUE_SIGNATURE in assistant).toBe(false);
		expect(assistant.reasoning_content).toBe("opaque continuation metadata payload");
	});

	it("demotes Anthropic 3p → DeepSeek cross-API thinking instead of semantic replay", () => {
		const target = deepseekReasoningTarget();
		const messages: Message[] = [
			userMessage("Inspect README"),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue on DeepSeek."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBe("");
		expect(assistant.content).toBe(`${renderDemotedThinking(target.id, "Read README and answer.")}\nDone.`);
	});

	it("demotes thinking to canonical text when the target cannot replay it semantically", () => {
		const target = openAIGpt4oTarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Explore the repo, then patch it."),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe(`${renderDemotedThinking(target.id, "Explore the repo, then patch it.")}\nDone.`);
	});

	it("demotes cross-API thinking for OpenCode reasoning targets with whenThinking schema", () => {
		const target = opencodeGoKimiTarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue on OpenCode."),
		];

		// Resolve the thinking-engaged compat the way `streamOpenAICompletions`
		// does for a request with reasoning effort set.
		const compat = target.compat.whenThinking ?? target.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe(`${renderDemotedThinking(target.id, "Read README and answer.")}\nDone.`);
	});

	it("demotes prior thinking to content when the OpenCode base compat runs with thinking off", () => {
		const target = opencodeGoKimiTarget();
		const compat = target.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);

		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue with thinking off."),
		];

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe(`${renderDemotedThinking(target.id, "Read README and answer.")}\nDone.`);
	});

	it("does not promote markup-healed same-model thinking into visible content", () => {
		// Markup-healed streams (MiniMax `<think>…</think>`, Kimi K2 healed
		// reasoning, …) record thinking blocks with `thinkingSignature: undefined`
		// because the healer reconstructs them from raw text deltas. On a
		// same-model continuation those blocks are PRIVATE reasoning the source
		// emitted, not cross-API preserved reasoning. Same-model history is never
		// signature-stripped or text-demoted by `transformMessages`, and no
		// encoder branch consumes an unsigned same-model thinking block, so it
		// falls through unemitted — the hidden chain-of-thought must never leak
		// into the next request's visible `content`.
		const target = opencodeGoKimiTarget();
		const compat = target.compat;
		const sameModelAssistant: AssistantMessage = {
			role: "assistant",
			api: target.api,
			provider: target.provider,
			model: target.id,
			content: [
				{ type: "thinking", thinking: "hidden chain-of-thought, must not leak" },
				{ type: "text", text: "Visible answer." },
			],
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: 0,
		};
		const messages: Message[] = [userMessage("Plan it."), sameModelAssistant, userMessage("Continue.")];

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		// Visible content stays exactly what the model produced on the last turn.
		expect(assistant.content).toBe("Visible answer.");
		// And the private reasoning is not promoted anywhere on the wire.
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.reasoning).toBeUndefined();
		expect(assistant.reasoning_text).toBeUndefined();
	});
});

describe("reasoning_content replay on local chat-template hosts", () => {
	function llamaCppQwenModel(overrides?: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
		// Local llama.cpp baseUrl, Qwen-family id, reasoning enabled. Per
		// detectCompat this resolves to `thinkingFormat: "qwen"`, none of the
		// `requires*` flags, and `replayReasoningContent: true`.
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

	function llamaCppAssistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: 0,
		};
	}

	function assistantWithReasoning(reasoning: string, answer: string): AssistantMessage {
		return llamaCppAssistant([
			{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning_content" } satisfies ThinkingContent,
			{ type: "text", text: answer },
		]);
	}

	it("replays reasoning_content on plain-text assistant turns for llama.cpp (no tool calls)", () => {
		// Existing `requires*ReasoningContent*` recovery paths gate on tool calls;
		// thinking blocks on a pure-text assistant turn (finish_reason=stop, next
		// user turn is a nudge) must still ride as `reasoning_content` for llama.cpp.
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
			usage: zeroUsage,
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
		const found = findAssistantMessage(wire);
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
		const assistant = llamaCppAssistant([
			{ type: "thinking", thinking: "trace A", thinkingSignature: "reasoning" } satisfies ThinkingContent,
			{ type: "text", text: "answer A" },
		]);
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire);
		expect(found?.reasoning).toBe("trace A");
		expect(found?.reasoning_content).toBeUndefined();
	});

	it("falls back to reasoningContentField for opaque thinking signatures", () => {
		// Anthropic/OpenAI-Responses thinking blocks ride a binary continuation
		// signature that is meaningless as a chat-completions field name. Use
		// the configured `reasoningContentField` (default `reasoning_content`)
		// rather than synthesizing a key from the opaque signature.
		const target = llamaCppQwenModel();
		const assistant = llamaCppAssistant([
			{ type: "thinking", thinking: "trace B", thinkingSignature: "rs_0123456789abcdef" } satisfies ThinkingContent,
			{ type: "text", text: "answer B" },
		]);
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire);
		expect(found?.reasoning_content).toBe("trace B");
		expect("rs_0123456789abcdef" in (found ?? {})).toBe(false);
	});

	it("does NOT replay reasoning_content when the target has no reasoning blocks", () => {
		// Pure-text turn with no thinking content stays minimal — the
		// replay branch only fires when there is actually something to preserve.
		const target = llamaCppQwenModel();
		const assistant = llamaCppAssistant([{ type: "text", text: "plain answer" }]);
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire);
		expect(found?.content).toBe("plain answer");
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.reasoning).toBeUndefined();
	});
});
