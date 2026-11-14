import { describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { AuthGatewaySessionStateStore } from "@oh-my-pi/pi-ai/auth-gateway";
import { encodeStream as encodeAnthropicMessagesStream } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { buildGrpcRequest, type CursorOptions, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { encodeStream as encodeChatCompletionsStream } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import type {
	AssistantMessage,
	Message,
	Model,
	ProviderSessionState,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	type ExecServerMessage,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	KvServerMessageSchema,
	type McpArgs,
	McpArgsSchema,
	type McpResult,
	McpToolCallSchema,
	PartialToolCallUpdateSchema,
	RequestContextArgsSchema,
	SetBlobArgsSchema,
	TextDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	ToolCallCompletedUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	ToolRequestsListedUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, encodeJsonValue, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// An auth-gateway runs Cursor for a client that owns every tool and is reached
// only through the pi-native wire, which carries no `kCursorExecResolved`
// marker. These drive the real Run transport against a local HTTP/2 Cursor.

function frame(message: AgentServerMessage["message"]): Buffer {
	const data = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const framed = Buffer.alloc(5 + data.length);
	framed.writeUInt32BE(data.length, 1);
	framed.set(data, 5);
	return framed;
}

function execFrame(id: number, message: ExecServerMessage["message"]): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, { id, execId: `exec-${id}`, message }),
	});
}

function blobId(record: string): string {
	return new Bun.CryptoHasher("sha256").update(record).digest("hex");
}

function setBlobFrame(id: number, record: string): Buffer {
	return frame({
		case: "kvServerMessage",
		value: create(KvServerMessageSchema, {
			id,
			message: {
				case: "setBlobArgs",
				value: create(SetBlobArgsSchema, {
					blobId: Buffer.from(blobId(record), "hex"),
					blobData: Buffer.from(record),
				}),
			},
		}),
	});
}

function checkpointFrame(records: string[]): Buffer {
	return frame({
		case: "conversationCheckpointUpdate",
		value: create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: records.map(record => Buffer.from(blobId(record), "hex")),
		}),
	});
}

function decodeClientMessages(buffer: Buffer): AgentClientMessage[] {
	const messages: AgentClientMessage[] = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const length = buffer.readUInt32BE(offset + 1);
		if (buffer.length - offset < 5 + length) break;
		messages.push(fromBinary(AgentClientMessageSchema, buffer.subarray(offset + 5, offset + 5 + length)));
		offset += 5 + length;
	}
	return messages;
}

type FixtureStream = (
	stream: http2.ServerHttp2Stream,
	headers: http2.IncomingHttpHeaders,
	received: AgentClientMessage[],
) => void;

/** Serves one Run stream with `handler`, called again on every client frame. */
async function withCursorServer<T>(handler: FixtureStream, run: (baseUrl: string) => Promise<T>): Promise<T> {
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		let buffered = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!stream.writableEnded) handler(stream, headers, decodeClientMessages(buffered));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");
	try {
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

function model(baseUrl = ""): Model<"cursor-agent"> {
	return buildModel({
		id: "composer-2.5",
		name: "composer-2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { path: { type: "string" } } },
});

const tools = [tool("read"), tool("bash"), tool("edit"), tool("write")];
const user: Message = { role: "user", content: "Fix the bug in calc.py.", timestamp: 1 };

/** What the fixture Cursor saw of one run. */
interface ObservedRun {
	allowedTools?: string;
	advertised?: string[];
	answer?: McpResult;
}

/**
 * One Cursor turn: fetch the request context, call the client's `read` over
 * MCP, and once the frame is answered write the records the server keeps for
 * the turn (its tool-result record holds the answer Cursor got) and end it.
 */
function readTurn(observed: ObservedRun): FixtureStream {
	let step = 0;
	return (stream, headers, received) => {
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		if (step === 0) {
			step = 1;
			const allowed = headers["x-cursor-agent-allowed-tools"];
			observed.allowedTools = Array.isArray(allowed) ? allowed.join(",") : allowed;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		if (step === 1) {
			const context = replies.find(reply => reply.case === "requestContextResult");
			if (context?.case !== "requestContextResult") return;
			step = 2;
			const result = context.value.result;
			observed.advertised =
				result.case === "success" ? (result.value.requestContext?.tools ?? []).map(def => def.name) : [];
			stream.write(
				execFrame(2, {
					case: "mcpArgs",
					value: create(McpArgsSchema, {
						name: "read",
						toolName: "read",
						toolCallId: "call-read-1",
						providerIdentifier: "pi-agent",
						args: { path: encodeJsonValue("calc.py") },
					}),
				}),
			);
			return;
		}
		const answer = replies.find(reply => reply.case === "mcpResult");
		if (step !== 2 || answer?.case !== "mcpResult") return;
		step = 3;
		observed.answer = answer.value;
		const answerText =
			answer.value.result.case === "success"
				? answer.value.result.value.content.map(item =>
						item.content.case === "text" ? item.content.value.text : "",
					)
				: [answer.value.result.case ?? ""];
		const records = [
			JSON.stringify({
				role: "user",
				content: [{ type: "text", text: "<user_query>\nFix the bug in calc.py.\n</user_query>" }],
				providerOptions: { cursor: { requestId: String(headers["x-request-id"]) } },
			}),
			JSON.stringify({
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-read-1", toolName: "read", args: { path: "calc.py" } }],
			}),
			JSON.stringify({
				role: "tool",
				content: [
					{ type: "tool-result", toolCallId: "call-read-1", toolName: "read", result: answerText.join("") },
				],
			}),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Waiting for the file." }] }),
		];
		stream.end(
			Buffer.concat([
				frame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: {
							case: "textDelta",
							value: create(TextDeltaUpdateSchema, { text: "Waiting for the file." }),
						},
					}),
				}),
				...records.map((record, index) => setBlobFrame(10 + index, record)),
				checkpointFrame(records),
				frame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				}),
			]),
		);
	};
}

async function runReadTurn(options: Omit<CursorOptions, "apiKey">): Promise<{
	assistant: AssistantMessage;
	observed: ObservedRun;
}> {
	const observed: ObservedRun = {};
	const assistant = await withCursorServer(readTurn(observed), async baseUrl => {
		const response = streamCursor(
			model(baseUrl),
			{ messages: [user], tools },
			{ sessionId: `external-${crypto.randomUUID()}`, ...options, apiKey: "test-token" },
		);
		for await (const _event of response) {
			// drain
		}
		return await response.result();
	});
	return { assistant, observed };
}

describe("Cursor runs whose tools an external executor owns", () => {
	it.each<{ mode: string; options: CursorOptions; allowedTools: string | undefined; advertised: string[] }>([
		{
			// The gateway can answer no native exec frame: Cursor's own Shell/Read/
			// StrReplace were told "Tool not available" while the client ran the
			// call anyway, in Cursor's argument shape. Every client tool is an MCP
			// tool instead, under its own name and schema.
			mode: "an external executor",
			options: { externalToolExecutor: true },
			allowedTools: "mcp_tool_call,get_mcp_tools_tool_call",
			advertised: ["read", "bash", "edit", "write"],
		},
		{
			// A local bridge answers native frames, so Cursor keeps its native
			// tools and the bridged ones are not offered twice.
			mode: "a local bridge",
			options: {},
			allowedTools: undefined,
			advertised: ["edit", "write"],
		},
	])("limits Cursor's toolset and MCP catalog for a run with $mode", async ({ options, allowedTools, advertised }) => {
		const { observed } = await runReadTurn(options);

		expect(observed.allowedTools).toBe(allowedTools);
		expect(observed.advertised).toEqual(advertised);
	});

	it("hands an MCP call to the client and stops the turn for it", async () => {
		const { assistant, observed } = await runReadTurn({ externalToolExecutor: true });
		// What the client receives over pi-native: plain JSON, no symbol markers.
		const received = JSON.parse(JSON.stringify(assistant)) as AssistantMessage;
		const calls = received.content.filter((block): block is ToolCall => block.type === "toolCall");

		// Cursor is told the call was handed off, not that the tool is missing.
		expect(observed.answer?.result.case).toBe("success");
		expect(calls).toEqual([{ type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "calc.py" } }]);
		// The model wound up after the handoff, but the client still owes the result.
		expect(received.stopReason).toBe("toolUse");
	});

	it("sends the client's result for a handed-off call on the next request", async () => {
		const { assistant } = await runReadTurn({ externalToolExecutor: true });
		const handedOff = JSON.parse(JSON.stringify(assistant)) as AssistantMessage;
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-read-1",
			toolName: "read",
			content: [{ type: "text", text: "1|def add(a, b):\n2|    return a - b" }],
			isError: false,
			timestamp: 3,
		};
		const blobStore = new Map<string, Uint8Array>();

		const { conversationState } = await buildGrpcRequest(
			model(),
			{ messages: [user, handedOff, result], tools },
			{ externalToolExecutor: true },
			{ conversationId: `external-${crypto.randomUUID()}`, blobStore },
		);
		const records = conversationState.rootPromptMessagesJson.map(id =>
			new TextDecoder().decode(blobStore.get(Buffer.from(id).toString("hex"))),
		);
		const toolRecords = records.filter(record => record.includes('"tool-result"'));

		// The server's own records answer the call with the handoff text; the
		// model must see what the client's tool returned instead.
		expect(toolRecords).toHaveLength(1);
		expect(JSON.parse(toolRecords[0])).toMatchObject({
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "call-read-1", result: "1|def add(a, b):\n2|    return a - b" }],
		});
	});
});

// With a session to park in (the gateway's `providerSessionState`), a run keeps
// the client's calls open across its requests instead of handing them off.

function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	return frame({ case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) });
}

function mcpText(answer: McpResult): string {
	return answer.result.case === "success"
		? answer.result.value.content.map(item => (item.content.case === "text" ? item.content.value.text : "")).join("")
		: `<${answer.result.case}>`;
}

/** One Run stream the relaying fixture Cursor served. */
interface ServedRun {
	/** The run request's action: a turn opens on `userMessageAction`, a rebuilt one resumes. */
	action: string | undefined;
	/** MCP answers the client wrote on the stream. */
	answers: McpResult[];
	/** The client closed the stream before Cursor ended it. */
	cancelled: boolean;
	closed: Promise<void>;
}

/** The model's closing text and the turn's end, whose output count covers the whole turn. */
function finished(text: string): Buffer {
	return Buffer.concat([
		interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) }),
		interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, { outputTokens: 12n }) }),
	]);
}

/**
 * Cursor handing the client one `read` call the way it does on the wire: the
 * call's start, its MCP exec frame, then the step's listing. Once the call is
 * answered the model finishes (or, with `finish: false`, keeps talking). A turn
 * rebuilt from history (`resumeAction`) finishes at once.
 */
function relayingCursor(runs: ServedRun[], finish = true): FixtureStream {
	const served = new WeakMap<http2.ServerHttp2Stream, { run: ServedRun; step: number; end(data: Buffer): void }>();
	return (stream, _headers, received) => {
		const entry = served.get(stream);
		if (!entry) {
			const request = received.find(message => message.message.case === "runRequest");
			if (request?.message.case !== "runRequest") return;
			const closed = Promise.withResolvers<void>();
			const run: ServedRun = {
				action: request.message.value.action?.action.case,
				answers: [],
				cancelled: false,
				closed: closed.promise,
			};
			let ended = false;
			stream.on("close", () => {
				run.cancelled = !ended;
				closed.resolve();
			});
			served.set(stream, {
				run,
				step: 0,
				end: data => {
					ended = true;
					stream.end(data);
				},
			});
			runs.push(run);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		entry.run.answers = replies.flatMap(reply => (reply.case === "mcpResult" ? [reply.value] : []));
		if (entry.step === 0 && replies.some(reply => reply.case === "requestContextResult")) {
			entry.step = 1;
			if (entry.run.action === "resumeAction") {
				entry.end(finished("Rebuilt."));
				return;
			}
			const args = create(McpArgsSchema, {
				name: "read",
				toolName: "read",
				toolCallId: "call-read-1",
				providerIdentifier: "pi-agent",
				args: { path: encodeJsonValue("calc.py") },
			});
			stream.write(
				Buffer.concat([
					interactionFrame({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 5 }) }),
					interactionFrame({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, {
							callId: "call-read-1",
							toolCall: create(ToolCallSchema, {
								tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
							}),
						}),
					}),
					execFrame(2, { case: "mcpArgs", value: args }),
					interactionFrame({
						case: "toolRequestsListed",
						value: create(ToolRequestsListedUpdateSchema, { callCount: 1 }),
					}),
				]),
			);
			return;
		}
		if (entry.step === 1 && entry.run.answers.length > 0) {
			entry.step = 2;
			if (finish) {
				entry.end(finished("Fixed."));
			} else {
				stream.write(
					interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "Fix" }) }),
				);
			}
		}
	};
}

const readResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-read-1",
	toolName: "read",
	content: [{ type: "text", text: "1|def add(a, b):\n2|    return a - b" }],
	isError: false,
	timestamp: 3,
};

function relayOptions(
	states: Map<string, ProviderSessionState>,
	extra?: Omit<CursorOptions, "providerSessionState">,
): CursorOptions {
	return {
		externalToolExecutor: true,
		sessionId: "relay-session",
		providerSessionState: states,
		apiKey: "test-token",
		...extra,
	};
}

/** One gateway request, as its client receives the reply over pi-native: plain JSON. */
async function respond(baseUrl: string, messages: Message[], options: CursorOptions): Promise<AssistantMessage> {
	const response = streamCursor(model(baseUrl), { messages, tools }, options);
	for await (const _event of response) {
		// drain
	}
	return JSON.parse(JSON.stringify(await response.result())) as AssistantMessage;
}

function text(message: AssistantMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** `call-read-n`'s MCP arguments; `args` replaces the `{ path }` its exec frame carries. */
function readArgs(n: number, args: McpArgs["args"] = { path: encodeJsonValue(`file${n}.py`) }): McpArgs {
	return create(McpArgsSchema, {
		name: "read",
		toolName: "read",
		toolCallId: `call-read-${n}`,
		providerIdentifier: "pi-agent",
		args,
	});
}

/** Cursor announcing `call-read-n` as the model streams it. */
function readStarted(n: number, args = readArgs(n)): Buffer {
	return interactionFrame({
		case: "toolCallStarted",
		value: create(ToolCallStartedUpdateSchema, {
			callId: `call-read-${n}`,
			toolCall: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
			}),
		}),
	});
}

/** Cursor streaming `call-read-n`'s argument text so far. */
function readArgsText(n: number, argsTextDelta: string): Buffer {
	return interactionFrame({
		case: "partialToolCall",
		value: create(PartialToolCallUpdateSchema, { callId: `call-read-${n}`, argsTextDelta }),
	});
}

/** `call-read-n`'s MCP exec frame: Cursor waits on its answer. */
function readExec(n: number): Buffer {
	return execFrame(n + 1, { case: "mcpArgs", value: readArgs(n) });
}

/** Cursor completing `call-read-n` once its answer is in. */
function readCompleted(n: number): Buffer {
	return interactionFrame({
		case: "toolCallCompleted",
		value: create(ToolCallCompletedUpdateSchema, {
			callId: `call-read-${n}`,
			toolCall: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args: readArgs(n) }) },
			}),
		}),
	});
}

function readCall(n: number): Buffer {
	return Buffer.concat([readStarted(n), readExec(n)]);
}

/** `call-read-n` as the client receives it, arguments complete. */
function readToolCall(n: number): ToolCall {
	return { type: "toolCall", id: `call-read-${n}`, name: "read", arguments: { path: `file${n}.py` } };
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function listed(callCount: number): Buffer {
	return interactionFrame({
		case: "toolRequestsListed",
		value: create(ToolRequestsListedUpdateSchema, { callCount }),
	});
}

/**
 * Cursor running a step's two `read` calls one at a time, as it does for Grok:
 * a call it serves itself (listed on its own) comes first, then `call-read-1`
 * with no listing; only once that is answered does it stream `call-read-2`
 * and list the step's two calls.
 */
function serializingCursor(runs: ServedRun[]): FixtureStream {
	const served = new WeakMap<http2.ServerHttp2Stream, { run: ServedRun; answered: number }>();
	return (stream, _headers, received) => {
		const entry = served.get(stream);
		if (!entry) {
			const request = received.find(message => message.message.case === "runRequest");
			if (request?.message.case !== "runRequest") return;
			const run: ServedRun = {
				action: request.message.value.action?.action.case,
				answers: [],
				cancelled: false,
				closed: Promise.resolve(),
			};
			served.set(stream, { run, answered: -1 });
			runs.push(run);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		entry.run.answers = replies.flatMap(reply => (reply.case === "mcpResult" ? [reply.value] : []));
		if (entry.answered === -1 && replies.some(reply => reply.case === "requestContextResult")) {
			entry.answered = 0;
			stream.write(
				Buffer.concat([
					interactionFrame({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, {
							callId: "server-call",
							toolCall: create(ToolCallSchema, {}),
						}),
					}),
					listed(1),
					readCall(1),
				]),
			);
		} else if (entry.answered >= 0 && entry.run.answers.length > entry.answered) {
			entry.answered = entry.run.answers.length;
			stream.write(
				entry.answered === 1
					? Buffer.concat([readCall(2), listed(2)])
					: Buffer.concat([
							interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "Fixed." }) }),
							interactionFrame({
								case: "turnEnded",
								value: create(TurnEndedUpdateSchema, { outputTokens: 12n }),
							}),
						]),
			);
			if (entry.answered === 2) stream.end();
		}
	};
}

const fileResult = (n: number): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: `call-read-${n}`,
	toolName: "read",
	content: [{ type: "text", text: `file ${n}` }],
	isError: false,
	timestamp: 3 + n,
});

/** A Run stream whose Cursor side the test writes. */
interface DrivenRun extends ServedRun {
	/** Writes `frames`, resolving once the client has read them. */
	send(frames: Buffer): Promise<void>;
	/** Resolves once the client has answered `n` MCP calls on the stream. */
	answered(n: number): Promise<void>;
	/** Writes `frames` and ends the stream. */
	end(frames: Buffer): void;
}

/**
 * A Cursor whose side of each Run stream the test writes. It opens a stream by
 * asking for the request context; `run(n)` resolves with the `n`th stream once
 * the client has answered. `send` trails its frames with a blob write, which
 * the client acknowledges on the spot, parked or not, after reading them.
 */
function drivenCursor(): { serve: FixtureStream; runs: DrivenRun[]; run(index: number): Promise<DrivenRun> } {
	const runs: DrivenRun[] = [];
	const opened: PromiseWithResolvers<DrivenRun>[] = [];
	const opening = (index: number) => (opened[index] ??= Promise.withResolvers<DrivenRun>());
	const receivers = new WeakMap<http2.ServerHttp2Stream, (received: AgentClientMessage[]) => void>();
	const serve: FixtureStream = (stream, _headers, received) => {
		const receive = receivers.get(stream);
		if (receive) {
			receive(received);
			return;
		}
		const request = received.find(message => message.message.case === "runRequest");
		if (request?.message.case !== "runRequest") return;
		const index = runs.length;
		const closed = Promise.withResolvers<void>();
		let acknowledged = new Set<number>();
		let waits: { ready(): boolean; resolve(): void }[] = [];
		const until = (ready: () => boolean): Promise<void> => {
			if (ready()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waits.push({ ready, resolve });
			return promise;
		};
		let writes = 0;
		let ended = false;
		const run: DrivenRun = {
			action: request.message.value.action?.action.case,
			answers: [],
			cancelled: false,
			closed: closed.promise,
			send: frames => {
				const id = ++writes;
				stream.write(Buffer.concat([frames, setBlobFrame(id, `write ${id}`)]));
				return until(() => acknowledged.has(id));
			},
			answered: n => until(() => run.answers.length >= n),
			end: frames => {
				ended = true;
				stream.end(frames);
			},
		};
		stream.on("close", () => {
			run.cancelled = !ended;
			closed.resolve();
		});
		receivers.set(stream, received => {
			const replies = received.flatMap(message =>
				message.message.case === "execClientMessage" ? [message.message.value.message] : [],
			);
			run.answers = replies.flatMap(reply => (reply.case === "mcpResult" ? [reply.value] : []));
			acknowledged = new Set(
				received.flatMap(message => (message.message.case === "kvClientMessage" ? [message.message.value.id] : [])),
			);
			if (replies.some(reply => reply.case === "requestContextResult")) opening(index).resolve(run);
			waits = waits.filter(wait => {
				if (!wait.ready()) return true;
				wait.resolve();
				return false;
			});
		});
		runs.push(run);
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
	};
	return { serve, runs, run: index => opening(index).promise };
}

/** The data payloads of a gateway SSE response, in order. */
function ssePayloads<T>(body: string): T[] {
	return body
		.split("\n")
		.flatMap(line => (line.startsWith("data: ") && line !== "data: [DONE]" ? [JSON.parse(line.slice(6)) as T] : []));
}

/** A call as its client assembled it from the stream; argument text that does not parse stays as it came. */
function clientCall({ id, name, json }: { id: string; name: string; json: string }): unknown {
	let args: unknown;
	try {
		args = JSON.parse(json || "{}");
	} catch {
		args = json;
	}
	return { type: "toolCall", id, name, arguments: args };
}

interface AnthropicStreamEvent {
	type: string;
	index: number;
	content_block?: { type: string; id?: string; name?: string };
	delta?: { type: string; partial_json?: string };
}

/** The calls an Anthropic Messages client assembles: a `tool_use` block's input is its `input_json_delta` text. */
function anthropicClientCalls(body: string): unknown[] {
	const calls = new Map<number, { id: string; name: string; json: string }>();
	for (const event of ssePayloads<AnthropicStreamEvent>(body)) {
		if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
			calls.set(event.index, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", json: "" });
		} else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
			const call = calls.get(event.index);
			if (call) call.json += event.delta.partial_json ?? "";
		}
	}
	return [...calls.values()].map(clientCall);
}

interface ChatCompletionChunk {
	choices?: {
		delta: { tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
	}[];
}

/** The calls a Chat Completions client assembles: each `tool_calls` field concatenated by index. */
function chatClientCalls(body: string): unknown[] {
	const calls = new Map<number, { id: string; name: string; json: string }>();
	for (const chunk of ssePayloads<ChatCompletionChunk>(body)) {
		for (const delta of chunk.choices?.[0]?.delta.tool_calls ?? []) {
			const call = calls.get(delta.index) ?? { id: "", name: "", json: "" };
			call.id += delta.id ?? "";
			call.name += delta.function?.name ?? "";
			call.json += delta.function?.arguments ?? "";
			calls.set(delta.index, call);
		}
	}
	return [...calls.values()].map(clientCall);
}

describe("Cursor runs relayed across an external executor's requests", () => {
	it("answers the parked call in-band with the next request's result and streams on in the same run", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));

			expect(handedOff.stopReason).toBe("toolUse");
			expect(handedOff.content.filter(block => block.type === "toolCall")).toEqual([
				{ type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "calc.py" } },
			]);
			// Cursor still waits on the call: nothing, no handoff text, answered it.
			expect(runs.map(run => run.answers)).toEqual([[]]);

			const resumed = await respond(baseUrl, [user, handedOff, readResult], relayOptions(states));

			expect(runs).toHaveLength(1);
			expect(runs[0].answers.map(mcpText)).toEqual(["1|def add(a, b):\n2|    return a - b"]);
			expect(resumed.stopReason).toBe("stop");
			expect(text(resumed)).toBe("Fixed.");
			// The turn-end count spans both responses; each reports only its share.
			expect(handedOff.usage.output + resumed.usage.output).toBe(12);
			expect(states.size).toBe(0);
		});
	});

	it("hands off a call Cursor waits on before listing its step, and counts it toward the listing", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(serializingCursor(runs), async baseUrl => {
			const first = await respond(baseUrl, [user], relayOptions(states));
			expect(first.stopReason).toBe("toolUse");
			expect(first.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))).toEqual(["call-read-1"]);

			const second = await respond(baseUrl, [user, first, fileResult(1)], relayOptions(states));
			expect(second.stopReason).toBe("toolUse");
			expect(second.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))).toEqual([
				"call-read-2",
			]);

			const third = await respond(
				baseUrl,
				[user, first, fileResult(1), second, fileResult(2)],
				relayOptions(states),
			);
			expect(third.stopReason).toBe("stop");
			expect(text(third)).toBe("Fixed.");
			expect(runs).toHaveLength(1);
			expect(runs[0].answers.map(mcpText)).toEqual(["file 1", "file 2"]);
			expect(states.size).toBe(0);
		});
	});

	it("cancels the parked run and rebuilds the turn when the next request does not continue it", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));
			const stray: ToolResultMessage = { ...readResult, toolCallId: "call-read-2" };

			const rebuilt = await respond(baseUrl, [user, handedOff, stray], relayOptions(states));
			await runs[0].closed;

			expect(runs.map(run => [run.action, run.answers.length, run.cancelled])).toEqual([
				["userMessageAction", 0, true],
				["resumeAction", 0, false],
			]);
			expect(text(rebuilt)).toBe("Rebuilt.");
			expect(states.size).toBe(0);
		});
	});

	it.each<{ cause: string; session: () => { states: Map<string, ProviderSessionState>; giveUp(): void } }>([
		{
			cause: "its idle timeout",
			session: () => {
				vi.useFakeTimers();
				const states = new Map<string, ProviderSessionState>();
				return {
					states,
					giveUp: () => {
						vi.advanceTimersByTime(30 * 60_000 - 1);
						expect(states.size).toBe(1);
						vi.advanceTimersByTime(1);
					},
				};
			},
		},
		{
			cause: "the gateway evicting its session",
			session: () => {
				const store = new AuthGatewaySessionStateStore(1);
				const session = (clientKey: string) =>
					store.acquire({ clientKey, model: model(), context: { messages: [user], tools }, account: "key:test" });
				const lease = session("relay-a");
				return {
					states: lease.states,
					giveUp: () => {
						lease.release();
						session("relay-b").release();
					},
				};
			},
		},
	])("cancels a parked run on $cause, and the late request rebuilds the turn", async ({ session }) => {
		const runs: ServedRun[] = [];
		try {
			await withCursorServer(relayingCursor(runs), async baseUrl => {
				const { states, giveUp } = session();
				const handedOff = await respond(baseUrl, [user], relayOptions(states));
				expect(runs.map(run => [run.answers.length, run.cancelled])).toEqual([[0, false]]);

				giveUp();
				await runs[0].closed;
				vi.useRealTimers();
				const rebuilt = await respond(baseUrl, [user, handedOff, readResult], relayOptions(states));

				expect(runs.map(run => [run.action, run.answers.length, run.cancelled])).toEqual([
					["userMessageAction", 0, true],
					["resumeAction", 0, false],
				]);
				expect(text(rebuilt)).toBe("Rebuilt.");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the run when the request it was resumed into is aborted", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs, false), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));
			const controller = new AbortController();
			const response = streamCursor(
				model(baseUrl),
				{ messages: [user, handedOff, readResult], tools },
				relayOptions(states, { signal: controller.signal }),
			);
			for await (const event of response) {
				if (event.type === "text_delta") controller.abort();
			}
			const aborted = await response.result();
			await runs[0].closed;

			expect(aborted.stopReason).toBe("aborted");
			expect(runs.map(run => [run.answers.length, run.cancelled])).toEqual([[1, true]]);
			expect(states.size).toBe(0);
		});
	});

	it("hands off only the calls whose exec frames it holds when Cursor goes quiet, and keeps the others open", async () => {
		const cursor = drivenCursor();
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(cursor.serve, async baseUrl => {
			const firstReply = respond(baseUrl, [user], relayOptions(states));
			const run = await cursor.run(0);
			// Cursor announces the second call, its arguments still to come, and
			// waits on the first before sending the second's exec frame.
			await run.send(Buffer.concat([readCall(1), readStarted(2, readArgs(2, {}))]));
			const first = await firstReply;
			expect(toolCalls(first)).toEqual([readToolCall(1)]);

			const secondReply = respond(baseUrl, [user, first, fileResult(1)], relayOptions(states));
			await run.answered(1);
			await run.send(Buffer.concat([readExec(2), listed(2)]));
			const second = await secondReply;
			expect(toolCalls(second)).toEqual([readToolCall(2)]);

			const thirdReply = respond(baseUrl, [user, first, fileResult(1), second, fileResult(2)], relayOptions(states));
			await run.answered(2);
			run.end(finished("Fixed."));
			const third = await thirdReply;
			expect(text(third)).toBe("Fixed.");
			expect(cursor.runs).toHaveLength(1);
			expect(cursor.runs[0].answers.map(mcpText)).toEqual(["file 1", "file 2"]);
		});
	});

	it.each([
		{ route: "Anthropic Messages", encode: encodeAnthropicMessagesStream, clientCalls: anthropicClientCalls },
		{ route: "Chat Completions", encode: encodeChatCompletionsStream, clientCalls: chatClientCalls },
	])(
		"streams the $route client only the calls it holds, each with its arguments complete",
		async ({ encode, clientCalls }) => {
			const cursor = drivenCursor();
			const states = new Map<string, ProviderSessionState>();
			await withCursorServer(cursor.serve, async baseUrl => {
				// One gateway request on the route: the calls its client assembles from
				// the stream, and the reply its history keeps.
				const request = async (messages: Message[]) => {
					const response = streamCursor(model(baseUrl), { messages, tools }, relayOptions(states));
					const body = await new Response(encode(response, "composer-2.5")).text();
					return { calls: clientCalls(body), message: await response.result() };
				};
				const firstReply = request([user]);
				const run = await cursor.run(0);
				// Cursor starts on the second call's arguments, then waits on the first
				// before sending the second's exec frame.
				await run.send(
					Buffer.concat([readCall(1), readStarted(2, readArgs(2, {})), readArgsText(2, '{"path":"fi')]),
				);
				const first = await firstReply;
				expect(first.calls).toEqual([readToolCall(1)]);

				const secondReply = request([user, first.message, fileResult(1)]);
				await run.answered(1);
				await run.send(Buffer.concat([readExec(2), listed(2)]));
				expect((await secondReply).calls).toEqual([readToolCall(2)]);
			});
		},
	);

	it("does not hand a call off again when Cursor announces it after the handoff", async () => {
		const cursor = drivenCursor();
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(cursor.serve, async baseUrl => {
			const firstReply = respond(baseUrl, [user], relayOptions(states));
			const run = await cursor.run(0);
			// The exec frame can come before the call's announcement.
			await run.send(Buffer.concat([readExec(1), listed(1)]));
			const first = await firstReply;
			expect(toolCalls(first)).toEqual([readToolCall(1)]);

			const secondReply = respond(baseUrl, [user, first, fileResult(1)], relayOptions(states));
			await run.answered(1);
			run.end(Buffer.concat([readStarted(1), readCompleted(1), finished("Fixed.")]));
			const second = await secondReply;
			expect(toolCalls(second)).toEqual([]);
			expect(second.stopReason).toBe("stop");
			expect(text(second)).toBe("Fixed.");
		});
	});

	it("counts a listing that arrives while the run is parked toward the step it lists", async () => {
		const cursor = drivenCursor();
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(cursor.serve, async baseUrl => {
			const firstReply = respond(baseUrl, [user], relayOptions(states));
			const run = await cursor.run(0);
			await run.send(readCall(1));
			const first = await firstReply;
			expect(toolCalls(first)).toEqual([readToolCall(1)]);
			// Cursor lists the step only once the run has parked on it.
			await run.send(listed(1));

			const secondReply = respond(baseUrl, [user, first, fileResult(1)], relayOptions(states));
			await run.answered(1);
			// The next step lists its two calls before the second one's exec frame.
			await run.send(Buffer.concat([readStarted(2), readStarted(3, readArgs(3, {})), readExec(2), listed(2)]));
			await run.send(readExec(3));
			const second = await secondReply;
			expect(toolCalls(second)).toEqual([readToolCall(2), readToolCall(3)]);

			const thirdReply = respond(
				baseUrl,
				[user, first, fileResult(1), second, fileResult(2), fileResult(3)],
				relayOptions(states),
			);
			await run.answered(3);
			run.end(finished("Fixed."));
			const third = await thirdReply;
			expect(text(third)).toBe("Fixed.");
			expect(cursor.runs).toHaveLength(1);
		});
	});

	it("reports a relayed turn's output once across a checkpoint retry", async () => {
		const cursor = drivenCursor();
		const states = new Map<string, ProviderSessionState>();
		const options = relayOptions(states, { providerRetryWait: async () => {} });
		await withCursorServer(cursor.serve, async baseUrl => {
			const firstReply = respond(baseUrl, [user], options);
			const run = await cursor.run(0);
			await run.send(
				Buffer.concat([
					interactionFrame({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 5 }) }),
					readCall(1),
					listed(1),
				]),
			);
			const first = await firstReply;
			expect(first.usage.output).toBe(5);

			const secondReply = respond(baseUrl, [user, first, fileResult(1)], options);
			await run.answered(1);
			// Cursor checkpoints the turn and the transport drops.
			run.end(checkpointFrame([]));
			const retry = await cursor.run(1);
			retry.end(finished("Fixed."));
			const second = await secondReply;

			expect(cursor.runs.map(served => served.action)).toEqual(["userMessageAction", "resumeAction"]);
			expect(text(second)).toBe("Fixed.");
			expect(first.usage.output + second.usage.output).toBe(12);
		});
	});
});
