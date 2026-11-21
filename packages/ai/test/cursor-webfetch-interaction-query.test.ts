import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { InteractionQuery, InteractionResponse } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	FetchArgsSchema,
	InteractionQuerySchema,
	WebFetchRequestQuerySchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6-xhigh-fast",
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

function decodeClientFrame(frame: Buffer): AgentClientMessage {
	const length = frame.readUInt32BE(1);
	return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function expectInteractionResponse(frames: AgentClientMessage[]): InteractionResponse {
	expect(frames).toHaveLength(1);
	const frame = frames[0];
	if (frame?.message.case !== "interactionResponse") {
		throw new Error("expected an interactionResponse frame");
	}
	return frame.message.value;
}

async function dispatchQuery(query: InteractionQuery): Promise<AgentClientMessage[]> {
	const written: Buffer[] = [];
	const h2Request = {
		write: (chunk: Buffer) => {
			written.push(chunk);
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];

	await handleServerMessage(
		create(AgentServerMessageSchema, {
			message: {
				case: "interactionQuery",
				value: query,
			},
		}),
		cursorAssistantMessage(),
		new AssistantMessageEventStream(),
		newBlockState(),
		new Map(),
		h2Request,
		undefined,
		undefined,
		{ sawTokenDelta: false },
		[],
	);

	return written.map(decodeClientFrame);
}

describe("Cursor interaction queries", () => {
	it("approves hosted WebFetch permission queries", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 18,
					query: {
						case: "webFetchRequestQuery",
						value: create(WebFetchRequestQuerySchema, {
							args: create(FetchArgsSchema, { url: "https://example.com", toolCallId: "fetch-2" }),
						}),
					},
				}),
			),
		);
		expect(response.id).toBe(18);
		expect(response.result.case).toBe("webFetchRequestResponse");
		if (response.result.case !== "webFetchRequestResponse") return;
		expect(response.result.value.result.case).toBe("approved");
	});

	it("approves an unknown permission-shaped query variant with a decodable frame", async () => {
		// Simulate a Cursor build newer than this proto: query variant on
		// field 12 (LEN), which the schema does not name. The reply must carry
		// `approved {}` on the same field number — and stay decodable: unknown
		// LEN fields store raw wire bytes INCLUDING the length varint, so a
		// missing prefix corrupts every byte after it in the frame.
		const idOnly = toBinary(InteractionQuerySchema, create(InteractionQuerySchema, { id: 21 }));
		const unknownVariant = new Uint8Array([0x62, 0x02, 0x0a, 0x00]); // field 12, LEN 2: approved {}
		const raw = new Uint8Array(idOnly.length + unknownVariant.length);
		raw.set(idOnly, 0);
		raw.set(unknownVariant, idOnly.length);

		const frames = await dispatchQuery(fromBinary(InteractionQuerySchema, raw));
		const response = expectInteractionResponse(frames);
		expect(response.id).toBe(21);
		expect(response.result.case).toBeUndefined();
		expect(response.$unknown).toEqual([{ no: 12, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }]);
	});
});

describe("Cursor hosted fetch tool calls", () => {
	function startToolCall(toolCall: object): AssistantMessage {
		const output = cursorAssistantMessage();
		processInteractionUpdate(
			{ message: { case: "toolCallStarted", value: { callId: "envelope-fetch", toolCall } } } as never,
			output,
			new AssistantMessageEventStream(),
			newBlockState(),
			{ sawTokenDelta: false },
		);
		return output;
	}

	it("detects an unnamed field-37 fetch call from a well-formed $unknown entry", () => {
		const data = new TextEncoder().encode("\x15https://example.com/doc");
		const output = startToolCall({ $unknown: [{ no: 37, wireType: 2, data }] });
		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		expect(block?.name).toBe("web_fetch");
		expect(block?.arguments).toEqual({ url: "https://example.com/doc" });
	});

	it("ignores malformed $unknown entries instead of treating them as a hosted fetch", () => {
		// protobuf-es only produces `{ no, wireType, data: Uint8Array }`; an entry
		// missing `data` is not a wire field and must not mint a web_fetch call.
		const output = startToolCall({ $unknown: [{ no: 37, wireType: 2 }] });
		expect(output.content.some(b => b.type === "toolCall" && b.name === "web_fetch")).toBe(false);
	});
});
