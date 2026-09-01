import { describe, expect, it } from "bun:test";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AskQuestionInteractionQuerySchema,
	CreatePlanRequestQuerySchema,
	ExaFetchRequestQuerySchema,
	ExaSearchRequestQuerySchema,
	type InteractionQuery,
	InteractionQuerySchema,
	SetupVmEnvironmentArgsSchema,
	SwitchModeRequestQuerySchema,
	WebSearchRequestQuerySchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array };
type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] };

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function emptyBlockState(): BlockState {
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

function decodeConnectFrame(frame: Buffer): AgentClientMessage {
	return fromBinary(AgentClientMessageSchema, frame.subarray(5));
}

async function dispatchQuery(query: InteractionQuery): Promise<Buffer[]> {
	const frames: Buffer[] = [];
	const h2Request = {
		write(chunk: Buffer) {
			frames.push(chunk);
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];
	const serverMsg = create(AgentServerMessageSchema, {
		message: { case: "interactionQuery", value: query },
	});
	await handleServerMessage(
		serverMsg,
		cursorAssistantMessage(),
		new AssistantMessageEventStream(),
		emptyBlockState(),
		new Map(),
		h2Request,
		undefined,
		undefined,
		{ sawTokenDelta: false },
		[],
	);
	return frames;
}

describe("cursor interaction query handshake", () => {
	it("approves hosted web search so the Run RPC can continue", async () => {
		const frames = await dispatchQuery(
			create(InteractionQuerySchema, {
				id: 11,
				query: { case: "webSearchRequestQuery", value: create(WebSearchRequestQuerySchema, {}) },
			}),
		);
		expect(frames).toHaveLength(1);
		const client = decodeConnectFrame(frames[0]!);
		expect(client.message.case).toBe("interactionResponse");
		expect(client.message.value).toMatchObject({
			id: 11,
			result: { case: "webSearchRequestResponse", value: { result: { case: "approved" } } },
		});
	});

	it("approves hosted Exa search and fetch permission queries", async () => {
		const search = await dispatchQuery(
			create(InteractionQuerySchema, {
				id: 12,
				query: { case: "exaSearchRequestQuery", value: create(ExaSearchRequestQuerySchema, {}) },
			}),
		);
		const fetch = await dispatchQuery(
			create(InteractionQuerySchema, {
				id: 13,
				query: { case: "exaFetchRequestQuery", value: create(ExaFetchRequestQuerySchema, {}) },
			}),
		);
		expect(decodeConnectFrame(search[0]!).message.value).toMatchObject({
			id: 12,
			result: { case: "exaSearchRequestResponse", value: { result: { case: "approved" } } },
		});
		expect(decodeConnectFrame(fetch[0]!).message.value).toMatchObject({
			id: 13,
			result: { case: "exaFetchRequestResponse", value: { result: { case: "approved" } } },
		});
	});

	it("approves unnamed field-9 permission queries used by hosted WebFetch", async () => {
		const query = create(InteractionQuerySchema, { id: 18 });
		const bag: ProtoUnknownBag = query; // protobuf-es unnamed query oneof (field 9)
		bag.$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }];
		const frames = await dispatchQuery(query);
		expect(frames).toHaveLength(1);
		const client = decodeConnectFrame(frames[0]!);
		expect(client.message.case).toBe("interactionResponse");
		if (client.message.case !== "interactionResponse") {
			throw new Error("expected interactionResponse");
		}
		expect(client.message.value.id).toBe(18);
		// The raw same-field reply must round-trip: under the current proto,
		// field 9 is named, so a correctly length-prefixed `approved {}` payload
		// decodes as an approved webFetchRequestResponse. A missing LEN prefix
		// would fail this decode (regression contract for the wire framing).
		expect(client.message.value.result).toMatchObject({
			case: "webFetchRequestResponse",
			value: { result: { case: "approved" } },
		});
	});

	it("rejects interactive ask / switch-mode / create-plan queries", async () => {
		const ask = decodeConnectFrame(
			(
				await dispatchQuery(
					create(InteractionQuerySchema, {
						id: 14,
						query: { case: "askQuestionInteractionQuery", value: create(AskQuestionInteractionQuerySchema, {}) },
					}),
				)
			)[0]!,
		);
		const mode = decodeConnectFrame(
			(
				await dispatchQuery(
					create(InteractionQuerySchema, {
						id: 15,
						query: { case: "switchModeRequestQuery", value: create(SwitchModeRequestQuerySchema, {}) },
					}),
				)
			)[0]!,
		);
		const plan = decodeConnectFrame(
			(
				await dispatchQuery(
					create(InteractionQuerySchema, {
						id: 16,
						query: { case: "createPlanRequestQuery", value: create(CreatePlanRequestQuerySchema, {}) },
					}),
				)
			)[0]!,
		);
		expect(ask.message.value).toMatchObject({
			id: 14,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected" } } },
			},
		});
		expect(mode.message.value).toMatchObject({
			id: 15,
			result: { case: "switchModeRequestResponse", value: { result: { case: "rejected" } } },
		});
		expect(plan.message.value).toMatchObject({
			id: 16,
			result: { case: "createPlanRequestResponse", value: { result: { result: { case: "error" } } } },
		});
	});

	it("does not invent a VM success or a reply for an empty query", async () => {
		const vm = await dispatchQuery(
			create(InteractionQuerySchema, {
				id: 19,
				query: { case: "setupVmEnvironmentArgs", value: create(SetupVmEnvironmentArgsSchema, {}) },
			}),
		);
		const empty = await dispatchQuery(create(InteractionQuerySchema, { id: 17 }));
		expect(vm).toEqual([]);
		expect(empty).toEqual([]);
	});
});
