import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * End-to-end encoder contract for #2851. GitHub Copilot's `anthropic-messages`
 * proxy forwards to signature-enforcing Anthropic, so after the fix it is a
 * SIGNING endpoint (`replayUnsignedThinking: false` — see the catalog compat
 * regression test). This pins the consequence: when a checkpoint/branch-return
 * turn is an abandoned tool-use turn (adaptive Opus emits a tool call then ends
 * on `stop`), the transform strips its end_turn-bound signature. Since the turn
 * is same-model with an invalid (undefined) signature, the thinking block is
 * dropped entirely — never emitted as `{ signature: "" }` (which would 400 the
 * request with "Invalid signature") and never demoted to text (which would
 * trigger the reasoning_extraction safety classifier and cause refusals).
 *
 * The signing classification is asserted directly in
 * `packages/catalog/test/anthropic-copilot-signing-compat.test.ts`; the explicit
 * `compat` override here models that post-fix classification so the encoder
 * behavior is exercised independently of cross-package module resolution.
 */
function copilotSigningModel(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "github-copilot",
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		baseUrl: "https://api.githubcopilot.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		// Post-#2851 classification: github-copilot is a signing endpoint.
		compat: { replayUnsignedThinking: false },
	} as ModelSpec<"anthropic-messages">);
}

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type WireBlock = { type: string; signature?: string; thinking?: string; text?: string; id?: string };
interface WireParam {
	role: string;
	content: string | WireBlock[];
}

function copilotAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-opus-4.8",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** Every thinking block emitted in the whole request, across all params. */
function allThinkingBlocks(params: WireParam[]): WireBlock[] {
	const blocks: WireBlock[] = [];
	for (const p of params) {
		if (!Array.isArray(p.content)) continue;
		for (const b of p.content) {
			if (b.type === "thinking") blocks.push(b);
		}
	}
	return blocks;
}

function assistantBlocksAt(params: WireParam[], index: number): WireBlock[] {
	const assistants = params.filter(p => p.role === "assistant");
	const content = assistants[index]?.content;
	return Array.isArray(content) ? content : [];
}

describe("#2851 github-copilot checkpoint/branch-return thinking signature", () => {
	it("classifies the explicit signing model as non-replay (sanity)", () => {
		expect(copilotSigningModel().compat.replayUnsignedThinking).toBe(false);
	});

	it("never emits an empty-signature thinking block for a historical checkpoint turn", () => {
		const model = copilotSigningModel();
		// The store holds a full (~14.6k char) Anthropic signature for the checkpoint
		// turn's thinking; the turn ended on `stop` (abandoned tool-use), so its
		// signature is end_turn-bound and gets stripped on replay.
		const checkpointSig = "real_anthropic_signature_".repeat(600);
		const messages: Message[] = [
			{ role: "user", content: "investigate the flaky test", timestamp: 1 } satisfies UserMessage,
			copilotAssistant(
				[
					{ type: "thinking", thinking: "Checkpoint first, then explore.", thinkingSignature: checkpointSig },
					{ type: "toolCall", id: "toolu_ckpt", name: "checkpoint", arguments: { goal: "find the flake" } },
				],
				{ stopReason: "stop", timestamp: 2 },
			),
			{
				role: "toolResult",
				toolCallId: "toolu_ckpt",
				toolName: "checkpoint",
				content: [{ type: "text", text: "checkpoint started" }],
				isError: false,
				timestamp: 3,
			} satisfies ToolResultMessage,
			// branch-return summary surfaces as a user turn in the rebuilt history
			{ role: "user", content: "[branch summary] explored, found the race", timestamp: 4 } satisfies UserMessage,
			copilotAssistant([{ type: "text", text: "Here's the fix." }], { stopReason: "stop", timestamp: 5 }),
		];

		const params = convertAnthropicMessages(messages, model, false) as unknown as WireParam[];

		// (a) Anthropic's all-or-none contract: no thinking block may carry an empty signature.
		for (const block of allThinkingBlocks(params)) {
			expect(block.signature && block.signature.length > 0).toBeTruthy();
		}

		// When a checkpoint thinking block with a valid signature is stripped (abandoned
		// tool-use), the block is dropped entirely — not demoted to text. Demotion would
		// trigger the reasoning_extraction safety classifier and cause model refusals.
		// The tool_use stays paired with the appended tool_result.
		const checkpointBlocks = assistantBlocksAt(params, 0);
		expect(checkpointBlocks.some(b => b.type === "thinking")).toBe(false);
		expect(checkpointBlocks.some(b => b.type === "tool_use" && b.id === "toolu_ckpt")).toBe(true);
	});

	it("still replays a signed historical thinking block natively (no regression to the common case)", () => {
		const model = copilotSigningModel();
		// A clean tool-use turn (stopReason "toolUse") keeps a replayable signature.
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: 1 } satisfies UserMessage,
			copilotAssistant(
				[
					{ type: "thinking", thinking: "I'll read README.", thinkingSignature: "sig_replayable" },
					{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "README.md" } },
				],
				{ stopReason: "toolUse", timestamp: 2 },
			),
			{
				role: "toolResult",
				toolCallId: "toolu_read",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			} satisfies ToolResultMessage,
			{ role: "user", content: "now summarize", timestamp: 4 } satisfies UserMessage,
			copilotAssistant([{ type: "text", text: "Summary." }], { stopReason: "stop", timestamp: 5 }),
		];

		const params = convertAnthropicMessages(messages, model, false) as unknown as WireParam[];
		for (const block of allThinkingBlocks(params)) {
			expect(block.signature && block.signature.length > 0).toBeTruthy();
		}
		const firstAssistant = assistantBlocksAt(params, 0);
		expect(firstAssistant.some(b => b.type === "thinking" && b.signature === "sig_replayable")).toBe(true);
	});
});
