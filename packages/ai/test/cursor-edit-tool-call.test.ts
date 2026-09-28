import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	flushOpenToolCalls,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type {
	AssistantMessage,
	CursorExecHandlers,
	CursorToolResultHandler,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved, kStreamingBlockKind } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	EditErrorSchema,
	EditResultSchema,
	EditToolCallSchema,
	ExecServerMessageSchema,
	ReadArgsSchema,
	ToolCallSchema,
	WriteArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const EDIT_ID = "tool_7aef3020-f275-4579-887c-34106e146f7";
const ENVELOPE_ID = "call-edit-1";
const TARGET = "/tmp/omp-cursor-edit-probe/note.txt";

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

function newBlockState(onToolResult?: CursorToolResultHandler): BlockState {
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
		execDedupeMap: new Map(),
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
		onToolResult,
	};
}

function editToolCall(path: string, streamContent?: string) {
	return {
		toolCallId: EDIT_ID,
		tool: {
			case: "editToolCall" as const,
			value: { args: { path, streamContent } },
		},
	};
}

function startEdit(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallStarted",
				value: { callId: ENVELOPE_ID, toolCall: editToolCall(TARGET, "orange") },
			},
		},
		output,
		stream,
		state,
		{ sawTokenDelta: false },
	);
}

function mockH2() {
	const written: unknown[] = [];
	return {
		written,
		h2Request: {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5],
	};
}

function execRead(value: { path?: string; toolCallId?: string }) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-readArgs",
				message: { case: "readArgs", value: create(ReadArgsSchema, value) },
			}),
		},
	});
}

function execWrite(value: { path?: string; fileText?: string; toolCallId?: string }) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-writeArgs",
				message: { case: "writeArgs", value: create(WriteArgsSchema, value) },
			}),
		},
	});
}

describe("cursor native editToolCall (StrReplace)", () => {
	it("opens one edit block and does not synthesize read/write cards for its materialization", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const toolResults: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			toolResults.push(result);
			return result;
		});
		const readPaths: string[] = [];
		const { h2Request } = mockH2();
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				readPaths.push(args.path);
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "Hello from OMP probe.\nThe fruit is apple.\nGoodbye.\n" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
			async write(args) {
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "write",
					content: [{ type: "text", text: "wrote" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage;
			},
		};

		startEdit(output, stream, state);

		await handleServerMessage(
			execRead({ path: TARGET, toolCallId: EDIT_ID }),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			result => {
				toolResults.push(result);
				return result;
			},
			{ sawTokenDelta: false },
			[],
		);
		await handleServerMessage(
			execWrite({
				path: TARGET,
				toolCallId: EDIT_ID,
				fileText: "Hello from OMP probe.\nThe fruit is orange.\nGoodbye.\n",
			}),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			result => {
				toolResults.push(result);
				return result;
			},
			{ sawTokenDelta: false },
			[],
		);

		processInteractionUpdate(
			{
				message: {
					case: "toolCallCompleted",
					value: { callId: ENVELOPE_ID, toolCall: editToolCall(TARGET, "orange") },
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const calls = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("edit");
		expect(calls[0]?.id).toBe(EDIT_ID);
		expect(calls[0]?.[kStreamingBlockKind]).toBe("cursor-edit");
		expect(calls[0]?.[kCursorExecResolved]).toBe(true);
		expect(calls[0]?.arguments).toEqual({ path: TARGET, stream_content: "orange" });
		expect(readPaths).toEqual([`${TARGET}:raw`]);
		expect(toolResults.map(result => result.toolName)).toEqual(["edit"]);
		expect(toolResults[0]?.toolCallId).toBe(EDIT_ID);
		expect(toolResults[0]?.isError).toBe(false);
	});

	it("still synthesizes a read block when the exec id is not an editToolCall", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const { h2Request } = mockH2();
		const readPaths: string[] = [];
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				readPaths.push(args.path);
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "plain" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		};

		await handleServerMessage(
			execRead({ path: TARGET, toolCallId: "call-read-plain" }),
			output,
			stream,
			newBlockState(),
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		const calls = output.content.filter(block => block.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
		expect(readPaths).toEqual([`${TARGET}:raw`]);
	});

	/** Materialize `fullText` through a capped local read and return Cursor's decoded read result. */
	async function materializeCappedRead(fullText: string) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-edit-full-"));
		try {
			const target = path.join(dir, "big.txt");
			await Bun.write(target, fullText);
			const output = cursorAssistantMessage();
			const stream = new AssistantMessageEventStream();
			const state = newBlockState();
			const { h2Request, written } = mockH2();
			startEdit(output, stream, state);
			await handleServerMessage(
				execRead({ path: target, toolCallId: EDIT_ID }),
				output,
				stream,
				state,
				new Map(),
				h2Request,
				{
					async read() {
						return {
							role: "toolResult",
							toolCallId: EDIT_ID,
							toolName: "read",
							content: [{ type: "text", text: fullText.split("\n").slice(0, 300).join("\n") }],
							details: {
								fileSize: Buffer.byteLength(fullText),
								truncation: { truncated: true },
								meta: { source: { type: "path", value: target } },
							},
							isError: false,
							timestamp: 1,
						};
					},
				},
				undefined,
				{ sawTokenDelta: false },
				[],
			);
			const frame = written[0];
			if (!Buffer.isBuffer(frame)) throw new Error("expected Cursor response bytes");
			const answer = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + frame.readUInt32BE(1)));
			if (answer.message.case !== "execClientMessage" || answer.message.value.message.case !== "readResult") {
				throw new Error("expected read result");
			}
			return answer.message.value.message.value.result;
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it("provides the full file to StrReplace when the local raw read is capped", async () => {
		const fullText = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		const result = await materializeCappedRead(fullText);
		if (result.case !== "success" || result.value.output.case !== "content") throw new Error("expected text content");
		expect(result.value.truncated).toBe(false);
		expect(result.value.output.value).toBe(fullText);
	});

	it("fails StrReplace materialization instead of loading a file past the size cap", async () => {
		const line = `${"x".repeat(1023)}\n`;
		const result = await materializeCappedRead(line.repeat(4 * 1024 + 1));
		if (result.case !== "error") throw new Error(`expected read error, got ${result.case}`);
		expect(result.value.error).toContain("line-range read");
	});

	it("appends streamContentDelta onto the open edit block", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		startEdit(output, stream, state);

		processInteractionUpdate(
			{
				message: {
					case: "toolCallDelta",
					value: {
						callId: ENVELOPE_ID,
						toolCallDelta: {
							delta: { case: "editToolCallDelta", value: { streamContentDelta: " peel" } },
						},
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		if (block?.type !== "toolCall") throw new Error("expected edit block");
		expect(block.arguments.stream_content).toBe("orange peel");
	});

	it("pairs a wire EditResult error as a failed edit, not Edit completed", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const toolResults: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			toolResults.push(result);
			return result;
		});
		startEdit(output, stream, state);

		const completed = create(ToolCallSchema, {
			toolCallId: EDIT_ID,
			tool: {
				case: "editToolCall",
				value: create(EditToolCallSchema, {
					args: { path: TARGET, streamContent: "orange" },
					result: create(EditResultSchema, {
						result: {
							case: "error",
							value: create(EditErrorSchema, { path: TARGET, error: "permission denied" }),
						},
					}),
				}),
			},
		});
		processInteractionUpdate(
			{ message: { case: "toolCallCompleted", value: { callId: ENVELOPE_ID, toolCall: completed } } },
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.toolName).toBe("edit");
		expect(toolResults[0]?.isError).toBe(true);
		expect(
			toolResults[0]?.content.some(part => part.type === "text" && part.text.includes("permission denied")),
		).toBe(true);
	});

	it("pairs an interrupted cursor-edit when the transport dies before writeArgs", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const toolResults: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			toolResults.push(result);
			return result;
		});
		startEdit(output, stream, state);
		expect(toolResults).toHaveLength(0);

		flushOpenToolCalls(output, stream, state);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.toolCallId).toBe(EDIT_ID);
		expect(toolResults[0]?.toolName).toBe("edit");
		expect(toolResults[0]?.isError).toBe(true);
	});

	it("treats a completion with no EditResult as a failed edit", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const toolResults: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			toolResults.push(result);
			return result;
		});
		startEdit(output, stream, state);

		processInteractionUpdate(
			{
				message: {
					case: "toolCallCompleted",
					value: { callId: ENVELOPE_ID, toolCall: editToolCall(TARGET, "orange") },
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.isError).toBe(true);
		expect(toolResults[0]?.content.some(part => part.type === "text" && part.text.includes("no result"))).toBe(true);
	});

	it("does not invent a closed-connection error after writeArgs already paired", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const toolResults: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			toolResults.push(result);
			return result;
		});
		const { h2Request } = mockH2();
		const execHandlers: CursorExecHandlers = {
			async write(args) {
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "write",
					content: [{ type: "text", text: "wrote" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage;
			},
		};
		startEdit(output, stream, state);
		await handleServerMessage(
			execWrite({ path: TARGET, toolCallId: EDIT_ID, fileText: "orange\n" }),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			result => {
				toolResults.push(result);
				return result;
			},
			{ sawTokenDelta: false },
			[],
		);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.isError).toBe(false);

		flushOpenToolCalls(output, stream, state);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.isError).toBe(false);
	});

	it("composes a ranged edit-owned read as one :raw selector", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const { h2Request } = mockH2();
		const readPaths: string[] = [];
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				readPaths.push(args.path);
				expect(args.offset).toBeUndefined();
				expect(args.limit).toBeUndefined();
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "line" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		};
		const state = newBlockState();
		startEdit(output, stream, state);
		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						execId: "exec-read-range",
						message: {
							case: "readArgs",
							value: create(ReadArgsSchema, { path: TARGET, toolCallId: EDIT_ID, offset: 2, limit: 1 }),
						},
					}),
				},
			}),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(readPaths).toEqual([`${TARGET}:raw:2+1`]);
	});
});
