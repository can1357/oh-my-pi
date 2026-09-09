import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, AgentBusyError, type AgentEvent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

describe("Agent", () => {
	it("should support steering message queueing", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("classifies agent-authored steering as a parent steering message", async () => {
		const toolSchema = type({ value: type("string") });
		const executed: string[] = [];
		const agentRef = {} as { current: Agent };
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				if (params.value === "first") {
					agentRef.current.steer({
						role: "user",
						content: "parent steering",
						attribution: "agent",
						timestamp: Date.now(),
					});
				}
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};
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
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			interruptMode: "immediate",
		});
		agentRef.current = agent;
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("start");
		unsubscribe();

		expect(executed).toEqual(["first"]);
		const skipped = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === "tool-2",
		);
		expect(skipped).toBeDefined();
		const skippedContent = skipped?.result.content[0];
		expect(skippedContent?.type).toBe("text");
		if (skippedContent?.type !== "text") throw new Error("skipped tool result must be text");
		expect(skippedContent.text).toContain("Skipped due to pending parent steering message");
		expect(skippedContent.text).toContain("After the steering message is handled on the next step");
		expect(skippedContent.text).not.toContain("pending system advisory");
		expect(skippedContent.text).not.toContain("queued user message");
	});

	it("classifies user-attributed custom steering as a queued user message", async () => {
		const toolSchema = type({ value: type("string") });
		const executed: string[] = [];
		const agentRef = {} as { current: Agent };
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				if (params.value === "first") {
					agentRef.current.steer({
						role: "custom",
						customType: "visible-user-steer",
						content: "visible custom steering",
						display: true,
						attribution: "user",
						timestamp: Date.now(),
					});
					agentRef.current.steer({
						role: "user",
						content: "normal user steering",
						timestamp: Date.now(),
					});
				}
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			steeringMode: "one-at-a-time",
			interruptMode: "immediate",
		});
		agentRef.current = agent;
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("start");
		unsubscribe();

		expect(executed).toEqual(["first"]);
		const skipped = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === "tool-2",
		);
		expect(skipped).toBeDefined();
		const skippedContent = skipped?.result.content[0];
		expect(skippedContent?.type).toBe("text");
		if (skippedContent?.type !== "text") throw new Error("skipped tool result must be text");
		expect(skippedContent.text).toContain("Skipped due to queued user message");
		expect(skippedContent.text).not.toContain("pending system advisory");
	});
	it("continue() re-executes a trailing assistant's unpaired tool calls before the next model call", async () => {
		const toolSchema = type({ value: type("string") });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		// One response only: the tool must run WITHOUT a model call re-issuing it,
		// and the single call is the post-tool continuation on the fresh result.
		const mock = createMockModel({ responses: [{ content: ["done after replay"] }] });
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [tool],
				// A harness stripped the failed tool result (AgentSession.retry's tool
				// replay), leaving the tool-calling assistant as the transcript tail.
				messages: [
					createUserMessage("run the probe"),
					createAssistantMessage(
						[{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
						"toolUse",
					),
				],
			},
			streamFn: mock.stream,
		});

		await agent.continue();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const roles = agent.state.messages.map(message => message.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const result = agent.state.messages[2] as ToolResultMessage;
		expect(result.toolCallId).toBe("call_1");
		expect(result.isError).not.toBe(true);
		expect(result.content).toContainEqual({ type: "text", text: "ok:again" });
	});

	it("classifies one-at-a-time steering from the next queued mixed source", async () => {
		const cases = [
			{
				order: ["system", "agent"] as const,
				expected: "pending system advisory",
				unexpected: "pending parent steering message",
			},
			{
				order: ["agent", "system"] as const,
				expected: "pending parent steering message",
				unexpected: "pending system advisory",
			},
		];

		for (const scenario of cases) {
			const toolSchema = type({ value: type("string") });
			const executed: string[] = [];
			const agentRef = {} as { current: Agent };
			const tool: AgentTool<typeof toolSchema, { value: string }> = {
				name: "echo",
				label: "Echo",
				description: "Echo tool",
				parameters: toolSchema,
				concurrency: "exclusive",
				interruptible: true,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					if (params.value === "first") {
						for (const source of scenario.order) {
							if (source === "agent") {
								agentRef.current.steer({
									role: "user",
									content: "parent steering",
									attribution: "agent",
									timestamp: Date.now(),
								});
							} else {
								agentRef.current.steer({
									role: "custom",
									customType: "advisor",
									content: "advisor steering",
									display: true,
									attribution: "agent",
									timestamp: Date.now(),
								});
							}
						}
					}
					return {
						content: [{ type: "text", text: `ok:${params.value}` }],
						details: { value: params.value },
					};
				},
			};
			const mock = createMockModel({
				responses: [
					{
						content: [
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
					},
					{ content: ["done"] },
					{ content: ["done"] },
				],
			});
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
				streamFn: mock.stream,
				interruptMode: "immediate",
			});
			agentRef.current = agent;
			const events: AgentEvent[] = [];
			const unsubscribe = agent.subscribe(event => events.push(event));

			await agent.prompt("start");
			unsubscribe();

			expect(executed).toEqual(["first"]);
			const skipped = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.toolCallId === "tool-2",
			);
			expect(skipped).toBeDefined();
			const skippedContent = skipped?.result.content[0];
			expect(skippedContent?.type).toBe("text");
			if (skippedContent?.type !== "text") throw new Error("skipped tool result must be text");
			expect(skippedContent.text).toContain(`Skipped due to ${scenario.expected}`);
			expect(skippedContent.text).not.toContain(scenario.unexpected);
		}
	});

	it("removes duplicate queued-message hooks independently", async () => {
		const mock = createMockModel({ responses: [{ content: ["first"] }, { content: ["second"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		let calls = 0;
		const signals: Array<AbortSignal | undefined> = [];
		const hook = (signal?: AbortSignal) => {
			calls++;
			signals.push(signal);
		};
		const removeFirst = agent.addBeforeQueuedMessageDequeueHook(hook);
		const removeSecond = agent.addBeforeQueuedMessageDequeueHook(hook);

		const controller = new AbortController();
		removeFirst();
		agent.followUp({ role: "user", content: "first turn", timestamp: Date.now() });
		await agent.continue(controller.signal);
		expect(calls).toBe(1);
		expect(signals).toEqual([controller.signal]);

		removeSecond();
		agent.followUp({ role: "user", content: "second turn", timestamp: Date.now() });
		await agent.continue();
		expect(calls).toBe(1);
	});

	it("continue() leaves queued messages owned when its signal is already aborted", async () => {
		const agent = new Agent();
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		agent.followUp({ role: "user", content: "stay queued", timestamp: Date.now() });
		const controller = new AbortController();
		controller.abort();

		await expect(agent.continue(controller.signal)).rejects.toThrow("Cannot continue from message role: assistant");
		expect(agent.peekFollowUpQueue()).toHaveLength(1);
	});
	it("keeps follow-up ownership when the deadline expires during a dequeue hook", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		// Generous budget: the loop checks the deadline before invoking dequeue
		// hooks, so the mock roundtrip must beat it even on starved CI runners.
		// The hook itself parks until the deadline timer aborts the loop signal,
		// so the expiry-during-hook branch stays exercised.
		const agent = new Agent({ streamFn: mock.stream, deadline: Date.now() + 1_000 });
		let hookSignal: AbortSignal | undefined;
		agent.addBeforeQueuedMessageDequeueHook(async signal => {
			if (!signal) throw new Error("Expected the active loop signal");
			hookSignal = signal;
			if (signal.aborted) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		});
		agent.followUp({ role: "user", content: "stay queued after deadline", timestamp: Date.now() });

		await agent.prompt("start");

		expect(hookSignal?.aborted).toBe(true);
		expect(agent.peekFollowUpQueue()).toHaveLength(1);
	});
	it("keeps queued work when continue() reaches its deadline inside a dequeue hook", async () => {
		// Same starvation guard as above: hook entry must precede expiry.
		const agent = new Agent({ deadline: Date.now() + 1_000 });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		agent.addBeforeQueuedMessageDequeueHook(async signal => {
			if (!signal) throw new Error("Expected the deadline-aware dequeue signal");
			if (signal.aborted) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		});
		agent.followUp({ role: "user", content: "stay queued before run loop", timestamp: Date.now() });

		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");

		expect(agent.peekFollowUpQueue()).toHaveLength(1);
	});

	it("claims an abortable busy state while continue() awaits dequeue hooks", async () => {
		const agent = new Agent();
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		agent.followUp({ role: "user", content: "stay queued", timestamp: Date.now() });
		const hookStarted = Promise.withResolvers<void>();
		agent.addBeforeQueuedMessageDequeueHook(async signal => {
			if (!signal) throw new Error("Expected continuation dequeue signal");
			hookStarted.resolve();
			if (signal.aborted) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		});

		const continuing = agent.continue();
		await hookStarted.promise;
		let idleResolved = false;
		const idle = agent.waitForIdle().then(() => {
			idleResolved = true;
		});
		await Promise.resolve();

		expect(agent.state.isStreaming).toBe(true);
		expect(idleResolved).toBe(false);
		await expect(agent.prompt("must not overlap")).rejects.toBeInstanceOf(AgentBusyError);

		agent.abort("cancel dequeue");
		await expect(continuing).rejects.toThrow("Cannot continue from message role: assistant");
		await idle;
		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.peekFollowUpQueue()).toHaveLength(1);
	});

	it("does not clear a successor prompt after continue() releases idle waiters", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { content: ["continued"] };
				},
				async () => {
					secondStarted.resolve();
					await releaseSecond.promise;
					return { content: ["successor"] };
				},
			],
		});
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		agent.followUp({ role: "user", content: "continue", timestamp: Date.now() });

		const continuing = agent.continue();
		await firstStarted.promise;
		const successor = agent.waitForIdle().then(() => agent.prompt("next prompt"));
		releaseFirst.resolve();
		await secondStarted.promise;
		await continuing;

		expect(agent.state.isStreaming).toBe(true);
		releaseSecond.resolve();
		await successor;
		expect(agent.state.isStreaming).toBe(false);
	});

	it("resolves a predecessor idle waiter when agent_end starts a successor", async () => {
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				{ content: ["first"] },
				async () => {
					secondStarted.resolve();
					await releaseSecond.promise;
					return { content: ["second"] };
				},
			],
		});
		const agent = new Agent({ streamFn: mock.stream });
		let successor: Promise<void> | undefined;
		agent.subscribe(event => {
			if (event.type === "agent_end" && !successor) {
				successor = agent.prompt("successor");
			}
		});

		const predecessor = agent.prompt("predecessor");
		let predecessorIdleResolved = false;
		void agent.waitForIdle().then(() => {
			predecessorIdleResolved = true;
		});
		await secondStarted.promise;
		await predecessor;
		expect(agent.state.isStreaming).toBe(true);

		releaseSecond.resolve();
		await successor;
		await Promise.resolve();
		expect(predecessorIdleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("classifies an in-flight continuation cancellation as aborted", async () => {
		const providerStarted = Promise.withResolvers<AbortSignal>();
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("Expected provider abort signal");
				providerStarted.resolve(signal);
				const stream = new AssistantMessageEventStream();
				signal.addEventListener("abort", () => stream.fail(new Error("provider aborted")), { once: true });
				return stream;
			},
		});
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		agent.followUp({ role: "user", content: "cancel this continuation", timestamp: Date.now() });
		const controller = new AbortController();

		const running = agent.continue(controller.signal);
		await providerStarted.promise;
		controller.abort("caller cancelled");
		await running;

		const finalMessage = agent.state.messages.at(-1);
		expect(finalMessage?.role).toBe("assistant");
		if (finalMessage?.role !== "assistant") throw new Error("Expected aborted assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("caller cancelled");
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
		let dequeueHooks = 0;
		const dequeueSignals: Array<AbortSignal | undefined> = [];
		agent.addBeforeQueuedMessageDequeueHook(signal => {
			dequeueHooks++;
			dequeueSignals.push(signal);
		});

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

		const controller = new AbortController();
		await expect(agent.continue(controller.signal)).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(mock.calls.length).toBe(2);
		expect(dequeueHooks).toBe(2);
		expect(dequeueSignals).toHaveLength(2);
		controller.abort();
		expect(dequeueSignals.every(signal => signal?.aborted === true)).toBe(true);
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

	it("prompt() emits assistant error lifecycle for provider stream failures", async () => {
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
	});

	it("pairs tool calls from failed partial streams with synthetic tool results", async () => {
		const mock = createMockModel({ responses: [] });
		const errorText = "connection reset after tool call";
		const toolCall = { type: "toolCall" as const, id: "tool-1", name: "alpha", arguments: { value: "hello" } };
		const started = createAssistantMessage([toolCall]);
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: started });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: started });
					stream.fail(new Error(errorText));
				});
				return stream;
			},
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe(event => events.push(event));

		await agent.prompt("trigger");
		unsubscribe();

		const toolResult = agent.state.messages.find(message => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "alpha",
			isError: true,
			details: {
				__synthetic: true,
				source: "assistant_stop_error",
				executed: false,
				upstreamError: errorText,
			},
		});

		const turnEnd = events.find(event => event.type === "turn_end");
		expect(turnEnd).toMatchObject({
			type: "turn_end",
			toolResults: [{ role: "toolResult", toolCallId: "tool-1", isError: true }],
		});
	});

	it("drops incomplete tool calls when a partial stream fails before toolcall_end", async () => {
		const mock = createMockModel({ responses: [] });
		const started = createAssistantMessage([{ type: "toolCall", id: "tool-1", name: "alpha", arguments: {} }]);
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: started });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: started });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"value":', partial: started });
					stream.fail(new Error("connection reset during tool arguments"));
				});
				return stream;
			},
		});

		await agent.prompt("trigger");

		const assistant = agent.state.messages.find(message => message.role === "assistant");
		expect(assistant?.content.some(block => block.type === "toolCall")).toBe(false);
		expect(agent.state.messages.some(message => message.role === "toolResult")).toBe(false);
	});

	it("preserves buffered Cursor results when a partial stream fails", async () => {
		const mock = createMockModel({ responses: [] });
		const errorText = "connection reset after Cursor exec";
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-tool-1",
			name: "shell",
			arguments: { command: "pwd" },
			[kCursorExecResolved]: true,
		};
		const started = createAssistantMessage([toolCall]);
		const realToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "/workspace" }],
			isError: false,
			timestamp: Date.now(),
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorOnToolResult: message => message,
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					await options?.cursorOnToolResult?.(realToolResult);
					stream.push({ type: "start", partial: started });
					stream.fail(new Error(errorText));
				});
				return stream;
			},
		});

		await agent.prompt("trigger");

		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "/workspace" }],
			isError: false,
		});
	});

	it("persists the transformed payload when the stream fails mid-transform", async () => {
		// The error drain snapshots the Cursor buffer just like the normal one, so
		// it needs the same await: a transformer still in flight when the provider
		// errors would otherwise patch an entry this path already detached, and
		// the original payload is persisted instead. A provider error is exactly
		// when a transform is most likely to be mid-flight.
		const mock = createMockModel({ responses: [] });
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-tool-err",
			name: "shell",
			arguments: { command: "pwd" },
			[kCursorExecResolved]: true,
		};
		const started = createAssistantMessage([toolCall]);
		const realToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "original" }],
			isError: false,
			timestamp: Date.now(),
		};
		// Held across the failure so the transform is guaranteed to still be
		// pending when the catch path runs.
		const gate = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorOnToolResult: async message => {
				await gate.promise;
				return { ...message, content: [{ type: "text" as const, text: "transformed" }] };
			},
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					// Fire-and-forget, exactly like the provider's data loop.
					void options?.cursorOnToolResult?.(realToolResult);
					stream.push({ type: "start", partial: started });
					stream.fail(new Error("connection reset mid-transform"));
				});
				return stream;
			},
		});

		const turn = agent.prompt("trigger");
		await Bun.sleep(0);
		gate.resolve();
		await turn;

		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			toolCallId: toolCall.id,
			content: [{ type: "text", text: "transformed" }],
		});
	});

	it("buffers a Cursor result even with neither exec handlers nor a transformer", async () => {
		// Both options are optional, but the Cursor provider resolves its native
		// tools server-side regardless and marks those blocks
		// `kCursorExecResolved`, so `agent-loop.ts` emits no placeholder for them.
		// Without a result sink the provider's own fallback result is dropped and
		// the assistant block is left unpaired — `buildSessionContext` then strips
		// the whole interaction on replay.
		const mock = createMockModel({ responses: [] });
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-tool-bare",
			name: "todo",
			arguments: { todos: [] },
			[kCursorExecResolved]: true,
		};
		const started = createAssistantMessage([toolCall]);
		const realToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "Todo snapshot not mirrored" }],
			isError: false,
			timestamp: Date.now(),
		};
		// No `cursorExecHandlers`, no `cursorOnToolResult` — a bare SDK host.
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					void options?.cursorOnToolResult?.(realToolResult);
					stream.push({ type: "start", partial: started });
					stream.push({ type: "done", reason: "stop", message: started });
				});
				return stream;
			},
		});

		await agent.prompt("trigger");

		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: toolCall.id, toolName: toolCall.name });
	});

	it("keeps the reserved result when the transformer rejects", async () => {
		// `cursorOnToolResult` is a supported option returning a Promise, and the
		// provider dispatches decoded messages with `void handleServerMessage(...)`.
		// The drain awaits a pending transformer, so a REJECTING one must not
		// take the turn down with it or cost the result: an unbuffered toolResult
		// leaves its toolCall block unpaired and the transcript rebuild strips it
		// as dangling. The reserved (pre-transform) payload stands in.
		const mock = createMockModel({ responses: [] });
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-tool-slow",
			name: "shell",
			arguments: { command: "pwd" },
			[kCursorExecResolved]: true,
		};
		const started = createAssistantMessage([toolCall]);
		const realToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "/workspace" }],
			isError: false,
			timestamp: Date.now(),
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorOnToolResult: async () => {
				throw new Error("transformer blew up");
			},
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					// Fire-and-forget, exactly like the provider's data loop.
					void options?.cursorOnToolResult?.(realToolResult);
					stream.push({ type: "start", partial: started });
					stream.push({ type: "done", reason: "stop", message: started });
				});
				return stream;
			},
		});

		await agent.prompt("trigger");

		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "/workspace" }],
		});
	});

	it("persists the transformed payload when the transformer resolves after message_end", async () => {
		// The transformer is awaited by the provider's fire-and-forget dispatch,
		// so `message_end` decoded from the same chunk can reach the drain while
		// it is still pending. Buffering the call is not enough: a transformer
		// that actually rewrites the result must have that rewrite persisted,
		// exactly like the awaited exec-channel paths. Otherwise the customized
		// payload is silently replaced by the original in this timing window.
		const mock = createMockModel({ responses: [] });
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-tool-late",
			name: "shell",
			arguments: { command: "pwd" },
			[kCursorExecResolved]: true,
		};
		const started = createAssistantMessage([toolCall]);
		const realToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "original" }],
			isError: false,
			timestamp: Date.now(),
		};
		// Deterministic race, no wall-clock delay. The transformer blocks on a
		// gate this test holds open across the whole stream, so it is guaranteed
		// to still be unresolved when `message_end` reaches the drain. The gate
		// is released only after `prompt()` has been started and has had a chance
		// to run to the drain — a drain that does not await the transformer will
		// already have persisted the original payload by then.
		//
		// Gating on the `message_end` event instead would deadlock: that event is
		// emitted from inside the drain that now waits on this promise.
		const gate = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorOnToolResult: async message => {
				await gate.promise;
				return { ...message, content: [{ type: "text" as const, text: "transformed" }] };
			},
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					// Fire-and-forget, exactly like the provider's data loop: the
					// transformer is still pending when the stream closes below.
					void options?.cursorOnToolResult?.(realToolResult);
					stream.push({ type: "start", partial: started });
					stream.push({ type: "done", reason: "stop", message: started });
				});
				return stream;
			},
		});

		const turn = agent.prompt("trigger");
		// Let the stream drain as far as it can while the transformer is blocked.
		// An unawaited drain finishes the turn here, with the original payload.
		for (let i = 0; i < 50; i++) await Promise.resolve();
		gate.resolve();
		await turn;

		const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			toolCallId: toolCall.id,
			content: [{ type: "text", text: "transformed" }],
		});
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
		const toolSchema = type({ value: type("string") });
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
		let beforeModelCalls = 0;
		agent.addBeforeModelCallHook(() => {
			beforeModelCalls++;
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
		expect(beforeModelCalls).toBe(2);
	});

	it("prompt() drops stale forced toolChoice after same-turn tool refresh", async () => {
		const toolSchema = type({ value: type("string") });
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
		const toolSchema = type({ value: type("string") });
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
		const toolSchema = type({ value: type("string") });
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
		const toolSchema = type({ value: type("string") });
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
		const toolSchema = type({ value: type("string") });
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
