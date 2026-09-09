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

// These tests pin the wire-validity contract that was verified end-to-end against the
// live Anthropic Messages API (claude-opus-4-8):
//
//   * A `thinking` block sent back to Anthropic MUST carry a non-empty signature, or the
//     request 400s ("thinking.signature: Field required" for a missing one,
//     "Invalid `signature` in `thinking` block" for a stale one).
//   * `stop_reason` is never replayed on the wire, so it does NOT constrain whether a
//     continuation is valid — a tool_use turn replays fine with tool_results appended
//     whether it ended on `tool_use` or `end_turn`.
//   * Therefore the safe recovery for a turn whose signature is untrustworthy is to strip it
//     and let the encoder downgrade that block to text — which the API accepts. Two cases
//     qualify: an abandoned `end_turn`+tool_use turn (all signatures are end_turn-bound and
//     unreplayable), and the single mid-stream block of an `aborted`/`error` turn (only the
//     block streaming at the abort point can hold a partial signature; earlier blocks
//     completed and keep their valid, replayable signatures).
//   * The latest assistant message is different: Anthropic requires thinking blocks from
//     its most recent response to remain unmodified, so valid signatures must be preserved
//     even when the turn is abandoned.
//
// The agent loop relies on this: it now runs tool_use blocks under `stop`/`end_turn` and
// continues. That continuation is valid only when the transform preserves latest signed
// thinking and downgrades historical/invalid signed thinking.

const model: Model<"anthropic-messages"> = buildModel({
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildHistory(stopReason: AssistantMessage["stopReason"], signature: string | undefined): Message[] {
	const user: UserMessage = { role: "user", content: "reason, then call the tool", timestamp: 1 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "deliberating about the forecast", thinkingSignature: signature },
			{ type: "text", text: "I'll check the weather." },
			{ type: "toolCall", id: "toolu_1", name: "get_weather", arguments: { location: "Paris" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: emptyUsage,
		stopReason,
		timestamp: 2,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "get_weather",
		content: [{ type: "text", text: "15C, partly cloudy" }],
		details: {},
		isError: false,
		timestamp: 3,
	};
	return [user, assistant, toolResult];
}

type WireBlock = { type: string; signature?: string; thinking?: string; text?: string };

function assistantBlocks(messages: Message[]): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

/** The hard API rule: no thinking block may be emitted without a non-empty signature. */
function expectNoUnsignedThinking(blocks: WireBlock[]): void {
	for (const block of blocks) {
		if (block.type === "thinking") {
			expect(block.signature && block.signature.length > 0).toBeTruthy();
		}
	}
}

describe("Anthropic abandoned/aborted tool-use replay", () => {
	it("preserves signed thinking on a genuine toolUse turn", () => {
		const blocks = assistantBlocks(buildHistory("toolUse", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("preserves signed thinking on the latest end_turn(stop) tool-use turn", () => {
		const blocks = assistantBlocks(buildHistory("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("preserves signed thinking on the latest surviving abandoned tool-use turn when trailing truncated thinking is dropped", () => {
		const blocks = assistantBlocks(buildHistoryWithTrailingTruncatedThinking("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "text" && b.text?.includes("deliberating about the forecast"))).toBe(false);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("drops historical end_turn(stop) tool-use thinking so the continuation stays wire-valid", () => {
		const blocks = assistantBlocks(buildHistoryWithLaterAssistant("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		// Signature stripped (historical same-model abandoned tool-use) -> the thinking block is
		// dropped entirely, never demoted to text. Demotion would trip the reasoning_extraction
		// classifier; the reasoning is the model's own prior chain and is not replayed as prose.
		expect(blocks.some(b => b.type === "thinking")).toBe(false);
		expect(blocks.some(b => b.type === "text" && b.text?.includes("deliberating"))).toBe(false);
		// The turn's other content survives (visible text + tool_use), so the tool_use still pairs
		// with the appended tool_result and the continuation stays wire-valid.
		expect(blocks.some(b => b.type === "text" && b.text === "I'll check the weather.")).toBe(true);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("strips only the mid-stream final block of an aborted interleaved turn, keeping earlier signed thinking", () => {
		// Interleaved thinking: a fully-signed thinking block and a tool_use completed, then the
		// model began a second thinking block and was interrupted mid-stream. Only that trailing
		// block can carry a partial (invalid) signature; the earlier one stays intact.
		const user: UserMessage = { role: "user", content: "go", timestamp: 1 };
		const aborted: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "first, list them", thinkingSignature: "sig_done" },
				{ type: "toolCall", id: "toolu_1", name: "list", arguments: {} },
				{ type: "thinking", thinking: "now decide", thinkingSignature: "trunc" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "aborted",
			timestamp: 2,
		};
		const blocks = assistantBlocks([user, aborted]);
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_done")).toBe(true);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "trunc")).toBe(false);
		// The stripped mid-stream block is dropped entirely, not demoted to text: same-model replay
		// to signature-enforcing Anthropic never emits demoted thinking (it would trip the
		// reasoning_extraction classifier). Only the earlier fully-signed block replays natively.
		expect(blocks.some(b => b.type === "text" && b.text?.includes("now decide"))).toBe(false);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("replays completed signed thinking when an aborted turn is interrupted during output behind a gateway baseUrl", () => {
		// Exact shape behind HTTP 400 "Invalid `signature` in `thinking` block": the model finished
		// thinking (block fully signed) and the user interrupted while it streamed the visible text.
		// The whole signature must replay as native signed thinking even when the first-party
		// provider is routed through an LLM gateway baseUrl, which still reaches signature-enforcing
		// Anthropic. Dropping it would emit signature:"" and 400 the gateway.
		const gatewayModel: Model<"anthropic-messages"> = buildModel({
			...model,
			baseUrl: "https://llm2.example.com/abc/v1/messages",
			compat: model.compatConfig,
		} as ModelSpec<"anthropic-messages">);
		const user: UserMessage = { role: "user", content: "deploy the update", timestamp: 1 };
		const aborted: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "23 phones are ready to update", thinkingSignature: "sig_valid" },
				{ type: "text", text: "Updating the phones now" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "aborted",
			timestamp: 2,
		};
		const followUp: UserMessage = { role: "user", content: "don't update phones", timestamp: 3 };
		const params = convertAnthropicMessages([user, aborted, followUp], gatewayModel, false);
		const assistant = params.find(p => p.role === "assistant");
		const blocks = (assistant?.content as WireBlock[] | undefined) ?? [];
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "text" && b.text === "Updating the phones now")).toBe(true);
	});
});

function buildHistoryWithLaterAssistant(
	stopReason: AssistantMessage["stopReason"],
	signature: string | undefined,
): Message[] {
	return [
		...buildHistory(stopReason, signature),
		{ role: "user", content: "continue after tool result", timestamp: 4 } satisfies UserMessage,
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 5,
		} satisfies AssistantMessage,
	];
}

function buildHistoryWithTrailingTruncatedThinking(
	stopReason: AssistantMessage["stopReason"],
	signature: string | undefined,
): Message[] {
	const abandonedToolUse = buildHistory(stopReason, signature);
	return [
		abandonedToolUse[0]!,
		abandonedToolUse[1]!,
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "truncated final thought", thinkingSignature: "sig_truncated" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "length",
			timestamp: 4,
		} satisfies AssistantMessage,
	];
}
