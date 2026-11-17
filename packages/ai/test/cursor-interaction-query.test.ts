import { describe, expect, it } from "bun:test";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import { CursorExecOrder } from "@oh-my-pi/pi-ai/providers/cursor/exec-order";
import type {
	AssistantMessage,
	CursorExecHandlers,
	CursorToolResultHandler,
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
	run: {
		onToolResult?: CursorToolResultHandler;
		output?: AssistantMessage;
		state?: BlockState;
		signal?: AbortSignal;
	} = {},
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
		run.output ?? cursorAssistantMessage(),
		new AssistantMessageEventStream(),
		run.state ?? emptyBlockState(),
		new Map(),
		h2Request,
		execHandlers,
		run.onToolResult,
		{ sawTokenDelta: false },
		[],
		[],
		undefined,
		false,
		run.signal,
	);
	return frames;
}

const askOption = (id: string, label: string) => create(AskQuestionArgs_OptionSchema, { id, label });

/** Three questions with a repeated label, a repeated question id, and one without options or id. */
function askQuery(
	id: number,
	asyncFlags: { runAsync?: boolean; asyncOriginalToolCallId?: string } = {},
	toolCallId = "tool_ask_1",
): InteractionQuery {
	const questions = [
		create(AskQuestionArgs_QuestionSchema, {
			id: "db",
			prompt: "Database?",
			options: [askOption("sqlite", "SQLite"), askOption("pg", "Postgres"), askOption("pg_cloud", "Postgres")],
		}),
		create(AskQuestionArgs_QuestionSchema, {
			id: "db",
			prompt: "Extras?",
			allowMultiple: true,
			options: [askOption("cache", "Cache"), askOption("queue", "Queue")],
		}),
		create(AskQuestionArgs_QuestionSchema, { prompt: "Why?" }),
	];
	return create(InteractionQuerySchema, {
		id,
		query: {
			case: "askQuestionInteractionQuery",
			value: create(AskQuestionInteractionQuerySchema, {
				toolCallId,
				args: create(AskQuestionArgsSchema, { title: "Pick storage", ...asyncFlags, questions }),
			}),
		},
	});
}

const askQueryForm =
	"<form><p>Pick storage</p>" +
	'<fieldset><legend>Database?</legend><label><input type="radio" name="cursor_q1" value="sqlite"> SQLite</label><label><input type="radio" name="cursor_q1" value="pg"> Postgres</label><label><input type="radio" name="cursor_q1" value="pg_cloud"> Postgres</label></fieldset>' +
	'<fieldset><legend>Extras?</legend><label><input type="checkbox" name="cursor_q2" value="cache"> Cache</label><label><input type="checkbox" name="cursor_q2" value="queue"> Queue</label></fieldset>' +
	'<fieldset><label>Why? <input type="text" name="cursor_q3"></label></fieldset>' +
	"</form>";

/** Matchers for the interaction response Cursor receives. */
const askResponse = (id: number, result: unknown) => ({
	id,
	result: { case: "askQuestionInteractionResponse", value: { result: { result } } },
});
const rejected = (reason: unknown) => ({ case: "rejected", value: { reason } });

/** An `ask` tool result; `details.data` is the submitted form data. */
function askToolResult(text: string, details?: unknown, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool_ask_1",
		toolName: "ask",
		content: [{ type: "text", text }],
		details,
		isError,
		timestamp: 1,
	};
}

describe("cursor native AskQuestion bridge", () => {
	it("answers through the host ask handler with option ids and typed text", async () => {
		const calls: unknown[] = [];
		const recorded: ToolResultMessage[] = [];
		const output = cursorAssistantMessage();
		const frames = await dispatchQuery(
			askQuery(30),
			{
				askQuestion: async call => {
					calls.push(call);
					return askToolResult("User answers: …", {
						data: { cursor_q1: "pg_cloud", cursor_q2: ["cache", "queue", "and a CDN"], cursor_q3: "because" },
					});
				},
			},
			{ output, onToolResult: result => void recorded.push(result) },
		);

		expect(calls).toEqual([{ toolCallId: "tool_ask_1", args: { html: askQueryForm } }]);
		expect(output.content).toMatchObject([{ type: "toolCall", id: "tool_ask_1", name: "ask" }]);
		expect(recorded).toMatchObject([{ toolCallId: "tool_ask_1", toolName: "ask", isError: false }]);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject(
			askResponse(30, {
				case: "success",
				value: {
					answers: [
						{ questionId: "db", selectedOptionIds: ["pg_cloud"], freeformText: "" },
						{ questionId: "db", selectedOptionIds: ["cache", "queue"], freeformText: "and a CDN" },
						{ questionId: "", selectedOptionIds: [], freeformText: "because" },
					],
				},
			}),
		);
	});

	it("shows one question at a time; an abort pairs the open one inside the abort event and skips the queued one", async () => {
		// The Agent finalizes an aborted turn without waiting for the handler; the
		// resolved `ask` block is paired only if its result is reserved by then.
		const state = emptyBlockState();
		state.execOrder = new CursorExecOrder();
		const controller = new AbortController();
		const opened: string[] = [];
		const recorded: ToolResultMessage[] = [];
		const handlers: CursorExecHandlers = {
			askQuestion: async call => {
				opened.push(call.toolCallId);
				const aborted = Promise.withResolvers<void>();
				call.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return askToolResult("Ask input was cancelled", undefined, true);
			},
		};
		const run = {
			state,
			signal: controller.signal,
			onToolResult: (result: ToolResultMessage) => void recorded.push(result),
		};
		const first = dispatchQuery(askQuery(40), handlers, run);
		const second = dispatchQuery(askQuery(41, {}, "tool_ask_2"), handlers, run);
		await Bun.sleep(0);
		expect(opened).toEqual(["tool_ask_1"]);
		controller.abort();
		expect(recorded).toMatchObject([
			{ toolCallId: "tool_ask_1", isError: true, content: [{ type: "text", text: "Question was cancelled" }] },
		]);

		expect(decodeConnectFrame((await first)[0]!).message.value).toMatchObject(
			askResponse(40, rejected("Ask input was cancelled")),
		);
		expect(decodeConnectFrame((await second)[0]!).message.value).toMatchObject(
			askResponse(41, rejected("Question was cancelled")),
		);
		expect(opened).toEqual(["tool_ask_1"]);
	});

	it("rejects a timed-out form and a result the host replaced", async () => {
		const answered = (details: object): CursorExecHandlers => ({
			askQuestion: async () => askToolResult("User answers: …", details),
		});
		// A timeout submits whatever the form held; that is not the user's answer.
		const timedOut = await dispatchQuery(askQuery(38), answered({ data: { cursor_q1: "pg" }, timedOut: true }));
		expect(decodeConnectFrame(timedOut[0]!).message.value).toMatchObject(
			askResponse(38, rejected("User answers: …")),
		);
		// A replacement without the form data no longer carries the answer.
		const replaced = await dispatchQuery(askQuery(39), answered({ data: { cursor_q1: "pg" } }), {
			onToolResult: () => askToolResult("Blocked by policy"),
		});
		expect(decodeConnectFrame(replaced[0]!).message.value).toMatchObject(
			askResponse(39, rejected("Blocked by policy")),
		);
	});

	it.each([
		["async questions", { runAsync: true }],
		["an async question's completion frame", { asyncOriginalToolCallId: "tool_ask_0" }],
	])("rejects %s without opening the dialog", async (_label, asyncFlags) => {
		let called = false;
		const frames = await dispatchQuery(askQuery(32, asyncFlags), {
			askQuestion: async () => {
				called = true;
				return askToolResult("unreachable");
			},
		});
		expect(called).toBe(false);
		expect(decodeConnectFrame(frames[0]!).message.value).toMatchObject(
			askResponse(32, rejected(expect.stringContaining("Async"))),
		);
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
