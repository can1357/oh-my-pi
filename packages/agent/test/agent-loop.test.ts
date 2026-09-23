import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	agentLoop,
	agentLoopContinue,
	agentLoopDetailed,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core/agent-loop";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core/speculative-execution";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	SpeculativePhysicalOutcome,
	StreamFn,
	ToolCallContext,
} from "@oh-my-pi/pi-agent-core/types";
import { ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD, SPECULATIVE_STREAM_SESSION } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { kCursorExecResolved, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { createAssistantMessage, createHarmonyMitigationModel, createUserMessage } from "./helpers";

declare module "@oh-my-pi/pi-agent-core/types" {
	interface CustomAgentMessages {
		advisor: {
			role: "custom";
			customType: "advisor";
			content: string;
			display: boolean;
			attribution: "agent";
			timestamp: number;
		};
	}
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const harmonyMitigationModel = createHarmonyMitigationModel();

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Hi there!"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map(e => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("ends gracefully without a provider call after the deadline", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const prompt = createUserMessage("Hello");
		const mock = createMockModel({ responses: [{ content: ["Too late"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			deadline: Date.now() - 1,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([prompt], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(await stream.result()).toEqual([prompt]);
		expect(mock.calls).toHaveLength(0);
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("returns detailed telemetry when awaiting detailed() directly", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ content: ["Hi there!"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const { detailed } = agentLoopDetailed([createUserMessage("Hello")], context, config, undefined, mock.stream);
		const result = await detailed();

		expect(result.messages).toHaveLength(2);
		expect(result.telemetry?.stepCount).toBe(1);
		expect(result.telemetry?.chats.total).toBe(1);
		expect(result.coverage?.modelsUsed).toEqual([mock.model.id]);
	});

	it("re-samples when an assistant turn ends with a pause_turn stop", async () => {
		const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [] };
		const secondCallRoles: string[] = [];
		const mock = createMockModel({
			responses: [
				{ content: ["Scanning the repo first."], stopReason: "stop", stopDetails: { type: "pause_turn" } },
				context => {
					secondCallRoles.push(...context.messages.map(m => m.role));
					return { content: ["All done."] };
				},
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The pause re-samples with the commentary committed to history and no
		// tool results in between; the second response ends the run.
		expect(mock.calls).toHaveLength(2);
		expect(messages.map(m => m.role)).toEqual(["user", "assistant", "assistant"]);
		const [paused, final] = messages.slice(1) as AssistantMessage[];
		expect(paused.content).toEqual([{ type: "text", text: "Scanning the repo first." }]);
		expect(final.content).toEqual([{ type: "text", text: "All done." }]);
		// The follow-up request replayed the paused commentary, with no user or
		// tool-result message appended in between.
		expect(secondCallRoles).toEqual(["user", "assistant"]);
		// One turn_start per sampling round: the continuation ran as a fresh turn.
		expect(events.filter(e => e.type === "turn_start")).toHaveLength(2);
	});

	it("caps consecutive pause_turn continuations", async () => {
		const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [] };
		function* pauseForever(): Generator<MockResponse> {
			while (true) {
				yield { content: ["still working"], stopReason: "stop", stopDetails: { type: "pause_turn" } };
			}
		}
		const mock = createMockModel({ responses: pauseForever() });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream).result();

		// Initial sample + MAX_PAUSED_TURN_CONTINUATIONS (8), then the loop stops
		// cleanly instead of spinning on a backend that never stops pausing.
		expect(mock.calls).toHaveLength(9);
		expect(messages.at(-1)?.role).toBe("assistant");
	});

	it("retries when harmony leakage reaches the committed assistant message (openai-codex)", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		// First response leaks a harmony payload as visible assistant text; the
		// retry is clean. Mitigation only engages for openai-codex.
		const leak = "Some prose. analysis to=functions.edit code 大发官网";
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [leak] }, { content: ["clean retry response"] }],
		});
		const config: AgentLoopConfig = { model: harmonyMitigationModel, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The leaked attempt was retried, not committed.
		expect(mock.calls).toHaveLength(2);
		expect(messages).toHaveLength(2);
		const final = messages[1];
		if (final.role !== "assistant") throw new Error("expected assistant message");
		expect(final.content).toEqual([{ type: "text", text: "clean retry response" }]);
		expect(JSON.stringify(messages)).not.toContain("to=functions.");
	});

	it("does not hard-abort a codex tool call whose argument legitimately carries the marker", async () => {
		// A legit edit of a file (e.g. these harmony fixtures) whose content carries
		// `to=functions.*` next to a channel word + non-Latin script. tool_arg is
		// gated on the trailing-garbage `T` co-signal, and the loop supplies no parse
		// boundary, so the call commits + executes once instead of being detected as
		// a leak and retried/escalated.
		const toolSchema = type({ input: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { input: string }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.input);
				return { content: [{ type: "text", text: "ok" }], details: { input: params.input } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const leakyArg = "@fixtures/corpus.json\n+\tanalysis to=functions.edit code 大发官网\n";
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "edit", arguments: { input: leakyArg } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("edit a fixture")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		// The tool ran on the original (unmodified) argument and the turn was not
		// retried — a hard-abort would have left `executed` empty and consumed the
		// "done" response as a clean retry instead.
		expect(executed).toEqual([leakyArg]);
		expect(mock.calls).toHaveLength(2);
	});

	it("dispatches a tool call appended by transformAssistantMessage on a stop turn", async () => {
		// In-text edit recovery (coding-agent) rewrites a text-only `stop` turn into
		// a synthetic tool call inside this hook; the loop must scan tool calls
		// AFTER the transform so the appended call is validated and executed.
		const toolSchema = type({ input: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { input: string }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.input);
				return { content: [{ type: "text", text: "ok" }], details: { input: params.input } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [{ content: ["stray payload turn"], stopReason: "stop" }, { content: ["done"] }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			transformAssistantMessage: message => {
				const stray = message.content.some(block => block.type === "text" && block.text.includes("stray payload"));
				if (!stray || message.content.some(block => block.type === "toolCall")) return;
				message.content.push({
					type: "toolCall",
					id: "recovered-1",
					name: "edit",
					arguments: { input: "payload" },
				});
			},
		};
		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream).result();

		expect(executed).toEqual(["payload"]);
		const toolResult = messages.find(m => m.role === "toolResult") as ToolResultMessage | undefined;
		expect(toolResult?.toolCallId).toBe("recovered-1");
		// The paired result went back to the provider for a second turn.
		expect(mock.calls).toHaveLength(2);
	});

	it("emits an aborted assistant message when cancellation happens before provider events", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const controller = new AbortController();
		// The mock provider would reject without a configured response; we want the
		// agent's abort path to kick in before any event is emitted. Use a raw stream
		// that never emits anything.
		const streamFn = () => new AssistantMessageEventStream();

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		queueMicrotask(() => controller.abort());

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("Request was aborted");
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("does not wait for provider iterator cleanup when aborting a stalled response", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const controller = new AbortController();
		let returnCalled = false;
		const streamFn = () =>
			({
				result: () => Promise.withResolvers<AssistantMessage>().promise,
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.withResolvers<IteratorResult<AssistantMessageEvent>>().promise,
					return: () => {
						returnCalled = true;
						return Promise.withResolvers<IteratorResult<AssistantMessageEvent>>().promise;
					},
				}),
			}) as AssistantMessageEventStream;

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		queueMicrotask(() => controller.abort("stop now"));
		const messages = await stream.result();

		expect(returnCalled).toBe(true);
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("stop now");
	});

	it("surfaces a custom abort reason on the synthesized aborted message", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const controller = new AbortController();
		const streamFn = () => new AssistantMessageEventStream();

		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		// Abort with a reason (as the coding agent does for a user Esc interrupt).
		queueMicrotask(() => controller.abort("Interrupted by user"));

		for await (const _event of stream) {
			// drain
		}

		const messages = await stream.result();
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		// The reason rides AbortController.abort(reason) onto the message verbatim,
		// instead of the generic "Request was aborted" default.
		expect(finalMessage.errorMessage).toBe("Interrupted by user");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		let convertedMessages: Message[] = [];
		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter(m => (m as { role: string }).role !== "notification")
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			transformContext: async messages => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: messages => {
				convertedMessages = messages.filter(
					m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const stream = agentLoop([createUserMessage("new message")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("provides tool call batch context", async () => {
		const toolSchema = type({ value: "string" });
		const contexts: ToolCallContext[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const toolCall = (ctx as { toolCall?: ToolCallContext })?.toolCall;
				if (toolCall) {
					contexts.push(toolCall);
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "world" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
		};

		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.batchId).toBe(contexts[1]?.batchId);
		expect(contexts[0]?.total).toBe(2);
		expect(contexts[0]?.toolCalls).toEqual([
			{ id: "tool-1", name: "echo" },
			{ id: "tool-2", name: "echo" },
		]);
		expect(contexts[0]?.index).toBe(0);
		expect(contexts[1]?.index).toBe(1);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find(e => e.type === "tool_execution_start");
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBeFalsy();
		}
	});

	it("surfaces validation error for malformed JSON parse sentinels without leaking __rawJson", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				return { content: [] };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const rawJsonPayload = `{"i": Finding getAvailable definition, "value": "hello"}${"A".repeat(1000)}`;
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: {
								__parseError: "Unexpected token F in JSON at position 6",
								__rawJson: rawJsonPayload,
							},
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		// Validation should have failed and reported the parse error & truncated JSON
		const toolResultMsg = events.find(e => e.type === "message_start" && e.message.role === "toolResult") as any;
		expect(toolResultMsg).toBeDefined();
		const resultText = toolResultMsg.message.content[0].text;
		expect(resultText).toContain("Tool call arguments are not valid JSON.");
		expect(resultText).toContain("Unexpected token F");
		expect(resultText).toContain("[truncated");

		// Should have paired start and end events
		const toolStart = events.find(e => e.type === "tool_execution_start") as any;
		const toolEnd = events.find(e => e.type === "tool_execution_end") as any;
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();

		// Start args must not include __rawJson
		expect(toolStart.args).toBeDefined();
		expect(toolStart.args.__rawJson).toBeUndefined();
		expect(toolStart.args.__parseError).toBeDefined(); // keeps __parseError for visibility of parse failure
	});

	it("runs completed tool calls after a transient stream_read_error", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					stopReason: "error",
					errorMessage: "Error Code stream_read_error: stream_read_error",
				},
				{ content: ["done after recovery"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("run echo")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(mock.calls).toHaveLength(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.stopReason).toBe("toolUse");
		expect(recoveredTurn.stopDetails?.type).toBe("stream_interrupted_after_content");
		const finalTurn = messages[3] as AssistantMessage;
		expect(finalTurn.content).toContainEqual({ type: "text", text: "done after recovery" });
	});

	it("runs completed tool calls after an Anthropic stream envelope truncation error", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					stopReason: "error",
					errorMessage: "Anthropic stream envelope error: stream ended before message_stop",
				},
				{ content: ["done after recovery"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("run echo")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(mock.calls).toHaveLength(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.stopReason).toBe("toolUse");
		expect(recoveredTurn.stopDetails?.type).toBe("stream_interrupted_after_content");
	});

	it("runs completed tool calls after a transient stream JSON parse error", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					stopReason: "error",
					errorMessage: "JSON Parse error: Unterminated string",
				},
				{ content: ["done after parse recovery"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("run echo")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(mock.calls).toHaveLength(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.stopReason).toBe("toolUse");
		expect(recoveredTurn.stopDetails?.type).toBe("stream_interrupted_after_content");
		const finalTurn = messages[3] as AssistantMessage;
		expect(finalTurn.content).toContainEqual({ type: "text", text: "done after parse recovery" });
	});

	it("recovers only completed calls when a stream parse error interrupts the next call", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const completedCall = {
			type: "toolCall" as const,
			id: "tool-complete",
			name: "echo",
			arguments: { value: "complete" },
		};
		const incompleteCall = {
			type: "toolCall" as const,
			id: "tool-incomplete",
			name: "echo",
			arguments: { value: "incomplete" },
		};
		const mock = createMockModel({ responses: [{ content: ["done after partial parse recovery"] }] });
		let streamCalls = 0;
		const streamFn: typeof mock.stream = (model, callContext, options) => {
			streamCalls++;
			if (streamCalls > 1) return mock.stream(model, callContext, options);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial: AssistantMessage = {
					...createAssistantMessage([completedCall, incompleteCall], "error"),
					errorMessage: "provider stream parse failed",
					stopDetails: {
						type: "parse_error",
						explanation: "JSON Parse error: Unterminated string",
					},
				};
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: completedCall, partial });
				stream.push({ type: "toolcall_start", contentIndex: 1, partial });
				stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"value":"incomplete', partial });
				stream.push({ type: "error", reason: "error", error: partial });
			});
			return stream;
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop([createUserMessage("run echo")], context, config, undefined, streamFn).result();

		expect(executedParams).toEqual([{ value: "complete" }]);
		expect(streamCalls).toBe(2);
		expect(mock.calls).toHaveLength(1);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.stopReason).toBe("toolUse");
		expect(recoveredTurn.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"tool-complete",
		]);
		expect(messages.some(message => message.role === "toolResult" && message.toolCallId === "tool-incomplete")).toBe(
			false,
		);
	});

	it("does not recover a wrapped refusal after dropping an incomplete sibling", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return { content: [], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const completedCall = {
			type: "toolCall" as const,
			id: "tool-complete",
			name: "echo",
			arguments: { value: "complete" },
		};
		const incompleteCall = {
			type: "toolCall" as const,
			id: "tool-incomplete",
			name: "echo",
			arguments: { value: "incomplete" },
		};
		const mock = createMockModel({ responses: [{ content: ["should not continue"] }] });
		let streamCalls = 0;
		const streamFn: typeof mock.stream = (model, callContext, options) => {
			streamCalls++;
			if (streamCalls > 1) return mock.stream(model, callContext, options);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial: AssistantMessage = {
					...createAssistantMessage([completedCall, incompleteCall], "error"),
					errorMessage: "provider refused output",
					stopDetails: { type: "refusal", explanation: "Unexpected end of JSON input" },
				};
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: completedCall, partial });
				stream.push({ type: "toolcall_start", contentIndex: 1, partial });
				stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"value":"incomplete', partial });
				stream.push({ type: "error", reason: "error", error: partial });
			});
			return stream;
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop([createUserMessage("run echo")], context, config, undefined, streamFn).result();

		expect(executedParams).toEqual([]);
		expect(streamCalls).toBe(1);
		expect(mock.calls).toHaveLength(0);
		const errorTurn = messages[1] as AssistantMessage;
		expect(errorTurn.stopReason).toBe("error");
		expect(errorTurn.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"tool-complete",
		]);
		expect(errorTurn.stopDetails).toEqual({
			type: "stream_interrupted_after_content",
			category: "refusal",
			explanation: "Unexpected end of JSON input",
		});
	});

	it("does not recover a mixed known and unknown completed tool turn", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return { content: [], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-known", name: "echo", arguments: { value: "known" } },
						{ type: "toolCall", id: "tool-unknown", name: "missing", arguments: { value: "unknown" } },
					],
					stopReason: "error",
					errorMessage: "JSON Parse error: Unterminated string",
				},
				{ content: ["should not continue"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("run mixed tools")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		const errorTurn = messages[1] as AssistantMessage;
		expect(errorTurn.stopReason).toBe("error");
		expect(errorTurn.errorMessage).toBe("JSON Parse error: Unterminated string");
	});

	it("does not recover content-only transient stream parse errors", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({
			responses: [
				{
					content: ["partial response"],
					stopReason: "error",
					errorMessage: "JSON Parse error: Unterminated string",
				},
				{ content: ["should not continue"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("answer once")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(mock.calls).toHaveLength(1);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
		const errorTurn = messages[1] as AssistantMessage;
		expect(errorTurn.stopReason).toBe("error");
		expect(errorTurn.errorMessage).toBe("JSON Parse error: Unterminated string");
	});

	it("does not recover ordinary transient errors or terminal stops quoting parse diagnostics", async () => {
		for (const stopDetails of [
			undefined,
			{ type: "refusal", explanation: "Unexpected end of JSON input" },
			{ type: "sensitive", explanation: "Unexpected end of JSON input" },
		]) {
			const executedParams: Array<{ value: string }> = [];
			const toolSchema = type({ value: "string" });
			const tool: AgentTool<typeof toolSchema, { value: string }> = {
				name: "echo",
				label: "Echo",
				description: "Echo tool",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					executedParams.push(params);
					return {
						content: [{ type: "text", text: `echoed: ${params.value}` }],
						details: { value: params.value },
					};
				},
			};
			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
			const mock = createMockModel({
				responses: [
					{
						content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						stopReason: "error",
						stopDetails,
						errorMessage: "rate_limit_error",
					},
					{ content: ["should not continue"] },
				],
			});
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

			const messages = await agentLoop(
				[createUserMessage("run echo")],
				context,
				config,
				undefined,
				mock.stream,
			).result();

			expect(executedParams).toEqual([]);
			expect(mock.calls).toHaveLength(1);
			expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
			const errorTurn = messages[1] as AssistantMessage;
			expect(errorTurn.stopReason).toBe("error");
			expect(errorTurn.errorMessage).toBe("rate_limit_error");
			expect(errorTurn.stopDetails).toEqual(stopDetails);
		}
	});

	it("labels the synthetic tool result for a provider-error turn as not-executed and preserves the upstream error", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `edited: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "edit", arguments: { value: "hello" } }],
					stopReason: "error",
					errorMessage: "Codex websocket transport error: websocket closed (1000)",
				},
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("edit thing")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		const toolResult = messages[2] as ToolResultMessage;
		expect(toolResult.isError).toBe(true);

		const text = toolResult.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		// The message must make it obvious the local tool never ran — this is the
		// bug in #4321: the previous wording ("Tool execution failed due to an
		// error: <upstream>") was indistinguishable from a real local tool
		// failure.
		expect(text).not.toContain("Tool execution failed due to an error");
		expect(text.toLowerCase()).toContain("not executed");
		expect(text.toLowerCase()).toContain("provider");
		expect(text).toContain("Codex websocket transport error: websocket closed (1000)");

		// Structured details on the synthetic result let downstream consumers
		// (UI, telemetry, ACP) distinguish it from a real tool failure without
		// string-matching the content.
		const details = toolResult.details as {
			__synthetic?: boolean;
			source?: string;
			executed?: boolean;
			upstreamError?: string;
		};
		expect(details.__synthetic).toBe(true);
		expect(details.source).toBe("assistant_stop_error");
		expect(details.executed).toBe(false);
		expect(details.upstreamError).toBe("Codex websocket transport error: websocket closed (1000)");

		const endEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "tool-1",
		);
		expect(endEvent).toBeDefined();
		expect(endEvent?.isError).toBe(true);
		// The event's result carries the same discriminator so the UI can
		// render "provider transport failed, tool not executed" instead of a
		// generic "Edit tool failed" panel.
		expect(endEvent?.result?.details?.__synthetic).toBe(true);
		expect(endEvent?.result?.details?.source).toBe("assistant_stop_error");
		expect(endEvent?.result?.details?.executed).toBe(false);
	});

	it("recovers completed custom-wire tool calls after stream_read_error", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			customWireName: "echo_wire",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "echo_wire", arguments: { value: "hello" } }],
					stopReason: "error",
					errorMessage: "Error Code stream_read_error: stream_read_error",
				},
				{ content: ["done after custom recovery"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop(
			[createUserMessage("run echo")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(mock.calls).toHaveLength(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const finalTurn = messages[3] as AssistantMessage;
		expect(finalTurn.content).toContainEqual({ type: "text", text: "done after custom recovery" });
	});

	it("routes unadvertised tool calls through resolveFallbackTool", async () => {
		const executedParams: Array<{ value: string }> = [];
		const toolSchema = type({ value: "string" });
		const deviceTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "browser",
			label: "Browser",
			description: "Mounted device tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params);
				return {
					content: [{ type: "text", text: `device: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		// The device is NOT in the advertised tool set.
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "browser", arguments: { value: "open" } },
						{ type: "toolCall", id: "tool-2", name: "nonexistent", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			resolveFallbackTool: name => (name === "browser" ? deviceTool : undefined),
		};

		const messages = await agentLoop(
			[createUserMessage("use the device")],
			context,
			config,
			undefined,
			mock.stream,
		).result();

		expect(executedParams).toEqual([{ value: "open" }]);
		const results = messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		const deviceResult = results.find(r => r.toolCallId === "tool-1");
		expect(deviceResult?.isError).toBeFalsy();
		expect(deviceResult?.content).toContainEqual({ type: "text", text: "device: open" });
		// Names the resolver does not know keep the "not found" failure.
		const missingResult = results.find(r => r.toolCallId === "tool-2");
		expect(missingResult?.isError).toBe(true);
		expect(missingResult?.content.some(c => c.type === "text" && c.text.includes("Tool nonexistent not found"))).toBe(
			true,
		);
	});

	it("hands resolveFallbackTool the request's advertised snapshot", async () => {
		// A host that recovers a mis-spelled name must resolve it against the set
		// THIS request advertised, not its own live tool state: an MCP
		// `tools/list_changed` reassigns the agent's tools mid-stream, so live
		// state can hold a roster the model never saw. The loop therefore hands
		// over the same snapshot exact-name dispatch searched.
		const toolSchema = type({ value: "string" });
		const advertisedTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "mcp__srv_bank",
			label: "Bank",
			description: "Advertised MCP tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `bank: ${params.value}` }], details: params };
			},
		};
		const advertisedTools = [advertisedTool];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: advertisedTools };
		const seen: Array<readonly { name: string }[]> = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "mcp__srv__bank", arguments: { value: "read" } }],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// Resolve ONLY from the handed-over snapshot; never from ambient state.
			resolveFallbackTool: (name, advertised) => {
				seen.push(advertised);
				return name === "mcp__srv__bank" ? advertised.find(tool => tool.name === "mcp__srv_bank") : undefined;
			},
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream).result();

		// The snapshot is the context's own array, so it cannot drift from what
		// exact-name dispatch matched against for this request.
		expect(seen.length).toBeGreaterThan(0);
		for (const advertised of seen) expect(advertised).toBe(advertisedTools);
		const result = messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tool-1");
		expect(result?.isError).toBeFalsy();
		expect(result?.content).toContainEqual({ type: "text", text: "bank: read" });
	});

	it("suggests the intended tool when a miss shares its trailing segment", async () => {
		const toolSchema = type({ path: "string" });
		const makeTool = (name: string): AgentTool<typeof toolSchema, { path: string }> => ({
			name,
			label: name,
			description: "Advertised tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.path }], details: params };
			},
		});
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [makeTool("read"), makeTool("mcp__context_resolve_library_id")],
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						// Whole id segment lost; only the trailing verb survived.
						{ type: "toolCall", id: "tool-1", name: "mcp__abc123__xyz789_read", arguments: { path: "p" } },
						// Separator lost; the tail after the last `__` still identifies it.
						{
							type: "toolCall",
							id: "tool-2",
							name: "mcp__context7__resolve_library_id",
							arguments: { path: "p" },
						},
						// Nothing in the advertised set shares a trailing segment.
						{ type: "toolCall", id: "tool-3", name: "totally_unrelated", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream).result();
		const results = messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		const textOf = (id: string): string =>
			(results.find(r => r.toolCallId === id)?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n");

		// The model reliably keeps the trailing verb, so the miss is recoverable
		// in-turn instead of costing a round trip.
		expect(textOf("tool-1")).toContain("Did you mean read?");
		expect(textOf("tool-2")).toContain("Did you mean mcp__context_resolve_library_id?");
		// No plausible target: the bare failure is preserved, never a guess.
		expect(textOf("tool-3")).toContain("Tool totally_unrelated not found");
		expect(textOf("tool-3")).not.toContain("Did you mean");
	});

	it("suggests a mounted device the advertised set does not contain", async () => {
		// Observed in a real transcript: the session mounts `github` as an
		// `xd://` device, the model emitted `mcp__<ns>__<id>_github`, and the miss
		// produced a bare `not found`. That is the one unrecoverable shape — the
		// capability is live, but it appears in no advertised name, so matching
		// only the advertised set had nothing to offer.
		const toolSchema = type({ path: "string" });
		const makeTool = (name: string): AgentTool<typeof toolSchema, { path: string }> => ({
			name,
			label: name,
			description: "Advertised tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.path }], details: params };
			},
		});
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [makeTool("read")],
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "mcp__nsnsnsnsnsns__ididididid_github", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// Devices are routable by `resolveFallbackTool` but never advertised.
			suggestFallbackToolNames: () => ["github", "lsp"],
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream).result();
		const result = messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "tool-1");
		const text = (result?.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).toContain("Did you mean github?");
		// Advisory only: naming the device must not dispatch it. No
		// `resolveFallbackTool` is installed here, so the call still fails.
		expect(result?.isError).toBe(true);
	});

	it("ranks the distinctive tail ahead of tools sharing only the generic one", async () => {
		const toolSchema = type({ path: "string" });
		const makeTool = (name: string): AgentTool<typeof toolSchema, { path: string }> => ({
			name,
			label: name,
			description: "Advertised tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.path }], details: params };
			},
		});
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			// Three tools share the weak `_get` tail and are listed first; only the
			// last matches the distinctive `resolve_library_get` tail.
			tools: [
				makeTool("alpha_get"),
				makeTool("beta_get"),
				makeTool("gamma_get"),
				makeTool("mcp__context_resolve_library_get"),
			],
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "bad__resolve_library_get", arguments: { path: "p" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, mock.stream).result();
		const result = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
		const text = (result?.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");

		// Listing is capped, so a uniquely-matching distinctive tail must survive
		// truncation rather than being crowded out by generic `_get` siblings.
		expect(text).toContain("mcp__context_resolve_library_get");
	});

	it("injects and strips intent when intent tracing is enabled", async () => {
		const toolSchema = type({ value: "string" });
		const executedParams: Record<string, unknown>[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params as Record<string, unknown>);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "hello", [INTENT_FIELD]: "Read one file" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			intentTracing: true,
		};

		const stream = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();
		const assistantWithToolCall = messages.find(
			message => message.role === "assistant" && message.content.some(content => content.type === "toolCall"),
		) as AssistantMessage | undefined;
		const tracedToolCall = assistantWithToolCall?.content.find(content => content.type === "toolCall");

		const firstRequestToolSchema = mock.calls[0]?.context.tools?.[0]?.parameters as
			| { properties?: Record<string, unknown>; required?: string[] }
			| undefined;
		expect(firstRequestToolSchema?.properties).toMatchObject({
			value: { type: "string" },
			[INTENT_FIELD]: { type: "string" },
		});
		expect(firstRequestToolSchema?.required).toEqual(expect.arrayContaining([INTENT_FIELD]));
		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(tracedToolCall?.type).toBe("toolCall");
		if (tracedToolCall?.type === "toolCall") {
			expect(tracedToolCall.intent).toBe("Read one file");
		}
	});

	it("normalizes trailing periods from intent at extraction site", async () => {
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [],
			tools: [
				{
					name: "echo",
					label: "echo",
					description: "echoes value",
					parameters: type({ value: "string" }),
					execute: async (_toolCallId, params: { value: string }) => ({
						content: [{ type: "text", text: params.value }],
					}),
				},
			],
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "hello", [INTENT_FIELD]: "Reading model role settings." },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			intentTracing: true,
		};

		const stream = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();
		const assistantWithToolCall = messages.find(
			message => message.role === "assistant" && message.content.some(content => content.type === "toolCall"),
		) as AssistantMessage | undefined;
		const tracedToolCall = assistantWithToolCall?.content.find(content => content.type === "toolCall");

		expect(tracedToolCall?.type).toBe("toolCall");
		if (tracedToolCall?.type === "toolCall") {
			expect(tracedToolCall.intent).toBe("Reading model role settings");
		}
	});

	it("runs shared tools in parallel and emits completion-ordered results", async () => {
		const toolSchema = type({ value: "string" });
		const startTimes: Record<string, number> = {};
		const finishTimes: Record<string, number> = {};
		const { promise: slowContinue, resolve: slowResolve } = Promise.withResolvers<void>();
		const { promise: slowStarted, resolve: slowStartedResolve } = Promise.withResolvers<void>();
		const { promise: fastFinished, resolve: fastFinishedResolve } = Promise.withResolvers<void>();

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "slow") {
					startTimes.slow = Bun.nanoseconds();
					slowStartedResolve();
					await slowContinue;
					finishTimes.slow = Bun.nanoseconds();
				} else {
					await slowStarted;
					startTimes.fast = Bun.nanoseconds();
					finishTimes.fast = Bun.nanoseconds();
					fastFinishedResolve();
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "slow" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "fast" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await fastFinished;
		slowResolve();
		await streamTask;

		expect(startTimes.fast).toBeDefined();
		expect(startTimes.slow).toBeDefined();
		expect(finishTimes.fast).toBeDefined();
		expect(finishTimes.slow).toBeDefined();
		expect(startTimes.fast).toBeLessThan(finishTimes.slow);
		expect(finishTimes.fast).toBeLessThan(finishTimes.slow);

		const toolResultStarts = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_start" }> =>
				e.type === "message_start" && e.message.role === "toolResult",
		);
		expect(toolResultStarts).toHaveLength(2);
		expect((toolResultStarts[0].message as ToolResultMessage).toolCallId).toBe("tool-2");
		expect((toolResultStarts[1].message as ToolResultMessage).toolCallId).toBe("tool-1");

		const turnEndEvent = events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
		expect(turnEndEvent).toBeDefined();
		if (!turnEndEvent) return;
		expect(turnEndEvent.toolResults.map(result => result.toolCallId)).toEqual(["tool-2", "tool-1"]);
	});

	it("resolves function-form concurrency per call", async () => {
		const toolSchema = type({ value: "string", exclusive: "boolean?" });
		const startTimes: Record<string, number> = {};
		const finishTimes: Record<string, number> = {};
		const { promise: slowContinue, resolve: slowResolve } = Promise.withResolvers<void>();
		const { promise: slowStarted, resolve: slowStartedResolve } = Promise.withResolvers<void>();
		const { promise: fastFinished, resolve: fastFinishedResolve } = Promise.withResolvers<void>();

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: args => (args.exclusive === true ? "exclusive" : "shared"),
			async execute(_toolCallId, params) {
				if (params.value === "slow") {
					startTimes.slow = Bun.nanoseconds();
					slowStartedResolve();
					await slowContinue;
					finishTimes.slow = Bun.nanoseconds();
				} else if (params.value === "fast") {
					await slowStarted;
					startTimes.fast = Bun.nanoseconds();
					finishTimes.fast = Bun.nanoseconds();
					fastFinishedResolve();
				} else {
					startTimes.exclusive = Bun.nanoseconds();
					finishTimes.exclusive = Bun.nanoseconds();
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "slow" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "fast" } },
						{
							type: "toolCall",
							id: "tool-3",
							name: "echo",
							arguments: { value: "last", exclusive: true },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await fastFinished;
		slowResolve();
		await streamTask;

		// Both shared calls overlapped: fast started and finished while slow was running.
		expect(startTimes.fast).toBeLessThan(finishTimes.slow);
		expect(finishTimes.fast).toBeLessThan(finishTimes.slow);
		// The exclusive call waited for every shared call to finish.
		expect(startTimes.exclusive).toBeGreaterThan(finishTimes.slow);
		expect(startTimes.exclusive).toBeGreaterThan(finishTimes.fast);
	});

	it("drops incomplete tool calls when assistant aborts before toolcall_end", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const abortController = new AbortController();
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		// Custom stream: emit a partial assistant that already contains a tool
		// call, then abort before any `toolcall_end` event proves that the args
		// completed. The agent must not synthesize a toolResult for that partial
		// call; replaying it would preserve unsafe/incomplete arguments.
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "yield", arguments: { data: { ok: true } } }],
					"toolUse",
				);
				stream.push({ type: "start", partial });
				setTimeout(() => {
					abortController.abort();
					stream.push({ type: "done", reason: "toolUse", message: partial });
				}, 0);
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, abortController.signal, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		expect(toolResultEvent).toBeUndefined();

		const assistantEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantEnd).toBeDefined();
		if (assistantEnd?.message.role !== "assistant") return;
		expect(assistantEnd.message.stopReason).toBe("aborted");
		expect(assistantEnd.message.content.some(block => block.type === "toolCall")).toBe(false);
	});

	it("drops incomplete tool calls on labeled user interrupts", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const abortController = new AbortController();
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage(
					[{ type: "toolCall", id: "", name: "browser", arguments: {} }],
					"toolUse",
				);
				stream.push({ type: "start", partial });
				setTimeout(() => {
					abortController.abort("Interrupted by user");
					stream.push({ type: "done", reason: "toolUse", message: partial });
				}, 0);
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, abortController.signal, streamFn);
		for await (const event of stream) events.push(event);

		expect(events.some(event => event.type === "message_end" && event.message.role === "toolResult")).toBe(false);
		const assistantEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantEnd?.message.role).toBe("assistant");
		if (assistantEnd?.message.role !== "assistant") return;
		expect(assistantEnd.message.errorMessage).toBe("Interrupted by user");
		expect(assistantEnd.message.content.some(block => block.type === "toolCall")).toBe(false);
	});

	it("should skip remaining interruptible waits when steering is queued", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const queuedUserMessage = createUserMessage("interrupt");
		let queuedDelivered = false;

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => executed.length >= 1 && !queuedDelivered,
			getSteeringMessages: async () => {
				// Deliver the steering message at the injection boundary after
				// tool execution has started
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// Only the first wait should execute; the second is skipped after steering is queued.
		expect(executed).toEqual(["first"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(true);
		expect(toolEnds[1].result.details).toEqual({
			__synthetic: true,
			source: "interrupt_skipped",
			executed: false,
		});
		const skippedContent = toolEnds[1].result.content[0];
		expect(skippedContent?.type).toBe("text");
		if (skippedContent?.type !== "text") throw new Error("skipped tool result must be text");
		expect(skippedContent.text).toContain("Skipped due to queued user message");
		expect(skippedContent.text).toContain("Do not count this skipped result as completed work");
		expect(skippedContent.text).toContain("retry the skipped tool if it is still needed");

		// Queued message should appear in events after the tool results and before the next model call.
		const eventSequence = events.flatMap(event => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		const sawInterruptInContext = mock.calls[1]?.context.messages.some(
			m => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
		);
		expect(sawInterruptInContext).toBe(true);
	});

	it("runs already-emitted non-interruptible tools when steering is queued and injects the steer after the batch (#10439)", async () => {
		// A user message typed while the model streams an `edit`/`write` must not
		// throw the finished call away: the generation cost is sunk, the tool is
		// cheap, and a skip only makes the model re-emit the same call.
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "write",
			label: "Write",
			description: "Non-interruptible side effect",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const queuedUserMessage = createUserMessage("interrupt");
		let queuedDelivered = false;

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "write", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "write", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			// Steering is already queued when the batch starts — the streaming
			// case: nothing has executed yet and the first record is at risk.
			hasSteeringMessages: () => mock.calls.length >= 1 && !queuedDelivered,
			getSteeringMessages: async () => {
				if (mock.calls.length < 1 || queuedDelivered) return [];
				queuedDelivered = true;
				return [queuedUserMessage];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(executed).toEqual(["first", "second"]);
		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.map(e => e.isError)).toEqual([false, false]);

		// The steer still lands at the batch boundary, after both results.
		const eventSequence = events.flatMap(event => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));
		const sawInterruptInContext = mock.calls[1]?.context.messages.some(
			m => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
		);
		expect(sawInterruptInContext).toBe(true);
	});

	it("should skip remaining interruptible waits with system advisory wording when advisor steering is queued", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const advisorMessage: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "pause before continuing",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		let advisorDelivered = false;

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				if (executed.length < 1 || advisorDelivered) {
					return { queued: false };
				}
				return { queued: true, source: "system" };
			},
			getSteeringMessages: async () => {
				if (executed.length >= 1 && !advisorDelivered) {
					advisorDelivered = true;
					return [advisorMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual(["first"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(true);
		const skippedContent = toolEnds[1].result.content[0];
		expect(skippedContent?.type).toBe("text");
		if (skippedContent?.type !== "text") throw new Error("skipped tool result must be text");
		expect(skippedContent.text).toContain("Skipped due to pending system advisory");
		expect(skippedContent.text).not.toContain("queued user message");
		expect(skippedContent.text).toContain("Do not count this skipped result as completed work");
		expect(skippedContent.text).toContain("retry the skipped tool if it is still needed");

		const advisorInjected = events.some(
			event =>
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "advisor" &&
				event.message.content === "pause before continuing",
		);
		expect(advisorInjected).toBe(true);
	});

	it("drains queued steering by aborting an interruptible tool mid-wait", async () => {
		const toolSchema = type({});
		let steerReady = false;
		let drained = false;
		let observedAbort = false;
		let resolvedByTimeout = false;

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Blocks until aborted (mimics a job poll)",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				steerReady = true;
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal?.aborted) {
					resolve();
				} else {
					const timer = setTimeout(() => {
						resolvedByTimeout = true;
						resolve();
					}, 2000);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				}
				await promise;
				observedAbort = signal?.aborted === true;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "wait", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => steerReady && !drained,
			getSteeringMessages: async () => {
				if (steerReady && !drained) {
					drained = true;
					return [createUserMessage("interrupt")];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(observedAbort).toBe(true);
		expect(resolvedByTimeout).toBe(false);
		expect(drained).toBe(true);
		expect(
			events.some(e => e.type === "message_start" && e.message.role === "user" && e.message.content === "interrupt"),
		).toBe(true);
	});

	it("distinguishes an in-flight abort from a never-executed steering skip", async () => {
		const toolSchema = type({});
		let steerReady = false;
		let drained = false;

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Starts work, then throws when steering aborts it",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				steerReady = true;
				if (!signal) throw new Error("missing tool abort signal");
				const aborted = Promise.withResolvers<void>();
				if (signal.aborted) {
					aborted.resolve();
				} else {
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				}
				await aborted.promise;
				throw new Error("aborted after partial work");
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "wait", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => steerReady && !drained,
			getSteeringMessages: async () => {
				if (!steerReady || drained) return [];
				drained = true;
				return [createUserMessage("interrupt")];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		const toolEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnd?.result.details).toEqual({
			__interrupted: true,
			source: "interrupt_skipped",
			execution: "started",
		});
		expect(toolEnd?.result.details).not.toHaveProperty("executed");
	});

	it("keeps a completed error result instead of clobbering it into skipped when a steer aborts the signal (#4752)", async () => {
		// A steer lands while an interruptible tool is in flight, aborting its shared
		// signal via the mid-batch watch poll. The tool nonetheless runs to completion
		// and returns a genuine error result (e.g. `ls` on a missing path exiting
		// non-zero). Its real output MUST survive — not be replaced by the "Skipped due
		// to queued user message" placeholder, which discards work the tool performed.
		const toolSchema = type({});
		let steerReady = false;
		let drained = false;

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "lslike",
			label: "Lslike",
			description: "Completes with an error result even after its signal aborts",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				steerReady = true;
				// Wait for the steering-watch poll to abort our signal, then finish
				// anyway with a real error result (no wall-clock sleep — await the abort).
				if (!signal?.aborted) {
					const { promise, resolve } = Promise.withResolvers<void>();
					signal?.addEventListener("abort", () => resolve(), { once: true });
					await promise;
				}
				expect(signal?.aborted).toBe(true);
				return {
					content: [{ type: "text", text: "ls: cannot access X: No such file or directory" }],
					details: {},
					isError: true,
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "lslike", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => steerReady && !drained,
			getSteeringMessages: async () => {
				if (steerReady && !drained) {
					drained = true;
					return [createUserMessage("interrupt")];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(1);
		const content = toolEnds[0].result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("tool result must be text");
		expect(content.text).toContain("No such file or directory");
		expect(content.text).not.toContain("Skipped due to queued user message");
		expect(toolEnds[0].isError).toBe(true);
		// The steer is still delivered at the injection boundary.
		expect(
			events.some(e => e.type === "message_start" && e.message.role === "user" && e.message.content === "interrupt"),
		).toBe(true);
	});

	it("drains queued IRC interrupts by aborting an interruptible tool mid-wait", async () => {
		const toolSchema = type({});
		let ircReady = false;
		let ircDrained = false;
		let observedAbort = false;
		let resolvedByTimeout = false;
		const ircMessage = createUserMessage("irc interrupt");

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Blocks until aborted (mimics a job poll)",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				ircReady = true;
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal?.aborted) {
					resolve();
				} else {
					const timer = setTimeout(() => {
						resolvedByTimeout = true;
						resolve();
					}, 1000);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				}
				await promise;
				observedAbort = signal?.aborted === true;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "wait", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasIrcInterrupts: () => ircReady && !ircDrained,
			getAsideMessages: async () => {
				if (ircReady && !ircDrained) {
					ircDrained = true;
					return [() => ircMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(observedAbort).toBe(true);
		expect(resolvedByTimeout).toBe(false);
		expect(ircDrained).toBe(true);
		expect(
			events.some(
				e => e.type === "message_start" && e.message.role === "user" && e.message.content === "irc interrupt",
			),
		).toBe(true);
	});

	it("cuts an interruptible wait short when a background completion is queued", async () => {
		const toolSchema = type({});
		let waiting = false;
		let drained = false;
		const notice = createUserMessage("process exited");

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Blocks until aborted, then rejects like a broker request",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				waiting = true;
				// Only the interrupt abort releases this; a regression hangs into the test deadline.
				const { promise, reject } = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => reject(new Error("Daemon broker request aborted")), {
					once: true,
				});
				await promise;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "wait", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasBackgroundCompletions: () => waiting && !drained,
			getAsideMessages: async () => {
				if (waiting && !drained) {
					drained = true;
					return [() => notice];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		const content = toolEnd?.result.content[0];
		if (content?.type !== "text") throw new Error("tool result must be text");
		expect(content.text).toContain("Skipped due to a queued background completion");
		expect(
			events.some(
				e => e.type === "message_start" && e.message.role === "user" && e.message.content === "process exited",
			),
		).toBe(true);
	});

	it("leaves the cooperative steering signal down for a queued background completion", async () => {
		const toolSchema = type({});
		let drained = false;
		let steeringSignal: AbortSignal | undefined;
		let softAbortedDuringRun: boolean | undefined;
		const peeked = Promise.withResolvers<void>();
		const notice = createUserMessage("job bg_9 completed");

		// Stands in for auto-background bash: non-interruptible, and it detaches
		// itself whenever the cooperative steering signal goes up.
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "run",
			label: "Run",
			description: "Foreground command that backgrounds itself on a steer",
			parameters: toolSchema,
			async execute() {
				// The batch watch peeked the completion queue; one macrotask later
				// any abort it decided to raise has landed.
				await peeked.promise;
				await new Promise<void>(resolve => setImmediate(resolve));
				softAbortedDuringRun = steeringSignal?.aborted === true;
				return { content: [{ type: "text", text: "ran inline" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "run", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getToolContext: toolCall => {
				steeringSignal = toolCall?.steeringSignal;
				return { toolCall } as AgentToolContext;
			},
			hasBackgroundCompletions: () => {
				peeked.resolve();
				return !drained;
			},
			getAsideMessages: async () => {
				if (drained) return [];
				drained = true;
				return [() => notice];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		// A completion notice must not push ordinary foreground work into the
		// background: the detached job's own completion would then detach the
		// next command, and so on (#12869).
		expect(softAbortedDuringRun).toBe(false);
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		const content = toolEnd?.result.content[0];
		if (content?.type !== "text") throw new Error("tool result must be text");
		expect(content.text).toBe("ran inline");
		// Still delivered, at the batch boundary.
		expect(
			events.some(
				e => e.type === "message_start" && e.message.role === "user" && e.message.content === "job bg_9 completed",
			),
		).toBe(true);
	});

	it("still raises the cooperative steering signal when a user steers after a background completion", async () => {
		const toolSchema = type({});
		let completionDrained = false;
		let steerQueued = false;
		let steeringDrained = false;
		let steeringSignal: AbortSignal | undefined;
		let softAbortedBeforeSteer: boolean | undefined;
		let softAbortedAfterSteer = false;
		let releaseSteeringWatch: (() => void) | undefined;
		const peeked = Promise.withResolvers<void>();
		const steeringMessage = createUserMessage("user steering");

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "run",
			label: "Run",
			description: "Foreground command that backgrounds itself on a steer",
			parameters: toolSchema,
			async execute() {
				await peeked.promise;
				await new Promise<void>(resolve => setImmediate(resolve));
				softAbortedBeforeSteer = steeringSignal?.aborted === true;
				steerQueued = true;
				releaseSteeringWatch?.();
				await new Promise<void>(resolve => {
					if (steeringSignal?.aborted) resolve();
					else steeringSignal?.addEventListener("abort", () => resolve(), { once: true });
				});
				softAbortedAfterSteer = true;
				return { content: [{ type: "text", text: "backgrounded" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "run", arguments: {} }] },
				{ content: ["done"] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getToolContext: toolCall => {
				steeringSignal = toolCall?.steeringSignal;
				return { toolCall } as AgentToolContext;
			},
			hasBackgroundCompletions: () => {
				peeked.resolve();
				return !completionDrained;
			},
			hasSteeringMessages: () => steerQueued && !steeringDrained,
			waitForSteeringMessages: () =>
				new Promise<void>(resolve => {
					releaseSteeringWatch = resolve;
				}),
			getSteeringMessages: async () => {
				if (!steerQueued || steeringDrained) return [];
				steeringDrained = true;
				return [steeringMessage];
			},
			getAsideMessages: async () => {
				if (completionDrained) return [];
				completionDrained = true;
				return [() => createUserMessage("job bg_9 completed")];
			},
		};

		for await (const _ of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			// drain
		}

		expect(softAbortedBeforeSteer).toBe(false);
		expect(softAbortedAfterSteer).toBe(true);
	});

	it("keeps legacy steering queued until the injection boundary when no non-consuming peek exists", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		let steerReady = false;
		let steeringDrained = false;
		const steeringMessage = createUserMessage("queued steering");

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				if (params.value === "first") steerReady = true;
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			// Legacy integrations may only have the consuming dequeue. The
			// mid-batch poll must not call it; the boundary below owns the drain.
			getSteeringMessages: async () => {
				if (steerReady && !steeringDrained) {
					steeringDrained = true;
					return [steeringMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(executed).toEqual(["first", "second"]);
		expect(steeringDrained).toBe(true);
		expect(
			events.some(
				e => e.type === "message_start" && e.message.role === "user" && e.message.content === "queued steering",
			),
		).toBe(true);
		expect(
			mock.calls[1]?.context.messages.some(
				m => m.role === "user" && typeof m.content === "string" && m.content === "queued steering",
			),
		).toBe(true);
	});

	it("does not abort a non-interruptible foreground tool when only IRC is queued", async () => {
		const toolSchema = type({});
		let ircReady = false;
		let ircDrained = false;
		let bgSignalAborted = true;
		let bgCompleted = false;
		let waitObservedAbort = false;
		const bgStarted = Promise.withResolvers<void>();
		const waitFinished = Promise.withResolvers<void>();
		const ircMessage = createUserMessage("peer irc");

		const bg: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "bg",
			label: "Bg",
			description: "Foreground non-interruptible work (mimics bash)",
			parameters: toolSchema,
			async execute(_toolCallId, _params, signal) {
				bgStarted.resolve();
				// Hold until the interruptible wait sibling has observed the IRC abort,
				// then finish normally. Reads `signal.aborted` at completion so the
				// assertion sees whether an IRC-only interrupt clobbered this signal.
				await waitFinished.promise;
				bgSignalAborted = signal?.aborted === true;
				bgCompleted = true;
				return { content: [{ type: "text", text: "bg done" }], details: {} };
			},
		};

		const wait: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Interruptible wait (mimics a job poll)",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				await bgStarted.promise;
				ircReady = true;
				const { promise, resolve } = Promise.withResolvers<void>();
				const timer = setTimeout(resolve, 2000);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						waitObservedAbort = true;
						resolve();
					},
					{ once: true },
				);
				await promise;
				waitFinished.resolve();
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [bg, wait] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call-bg", name: "bg", arguments: {} },
						{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasIrcInterrupts: () => ircReady && !ircDrained,
			getAsideMessages: async () => {
				if (ircReady && !ircDrained) {
					ircDrained = true;
					return [() => ircMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(waitObservedAbort).toBe(true);
		expect(bgCompleted).toBe(true);
		expect(bgSignalAborted).toBe(false);
		expect(ircDrained).toBe(true);
		const bgEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "call-bg",
		);
		expect(bgEnd?.isError).toBe(false);
		if (bgEnd?.result.content[0]?.type === "text") {
			expect(bgEnd.result.content[0].text).toContain("bg done");
		}
	});

	it("runs a queued non-interruptible tool after an IRC interrupt aborts an earlier wait (#7493)", async () => {
		// Reproduces the reporter's orchestration flow: a batch pairs an
		// interruptible `hub wait` with a non-interruptible `todo` update queued
		// behind it (todo is `concurrency: "exclusive"`). A peer subagent message
		// (IRC) lands mid-wait, aborting the wait. The queued todo had not started
		// yet, so the `interruptState.triggered` early-return in `runTool` skipped
		// it — surfacing as "Skipped due to pending peer interrupt". IRC must leave
		// non-interruptible foreground work alone whether it is already running or
		// still queued, so the todo update must actually execute.
		const toolSchema = type({});
		let ircReady = false;
		let ircDrained = false;
		let todoExecuted = false;
		const ircMessage = createUserMessage("peer irc");

		const wait: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Interruptible wait (mimics a job poll)",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, _params, signal) {
				ircReady = true;
				// Resolve strictly on the IRC abort under test — no wall-clock timer.
				// If the interrupt never fired the loop would hang, which is itself
				// the failure signal (ts-no-test-timers: await the real event).
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
				await promise;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const todo: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "todo",
			label: "Todo",
			description: "Non-interruptible local state mutation (mimics todo)",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute() {
				todoExecuted = true;
				return { content: [{ type: "text", text: "todo updated" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [wait, todo] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} },
						{ type: "toolCall", id: "call-todo", name: "todo", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasIrcInterrupts: () => ircReady && !ircDrained,
			getAsideMessages: async () => {
				if (ircReady && !ircDrained) {
					ircDrained = true;
					return [() => ircMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(ircDrained).toBe(true);
		expect(todoExecuted).toBe(true);
		const todoEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "call-todo",
		);
		expect(todoEnd?.isError).toBe(false);
		if (todoEnd?.result.content[0]?.type === "text") {
			expect(todoEnd.result.content[0].text).toContain("todo updated");
		}
	});

	it("does not abort a tool when its interruptibility resolver rejects the call", async () => {
		const toolSchema = type({ op: "'start' | 'wait'" });
		let steerReady = false;
		let drained = false;
		let observedAbort = false;
		const toolRelease = Promise.withResolvers<void>();

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Blocks on its own window (mimics a side-effecting start)",
			parameters: toolSchema,
			interruptible: params => params.op === "wait",
			async execute(_toolCallId, _params, signal) {
				steerReady = true;
				if (!signal?.aborted) await toolRelease.promise;
				observedAbort = signal?.aborted === true;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "wait", arguments: { op: "start" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				const queued = steerReady && !drained;
				if (queued) toolRelease.resolve();
				return queued;
			},
			getSteeringMessages: async () => {
				if (steerReady && !drained) {
					drained = true;
					return [createUserMessage("interrupt")];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, mock.stream)) {
			events.push(event);
		}

		expect(observedAbort).toBe(false);
		expect(steerReady).toBe(true);
		expect(drained).toBe(true);
		expect(
			events.some(e => e.type === "message_start" && e.message.role === "user" && e.message.content === "interrupt"),
		).toBe(true);
	});

	it("leaves steering queued when the run is aborted while interrupted tools settle", async () => {
		// Regression: the mid-batch steering poll used to DEQUEUE the message into
		// a loop-local variable. An external abort while the in-flight tools were
		// still settling then injected it into history right before the run died —
		// the message showed as "sent" but the agent never responded, and queue
		// consumers (clearAllQueues/hasQueuedMessages) could no longer see it.
		// The poll must only peek; an abort must leave the queue untouched.
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const abortController = new AbortController();
		const steerTriggered = Promise.withResolvers<void>();
		let steerReady = false;
		let drained = false;

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "shared",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				if (params.value === "fast") {
					steerReady = true;
				} else {
					// Slow tool: keep settling until the steering interrupt has
					// fired, then abort the whole run before resolving.
					await steerTriggered.promise;
					abortController.abort();
					await Bun.sleep(1);
				}
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "fast" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "slow" } },
					],
				},
				{ content: ["never reached"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				if (!steerReady) return false;
				steerTriggered.resolve();
				return true;
			},
			getSteeringMessages: async () => {
				if (!steerReady) return [];
				drained = true;
				return [createUserMessage("interrupt")];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, abortController.signal, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The queue was never drained into the dying run...
		expect(drained).toBe(false);
		// ...and the steering message never landed in history.
		const steerInjected = events.some(
			e => e.type === "message_start" && e.message.role === "user" && e.message.content === "interrupt",
		);
		expect(steerInjected).toBe(false);
		const steerInContext = context.messages.some(m => m.role === "user" && m.content === "interrupt");
		expect(steerInContext).toBe(false);
	});

	it("injects nothing when steering is retracted between the interrupt and the boundary", async () => {
		// The interrupt poll peeks; the queue owner may still cancel (Esc/Alt+Up
		// pulls the message back into the editor) before the loop reaches the
		// injection boundary. The boundary dequeue must then find nothing and the
		// loop must keep going without a phantom user message.
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		let steerReady = false;

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				if (executed.length >= 1) {
					steerReady = true;
					return true;
				}
				return false;
			},
			// Retraction: by the time the loop dequeues, the queue is empty again.
			getSteeringMessages: async () => [],
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The interrupt fired (second tool skipped), but no user message appeared.
		expect(steerReady).toBe(true);
		expect(executed).toEqual(["first"]);
		const userInjected = events.some(
			e => e.type === "message_start" && e.message.role === "user" && e.message.content !== "start",
		);
		expect(userInjected).toBe(false);

		// The loop still completed the turn normally.
		const finalAssistant = events.findLast(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		expect(finalAssistant).toBeDefined();
		if (finalAssistant?.message.role !== "assistant") return;
		expect(finalAssistant.message.stopReason).toBe("stop");
	});

	it("injects aside messages at the step boundary without interrupting tools", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const asideMessage = createUserMessage("bg-job-complete");
		let asideCommitted = false;
		Object.defineProperty(asideMessage, ASIDE_MESSAGE_COMMIT, { value: () => (asideCommitted = true) });
		let asideDelivered = false;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getAsideMessages: async () => {
				if (!asideDelivered && executed.length >= 1) {
					asideDelivered = true;
					return [asideMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// Asides are non-interrupting: BOTH tools in the batch run (steering would skip the 2nd).
		expect(executed).toEqual(["first", "second"]);

		// The aside lands after the tool results, before the next model call.
		const seq = events.flatMap(event => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(seq).toContain("bg-job-complete");
		expect(seq.indexOf("tool:tool-2")).toBeLessThan(seq.indexOf("bg-job-complete"));

		// The model saw it on the very next request — delivered mid-run, no yield required.
		const sawAsideInContext = mock.calls[1]?.context.messages.some(
			m => m.role === "user" && typeof m.content === "string" && m.content === "bg-job-complete",
		);
		expect(sawAsideInContext).toBe(true);
		expect(asideCommitted).toBe(true);
	});

	it("commits initial aside messages when they enter the live context", async () => {
		const message = createUserMessage("idle completion");
		let committed = false;
		Object.defineProperty(message, ASIDE_MESSAGE_COMMIT, { value: () => (committed = true) });
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };

		const stream = agentLoop(
			[message],
			context,
			{ model: mock.model, convertToLlm: identityConverter },
			undefined,
			mock.stream,
		);
		expect(committed).toBe(true);
		for await (const _event of stream) {
			// Drain the loop.
		}
	});

	it("discards a drained aside when the deadline expires before insertion", async () => {
		let now = 100;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const toolSchema = type({ value: "string" });
			let executed = false;
			const tool: AgentTool<typeof toolSchema, { value: string }> = {
				name: "echo",
				label: "Echo",
				description: "Echo tool",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					executed = true;
					return { content: [{ type: "text", text: "done" }], details: { value: params.value } };
				},
			};
			const aside = createUserMessage("completion");
			let committed = false;
			let discarded: Error | undefined;
			Object.defineProperties(aside, {
				[ASIDE_MESSAGE_COMMIT]: { value: () => (committed = true) },
				[ASIDE_MESSAGE_DISCARD]: { value: (error: Error) => (discarded = error) },
			});
			let delivered = false;
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } }] },
					{ content: ["unused"] },
				],
			});
			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
			const stream = agentLoop(
				[createUserMessage("start")],
				context,
				{
					model: mock.model,
					convertToLlm: identityConverter,
					deadline: 200,
					getAsideMessages: async () => {
						if (!delivered && executed) {
							delivered = true;
							now = 200;
							return [aside];
						}
						return [];
					},
				},
				undefined,
				mock.stream,
			);

			for await (const _event of stream) {
				// Drain the loop.
			}

			expect(committed).toBe(false);
			expect(discarded?.message).toContain("not committed");
			expect(context.messages).not.toContain(aside);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("isolates discard hooks when a later aside thunk fails", async () => {
		const throwingAside = createUserMessage("throwing completion");
		Object.defineProperty(throwingAside, ASIDE_MESSAGE_DISCARD, {
			value: () => {
				throw new Error("discard failed");
			},
		});
		const aside = createUserMessage("completion");
		let discarded: Error | undefined;
		Object.defineProperty(aside, ASIDE_MESSAGE_DISCARD, {
			value: (error: Error) => {
				discarded = error;
			},
		});
		let delivered = false;
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const stream = agentLoop(
			[createUserMessage("hi")],
			context,
			{
				model: mock.model,
				convertToLlm: identityConverter,
				getAsideMessages: async () => {
					if (delivered) return [];
					delivered = true;
					return [
						() => throwingAside,
						() => aside,
						() => {
							throw new Error("later aside failed");
						},
					];
				},
			},
			undefined,
			mock.stream,
		);

		const drain = async () => {
			for await (const _event of stream) {
				// Drain the loop.
			}
		};
		await expect(drain()).rejects.toThrow("later aside failed");
		expect(discarded?.message).toBe("later aside failed");
	});

	it("fails the stream instead of hanging when an initial aside commit hook throws", async () => {
		// Regression #12545: the aside-commit loop ran before agentLoop's try, so a
		// throwing host commit hook escaped as an unhandled rejection and left the
		// EventStream unsettled — stream.result() hung forever.
		const message = createUserMessage("boom");
		Object.defineProperty(message, ASIDE_MESSAGE_COMMIT, {
			value: () => {
				throw new Error("commit hook boom");
			},
		});
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const stream = agentLoop(
			[message],
			context,
			{ model: mock.model, convertToLlm: identityConverter },
			undefined,
			mock.stream,
		);
		await expect(stream.result()).rejects.toThrow("commit hook boom");
	});

	it("surfaces the original error when a discard hook throws in the loop's finally", async () => {
		// Regression #12545: discardAsides ran bare in runLoopBody's finally, so a
		// throwing host discard hook replaced the in-flight loop error. Here the
		// pending aside's commit hook throws mid-turn and its discard hook throws in
		// the finally; the surfaced failure must stay the original commit error.
		const toolSchema = type({ value: "string" });
		let executed = false;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed = true;
				return { content: [{ type: "text", text: "done" }], details: { value: params.value } };
			},
		};
		const aside = createUserMessage("completion");
		Object.defineProperties(aside, {
			[ASIDE_MESSAGE_COMMIT]: {
				value: () => {
					throw new Error("commit boom");
				},
			},
			[ASIDE_MESSAGE_DISCARD]: {
				value: () => {
					throw new Error("discard boom");
				},
			},
		});
		let delivered = false;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } }] },
				{ content: ["unused"] },
			],
		});
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			{
				model: mock.model,
				convertToLlm: identityConverter,
				getAsideMessages: async () => {
					if (!delivered && executed) {
						delivered = true;
						return [aside];
					}
					return [];
				},
			},
			undefined,
			mock.stream,
		);
		await expect(stream.result()).rejects.toThrow("commit boom");
	});

	it("evaluates aside thunks at injection and skips ones that return null", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let polls = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// A lazy aside that decides, at injection time, NOT to inject (e.g. superseded).
			getAsideMessages: async () => {
				polls++;
				return [() => null];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The thunk was consulted...
		expect(polls).toBeGreaterThan(0);
		// ...but a null result injects nothing and triggers no wasted continuation turn.
		const userStarts = events.filter(e => e.type === "message_start" && e.message.role === "user");
		expect(userStarts).toHaveLength(1); // only the original prompt
		expect(mock.calls).toHaveLength(1);
	});
});

it("refreshes tools and system prompt between same-turn model calls", async () => {
	const toolSchema = type({ value: "string" });
	let activeSystemPrompt = "prompt-one";
	let activeTools: Array<AgentTool<typeof toolSchema, { value: string }>> = [];
	const betaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "beta",
		label: "Beta",
		description: "Beta tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `beta:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	const alphaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "alpha",
		label: "Alpha",
		description: "Alpha tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			activeSystemPrompt = "prompt-two";
			activeTools = [alphaTool, betaTool];
			return {
				content: [{ type: "text", text: `alpha:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	activeTools = [alphaTool];

	const context: AgentContext = {
		systemPrompt: [activeSystemPrompt],
		messages: [],
		tools: activeTools,
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		syncContextBeforeModelCall: async currentContext => {
			currentContext.systemPrompt = [activeSystemPrompt];
			currentContext.tools = activeTools;
		},
	};

	const stream = agentLoop([createUserMessage("refresh tools")], context, config, undefined, mock.stream);
	for await (const _ of stream) {
		// drain
	}

	expect(mock.calls).toHaveLength(2);
	expect(mock.calls[0]?.context.systemPrompt).toEqual(["prompt-one"]);
	expect(mock.calls[0]?.context.tools?.map(tool => tool.name)).toEqual(["alpha"]);
	expect(mock.calls[1]?.context.systemPrompt).toEqual(["prompt-two"]);
	expect(mock.calls[1]?.context.tools?.map(tool => tool.name)).toEqual(["alpha", "beta"]);
});

it("recovers from provider whitespace loop recovery without duplicating assistant messages", async () => {
	const context: AgentContext = {
		systemPrompt: ["You are helpful."],
		messages: [],
		tools: [],
	};

	const customStreamFn = (model: any, _context: any, _options: any) => {
		const stream = new AssistantMessageEventStream();
		const run = async () => {
			try {
				const mockAssistantMsg = (): AssistantMessage => ({
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});

				// First Attempt
				const output1 = mockAssistantMsg();
				stream.push({ type: "start", partial: output1 });

				output1.content.push({ type: "thinking", thinking: "stale thoughts" });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: output1 });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: "stale thoughts", partial: output1 });
				stream.push({ type: "thinking_end", contentIndex: 0, content: "stale thoughts", partial: output1 });

				output1.content.push({ type: "toolCall", id: "fc_1", name: "todo", arguments: {} });
				stream.push({ type: "toolcall_start", contentIndex: 1, partial: output1 });

				// Wait a tick to simulate async stream delivery
				await Promise.resolve();

				// Recovery event: push a start with reset content!
				const output2 = mockAssistantMsg();
				stream.push({ type: "start", partial: output2 });

				// Second Attempt
				output2.content.push({ type: "text", text: "Hello!" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output2 });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello!", partial: output2 });
				stream.push({ type: "text_end", contentIndex: 0, content: "Hello!", partial: output2 });

				stream.push({
					type: "done",
					reason: "stop",
					message: output2,
				});
			} catch (err) {
				stream.fail(err);
			}
		};
		void run();
		return stream;
	};

	const mock = createMockModel();
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, customStreamFn as any);

	for await (const event of stream) {
		events.push(event);
	}

	const messages = await stream.result();

	// The final messages list should only contain one assistant message!
	const assistantMessages = messages.filter(m => m.role === "assistant");
	expect(assistantMessages).toHaveLength(1);
	expect(assistantMessages[0].content).toHaveLength(1);
	expect(assistantMessages[0].content[0].type).toBe("text");

	// Event sequence checks
	const messageStarts = events.filter(e => e.type === "message_start");
	// Should only have 1 message_start for the user message and 1 for the assistant message
	expect(messageStarts).toHaveLength(2);
	expect(messageStarts[0].message.role).toBe("user");
	expect(messageStarts[1].message.role).toBe("assistant");

	// Should have message_updates
	const updates = events.filter(e => e.type === "message_update");
	expect(updates.length).toBeGreaterThan(0);
});

describe("agentLoop event-driven steering watch", () => {
	it("wakes on a steering event instead of polling for it", async () => {
		const executed: string[] = [];
		let steerReady = false;
		let drained = false;
		let waitCalls = 0;
		let wake: (() => void) | undefined;

		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				// Make a steer available and wake the watcher, the way a real queue
				// does on enqueue. No timer is involved.
				if (params.value === "first") {
					steerReady = true;
					wake?.();
				}
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => (steerReady && !drained ? { queued: true, source: "user" } : { queued: false }),
			waitForSteeringMessages: async signal => {
				waitCalls++;
				if (steerReady) return;
				const waiter = Promise.withResolvers<void>();
				wake = waiter.resolve;
				signal?.addEventListener("abort", () => waiter.resolve(), { once: true });
				await waiter.promise;
			},
			getSteeringMessages: async () => {
				if (steerReady && !drained) {
					drained = true;
					return [createUserMessage("interrupt")];
				}
				return [];
			},
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		// The watcher woke on the event and stopped the batch before the second call.
		expect(executed).toEqual(["first"]);
		expect(waitCalls).toBeGreaterThan(0);
	});

	it("does not miss steering queued between the state check and subscription", async () => {
		const executed: string[] = [];
		let steerReady = false;
		let waitTimedOut = false;
		const firstToolStarted = Promise.withResolvers<void>();
		const checkStarted = Promise.withResolvers<void>();
		const checkRelease = Promise.withResolvers<void>();
		let baselinePeeked = false;
		let checking = false;
		let drained = false;
		let wake: (() => void) | undefined;
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params, signal) {
				executed.push(params.value);
				if (params.value === "first") {
					firstToolStarted.resolve();
					const waiter = Promise.withResolvers<void>();
					const timer = setTimeout(() => {
						waitTimedOut = true;
						waiter.resolve();
					}, 500);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							waiter.resolve();
						},
						{ once: true },
					);
					await waiter.promise;
				}
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: async () => {
				const queued = steerReady && !drained;
				if (!baselinePeeked) {
					// The provider-wait watch's baseline peek settles at once: the
					// first model call waits for it, so gating it on run progress
					// would deadlock the run before any tool starts. The gate below
					// targets the tool-batch watch's checks instead.
					baselinePeeked = true;
					return queued ? { queued: true, source: "user" } : { queued: false };
				}
				if (!checking) {
					checking = true;
					checkStarted.resolve();
					await checkRelease.promise;
				}
				return queued ? { queued: true, source: "user" } : { queued: false };
			},
			waitForSteeringMessages: async signal => {
				// This queue emits future transitions only. Queue state belongs to
				// hasSteeringMessages, so subscribing late cannot recover this edge.
				const waiter = Promise.withResolvers<void>();
				wake = waiter.resolve;
				signal?.addEventListener("abort", () => waiter.resolve(), { once: true });
				await waiter.promise;
			},
			getSteeringMessages: async () => {
				if (!steerReady || drained) return [];
				drained = true;
				return [createUserMessage("arrived on the edge")];
			},
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		const completion = (async () => {
			for await (const _event of stream) {
				// drain
			}
		})();
		await Promise.all([firstToolStarted.promise, checkStarted.promise]);
		steerReady = true;
		wake?.();
		checkRelease.resolve();
		await completion;

		expect(waitTimedOut).toBe(false);
		expect(drained).toBe(true);
		expect(executed).not.toContain("second");
	});

	it("completes cleanly when canceling a rejecting wait after queued steering", async () => {
		let drained = false;
		let watchCanceled = false;
		const unhandledRejections: unknown[] = [];
		const captureUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", captureUnhandledRejection);
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => (drained ? { queued: false } : { queued: true, source: "user" }),
			waitForSteeringMessages: signal => {
				const waiter = Promise.withResolvers<void>();
				signal?.addEventListener(
					"abort",
					() => {
						watchCanceled = true;
						waiter.reject(new Error("watch canceled"));
					},
					{ once: true },
				);
				return waiter.promise;
			},
			getSteeringMessages: async () => {
				if (drained) return [];
				drained = true;
				return [createUserMessage("already queued")];
			},
		};

		try {
			const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
			for await (const _event of stream) {
				// drain
			}
			await Bun.sleep(0);

			expect(drained).toBe(true);
			expect(watchCanceled).toBe(true);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", captureUnhandledRejection);
		}
	});

	it("does not hang teardown when the steering wait ignores its signal", async () => {
		const executed: string[] = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => ({ queued: false }),
			// Never settles and never observes the signal: a shape an integration can
			// legitimately write, since the contract does not require honouring it.
			waitForSteeringMessages: () => Promise.withResolvers<void>().promise,
			getSteeringMessages: async () => [],
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		expect(executed).toEqual(["only"]);
	});

	it("uses the IRC timer without polling the steering queue", async () => {
		const secondIrcCheck = Promise.withResolvers<void>();
		let steeringChecks = 0;
		let ircChecks = 0;
		let steeringChecksAtFirstIrc: number | undefined;
		let steeringChecksAtIrcTimer: number | undefined;
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				await secondIrcCheck.promise;
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				steeringChecks++;
				return false;
			},
			waitForSteeringMessages: () => Promise.withResolvers<void>().promise,
			hasIrcInterrupts: () => {
				ircChecks++;
				if (ircChecks === 1) steeringChecksAtFirstIrc = steeringChecks;
				if (ircChecks === 2) {
					steeringChecksAtIrcTimer = steeringChecks;
					secondIrcCheck.resolve();
				}
				return false;
			},
			getSteeringMessages: async () => [],
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		// The timer ticks for IRC only: no steering peek is added between ticks.
		// (Absolute counts also include the pre-first-event peek each model call's
		// provider wait performs, which is not what this test governs.)
		expect(steeringChecksAtFirstIrc).toBeDefined();
		expect(steeringChecksAtIrcTimer).toBe(steeringChecksAtFirstIrc!);
		expect(ircChecks).toBeGreaterThanOrEqual(2);
	});

	it("does not hang teardown when the steering check ignores cancellation", async () => {
		const executed: string[] = [];
		const check = Promise.withResolvers<boolean>();
		const checkStarted = Promise.withResolvers<void>();
		let checkCalls = 0;
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				await checkStarted.promise;
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => {
				checkCalls++;
				if (checkCalls !== 1) return false;
				checkStarted.resolve();
				return check.promise;
			},
			waitForSteeringMessages: () => Promise.withResolvers<void>().promise,
			getSteeringMessages: async () => [],
		};
		const controller = new AbortController();
		const stream = agentLoop([createUserMessage("start")], context, config, controller.signal, mock.stream);
		const drain = (async () => {
			for await (const _event of stream) {
				// drain
			}
		})();
		// The first check never answers, so the provider request parks on its
		// steering baseline; aborting the run must settle `ready` through the
		// watch teardown (not the hung check) so the aborted turn still closes
		// and nothing lingers.
		await checkStarted.promise;
		controller.abort();
		// This is the behavior under test, so retain a deadline; cancel its timer
		// when teardown succeeds instead of leaving a losing sleep alive.
		const timeout = Promise.withResolvers<boolean>();
		const timeoutId = setTimeout(() => timeout.resolve(false), 1000);
		const completed = await Promise.race([drain.then(() => true), timeout.promise]);
		clearTimeout(timeoutId);
		try {
			expect(completed).toBe(true);
			// The provider call never ran: the abort landed while the request
			// was still parked on its baseline, so no tool executed.
			expect(executed).toEqual([]);
		} finally {
			check.resolve(false);
			await drain;
		}
	});

	it("stops watching after a steering subscription rejects", async () => {
		let waitCalls = 0;
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				await Bun.sleep(0);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages: () => ({ queued: false }),
			waitForSteeringMessages: () => {
				waitCalls++;
				return Promise.reject(new Error("subscription unavailable"));
			},
			getSteeringMessages: async () => [],
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		// Exactly one subscription per watch — the provider wait before each of the
		// two model calls, plus the tool batch — and a rejection ends that watch
		// instead of resubscribing in a loop.
		expect(waitCalls).toBe(3);
	});
});

describe("agentLoop steering during the provider wait", () => {
	/**
	 * Queue shaped like AgentSession's: non-consuming peek, wake, consuming drain.
	 *
	 * `oneAtATime` mirrors Agent's one-steer-per-boundary mode — the only way a
	 * message survives a drain and is therefore still queued when the next
	 * request arms its steering watch.
	 */
	function createSteeringQueue(oneAtATime = false) {
		const queued: AgentMessage[] = [];
		let wake: (() => void) | undefined;
		let peeks = 0;
		return {
			get size(): number {
				return queued.length;
			},
			/** Non-consuming peeks the loop has made, across every watch it armed. */
			get peeks(): number {
				return peeks;
			},
			push(text: string): void {
				queued.push(createUserMessage(text));
				wake?.();
				wake = undefined;
			},
			config: {
				hasSteeringMessages: () => {
					peeks += 1;
					return { queued: queued.length > 0, source: "user" as const, pending: queued.length };
				},
				// Mirrors Agent: a waiter resolves immediately while ANY message is
				// queued, so a resolution is not proof that something arrived.
				waitForSteeringMessages: (signal?: AbortSignal) => {
					if (queued.length > 0 || signal?.aborted) return Promise.resolve();
					const waiter = Promise.withResolvers<void>();
					wake = waiter.resolve;
					signal?.addEventListener("abort", () => waiter.resolve(), { once: true });
					return waiter.promise;
				},
				getSteeringMessages: async () => queued.splice(0, oneAtATime ? 1 : queued.length),
			} satisfies Pick<AgentLoopConfig, "hasSteeringMessages" | "waitForSteeringMessages" | "getSteeringMessages">,
		};
	}

	function pushAnswer(stream: AssistantMessageEventStream, text: string): void {
		const partial = createAssistantMessage([{ type: "text", text }], "stop");
		stream.push({ type: "start", partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	}

	/** One macrotask boundary: every microtask an armed steering watcher would
	 *  use (wake -> peek -> abort) has run by the time this resolves. No wall
	 *  clock is involved, so the gap cannot flake under load. */
	function drainWatcherTurn(): Promise<void> {
		return new Promise<void>(resolve => setImmediate(resolve));
	}

	/** Text of every assistant turn the run committed, in order. */
	function assistantTexts(events: AgentEvent[]): string[] {
		return events.flatMap(event =>
			event.type === "message_end" && event.message.role === "assistant"
				? [
						event.message.content
							.filter(
								(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
									block.type === "text",
							)
							.map(block => block.text)
							.join(""),
					]
				: [],
		);
	}

	it("rebuilds the first dispatch when steering arrives during credential resolution", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const resolverStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<string>();
		const contexts: Context[] = [];
		let getApiKeyCalls = 0;
		let resolverCalls = 0;

		const streamFn: StreamFn = (_model, llmContext) => {
			contexts.push(llmContext);
			const response = new AssistantMessageEventStream();
			queueMicrotask(() => pushAnswer(response, "answer with steer"));
			return response;
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getApiKey: () => {
				getApiKeyCalls++;
				return async () => {
					resolverCalls++;
					resolverStarted.resolve();
					return releaseCredential.promise;
				};
			},
			...queue.config,
		};

		const run = (async (): Promise<AgentEvent[]> => {
			const events: AgentEvent[] = [];
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
			return events;
		})();

		await resolverStarted.promise;
		queue.push("actually, do X instead");
		await drainWatcherTurn();
		// Credential selection is still blocked, so no stale request reached the transport.
		expect(contexts).toEqual([]);
		releaseCredential.resolve("resolved-key");
		const events = await run;

		expect(getApiKeyCalls).toBe(1);
		expect(resolverCalls).toBe(1);
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.messages.some(m => m.role === "user" && m.content === "actually, do X instead")).toBe(
			true,
		);
		expect(queue.size).toBe(0);
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
		expect(
			events.some(
				e => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "aborted",
			),
		).toBe(false);
	});

	it("cancels a request that streamed nothing and re-issues it with the steer", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;
		let resolverCalls = 0;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				// The provider is still thinking (or retrying): no event will ever
				// arrive unless the request is cancelled.
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				queueMicrotask(() => queue.push("actually, do X instead"));
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getApiKey: () => async () => {
				resolverCalls++;
				return "key-" + resolverCalls;
			},
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(firstRequestAborted).toBe(true);
		expect(contexts.length).toBe(2);
		expect(resolverCalls).toBe(2);
		// The steer is in context for the re-issued call, and the queue is empty
		// before that call starts, so it cannot interrupt its own replacement.
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "actually, do X instead")).toBe(true);
		expect(queue.size).toBe(0);
		// No aborted boundary: nothing streamed, so nothing is persisted or shown.
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
		expect(
			events.some(
				e => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "aborted",
			),
		).toBe(false);
		// The steer is announced inside the still-open turn, before the retry.
		const userTexts = events.flatMap(e =>
			e.type === "message_start" && e.message.role === "user" && typeof e.message.content === "string"
				? [e.message.content]
				: [],
		);
		expect(userTexts).toEqual(["start", "actually, do X instead"]);
	});

	it("never interrupts a request that already streamed an event", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				const partial = createAssistantMessage([{ type: "text", text: "streamed answer" }], "stop");
				queueMicrotask(async () => {
					// First event: the interrupt window closes here.
					stream.push({ type: "start", partial });
					await drainWatcherTurn();
					// Steering that arrives now must never discard the streamed turn.
					queue.push("late steer");
					await drainWatcherTurn();
					stream.push({ type: "done", reason: "stop", message: partial });
				});
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer after boundary"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(firstRequestAborted).toBe(false);
		// The streamed turn is kept and the steer lands at the turn boundary.
		expect(assistantTexts(events)).toEqual(["streamed answer", "answer after boundary"]);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "late steer")).toBe(true);
		expect(
			events.some(
				e => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "aborted",
			),
		).toBe(false);
	});

	it("keeps an external abort in the same window a user abort and leaves the queue intact", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const abortController = new AbortController();
		const contexts: Context[] = [];

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			// Esc lands first; the message the user had already typed must survive
			// for the next run instead of being drained into a dying one.
			options?.signal?.addEventListener("abort", () => queue.push("typed before Esc"), { once: true });
			queueMicrotask(() => abortController.abort("Interrupted by user"));
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			[createUserMessage("start")],
			context,
			config,
			abortController.signal,
			streamFn,
		)) {
			events.push(event);
		}

		expect(contexts.length).toBe(1);
		const assistantEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantEnd?.message.role).toBe("assistant");
		if (assistantEnd?.message.role !== "assistant") return;
		expect(assistantEnd.message.stopReason).toBe("aborted");
		expect(assistantEnd.message.errorMessage).toBe("Interrupted by user");
		expect(queue.size).toBe(1);
	});

	it("parks the steer for the turn boundary when interruptMode is wait", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				queueMicrotask(async () => {
					// Queued while the provider has streamed nothing — exactly the window
					// "immediate" would cancel; "wait" must let the request finish.
					queue.push("steer while waiting");
					await drainWatcherTurn();
					pushAnswer(stream, "slow answer");
				});
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer after boundary"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "wait",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(firstRequestAborted).toBe(false);
		expect(assistantTexts(events)).toEqual(["slow answer", "answer after boundary"]);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "steer while waiting")).toBe(true);
	});

	it("keeps a request whose first event settled the race in the same tick as the steer", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel();
		const contexts: Context[] = [];
		const partial = createAssistantMessage([{ type: "text", text: "streamed answer" }], "stop");
		let firstRequestAborted = false;
		let firstStream: AssistantMessageEventStream | undefined;
		let peeks = 0;
		let wake: (() => void) | undefined;
		const queued: AgentMessage[] = [];

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			// The steer becomes visible in the very tick the provider delivers its
			// first event: the peek that reports it also pushes `start`, so the
			// first-event race settles before the watcher can be believed. The loop
			// must let that turn finish — the cancellation is only legal for a
			// request that produced nothing.
			hasSteeringMessages: () => {
				peeks += 1;
				if (peeks === 1) return { queued: false, source: "user" as const };
				if (firstStream) {
					queued.push(createUserMessage("same-tick steer"));
					firstStream.push({ type: "start", partial });
					firstStream = undefined;
				}
				return { queued: queued.length > 0, source: "user" as const };
			},
			waitForSteeringMessages: (signal?: AbortSignal) => {
				if (queued.length > 0 || signal?.aborted) return Promise.resolve();
				const waiter = Promise.withResolvers<void>();
				wake = waiter.resolve;
				signal?.addEventListener("abort", () => waiter.resolve(), { once: true });
				return waiter.promise;
			},
			getSteeringMessages: async () => queued.splice(0, queued.length),
		};

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				firstStream = stream;
				queueMicrotask(() => {
					// Wake the watcher while the loop is parked on the first event.
					wake?.();
					wake = undefined;
				});
				queueMicrotask(async () => {
					await drainWatcherTurn();
					stream.push({ type: "done", reason: "stop", message: partial });
				});
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer after boundary"));
			}
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(firstRequestAborted).toBe(false);
		expect(assistantTexts(events)).toEqual(["streamed answer", "answer after boundary"]);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "same-tick steer")).toBe(true);
	});

	it("folds a provider stream that fails with the steer abort reason into the steer path", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				// A real provider stream rejects its in-flight waiter (and its
				// result()) with the abort reason — the loop must read that as its own
				// cancellation, not as a `__omp.steer_interrupt__` run failure.
				options?.signal?.addEventListener("abort", () => stream.fail(options.signal?.reason), { once: true });
				queueMicrotask(() => queue.push("actually, do X instead"));
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		try {
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
			// Let a rejection abandoned by the decided race surface as unhandled.
			await drainWatcherTurn();
			await drainWatcherTurn();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(contexts.length).toBe(2);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "actually, do X instead")).toBe(true);
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
		expect(unhandled).toEqual([]);
	});

	it("takes the aborted-turn path when the user aborts before the steer is drained", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const abortController = new AbortController();
		const contexts: Context[] = [];

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			// Esc lands in the gap between the cancellation and the drain: the queued
			// message must stay queued for the next run instead of being injected
			// into a turn that is already dying.
			options?.signal?.addEventListener("abort", () => abortController.abort("Interrupted by user"), {
				once: true,
			});
			queueMicrotask(() => queue.push("typed before Esc"));
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			[createUserMessage("start")],
			context,
			config,
			abortController.signal,
			streamFn,
		)) {
			events.push(event);
		}

		// No re-issue: the turn aborted instead of folding the steer in.
		expect(contexts.length).toBe(1);
		expect(queue.size).toBe(1);
		const assistantEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "assistant",
		);
		expect(assistantEnd?.message.role).toBe("assistant");
		if (assistantEnd?.message.role !== "assistant") return;
		expect(assistantEnd.message.stopReason).toBe("aborted");
		expect(assistantEnd.message.errorMessage).toBe("Interrupted by user");
		expect(assistantTexts(events)).toEqual([""]);
	});

	it("closes a stream handed back by a provider that ignored the cancellation", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];

		/** Counts the iterator the loop abandons; a fresh generator per call is
		 *  exactly why `return()` alone cannot settle the stream. */
		class TrackedStream extends AssistantMessageEventStream {
			iteratorsReturned = 0;
			override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
				const inner = super[Symbol.asyncIterator]();
				return {
					next: () => inner.next(),
					return: async (value?: never) => {
						this.iteratorsReturned += 1;
						return (await inner.return?.(value)) ?? { value: undefined, done: true };
					},
				};
			}
		}

		const leaked = new TrackedStream();
		const handBack = Promise.withResolvers<AssistantMessageEventStream>();

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			if (contexts.length > 1) {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
				return stream;
			}
			// Ignores the cancellation: hands a live stream back *after* the steer
			// already won, so only the loop can close it.
			options?.signal?.addEventListener("abort", () => handBack.resolve(leaked), { once: true });
			queueMicrotask(() => queue.push("actually, do X instead"));
			return handBack.promise;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(contexts.length).toBe(2);
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
		expect(leaked.iteratorsReturned).toBe(1);
		// The producer itself is settled, not just an unstarted generator.
		expect(leaked.done).toBe(true);
	});

	it("keeps a request whose steer was already queued when it was issued, without spinning the watch", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue(true);
		// Two messages typed before the run; this host injects one per boundary, so
		// the second is still parked when the first request is issued. It is already
		// scheduled for the next boundary — cancelling this request for it would
		// only discard work the loop had just decided to do.
		queue.push("delivered with the prompt");
		queue.push("left over from the last turn");
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;
		let firstStream: AssistantMessageEventStream | undefined;
		const firstCallIssued = Promise.withResolvers<void>();

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				// Stays silent until the assertions below release it.
				firstStream = stream;
				firstCallIssued.resolve();
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer after boundary"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		const run = (async () => {
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
		})();

		// The watch is armed before the request is issued, so a spinning watcher
		// never lets this resolve.
		await firstCallIssued.promise;
		// Macrotask turns with the provider still silent. A watcher that
		// resubscribed to its already-fulfilled waiter (the host resolves it while
		// the queue is merely occupied) would starve them, or burn a peek per
		// microtask until it did.
		for (let turn = 0; turn < 5; turn++) await drainWatcherTurn();
		expect(firstRequestAborted).toBe(false);
		// Bounded by the poll cadence, not by how long the provider thinks.
		expect(queue.peeks).toBeLessThan(10);
		expect(queue.size).toBe(1);

		pushAnswer(firstStream!, "answer without the steer");
		await run;

		expect(firstRequestAborted).toBe(false);
		expect(contexts.length).toBe(2);
		expect(contexts[0]?.messages.some(m => m.role === "user" && m.content === "delivered with the prompt")).toBe(
			true,
		);
		// The leftover lands at the turn boundary, exactly as it would have anyway.
		expect(assistantTexts(events)).toEqual(["answer without the steer", "answer after boundary"]);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "left over from the last turn")).toBe(
			true,
		);
	});

	it("cancels the request for a steer that arrives while a leftover is still queued", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue(true);
		queue.push("delivered with the prompt");
		queue.push("left over from the last turn");
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;
		// Real timers: the behaviour under test IS the loop's own wall-clock poll
		// cadence (STEERING_INTERRUPT_POLL_MS), which no fake clock drives here.
		let fallback: Timer | undefined;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				// The user types a correction while the provider is still thinking and
				// the earlier message is still parked. Occupancy alone cannot tell the
				// two apart; the count can.
				queueMicrotask(() => queue.push("actually, do X instead"));
				// Deadline, not a guessed wait: a watcher that never fires must fail
				// the assertions below instead of hanging the suite.
				fallback = setTimeout(() => pushAnswer(stream, "uninterrupted answer"), 1500);
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with both"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		try {
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
		} finally {
			clearTimeout(fallback);
		}

		expect(firstRequestAborted).toBe(true);
		// The interrupt drain takes everything queued — the leftover and the
		// correction travel together on the re-issued call. Taking only the
		// first (the host's one-at-a-time pacing) would leave the correction
		// parked behind a watch baseline it can never exceed.
		expect(contexts.length).toBe(2);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "left over from the last turn")).toBe(
			true,
		);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "actually, do X instead")).toBe(true);
		expect(assistantTexts(events)).toEqual(["answer with both"]);
		expect(queue.size).toBe(0);
	});

	it("cancels within one poll cadence for a host with no steering wake-up", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;
		// Real timers for the same reason as the test above: the poll cadence is
		// the mechanism under test.
		let fallback: Timer | undefined;
		// Poll-only: the loop has to notice the arrival on a timer tick, and the
		// tick can only tell an arrival from a leftover if the watch recorded the
		// queue when it armed.
		const { waitForSteeringMessages: _unused, ...pollOnly } = queue.config;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				queueMicrotask(() => queue.push("steer before the first tick"));
				// Deadline only; the interrupt must land a cadence before it.
				fallback = setTimeout(() => pushAnswer(stream, "uninterrupted answer"), 1500);
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...pollOnly,
		};

		const events: AgentEvent[] = [];
		try {
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
		} finally {
			clearTimeout(fallback);
		}

		expect(firstRequestAborted).toBe(true);
		expect(contexts.length).toBe(2);
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "steer before the first tick")).toBe(
			true,
		);
	});
	it("caps steer re-issues so a further steer waits for the boundary", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		const aborted: boolean[] = [];

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			const call = contexts.length;
			options?.signal?.addEventListener(
				"abort",
				() => {
					aborted[call - 1] = true;
				},
				{ once: true },
			);
			if (call <= 2) {
				// Still thinking: never answers, so each steer cancels and re-issues.
				queueMicrotask(() => queue.push(call === 1 ? "first correction" : "second correction"));
			} else if (call === 3) {
				// Re-issue cap hit: this call runs without the pre-output interrupt,
				// so the arrival cannot cancel it — it answers and the steer lands
				// at the turn boundary instead.
				queueMicrotask(() => queue.push("third correction"));
				queueMicrotask(() => pushAnswer(stream, "answer after two re-issues"));
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer after boundary"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		// Exactly two cancellations: the third steer arrives on a call running
		// without the pre-output interrupt.
		expect(aborted.filter(Boolean).length).toBe(2);
		expect(contexts.length).toBe(4);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "first correction")).toBe(true);
		expect(contexts[2]?.messages.some(m => m.role === "user" && m.content === "second correction")).toBe(true);
		expect(contexts[3]?.messages.some(m => m.role === "user" && m.content === "third correction")).toBe(true);
		expect(assistantTexts(events)).toEqual(["answer after two re-issues", "answer after boundary"]);
		expect(queue.size).toBe(0);
	});

	it("stops the steering watch when setup between the response and the read loop throws", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		// Poll-only host: a leaked watch keeps its `setInterval` ticking, which
		// keeps peeking the queue — peek-count stability after the failure
		// proves the watch stopped.
		const { waitForSteeringMessages: _unused, ...pollOnly } = queue.config;

		const streamFn: StreamFn = () => {
			const stream = new AssistantMessageEventStream();
			// Fail iterator acquisition itself, before the read loop (and its
			// `finally`) exists.
			(stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = () => {
				throw new Error("iterator setup failed");
			};
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...pollOnly,
		};

		await expect(
			agentLoop([createUserMessage("start")], context, config, undefined, streamFn).result(),
		).rejects.toThrow("iterator setup failed");

		const peeksAfterThrow = queue.peeks;
		// Real sleep: the behaviour under test IS the loop's own wall-clock poll
		// interval leaking (or not) into the process, which no fake clock drives
		// here — same reason as the poll-cadence tests above. Two cadences: a
		// leaked interval would peek at least twice more.
		await Bun.sleep(600);
		expect(queue.peeks).toBe(peeksAfterThrow);
	});

	it("closes the open turn when the deadline expires on a steer re-issue", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			// Far enough out that the request is issued and the steer lands
			// first; the drain moves it into the past (the deadline signal
			// itself stays clean), so the re-issue `continue` re-enters the
			// loop against an exceeded deadline with the turn still open.
			deadline: Date.now() + 60_000,
			hasSteeringMessages: queue.config.hasSteeringMessages,
			waitForSteeringMessages: queue.config.waitForSteeringMessages,
			getSteeringMessages: async signal => {
				const batch = await queue.config.getSteeringMessages();
				if (batch.length > 0) config.deadline = Date.now() - 1;
				return batch;
			},
		};

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				queueMicrotask(() => queue.push("steer before the deadline"));
			}
			// Never answers: the re-issue `continue` re-enters the loop, where
			// the expired deadline stops the run with the turn still open.
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		// The interrupt happened (not a plain pre-first-call deadline exit)...
		expect(firstRequestAborted).toBe(true);
		expect(contexts.length).toBe(1);
		// ...the steer was folded into the turn before the deadline hit...
		expect(
			events.some(
				e =>
					e.type === "message_start" &&
					e.message.role === "user" &&
					e.message.content === "steer before the deadline",
			),
		).toBe(true);
		// ...and the open turn is closed instead of leaving `turn_start` unpaired.
		expect(events.filter(e => e.type === "turn_start").length).toBe(1);
		expect(events.filter(e => e.type === "turn_end").length).toBe(1);
		expect(events.some(e => e.type === "agent_end")).toBe(true);
	});

	it("waits for the steering baseline before issuing the provider request", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;
		let peeks = 0;
		// Slow host: the first peek reads the queue when called but answers
		// late. The snapshot-at-call models a host whose observation reflects
		// arm time while delivery takes a round trip; a steer pushed while the
		// answer is in flight is growth past that baseline, not baseline.
		const releaseBaseline = Promise.withResolvers<void>();
		const peekEntered = Promise.withResolvers<void>();
		let baselineSnapshot = 0;
		const hasSteeringMessages = (): Promise<{ queued: boolean; source: "user"; pending: number }> => {
			peeks += 1;
			if (peeks === 1) {
				baselineSnapshot = queue.size;
				peekEntered.resolve();
				return releaseBaseline.promise.then(() => ({
					queued: baselineSnapshot > 0,
					source: "user" as const,
					pending: baselineSnapshot,
				}));
			}
			return Promise.resolve(queue.config.hasSteeringMessages());
		};

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				// Still thinking: without the baseline wait this call would be
				// issued while the peek is in flight and the steer below would
				// count as baseline, hanging the run here.
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			hasSteeringMessages,
			waitForSteeringMessages: queue.config.waitForSteeringMessages,
			getSteeringMessages: queue.config.getSteeringMessages,
		};

		const events: AgentEvent[] = [];
		const run = (async (): Promise<AgentEvent[]> => {
			for await (const event of agentLoop([createUserMessage("start")], context, config, undefined, streamFn)) {
				events.push(event);
			}
			return events;
		})();
		// Await the real signal, never a tick count: a tight poll loop starves
		// the loop's own startup in Bun, while this resolves whenever the watch
		// arms. (A regression that never peeks fails on the test timeout.)
		await peekEntered.promise;
		expect(peeks).toBe(1);
		expect(contexts.length).toBe(0);
		// Pushed after the request would have been issued (unfixed code has
		// already called streamFn by now) but before the peek resolves.
		queue.push("steer during baseline");
		releaseBaseline.resolve();

		// Hang guard only: a baseline race that swallows the steer leaves the
		// thinking request parked forever. That must fail this test with a
		// diagnostic, not hang it — a real timer is the only guard a hung
		// promise allows (fake timers cannot settle an await that never
		// resolves). Kept under bun's 5s default test timeout so the guard,
		// not the runner, reports the cause.
		let hangTimer: Timer | undefined;
		const hangGuard = new Promise<never>((_resolve, reject) => {
			hangTimer = setTimeout(
				() => reject(new Error("run hung: steer during baseline never interrupted the request")),
				4000,
			);
		});
		try {
			await Promise.race([run, hangGuard]);
		} finally {
			clearTimeout(hangTimer);
		}

		expect(firstRequestAborted).toBe(true);
		expect(contexts.length).toBe(2);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "steer during baseline")).toBe(true);
		expect(queue.size).toBe(0);
		expect(assistantTexts(events)).toEqual(["answer with steer"]);
	});

	it("does not record a cancelled pre-output request as a failed chat", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const queue = createSteeringQueue();
		const mock = createMockModel();
		const contexts: Context[] = [];
		let firstRequestAborted = false;

		const streamFn: StreamFn = (_model, llmContext, options) => {
			contexts.push(llmContext);
			const stream = new AssistantMessageEventStream();
			if (contexts.length === 1) {
				// Still thinking: the steer below cancels a request that
				// streamed nothing, and the loop re-issues with it folded in.
				options?.signal?.addEventListener(
					"abort",
					() => {
						firstRequestAborted = true;
					},
					{ once: true },
				);
				queueMicrotask(() => queue.push("ordinary steer"));
			} else {
				queueMicrotask(() => pushAnswer(stream, "answer with steer"));
			}
			return stream;
		};

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			...queue.config,
		};

		const { detailed } = agentLoopDetailed([createUserMessage("start")], context, config, undefined, streamFn);
		const result = await detailed();

		expect(firstRequestAborted).toBe(true);
		expect(contexts.length).toBe(2);
		expect(contexts[1]?.messages.some(m => m.role === "user" && m.content === "ordinary steer")).toBe(true);
		// Only the re-issued call owns a chat: the cancelled request leaves no
		// failed chat, no error stop reason, and no error entry.
		expect(result.telemetry?.chats.total).toBe(1);
		expect(result.telemetry?.chats.byStopReason).toEqual({ stop: 1 });
		expect(result.telemetry?.errors.total).toBe(0);
		expect(result.telemetry?.errors.byType).toEqual({});
		expect(
			result.messages.flatMap(message =>
				message.role === "assistant"
					? [
							message.content
								.filter(
									(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
										block.type === "text",
								)
								.map(block => block.text)
								.join(""),
						]
					: [],
			),
		).toEqual(["answer with steer"]);
	});

	it("preserves completed results and later tools when a steering callback throws", async () => {
		const toolSchema = type({ value: "string", exclusive: "boolean" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: args => (args.exclusive ? "exclusive" : "shared"),
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "first-exclusive", exclusive: true },
						},
						{
							type: "toolCall",
							id: "tool-2",
							name: "echo",
							arguments: { value: "shared-sibling", exclusive: false },
						},
						{
							type: "toolCall",
							id: "tool-3",
							name: "echo",
							arguments: { value: "next-exclusive", exclusive: true },
						},
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			// A transient host-callback failure after the first tool ran must not
			// reject the trailing checkSteering and poison the ordering chain.
			hasSteeringMessages: () => {
				if (executed.length >= 1) throw new Error("transient steering-callback failure");
				return { queued: false };
			},
			getSteeringMessages: async () => [],
		};

		const results: ToolResultMessage[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				results.push(event.message);
			}
		}

		expect(executed).toEqual(["first-exclusive", "shared-sibling", "next-exclusive"]);
		expect(
			results.map(result => {
				const block = result.content?.[0];
				return block?.type === "text" ? block.text : "";
			}),
		).toEqual(["echoed: first-exclusive", "echoed: shared-sibling", "echoed: next-exclusive"]);
	});
});

describe("agentLoop pre-model-call gate", () => {
	const echoToolSchema = type({ value: "string" });

	function echoTool(executed: string[]): AgentTool<typeof echoToolSchema> {
		const toolSchema = echoToolSchema;
		return {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
			},
		};
	}

	it("gates the provider-bound context before opening the initial turn", async () => {
		const context: AgentContext = { systemPrompt: ["stale"], messages: [], tools: [] };
		const queued = createUserMessage("queued");
		const providerMessage = createUserMessage("provider") as Message;
		const mock = createMockModel({ responses: [{ content: ["should not be reached"] }] });
		let pending = true;
		let gatedContext: Context | undefined;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				if (!pending) return [];
				pending = false;
				return [queued];
			},
			syncContextBeforeModelCall: current => {
				current.systemPrompt = ["fresh"];
			},
			transformProviderContext: providerContext => ({
				...providerContext,
				systemPrompt: [...(providerContext.systemPrompt ?? []), "provider"],
				messages: [...providerContext.messages, providerMessage],
			}),
			beforeModelCall: current => {
				gatedContext = current;
				return { stop: true, reason: "over budget" };
			},
		};

		const prompts = [createUserMessage("start")];
		const events: AgentEvent[] = [];
		const stream = agentLoop(prompts, context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(gatedContext?.systemPrompt).toEqual(["fresh", "provider"]);
		expect(gatedContext?.messages.at(-1)).toEqual(providerMessage);
		expect(prompts).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end")).toHaveLength(2);
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(0);
	});

	it("balances the synthetic error turn when the gate throws", async () => {
		const mock = createMockModel({ responses: [{ content: ["should not be reached"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		agent.setBeforeModelCall(() => {
			throw new Error("gate failed");
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("start");
		unsubscribe();

		expect(agent.state.messages.some(message => message.role === "user")).toBe(true);
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		const turnStartIndex = events.findIndex(event => event.type === "turn_start");
		const userStartIndex = events.findIndex(event => event.type === "message_start" && event.message.role === "user");
		expect(turnStartIndex).toBeLessThan(userStartIndex);
	});

	it("stops before the provider call and closes the open turn", async () => {
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } }] },
				// A second provider call would consume this; the gate must prevent it.
				{ content: ["should not be reached"] },
			],
		});

		let calls = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// Allow the first request, refuse the one that would follow the tool call.
			beforeModelCall: () => (++calls > 1 ? ({ stop: true, reason: "over budget" } as const) : undefined),
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The tool ran, then the gate stopped the follow-up request.
		expect(executed).toEqual(["first"]);
		expect(calls).toBe(2);
		expect(events.some(e => e.type === "agent_end")).toBe(true);

		// Every started turn is closed, so consumers pairing the events are not
		// left mid-turn by the stop.
		const starts = events.filter(e => e.type === "turn_start").length;
		const ends = events.filter(e => e.type === "turn_end").length;
		expect(ends).toBe(starts);
	});

	it("returns a hard tool choice when the gate stops before serving it", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let toolChoiceCalls = 0;
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () => {
				toolChoiceCalls++;
				return "none";
			},
		});
		agent.setBeforeModelCall(() => (++gateCalls === 1 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("stop");
		await agent.prompt("continue");

		expect(toolChoiceCalls).toBe(1);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options?.toolChoice).toBe("none");
	});

	it("discards a deferred tool choice when its tool is no longer active", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let toolChoiceCalls = 0;
		let gateCalls = 0;
		let unavailableToolChoices = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () => {
				toolChoiceCalls++;
				return toolChoiceCalls === 1 ? { type: "tool", name: "echo" } : "none";
			},
			onToolChoiceUnavailable: () => {
				unavailableToolChoices++;
			},
		});
		agent.setTools([echoTool([])]);
		agent.setBeforeModelCall(() => (++gateCalls === 1 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("stop");
		agent.setTools([]);
		await agent.prompt("continue");

		expect(toolChoiceCalls).toBe(2);
		expect(unavailableToolChoices).toBe(1);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options?.toolChoice).toBe("none");
	});

	it("clears a deferred tool choice when the agent resets", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let toolChoiceCalls = 0;
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () => {
				toolChoiceCalls++;
				return toolChoiceCalls === 1 ? "none" : "auto";
			},
		});
		agent.setBeforeModelCall(() => (++gateCalls === 1 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("stop");
		agent.reset();
		await agent.prompt("continue");

		expect(toolChoiceCalls).toBe(2);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options?.toolChoice).toBe("auto");
	});

	it("clears a deferred tool choice with all queued session state", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let toolChoiceCalls = 0;
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () => {
				toolChoiceCalls++;
				return toolChoiceCalls === 1 ? "none" : "auto";
			},
		});
		agent.setBeforeModelCall(() => (++gateCalls === 1 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("stop");
		agent.clearAllQueues();
		await agent.prompt("new session");

		expect(toolChoiceCalls).toBe(2);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options?.toolChoice).toBe("auto");
	});

	it("leaves tool-choice rejection to a concurrent abort", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["should not be reached"] }] });
		const gateEntered = Promise.withResolvers<void>();
		const gateAborted = Promise.withResolvers<void>();
		const controller = new AbortController();
		let rejectedToolChoices = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => "none",
			onToolChoiceRejected: () => {
				rejectedToolChoices++;
			},
			beforeModelCall: async (_context, signal) => {
				if (!signal) throw new Error("missing gate abort signal");
				gateEntered.resolve();
				const waiter = Promise.withResolvers<void>();
				signal.addEventListener(
					"abort",
					() => {
						gateAborted.resolve();
						waiter.resolve();
					},
					{ once: true },
				);
				await waiter.promise;
				return { stop: true, reason: "over budget" };
			},
		};

		const stream = agentLoop([createUserMessage("start")], context, config, controller.signal, mock.stream);
		const drain = (async () => {
			for await (const _event of stream) {
				// drain
			}
		})();
		await gateEntered.promise;
		controller.abort();
		await drain;

		await gateAborted.promise;
		expect(rejectedToolChoices).toBe(0);
		expect(mock.calls).toHaveLength(0);
	});

	it("passes the run abort signal to agent pre-model hooks", async () => {
		const mock = createMockModel({ responses: [{ content: ["should not be reached"] }] });
		const gateEntered = Promise.withResolvers<void>();
		const gateAborted = Promise.withResolvers<void>();
		const agent = new Agent({ streamFn: mock.stream });
		agent.setBeforeModelCall(async (_context, signal) => {
			gateEntered.resolve();
			if (!signal) throw new Error("missing gate abort signal");
			const waiter = Promise.withResolvers<void>();
			signal.addEventListener(
				"abort",
				() => {
					gateAborted.resolve();
					waiter.resolve();
				},
				{ once: true },
			);
			// No return: a pure-observer gate may resolve void and still proceed.
			await waiter.promise;
		});

		const prompt = agent.prompt("start");
		await gateEntered.promise;
		agent.abort();
		await prompt;
		await gateAborted.promise;

		expect(mock.calls).toHaveLength(0);
	});

	it("opens an error turn before accepted inputs when a tool-choice rejection hook throws", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["should not be reached"] }] });
		const softState: NonNullable<AgentLoopConfig["softToolRequirementState"]> = { escalations: 0 };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => ({
				soft: true,
				id: "preview-1",
				toolName: "resolve",
				reminder: [createUserMessage("resolve")],
			}),
			softToolRequirementState: softState,
			onToolChoiceRejected: () => {
				throw new Error("rejection failed");
			},
			beforeModelCall: () => ({ stop: true, reason: "over budget" }),
		};
		const events: AgentEvent[] = [];
		let failure: unknown;

		try {
			const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
			for await (const event of stream) events.push(event);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("rejection failed");
		expect(events.some(event => event.type === "message_end" && event.message.role === "user")).toBe(true);
		const turnStartIndex = events.findIndex(event => event.type === "turn_start");
		const userStartIndex = events.findIndex(event => event.type === "message_start" && event.message.role === "user");
		expect(turnStartIndex).toBeLessThan(userStartIndex);
		expect(softState.id).toBeUndefined();
		expect(softState.forcedToolChoice).toBeUndefined();
		expect(softState.escalations).toBe(0);
		expect(mock.calls).toHaveLength(0);
	});

	it("does not return a hard tool choice already served before a later gate stop", async () => {
		const executed: string[] = [];
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } }] },
				{ content: ["done"] },
			],
		});
		let toolChoiceCalls = 0;
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () => {
				toolChoiceCalls++;
				return toolChoiceCalls === 1 ? { type: "tool", name: "echo" } : undefined;
			},
		});
		agent.setTools([echoTool(executed)]);
		agent.setBeforeModelCall(() => (++gateCalls === 2 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("run");
		await agent.prompt("continue");

		expect(executed).toEqual(["first"]);
		expect(toolChoiceCalls).toBe(3);
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "echo" });
		expect(mock.calls[1]?.options?.toolChoice).toBeUndefined();
	});
	it("gates a soft reminder once in the final provider context", async () => {
		const reminder = createUserMessage("resolve the pending preview");
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["done"], stopReason: "aborted" }] });
		let gatedContext: Context | undefined;
		let gateCalls = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => ({
				soft: true,
				id: "preview-1",
				toolName: "resolve",
				reminder: [reminder],
			}),
			beforeModelCall: providerContext => {
				gateCalls++;
				gatedContext = providerContext;
				return undefined;
			},
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(gateCalls).toBe(1);
		expect(gatedContext?.messages).toContain(reminder);
		expect(mock.calls).toHaveLength(1);
	});

	it("retains a soft reminder escalation when a gate stops the forced call", async () => {
		const reminder = createUserMessage("resolve the pending preview");
		const executed: string[] = [];
		let pending = true;
		const tool = echoTool(executed);
		const execute = tool.execute.bind(tool);
		tool.execute = async (...args) => {
			pending = false;
			return execute(...args);
		};
		const mock = createMockModel({
			responses: [
				{ content: ["not yet"] },
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "resolved" } }] },
				{ content: ["done"] },
			],
		});
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () =>
				pending
					? {
							soft: true,
							id: "preview-1",
							toolName: "echo",
							reminder: [reminder],
						}
					: undefined,
		});
		agent.setTools([tool]);
		agent.setBeforeModelCall(() => (++gateCalls === 2 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("start");
		await agent.prompt("continue");

		expect(mock.calls).toHaveLength(3);
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "echo" });
		expect(executed).toEqual(["resolved"]);
		expect(agent.state.messages.filter(message => message === reminder)).toHaveLength(1);
	});

	it("clears retained soft-requirement state with all queued session state", async () => {
		const reminder = createUserMessage("resolve the pending preview");
		const executed: string[] = [];
		let pending = true;
		const tool = echoTool(executed);
		const execute = tool.execute.bind(tool);
		tool.execute = async (...args) => {
			pending = false;
			return execute(...args);
		};
		const mock = createMockModel({
			responses: [
				{ content: ["not yet"] },
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "resolved" } }] },
				{ content: ["done"] },
			],
		});
		let gateCalls = 0;
		const agent = new Agent({
			streamFn: mock.stream,
			getToolChoice: () =>
				pending
					? {
							soft: true,
							id: "preview-1",
							toolName: "echo",
							reminder: [reminder],
						}
					: undefined,
		});
		agent.setTools([tool]);
		agent.setBeforeModelCall(() => (++gateCalls === 2 ? { stop: true, reason: "over budget" } : undefined));

		await agent.prompt("start");
		agent.clearAllQueues();
		await agent.prompt("continue");

		// The cleared lifecycle treats the still-pending requirement as new: the
		// reminder is re-injected and the discarded run's earned escalation is
		// not applied to the next request.
		expect(mock.calls).toHaveLength(3);
		expect(mock.calls[1]?.options?.toolChoice).toBeUndefined();
		expect(executed).toEqual(["resolved"]);
		expect(agent.state.messages.filter(message => message === reminder)).toHaveLength(2);
	});

	it("closes an open Harmony retry turn when the gate stops the retry", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: ["Some prose. analysis to=functions.edit code"] }],
		});
		const retryModel = { ...harmonyMitigationModel, id: "retry-model" };
		let gateCalls = 0;
		let turnEndCalls = 0;
		let rejectedToolChoices = 0;
		const config: AgentLoopConfig = {
			model: harmonyMitigationModel,
			getModel: () => (gateCalls === 0 ? harmonyMitigationModel : retryModel),
			convertToLlm: identityConverter,
			beforeModelCall: () => (++gateCalls > 1 ? { stop: true, reason: "over budget" } : undefined),
			onTurnEnd: () => {
				turnEndCalls++;
			},
			onToolChoiceRejected: () => {
				rejectedToolChoices++;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(mock.calls).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		expect(turnEndCalls).toBe(1);
		expect(rejectedToolChoices).toBe(0);
		const final = messages.at(-1);
		expect(final?.role).toBe("assistant");
		if (final?.role !== "assistant") throw new Error("expected stopped assistant message");
		expect(final.stopReason).toBe("aborted");
		expect(final.errorMessage).toBe("over budget");
		expect(final.model).toBe(retryModel.id);
	});

	it("closes an open Harmony retry turn when abort lands inside the retry gate", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: ["Some prose. analysis to=functions.edit code"] }],
		});
		const gateEntered = Promise.withResolvers<void>();
		const controller = new AbortController();
		let gateCalls = 0;
		const config: AgentLoopConfig = {
			model: harmonyMitigationModel,
			convertToLlm: identityConverter,
			beforeModelCall: async (_context, signal) => {
				if (++gateCalls === 1) return undefined;
				if (!signal) throw new Error("missing gate abort signal");
				gateEntered.resolve();
				const waiter = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => waiter.resolve(), { once: true });
				await waiter.promise;
				return undefined;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, controller.signal, mock.stream);
		const drain = (async () => {
			for await (const event of stream) events.push(event);
		})();
		await gateEntered.promise;
		controller.abort();
		await drain;

		expect(mock.calls).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
	});

	it("proceeds when the gate returns undefined", async () => {
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "only" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeModelCall: () => undefined,
		};

		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(executed).toEqual(["only"]);
	});
});

describe("agentLoop useless-flag propagation", () => {
	async function runProbe(toolReturn: unknown): Promise<ToolResultMessage> {
		const toolSchema = type({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute() {
				return toolReturn as never;
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "probe", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, mock.stream)) {
			events.push(event);
		}
		const message = events
			.filter(e => e.type === "message_end")
			.map(e => (e as { message: AgentMessage }).message)
			.find(m => m.role === "toolResult");
		expect(message).toBeDefined();
		return message as ToolResultMessage;
	}

	it("copies a tool-declared useless flag onto the emitted tool result message", async () => {
		const message = await runProbe({
			content: [{ type: "text", text: "No matches found" }],
			details: {},
			useless: true,
		});
		expect(message.useless).toBe(true);
		expect(message.isError).toBe(false);
	});

	it("drops the useless flag when the tool also reports an error", async () => {
		const message = await runProbe({
			content: [{ type: "text", text: "failed but flagged" }],
			details: {},
			isError: true,
			useless: true,
		});
		expect(message.isError).toBe(true);
		expect(message.useless).toBeUndefined();
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [userMessage],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter(e => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		const firstEnd = messageEndEvents[0];
		if (firstEnd?.type !== "message_end") throw new Error("Expected message_end");
		expect(firstEnd.message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface HookMessage {
			role: "hookMessage";
			text: string;
			timestamp: number;
		}

		const hookMessage: HookMessage = {
			role: "hookMessage",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [hookMessage as unknown as AgentMessage],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Response to hook"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				// Convert hookMessage to user message
				return messages
					.map(m => {
						const candidate = m as unknown as Partial<HookMessage>;
						if (candidate.role === "hookMessage") {
							return {
								role: "user" as const,
								content: candidate.text ?? "",
								timestamp: candidate.timestamp ?? Date.now(),
							};
						}
						return m;
					})
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		// Should not throw - the hookMessage will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, mock.stream);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});

	it("blocks tool execution when beforeToolCall returns block", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ block: true, reason: "policy: blocked" }),
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual([]);
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(JSON.stringify(toolEnd.result)).toContain("policy: blocked");
		}
	});

	it("passes beforeToolCall args mutations into tool.execute without revalidation", async () => {
		const toolSchema = type({ value: "string" });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				(args as { value: string | number }).value = 123;
				return undefined;
			},
		};

		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(executed).toEqual([123]);
	});
	it("applies beforeToolCall args replacement to execution, events, and the assistant message", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "original" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ args: { value: "revised" } }),
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The revision is the single source of truth: execute, the start event,
		// and the persisted assistant message tool call all carry it.
		expect(executed).toEqual(["revised"]);
		const toolStart = events.find(e => e.type === "tool_execution_start");
		expect(toolStart?.type === "tool_execution_start" && toolStart.args).toEqual({ value: "revised" });
		const messages = await stream.result();
		const assistant = messages.find(m => m.role === "assistant");
		const toolCallBlock =
			assistant?.role === "assistant" ? assistant.content.find(c => c.type === "toolCall") : undefined;
		expect(toolCallBlock?.type === "toolCall" && toolCallBlock.arguments).toEqual({ value: "revised" });
	});

	it("resolves functional concurrency from beforeToolCall-revised args", async () => {
		const toolSchema = type({ value: "string" });
		const concurrencySeen: unknown[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: args => {
				concurrencySeen.push({ ...(args as Record<string, unknown>) });
				return (args as { value: string }).value === "exclusive" ? "exclusive" : "shared";
			},
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "shared" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ args: { value: "exclusive" } }),
		};

		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// Scheduling resolves concurrency AFTER the hook revision, so an
		// argument-dependent policy (e.g. bash pty => exclusive) sees the
		// arguments the tool actually runs with.
		expect(concurrencySeen).toEqual([{ value: "exclusive" }]);
	});

	it("rejects a beforeToolCall args replacement that fails schema validation", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ args: { bogus: 42 } }),
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual([]);
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd?.type === "tool_execution_end" && toolEnd.isError).toBe(true);
	});

	it("afterToolCall overrides content and isError on the emitted tool result", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `original: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const seen: Array<{ args: unknown; isError: boolean }> = [];
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async ({ args, isError }) => {
				seen.push({ args, isError });
				return {
					content: [{ type: "text", text: "rewritten" }],
					isError: true,
				};
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(seen).toEqual([{ args: { value: "hello" }, isError: false }]);

		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(toolEnd.result.content).toEqual([{ type: "text", text: "rewritten" }]);
			// details preserved when override omits the field
			expect(toolEnd.result.details).toEqual({ value: "hello" });
		}

		const toolResultMessage = events
			.filter(e => e.type === "message_start")
			.map(e => (e.type === "message_start" ? e.message : undefined))
			.find((m): m is AgentMessage => m !== undefined && m.role === "toolResult");
		expect(toolResultMessage).toBeDefined();
		if (toolResultMessage && toolResultMessage.role === "toolResult") {
			expect(toolResultMessage.isError).toBe(true);
			expect(toolResultMessage.content).toEqual([{ type: "text", text: "rewritten" }]);
		}
	});

	it("fails closed when afterToolCall returns malformed computer provider metadata", async () => {
		const toolSchema = type({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute() {
				return { content: [], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-metadata", name: "probe", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async () =>
				({
					providerMetadata: {
						type: "computer",
						screenshot: {
							type: "computer_screenshot",
							image_url: "data:image/png;base64,AAEC",
							file_id: "file_conflicting_ref",
						},
						acknowledgedSafetyChecks: [{ id: 42 }],
					},
				}) as never,
		};
		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, mock.stream)) {
			events.push(event);
		}
		const result = events
			.filter(event => event.type === "message_end" && event.message.role === "toolResult")
			.map(event =>
				event.type === "message_end" && event.message.role === "toolResult" ? event.message : undefined,
			)[0];
		expect(result?.isError).toBe(true);
		expect(result?.providerMetadata).toBeUndefined();
		expect(JSON.stringify(result?.content)).toContain("computer providerMetadata had an unsupported shape");
	});

	it("runs afterToolCall for a completed result even when the run aborts before the hook", async () => {
		const toolSchema = type({ value: "string" });
		const controller = new AbortController();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				controller.abort("stop after tool");
				return {
					content: [{ type: "text", text: `original: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		let hookSawAbortedSignal = false;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async (_context, signal) => {
				hookSawAbortedSignal = signal?.aborted === true;
				return { content: [{ type: "text", text: "rewritten after abort" }] };
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo")], context, config, controller.signal, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(hookSawAbortedSignal).toBe(true);
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
			expect(toolEnd.result.content).toEqual([{ type: "text", text: "rewritten after abort" }]);
		}
	});

	it("stops after a post-tool hook marks the completed result terminal", async () => {
		const toolSchema = type({ value: "string" });
		const controller = new AbortController();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-terminal", name: "echo", arguments: { value: "done" } }] },
				{ content: ["must not be reached"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async () => {
				controller.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo")], context, config, controller.signal, mock.stream);
		for await (const event of stream) events.push(event);

		expect(mock.calls).toHaveLength(1);
		expect(events.some(event => event.type === "tool_execution_end")).toBe(true);
		expect(
			events.some(
				event =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "aborted",
			),
		).toBe(false);
	});

	it("runs onTurnEnd for a terminal-yield turn without a spent abort signal", async () => {
		const toolSchema = type({ value: "string" });
		const controller = new AbortController();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "yield",
			label: "Yield",
			description: "Yield tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { value: "final answer" } }] },
				{ content: ["must not be reached"] },
			],
		});
		const turnEndCalls: Array<{ willContinue: boolean | undefined; signalAborted: boolean }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async () => {
				controller.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			},
			onTurnEnd: (_messages, signal, ctx) => {
				turnEndCalls.push({ willContinue: ctx?.willContinue, signalAborted: signal?.aborted === true });
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, mock.stream);
		for await (const event of stream) events.push(event);

		// The terminal-yield abort must not suppress per-turn bookkeeping: the
		// hook runs once for the yield turn, marked complete (willContinue:false)
		// and with no aborted signal so downstream waits behave like a plain turn.
		expect(mock.calls).toHaveLength(1);
		expect(turnEndCalls).toEqual([{ willContinue: false, signalAborted: false }]);
	});

	it("preserves an external abort boundary when a completed tool ignores cancellation", async () => {
		const toolSchema = type({ value: "string" });
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				started.resolve();
				await release.promise;
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-abort", name: "echo", arguments: { value: "done" } }] },
				{ content: ["must not be observed"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo")], context, config, controller.signal, mock.stream);
		const consuming = (async () => {
			for await (const event of stream) events.push(event);
		})();
		await started.promise;
		controller.abort("Stopped by user");
		release.resolve();
		await consuming;

		expect(mock.calls).toHaveLength(2);
		const aborted = events.find(
			event =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted",
		);
		expect(aborted).toBeDefined();
		if (aborted?.type !== "message_end" || aborted.message.role !== "assistant") {
			throw new Error("Expected an aborted assistant message");
		}
		expect(aborted.message.errorMessage).toBe("Stopped by user");
	});

	it("surfaces afterToolCall errors as a tool error result", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `ok: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async () => {
				throw new Error("hook exploded");
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(JSON.stringify(toolEnd.result)).toContain("hook exploded");
		}
	});
	it("runs onBeforeYield before polling follow-up messages", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const queuedFollowUps: AgentMessage[] = [];
		let hookCalls = 0;
		const mock = createMockModel({
			responses: [{ content: ["first"] }, { content: ["second"] }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onBeforeYield: () => {
				hookCalls++;
				if (hookCalls === 1) {
					queuedFollowUps.push(createUserMessage("follow-up"));
				}
			},
			getFollowUpMessages: async () => queuedFollowUps.splice(0),
		};

		const stream = agentLoop([createUserMessage("initial")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		const messages = await stream.result();
		expect(hookCalls).toBe(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages[2]).toMatchObject({ role: "user", content: "follow-up" });
	});

	it("skips tool calls when the assistant turn was truncated by max_tokens (stop_reason: length) and tells the model to chunk", async () => {
		// Regression for issue #1785 (`write` tool crash on >1020-line content).
		// When a model emits a `write` call whose `content` argument exceeds the
		// model's `max_tokens` output cap, the provider cuts the stream off mid-
		// arguments and reports `stop_reason: length`. The agent must NOT execute
		// the truncated call (its `content` is a partial string), AND the synthetic
		// tool result must guide the model towards a chunked retry — otherwise the
		// auto-continue loop re-emits the same oversized payload and the file never
		// gets written ("write tool crash" from the reporter's POV).
		const writeSchema = type({ path: "string", content: "string" });
		const executed: { path: string; content: string }[] = [];
		const writeTool: AgentTool<typeof writeSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: writeSchema,
			async execute(_id, params) {
				executed.push({ path: params.path, content: params.content });
				return { content: [{ type: "text", text: "ok" }], details: { path: params.path } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [writeTool] };

		// The model emits one write tool call, then the stream ends with
		// stop_reason: "length". The arguments field carries a truncated content
		// payload — exactly what the streaming JSON parser produces when the
		// closing quote/brace never arrive.
		const truncatedContent = "line 1\nline 2\n... (cut off mid-string"; // no closing quote
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-write-1",
							name: "write",
							arguments: { path: "/tmp/huge.ts", content: truncatedContent },
						},
					],
					stopReason: "length",
				},
				{
					content: ["ok, I will split the write into smaller chunks"],
				},
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("write huge file")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const messages = await stream.result();

		// The tool MUST NOT have been executed — the arguments are mid-string and
		// running them would persist a half-written file.
		expect(executed).toEqual([]);

		// The synthetic tool result must surface the truncation cause so the model
		// can recover by chunking instead of re-emitting the same payload.
		const toolResult = messages.find(m => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult?.role !== "toolResult") throw new Error("expected tool result");
		expect(toolResult.toolCallId).toBe("tc-write-1");
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("stop_reason: length");
		expect(text).toMatch(/split|chunk/i);
	});
	it("fills whitespace-only error tool results so Anthropic does not 400", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "\n\n\n\n\n" }],
					isError: true,
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(toolEnd.result.content).toEqual([{ type: "text", text: "Tool failed with no output." }]);
		}
	});

	it("aborts pending tool calls instead of running them when the deadline is crossed during the request", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const mock = createMockModel();
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			deadline: Date.now() + 10_000,
		};

		// The provider returns a runnable tool call, but the wall clock crosses the
		// deadline while the request is in flight (simulated by moving the deadline
		// into the past mid-call). The loop must NOT execute the tool — it pairs each
		// call with an aborted placeholder so the tool_use/tool_result contract stays
		// valid for any later replay.
		const toolCall = { type: "toolCall" as const, id: "tc-late-1", name: "some-tool", arguments: {} };
		const streamFn = () => {
			config.deadline = Date.now() - 1;
			const stream = new AssistantMessageEventStream();
			const partial = createAssistantMessage([toolCall], "toolUse");
			stream.push({ type: "start", partial });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
			stream.push({ type: "done", reason: "toolUse", message: partial });
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Run helper")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		const toolResult = messages[2] as ToolResultMessage;
		expect(toolResult.toolCallId).toBe("tc-late-1");
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("Deadline exceeded");
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("does not dequeue follow-up messages when the deadline is crossed during onBeforeYield", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ content: ["Hi"] }] });
		const queuedFollowUps = [createUserMessage("follow-up")];
		let followUpPolls = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			deadline: Date.now() + 10_000,
			onBeforeYield: () => {
				// The wall clock crosses the deadline while this hook runs.
				config.deadline = Date.now() - 1;
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return queuedFollowUps.splice(0);
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// The post-onBeforeYield deadline guard must exit before the queue drain, so
		// the follow-up is never dequeued (and therefore never silently dropped).
		expect(followUpPolls).toBe(0);
		expect(queuedFollowUps).toHaveLength(1);
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("aborts the in-flight provider request when the deadline timer fires", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
			deadline: Date.now() + 50,
		};

		// A stalled provider that never emits; it only observes the abort signal the
		// loop hands it. The merged deadline signal must fire and cancel the request,
		// surfacing the deadline reason on the synthesized aborted message.
		let providerSignalAborted = false;
		let providerSignalReason: unknown;
		const stream = agentLoop([createUserMessage("Wait")], context, config, undefined, (_model, _context, options) => {
			options?.signal?.addEventListener("abort", () => {
				providerSignalAborted = true;
				providerSignalReason = options.signal?.reason;
			});
			return new AssistantMessageEventStream();
		});

		const messages = await stream.result();

		expect(providerSignalAborted).toBe(true);
		if (!(providerSignalReason instanceof DOMException)) throw new Error("Expected a DOMException deadline reason");
		expect(providerSignalReason.name).toBe("TimeoutError");
		expect(providerSignalReason.message).toBe("Deadline exceeded");
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("Deadline exceeded");
	});
});

describe("agentLoop streaming snapshots", () => {
	it("deep-clones tool-call arguments into message_update snapshots, copying only own enumerable properties", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		// Arguments carry a nested object, a nested array, primitives, and an
		// INHERITED enumerable property. The snapshot must deep-clone the own
		// nested structures (fresh references), pass primitives through by value,
		// and carry only OWN enumerable data — the inherited key must never leak
		// into the immutable view subscribers receive.
		const inheritedProto = { inheritedKey: "from-prototype" };
		const innerArray = [2, 3];
		const base: Record<string, unknown> = Object.create(inheritedProto);
		const sourceArgs: Record<string, unknown> = Object.assign(base, {
			nestedObj: { a: 1, b: "two" },
			nestedArr: [1, innerArray, { c: 4 }],
			num: 42,
			str: "hi",
			flag: true,
			nul: null,
		});
		const toolCall = { type: "toolCall" as const, id: "tc-clone", name: "noop", arguments: sourceArgs };

		// Turn 0 streams the tool call; the unknown tool produces an error result
		// and the loop calls the model again — turn 1 returns plain text so the
		// loop terminates instead of spinning forever.
		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			if (turn++ === 0) {
				const partial = createAssistantMessage([toolCall], "toolUse");
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
				stream.push({ type: "done", reason: "toolUse", message: partial });
			} else {
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			}
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("call noop")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolUpdate = events.find(
			(e): e is Extract<AgentEvent, { type: "message_update" }> =>
				e.type === "message_update" &&
				e.message.role === "assistant" &&
				e.message.content.some(c => c.type === "toolCall"),
		);
		expect(toolUpdate).toBeDefined();
		if (toolUpdate?.message.role !== "assistant") throw new Error("missing tool-call update");
		const block = toolUpdate.message.content.find(c => c.type === "toolCall");
		if (block?.type !== "toolCall") throw new Error("missing tool-call block");
		const cloned: Record<string, unknown> = block.arguments;

		// Fresh top-level object, not the source reference.
		expect(cloned).not.toBe(sourceArgs);
		// Own enumerable keys only — the inherited property must not appear.
		expect("inheritedKey" in cloned).toBe(false);
		expect(Object.hasOwn(cloned, "inheritedKey")).toBe(false);
		// Nested object: deep-cloned (equal value, distinct reference).
		expect(cloned.nestedObj).toEqual({ a: 1, b: "two" });
		expect(cloned.nestedObj).not.toBe(sourceArgs.nestedObj);
		// Nested array: deep-cloned recursively (distinct references at every level).
		expect(Array.isArray(cloned.nestedArr)).toBe(true);
		expect(cloned.nestedArr).toEqual([1, [2, 3], { c: 4 }]);
		expect(cloned.nestedArr).not.toBe(sourceArgs.nestedArr);
		expect((cloned.nestedArr as unknown[])[1]).not.toBe(innerArray);
		// Primitives pass through by value.
		expect(cloned.num).toBe(42);
		expect(cloned.str).toBe("hi");
		expect(cloned.flag).toBe(true);
		expect(cloned.nul).toBeNull();
	});

	it("shares one immutable snapshot between message and assistantMessageEvent.partial on message_update", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		const livePartial = createAssistantMessage([{ type: "text", text: "Hi" }], "stop");
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: livePartial });
			stream.push({ type: "text_start", contentIndex: 0, partial: livePartial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Hi", partial: livePartial });
			stream.push({ type: "text_end", contentIndex: 0, content: "Hi", partial: livePartial });
			stream.push({ type: "done", reason: "stop", message: livePartial });
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("say hi")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const update = events.find(
			(e): e is Extract<AgentEvent, { type: "message_update" }> => e.type === "message_update",
		);
		expect(update).toBeDefined();
		if (!update) throw new Error("missing message_update");
		const ame = update.assistantMessageEvent;
		expect("partial" in ame).toBe(true);
		if (!("partial" in ame)) throw new Error("expected a partial-bearing assistant event");
		// Alias contract: `message` and `assistantMessageEvent.partial` are ONE
		// shared snapshot...
		expect(update.message).toBe(ame.partial);
		// ...and that snapshot is an independent deep clone of the live streaming
		// partial, never the mutable partial object itself.
		expect(update.message).not.toBe(livePartial);
	});

	it("rebuilds snapshots incrementally across interleaved finalized and streaming blocks", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		// Interleaved block lifecycle: block 0 finalizes first; block 2 starts
		// and ends while block 1 is still streaming. Events are pushed one
		// microtask at a time, mutating the live partial immediately before each
		// push (the mutate-then-push stream contract), so the consumer observes
		// each event with only the deltas delivered so far applied.
		const partial = createAssistantMessage([], "stop");
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial });
			const steps: (() => void)[] = [
				() => {
					partial.content.push({ type: "text", text: "A" });
					stream.push({ type: "text_start", contentIndex: 0, partial });
				},
				() => stream.push({ type: "text_delta", contentIndex: 0, delta: "A", partial }),
				() => stream.push({ type: "text_end", contentIndex: 0, content: "A", partial }),
				() => {
					partial.content.push({ type: "text", text: "B" });
					stream.push({ type: "text_start", contentIndex: 1, partial });
				},
				() => stream.push({ type: "text_delta", contentIndex: 1, delta: "B", partial }),
				() => {
					partial.content.push({ type: "text", text: "C" });
					stream.push({ type: "text_start", contentIndex: 2, partial });
				},
				() => stream.push({ type: "text_delta", contentIndex: 2, delta: "C", partial }),
				() => {
					(partial.content[1] as { type: "text"; text: string }).text = "B2";
					stream.push({ type: "text_delta", contentIndex: 1, delta: "2", partial });
				},
				() => stream.push({ type: "text_end", contentIndex: 2, content: "C", partial }),
				() => stream.push({ type: "text_end", contentIndex: 1, content: "B2", partial }),
				() => stream.push({ type: "done", reason: "stop", message: partial }),
			];
			let step = 0;
			const runNext = (): void => {
				if (step < steps.length) {
					steps[step++]!();
					setTimeout(runNext, 0);
				}
			};
			setTimeout(runNext, 0);
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("stream")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		type MessageUpdate = Extract<AgentEvent, { type: "message_update" }>;
		const updates = events.filter((e): e is MessageUpdate => e.type === "message_update");
		const contentOf = (update: MessageUpdate): AssistantMessage["content"] => {
			if (update.message.role !== "assistant") throw new Error("expected assistant message_update");
			return update.message.content;
		};
		const textOf = (update: MessageUpdate, index: number): string => {
			const block = contentOf(update)[index];
			if (block?.type !== "text") throw new Error(`expected text block at content[${index}]`);
			return block.text;
		};

		// One update per streamed event (start/done do not emit updates).
		expect(updates.length).toBe(10);

		// Appended-block loop: block 1 appears once it starts (updates 3-4), and
		// block 2 only once IT starts (update 5 onward) — later blocks never
		// leak into earlier snapshots.
		expect(updates.slice(0, 3).every(u => contentOf(u).length === 1)).toBe(true);
		expect(updates.slice(3, 5).every(u => contentOf(u).length === 2)).toBe(true);
		expect(updates.slice(5).every(u => contentOf(u).length === 3)).toBe(true);
		// ...and the final snapshot carries every block with its accumulated text.
		const last = updates.at(-1)!;
		expect(textOf(last, 0)).toBe("A");
		expect(textOf(last, 1)).toBe("B2");
		expect(textOf(last, 2)).toBe("C");

		// Finalized blocks are shared by reference: from the first update after
		// block 0's end event, every snapshot carries the SAME content[0] object.
		expect(new Set(updates.slice(3).map(u => contentOf(u)[0])).size).toBe(1);
		// Block 2 finalizes at update 8; the final update shares its clone.
		expect(contentOf(updates[8]!)[2]).toBe(contentOf(updates[9]!)[2]);

		// Open blocks are re-cloned on every delta: while block 1 streams, each
		// consecutive update carries a FRESH clone (never the previous snapshot's).
		for (let i = 3; i < updates.length - 1; i++) {
			expect(contentOf(updates[i + 1]!)[1]).not.toBe(contentOf(updates[i]!)[1]);
		}

		// Snapshot blocks never alias the mutable live partial.
		updates.forEach(u => {
			contentOf(u).forEach((block, i) => expect(block).not.toBe(partial.content[i]));
		});

		// The finalized block's content stays stable across the whole turn.
		updates.forEach(u => expect(textOf(u, 0)).toBe("A"));
	});
});

describe("agentLoop kCursorExecResolved (issue #4348)", () => {
	it("skips execute for a toolCall block marked as already run by Cursor's exec channel", async () => {
		const { kCursorExecResolved } = await import("@oh-my-pi/pi-ai/utils/block-symbols");

		const toolSchema = type({ command: "string" });
		let executeCalls = 0;
		const tool: AgentTool<typeof toolSchema, { command: string }> = {
			name: "bash",
			label: "Bash",
			description: "Run shell commands",
			parameters: toolSchema,
			async execute(_id, params) {
				executeCalls += 1;
				return {
					content: [{ type: "text", text: `local run: ${params.command}` }],
					details: { command: params.command },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		// Simulate the shape the Cursor provider now emits after
		// `synthesizeCursorExecToolCall`: a `toolCall` content block stamped
		// with `kCursorExecResolved` because the server-driven exec channel
		// already ran the tool. `agent-loop.ts` MUST NOT invoke `tool.execute`
		// again — that would double-execute bash/write/delete/etc. and append a
		// second `toolResult` with the same `toolCallId`.
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const resolvedBlock = {
					type: "toolCall" as const,
					id: "cursor-exec-tc-1",
					name: "bash",
					arguments: { command: "rm -rf /tmp/cursor-once" },
					[kCursorExecResolved]: true as const,
				};
				const finalMessage: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Ran the command." }, resolvedBlock],
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
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: finalMessage });
				stream.push({ type: "done", reason: "stop", message: finalMessage });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run bash")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		// Tool MUST NOT have been executed — Cursor already ran it server-side.
		expect(executeCalls).toBe(0);

		// No `tool_execution_start`/`tool_execution_end` from agent-loop —
		// those live-events belong to the bridge that already ran the tool.
		const startFromLoop = events.find(e => e.type === "tool_execution_start");
		const endFromLoop = events.find(e => e.type === "tool_execution_end");
		expect(startFromLoop).toBeUndefined();
		expect(endFromLoop).toBeUndefined();

		// And no duplicate `toolResult` message emitted for the resolved block:
		// the buffered result flows via the Agent-class path, not agent-loop.
		const orphanToolResult = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		expect(orphanToolResult).toBeUndefined();
	});

	it("still runs a normal, unmarked toolCall block in the same turn", async () => {
		// Guards against the filter over-matching: a mixed turn where only
		// SOME blocks are Cursor-resolved must still execute the unmarked one.
		const { kCursorExecResolved } = await import("@oh-my-pi/pi-ai/utils/block-symbols");

		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (turn++ === 0) {
					const resolvedBlock = {
						type: "toolCall" as const,
						id: "resolved-1",
						name: "bash",
						arguments: { command: "true" },
						[kCursorExecResolved]: true as const,
					};
					const runnableBlock = {
						type: "toolCall" as const,
						id: "runnable-1",
						name: "echo",
						arguments: { value: "hi" },
					};
					const partial: AssistantMessage = {
						role: "assistant",
						content: [resolvedBlock, runnableBlock],
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
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "done", reason: "toolUse", message: partial });
				} else {
					// Second turn: replay `done` closes the loop.
					const partial: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "finished" }],
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
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				}
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("mixed")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual(["hi"]);

		const executionStarts = events.filter(e => e.type === "tool_execution_start");
		// Exactly one execution: the unmarked `echo` block. The resolved
		// `bash` block is passed through untouched.
		expect(executionStarts).toHaveLength(1);
		if (executionStarts[0]?.type !== "tool_execution_start") throw new Error("expected tool_execution_start");
		expect(executionStarts[0].toolCallId).toBe("runnable-1");
		expect(executionStarts[0].toolName).toBe("echo");
	});
});

describe("speculative tool execution", () => {
	it("opens, updates, and finalizes a stream policy before final call admission", async () => {
		const schema = type({ value: "string" });
		const calls: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "streamed",
			label: "Streamed",
			description: "Records speculative stream lifecycle",
			parameters: schema,
			speculation: {
				stream: {
					open: ({ parentToolCallId }) => {
						calls.push(`open:${parentToolCallId}`);
						return {
							update: (toolCall, partialJson) => {
								calls.push(`update:${toolCall.id}:${partialJson}`);
							},
							finalize: ({ toolCall }) => {
								calls.push(`finalize:${toolCall.id}`);
							},
							commit: () => {
								calls.push("commit");
							},
							discard: reason => {
								calls.push(`discard:${reason}`);
							},
						};
					},
				},
			},
			async execute(_toolCallId, _args, _signal, _onUpdate, context) {
				calls.push("execute");
				await context?.[SPECULATIVE_STREAM_SESSION]?.commit();
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		let turn = 0;
		const streamFn = () => {
			const response = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (turn++ === 0) {
					const streamingToolCall = {
						type: "toolCall" as const,
						id: "stream-1",
						name: "streamed",
						arguments: {},
					};
					setStreamingPartialJson(streamingToolCall, '{"value":"ok"}');
					const streamingPartial = createAssistantMessage([streamingToolCall], "toolUse");
					const toolCall = {
						type: "toolCall" as const,
						id: "stream-1",
						name: "streamed",
						arguments: { value: "ok" },
					};
					const finalPartial = createAssistantMessage([toolCall], "toolUse");
					response.push({ type: "start", partial: streamingPartial });
					response.push({ type: "toolcall_start", contentIndex: 0, partial: streamingPartial });
					response.push({ type: "toolcall_delta", contentIndex: 0, delta: '"ok"}', partial: streamingPartial });
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalPartial });
					response.push({ type: "done", reason: "toolUse", message: finalPartial });
					return;
				}
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				response.push({ type: "start", partial });
				response.push({ type: "done", reason: "stop", message: partial });
			});
			return response;
		};

		await agentLoop(
			[createUserMessage("stream")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: createMockModel({ responses: [] }).model,
				convertToLlm: identityConverter,
				getToolContext: () => ({}),
				speculativeToolExecution: { enabled: true },
			},
			undefined,
			streamFn,
		).result();

		expect(calls).toEqual([
			"open:stream-1",
			'update:stream-1:{"value":"ok"}',
			"finalize:stream-1",
			"execute",
			"commit",
		]);
	});

	it("skips stream speculation sessions when a message transformer is configured", async () => {
		const schema = type({ value: "string" });
		const calls: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "streamed",
			label: "Streamed",
			description: "Records stream session opens",
			parameters: schema,
			speculation: {
				stream: {
					open: ({ parentToolCallId }) => {
						calls.push(`open:${parentToolCallId}`);
						return {
							update() {},
							finalize() {},
							commit() {},
							discard() {},
						};
					},
				},
			},
			async execute() {
				calls.push("execute");
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		let turn = 0;
		const streamFn = () => {
			const response = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (turn++ === 0) {
					const streamingToolCall = {
						type: "toolCall" as const,
						id: "stream-1",
						name: "streamed",
						arguments: {},
					};
					setStreamingPartialJson(streamingToolCall, '{"value":"ok"}');
					const streamingPartial = createAssistantMessage([streamingToolCall], "toolUse");
					const toolCall = {
						type: "toolCall" as const,
						id: "stream-1",
						name: "streamed",
						arguments: { value: "ok" },
					};
					const finalPartial = createAssistantMessage([toolCall], "toolUse");
					response.push({ type: "start", partial: streamingPartial });
					response.push({ type: "toolcall_start", contentIndex: 0, partial: streamingPartial });
					response.push({ type: "toolcall_delta", contentIndex: 0, delta: '"ok"}', partial: streamingPartial });
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalPartial });
					response.push({ type: "done", reason: "toolUse", message: finalPartial });
					return;
				}
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				response.push({ type: "start", partial });
				response.push({ type: "done", reason: "stop", message: partial });
			});
			return response;
		};

		// Even an identity transformer can rewrite or remove the call before
		// dispatch, so stream sessions planning from pre-transform arguments
		// must never open — matching the direct-admission guard.
		await agentLoop(
			[createUserMessage("stream")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: createMockModel({ responses: [] }).model,
				convertToLlm: identityConverter,
				getToolContext: () => ({}),
				transformAssistantMessage: async () => {},
				speculativeToolExecution: { enabled: true },
			},
			undefined,
			streamFn,
		).result();

		expect(calls).toEqual(["execute"]);
	});

	it("reconciles streamed calls when the provider iterator ends without a final event", async () => {
		const schema = type({ value: "string" });
		const discarded: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "streamed",
			label: "Streamed",
			description: "Records speculative stream cleanup",
			parameters: schema,
			speculation: {
				stream: {
					open: () => ({
						update() {},
						finalize() {},
						commit() {},
						discard: reason => {
							discarded.push(reason);
						},
					}),
				},
			},
			async execute() {
				throw new Error("the trailing response removed this tool call");
			},
		};
		const streamingToolCall = {
			type: "toolCall" as const,
			id: "removed-stream",
			name: "streamed",
			arguments: {},
		};
		setStreamingPartialJson(streamingToolCall, '{"value":"discard"}');
		const streamingPartial = createAssistantMessage([streamingToolCall], "toolUse");
		const finalizedToolCall = { ...streamingToolCall, arguments: { value: "discard" } };
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: streamingPartial },
			{ type: "toolcall_start", contentIndex: 0, partial: streamingPartial },
			{ type: "toolcall_delta", contentIndex: 0, delta: '"discard"}', partial: streamingPartial },
			{ type: "toolcall_end", contentIndex: 0, toolCall: finalizedToolCall, partial: streamingPartial },
		];
		const cursorResolvedToolCall = { ...finalizedToolCall, [kCursorExecResolved]: true as const };
		const trailingMessages = [
			createAssistantMessage([{ type: "text", text: "finished without the call" }], "stop"),
			createAssistantMessage([cursorResolvedToolCall], "stop"),
		];
		for (const trailing of trailingMessages) {
			const previousDiscardCount = discarded.length;
			const streamFn = () => {
				let index = 0;
				return {
					result: async () => trailing,
					[Symbol.asyncIterator]: () => ({
						next: async (): Promise<IteratorResult<AssistantMessageEvent>> =>
							index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined },
					}),
				} as AssistantMessageEventStream;
			};

			await agentLoop(
				[createUserMessage("stream")],
				{ systemPrompt: [""], messages: [], tools: [tool] },
				{
					model: createMockModel({ responses: [] }).model,
					convertToLlm: identityConverter,
					getToolContext: () => ({}),
					speculativeToolExecution: { enabled: true },
				},
				undefined,
				streamFn,
			).result();

			expect(discarded).toHaveLength(previousDiscardCount + 1);
		}

		const previousDiscardCount = discarded.length;
		const failingStream = () => {
			let index = 0;
			return {
				result: async (): Promise<AssistantMessage> => {
					throw new Error("trailing response failed");
				},
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<AssistantMessageEvent>> =>
						index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined },
				}),
			} as AssistantMessageEventStream;
		};

		await expect(
			agentLoop(
				[createUserMessage("stream")],
				{ systemPrompt: [""], messages: [], tools: [tool] },
				{
					model: createMockModel({ responses: [] }).model,
					convertToLlm: identityConverter,
					getToolContext: () => ({}),
					speculativeToolExecution: { enabled: true },
				},
				undefined,
				failingStream,
			).result(),
		).rejects.toThrow("trailing response failed");
		expect(discarded.slice(previousDiscardCount)).toEqual(["provider stream finalization failed"]);
	});

	it("invalidates failed descendants without discarding independent siblings", async () => {
		const schema = type({ name: "string" });
		const executions: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "shadow",
			label: "Shadow",
			description: "Exercises dependency scheduling",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute({ args }) {
						const name = args.name as string;
						executions.push(name);
						if (name === "parent") throw new Error("parent failed");
						return { kind: "result", result: { content: [{ type: "text", text: name }] }, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("ordinary execution is not part of this scheduler test");
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const coordinator = new SpeculativeOperationCoordinator(
			{ enabled: true, maxInFlight: 2 },
			{ context, loopConfig },
		);
		const makeCall = (id: string, name: string) => ({
			type: "toolCall" as const,
			id,
			name: "shadow",
			arguments: { name },
		});
		const parent = await coordinator.admit({
			candidateId: "parent",
			parentToolCallId: "eval-1",
			dependencies: [],
			toolCall: makeCall("parent-call", "parent"),
			tool,
			source: "eval_shadow",
		});
		const child = await coordinator.admit({
			candidateId: "child",
			parentToolCallId: "eval-1",
			dependencies: ["parent"],
			toolCall: makeCall("child-call", "child"),
			tool,
			source: "eval_shadow",
		});
		const sibling = await coordinator.admit({
			candidateId: "sibling",
			parentToolCallId: "eval-1",
			dependencies: [],
			toolCall: makeCall("sibling-call", "sibling"),
			tool,
			source: "eval_shadow",
		});
		await coordinator.finalizeAdmissions();

		await expect(parent?.outcome).rejects.toThrow("parent failed");
		await expect(child?.outcome).rejects.toThrow("dependency parent did not settle successfully");
		await expect(sibling?.outcome).resolves.toEqual({
			kind: "result",
			result: { content: [{ type: "text", text: "sibling" }] },
			isError: false,
		});
		expect(executions).toEqual(["parent", "sibling"]);
		await coordinator.close("test complete");
	});

	it("shares maxInFlight across dependency-aware child operations", async () => {
		const schema = type({ index: "number" });
		let running = 0;
		let peak = 0;
		const gate = Promise.withResolvers<void>();
		const tool: AgentTool<typeof schema> = {
			name: "bounded",
			label: "Bounded",
			description: "Measures speculative concurrency",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						running++;
						peak = Math.max(peak, running);
						await gate.promise;
						running--;
						return { kind: "result", result: { content: [] }, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("ordinary execution is not part of this scheduler test");
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const coordinator = new SpeculativeOperationCoordinator(
			{ enabled: true, maxInFlight: 2 },
			{ context, loopConfig },
		);
		const handles = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				coordinator.admit({
					candidateId: `candidate-${index}`,
					parentToolCallId: "eval-1",
					dependencies: [],
					toolCall: {
						type: "toolCall",
						id: `call-${index}`,
						name: "bounded",
						arguments: { index },
					},
					tool,
					source: "eval_shadow",
				}),
			),
		);
		await coordinator.finalizeAdmissions();
		expect(running).toBe(2);
		gate.resolve();
		await Promise.all(handles.map(handle => handle?.outcome));
		expect(peak).toBe(2);
		await coordinator.close("test complete");
	});

	it("normalizes non-positive maxInFlight values so admitted work cannot deadlock", async () => {
		const schema = type({});
		const tool: AgentTool<typeof schema> = {
			name: "bounded",
			label: "Bounded",
			description: "Runs one bounded candidate",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						return { kind: "result", result: { content: [{ type: "text", text: "done" }] }, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("ordinary execution is not part of this scheduler test");
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const coordinator = new SpeculativeOperationCoordinator(
			{ enabled: true, maxInFlight: 0 },
			{
				context,
				loopConfig: {
					model: createMockModel({ responses: [] }).model,
					convertToLlm: identityConverter,
				},
			},
		);
		const handle = await coordinator.admit({
			candidateId: "bounded-1",
			parentToolCallId: "eval-1",
			dependencies: [],
			toolCall: { type: "toolCall", id: "bounded-1", name: "bounded", arguments: {} },
			tool,
			source: "eval_shadow",
		});
		await coordinator.finalizeAdmissions();

		expect(
			await Promise.race([handle?.outcome.then(() => "completed"), Bun.sleep(100).then(() => "timed-out")]),
		).toBe("completed");
		await coordinator.close("test complete");
	});

	it("keeps the session-scoped host open when a turn coordinator closes", async () => {
		let closeCalls = 0;
		const coordinator = new SpeculativeOperationCoordinator(
			{
				enabled: true,
				host: {
					authorize: () => ({ allowed: true }),
					close: () => {
						closeCalls++;
					},
				},
			},
			{
				context: { systemPrompt: [""], messages: [], tools: [] },
				loopConfig: {
					model: createMockModel({ responses: [] }).model,
					convertToLlm: identityConverter,
				},
			},
		);

		await coordinator.close("turn complete");

		expect(closeCalls).toBe(0);
	});
	it("does not invoke beforeToolCall for a truncated tool turn", async () => {
		const schema = type({ value: "string" });
		let hookCalls = 0;
		let speculativeExecutions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "truncated",
			label: "Truncated",
			description: "Records dispatch preparation",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						speculativeExecutions++;
						return { kind: "result", result: { content: [] }, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("truncated calls must not execute");
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "truncated-1", name: "truncated", arguments: { value: "skip" } }],
					stopReason: "length",
				},
				{ content: ["done"] },
			],
		});

		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					hookCalls++;
				},
				speculativeToolExecution: {
					enabled: true,
					host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
				},
			},
			undefined,
			mock.stream,
		).result();

		expect(hookCalls).toBe(0);
		expect(speculativeExecutions).toBe(0);
	});

	it("discards blocked and preparation-failed calls before releasing host-deferred work", async () => {
		for (const preparation of ["blocked", "failed"] as const) {
			const schema = type({ value: "string" });
			let speculativeExecutions = 0;
			let ordinaryExecutions = 0;
			const tool: AgentTool<typeof schema> = {
				name: "deferred",
				label: "Deferred",
				description: "Exercises pre-dispatch speculation gating",
				parameters: schema,
				speculation: {
					finalized: {
						assess: () => ({ eligible: true, effect: { kind: "pure" } }),
						async execute() {
							speculativeExecutions++;
							return { kind: "result", result: { content: [] }, isError: false };
						},
					},
				},
				async execute() {
					ordinaryExecutions++;
					return { content: [] };
				},
			};
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: `deferred-${preparation}`,
								name: "deferred",
								arguments: { value: "run" },
							},
						],
					},
					{ content: ["done"] },
				],
			});

			await agentLoop(
				[createUserMessage("run")],
				{ systemPrompt: [""], messages: [], tools: [tool] },
				{
					model: mock.model,
					convertToLlm: identityConverter,
					beforeToolCall: async () => {
						if (preparation === "failed") throw new Error("policy failed");
						return { block: true, reason: "policy denied execution" };
					},
					speculativeToolExecution: {
						enabled: true,
						host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
					},
				},
				undefined,
				mock.stream,
			).result();

			expect(speculativeExecutions).toBe(0);
			expect(ordinaryExecutions).toBe(0);
		}
	});

	it("normalizes malformed speculative results before persisting them", async () => {
		const schema = type({ value: "string" });
		const tool: AgentTool<typeof schema> = {
			name: "malformed",
			label: "Malformed",
			description: "Returns a malformed speculative result",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						// Deliberately malformed at runtime (still typechecks via cast):
						// content must be an array but arrives as a string.
						const malformed = { content: "not-an-array" } as unknown as SpeculativePhysicalOutcome["result"];
						return { kind: "result", result: malformed, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("ordinary execution must not run for a claimed speculation");
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "malformed-1", name: "malformed", arguments: { value: "run" } }],
				},
				{ content: ["done"] },
			],
		});
		let observed: { content: unknown; isError: unknown } | undefined;
		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				afterToolCall: async ({ result, isError }) => {
					observed = { content: result.content, isError };
				},
				speculativeToolExecution: { enabled: true },
			},
			undefined,
			mock.stream,
		).result();

		if (!observed) throw new Error("expected the tool turn to complete");
		expect(Array.isArray(observed.content)).toBe(true);
		expect(observed.isError).toBe(true);
	});

	it("discards host-deferred work when beforeToolCall mutates validated arguments in place", async () => {
		const schema = type({ value: "string" });
		let speculativeExecutions = 0;
		const ordinaryArguments: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "rewritten",
			label: "Rewritten",
			description: "Exercises final-argument reconciliation",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) =>
						typeof args.value === "string"
							? {
									eligible: true,
									effect: {
										kind: "local_read",
										resources: [{ scheme: "file", path: args.value, access: "read" }],
									},
								}
							: { eligible: false, reason: "value must be a string" },
					async execute() {
						speculativeExecutions++;
						return { kind: "result", result: { content: [] }, isError: false };
					},
				},
			},
			async execute(_toolCallId, args) {
				ordinaryArguments.push(args.value);
				return { content: [] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "rewritten-1", name: "rewritten", arguments: { value: "before" } }] },
				{ content: ["done"] },
			],
		});

		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolCall: async ({ args }) => {
					args.value = "after";
				},
				speculativeToolExecution: {
					enabled: true,
					host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
				},
			},
			undefined,
			mock.stream,
		).result();

		expect(speculativeExecutions).toBe(0);
		expect(ordinaryArguments).toEqual(["after"]);
	});

	it("reconciles host-deferred candidates with the transformed execution arguments", async () => {
		const schema = type({ value: "string" });
		const speculativeArguments: string[] = [];
		const ordinaryArguments: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "transformed",
			label: "Transformed",
			description: "Uses transformed arguments for speculative reconciliation",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) =>
						args.value === "after"
							? { eligible: true, effect: { kind: "pure" } }
							: { eligible: false, reason: "expected transformed arguments" },
					async execute({ args }) {
						speculativeArguments.push(String(args.value));
						return {
							kind: "result",
							result: { content: [{ type: "text", text: "speculative result" }] },
							isError: false,
						};
					},
				},
			},
			async execute(_toolCallId, args) {
				ordinaryArguments.push(args.value);
				return { content: [{ type: "text", text: "ordinary result" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "transformed-1", name: "transformed", arguments: { value: "before" } },
					],
				},
				{ content: ["done"] },
			],
		});

		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				transformToolCallArguments: args => ({ ...args, value: "after" }),
				speculativeToolExecution: {
					enabled: true,
					host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
				},
			},
			undefined,
			mock.stream,
		).result();

		expect(speculativeArguments).toEqual(["after"]);
		expect(ordinaryArguments).toEqual([]);
	});

	it("falls back from a structured error returned by direct speculative execution", async () => {
		const schema = type({ value: "string" });
		let speculativeExecutions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "transient",
			label: "Transient",
			description: "Returns one speculative error",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						speculativeExecutions++;
						return {
							kind: "result",
							result: { content: [{ type: "text", text: "temporary failure" }], isError: true },
							isError: true,
						};
					},
				},
			},
			async execute() {
				return { content: [{ type: "text", text: "recovered" }] };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true }, { context, loopConfig });
		const toolCall = {
			type: "toolCall" as const,
			id: "transient-1",
			name: "transient",
			arguments: { value: "run" },
		};

		coordinator.admitFinalized(context, toolCall, loopConfig, undefined);
		await coordinator.finalizeAdmissions();

		await expect(coordinator.claim(tool, toolCall, { value: "run" })).resolves.toBeUndefined();
		expect(speculativeExecutions).toBe(1);
		await coordinator.close("test complete");
	});

	it("does not attach a coordinator whose final calls were discarded", async () => {
		const schema = type({ value: "string" });
		const tool: AgentTool<typeof schema> = {
			name: "discarded",
			label: "Discarded",
			description: "Returns a value",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						return { kind: "result", result: { content: [] }, isError: false };
					},
				},
			},
			async execute() {
				return { content: [] };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true }, { context, loopConfig });
		const toolCall = {
			type: "toolCall" as const,
			id: "discarded-1",
			name: "discarded",
			arguments: { value: "run" },
		};
		coordinator.admitFinalized(context, toolCall, loopConfig, undefined);

		await coordinator.reconcileFinalCalls(new Map());
		const message = createAssistantMessage([]);
		coordinator.attach(message);

		expect(coordinator.size).toBe(0);
		expect(SpeculativeOperationCoordinator.take(message)).toBeUndefined();
		await coordinator.close("test complete");
	});
	it("discards stream sessions whose final arguments changed", async () => {
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true });
		const discarded: string[] = [];
		expect(
			coordinator.registerStreamSession("stream-1", {
				update() {},
				finalize() {},
				commit() {},
				async discard(reason: string) {
					discarded.push(reason);
				},
				matchesFinalArgs: args => args.code === "original",
			}),
		).toBe(true);
		const callFor = (code: string) =>
			new Map([["stream-1", { type: "toolCall" as const, id: "stream-1", name: "eval", arguments: { code } }]]);
		// Unchanged arguments retain the session.
		await coordinator.reconcileFinalCalls(callFor("original"));
		expect(discarded).toEqual([]);
		// A hook rewrite that keeps the ID discards the stale plan.
		await coordinator.reconcileFinalCalls(callFor("replaced"));
		expect(discarded).toEqual(["final outer tool call arguments changed"]);
		await coordinator.close("test complete");
	});

	it("does not attach a coordinator after its close begins", async () => {
		const cleanup = Promise.withResolvers<void>();
		const coordinator = new SpeculativeOperationCoordinator({ enabled: true });
		expect(
			coordinator.registerStreamSession("late-stream", {
				update() {},
				finalize() {},
				commit() {},
				async discard() {
					await cleanup.promise;
				},
			}),
		).toBe(true);
		const closing = coordinator.close("turn aborted", "aborted");
		const message = createAssistantMessage([]);

		coordinator.attach(message);

		expect(SpeculativeOperationCoordinator.take(message)).toBeUndefined();
		cleanup.resolve();
		await closing;
	});
});
