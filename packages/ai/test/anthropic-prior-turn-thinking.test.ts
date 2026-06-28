import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@pk-nerdsaver-ai/pi-ai/dialect";
import { convertAnthropicMessages } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";

/**
 * Cross-model `anthropic-messages` continuations must preserve the prior
 * turn's reasoning chain. Anthropic enforces an all-or-none contract on
 * thinking blocks ("if you include thinking blocks in prior assistant turns,
 * you must include ALL thinking blocks (including redacted ones)") but the
 * legacy transform only honored that for the LATEST surviving assistant.
 * Every earlier turn fell through to the cross-API text-demotion path
 * whenever the conversation crossed a model boundary — silently dropping the
 * reasoning chain on continuation for custom anthropic-messages providers
 * configured via `models.yaml` and for session-level model swaps (#2257).
 *
 * The signature policy is a second axis: official Anthropic cryptographically
 * binds signatures to its key+session+model, so cross-model signatures must
 * be stripped (and matching redacted siblings dropped) whenever either side
 * of the replay is official Anthropic. Third-party endpoints (Z.AI, DeepSeek,
 * custom anthropic-messages providers) treat signatures as opaque
 * continuation hints they pass through unchanged, so 3p ↔ 3p replays
 * preserve them as-is to keep the reasoning chain signed for the next
 * turn (#2265).
 */
function makeAnthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
interface WireRedactedBlock {
	type: "redacted_thinking";
	data: string;
}
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock =
	| WireThinkingBlock
	| WireTextBlock
	| WireRedactedBlock
	| WireToolUseBlock
	| { type: string; [key: string]: unknown };

describe("Anthropic prior-turn thinking preservation (#2257, #2265)", () => {
	it("preserves the prior thinking block as native `thinking` across compatible endpoints", () => {
		// Source v1, target v2, both on the same custom anthropic-messages
		// provider. The first assistant turn is PRIOR, so the latest-only
		// preservation path doesn't help — without the fix the prior thinking
		// block is demoted to plain `text` and the reasoning chain disappears.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const priorThinkingText = "Plan: read README, then summarize.";
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: priorThinkingText, thinkingSignature: "sig_v1" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Got the body, now translating", thinkingSignature: "sig_v2" },
					{ type: "text", text: "Voici le résumé en français." },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Now translate it to Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(2);
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking).toBeDefined();
		expect(thinking?.thinking).toBe(priorThinkingText);
		// 3p ↔ 3p replay: the source signature is opaque continuation metadata
		// that compatible endpoints pass through. Stripping it (the pre-fix
		// behavior) silently demotes the reasoning chain on the next turn.
		expect(thinking?.signature).toBe("sig_v1");
		// And the paired tool_use must still be present right after it.
		const toolUse = priorBlocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe("toolu_prior");
	});

	it("keeps the signature on prior turns when the source model matches the target", () => {
		// Same provider+api+id throughout: signatures are valid and must ride
		// the wire untouched (prompt-cache stability + Anthropic's all-or-none
		// invariant).
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant([
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig_same" },
				{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "summarising", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("And now in Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("plan");
		expect(thinking?.signature).toBe("sig_same");
	});

	it("preserves redacted_thinking blocks from prior anthropic-messages turns", () => {
		// Anthropic's "include ALL thinking blocks (including redacted ones)"
		// rule means redacted_thinking from earlier turns must survive whenever
		// any thinking content from the same turn is replayed.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig" },
					{ type: "redactedThinking", data: "encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "later", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const redacted = priorBlocks.find(b => b.type === "redacted_thinking") as WireRedactedBlock | undefined;
		expect(redacted).toBeDefined();
		expect(redacted?.data).toBe("encrypted-blob");
	});

	it("strips foreign signatures and drops redacted_thinking when the target is official Anthropic", () => {
		// 3p → official Anthropic. The official endpoint rejects foreign
		// signatures cryptographically, and `replayUnsignedThinking: false`
		// demotes the unsigned visible thinking to text downstream, so the
		// matching redacted sibling must not remain as a lone native
		// redacted_thinking block.
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig_custom" },
					{ type: "redactedThinking", data: "foreign-encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "official latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking(target.id, "visible reasoning"));
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(priorBlocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
	});

	it("strips official Anthropic source signatures on cross-model replay to a 3p target", () => {
		// official Anthropic → 3p. Anthropic's signature is bound to the
		// issuing model+session, so the 3p target cannot reverify or
		// meaningfully continue from it; passing it through would leak
		// private continuation metadata for no benefit. The unsigned thinking
		// is still emitted natively because the 3p target's compat advertises
		// `replayUnsignedThinking: true`.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic reasoning", thinkingSignature: "sig_anthropic" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "v2 reasoning", thinkingSignature: "sig_v2" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("anthropic reasoning");
		expect(thinking?.signature).toBe("");
	});

	it("preserves prior unsigned thinking from non-anthropic sources on unsigned-replay targets", () => {
		// Anthropic-compatible targets that advertise `replayUnsignedThinking`
		// accept unsigned native thinking as their semantic-carry analogue.
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "openai chain-of-thought", thinkingSignature: "" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{
					api: "openai-responses",
					provider: "openai",
					model: "o1-preview",
				} as Partial<AssistantMessage>,
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("openai chain-of-thought");
		expect(thinking?.signature).toBe("");
	});
});
