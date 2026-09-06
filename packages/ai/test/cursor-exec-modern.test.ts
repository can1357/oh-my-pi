import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	buildCursorRequestContextRules,
	CURSOR_CLIENT_VERSION,
	flushOpenToolCalls,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, CursorExecHandlers, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AgentStoreConflictArgsSchema,
	CanvasDiagnosticsArgsSchema,
	ComputerUseArgsSchema,
	ConnectScmArgsSchema,
	ConnectScmErrorSchema,
	ConnectScmGithubRepositorySchema,
	ConnectScmGithubSchema,
	ConnectScmRejectedSchema,
	ConnectScmResultSchema,
	ConnectScmSuccessSchema,
	ConnectScmToolCallSchema,
	ConversationSearchArgsSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	type CursorRule,
	type ExecServerMessage,
	ExecServerMessageSchema,
	ExecuteHookArgsSchema,
	ExecuteHookRequestSchema,
	ForceBackgroundShellArgsSchema,
	ForceBackgroundShellStatus,
	ForceBackgroundSubagentArgsSchema,
	ForceBackgroundSubagentStatus,
	GetDiffRequestSchema,
	GrepArgsSchema,
	ListMcpResourcesExecArgsSchema,
	McpAllowlistPrecheckArgsSchema,
	McpArgsSchema,
	McpStateExecArgsSchema,
	type McpToolDefinition,
	McpToolDefinitionSchema,
	PiBashExecArgsSchema,
	PiEditExecArgsSchema,
	PiEditReplacementSchema,
	PiFindExecArgsSchema,
	PiGrepExecArgsSchema,
	PiLsExecArgsSchema,
	PiReadExecArgsSchema,
	PiWriteExecArgsSchema,
	PostToolUseRequestQuerySchema,
	ReadArgsSchema,
	ReadMcpResourceExecArgsSchema,
	RecordScreenArgsSchema,
	RequestContextArgsSchema,
	ShellAllowlistPrecheckArgsSchema,
	ShellArgsSchema,
	SmartModeClassifierArgsSchema,
	SubagentArgsSchema,
	SubagentAwaitArgsSchema,
	ToolCallSchema,
	WebFetchAllowlistPrecheckArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/**
 * Drive one `ExecServerMessage` through the real dispatcher and decode every
 * frame it wrote back.
 *
 * The frames are decoded from the actual wire bytes rather than intercepted as
 * objects: the whole point of these cases is what the SERVER receives, and an
 * `ExecClientMessage` whose oneof never got set still looks like a populated
 * object in memory.
 */
async function dispatchExec(
	message: ExecServerMessage,
	options: {
		execHandlers?: CursorExecHandlers;
		requestContextTools?: McpToolDefinition[];
		requestContextRules?: CursorRule[];
	} = {},
): Promise<{ frames: AgentClientMessage[]; output: AssistantMessage; results: ToolResultMessage[] }> {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const state = newBlockState();
	const written: Buffer[] = [];
	const h2Request = {
		write: (chunk: Buffer) => {
			written.push(chunk);
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];
	const results: ToolResultMessage[] = [];

	await handleServerMessage(
		create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: message } }),
		output,
		stream,
		state,
		new Map(),
		h2Request,
		options.execHandlers,
		result => {
			results.push(result);
			return result;
		},
		{ sawTokenDelta: false },
		options.requestContextTools ?? [],
		options.requestContextRules,
	);

	return { frames: written.map(decodeClientFrame), output, results };
}

/** Strip the 5-byte Connect envelope (flags + big-endian length) and decode. */
function decodeClientFrame(frame: Buffer): AgentClientMessage {
	const length = frame.readUInt32BE(1);
	return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function buildExecMessage(message: ExecServerMessage["message"]): ExecServerMessage {
	return create(ExecServerMessageSchema, { id: 7, execId: "exec-modern", message });
}

function mcpTool(name: string, providerIdentifier: string) {
	return create(McpToolDefinitionSchema, { name, toolName: name, providerIdentifier, description: `${name} tool` });
}

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

function newBlockState(overrides: Partial<BlockState> = {}): BlockState {
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
		...overrides,
	};
}

function toolResult(text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "unused",
		toolName: "unused",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...extra,
	};
}

/** The single `execClientMessage` a dispatch produced, or a failure if it produced anything else. */
function soleResult(frames: AgentClientMessage[]) {
	expect(frames).toHaveLength(1);
	const frame = frames[0].message;
	if (frame.case !== "execClientMessage") throw new Error(`expected execClientMessage, got ${frame.case}`);
	return frame.value.message;
}

describe("Cursor modern exec protocol activation", () => {
	it("advertises the client build whose schema includes modern exec frames", () => {
		expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.07.23-e383d2b");
	});
});

describe("Cursor requestContext rules", () => {
	it("returns mapped system-prompt canaries as global CursorRule entries", async () => {
		const canary = "PIKEL-CANARY-7F3A";
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "requestContextArgs",
				value: create(RequestContextArgsSchema, {}),
			}),
			{
				requestContextRules: buildCursorRequestContextRules(["prefix", `when asked, answer exactly:\n${canary}`]),
			},
		);
		const result = soleResult(frames);
		expect(result.case).toBe("requestContextResult");
		if (result.case !== "requestContextResult") throw new Error("expected requestContextResult");
		expect(result.value.result.case).toBe("success");
		if (result.value.result.case !== "success") throw new Error("expected success");
		const rules = result.value.result.value.requestContext?.rules ?? [];
		expect(rules).toHaveLength(2);
		expect(rules[1]?.content).toContain(canary);
		expect(rules[1]?.type?.type.case).toBe("global");
	});
});

describe("Cursor conversation checkpoints", () => {
	it("records checkpoint-only occupancy without billing it as token usage", async () => {
		const output = cursorAssistantMessage();

		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
						tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 120_000 }),
					}),
				},
			}),
			output,
			new AssistantMessageEventStream(),
			newBlockState(),
			new Map(),
			{ write: () => true } as unknown as Parameters<typeof handleServerMessage>[5],
			undefined,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(output.usage).toMatchObject({
			contextTokens: 120_000,
			input: 0,
			output: 0,
			totalTokens: 0,
		});
	});
});

describe("Cursor stream teardown", () => {
	it("keeps whole arguments on a block still open when the transport ends", async () => {
		// A connect-SCM block arrives with complete `arguments` and never feeds
		// the streamed partial-JSON buffer. `parseStreamingJson(undefined)`
		// returns `{}`, so reparsing every open block on teardown erased exactly
		// those args — the interaction then rebuilt as an empty call.
		const wire = create(ToolCallSchema, {
			tool: {
				case: "connectScmToolCall",
				value: create(ConnectScmToolCallSchema, {
					args: create(ConnectScmArgsSchema, {
						toolCallId: "inner-id",
						target: {
							case: "github",
							value: create(ConnectScmGithubSchema, {
								repository: create(ConnectScmGithubRepositorySchema, { owner: "can1357", repo: "oh-my-pi" }),
							}),
						},
					}),
				}),
			},
		});
		const toolCall = fromBinary(ToolCallSchema, toBinary(ToolCallSchema, wire));

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();

		// Start the call and leave it open: the transport dies before completion.
		processInteractionUpdate(
			{ message: { case: "toolCallStarted", value: { callId: "envelope-a", toolCall } } },
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		if (!block) throw new Error("expected an open tool-call block");
		const argsBeforeTeardown = block.arguments;
		expect(argsBeforeTeardown).not.toEqual({});

		flushOpenToolCalls(output, stream, state);

		expect(block.arguments).toEqual(argsBeforeTeardown);
		// The block is closed, so no live card is left animating.
		expect(state.openToolCalls.size).toBe(0);
		expect(state.currentToolCall).toBeNull();
	});

	it("salvages a truncated streamed argument buffer into partial arguments", async () => {
		// The other half of the same contract: blocks that *do* stream their args
		// must still be reparsed on teardown, or a cut-short call renders with no
		// arguments at all.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "envelope-mcp",
						toolCall: { tool: { case: "mcpToolCall", value: { args: { toolCallId: "mcp-1" } } } },
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		if (!block) throw new Error("expected an open tool-call block");
		setStreamingPartialJson(block, '{"path":"/repo/a.ts"');

		flushOpenToolCalls(output, stream, state);

		expect(block.arguments).toEqual({ path: "/repo/a.ts" });
	});

	it("pairs a server-owned call the transport cut short", async () => {
		// `connect_scm` and native todo blocks are stamped `kCursorExecResolved`
		// at start, so `agent-loop.ts` synthesizes no placeholder for them and
		// only their completion frame pairs a result. A transport that dies
		// first left the call unpaired, and `buildSessionContext` strips a
		// dangling call — the whole interaction vanished from replay.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const paired: ToolResultMessage[] = [];
		const state = newBlockState({ onToolResult: result => void paired.push(result) });

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "envelope-todo",
						toolCall: { tool: { case: "updateTodosToolCall", value: { args: { todos: [] } } } },
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		if (!block) throw new Error("expected an open tool-call block");
		expect(paired).toHaveLength(0);

		flushOpenToolCalls(output, stream, state);

		expect(paired).toHaveLength(1);
		expect(paired[0].toolCallId).toBe(block.id);
		expect(paired[0].isError).toBe(true);
	});

	it("leaves an exec-settled MCP call to the dispatch that owns its result", async () => {
		// MCP blocks are also marked resolved, but by the exec dispatch, which
		// already emitted their result and is awaited before teardown. Pairing
		// one here too would file a duplicate against the same `toolCallId`.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const paired: ToolResultMessage[] = [];
		const state = newBlockState({ onToolResult: result => void paired.push(result) });
		state.resolvedMcpToolCallIds.add("mcp-1");

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "envelope-mcp",
						toolCall: { tool: { case: "mcpToolCall", value: { args: { toolCallId: "mcp-1" } } } },
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		flushOpenToolCalls(output, stream, state);

		expect(paired).toEqual([]);
	});
});

describe("Cursor modern exec frames: failure channel", () => {
	it("throws on a frame whose oneof this build does not model, instead of stranding the exec id", async () => {
		// A oneof number absent from agent.proto decodes into unknown fields and
		// leaves `message.case` unset. The old code returned silently, so the
		// server waited on a reply that never arrived.
		const message = create(ExecServerMessageSchema, { id: 11, execId: "exec-unknown" });

		const { frames } = await dispatchExec(message);

		const control = frames[0].message;
		expect(control.case).toBe("execClientControlMessage");
		if (control.case !== "execClientControlMessage") throw new Error("unreachable");
		expect(control.value.message.case).toBe("throw");
		if (control.value.message.case !== "throw") throw new Error("unreachable");
		expect(control.value.message.value.id).toBe(11);
		expect(control.value.message.value.errorCode).toBe("unknown_exec_variant");

		// A throw must be followed by a stream close, or the exec stays open.
		const close = frames[1].message;
		expect(close.case).toBe("execClientControlMessage");
		if (close.case !== "execClientControlMessage") throw new Error("unreachable");
		expect(close.value.message.case).toBe("streamClose");
	});

	it("throws for gitDiffRequest, whose response type has no error variant", async () => {
		// `GetDiffResponse` models five output formats and no failure, so any
		// in-band answer claims a diff was computed.
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "gitDiffRequest",
				value: create(GetDiffRequestSchema, { cwd: "/repo", ref: "HEAD" }),
			}),
		);

		const control = frames[0].message;
		if (control.case !== "execClientControlMessage") throw new Error(`got ${control.case}`);
		expect(control.value.message.case).toBe("throw");
		if (control.value.message.case !== "throw") throw new Error("unreachable");
		expect(control.value.message.value.errorCode).toBe("exec_variant_unsupported");
	});
});

describe("Cursor modern exec frames: no answer carries an unset oneof", () => {
	// A result whose `result` oneof is unset is indistinguishable from "the tool
	// ran and produced nothing". Every one of these frames was previously
	// answered that way, or is newly handled and must not regress into it.
	const cases: [name: string, message: ExecServerMessage, resultCase: string][] = [
		[
			"listMcpResourcesExecArgs",
			buildExecMessage({
				case: "listMcpResourcesExecArgs",
				value: create(ListMcpResourcesExecArgsSchema, {}),
			}),
			"success",
		],
		[
			"readMcpResourceExecArgs",
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { uri: "file:///nope" }),
			}),
			"notFound",
		],
		[
			"recordScreenArgs",
			buildExecMessage({ case: "recordScreenArgs", value: create(RecordScreenArgsSchema, {}) }),
			"failure",
		],
		[
			"computerUseArgs",
			buildExecMessage({ case: "computerUseArgs", value: create(ComputerUseArgsSchema, {}) }),
			"error",
		],
		[
			"subagentArgs",
			buildExecMessage({
				case: "subagentArgs",
				value: create(SubagentArgsSchema, { toolCallId: "c1", subagentType: "explore", prompt: "go" }),
			}),
			"error",
		],
		[
			"subagentAwaitArgs",
			buildExecMessage({
				case: "subagentAwaitArgs",
				value: create(SubagentAwaitArgsSchema, { agentId: "agent-1", timeoutMs: 10 }),
			}),
			"notFound",
		],
		[
			"smartModeClassifierArgs",
			buildExecMessage({
				case: "smartModeClassifierArgs",
				value: create(SmartModeClassifierArgsSchema, { toolCallId: "c1" }),
			}),
			"error",
		],
		[
			"canvasDiagnosticsArgs",
			buildExecMessage({
				case: "canvasDiagnosticsArgs",
				value: create(CanvasDiagnosticsArgsSchema, { path: "/a.ts", toolCallId: "c1" }),
			}),
			"error",
		],
		[
			"conversationSearchArgs",
			buildExecMessage({
				case: "conversationSearchArgs",
				value: create(ConversationSearchArgsSchema, { query: "chess", toolCallId: "c1" }),
			}),
			"error",
		],
		[
			"agentStoreConflictArgs",
			buildExecMessage({
				case: "agentStoreConflictArgs",
				value: create(AgentStoreConflictArgsSchema, {}),
			}),
			"error",
		],
	];

	for (const [name, message, resultCase] of cases) {
		it(`answers ${name} with a set '${resultCase}' variant`, async () => {
			const { frames } = await dispatchExec(message);
			const answer = soleResult(frames);
			expect(answer.case).toBeDefined();
			const value = answer.value;
			expect(value).toHaveProperty("result");
			const result = (value as { result: { case?: string } }).result;
			expect(result.case).toBe(resultCase);
		});
	}

	it("reports the requested uri back on a not-found MCP resource read", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { uri: "mcp://server/thing" }),
			}),
		);
		const answer = soleResult(frames);
		if (answer.case !== "readMcpResourceExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "notFound") throw new Error("expected notFound");
		expect(answer.value.result.value.uri).toBe("mcp://server/thing");
	});

	it("echoes the requested path on a canvas diagnostics error", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "canvasDiagnosticsArgs",
				value: create(CanvasDiagnosticsArgsSchema, { path: "/canvas/a.ts", toolCallId: "c1" }),
			}),
		);
		const answer = soleResult(frames);
		if (answer.case !== "canvasDiagnosticsResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "error") throw new Error("expected error");
		expect(answer.value.result.value.path).toBe("/canvas/a.ts");
	});

	it("reports the awaited agent id back as not found", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "subagentAwaitArgs",
				value: create(SubagentAwaitArgsSchema, { agentId: "agent-42", timeoutMs: 5 }),
			}),
		);
		const answer = soleResult(frames);
		if (answer.case !== "subagentAwaitResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "notFound") throw new Error("expected notFound");
		expect(answer.value.result.value.agentId).toBe("agent-42");
	});
});

describe("Cursor MCP resource frames answer from the host's servers", () => {
	it("returns the resources the host advertises, with their server names", async () => {
		// The empty catalog above is the no-handler fallback. A host holding live
		// MCP connections must answer from them, or its resources are invisible
		// to Cursor even though the same session is connected to the servers.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "listMcpResourcesExecArgs", value: create(ListMcpResourcesExecArgsSchema, {}) }),
			{
				execHandlers: {
					listMcpResources: async () => [
						{ uri: "docs://readme", name: "README", mimeType: "text/markdown", server: "docs" },
					],
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "listMcpResourcesExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.resources).toHaveLength(1);
		const [resource] = answer.value.result.value.resources;
		expect(resource.uri).toBe("docs://readme");
		// Cursor addresses the follow-up read by this name.
		expect(resource.server).toBe("docs");
		expect(resource.mimeType).toBe("text/markdown");
	});

	it("passes the frame's server filter through to the host", async () => {
		let sawFilter: string | undefined;
		await dispatchExec(
			buildExecMessage({
				case: "listMcpResourcesExecArgs",
				value: create(ListMcpResourcesExecArgsSchema, { server: "issues" }),
			}),
			{
				execHandlers: {
					listMcpResources: async ({ server }) => {
						sawFilter = server;
						return [];
					},
				},
			},
		);
		expect(sawFilter).toBe("issues");
	});

	it("answers a read with the host's text content", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { server: "docs", uri: "docs://readme" }),
			}),
			{
				execHandlers: {
					readMcpResource: async ({ uri }) => ({ uri, mimeType: "text/markdown", text: "# Title" }),
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "readMcpResourceExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.content).toEqual({ case: "text", value: "# Title" });
	});

	it("forwards a download request and answers with the path, not the content", async () => {
		// `download_path` is a different contract: the host writes the resource
		// to that workspace-relative path and the model is told where it landed.
		// Returning content anyway would put the payload back in context, which
		// is exactly what the download mode exists to avoid.
		let sawDownloadPath: string | undefined;
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, {
					server: "files",
					uri: "files://logo",
					downloadPath: "assets/logo.png",
				}),
			}),
			{
				execHandlers: {
					readMcpResource: async ({ uri, downloadPath }) => {
						sawDownloadPath = downloadPath;
						// A host that also has the bytes on hand must still not have
						// them forwarded: the download path is the whole answer.
						return { uri, mimeType: "image/png", downloadPath, text: "inline payload" };
					},
				},
			},
		);
		expect(sawDownloadPath).toBe("assets/logo.png");
		const answer = soleResult(frames);
		if (answer.case !== "readMcpResourceExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.downloadPath).toBe("assets/logo.png");
		expect(answer.value.result.value.content.case).toBeUndefined();
	});

	it("distinguishes a missing resource from a failing host", async () => {
		// `null` is "no such server or uri", which is `not_found`. A throw is a
		// real failure and must not masquerade as a missing resource — the model
		// would retry a different uri instead of surfacing the fault.
		const missing = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { server: "docs", uri: "docs://gone" }),
			}),
			{ execHandlers: { readMcpResource: async () => null } },
		);
		const missingAnswer = soleResult(missing.frames);
		if (missingAnswer.case !== "readMcpResourceExecResult") throw new Error(`got ${missingAnswer.case}`);
		expect(missingAnswer.value.result.case).toBe("notFound");

		const broken = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { server: "docs", uri: "docs://readme" }),
			}),
			{
				execHandlers: {
					readMcpResource: async () => {
						throw new Error("server disconnected");
					},
				},
			},
		);
		const brokenAnswer = soleResult(broken.frames);
		if (brokenAnswer.case !== "readMcpResourceExecResult") throw new Error(`got ${brokenAnswer.case}`);
		if (brokenAnswer.value.result.case !== "error") throw new Error(`got ${brokenAnswer.value.result.case}`);
		expect(brokenAnswer.value.result.value.error).toContain("server disconnected");
	});

	it("records a resource read as a paired transcript block", async () => {
		// The read runs locally and, in download mode, writes a workspace file.
		// An exec frame with no synthesized block is invisible in the UI, and an
		// unpaired call is stripped by `buildSessionContext` — taking the whole
		// interaction out of every rebuilt transcript.
		const { output, results } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, {
					server: "docs",
					uri: "docs://readme",
					downloadPath: "assets/readme.md",
				}),
			}),
			{
				execHandlers: {
					readMcpResource: async ({ uri, downloadPath }) => ({ uri, mimeType: "text/markdown", downloadPath }),
				},
			},
		);

		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		// Not `read`: this is a remote MCP operation, and the name drives
		// rendering and prune semantics.
		expect(blocks[0].name).toBe("read_mcp_resource");
		expect(blocks[0].arguments).toEqual({
			server: "docs",
			uri: "docs://readme",
			download_path: "assets/readme.md",
		});
		// Paired under the same id, and a success is not filed as a failure.
		expect(results.map(r => r.toolCallId)).toEqual([blocks[0].id]);
		expect(results[0].isError).toBe(false);
		expect(results[0].content).toEqual([{ type: "text", text: "Downloaded docs://readme to assets/readme.md" }]);
	});

	it("pairs a failed resource read as an error, still under one block", async () => {
		// A refused download (no write grant, a path outside the workspace) and
		// a dead server both land here. The block must resolve — an unpaired
		// call strips the interaction — and must resolve as an error, or the
		// transcript shows a read that never happened as having succeeded.
		const { output, results } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { server: "docs", uri: "docs://readme" }),
			}),
			{
				execHandlers: {
					readMcpResource: async () => {
						throw new Error("Refusing to download outside the workspace: ../escape");
					},
				},
			},
		);

		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(results.map(r => r.toolCallId)).toEqual([blocks[0].id]);
		expect(results[0].isError).toBe(true);
		expect(results[0].content).toEqual([
			{ type: "text", text: "Refusing to download outside the workspace: ../escape" },
		]);
	});

	it("leaves no block when no handler ran", async () => {
		// Without a handler the frame is answered from a fixed `not_found` and
		// nothing executed, so a block would claim work that never happened.
		const { output, results } = await dispatchExec(
			buildExecMessage({
				case: "readMcpResourceExecArgs",
				value: create(ReadMcpResourceExecArgsSchema, { server: "docs", uri: "docs://readme" }),
			}),
		);
		expect(output.content.filter(block => block.type === "toolCall")).toHaveLength(0);
		expect(results).toHaveLength(0);
	});

	it("records a handled listing as a block with a paired result", async () => {
		// The model consumes this catalog: without a block and a paired result
		// the listing is invisible in the UI and stripped from rebuilt history.
		const { output, results } = await dispatchExec(
			buildExecMessage({
				case: "listMcpResourcesExecArgs",
				value: create(ListMcpResourcesExecArgsSchema, { server: "docs" }),
			}),
			{
				execHandlers: {
					listMcpResources: async () => [
						{ uri: "docs://readme", name: "README", mimeType: "text/markdown", server: "docs" },
					],
				},
			},
		);
		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].name).toBe("list_mcp_resources");
		expect(results.map(r => r.toolCallId)).toEqual([blocks[0].id]);
		expect(results[0].isError).toBe(false);
	});

	it("leaves no block for a listing no handler answered", async () => {
		// The no-handler fallback is a fixed empty catalog: nothing executed, so
		// a block would claim work that never happened.
		const { output, results } = await dispatchExec(
			buildExecMessage({ case: "listMcpResourcesExecArgs", value: create(ListMcpResourcesExecArgsSchema, {}) }),
		);
		expect(output.content.filter(block => block.type === "toolCall")).toHaveLength(0);
		expect(results).toHaveLength(0);
	});

	it("reports a failing list as an error, not an empty catalog", async () => {
		// An empty success says "asked, none exist" — a lie when the lookup
		// failed, and one the model cannot retry.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "listMcpResourcesExecArgs", value: create(ListMcpResourcesExecArgsSchema, {}) }),
			{
				execHandlers: {
					listMcpResources: async () => {
						throw new Error("registry unavailable");
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "listMcpResourcesExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "error") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.error).toContain("registry unavailable");
	});
});

describe("Cursor modern exec frames: status and precheck answers", () => {
	it("reports NOT_FOUND for force-background requests, since nothing runs in the background", async () => {
		const shell = await dispatchExec(
			buildExecMessage({
				case: "forceBackgroundShellArgs",
				value: create(ForceBackgroundShellArgsSchema, { toolCallId: "c1" }),
			}),
		);
		const shellAnswer = soleResult(shell.frames);
		if (shellAnswer.case !== "forceBackgroundShellResult") throw new Error(`got ${shellAnswer.case}`);
		expect(shellAnswer.value.status).toBe(ForceBackgroundShellStatus.NOT_FOUND);

		const subagent = await dispatchExec(
			buildExecMessage({
				case: "forceBackgroundSubagentArgs",
				value: create(ForceBackgroundSubagentArgsSchema, { toolCallId: "c1" }),
			}),
		);
		const subagentAnswer = soleResult(subagent.frames);
		if (subagentAnswer.case !== "forceBackgroundSubagentResult") throw new Error(`got ${subagentAnswer.case}`);
		expect(subagentAnswer.value.status).toBe(ForceBackgroundSubagentStatus.NOT_FOUND);
	});

	it("declines every allowlist precheck, since no allowlist is configured", async () => {
		// `true` here would grant an approval bypass that was never configured.
		const shell = await dispatchExec(
			buildExecMessage({
				case: "shellAllowlistPrecheckArgs",
				value: create(ShellAllowlistPrecheckArgsSchema, { command: "rm -rf /", workingDirectory: "/" }),
			}),
		);
		const shellAnswer = soleResult(shell.frames);
		if (shellAnswer.case !== "shellAllowlistPrecheckResult") throw new Error(`got ${shellAnswer.case}`);
		expect(shellAnswer.value.allowlisted).toBe(false);

		const mcp = await dispatchExec(
			buildExecMessage({
				case: "mcpAllowlistPrecheckArgs",
				value: create(McpAllowlistPrecheckArgsSchema, { providerIdentifier: "pi-agent", toolName: "task" }),
			}),
		);
		const mcpAnswer = soleResult(mcp.frames);
		if (mcpAnswer.case !== "mcpAllowlistPrecheckResult") throw new Error(`got ${mcpAnswer.case}`);
		expect(mcpAnswer.value.allowlisted).toBe(false);

		const web = await dispatchExec(
			buildExecMessage({
				case: "webFetchAllowlistPrecheckArgs",
				value: create(WebFetchAllowlistPrecheckArgsSchema, { url: "https://example.com" }),
			}),
		);
		const webAnswer = soleResult(web.frames);
		if (webAnswer.case !== "webFetchAllowlistPrecheckResult") throw new Error(`got ${webAnswer.case}`);
		expect(webAnswer.value.allowlisted).toBe(false);
	});
});

describe("Cursor modern exec frames: hooks", () => {
	it("answers a hook query with the matching response case and an empty payload", async () => {
		// The request and response oneofs are parallel; a response of the wrong
		// case is read as a different hook entirely.
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "executeHookArgs",
				value: create(ExecuteHookArgsSchema, {
					request: create(ExecuteHookRequestSchema, {
						request: { case: "postToolUse", value: create(PostToolUseRequestQuerySchema, {}) },
					}),
				}),
			}),
		);

		const answer = soleResult(frames);
		if (answer.case !== "executeHookResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.response?.response.case).toBe("postToolUse");
		if (answer.value.response?.response.case !== "postToolUse") throw new Error("unreachable");
		// Every field is optional; this client runs no hooks, so it contributes none.
		expect(answer.value.response.response.value.additionalContext).toBeUndefined();
	});

	it("maps every modelled hook request onto its parallel response case", async () => {
		// The request and response oneofs are parallel by field number. A single
		// mis-wired branch answers a different hook than the one asked, which the
		// server reads as a stalled or misrouted hook — invisible unless every
		// variant is exercised.
		const requestCases = [
			"preCompact",
			"subagentStart",
			"subagentStop",
			"preToolUse",
			"postToolUse",
			"postToolUseFailure",
			"beforeSubmitPrompt",
			"afterAgentResponse",
			"afterAgentThought",
			"stop",
		] as const;

		for (const requestCase of requestCases) {
			const request = create(ExecuteHookRequestSchema, {
				request: { case: requestCase, value: {} },
			} as never);
			const { frames } = await dispatchExec(
				buildExecMessage({ case: "executeHookArgs", value: create(ExecuteHookArgsSchema, { request }) }),
			);

			const answer = soleResult(frames);
			if (answer.case !== "executeHookResult") throw new Error(`${requestCase}: got ${answer.case}`);
			expect(answer.value.response?.response.case).toBe(requestCase);
		}
	});

	it("throws for a hook request whose case this build does not model", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "executeHookArgs",
				value: create(ExecuteHookArgsSchema, { request: create(ExecuteHookRequestSchema, {}) }),
			}),
		);

		const control = frames[0].message;
		if (control.case !== "execClientControlMessage") throw new Error(`got ${control.case}`);
		expect(control.value.message.case).toBe("throw");
		if (control.value.message.case !== "throw") throw new Error("unreachable");
		expect(control.value.message.value.errorCode).toBe("unknown_hook_request");
	});
});

describe("Cursor modern exec frames: MCP state", () => {
	it("regroups the advertised tool catalog by provider identifier", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "mcpStateExecArgs", value: create(McpStateExecArgsSchema, {}) }),
			{
				requestContextTools: [
					mcpTool("task", "pi-agent"),
					mcpTool("hub", "pi-agent"),
					mcpTool("mcp__fixture_report", "fixture"),
				],
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "mcpStateExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		const servers = answer.value.result.value.servers;
		expect(servers.map(server => server.serverIdentifier).sort()).toEqual(["fixture", "pi-agent"]);
		const piAgent = servers.find(server => server.serverIdentifier === "pi-agent");
		expect(piAgent?.tools.map(t => t.name)).toEqual(["task", "hub"]);
	});

	it("restricts the answer to the requested server identifiers", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "mcpStateExecArgs",
				value: create(McpStateExecArgsSchema, { serverIdentifiers: ["fixture"] }),
			}),
			{ requestContextTools: [mcpTool("task", "pi-agent"), mcpTool("mcp__fixture_report", "fixture")] },
		);

		const answer = soleResult(frames);
		if (answer.case !== "mcpStateExecResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.servers.map(s => s.serverIdentifier)).toEqual(["fixture"]);
	});
});

describe("Cursor modern exec frames: redacted read", () => {
	it("refuses redactedRead rather than serving the unredacted file", async () => {
		// The frame exists so the client can strip secrets first. No redaction is
		// implemented, so answering with a plain read would leak exactly what the
		// frame withholds.
		const readHandler: CursorExecHandlers = {
			async read() {
				return toolResult("SECRET=hunter2");
			},
		};
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "redactedReadArgs",
				value: create(ReadArgsSchema, { path: "/repo/.env", toolCallId: "c1" }),
			}),
			{ execHandlers: readHandler },
		);

		const answer = soleResult(frames);
		if (answer.case !== "redactedReadResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.result.case).toBe("error");
		if (answer.value.result.case !== "error") throw new Error("unreachable");
		expect(answer.value.result.value.error).toContain("redaction");
		expect(JSON.stringify(answer.value)).not.toContain("hunter2");
	});
});

describe("Cursor modern exec frames: Pi tools", () => {
	it("round-trips piRead through its handler into a typed success", async () => {
		const { frames, output, results } = await dispatchExec(
			buildExecMessage({
				case: "piReadArgs",
				value: create(PiReadExecArgsSchema, { path: "/repo/a.ts", offset: 5, limit: 20 }),
			}),
			{
				execHandlers: {
					async piRead(call) {
						expect(call.args.path).toBe("/repo/a.ts");
						expect(call.args.offset).toBe(5);
						// The Pi frames carry no tool_call_id; the dispatcher mints one.
						expect(call.toolCallId).toBeTruthy();
						// Like the real bridge, the handler files its result under the id
						// it was handed.
						return toolResult("line one\nline two", { toolCallId: call.toolCallId, toolName: "read" });
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piReadResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.output).toBe("line one\nline two");

		// The synthesized block and its paired result must share the minted id, or
		// the call is stripped as dangling on replay.
		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].name).toBe("read");
		expect(results.map(r => r.toolCallId)).toEqual([blocks[0].id]);
		// The displayed args must be the operation that actually runs. The bridge
		// composes offset/limit into `read`'s `:raw:N+K` selector, so a block
		// showing the bare path claims a whole-file read that never happened.
		expect(blocks[0].arguments).toEqual({ path: "/repo/a.ts:raw:5+20" });
	});

	it("maps a failing Pi handler onto the frame's own error variant", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/nope" }) }),
			{
				execHandlers: {
					async piRead(call) {
						return toolResult("ENOENT: /nope", { isError: true, toolCallId: call.toolCallId });
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piReadResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "error") throw new Error("expected error");
		expect(answer.value.result.value.error).toBe("ENOENT: /nope");
	});

	it("rejects a Pi frame with no handler installed instead of faking a success", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piGrepArgs", value: create(PiGrepExecArgsSchema, { pattern: "foo" }) }),
		);

		const answer = soleResult(frames);
		if (answer.case !== "piGrepResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.result.case).toBe("error");
	});

	it("answers an unavailable edit or write with the protocol's rejected variant", async () => {
		// These two results model refusal and failure as separate oneof cases.
		// A denial answered as `error` reads as "the tool ran and broke", which
		// invites a retry of an operation that was never permitted.
		const edit = soleResult(
			(
				await dispatchExec(
					buildExecMessage({
						case: "piEditArgs",
						value: create(PiEditExecArgsSchema, {
							path: "/a.ts",
							edits: [create(PiEditReplacementSchema, { oldText: "x", newText: "y" })],
						}),
					}),
				)
			).frames,
		);
		if (edit.case !== "piEditResult") throw new Error(`got ${edit.case}`);
		expect(edit.value.result.case).toBe("rejected");

		const write = soleResult(
			(
				await dispatchExec(
					buildExecMessage({
						case: "piWriteArgs",
						value: create(PiWriteExecArgsSchema, { path: "/a.ts", content: "x" }),
					}),
				)
			).frames,
		);
		if (write.case !== "piWriteResult") throw new Error(`got ${write.case}`);
		expect(write.value.result.case).toBe("rejected");
	});

	it("carries a truncation summary onto the Pi success payload", async () => {
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piBashArgs", value: create(PiBashExecArgsSchema, { command: "yes" }) }),
			{
				execHandlers: {
					async piBash() {
						return toolResult("out", {
							details: {
								truncation: {
									truncated: true,
									truncatedBy: "lines",
									totalLines: 5000,
									outputLines: 300,
									outputBytes: 4096,
								},
							},
						});
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piBashResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.truncation?.truncated).toBe(true);
		expect(answer.value.result.value.truncation?.truncatedBy).toBe("lines");
		expect(answer.value.result.value.truncation?.totalLines).toBe(5000);
	});

	it("reads truncation from the `details.meta.truncation` shape real Bash results use", async () => {
		// `BashTool` files its summary under `details.meta.truncation`
		// (`TruncationMeta`), which carries no `truncated` flag — its presence is
		// the signal. Reading only the top-level `TruncationResult` shape handed
		// Cursor clipped output with no notice that it was clipped.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piBashArgs", value: create(PiBashExecArgsSchema, { command: "yes" }) }),
			{
				execHandlers: {
					async piBash() {
						return toolResult("out", {
							details: {
								meta: {
									truncation: {
										direction: "head",
										truncatedBy: "bytes",
										totalLines: 5000,
										totalBytes: 120000,
										outputLines: 300,
										outputBytes: 4096,
									},
								},
							},
						});
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piBashResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.truncation?.truncated).toBe(true);
		expect(answer.value.result.value.truncation?.truncatedBy).toBe("bytes");
		expect(answer.value.result.value.truncation?.totalLines).toBe(5000);
		expect(answer.value.result.value.truncation?.outputBytes).toBe(4096);
	});

	it("omits truncation entirely when nothing was truncated", async () => {
		// `optional PiTruncation` — a zeroed message would claim the output was
		// trimmed to nothing.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piBashArgs", value: create(PiBashExecArgsSchema, { command: "echo hi" }) }),
			{
				execHandlers: {
					async piBash() {
						return toolResult("hi", { details: { truncation: { truncated: false, totalLines: 1 } } });
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piBashResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.truncation).toBeUndefined();
	});

	it("passes edit replacements through to the handler and surfaces diff/patch", async () => {
		const { frames, output } = await dispatchExec(
			buildExecMessage({
				case: "piEditArgs",
				value: create(PiEditExecArgsSchema, {
					path: "/repo/a.ts",
					edits: [create(PiEditReplacementSchema, { oldText: "before", newText: "after" })],
				}),
			}),
			{
				execHandlers: {
					async piEdit(call) {
						expect(call.args.edits[0].oldText).toBe("before");
						return toolResult("edited", { details: { diff: "-before\n+after", patch: "@@" } });
					},
				},
			},
		);

		const answer = soleResult(frames);
		if (answer.case !== "piEditResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error("expected success");
		expect(answer.value.result.value.diff).toBe("-before\n+after");
		expect(answer.value.result.value.patch).toBe("@@");

		// The synthesized display block must use the local edit tool's replace
		// schema, or the rebuilt transcript renders empty edits.
		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		expect(block?.name).toBe("edit");
		expect(block?.arguments).toEqual({ path: "/repo/a.ts", old_string: "before", new_string: "after" });
	});

	it("answers each remaining Pi frame with a populated success payload", async () => {
		// The outer result case alone is not proof: an unset inner oneof reads as
		// "the tool ran and produced nothing", and dropped output or limit
		// metadata is invisible at the discriminator level.
		const handlers: CursorExecHandlers = {
			async piWrite() {
				return toolResult("wrote");
			},
			async piGrep() {
				return toolResult("a.ts:1:hit", { details: { perFileLimitReached: 20, linesTruncated: true } });
			},
			async piFind() {
				return toolResult("a.ts", { details: { resultLimitReached: 200 } });
			},
			async piLs() {
				return toolResult("a.ts\nb.ts", { details: { resultLimitReached: 500 } });
			},
		};

		const write = soleResult(
			(
				await dispatchExec(
					buildExecMessage({
						case: "piWriteArgs",
						value: create(PiWriteExecArgsSchema, { path: "/a.ts", content: "x" }),
					}),
					{ execHandlers: handlers },
				)
			).frames,
		);
		if (write.case !== "piWriteResult") throw new Error(`got ${write.case}`);
		if (write.value.result.case !== "success") throw new Error("expected success");
		expect(write.value.result.value.output).toBe("wrote");

		const grep = soleResult(
			(
				await dispatchExec(
					buildExecMessage({ case: "piGrepArgs", value: create(PiGrepExecArgsSchema, { pattern: "hit" }) }),
					{ execHandlers: handlers },
				)
			).frames,
		);
		if (grep.case !== "piGrepResult") throw new Error(`got ${grep.case}`);
		if (grep.value.result.case !== "success") throw new Error("expected success");
		expect(grep.value.result.value.output).toBe("a.ts:1:hit");
		expect(grep.value.result.value.matchLimitReached).toBe(20);
		expect(grep.value.result.value.linesTruncated).toBe(true);

		const find = soleResult(
			(
				await dispatchExec(
					buildExecMessage({ case: "piFindArgs", value: create(PiFindExecArgsSchema, { pattern: "*.ts" }) }),
					{ execHandlers: handlers },
				)
			).frames,
		);
		if (find.case !== "piFindResult") throw new Error(`got ${find.case}`);
		if (find.value.result.case !== "success") throw new Error("expected success");
		expect(find.value.result.value.output).toBe("a.ts");
		expect(find.value.result.value.resultLimitReached).toBe(200);

		const ls = soleResult(
			(
				await dispatchExec(buildExecMessage({ case: "piLsArgs", value: create(PiLsExecArgsSchema, {}) }), {
					execHandlers: handlers,
				})
			).frames,
		);
		if (ls.case !== "piLsResult") throw new Error(`got ${ls.case}`);
		if (ls.value.result.case !== "success") throw new Error("expected success");
		expect(ls.value.result.value.output).toBe("a.ts\nb.ts");
		expect(ls.value.result.value.entryLimitReached).toBe(500);
	});

	it("serves miniSweAgentBash from the existing shell handler under its own frame", async () => {
		// Frame 52 carries the same ShellArgs/ShellResult pair as `shellArgs`, so
		// the shell handler answers it unchanged — under result field 55.
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "miniSweAgentBashArgs",
				value: create(ShellArgsSchema, { command: "echo hi", workingDirectory: "/repo", toolCallId: "c1" }),
			}),
			{
				execHandlers: {
					async shell(args) {
						expect(args.command).toBe("echo hi");
						return toolResult("hi", { toolCallId: "c1", toolName: "bash" });
					},
				},
			},
		);

		const answer = soleResult(frames);
		expect(answer.case).toBe("miniSweAgentBashResult");
		if (answer.case !== "miniSweAgentBashResult") throw new Error("unreachable");
		expect(answer.value.result.case).toBe("success");
	});
});

describe("Cursor modern exec frames: server-resolved tool calls leave a paired block", () => {
	// `buildSessionContext` strips a `toolCall` with no matching `toolResult`,
	// taking the whole interaction out of every rebuilt transcript. Both of these
	// variants are refused, but a refusal still has to settle its block.

	it("pairs the conversationSearch block the exec frame synthesizes", async () => {
		const { output, results } = await dispatchExec(
			buildExecMessage({
				case: "conversationSearchArgs",
				value: create(ConversationSearchArgsSchema, { query: "chess", toolCallId: "call-search-1", limit: 5 }),
			}),
		);

		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ id: "call-search-1", name: "search_conversations" });
		// Resolved => agent-loop emits no placeholder, so the pair must come from here.
		expect(blocks[0][kCursorExecResolved]).toBe(true);
		expect(results.map(result => result.toolCallId)).toEqual(["call-search-1"]);
		expect(results[0].isError).toBe(true);
	});

	/**
	 * Drive a streamed `connect_scm` pair through the interaction decoder.
	 *
	 * The `ToolCall` is built with the generated schema and re-decoded from its
	 * own wire bytes, so the `target` / `result` oneofs carry the real
	 * `{ case, value }` shape the server sends — a hand-shaped literal would
	 * silently pass against a selector reading the wrong field.
	 */
	function runConnectScm(
		args: { toolCallId?: string; repository?: { owner: string; repo: string } },
		result: { case: "success" | "error" | "rejected"; value: Record<string, string> } | undefined,
		options: { envelopeId?: string; completionCarriesCall?: boolean } = {},
	): { output: AssistantMessage; results: ToolResultMessage[]; resultsAfterStart: number } {
		const wire = create(ToolCallSchema, {
			tool: {
				case: "connectScmToolCall",
				value: create(ConnectScmToolCallSchema, {
					args: create(ConnectScmArgsSchema, {
						toolCallId: args.toolCallId ?? "",
						target: args.repository
							? {
									case: "github",
									value: create(ConnectScmGithubSchema, {
										repository: create(ConnectScmGithubRepositorySchema, args.repository),
									}),
								}
							: { case: undefined },
					}),
					result: result
						? create(ConnectScmResultSchema, {
								result:
									result.case === "success"
										? { case: "success", value: create(ConnectScmSuccessSchema, {}) }
										: result.case === "error"
											? { case: "error", value: create(ConnectScmErrorSchema, result.value) }
											: { case: "rejected", value: create(ConnectScmRejectedSchema, result.value) },
							})
						: undefined,
				}),
			},
		});
		const toolCall = fromBinary(ToolCallSchema, toBinary(ToolCallSchema, wire));

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const results: ToolResultMessage[] = [];
		state.onToolResult = toolResultMessage => {
			results.push(toolResultMessage);
			return toolResultMessage;
		};

		const usage = { sawTokenDelta: false };
		processInteractionUpdate(
			{ message: { case: "toolCallStarted", value: { callId: options.envelopeId ?? "", toolCall } } },
			output,
			stream,
			state,
			usage,
		);
		const resultsAfterStart = results.length;
		processInteractionUpdate(
			{
				message: {
					case: "toolCallCompleted",
					value: options.completionCarriesCall === false ? {} : { toolCall },
				},
			},
			output,
			stream,
			state,
			usage,
		);
		return { output, results, resultsAfterStart };
	}

	function soleBlock(output: AssistantMessage): ToolCallState {
		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		return blocks[0];
	}

	it("reads the connectScm repository out of the target oneof, not a flat field", async () => {
		const { output, results } = runConnectScm(
			{ toolCallId: "call-scm-1", repository: { owner: "can1357", repo: "oh-my-pi" } },
			{ case: "success", value: {} },
		);

		const block = soleBlock(output);
		expect(block).toMatchObject({
			id: "call-scm-1",
			name: "connect_scm",
			arguments: { owner: "can1357", repo: "oh-my-pi" },
		});
		// Resolved => agent-loop runs no local tool, so the decoder owes the pair.
		expect(block[kCursorExecResolved]).toBe(true);
		expect(results.map(result => result.toolCallId)).toEqual(["call-scm-1"]);
	});

	it("settles connectScm from the completion's result, never from the announcement", async () => {
		// The start frame carries no verdict. Answering there would persist a
		// fabricated outcome before the server reported one.
		const success = runConnectScm({ toolCallId: "c1" }, { case: "success", value: {} });
		const failed = runConnectScm({ toolCallId: "c2" }, { case: "error", value: { error: "token expired" } });
		const rejected = runConnectScm({ toolCallId: "c3" }, { case: "rejected", value: { reason: "user declined" } });

		// The bug this guards: settling at start persisted a hard-coded failure
		// for every call, including the ones the server went on to accept.
		expect([success, failed, rejected].map(run => run.resultsAfterStart)).toEqual([0, 0, 0]);
		expect(success.results.map(r => r.isError)).toEqual([false]);
		expect(failed.results[0].isError).toBe(true);
		expect(failed.results[0].content).toEqual([{ type: "text", text: "token expired" }]);
		expect(rejected.results[0].isError).toBe(true);
		expect(rejected.results[0].content).toEqual([{ type: "text", text: "user declined" }]);
	});

	it("still pairs connectScm when the completion carries no tool call at all", async () => {
		// An unpaired resolved block is stripped along with its whole interaction,
		// so a resultless completion must settle as a failure rather than stay open.
		const { output, results } = runConnectScm({ toolCallId: "c4" }, undefined, {
			completionCarriesCall: false,
		});

		expect(soleBlock(output).id).toBe("c4");
		expect(results.map(result => result.toolCallId)).toEqual(["c4"]);
		expect(results[0].isError).toBe(true);
	});

	it("falls back to the envelope call id when connectScm args carry none", async () => {
		const { output, results } = runConnectScm(
			{ repository: { owner: "o", repo: "r" } },
			{ case: "success", value: {} },
			{
				envelopeId: "envelope-id",
			},
		);

		expect(soleBlock(output).id).toBe("envelope-id");
		expect(results.map(result => result.toolCallId)).toEqual(["envelope-id"]);
	});

	it("ignores a completion whose envelope id belongs to a different call", async () => {
		// Server-resolved and parallel calls interleave: a completion for an
		// unrelated call would otherwise close whichever block is current and pair
		// it with the wrong verdict — here, marking a pending connect as rejected.
		//
		// Correlation is on the envelope id, which is deliberately NOT the block
		// id: the block persists under the inner `tool_call_id` the transcript
		// files it under.
		const wire = create(ToolCallSchema, {
			tool: {
				case: "connectScmToolCall",
				value: create(ConnectScmToolCallSchema, {
					args: create(ConnectScmArgsSchema, { toolCallId: "inner-id" }),
					result: create(ConnectScmResultSchema, {
						result: { case: "rejected", value: create(ConnectScmRejectedSchema, { reason: "other call" }) },
					}),
				}),
			},
		});
		const toolCall = fromBinary(ToolCallSchema, toBinary(ToolCallSchema, wire));

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const results: ToolResultMessage[] = [];
		state.onToolResult = result => {
			results.push(result);
			return result;
		};
		const usage = { sawTokenDelta: false };

		processInteractionUpdate(
			{ message: { case: "toolCallStarted", value: { callId: "envelope-a", toolCall } } },
			output,
			stream,
			state,
			usage,
		);
		processInteractionUpdate(
			{ message: { case: "toolCallCompleted", value: { callId: "envelope-b", toolCall } } },
			output,
			stream,
			state,
			usage,
		);

		// The block stays open and unpaired; only its own completion settles it.
		expect(results).toEqual([]);

		processInteractionUpdate(
			{ message: { case: "toolCallCompleted", value: { callId: "envelope-a", toolCall } } },
			output,
			stream,
			state,
			usage,
		);

		expect(results.map(result => result.toolCallId)).toEqual(["inner-id"]);
		expect(results[0].content).toEqual([{ type: "text", text: "other call" }]);
	});

	it("settles two interleaved calls independently, each with its own result", async () => {
		// `start A, start B, complete A, complete B` is legal wire order. With a
		// single "current block" slot, B's start orphaned A: A's completion then
		// settled B, and A was never paired — so the transcript rebuild dropped
		// the whole interaction.
		function scmCall(toolCallId: string, reason: string) {
			const wire = create(ToolCallSchema, {
				tool: {
					case: "connectScmToolCall",
					value: create(ConnectScmToolCallSchema, {
						args: create(ConnectScmArgsSchema, { toolCallId }),
						result: create(ConnectScmResultSchema, {
							result: { case: "rejected", value: create(ConnectScmRejectedSchema, { reason }) },
						}),
					}),
				},
			});
			return fromBinary(ToolCallSchema, toBinary(ToolCallSchema, wire));
		}

		const callA = scmCall("inner-a", "reason A");
		const callB = scmCall("inner-b", "reason B");

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const results: ToolResultMessage[] = [];
		state.onToolResult = result => {
			results.push(result);
			return result;
		};
		const usage = { sawTokenDelta: false };
		const send = (updateCase: string, callId: string, toolCall: unknown) =>
			processInteractionUpdate(
				{ message: { case: updateCase, value: { callId, toolCall } } },
				output,
				stream,
				state,
				usage,
			);

		send("toolCallStarted", "envelope-a", callA);
		send("toolCallStarted", "envelope-b", callB);
		send("toolCallCompleted", "envelope-a", callA);
		send("toolCallCompleted", "envelope-b", callB);

		// Both blocks exist, and each is paired with its OWN verdict.
		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks.map(block => block.id)).toEqual(["inner-a", "inner-b"]);
		expect(results.map(result => result.toolCallId)).toEqual(["inner-a", "inner-b"]);
		expect(results.map(result => result.content)).toEqual([
			[{ type: "text", text: "reason A" }],
			[{ type: "text", text: "reason B" }],
		]);
	});

	it("does not double-create a block for a Pi call the exec channel already synthesized", async () => {
		// Modern builds stream a `pi_*_tool_call` envelope alongside the exec
		// frame. The exec side owns that block; a second one here would render the
		// same call twice and leave the duplicate unpaired.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "call-pi-read",
						toolCall: { tool: { case: "piReadToolCall", value: { args: { path: "/a.ts" } } } },
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(output.content.filter(block => block.type === "toolCall")).toHaveLength(0);
	});
});

describe("Cursor legacy read frame: range reporting", () => {
	it("reports rangeApplied only when the frame asked for a window", async () => {
		// The field reports whether the frame's window was actually composed
		// onto the read. Reporting true for an unranged whole-file read, or
		// false for a paginated one, misdescribes what the client did.
		const handlers: CursorExecHandlers = {
			async read() {
				return toolResult("line1\nline2");
			},
		};

		const ranged = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/big.ts", toolCallId: "c1", offset: 5, limit: 20 }),
			}),
			{ execHandlers: handlers },
		);
		const rangedAnswer = soleResult(ranged.frames);
		if (rangedAnswer.case !== "readResult") throw new Error(`got ${rangedAnswer.case}`);
		if (rangedAnswer.value.result.case !== "success") throw new Error(`got ${rangedAnswer.value.result.case}`);
		expect(rangedAnswer.value.result.value.rangeApplied).toBe(true);

		const whole = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/big.ts", toolCallId: "c2" }),
			}),
			{ execHandlers: handlers },
		);
		const wholeAnswer = soleResult(whole.frames);
		if (wholeAnswer.case !== "readResult") throw new Error(`got ${wholeAnswer.case}`);
		if (wholeAnswer.value.result.case !== "success") throw new Error(`got ${wholeAnswer.value.result.case}`);
		expect(wholeAnswer.value.result.value.rangeApplied).toBe(false);
	});
	it("treats a path-embedded selector as ranged without reporting the slice as the file total", async () => {
		const slice = Array.from({ length: 55 }, (_, index) => `line ${index + 301}`).join("\n");
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, {
					path: "/repo/plan.md:raw:301-",
					toolCallId: "c-inline",
				}),
			}),
			{
				execHandlers: {
					async read() {
						return toolResult(slice, { details: { fileSize: 21_015 } });
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "readResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.totalLines).toBe(0);
		expect(answer.value.result.value.rangeApplied).toBe(true);
		expect(answer.value.result.value.fileSize).toBe(21_015n);
	});

	it("carries the composed selector into the synthesized call", async () => {
		// A bare path beside a ranged result makes the slice look like the whole
		// file in every rebuilt transcript.
		const { output } = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/big.ts", toolCallId: "c1", offset: 5, limit: 20 }),
			}),
			{
				execHandlers: {
					async read() {
						return toolResult("line1\nline2");
					},
				},
			},
		);
		const call = output.content.find(block => block.type === "toolCall");
		expect(call?.arguments).toMatchObject({ path: "/repo/big.ts:raw:5+20" });
	});
	it("records a zero-line read as zero lines, not the whole file", async () => {
		// `limit: 0` composes no selector — nothing reads zero lines — and the
		// frame is answered with empty output directly. A bare path in the block
		// would replay as a whole-file read that came back empty.
		const { output } = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/big.ts", toolCallId: "c1", offset: 5, limit: 0 }),
			}),
			{
				execHandlers: {
					async read() {
						return toolResult("");
					},
				},
			},
		);
		const call = output.content.find(block => block.type === "toolCall");
		expect(call?.arguments).toMatchObject({ path: "/repo/big.ts:raw:5+0" });
	});
});

describe("Cursor legacy grep frame: offset reporting", () => {
	it("echoes the frame's offset back as offsetApplied", async () => {
		// The field reports the offset this client actually applied, so it must
		// track the frame's request rather than being left unset.
		const handlers: CursorExecHandlers = {
			async grep() {
				return toolResult("a.ts:1:needle");
			},
		};

		const paged = await dispatchExec(
			buildExecMessage({
				case: "grepArgs",
				value: create(GrepArgsSchema, { pattern: "needle", path: "src", toolCallId: "c1", offset: 20 }),
			}),
			{ execHandlers: handlers },
		);
		const pagedAnswer = soleResult(paged.frames);
		if (pagedAnswer.case !== "grepResult") throw new Error(`got ${pagedAnswer.case}`);
		if (pagedAnswer.value.result.case !== "success") throw new Error(`got ${pagedAnswer.value.result.case}`);
		const pagedUnion = pagedAnswer.value.result.value.workspaceResults.src?.result;
		if (pagedUnion?.case !== "content") throw new Error(`got ${pagedUnion?.case}`);
		expect(pagedUnion.value.offsetApplied).toBe(20);

		const first = await dispatchExec(
			buildExecMessage({
				case: "grepArgs",
				value: create(GrepArgsSchema, { pattern: "needle", path: "src", toolCallId: "c2" }),
			}),
			{ execHandlers: handlers },
		);
		const firstAnswer = soleResult(first.frames);
		if (firstAnswer.case !== "grepResult") throw new Error(`got ${firstAnswer.case}`);
		if (firstAnswer.value.result.case !== "success") throw new Error(`got ${firstAnswer.value.result.case}`);
		const firstUnion = firstAnswer.value.result.value.workspaceResults.src?.result;
		if (firstUnion?.case !== "content") throw new Error(`got ${firstUnion?.case}`);
		// Absent, not 0: no offset was requested, so none was applied.
		expect(firstUnion.value.offsetApplied).toBeUndefined();
	});

	it("carries the executed page into the synthesized call", async () => {
		// The block is what a reloaded transcript replays. Showing an unskipped
		// search beside a result taken from a later file window tells the next
		// turn the wrong thing about what was searched.
		const { output } = await dispatchExec(
			buildExecMessage({
				case: "grepArgs",
				value: create(GrepArgsSchema, { pattern: "needle", path: "src", toolCallId: "c1", offset: 20 }),
			}),
			{
				execHandlers: {
					async grep() {
						return toolResult("a.ts:1:needle");
					},
				},
			},
		);
		const call = output.content.find(block => block.type === "toolCall");
		expect(call?.arguments).toMatchObject({ pattern: "needle", path: "src", skip: 20 });
	});
});

describe("Cursor MCP frame: approval-only probes", () => {
	it("answers from the host's policy without running the tool", async () => {
		// The server sends this to resolve a permission decision BEFORE the real
		// call. Running the tool to answer it fires a side effect the user has
		// not been asked about, and fires it again when the real frame arrives.
		// The verdict comes from the host's policy instead.
		let invocations = 0;
		const handlers: CursorExecHandlers = {
			async mcp() {
				invocations += 1;
				return toolResult("ran");
			},
		};

		const { frames, output, results } = await dispatchExec(
			buildExecMessage({
				case: "mcpArgs",
				value: create(McpArgsSchema, {
					name: "deploy",
					toolName: "deploy",
					toolCallId: "c1",
					providerIdentifier: "ops",
					smartModeApprovalOnly: true,
				}),
			}),
			{ execHandlers: handlers },
		);

		expect(invocations).toBe(0);
		const answer = soleResult(frames);
		if (answer.case !== "mcpResult") throw new Error(`got ${answer.case}`);
		// No preflight handler is registered here: with nothing to decide
		// against, the probe cannot be approved.
		expect(answer.value.result.case).toBe("rejected");
		// Nothing ran, so nothing may appear in the transcript either.
		expect(output.content.filter(block => block.type === "toolCall")).toHaveLength(0);
		expect(results).toHaveLength(0);
	});

	it("approves a probe the host's policy allows", async () => {
		// A definite allow must still be approved, or a permitted call loses the
		// fast path on every turn.
		let invocations = 0;
		const { frames, output } = await dispatchExec(
			buildExecMessage({
				case: "mcpArgs",
				value: create(McpArgsSchema, {
					name: "lookup",
					toolName: "lookup",
					toolCallId: "c1",
					providerIdentifier: "ops",
					smartModeApprovalOnly: true,
				}),
			}),
			{
				execHandlers: {
					async mcp() {
						invocations += 1;
						return toolResult("ran");
					},
					async mcpApprovalPreflight() {
						return true;
					},
				},
			},
		);

		// Approved, but still not executed: the call itself comes later.
		expect(invocations).toBe(0);
		const answer = soleResult(frames);
		if (answer.case !== "mcpResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.result.case).toBe("approved");
		expect(output.content.filter(block => block.type === "toolCall")).toHaveLength(0);
	});

	it("refuses a probe the host declines to approve", async () => {
		// A pending prompt resolves to false: it can only be answered at
		// execution time, and approving on the user's behalf pre-authorizes a
		// call they never saw.
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "mcpArgs",
				value: create(McpArgsSchema, {
					name: "deploy",
					toolName: "deploy",
					toolCallId: "c1",
					providerIdentifier: "ops",
					smartModeApprovalOnly: true,
				}),
			}),
			{
				execHandlers: {
					async mcp() {
						return toolResult("ran");
					},
					async mcpApprovalPreflight() {
						return false;
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "mcpResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.result.case).toBe("rejected");
	});

	it("still runs an ordinary MCP frame", async () => {
		// The guard keys on the flag alone: a normal call must be unaffected.
		let invocations = 0;
		const handlers: CursorExecHandlers = {
			async mcp() {
				invocations += 1;
				return toolResult("ran");
			},
		};

		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "mcpArgs",
				value: create(McpArgsSchema, {
					name: "deploy",
					toolName: "deploy",
					toolCallId: "c2",
					providerIdentifier: "ops",
				}),
			}),
			{ execHandlers: handlers },
		);

		expect(invocations).toBe(1);
		const answer = soleResult(frames);
		if (answer.case !== "mcpResult") throw new Error(`got ${answer.case}`);
		expect(answer.value.result.case).toBe("success");
	});
});

describe("Cursor exec answers: what the result claims about the work", () => {
	it("reports the file's own line count for a windowed read", async () => {
		// `total_lines` derived from the payload is the file's length only when
		// the payload is the file. Under a composed window it is the window's, so
		// a 20-line page of a 100-line file answered `total_lines: 20` — which a
		// paginating server reads as "you have the whole thing".
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/big.ts", toolCallId: "c1", offset: 5, limit: 20 }),
			}),
			{
				execHandlers: {
					async read() {
						return toolResult("line5\nline6\nline7", {
							// The shape `read` records a composed range in: the flat
							// `truncation.totalLines` counts from the window's start,
							// `meta.truncation.totalLines` counts the file.
							details: {
								truncation: { truncated: true, totalLines: 97 },
								meta: { truncation: { totalLines: 101 } },
								fileSize: 4096,
							},
						});
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "readResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.totalLines).toBe(101);
		expect(answer.value.result.value.rangeApplied).toBe(true);
		expect(answer.value.result.value.fileSize).toBe(4096n);
	});

	it("counts the payload when the read returned the file whole", async () => {
		// No window, no recorded total: the payload IS the file, so counting it
		// is exact and the fallback must stay.
		const { frames } = await dispatchExec(
			buildExecMessage({
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/repo/small.ts", toolCallId: "c1" }),
			}),
			{
				execHandlers: {
					async read() {
						return toolResult("a\nb\nc");
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "readResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.totalLines).toBe(3);
	});

	it("signals the native grep backend's internal cap", async () => {
		// `GrepTool` folds that ceiling into the flat `details.truncated` alone —
		// no `details.truncation`, no `perFileLimitReached`. Forwarding only the
		// latter two answered a clipped search as an unqualified success, which
		// is the one truncation a caller can neither detect nor page around.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piGrepArgs", value: create(PiGrepExecArgsSchema, { pattern: "hit" }) }),
			{
				execHandlers: {
					async piGrep() {
						return toolResult("a.ts:1:hit", { details: { truncated: true } });
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "piGrepResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.truncation?.truncated).toBe(true);
		expect(answer.value.result.value.truncation?.truncatedBy).toBe("matches");
	});

	it("leaves an untruncated grep unqualified", async () => {
		// The flat flag is the only signal consulted, so a search that hit no cap
		// must not acquire one.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piGrepArgs", value: create(PiGrepExecArgsSchema, { pattern: "hit" }) }),
			{
				execHandlers: {
					async piGrep() {
						return toolResult("a.ts:1:hit", { details: { truncated: false } });
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "piGrepResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.truncation).toBeUndefined();
	});

	it("does not restate a cap that already reported itself", async () => {
		// `perFileLimitReached` carries the count; adding a second, countless
		// truncation record for the same event tells the server two caps fired.
		const { frames } = await dispatchExec(
			buildExecMessage({ case: "piGrepArgs", value: create(PiGrepExecArgsSchema, { pattern: "hit" }) }),
			{
				execHandlers: {
					async piGrep() {
						return toolResult("a.ts:1:hit", { details: { truncated: true, perFileLimitReached: 20 } });
					},
				},
			},
		);
		const answer = soleResult(frames);
		if (answer.case !== "piGrepResult") throw new Error(`got ${answer.case}`);
		if (answer.value.result.case !== "success") throw new Error(`got ${answer.value.result.case}`);
		expect(answer.value.result.value.matchLimitReached).toBe(20);
		expect(answer.value.result.value.truncation).toBeUndefined();
	});

	it("records the scoped grep's context and cap in the synthesized call", async () => {
		// Neither field is expressible in the `grep` schema, so the bridge serves
		// them by building a scoped tool. A block that omits them replays a
		// context-widened, capped search as an ordinary grep.
		const { output } = await dispatchExec(
			buildExecMessage({
				case: "piGrepArgs",
				value: create(PiGrepExecArgsSchema, { pattern: "hit", context: 3, limit: 50 }),
			}),
			{
				execHandlers: {
					async piGrep() {
						return toolResult("a.ts:1:hit");
					},
				},
			},
		);
		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].arguments).toMatchObject({ pattern: "hit", context: 3, limit: 50 });
	});

	it("names the MCP resources it listed in the paired result", async () => {
		// Rebuilt history is serialized from the paired result, so recording only
		// a count leaves the model aware it once saw N resources and unable to
		// name the URIs a follow-up read needs.
		const { results } = await dispatchExec(
			buildExecMessage({
				case: "listMcpResourcesExecArgs",
				value: create(ListMcpResourcesExecArgsSchema, { server: "docs" }),
			}),
			{
				execHandlers: {
					listMcpResources: async () => [
						{ uri: "docs://readme", name: "README", mimeType: "text/markdown", server: "docs" },
						{ uri: "docs://changelog", server: "docs" },
					],
				},
			},
		);
		expect(results).toHaveLength(1);
		const text = results[0].content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("docs://readme");
		expect(text).toContain("README");
		expect(text).toContain("text/markdown");
		// A resource the server described with nothing but a URI still gets named.
		expect(text).toContain("docs://changelog");
	});

	it("says so plainly when a server advertises nothing", async () => {
		const { results } = await dispatchExec(
			buildExecMessage({
				case: "listMcpResourcesExecArgs",
				value: create(ListMcpResourcesExecArgsSchema, { server: "docs" }),
			}),
			{ execHandlers: { listMcpResources: async () => [] } },
		);
		expect(results).toHaveLength(1);
		const text = results[0].content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toBe("No MCP resources available");
		expect(results[0].isError).toBe(false);
	});
});
