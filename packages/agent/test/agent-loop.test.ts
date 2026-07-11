import { describe, expect, it } from "bun:test";
import { agentLoop, agentLoopContinue, agentLoopDetailed } from "@pk-nerdsaver-ai/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	ToolCallContext,
} from "@pk-nerdsaver-ai/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import { type } from "arktype";
import { createAssistantMessage, createUserMessage } from "./helpers";

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

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
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

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

	it("should skip remaining tool calls when steering is queued", async () => {
		const toolSchema = type({ value: "string" });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
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

		// Only the first tool should execute; the second is skipped after steering is queued.
		expect(executed).toEqual(["first"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(true);
		if (toolEnds[1].result.content[0]?.type === "text") {
			expect(toolEnds[1].result.content[0].text).toContain("Skipped due to queued user message");
		}

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

	it("does not abort a non-interruptible tool mid-wait; steering still drains at the boundary", async () => {
		const toolSchema = type({});
		let steerReady = false;
		let drained = false;
		let observedAbort = false;
		let resolvedByTimeout = false;

		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Blocks on its own window (no interruptible flag)",
			parameters: toolSchema,
			async execute(_toolCallId, _params, signal) {
				steerReady = true;
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal?.aborted) {
					resolve();
				} else {
					const timer = setTimeout(() => {
						resolvedByTimeout = true;
						resolve();
					}, 300);
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

		expect(observedAbort).toBe(false);
		expect(resolvedByTimeout).toBe(true);
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
		const stream = agentLoop([createUserMessage("Wait")], context, config, undefined, (_model, _context, options) => {
			options?.signal?.addEventListener("abort", () => {
				providerSignalAborted = true;
			});
			return new AssistantMessageEventStream();
		});

		const messages = await stream.result();

		expect(providerSignalAborted).toBe(true);
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
});
