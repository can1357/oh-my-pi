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
 * Regression: DeepSeek's Anthropic endpoint rejects a thinking-mode request when
 * an assistant turn inside the CURRENT turn carries no `thinking` block —
 * "The `content[].thinking` in the thinking mode must be passed back to the
 * API." A gateway model group whose primary upstream is lax (it can answer a
 * thinking-mode turn with no reasoning at all) and whose fallback is that strict
 * endpoint inherits the stricter contract.
 *
 * Proven against https://api.deepseek.com/anthropic/v1/messages:
 * - a thinking-less assistant turn after the last user text → 400;
 * - appending one user prompt past it → 200 (the window, not the whole history);
 * - an unsigned `thinking` block with non-blank text restores 200 through litellm
 *   (a blank one is dropped by the adapter's body normalization);
 * - a thinking-less turn before the last user text is accepted as-is;
 * - `redacted_thinking` is rejected outright ("unknown variant"), so it can never
 *   stand in for a `thinking` block.
 */
const PLACEHOLDER = "(no reasoning was returned for this turn)";
const strictCompat = {
	requiresThinkingPresence: true,
	replayUnsignedThinking: true,
} satisfies ModelSpec<"anthropic-messages">["compat"];

function makeModel(compat?: ModelSpec<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	const spec: ModelSpec<"anthropic-messages"> = {
		api: "anthropic-messages",
		provider: "litellm",
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		baseUrl: "https://llm.example.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		compat,
	};
	return buildModel(spec);
}

function makeUser(text = "go"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "litellm",
		model: "deepseek-v4.1-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function makeToolResult(toolCallId: string, text = "data"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

const readCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a" } });

interface WireBlock {
	type: string;
	[key: string]: unknown;
}

function isWireBlock(value: unknown): value is WireBlock {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/** Serialized assistant turns, in order, as wire blocks. */
function assistantBlocks(
	messages: Message[],
	model: Model<"anthropic-messages">,
	thinkingEnabled: boolean,
): WireBlock[][] {
	const params = convertAnthropicMessages(messages, model, false, { thinkingEnabled });
	const turns: WireBlock[][] = [];
	for (const param of params) {
		if (param.role !== "assistant") continue;
		if (typeof param.content === "string") throw new Error("assistant content serialized as a string");
		turns.push(param.content.filter(isWireBlock));
	}
	return turns;
}

describe("Anthropic thinking-presence replay (DeepSeek strict validator)", () => {
	it("pads a thinking-less turn that the current request answers", () => {
		const turns = assistantBlocks(
			[makeUser("list files"), makeAssistant([readCall("call_a")]), makeToolResult("call_a")],
			makeModel(strictCompat),
			true,
		);
		expect(turns).toHaveLength(1);
		expect(turns[0][0]).toEqual({ type: "thinking", thinking: PLACEHOLDER, signature: "" });
		expect(turns[0][1]).toMatchObject({ type: "tool_use", id: "call_a" });
	});

	it("leaves turns before the last user prompt untouched", () => {
		const turns = assistantBlocks(
			[
				makeUser("first"),
				makeAssistant([{ type: "text", text: "answer" }], "stop"),
				makeUser("second"),
				makeAssistant([{ type: "text", text: "later" }], "stop"),
			],
			makeModel(strictCompat),
			true,
		);
		expect(turns).toEqual([
			[{ type: "text", text: "answer" }],
			[
				{ type: "thinking", thinking: PLACEHOLDER, signature: "" },
				{ type: "text", text: "later" },
			],
		]);
	});

	it("pads every in-window turn of a multi-step tool loop", () => {
		const turns = assistantBlocks(
			[
				makeUser("inspect"),
				makeAssistant([readCall("call_a")]),
				makeToolResult("call_a"),
				makeAssistant([readCall("call_b")]),
				makeToolResult("call_b"),
			],
			makeModel(strictCompat),
			true,
		);
		expect(turns.map(blocks => blocks[0])).toEqual([
			{ type: "thinking", thinking: PLACEHOLDER, signature: "" },
			{ type: "thinking", thinking: PLACEHOLDER, signature: "" },
		]);
	});

	it("does not duplicate a thinking block that is already present", () => {
		const [blocks] = assistantBlocks(
			[
				makeUser(),
				makeAssistant([{ type: "thinking", thinking: "kept", thinkingSignature: "" }, readCall("call_a")]),
				makeToolResult("call_a"),
			],
			makeModel(strictCompat),
			true,
		);
		expect(blocks.filter(block => block.type === "thinking")).toEqual([
			{ type: "thinking", thinking: "kept", signature: "" },
		]);
	});

	it("pads a turn that only carries redacted thinking", () => {
		const [blocks] = assistantBlocks(
			[
				makeUser(),
				makeAssistant([{ type: "redactedThinking", data: "b3BhcXVl" }, readCall("call_a")]),
				makeToolResult("call_a"),
			],
			makeModel(strictCompat),
			true,
		);
		expect(blocks[0]).toEqual({ type: "thinking", thinking: PLACEHOLDER, signature: "" });
		expect(blocks.some(block => block.type === "redacted_thinking")).toBe(true);
	});

	it("leaves the current turn alone when thinking is disabled", () => {
		const turns = assistantBlocks(
			[makeUser(), makeAssistant([readCall("call_a")]), makeToolResult("call_a")],
			makeModel(strictCompat),
			false,
		);
		expect(turns[0].some(block => block.type === "thinking")).toBe(false);
	});

	it("leaves the current turn alone when the endpoint does not require presence", () => {
		const turns = assistantBlocks(
			[makeUser(), makeAssistant([readCall("call_a")]), makeToolResult("call_a")],
			makeModel({ replayUnsignedThinking: true }),
			true,
		);
		expect(turns[0].some(block => block.type === "thinking")).toBe(false);
	});
});
