import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type BlockState,
	buildCursorHistoryForTest,
	buildCursorRequestContextRules,
	buildCursorSystemPromptJsons,
	emptyGrepPatternRejection,
	handleServerMessage,
	processInteractionUpdate,
	resolveExecHandler,
	streamCursor,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import { streamCursor as lazyStreamCursor, setCursorProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, CursorExecHandlers, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { McpResult, ReadResult } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	type AgentRunRequest,
	AgentServerMessageSchema,
	CursorRuleSource,
	ExecServerMessageSchema,
	McpArgsSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolResultContentItemSchema,
	ReadArgsSchema,
	ReadErrorSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, encodeJsonValue } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

const cursorModel: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const cursorMaxModeModel: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5-max",
	name: "Cursor Composer 2.5 Max",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
	cursorMaxMode: true,
});
function cursorAssistant(
	model: string,
	content: AssistantMessage["content"],
	timestamp: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "cursor-agent",
		provider: "cursor",
		model,
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function captureCursorPayload(context: Context, model: Model<"cursor-agent"> = cursorModel): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (isAgentRunRequest(payload)) {
				resolve(payload);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return !!payload && typeof payload === "object" && "$typeName" in payload;
}

function toolResultContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Use the read tool.", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
				content: [
					{
						type: "toolCall",
						id: "call-read",
						name: "read",
						arguments: { path: "package.json" },
					},
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

describe("Cursor resolveExecHandler execHandlers binding", () => {
	it("invokes handler with correct this when passed as bound method", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				// Handler methods rely on 'this' (e.g. to access other handlers or state).
				// When passed without .bind(handlers), 'this' is undefined in strict mode.
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read.bind(handlers),
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			() => ({ tag: "error" }),
			{ toolCallId: "exec-bind", toolName: "read" },
		);

		expect(execResult).toBe(sentinel);
		expect((execResult as { tag: string }).tag).toBe("bound-correctly");
	});

	it("handler loses this when passed unbound and fails or returns wrong result", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		// Pass method reference without .bind(handlers). In strict mode 'this' is undefined
		// when resolveExecHandler calls handler(args), so (this as any).sentinel throws.
		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read,
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			(msg: string) => ({ tag: "error", message: msg }),
			{ toolCallId: "exec-bind", toolName: "read" },
		);

		// Should get error result (handler threw accessing undefined.sentinel)
		expect(execResult).toEqual({ tag: "error", message: expect.any(String) });
	});

	// `synthesizeCursorExecToolCall` marks every exec block `kCursorExecResolved`
	// BEFORE the handler runs, so `agent-loop.ts` emits no placeholder result for
	// it. Any exit that returns no `toolResult` therefore leaves the call
	// unpaired and `buildSessionContext` strips the whole interaction on replay.
	describe("pairs a toolResult on every result-less exit", () => {
		const pairing = { toolCallId: "exec-1", toolName: "read" };

		it("pairs when no handler is installed", async () => {
			// The bare-SDK shape: `cursorExecHandlers` is optional, but the block
			// was already synthesized and resolved by the time we get here.
			const { execResult, toolResult } = await resolveExecHandler(
				{ path: "/tmp/foo" },
				undefined,
				undefined,
				() => ({}),
				(reason: string) => ({ tag: "rejected", reason }),
				() => ({ tag: "error" }),
				pairing,
			);

			expect(execResult).toEqual({ tag: "rejected", reason: "Tool not available" });
			// Same text the server sees in `execResult`, so transcript and wire agree.
			expect(toolResult).toMatchObject({
				role: "toolResult",
				toolCallId: "exec-1",
				toolName: "read",
				content: [{ type: "text", text: "Tool not available" }],
				isError: true,
			});
		});

		it("pairs when the handler produces nothing", async () => {
			const { execResult, toolResult } = await resolveExecHandler(
				{ path: "/tmp/foo" },
				async () => ({ execResult: undefined, toolResult: undefined }),
				undefined,
				() => ({}),
				(reason: string) => ({ tag: "rejected", reason }),
				() => ({ tag: "error" }),
				pairing,
			);

			expect(execResult).toEqual({ tag: "rejected", reason: "Tool returned no result" });
			expect(toolResult).toMatchObject({
				toolCallId: "exec-1",
				content: [{ type: "text", text: "Tool returned no result" }],
				isError: true,
			});
		});

		it("pairs when the handler throws", async () => {
			const { execResult, toolResult } = await resolveExecHandler(
				{ path: "/tmp/foo" },
				async () => {
					throw new Error("handler blew up");
				},
				undefined,
				() => ({}),
				() => ({ tag: "rejected" }),
				(message: string) => ({ tag: "error", message }),
				pairing,
			);

			expect(execResult).toEqual({ tag: "error", message: "handler blew up" });
			expect(toolResult).toMatchObject({
				toolCallId: "exec-1",
				content: [{ type: "text", text: "handler blew up" }],
				isError: true,
			});
		});

		it("pairs when the handler returns an execResult but no toolResult", async () => {
			// The server got a real answer; only the transcript side is missing.
			// Not an error — but still needs a result to keep the block paired.
			const { execResult, toolResult } = await resolveExecHandler(
				{ path: "/tmp/foo" },
				async () => ({ execResult: { tag: "ok" }, toolResult: undefined }),
				undefined,
				() => ({}),
				() => ({ tag: "rejected" }),
				() => ({ tag: "error" }),
				pairing,
			);

			expect(execResult).toEqual({ tag: "ok" });
			expect(toolResult).toMatchObject({ toolCallId: "exec-1", isError: false });
		});

		it("records a rejected TResult-only return as a failed call", async () => {
			// TResult-only is a supported handler form, so the transcript entry has
			// to be synthesized. A `rejected` result means Cursor was told the call
			// failed - recording it as successful hides that from the user and from
			// downstream lifecycle logic.
			const rejected = create(ReadResultSchema, {
				result: { case: "rejected", value: create(ReadRejectedSchema, { path: "/tmp/foo", reason: "denied" }) },
			});
			// Explicit TResult: `ReadResult` has its own `result` field, so inference
			// would otherwise match the `{ result?: TResult }` handler-return variant
			// and unwrap the oneof as the exec result.
			const { execResult, toolResult } = await resolveExecHandler<{ path: string }, ReadResult>(
				{ path: "/tmp/foo" },
				async () => rejected,
				undefined,
				() => rejected,
				() => rejected,
				() => rejected,
				pairing,
			);

			expect(execResult).toBe(rejected);
			// The variant's own text is what the server received, so reuse it.
			expect(toolResult).toMatchObject({
				toolCallId: "exec-1",
				content: [{ type: "text", text: "denied" }],
				isError: true,
			});
		});

		it("records an errored TResult-only return as a failed call", async () => {
			const errored = create(ReadResultSchema, {
				result: { case: "error", value: create(ReadErrorSchema, { path: "/tmp/foo", error: "EIO" }) },
			});
			const { toolResult } = await resolveExecHandler<{ path: string }, ReadResult>(
				{ path: "/tmp/foo" },
				async () => errored,
				undefined,
				() => errored,
				() => errored,
				() => errored,
				pairing,
			);

			expect(toolResult).toMatchObject({ content: [{ type: "text", text: "EIO" }], isError: true });
		});

		it("keeps a successful TResult-only return successful", async () => {
			// `success` is the only non-failure variant; the placeholder text still
			// applies because the handler gave the transcript nothing to show.
			const ok = create(ReadResultSchema, {
				result: {
					case: "success",
					value: create(ReadSuccessSchema, { path: "/tmp/foo", output: { case: "content", value: "hi" } }),
				},
			});
			const { toolResult } = await resolveExecHandler<{ path: string }, ReadResult>(
				{ path: "/tmp/foo" },
				async () => ok,
				undefined,
				() => ok,
				() => ok,
				() => ok,
				pairing,
			);

			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: "Tool produced no transcript result" }],
				isError: false,
			});
		});

		it("records an MCP success carrying is_error as a failed call", async () => {
			// MCP is the one shape where `success` is not enough: an application-level
			// tool failure rides inside the success variant as `is_error`, mirroring
			// the MCP spec. Cursor sees a failed tool, so the transcript must too.
			const mcpFailure = create(McpResultSchema, {
				result: {
					case: "success",
					value: create(McpSuccessSchema, {
						content: [
							create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: "upstream 503" }) },
							}),
						],
						isError: true,
					}),
				},
			});
			const { toolResult } = await resolveExecHandler<{ name: string }, McpResult>(
				{ name: "mcp__fixture" },
				async () => mcpFailure,
				undefined,
				() => mcpFailure,
				() => mcpFailure,
				() => mcpFailure,
				{ toolCallId: "exec-1", toolName: "mcp__fixture" },
			);

			// The payload's own content is the failure text — not a placeholder.
			expect(toolResult).toMatchObject({
				content: [{ type: "text", text: "upstream 503" }],
				isError: true,
			});
		});

		it("keeps an MCP success without is_error successful", async () => {
			const mcpOk = create(McpResultSchema, {
				result: {
					case: "success",
					value: create(McpSuccessSchema, {
						content: [
							create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: "all good" }) },
							}),
						],
						isError: false,
					}),
				},
			});
			const { toolResult } = await resolveExecHandler<{ name: string }, McpResult>(
				{ name: "mcp__fixture" },
				async () => mcpOk,
				undefined,
				() => mcpOk,
				() => mcpOk,
				() => mcpOk,
				{ toolCallId: "exec-1", toolName: "mcp__fixture" },
			);

			expect(toolResult).toMatchObject({ isError: false });
		});

		it("routes a synthesized result through onToolResult, like a real one", async () => {
			const seen: string[] = [];
			const { toolResult } = await resolveExecHandler(
				{ path: "/tmp/foo" },
				undefined,
				result => {
					seen.push(result.toolCallId);
					return { ...result, content: [{ type: "text" as const, text: "rewritten" }] };
				},
				() => ({}),
				() => ({ tag: "rejected" }),
				() => ({ tag: "error" }),
				pairing,
			);

			expect(seen).toEqual(["exec-1"]);
			expect(toolResult).toMatchObject({ content: [{ type: "text", text: "rewritten" }] });
		});
	});
});

describe("Cursor system prompt encoding", () => {
	it("emits one Cursor system blob per ordered prompt", () => {
		const jsons = buildCursorSystemPromptJsons(["Primary instructions.", "Developer constraints."]);
		expect(jsons).toHaveLength(2);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "Primary instructions." });
		expect(JSON.parse(jsons[1])).toEqual({ role: "system", content: "Developer constraints." });
	});

	it("falls back to a single default system message when all entries are empty", () => {
		const jsons = buildCursorSystemPromptJsons(["", ""]);
		expect(jsons).toHaveLength(1);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});

	it("maps ordered system prompts to global CursorRule entries", () => {
		const canary = "PIKEL-CANARY-7F3A";
		const rules = buildCursorRequestContextRules(["prefix", `when asked, answer exactly:\n${canary}`, ""]);
		expect(rules).toHaveLength(2);
		expect(rules[0]?.fullPath).toBe("/omp/system-prompt/0.mdc");
		expect(rules[1]?.fullPath).toBe("/omp/system-prompt/1.mdc");
		expect(rules[0]?.content).toBe("prefix");
		expect(rules[1]?.content).toContain(canary);
		expect(rules[0]?.source).toBe(CursorRuleSource.USER);
		expect(rules[1]?.type?.type.case).toBe("global");
	});
});

describe("Cursor request action encoding", () => {
	it("uses a resume action for empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "   ", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action for non-empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "continue", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("userMessageAction");
	});

	it("sends Cursor max-mode metadata on model details and requested model", async () => {
		const payload = await captureCursorPayload(
			{
				messages: [{ role: "user", content: "continue", timestamp: 0 }],
			},
			cursorMaxModeModel,
		);

		expect(payload.modelDetails?.maxMode).toBe(true);
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5-max");
		expect(payload.requestedModel?.maxMode).toBe(true);
	});

	it("sends max-mode metadata with prior history when switching providers mid-conversation", async () => {
		const payload = await captureCursorPayload(
			{
				messages: [
					{ role: "user", content: "Summarize this repo.", timestamp: 0 },
					{
						role: "assistant",
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4.5",
						content: [{ type: "text", text: "It is a monorepo." }],
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
					},
					{ role: "user", content: "continue", timestamp: 2 },
				],
			},
			cursorMaxModeModel,
		);

		expect(payload.modelDetails?.maxMode).toBe(true);
		expect(payload.requestedModel?.maxMode).toBe(true);
		// History from the other provider is carried into the fresh Cursor conversation.
		expect(payload.conversationState?.turns.length).toBeGreaterThan(0);
	});

	it("uses a resume action when a tool result is the final context message", async () => {
		const payload = await captureCursorPayload(toolResultContext());

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action with selected context for image-only user turns", async () => {
		const imageData = "aW1hZ2U=";
		const payload = await captureCursorPayload({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		});

		if (payload.action?.action.case !== "userMessageAction") {
			throw new Error("Expected Cursor userMessageAction");
		}
		const userMessage = payload.action.action.value.userMessage;
		expect(userMessage?.text).toBe("");
		expect(userMessage?.selectedContext?.selectedImages).toHaveLength(1);
		const selectedImage = userMessage?.selectedContext?.selectedImages[0];
		expect(selectedImage?.mimeType).toBe("image/png");
		if (selectedImage?.dataOrBlobId.case !== "data") {
			throw new Error("Expected Cursor selected image data");
		}
		expect(Array.from(selectedImage.dataOrBlobId.value)).toEqual(Array.from(Buffer.from(imageData, "base64")));
	});
});

describe("Cursor history encoding", () => {
	it("keeps an empty tool result paired with its structured call", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Read the empty window.", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "empty.txt", limit: 0 } }],
				2,
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "What did it say?", timestamp: 4 },
		];

		const history = buildCursorHistoryForTest(messages);
		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Read the empty window." }] },
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "call-read", toolName: "read", args: { path: "empty.txt", limit: 0 } },
				],
			},
			{
				role: "tool",
				id: "call-read",
				content: [{ type: "tool-result", toolName: "read", toolCallId: "call-read", result: "" }],
			},
		]);
	});

	it("omits undefined optional tool arguments from protobuf replay", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Search for TODOs.", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[
					{
						type: "toolCall",
						id: "call-grep",
						name: "grep",
						arguments: {
							pattern: "TODO",
							path: ".",
							case: undefined,
							context: undefined,
							limit: undefined,
						},
					},
				],
				2,
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "call-grep",
				toolName: "grep",
				content: [{ type: "text", text: "No matches" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "Continue.", timestamp: 4 },
		];

		const history = buildCursorHistoryForTest(messages);
		expect(history.rootPromptMessagesJson[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-grep",
					toolName: "grep",
					args: { pattern: "TODO", path: "." },
				},
			],
		});
		expect(history.turnStepMessagesJson).toEqual([
			[
				expect.objectContaining({
					toolCall: expect.objectContaining({
						mcpToolCall: expect.objectContaining({
							args: expect.objectContaining({
								args: { pattern: expect.any(String), path: expect.any(String) },
							}),
						}),
					}),
				}),
			],
		]);
	});

	it("normalizes non-JSON MCP arguments instead of aborting history replay", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Run the MCP tool.", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[
					{
						type: "toolCall",
						id: "call-mcp",
						name: "mcp__example_tool",
						arguments: {
							expectedHash: Number.POSITIVE_INFINITY,
							notANumber: Number.NaN,
							counter: 10n,
							nested: { value: Number.NEGATIVE_INFINITY, list: [1, 2n, Number.NaN] },
						},
					},
				],
				2,
				"toolUse",
			),
			{ role: "user", content: "Continue.", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages);
		expect(history.rootPromptMessagesJson[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-mcp",
					toolName: "mcp__example_tool",
					args: {
						expectedHash: null,
						notANumber: null,
						nested: { value: null, list: [1, null, null] },
					},
				},
			],
		});
	});

	it("keeps a __proto__ argument key as an own property during replay", () => {
		// A JSON.parse'd object carries `__proto__` as an own enumerable data
		// key. Building the normalized record with a plain `{}` would route the
		// assignment through the prototype setter and drop the key.
		const pollutedArguments = JSON.parse('{"__proto__":{"polluted":true},"safe":"ok"}') as Record<string, unknown>;
		const messages: Context["messages"] = [
			{ role: "user", content: "Run the MCP tool.", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[{ type: "toolCall", id: "call-mcp", name: "mcp__example_tool", arguments: pollutedArguments }],
				2,
				"toolUse",
			),
			{ role: "user", content: "Continue.", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages);
		const assistant = history.rootPromptMessagesJson[1] as {
			content: { args: Record<string, unknown> }[];
		};
		const args = assistant.content[0].args;
		expect(Object.hasOwn(args, "__proto__")).toBe(true);
		expect(Reflect.get(args, "__proto__")).toEqual({ polluted: true });
		expect(args.safe).toBe("ok");

		// The protobuf argument map must carry the same own keys — a plain `{}`
		// map would retarget its prototype to the encoded bytes and replay
		// inherited numeric indices instead of `__proto__`.
		const step = history.turnStepMessagesJson[0][0] as {
			toolCall: { mcpToolCall: { args: { args: Record<string, string> } } };
		};
		const encodedArgs = step.toolCall.mcpToolCall.args.args;
		expect(Object.keys(encodedArgs).sort()).toEqual(["__proto__", "safe"]);
	});

	it("excludes enumerable prototype properties from MCP history replay", () => {
		const nested: Record<string, unknown> = Object.create({ inheritedNested: "drop" });
		nested.own = "keep";
		const inheritedArguments: Record<string, unknown> = Object.create({ admin: true });
		inheritedArguments.safe = "ok";
		inheritedArguments.nested = nested;
		const messages: Context["messages"] = [
			{ role: "user", content: "Run the MCP tool.", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[{ type: "toolCall", id: "call-mcp", name: "mcp__example_tool", arguments: inheritedArguments }],
				2,
				"toolUse",
			),
			{ role: "user", content: "Continue.", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages);
		expect(history.rootPromptMessagesJson[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-mcp",
					toolName: "mcp__example_tool",
					args: { safe: "ok", nested: { own: "keep" } },
				},
			],
		});
		expect(history.turnStepMessagesJson[0][0]).toEqual({
			toolCall: {
				toolCallId: "call-mcp",
				mcpToolCall: {
					args: {
						name: "mcp__example_tool",
						args: { safe: expect.any(String), nested: expect.any(String) },
						toolCallId: "call-mcp",
						providerIdentifier: "pi-agent",
						toolName: "mcp__example_tool",
					},
				},
			},
		});
	});

	it("preserves same-model K3 thinking and paired tool structure in request history", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Inspect package.json", timestamp: 1 },
			cursorAssistant(
				"kimi-k3-high",
				[
					{ type: "thinking", thinking: "I should inspect the package." },
					{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } },
				],
				2,
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
			cursorAssistant(
				"kimi-k3-high",
				[
					{ type: "thinking", thinking: "The package is valid." },
					{ type: "text", text: "Verified." },
				],
				4,
			),
			{ role: "user", content: "What did you verify?", timestamp: 5 },
		];

		const history = buildCursorHistoryForTest(messages, undefined, "kimi-k3-high");

		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Inspect package.json" }] },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "I should inspect the package.",
						providerOptions: { cursor: { modelName: "kimi-k3-high" } },
					},
					{
						type: "tool-call",
						toolCallId: "call-read",
						toolName: "read",
						args: { path: "package.json" },
					},
				],
			},
			{
				role: "tool",
				id: "call-read",
				content: [
					{
						type: "tool-result",
						toolName: "read",
						toolCallId: "call-read",
						result: "package contents",
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "The package is valid.",
						providerOptions: { cursor: { modelName: "kimi-k3-high" } },
					},
					{ type: "text", text: "Verified." },
				],
			},
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[
				expect.objectContaining({ thinkingMessage: { text: "I should inspect the package." } }),
				expect.objectContaining({
					toolCall: expect.objectContaining({
						toolCallId: "call-read",
						mcpToolCall: expect.objectContaining({
							args: expect.objectContaining({ toolCallId: "call-read", toolName: "read" }),
							result: { success: { content: [{ text: { text: "package contents" } }] } },
						}),
					}),
				}),
				expect.objectContaining({ thinkingMessage: { text: "The package is valid." } }),
				expect.objectContaining({ assistantMessage: { text: "Verified." } }),
			],
		]);
		expect(buildCursorHistoryForTest(messages, undefined, "kimi-k3-high")).toEqual(history);
	});

	it("rejects switching existing foreign history to K3", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Plan this change.", timestamp: 1 },
			{
				...cursorAssistant(
					"claude-4.6-opus-high",
					[{ type: "thinking", thinking: "Foreign signed reasoning.", thinkingSignature: "signature" }],
					2,
				),
				api: "anthropic-messages",
				provider: "anthropic",
			},
			{ role: "user", content: "Continue with K3.", timestamp: 3 },
		];

		expect(() => buildCursorHistoryForTest(messages, undefined, "kimi-k3-high")).toThrow(
			"cannot continue history from a different model (anthropic/claude-4.6-opus-high)",
		);
	});

	it("replays a same-model K3 turn missing thinking instead of bricking the session", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Do a big multi-tool task", timestamp: 1 },
			cursorAssistant(
				"kimi-k3-high",
				[{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } }],
				2,
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
			cursorAssistant("kimi-k3-high", [{ type: "text", text: "Done." }], 4),
			{ role: "user", content: "Continue the same session", timestamp: 5 },
		];

		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const history = buildCursorHistoryForTest(messages, undefined, "kimi-k3-high");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("assistant turn(s) 1, 2"), {
			model: "kimi-k3-high",
			assistantTurns: [1, 2],
		});
		buildCursorHistoryForTest(messages, undefined, "kimi-k3-high");
		expect(warnSpy).toHaveBeenCalledTimes(1);

		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Do a big multi-tool task" }] },
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-read", toolName: "read", args: { path: "package.json" } }],
			},
			{
				role: "tool",
				id: "call-read",
				content: [{ type: "tool-result", toolName: "read", toolCallId: "call-read", result: "package contents" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "Done." }] },
		]);
	});

	it("keeps non-K3 Cursor thinking out of model-facing history", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Inspect package.json", timestamp: 1 },
			cursorAssistant(
				"cursor-composer-2.5",
				[
					{ type: "thinking", thinking: "Internal reasoning." },
					{ type: "text", text: "Visible answer." },
				],
				2,
			),
			{ role: "user", content: "Continue.", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages, undefined, "cursor-composer-2.5");
		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Inspect package.json" }] },
			{ role: "assistant", content: [{ type: "text", text: "Visible answer." }] },
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "Visible answer." } })],
		]);
	});

	it("keeps foreign thinking out of turns when switching to a non-K3 Cursor model", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "Plan this change.", timestamp: 1 },
			{
				...cursorAssistant(
					"claude-4.6-opus-high",
					[
						{ type: "thinking", thinking: "Foreign signed reasoning.", thinkingSignature: "signature" },
						{ type: "text", text: "Here is the plan." },
					],
					2,
				),
				api: "anthropic-messages",
				provider: "anthropic",
			},
			{ role: "user", content: "Continue.", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages, undefined, "cursor-composer-2.5");
		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Plan this change." }] },
			{ role: "assistant", content: [{ type: "text", text: "Here is the plan." }] },
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "Here is the plan." } })],
		]);
		for (const steps of history.turnStepMessagesJson) {
			for (const step of steps) {
				expect(step).not.toHaveProperty("thinkingMessage");
			}
		}
	});

	it("sanitizes foreign responses composite tool-call ids for Cursor replay", () => {
		// openai-codex/responses history stores composite `"{callId}|{itemId}"`
		// tool-call ids (encodeResponsesToolCallId). The `|` is invalid for
		// Cursor's tool-call-id charset and gets the whole Run rejected as
		// resource_exhausted, so it must be normalized identically on the call
		// and result sides.
		const compositeId = "call_abc123|fc_def456";
		const sanitizedId = "call_abc123_fc_def456";
		const messages: Context["messages"] = [
			{ role: "user", content: "Read package.json", timestamp: 1 },
			{
				...cursorAssistant(
					"gpt-5.6-sol",
					[{ type: "toolCall", id: compositeId, name: "read", arguments: { path: "package.json" } }],
					2,
					"toolUse",
				),
				api: "openai-codex-responses",
				provider: "openai-codex",
			},
			{
				role: "toolResult",
				toolCallId: compositeId,
				toolName: "read",
				content: [{ type: "text", text: "{}" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "Continue.", timestamp: 4 },
		];

		const history = buildCursorHistoryForTest(messages, undefined, "cursor-composer-2.5");
		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "Read package.json" }] },
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: sanitizedId, toolName: "read", args: { path: "package.json" } }],
			},
			{
				role: "tool",
				id: sanitizedId,
				content: [{ type: "tool-result", toolName: "read", toolCallId: sanitizedId, result: "{}" }],
			},
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[
				expect.objectContaining({
					toolCall: expect.objectContaining({
						toolCallId: sanitizedId,
						mcpToolCall: expect.objectContaining({
							args: expect.objectContaining({ toolCallId: sanitizedId }),
						}),
					}),
				}),
			],
		]);
		expect(JSON.stringify(history)).not.toContain("|");
	});

	it("preserves image-only user turns in root prompt history and conversation turns", () => {
		const imageData = "aW1hZ2U=";
		const history = buildCursorHistoryForTest([
			{
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
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
			},
			{ role: "user", content: "what is in the image?", timestamp: 0 },
		]);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "image", image: `data:image/png;base64,${imageData}`, mediaType: "image/png" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([
			expect.objectContaining({
				selectedContext: {
					selectedImages: [
						expect.objectContaining({
							mimeType: "image/png",
							data: imageData,
						}),
					],
				},
			}),
		]);
	});

	it("preserves trailing tool result history for resume actions", () => {
		const history = buildCursorHistoryForTest(toolResultContext().messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Use the read tool." }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-read",
						toolName: "read",
						args: { path: "package.json" },
					},
				],
			},
			{
				role: "tool",
				id: "call-read",
				content: [
					{
						type: "tool-result",
						toolName: "read",
						toolCallId: "call-read",
						result: "package contents",
					},
				],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([expect.objectContaining({ text: "Use the read tool." })]);
		expect(history.turnStepMessagesJson).toEqual([
			[
				expect.objectContaining({
					toolCall: expect.objectContaining({
						toolCallId: "call-read",
						mcpToolCall: expect.objectContaining({
							result: { success: { content: [{ text: { text: "package contents" } }] } },
						}),
					}),
				}),
			],
		]);
	});

	it("preserves structured tool errors", () => {
		const errorContext: Context = {
			messages: [
				{
					role: "user",
					content: "Search for nothing.",
					timestamp: 1,
				},
				{
					role: "assistant",
					api: "cursor-agent",
					provider: "cursor",
					model: "cursor-composer-2.5",
					content: [
						{
							type: "toolCall",
							id: "call-search",
							name: "search",
							arguments: { pattern: "" },
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "Pattern must not be empty" }],
					isError: true,
					timestamp: 3,
				},
			],
		};

		const history = buildCursorHistoryForTest(errorContext.messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Search for nothing." }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-search",
						toolName: "search",
						args: { pattern: "" },
					},
				],
			},
			{
				role: "tool",
				id: "call-search",
				content: [
					{
						type: "tool-result",
						toolName: "search",
						toolCallId: "call-search",
						result: "Pattern must not be empty",
						isError: true,
					},
				],
			},
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[
				expect.objectContaining({
					toolCall: expect.objectContaining({
						toolCallId: "call-search",
						mcpToolCall: expect.objectContaining({
							result: { error: { error: "Pattern must not be empty" } },
						}),
					}),
				}),
			],
		]);
	});
});

describe("Cursor grepArgs empty-pattern guard (issue #4574)", () => {
	it("returns null when the pattern is a non-empty regex", () => {
		expect(emptyGrepPatternRejection("foo", undefined)).toBeNull();
		expect(emptyGrepPatternRejection("foo", "**/*.ts")).toBeNull();
		// Whitespace-only patterns count as valid: leading/trailing whitespace is
		// meaningful in regexes (indentation anchors), matching the coding-agent
		// grep tool's own contract at packages/coding-agent/src/tools/grep.ts.
		expect(emptyGrepPatternRejection(" \tfoo ", undefined)).toBeNull();
	});

	it("rejects an empty pattern with a glob-aware hint when only a glob is present", () => {
		const message = emptyGrepPatternRejection("", "**/*snapcompact*");
		expect(message).toContain("grep pattern is required");
		expect(message).toContain('"**/*snapcompact*"');
		expect(message).toContain("ls/read tool");
	});

	it("rejects an empty pattern with a plain message when no glob is present", () => {
		expect(emptyGrepPatternRejection("", undefined)).toBe("grep pattern is required (received an empty pattern).");
		expect(emptyGrepPatternRejection(undefined, undefined)).toBe(
			"grep pattern is required (received an empty pattern).",
		);
	});

	it("rejects a whitespace-only pattern the same way as an empty one", () => {
		expect(emptyGrepPatternRejection("   ", undefined)).toBe("grep pattern is required (received an empty pattern).");
		expect(emptyGrepPatternRejection("\t\n", "src/**/*.ts")).toContain('"src/**/*.ts"');
	});
});

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

describe("Cursor K3 completion warnings", () => {
	it("warns when a K3 turn ends without thinking blocks", () => {
		const output = cursorAssistantMessage();
		output.model = "kimi-k3-high";
		output.timestamp = 7516;
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		processInteractionUpdate(
			{ message: { case: "turnEnded", value: {} } },
			output,
			new AssistantMessageEventStream(),
			newBlockState(),
			{ sawTokenDelta: false },
		);

		expect(warnSpy).toHaveBeenCalledWith(
			"Cursor kimi-k3 turn completed without thinking blocks; persisted history will replay this turn without reasoning",
			{ model: "kimi-k3-high", messageTimestamp: 7516 },
		);
	});
});

describe("Cursor exec local-work tracking (issue #4593)", () => {
	it("marks the stream busy for the duration of a local exec handler", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];
		const handlerGate = Promise.withResolvers<void>();
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				await handlerGate.promise;
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		};
		const serverMsg = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-1",
					message: {
						case: "readArgs",
						value: create(ReadArgsSchema, { path: "/tmp/slow-file", toolCallId: "call-read-1" }),
					},
				}),
			},
		});

		expect(stream.hasPendingLocalWork).toBe(false);
		const dispatch = handleServerMessage(
			serverMsg,
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

		// The exec round-trip is in flight: the stream must advertise local
		// work so the lazy idle watchdog defers instead of aborting.
		expect(stream.hasPendingLocalWork).toBe(true);

		handlerGate.resolve();
		await dispatch;

		expect(stream.hasPendingLocalWork).toBe(false);
		// The read result went back out on the exec channel.
		expect(written.length).toBe(1);
	});

	it("synthesizes an MCP call while preserving opaque string arguments", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];
		const serverMsg = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-mcp-1",
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "mcp__fixture_report",
							toolName: "mcp__fixture_report",
							toolCallId: "call-mcp-1",
							providerIdentifier: "pi-agent",
							args: {
								query: new TextEncoder().encode(JSON.stringify("latest chess news")),
								numericHash: encodeJsonValue("57785654"),
								exponentHash: encodeJsonValue("1e234567"),
								booleanToken: encodeJsonValue("true"),
								nullToken: encodeJsonValue("null"),
								nested: encodeJsonValue('{"enabled":true}'),
								array: encodeJsonValue("[1,2]"),
								quoted: encodeJsonValue('"label"'),
							},
						}),
					},
				}),
			},
		});
		const execHandlers: CursorExecHandlers = {
			async mcp(args) {
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: args.toolName,
					content: [{ type: "text", text: "reported" }],
					isError: false,
					timestamp: 1,
				};
			},
		};

		await handleServerMessage(
			serverMsg,
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			{
				sawTokenDelta: false,
			},
			[],
		);

		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: "Final synthesized answer" } } },
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(output.content).toHaveLength(2);
		expect(output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-mcp-1",
			name: "mcp__fixture_report",
			arguments: {
				query: "latest chess news",
				numericHash: "57785654",
				exponentHash: "1e234567",
				booleanToken: "true",
				nullToken: "null",
				nested: { enabled: true },
				array: [1, 2],
				quoted: "label",
			},
		});
		expect(output.content[1]).toMatchObject({ type: "text", text: "Final synthesized answer" });
		expect(state.resolvedMcpToolCallIds.has("call-mcp-1")).toBe(true);
	});

	it("leaves an MCP call unpaired when no mcp handler is installed", async () => {
		// The exception to the pairing rule. Every other exec case synthesizes a
		// block and marks it resolved unconditionally, but `mcpArgs` only marks it
		// when an `mcp` handler exists. Without one the streamed block stays
		// unresolved, so `agent-loop.ts` runs it locally and pairs its own result
		// — synthesizing one here would double up.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];
		const serverMsg = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-mcp-2",
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "mcp__fixture_report",
							toolName: "mcp__fixture_report",
							toolCallId: "call-mcp-unhandled",
							providerIdentifier: "pi-agent",
						}),
					},
				}),
			},
		});
		const collected: ToolResultMessage[] = [];

		await handleServerMessage(
			serverMsg,
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			result => {
				collected.push(result);
				return result;
			},
			{ sawTokenDelta: false },
			[],
		);

		expect(state.resolvedMcpToolCallIds.has("call-mcp-unhandled")).toBe(false);
		expect(collected).toEqual([]);

		// The block itself only exists once the streamed call arrives. It must
		// come out unresolved, so `agent-loop.ts` executes it and pairs a result.
		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "call-mcp-unhandled",
						toolCall: {
							mcpToolCall: {
								args: {
									name: "mcp__fixture_report",
									toolName: "mcp__fixture_report",
									toolCallId: "call-mcp-unhandled",
								},
							},
						},
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const mcpBlock = output.content.find(
			(block): block is ToolCallState => block.type === "toolCall" && block.id === "call-mcp-unhandled",
		);
		expect(mcpBlock).toBeDefined();
		expect(mcpBlock?.[kCursorExecResolved]).toBeUndefined();
	});

	it("pairs a result for a synthesized exec block when no handler is installed", async () => {
		// End-to-end over the real dispatch: synthesis, resolved marking and
		// pairing must line up. `cursorExecHandlers` is optional (a bare SDK host
		// passes none), but the block is synthesized and marked
		// `kCursorExecResolved` regardless, so `agent-loop.ts` emits no
		// placeholder for it. Production callsites discard the returned
		// `toolResult` — the sink is the only path that reaches the transcript,
		// so an unpaired call here is stripped from every rebuild.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];
		const serverMsg = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-read-1",
					message: {
						case: "readArgs",
						value: create(ReadArgsSchema, { path: "/tmp/orphan", toolCallId: "call-read-orphan" }),
					},
				}),
			},
		});
		const collected: ToolResultMessage[] = [];

		await handleServerMessage(
			serverMsg,
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			result => {
				collected.push(result);
				return result;
			},
			{ sawTokenDelta: false },
			[],
		);

		const blocks = output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ id: "call-read-orphan", name: "read" });
		// Resolved => no placeholder from agent-loop, so the sink must have fired.
		expect(blocks[0][kCursorExecResolved]).toBe(true);
		expect(collected.map(result => result.toolCallId)).toEqual(["call-read-orphan"]);
		expect(collected[0]).toMatchObject({ toolName: "read", isError: true });
	});

	it("survives a local exec tool outliving the lazy idle budget end to end", async () => {
		const workDone = Promise.withResolvers<void>();
		// The tracked work completes only once the lazy watchdog has consulted
		// the stream's local-work state at two expired deadlines, proving the
		// idle budget was truly exceeded while the exec tool ran.
		class ProbedStream extends AssistantMessageEventStream {
			probeCalls = 0;
			override get hasPendingLocalWork(): boolean {
				this.probeCalls++;
				if (this.probeCalls >= 2) workDone.resolve();
				return super.hasPendingLocalWork;
			}
		}
		const source = new ProbedStream();
		let providerSignal: AbortSignal | undefined;
		setCursorProviderModule({
			streamCursor: (_model, _context, options) => {
				providerSignal = options.signal;
				void (async () => {
					const partial = cursorAssistantMessage();
					source.push({ type: "start", partial });
					source.push({ type: "text_delta", contentIndex: 0, delta: "spawning local tool", partial });
					await source.trackLocalWork(workDone.promise);
					const message = cursorAssistantMessage();
					source.push({ type: "done", reason: "stop", message });
				})();
				return source;
			},
		});

		const stream = lazyStreamCursor(cursorModel, { messages: [] }, { apiKey: "test", streamIdleTimeoutMs: 5 });
		const result = await stream.result();

		expect(providerSignal?.aborted).toBe(false);
		expect(source.probeCalls).toBeGreaterThanOrEqual(2);
		expect(result.stopReason).toBe("stop");
	});

	it("still aborts a silent cursor stream with no local work in flight", async () => {
		const partial = cursorAssistantMessage();
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial } as const;
				const stalled = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					stalled.reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => stalled.reject(new Error("Request was aborted")), {
					once: true,
				});
				await stalled.promise;
			},
		} as unknown as AssistantMessageEventStream;
		setCursorProviderModule({
			streamCursor: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = lazyStreamCursor(cursorModel, { messages: [] }, { apiKey: "test", streamIdleTimeoutMs: 10 });
		const result = await stream.result();

		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});
});
