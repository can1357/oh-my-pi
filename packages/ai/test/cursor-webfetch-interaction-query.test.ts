import { describe, expect, it } from "bun:test";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { InteractionQuery, InteractionResponse } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AskQuestionInteractionQuerySchema,
	CreatePlanRequestQuerySchema,
	ExaFetchArgsSchema,
	ExaFetchRequestQuerySchema,
	ExaSearchArgsSchema,
	ExaSearchRequestQuerySchema,
	FetchArgsSchema,
	InteractionQuerySchema,
	SwitchModeRequestQuerySchema,
	WebFetchRequestQuerySchema,
	WebSearchArgsSchema,
	WebSearchRequestQuerySchema,
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
	it("approves hosted web search so the turn is not left waiting on permission", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 11,
					query: {
						case: "webSearchRequestQuery",
						value: create(WebSearchRequestQuerySchema, {
							args: create(WebSearchArgsSchema, { searchTerm: "Grok Bot use cases", toolCallId: "ws-1" }),
						}),
					},
				}),
			),
		);
		expect(response.id).toBe(11);
		expect(response.result.case).toBe("webSearchRequestResponse");
		if (response.result.case !== "webSearchRequestResponse") return;
		expect(response.result.value.result.case).toBe("approved");
	});

	it("approves Exa fetch, the permission prompt that stalled cursor-grok-4.6-xhigh", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 12,
					query: {
						case: "exaFetchRequestQuery",
						value: create(ExaFetchRequestQuerySchema, {
							args: create(ExaFetchArgsSchema, {
								ids: ["https://docs.x.ai/grok-bot/use-cases"],
								toolCallId: "fetch-1",
							}),
						}),
					},
				}),
			),
		);
		expect(response.id).toBe(12);
		expect(response.result.case).toBe("exaFetchRequestResponse");
		if (response.result.case !== "exaFetchRequestResponse") return;
		expect(response.result.value.result.case).toBe("approved");
	});

	it("approves Exa search", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 13,
					query: {
						case: "exaSearchRequestQuery",
						value: create(ExaSearchRequestQuerySchema, {
							args: create(ExaSearchArgsSchema, {
								query: "Grok Bot",
								type: "auto",
								numResults: 5,
								toolCallId: "es-1",
							}),
						}),
					},
				}),
			),
		);
		expect(response.result.case).toBe("exaSearchRequestResponse");
		if (response.result.case !== "exaSearchRequestResponse") return;
		expect(response.result.value.result.case).toBe("approved");
	});

	it("rejects ask-question instead of leaving the query unanswered", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 14,
					query: {
						case: "askQuestionInteractionQuery",
						value: create(AskQuestionInteractionQuerySchema, { toolCallId: "ask-1" }),
					},
				}),
			),
		);
		expect(response.result.case).toBe("askQuestionInteractionResponse");
		if (response.result.case !== "askQuestionInteractionResponse") return;
		expect(response.result.value.result?.result.case).toBe("rejected");
	});

	it("rejects mode switches", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 15,
					query: {
						case: "switchModeRequestQuery",
						value: create(SwitchModeRequestQuerySchema, {}),
					},
				}),
			),
		);
		expect(response.result.case).toBe("switchModeRequestResponse");
		if (response.result.case !== "switchModeRequestResponse") return;
		expect(response.result.value.result.case).toBe("rejected");
	});

	it("errors create-plan so the server is not blocked on a plan URI", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 16,
					query: {
						case: "createPlanRequestQuery",
						value: create(CreatePlanRequestQuerySchema, { toolCallId: "plan-1" }),
					},
				}),
			),
		);
		expect(response.result.case).toBe("createPlanRequestResponse");
		if (response.result.case !== "createPlanRequestResponse") return;
		expect(response.result.value.result?.result.case).toBe("error");
	});

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

	it("does not invent a reply for an unknown query variant", async () => {
		const frames = await dispatchQuery(create(InteractionQuerySchema, { id: 17 }));
		expect(frames).toHaveLength(0);
	});
});
