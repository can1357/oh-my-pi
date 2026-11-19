/**
 * Regression guard for cross-API 3p ↔ 3p thinking-block handling (#3434).
 *
 * Mid-session switches can replay a prior assistant turn whose native reasoning
 * slot was authored by a different provider. Live provider probes showed that
 * unsigned foreign reasoning is only semantically carried by Z.AI-format
 * OpenAI-compatible targets; schema requirements such as
 * `requiresReasoningContentForToolCalls` and local llama.cpp cache-prefix replay
 * do not make the reasoning meaningful. Non-allowlisted targets demote the
 * reasoning into canonical visible text so the next model can still read it.
 *
 * This file pins the wire output for the canonical scenarios.
 */
import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
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

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function zaiOpenAITarget(): Model<"openai-completions"> {
	// Z.AI's OpenAI-format endpoint (api.z.ai/api/coding/paas/v4 — same vendor
	// catalog entry as the Anthropic source above). thinkingFormat resolves to
	// "zai"; requiresReasoningContentForToolCalls is false.
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

describe("cross-API thinking-block preservation (#3433/#3434)", () => {
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
