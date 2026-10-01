import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	type InteractionUpdate,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/**
 * Live `AgentServerMessage` frame captured from a Cursor turn: `turn_ended`
 * with input 12336, output 36, cache read/write 0, reasoning 31 — while the
 * turn's `tokenDelta` frames summed to 22.
 */
const CAPTURED_TURN_ENDED = Buffer.from("0a0d720b08b060102418002000281f", "hex");

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
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

function newBlockState(): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
}

function capturedTurnEndedUpdate(): InteractionUpdate {
	const msg = fromBinary(AgentServerMessageSchema, CAPTURED_TURN_ENDED);
	if (msg.message.case !== "interactionUpdate") throw new Error("expected an interaction update");
	return msg.message.value;
}

describe("Cursor turn usage (issue #13082)", () => {
	it("adopts the final per-turn counters over the streamed tokenDelta estimate", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState = { sawTokenDelta: false };

		processInteractionUpdate(
			{ message: { case: "tokenDelta", value: { tokens: 22 } } },
			output,
			stream,
			state,
			usageState,
		);
		processInteractionUpdate(capturedTurnEndedUpdate(), output, stream, state, usageState);

		expect(output.usage).toMatchObject({
			input: 12336,
			output: 36,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 31,
			totalTokens: 12372,
		});
	});

	it("keeps the streamed output when the final frame reports no counters", () => {
		// Older Cursor builds end the turn with a bare `TurnEndedUpdate`. Reading
		// its unset counters as zeros would erase the turn's only usage signal.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState = { sawTokenDelta: false };

		processInteractionUpdate(
			{ message: { case: "tokenDelta", value: { tokens: 22 } } },
			output,
			stream,
			state,
			usageState,
		);
		processInteractionUpdate({ message: { case: "turnEnded", value: {} } }, output, stream, state, usageState);

		expect(output.usage).toMatchObject({ input: 0, output: 22, totalTokens: 22 });
		expect(output.usage.reasoningTokens).toBeUndefined();
	});

	it("records checkpoint context occupancy after the turn started streaming output", async () => {
		// `tokenDetails.usedTokens` counts the whole conversation, not this
		// turn's output: skipping it once a `tokenDelta` arrived left compaction
		// and handoff sizing the context from output tokens alone.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState = { sawTokenDelta: false };
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];

		processInteractionUpdate(
			{ message: { case: "tokenDelta", value: { tokens: 24_000 } } },
			output,
			stream,
			state,
			usageState,
		);
		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
						tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 89_000 }),
					}),
				},
			}),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			undefined,
			usageState,
			[],
		);

		expect(output.usage.contextTokens).toBe(89_000);
		expect(output.usage.output).toBe(24_000);
	});
});
