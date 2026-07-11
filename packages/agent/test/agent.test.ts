import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, type AgentTool, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { type SimpleStreamOptions, z } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

describe("Agent", () => {
	it("should support steering message queueing", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const mock = createMockModel({ responses: [{ content: ["Processed"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some(message => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some(part => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		const mock = createMockModel({
			responses: [{ content: ["Processed 1"] }, { content: ["Processed 2"] }],
		});
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(mock.calls.length).toBe(2);
	});

	it("delivers a steer that lands at the yield boundary instead of stranding it", async () => {
		// Regression: a steering message queued after the stop-boundary dequeue
		// (e.g. while onBeforeYield runs) was silently stranded in the queue until
		// the next manual prompt. The outer yield drain must re-poll steering.
		const mock = createMockModel({ responses: [{ content: ["First answer"] }, { content: ["Steer answer"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		let injected = false;
		agent.setOnBeforeYield(() => {
			if (injected) return;
			injected = true;
			agent.steer({
				role: "user",
				content: [{ type: "text", text: "Late steer" }],
				steering: true,
				timestamp: Date.now(),
			});
		});

		await agent.prompt("Initial");

		expect(mock.calls.length).toBe(2);
		expect(agent.hasQueuedMessages()).toBe(false);
		const steerDelivered = agent.state.messages.some(
			message =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(part => part.type === "text" && part.text === "Late steer"),
		);
		expect(steerDelivered).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("keeps Anthropic refusal errors out of the next provider context", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: ["I can't assist with that request."],
					stopReason: "error",
					stopDetails: { type: "refusal", category: "bio", explanation: "policy refusal" },
					errorMessage: "Refusal (bio): policy refusal",
				},
				{ content: ["recovered"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		await agent.prompt("trigger refusal");
		await agent.prompt("next request");

		expect(mock.calls).toHaveLength(2);
		const replayedMessages = mock.calls[1].context.messages;
		expect(replayedMessages.map(message => message.role)).toEqual(["user", "user"]);
		expect(JSON.stringify(replayedMessages)).not.toContain("Refusal (bio)");
		expect(JSON.stringify(replayedMessages)).not.toContain("I can't assist");
	});

	it("prompt() emits assistant error lifecycle for Anthropic output-blocked stream errors before assistant start", async () => {
		const mock = createMockModel({ responses: [] });
		const errorText = "Output blocked by content filtering policy";
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new Error(errorText)));
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("trigger");
		unsubscribe();

		const assistantStartIndex = events.findIndex(
			event => event.type === "message_start" && event.message.role === "assistant",
		);
		const assistantEndIndex = events.findIndex(
			event => event.type === "message_end" && event.message.role === "assistant",
		);
		const turnEndIndex = events.findIndex(event => event.type === "turn_end");
		const agentEndIndex = events.findIndex(event => event.type === "agent_end");
		expect(assistantStartIndex).toBeGreaterThan(-1);
		expect(assistantEndIndex).toBeGreaterThan(assistantStartIndex);
		expect(turnEndIndex).toBeGreaterThan(assistantEndIndex);
		expect(agentEndIndex).toBeGreaterThan(turnEndIndex);

		const assistantEnd = events[assistantEndIndex];
		if (assistantEnd?.type !== "message_end" || assistantEnd.message.role !== "assistant") {
			throw new Error("assistant message_end not emitted");
		}
		expect(assistantEnd.message.stopReason).toBe("error");
		expect(assistantEnd.message.errorMessage).toBe(errorText);

		const lastMessage = agent.state.messages.at(-1);
		if (lastMessage?.role !== "assistant") {
			throw new Error("assistant error was not appended");
		}
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe(errorText);
	});

	it("prompt() keeps unrelated provider stream failures out of the assistant lifecycle", async () => {
		const mock = createMockModel({ responses: [] });
		const errorText = "connection reset";
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new Error(errorText)));
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("trigger");
		unsubscribe();

		expect(events.some(event => event.type === "message_start" && event.message.role === "assistant")).toBe(false);
		expect(events.some(event => event.type === "message_end" && event.message.role === "assistant")).toBe(false);
		const agentEnd = events.find(event => event.type === "agent_end");
		if (agentEnd?.type !== "agent_end") {
			throw new Error("agent_end not emitted");
		}
		const errorMessage = agentEnd.messages.find(message => message.role === "assistant");
		if (errorMessage?.role !== "assistant") {
			throw new Error("assistant error was not included in agent_end");
		}
		expect(errorMessage.errorMessage).toBe(errorText);
	});

	it("prompt() finalizes an existing assistant stream for Anthropic output-blocked stream errors", async () => {
		const mock = createMockModel({ responses: [] });
		const errorText = "Output blocked by content filtering policy";
		const started = createAssistantMessage([{ type: "text", text: "partial" }]);
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: started });
					stream.fail(new Error(errorText));
				});
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("trigger");
		unsubscribe();

		const assistantStarts = events.filter(
			event => event.type === "message_start" && event.message.role === "assistant",
		);
		const assistantEnds = events.filter(event => event.type === "message_end" && event.message.role === "assistant");
		expect(assistantStarts).toHaveLength(1);
		expect(assistantEnds).toHaveLength(1);

		const assistantEnd = assistantEnds[0];
		if (assistantEnd?.type !== "message_end" || assistantEnd.message.role !== "assistant") {
			throw new Error("assistant message_end not emitted");
		}
		expect(assistantEnd.message.stopReason).toBe("error");
		expect(assistantEnd.message.errorMessage).toBe(errorText);
	});

	it("prompt() refreshes tools and system prompt between same-turn model calls", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["prompt-one"],
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setSystemPrompt(["prompt-two"]);
				agent.setTools([alphaTool, betaTool]);
			}
		});

		await agent.prompt("refresh tools");
		unsubscribe();

		const observed = mock.calls.map(call => ({
			systemPrompt: call.context.systemPrompt?.join("\n\n") ?? "",
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
		}));
		expect(observed).toEqual([
			{ systemPrompt: "prompt-one", toolNames: ["alpha"] },
			{ systemPrompt: "prompt-two", toolNames: ["alpha", "beta"] },
		]);
	});

	it("prompt() drops stale forced toolChoice after same-turn tool refresh", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setTools([betaTool]);
			}
		});

		await agent.prompt("refresh tools", { toolChoice: { type: "function", name: "alpha" } });
		unsubscribe();

		const observed = mock.calls.map(call => ({
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
			toolChoice: call.options?.toolChoice,
		}));
		expect(observed).toEqual([
			{ toolNames: ["alpha"], toolChoice: { type: "function", name: "alpha" } },
			{ toolNames: ["beta"], toolChoice: undefined },
		]);
	});

	it("drops queued forced toolChoice when the queued tool is not active", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: {
				model: mock.model,
				tools: [betaTool],
				messages: [],
			},
			streamFn: mock.stream,
			getToolChoice: () => ({ type: "function", name: "alpha" }),
		});

		await agent.prompt("refresh tools");

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.context.tools?.map(tool => tool.name)).toEqual(["beta"]);
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
	});

	it("re-reads thinking level for each model call within a run", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				thinkingLevel: ThinkingLevel.Low,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		// Bump thinking level mid-run, after the first assistant turn finishes
		// and before the second model call (which follows the tool result).
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setThinkingLevel(ThinkingLevel.High);
			}
		});

		await agent.prompt("run");
		unsubscribe();

		const reasoningPerCall: Array<SimpleStreamOptions["reasoning"]> = mock.calls.map(call => call.options?.reasoning);
		expect(reasoningPerCall).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
	});

	it("forwards explicit reasoning disablement to the stream", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: {
				model: mock.model,
				messages: [],
				disableReasoning: true,
			},
			streamFn: mock.stream,
		});

		await agent.prompt("run");

		expect(mock.calls[0]?.options?.disableReasoning).toBe(true);
	});

	it("re-reads disableReasoning for each model call within a run", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				thinkingLevel: ThinkingLevel.High,
				disableReasoning: false,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		// Flip thinking off mid-run after the first assistant turn produces the
		// tool call but before the continuation request is sent.
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setThinkingLevel(undefined);
				agent.setDisableReasoning(true);
			}
		});

		await agent.prompt("run");
		unsubscribe();

		const disablePerCall = mock.calls.map(call => call.options?.disableReasoning);
		expect(disablePerCall).toEqual([false, true]);
	});

	it("forwards distinct provider session id and prompt cache key to the stream", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, messages: [] },
			streamFn: mock.stream,
			sessionId: "provider-lineage",
			promptCacheKey: "parent-cache",
		});

		await agent.prompt("run");

		expect(mock.calls[0]?.options?.sessionId).toBe("provider-lineage");
		expect(mock.calls[0]?.options?.promptCacheKey).toBe("parent-cache");
	});

	it("forwards the live cwd from cwdResolver to the stream, overriding the static cwd", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, messages: [] },
			streamFn: mock.stream,
			cwd: "/static/repo-a",
			cwdResolver: () => "/live/repo-b",
		});

		await agent.prompt("run");

		// The resolver wins over the constructor-time `cwd`: provider workspace
		// discovery (e.g. GitLab Duo namespace/project) must key off the live dir.
		expect(mock.calls[0]?.options?.cwd).toBe("/live/repo-b");
	});

	it("falls back to the static cwd when cwdResolver returns undefined", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, messages: [] },
			streamFn: mock.stream,
			cwd: "/static/repo-a",
			cwdResolver: () => undefined,
		});

		await agent.prompt("run");

		expect(mock.calls[0]?.options?.cwd).toBe("/static/repo-a");
	});

	it("re-reads cwd from cwdResolver for each model call within a run (a /move mid-run is seen)", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		// The host owns the live cwd; `cwdResolver` reads it on every config build.
		let liveCwd = "/live/repo-a";
		const agent = new Agent({
			initialState: { model: mock.model, tools: [alphaTool], messages: [] },
			streamFn: mock.stream,
			cwdResolver: () => liveCwd,
		});

		// Simulate `/move` between the tool-call turn and the continuation request.
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				liveCwd = "/live/repo-b";
			}
		});

		await agent.prompt("run");
		unsubscribe();

		const cwdPerCall = mock.calls.map(call => call.options?.cwd);
		expect(cwdPerCall).toEqual(["/live/repo-a", "/live/repo-b"]);
	});

	it("returns static metadata via the plain setter", () => {
		const agent = new Agent();
		expect(agent.metadata).toBeUndefined();

		const value = { user_id: "static" };
		agent.metadata = value;
		expect(agent.metadata).toEqual({ user_id: "static" });

		agent.metadata = undefined;
		expect(agent.metadata).toBeUndefined();
	});

	it("metadataForProvider resolves dynamic value at every call when a resolver is installed", () => {
		const agent = new Agent();
		let live = "alpha";
		agent.setMetadataResolver(() => ({ user_id: live }));

		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "alpha" });
		live = "beta";
		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "beta" });
		// Static getter is unaffected by the resolver.
		expect(agent.metadata).toBeUndefined();
	});

	it("clears any installed resolver when assigning the plain setter", () => {
		const agent = new Agent();
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.metadata = { user_id: "from-static" };
		expect(agent.metadata).toEqual({ user_id: "from-static" });
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-static" });
	});

	it("metadataForProvider returns undefined from the resolver even when a static value is set", () => {
		// Pin the contract that an installed resolver wins unconditionally over
		// `#metadata` in the per-provider path.
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => undefined);
		expect(agent.metadataForProvider("any")).toBeUndefined();
		// The static getter returns the pre-set static value; the resolver does not affect it.
		expect(agent.metadata).toEqual({ user_id: "static" });
	});

	it("reverts to the plain-setter value when the resolver is cleared via setMetadataResolver(undefined)", () => {
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.setMetadataResolver(undefined);
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "static" });
		expect(agent.metadata).toEqual({ user_id: "static" });
	});
});

describe("Agent — F3 in-place state mutation", () => {
	it("appendMessage mutates the existing messages array in place", () => {
		const agent = new Agent();
		const arr = agent.state.messages;

		agent.appendMessage({ role: "user", content: "a", timestamp: 1 });
		agent.appendMessage({ role: "user", content: "b", timestamp: 2 });

		expect(agent.state.messages).toBe(arr);
		expect(arr.length).toBe(2);
	});

	it("popMessage mutates in place and clears streamMessage when popping it", () => {
		const agent = new Agent();
		const arr = agent.state.messages;

		const m1 = { role: "user" as const, content: "x", timestamp: 1 };
		const m2 = { role: "user" as const, content: "y", timestamp: 2 };
		agent.appendMessage(m1);
		agent.appendMessage(m2);

		const removed = agent.popMessage();
		expect(removed).toBe(m2);
		expect(agent.state.messages).toBe(arr);
		expect(agent.state.messages).toEqual([m1]);
	});

	it("clearMessages and reset preserve array/Set identity", () => {
		const agent = new Agent();
		const msgs = agent.state.messages;
		const pending = agent.state.pendingToolCalls;

		agent.appendMessage({ role: "user", content: "x", timestamp: 1 });
		agent.clearMessages();
		expect(agent.state.messages).toBe(msgs);
		expect(agent.state.messages.length).toBe(0);

		agent.appendMessage({ role: "user", content: "y", timestamp: 2 });
		agent.reset();
		expect(agent.state.messages).toBe(msgs);
		expect(agent.state.pendingToolCalls).toBe(pending);
		expect(agent.state.messages.length).toBe(0);
		expect(agent.state.pendingToolCalls.size).toBe(0);
	});

	it("replaceMessages still snapshots the input (callers may keep mutating their array)", () => {
		const agent = new Agent();
		const external = [{ role: "user" as const, content: "x", timestamp: 1 }];
		agent.replaceMessages(external);
		external.push({ role: "user", content: "leaked", timestamp: 2 });
		expect(agent.state.messages.length).toBe(1);
	});

	it("constructor snapshots caller-owned mutable initial state collections", () => {
		const messages = [{ role: "user" as const, content: "x", timestamp: 1 }];
		const pendingToolCalls = new Set(["call-1"]);
		const agent = new Agent({ initialState: { messages, pendingToolCalls } });

		agent.appendMessage({ role: "user", content: "y", timestamp: 2 });
		agent.emitExternalEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "tool", result: {} });

		expect(messages.length).toBe(1);
		expect(pendingToolCalls.has("call-1")).toBe(true);
		expect(agent.state.messages).not.toBe(messages);
		expect(agent.state.pendingToolCalls).not.toBe(pendingToolCalls);
	});
});
