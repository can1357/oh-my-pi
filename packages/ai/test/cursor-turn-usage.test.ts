import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
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

	it("excludes cache hits and writes from fresh input", () => {
		// Cursor's `inputTokens` counts the whole prompt, cache hits and writes
		// included. Recording it as-is next to `cacheRead` bills and counts every
		// cached token twice.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState = { sawTokenDelta: true };

		processInteractionUpdate(
			{
				message: {
					case: "turnEnded",
					value: {
						inputTokens: 100n,
						outputTokens: 7n,
						cacheReadTokens: 60n,
						cacheWriteTokens: 15n,
						reasoningTokens: 2n,
					},
				},
			},
			output,
			stream,
			state,
			usageState,
		);

		expect(output.usage).toMatchObject({
			input: 25,
			output: 7,
			cacheRead: 60,
			cacheWrite: 15,
			reasoningTokens: 2,
			totalTokens: 107,
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
		const h2Request = { write: (_frame: Uint8Array): void => {} };

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

	it("keeps a real checkpoint occupancy beside a huge cache bill", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState: UsageState = { sawTokenDelta: false, contextWindow: 500_000 };

		processInteractionUpdate(
			{
				message: {
					case: "turnEnded",
					value: { inputTokens: 5_695_246n, outputTokens: 23_633n, cacheReadTokens: 5_601_408n },
				},
			},
			output,
			stream,
			state,
			usageState,
		);
		await checkpoint(output, stream, state, usageState, 264_400);

		expect(output.usage).toMatchObject({ input: 93_838, cacheRead: 5_601_408, totalTokens: 5_718_879 });
		expect(output.usage.contextTokens).toBe(264_400);
	});

	it("rejects an over-window cache bill without inventing a context occupancy", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState: UsageState = { sawTokenDelta: false, contextWindow: 500_000 };

		processInteractionUpdate(
			{
				message: {
					case: "turnEnded",
					value: { inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n },
				},
			},
			output,
			stream,
			state,
			usageState,
		);
		await checkpoint(output, stream, state, usageState, 892_018);

		expect(output.usage).toMatchObject({
			input: 6_374,
			output: 2_828,
			cacheRead: 882_816,
			totalTokens: 892_018,
			contextTokens: 0,
		});
	});

	it("rejects an over-window bill checkpoint that arrived before turnEnded", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const usageState: UsageState = { sawTokenDelta: false, contextWindow: 500_000 };

		await checkpoint(output, stream, state, usageState, 892_018);
		expect(output.usage.contextTokens).toBe(892_018);

		processInteractionUpdate(
			{
				message: {
					case: "turnEnded",
					value: { inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n },
				},
			},
			output,
			stream,
			state,
			usageState,
		);

		expect(output.usage.contextTokens).toBe(0);
	});

	it.each([true, false])(
		"keeps an earlier real checkpoint when the bill echo arrives (turnEnded first: %s)",
		async endedFirst => {
			const output = cursorAssistantMessage();
			const stream = new AssistantMessageEventStream();
			const state = newBlockState();
			const usageState: UsageState = { sawTokenDelta: false, contextWindow: 500_000 };
			const update: InteractionUpdate = {
				message: {
					case: "turnEnded",
					value: { inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n },
				},
			};
			if (endedFirst) processInteractionUpdate(update, output, stream, state, usageState);
			await checkpoint(output, stream, state, usageState, 264_400);
			await checkpoint(output, stream, state, usageState, 892_018);
			if (!endedFirst) processInteractionUpdate(update, output, stream, state, usageState);

			expect(output.usage.contextTokens).toBe(264_400);
			expect(output.usage.totalTokens).toBe(892_018);
			await checkpoint(output, stream, state, usageState, 280_000);
			expect(output.usage.contextTokens).toBe(280_000);
		},
	);

	it.each([
		{ contextWindow: 500_000, input: 100n, output: 7n, cacheRead: 60n, cacheWrite: 15n, usedTokens: 107 },
		{
			contextWindow: 500_000,
			input: 350_000n,
			output: 1_000n,
			cacheRead: 0n,
			cacheWrite: 340_000n,
			usedTokens: 351_000,
		},
		{
			contextWindow: 500_000,
			input: 889_190n,
			output: 2_828n,
			cacheRead: 882_816n,
			cacheWrite: 0n,
			usedTokens: 510_000,
		},
		{
			contextWindow: 892_018,
			input: 889_190n,
			output: 2_828n,
			cacheRead: 882_816n,
			cacheWrite: 0n,
			usedTokens: 892_018,
		},
		{ contextWindow: 0, input: 889_190n, output: 2_828n, cacheRead: 882_816n, cacheWrite: 0n, usedTokens: 892_018 },
	])(
		"keeps a checkpoint without independent evidence of a bill echo ($usedTokens / $contextWindow)",
		async scenario => {
			const output = cursorAssistantMessage();
			const stream = new AssistantMessageEventStream();
			const state = newBlockState();
			const usageState: UsageState = { sawTokenDelta: false, contextWindow: scenario.contextWindow };
			processInteractionUpdate(
				{
					message: {
						case: "turnEnded",
						value: {
							inputTokens: scenario.input,
							outputTokens: scenario.output,
							cacheReadTokens: scenario.cacheRead,
							cacheWriteTokens: scenario.cacheWrite,
						},
					},
				},
				output,
				stream,
				state,
				usageState,
			);
			await checkpoint(output, stream, state, usageState, scenario.usedTokens);

			expect(output.usage.contextTokens).toBe(scenario.usedTokens);
		},
	);
});

async function checkpoint(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
	usedTokens: number,
): Promise<void> {
	await handleServerMessage(
		create(AgentServerMessageSchema, {
			message: {
				case: "conversationCheckpointUpdate",
				value: create(ConversationStateStructureSchema, {
					tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }),
				}),
			},
		}),
		output,
		stream,
		state,
		new Map(),
		{ write: (_frame: Uint8Array): void => {} },
		undefined,
		undefined,
		usageState,
		[],
	);
}
