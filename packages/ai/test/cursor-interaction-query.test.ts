import { describe, expect, it } from "bun:test";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import type {
	AssistantMessage,
	CursorAskQuestionCall,
	CursorAskQuestionResult,
	CursorExecHandlers,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AskQuestionArgs_OptionSchema,
	AskQuestionArgs_QuestionSchema,
	AskQuestionArgsSchema,
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

async function dispatchQuery(
	query: InteractionQuery,
	execHandlers?: CursorExecHandlers,
	onToolResult?: (result: ToolResultMessage) => ToolResultMessage | undefined,
	output: AssistantMessage = cursorAssistantMessage(),
	signal?: AbortSignal,
): Promise<Buffer[]> {
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
		output,
		new AssistantMessageEventStream(),
		emptyBlockState(),
		new Map(),
		h2Request,
		execHandlers,
		onToolResult,
		{ sawTokenDelta: false },
		[],
		[],
		undefined,
		false,
		signal,
	);
	return frames;
}

function askQuery(
	id: number,
	asyncFlags: { runAsync?: boolean; asyncOriginalToolCallId?: string } = {},
): InteractionQuery {
	return create(InteractionQuerySchema, {
		id,
		query: {
			case: "askQuestionInteractionQuery",
			value: create(AskQuestionInteractionQuerySchema, {
				toolCallId: "tool_ask_1",
				args: create(AskQuestionArgsSchema, {
					title: "Pick storage",
					...asyncFlags,
					questions: [
						create(AskQuestionArgs_QuestionSchema, {
							id: "db",
							prompt: "Database?",
							options: [
								create(AskQuestionArgs_OptionSchema, { id: "sqlite", label: "SQLite" }),
								create(AskQuestionArgs_OptionSchema, { id: "pg", label: "Postgres" }),
							],
						}),
						create(AskQuestionArgs_QuestionSchema, {
							id: "extras",
							prompt: "Extras?",
							allowMultiple: true,
							options: [
								create(AskQuestionArgs_OptionSchema, { id: "cache", label: "Cache" }),
								create(AskQuestionArgs_OptionSchema, { id: "queue", label: "Queue" }),
							],
						}),
					],
				}),
			}),
		},
	});
}

function askToolResult(text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool_ask_1",
		toolName: "ask",
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	};
}

describe("cursor native AskQuestion bridge", () => {
	it("answers through the host ask handler and maps labels back to option ids", async () => {
		const calls: CursorAskQuestionCall[] = [];
		const recorded: ToolResultMessage[] = [];
		const output = cursorAssistantMessage();
		const frames = await dispatchQuery(
			askQuery(30),
			{
				askQuestion: async (call): Promise<CursorAskQuestionResult> => {
					calls.push(call);
					return {
						toolResult: askToolResult("User answers: …"),
						answers: [
							{ selectedOptions: ["Postgres"] },
							{ selectedOptions: ["Cache", "Queue"], customInput: "and a CDN" },
						],
					};
				},
			},
			result => {
				recorded.push(result);
			},
			output,
		);

		expect(calls).toEqual([
			{
				toolCallId: "tool_ask_1",
				args: {
					i: "Pick storage",
					questions: [
						{ id: "db", question: "Database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
						{ id: "extras", question: "Extras?", options: [{ label: "Cache" }, { label: "Queue" }], multi: true },
					],
				},
			},
		]);
		expect(output.content).toMatchObject([{ type: "toolCall", id: "tool_ask_1", name: "ask" }]);
		expect(recorded).toMatchObject([{ toolCallId: "tool_ask_1", toolName: "ask", isError: false }]);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 30,
			result: {
				case: "askQuestionInteractionResponse",
				value: {
					result: {
						result: {
							case: "success",
							value: {
								answers: [
									{ questionId: "db", selectedOptionIds: ["pg"], freeformText: "" },
									{ questionId: "extras", selectedOptionIds: ["cache", "queue"], freeformText: "and a CDN" },
								],
							},
						},
					},
				},
			},
		});
	});

	it("records the cancellation inside the abort event and drops the handler's late result", async () => {
		// The Agent finalizes an aborted turn without waiting for the provider; the
		// resolved `ask` block is paired only if its result is reserved by then.
		const controller = new AbortController();
		const recorded: ToolResultMessage[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const dispatched = dispatchQuery(
			askQuery(37),
			{
				askQuestion: async () => {
					handlerStarted.resolve();
					await release.promise;
					return { toolResult: askToolResult("Ask input was cancelled", true) };
				},
			},
			result => {
				recorded.push(result);
				return result;
			},
			undefined,
			controller.signal,
		);
		await handlerStarted.promise;
		controller.abort();

		expect(recorded).toMatchObject([
			{
				toolCallId: "tool_ask_1",
				toolName: "ask",
				isError: true,
				content: [{ type: "text", text: "Question was cancelled" }],
			},
		]);
		release.resolve();
		const frames = await dispatched;
		expect(recorded).toHaveLength(1);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 37,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected", value: { reason: "Question was cancelled" } } } },
			},
		});
	});

	it("rejects a question that arrives after the abort without filing it", async () => {
		const controller = new AbortController();
		controller.abort();
		const output = cursorAssistantMessage();
		let called = false;
		const frames = await dispatchQuery(
			askQuery(38),
			{
				askQuestion: async () => {
					called = true;
					return { toolResult: askToolResult("unreachable") };
				},
			},
			undefined,
			output,
			controller.signal,
		);
		expect(called).toBe(false);
		expect(output.content).toEqual([]);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			result: { value: { result: { result: { case: "rejected" } } } },
		});
	});

	it("calls a class-method handler with its own receiver", async () => {
		class Handlers implements CursorExecHandlers {
			#answer = "Postgres";
			async askQuestion(): Promise<CursorAskQuestionResult> {
				return { toolResult: askToolResult("User answers: …"), answers: [{ selectedOptions: [this.#answer] }] };
			}
		}
		const frames = await dispatchQuery(askQuery(33), new Handlers());
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 33,
			result: {
				case: "askQuestionInteractionResponse",
				value: {
					result: {
						result: {
							case: "success",
							value: {
								answers: [
									{ questionId: "db", selectedOptionIds: ["pg"] },
									{ questionId: "extras", selectedOptionIds: [] },
								],
							},
						},
					},
				},
			},
		});
	});

	it("rejects with the host-rewritten text when ask fails", async () => {
		const frames = await dispatchQuery(
			askQuery(35),
			{ askQuestion: async () => ({ toolResult: askToolResult("token sk-123 rejected", true) }) },
			result => ({ ...result, content: [{ type: "text", text: "token [redacted] rejected" }] }),
		);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 35,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected", value: { reason: "token [redacted] rejected" } } } },
			},
		});
	});

	it("records a failed ask and rejects with the host-rewritten text when the handler throws", async () => {
		const recorded: ToolResultMessage[] = [];
		const frames = await dispatchQuery(
			askQuery(36),
			{
				askQuestion: async () => {
					throw new Error("dialog crashed at /secret/path");
				},
			},
			result => {
				recorded.push(result);
				return { ...result, content: [{ type: "text", text: "dialog crashed" }] };
			},
		);
		expect(recorded).toMatchObject([{ toolCallId: "tool_ask_1", toolName: "ask", isError: true }]);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 36,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected", value: { reason: "dialog crashed" } } } },
			},
		});
	});

	it("does not send the original answers when the host rewrites a successful ask", async () => {
		const frames = await dispatchQuery(
			askQuery(39),
			{
				askQuestion: async () => ({
					toolResult: askToolResult('User answers: db: "my password is hunter2"'),
					answers: [{ selectedOptions: [], customInput: "my password is hunter2" }, { selectedOptions: [] }],
				}),
			},
			result => ({ ...result, content: [{ type: "text", text: "User answers: db: [redacted]" }] }),
		);
		const response = decodeConnectFrame(frames[0]!).message.value;
		expect(response).toMatchObject({
			id: 39,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected", value: { reason: "User answers: db: [redacted]" } } } },
			},
		});
		expect(JSON.stringify(response)).not.toContain("hunter2");
	});

	it.each([
		["async questions", { runAsync: true }],
		["an async question's completion frame", { asyncOriginalToolCallId: "tool_ask_0" }],
	])("rejects %s without opening the dialog", async (_label, asyncFlags) => {
		let called = false;
		const frames = await dispatchQuery(askQuery(32, asyncFlags), {
			askQuestion: async () => {
				called = true;
				return { toolResult: askToolResult("unreachable") };
			},
		});
		expect(called).toBe(false);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			id: 32,
			result: {
				case: "askQuestionInteractionResponse",
				value: { result: { result: { case: "rejected", value: { reason: expect.stringContaining("Async") } } } },
			},
		});
	});
});

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

describe("cursor native AskQuestion label mapping", () => {
	function collidingQuery(): InteractionQuery {
		const option = (id: string, label: string) => create(AskQuestionArgs_OptionSchema, { id, label });
		return create(InteractionQuerySchema, {
			id: 40,
			query: {
				case: "askQuestionInteractionQuery",
				value: create(AskQuestionInteractionQuerySchema, {
					toolCallId: "tool_ask_1",
					args: create(AskQuestionArgsSchema, {
						questions: [
							create(AskQuestionArgs_QuestionSchema, {
								id: "go",
								prompt: "Proceed?",
								options: [option("yes_now", "Yes"), option("yes_later", "Yes"), option("other", "Other")],
							}),
							create(AskQuestionArgs_QuestionSchema, {
								id: "go",
								prompt: "Which parts?",
								allowMultiple: true,
								options: [option("done", "Done"), option("all", "All")],
							}),
							create(AskQuestionArgs_QuestionSchema, {
								prompt: "Notes?",
								options: [option("none", "Other")],
							}),
						],
					}),
				}),
			},
		});
	}

	it("renames colliding labels and ids so every Cursor option id is reachable", async () => {
		const calls: CursorAskQuestionCall[] = [];
		const frames = await dispatchQuery(collidingQuery(), {
			askQuestionReservedLabels: multi => (multi ? ["Other", "Done"] : ["Other"]),
			askQuestion: async (call): Promise<CursorAskQuestionResult> => {
				calls.push(call);
				return {
					toolResult: askToolResult("User answers: …"),
					answers: [
						{ selectedOptions: ["Yes (2)"] },
						{ selectedOptions: ["Done (2)", "All"] },
						{ selectedOptions: ["Other (2)"] },
					],
				};
			},
		});

		expect(calls[0]?.args).toEqual({
			i: "Question from the model",
			questions: [
				{
					id: "go",
					question: "Proceed?",
					options: [{ label: "Yes" }, { label: "Yes (2)" }, { label: "Other (2)" }],
				},
				{ id: "go (2)", question: "Which parts?", options: [{ label: "Done (2)" }, { label: "All" }], multi: true },
				{ id: "q3", question: "Notes?", options: [{ label: "Other (2)" }] },
			],
		});
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject({
			result: {
				value: {
					result: {
						result: {
							case: "success",
							value: {
								answers: [
									{ questionId: "go", selectedOptionIds: ["yes_later"] },
									{ questionId: "go", selectedOptionIds: ["done", "all"] },
									{ questionId: "", selectedOptionIds: ["none"] },
								],
							},
						},
					},
				},
			},
		});
	});
});
