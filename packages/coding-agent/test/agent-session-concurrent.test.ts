/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, shouldRenderAbortReason } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Mock stream that mimics AssistantMessageEventStream

// AgentSession schedules its TTSR retry and context-promotion continuations
// through `scheduler.wait(delayMs, { signal })` (node:timers/promises), with
// blind 50ms/100ms "settle" delays. Tests that drive a continuation to
// completion would otherwise pay that wall-clock time on every run. This spy
// collapses the blind delay to a single macrotask hop (`scheduler.wait(0)`)
// while preserving the real abort-signal semantics, so the continuation still
// fires only after the aborted/overflowed turn has been recorded. Each test
// that opts in must run inside a block whose afterEach restores mocks.
const originalSchedulerWait = scheduler.wait.bind(scheduler);
function collapseSchedulerSettleDelays(): void {
	vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
}
let sharedDir: string;
let sharedAuthStorage: AuthStorage;
let sharedModelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = path.join(os.tmpdir(), `pi-concurrent-shared-${Snowflake.next()}`);
	fs.mkdirSync(sharedDir, { recursive: true });
	sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
	sharedAuthStorage.setRuntimeApiKey("openai-codex", "test-key");
	sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
});

afterAll(() => {
	sharedAuthStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		// Collapse scheduler settle delays so the post-abort auto-continue and
		// dispose teardown are deterministic instead of racing the wall clock.
		collapseSchedulerSettleDelays();
		tempDir = path.join(os.tmpdir(), `pi-concurrent-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("continues a main session from session_stop feedback before settling", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const stopEvents: Array<{
			messages: AgentMessage[];
			stop_hook_active: boolean;
			session_id: string;
			turn_id: number;
			last_assistant_message?: AgentMessage;
		}> = [];
		const eventOrder: string[] = [];
		const extensionRunner = {
			emit: vi.fn(event => {
				eventOrder.push(event.type);
				return Promise.resolve(undefined);
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(event => {
				eventOrder.push("session_stop");
				stopEvents.push(event);
				if (stopEvents.length === 1) {
					return Promise.resolve({ continue: true, additionalContext: "Mission incomplete; continue." });
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		const callMessages = mock.calls.map(call => call.context.messages);
		expect(callMessages).toHaveLength(2);
		expect(
			callMessages[1]?.some(message =>
				typeof message.content === "string"
					? message.content.includes("Mission incomplete; continue.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("Mission incomplete; continue."),
						),
			),
		).toBe(true);
		expect(eventOrder.filter(type => type === "session_stop" || type === "agent_end")).toEqual([
			"session_stop",
			"agent_end",
			"session_stop",
			"agent_end",
		]);
		expect(stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
		expect(stopEvents.map(event => event.turn_id)).toEqual([0, 0]);
		expect(stopEvents[0]?.session_id).toBe(session.sessionId);
		expect(stopEvents[0]?.last_assistant_message?.role).toBe("assistant");
		expect(
			stopEvents[1]?.messages.some(
				message =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "text" && block.text === "First message"),
			),
		).toBe(true);
	});

	it("reports streaming while a tool is still executing", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blockingTool: AgentTool = {
			name: "blocking_tool",
			label: "Blocking Tool",
			description: "Waits until the test releases it",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		};
		let streamCall = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [blockingTool] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const toolTurn = ++streamCall === 1;
				queueMicrotask(() => {
					const message: AssistantMessage = toolTurn
						? {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "call-blocking",
										name: "blocking_tool",
										arguments: {},
									},
								],
								api: "anthropic-messages",
								provider: "anthropic",
								model: model.id,
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
							}
						: {
								role: "assistant",
								content: [{ type: "text", text: "finished" }],
								api: "anthropic-messages",
								provider: "anthropic",
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
							};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});

		const prompt = session.prompt("Run the blocking tool");
		await started.promise;

		// `UiHelpers.renderInitialMessages` uses this exact predicate to retain
		// dangling toolCalls in pendingTools during a focus rebuild.
		expect(session.isStreaming).toBe(true);

		release.resolve();
		await prompt;
		expect(session.isStreaming).toBe(false);
	});

	it("uses non-empty session_stop reason when additional context is empty", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		let stopCount = 0;
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => {
				stopCount++;
				if (stopCount === 1) {
					return Promise.resolve({
						continue: true,
						additionalContext: "",
						reason: "Continue from fallback reason.",
					});
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("Continue from fallback reason.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("Continue from fallback reason."),
						),
			),
		).toBe(true);
	});

	it("does not emit session_stop when abort starts before the settle pass", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const settleGate = Promise.withResolvers<void>();
		const settleReached = Promise.withResolvers<void>();
		const emitSessionStop = vi.fn().mockResolvedValue(undefined);
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop,
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		vi.spyOn(session.goalRuntime, "onAgentEnd").mockImplementation(() => {
			settleReached.resolve();
			return settleGate.promise;
		});

		const promptPromise = session.prompt("First message");
		await settleReached.promise;
		const abortPromise = session.abort();
		settleGate.resolve();

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

		expect(emitSessionStop).not.toHaveBeenCalled();
	});

	it("cancels an active session_stop pass without applying stale continuation feedback", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const stopStarted = Promise.withResolvers<void>();
		const stopHook = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		let firstStopSignal: AbortSignal | undefined;
		let stopCount = 0;
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_stop", event => {
					stopCount++;
					if (stopCount !== 1) return;
					firstStopSignal = event.signal;
					stopStarted.resolve();
					return stopHook.promise;
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"slow-session-stop",
		);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		const extensionErrors: string[] = [];
		extensionRunner.onError(error => extensionErrors.push(error.error));

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const promptPromise = session.prompt("First message");
		await stopStarted.promise;
		let abortSettled = false;
		const abortPromise = session.abort().then(() => {
			abortSettled = true;
		});
		await scheduler.yield();
		const abortSettledBeforeHandler = abortSettled;
		const signalWasCancelled = firstStopSignal?.aborted;
		stopHook.resolve({ continue: true, additionalContext: "Should not run after abort." });

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

		expect(abortSettledBeforeHandler).toBe(true);
		expect(signalWasCancelled).toBe(true);
		expect(extensionErrors).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(session.queuedMessageCount).toBe(0);

		await session.prompt("Second message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("Should not run after abort.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("Should not run after abort."),
						),
			),
		).toBe(false);
	});

	it("caps consecutive session_stop continuations at eight", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Pass"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => Promise.resolve({ decision: "block" as const, reason: "Run another pass." })),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(9);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(9);
	});

	it("emits session_stop only after empty-stop recovery reaches a final stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [""] }, { content: ["Recovered"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("emits session_stop after empty-stop retry cap settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [""] }, { content: [""] }, { content: [""] }, { content: [""] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("continues session_stop feedback in ACP sessions with deferred client turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		let stopCount = 0;
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => {
				stopCount++;
				if (stopCount === 1) {
					return Promise.resolve({ continue: true, additionalContext: "ACP stop continuation." });
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("ACP stop continuation.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("ACP stop continuation."),
						),
			),
		).toBe(true);
	});

	it("does not emit session_stop for subagent sessions", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Subagent done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			agentKind: "sub",
		});

		await session.prompt("Subagent message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(extensionRunner.emit).toHaveBeenCalledWith({ type: "agent_end", messages: expect.any(Array) });
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// First prompt completes
		await session.prompt("First message");

		// Should not be streaming anymore
		expect(session.isStreaming).toBe(false);

		// Second prompt should work
		await expect(session.prompt("Second message")).resolves.toBe(true);
	});
	it("queues extension follow-up user messages on an idle session without starting a turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		await session.sendUserMessage("hello from session_start", { deliverAs: "followUp" });

		expect(mock.calls).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(1);
	});

	// Regression: a subscriber that fires the next prompt synchronously from the
	// agent_end listener (the shape every wire transport ends up in — rpc-mode
	// stdout subscriber, ACP bridge, Cursor exec) must not collide with the
	// outgoing turn's still-unwinding in-flight bookkeeping. Before the wire-level
	// agent_end was deferred until #promptInFlightCount drops to 0, the
	// subscriber observed agent_end while Session.isStreaming was still true (the
	// agent's own `isStreaming` had flipped, but #promptWithMessage's finally had
	// not yet decremented the prompt-in-flight counter), and the next prompt
	// threw AgentBusyError. Surfaced as `RpcCommandError: prompt: Agent is
	// already processing` from omp-rpc clients (robomp triage reminder path).

	it("does not let extension notifications block public agent_end", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const { promise: extensionGate, resolve: releaseExtension } = Promise.withResolvers<void>();
		const extensionRunner = {
			emit: vi.fn((event: { type: string }) =>
				event.type === "agent_end" ? extensionGate : Promise.resolve(undefined),
			),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const { promise: publicAgentEnd, resolve: onPublicAgentEnd } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") onPublicAgentEnd();
		});

		await session.prompt("First message");
		await publicAgentEnd;
		expect(extensionRunner.emit).toHaveBeenCalledWith({ type: "agent_end", messages: expect.any(Array) });

		releaseExtension();
		await session.waitForIdle();
	});

	it("queues idle ACP client-triggered custom messages instead of starting an ownerless turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		await session.sendCustomMessage(
			{
				customType: "async-result",
				content: "Background result",
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		expect(mock.calls).toHaveLength(callsAfterFirstPrompt);
		expect(session.isStreaming).toBe(false);

		await session.prompt("Next user prompt");
		await session.dispose();
		session = undefined as unknown as AgentSession;
		expect(mock.calls).toHaveLength(callsAfterFirstPrompt + 1);
		expect(
			mock.calls.at(-1)?.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Background result");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Background result"),
				);
			}),
		).toBe(true);
	});
});

describe("AgentSession TTSR resume gate", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ttsr-gate-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
	});

	const testRule: Rule = {
		name: "no-unwrap",
		path: "/tmp/no-unwrap.md",
		content: "Do not use .unwrap()",
		condition: ["\\.unwrap\\("],
		_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
	};

	function makeMsg(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		};
	}

	function pushContinuationStream(stream: AssistantMessageEventStream, onComplete: () => void): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			onComplete();
			stream.push({
				type: "done",
				reason: "stop",
				message: makeMsg('Fixed: let val = result.expect("msg")'),
			});
		});
	}

	function pushAbortableTtsrStream(stream: AssistantMessageEventStream, signal: AbortSignal | undefined): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "let val = result.unwrap(",
				partial: makeMsg("let val = result.unwrap("),
			});
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeMsg("let val = result.unwrap(", "aborted"),
						});
					},
					{ once: true },
				);
			}
		});
	}

	it("prompt() blocks until TTSR interrupt continuation completes", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else {
					// Continuation stream: complete normally after a delay
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("marks extension agent_end willContinue for TTSR abort and not ordinary abort", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const extensionEmits: Array<{ type: string; willContinue?: boolean }> = [];
		const continuationStarted = Promise.withResolvers<void>();

		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					pushAbortableTtsrStream(stream, signal);
				} else {
					pushContinuationStream(stream, () => continuationStarted.resolve());
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const modelRegistry = sharedModelRegistry;
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => {
					extensionEmits.push({ type: event.type, willContinue: event.willContinue });
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"capture-agent-end",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			modelRegistry,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
			extensionRunner,
		});

		const firstGoalEndStarted = Promise.withResolvers<void>();
		const releaseFirstGoalEnd = Promise.withResolvers<void>();
		let goalEndCalls = 0;
		vi.spyOn(GoalRuntime.prototype, "onAgentEnd").mockImplementation(async () => {
			goalEndCalls++;
			if (goalEndCalls !== 1) return;
			firstGoalEndStarted.resolve();
			await releaseFirstGoalEnd.promise;
		});

		const ttsrPrompt = session.prompt("Write some Rust code");
		await firstGoalEndStarted.promise;
		await continuationStarted.promise;
		const pendingClearedWhileMaintenanceBlocked = !session.isTtsrAbortPending;
		releaseFirstGoalEnd.resolve();
		await ttsrPrompt;
		await session.waitForIdle();
		expect(pendingClearedWhileMaintenanceBlocked).toBe(true);

		const ttsrEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		// Intermediate TTSR-abort settle continues; terminal settle after retry does not.
		expect(ttsrEnds.length).toBeGreaterThanOrEqual(2);
		expect(ttsrEnds[0]?.willContinue).toBe(true);
		expect(ttsrEnds.slice(1, -1).every(event => !event.willContinue)).toBe(true);
		expect(ttsrEnds.at(-1)?.willContinue).toBeFalsy();

		extensionEmits.length = 0;
		const ordinaryAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				queueMicrotask(() => {
					const partial = makeMsg("partial");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "partial",
						partial: makeMsg("partial"),
					});
					queueMicrotask(() => {
						session?.agent.abort("user cancelled");
					});
					if (signal) {
						signal.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: makeMsg("partial", "aborted"),
								});
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});
		await session.dispose();
		session = new AgentSession({
			agent: ordinaryAgent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		const promptPromise = session.prompt("user will cancel");
		await session.waitForIdle();
		await promptPromise.catch(() => undefined);

		const ordinaryEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(ordinaryEnds.length).toBeGreaterThanOrEqual(1);
		for (const event of ordinaryEnds) {
			expect(event.willContinue).toBeFalsy();
		}
	});

	it("labels aborted tool placeholders with the TTSR rule reason", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_ttsr_abort_reason",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap(" },
		};

		const makeToolCallMsg = (stopReason: "toolUse" | "aborted" = "toolUse"): AssistantMessage => ({
			role: "assistant",
			content: [toolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						if (signal) {
							signal.addEventListener(
								"abort",
								() => {
									stream.push({
										type: "error",
										reason: "aborted",
										error: makeToolCallMsg("aborted"),
									});
								},
								{ once: true },
							);
						}
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						// The TTSR abort placeholder is only minted for tool calls that reached
						// `toolcall_end`: the agent loop drops incomplete tool calls from an
						// aborted turn (partial args are unsafe to replay). Complete the call
						// before the rule-driven abort fires so the labeled placeholder survives.
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCallContent, partial });
					});
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const toolResult = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolCallContent.id,
			);
		expect(toolResult?.type).toBe("message");
		const text =
			toolResult?.type === "message" && toolResult.message.role === "toolResult"
				? (toolResult.message.content.find((part): part is { type: "text"; text: string } => part.type === "text")
						?.text ?? "")
				: "";
		expect(text).toContain("Tool execution was aborted: TTSR matched rule: no-unwrap");
		expect(text).not.toContain("Request was aborted");

		// The persisted aborted assistant turn must not render as an error on
		// resume/`/tree`/rebuild: TTSR interruption is control flow, so AgentSession
		// stamps the SilentAbort flag and `shouldRenderAbortReason` returns false.
		const abortedAssistant = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			);
		expect(abortedAssistant?.type).toBe("message");
		if (abortedAssistant?.type === "message" && abortedAssistant.message.role === "assistant") {
			expect(shouldRenderAbortReason(abortedAssistant.message)).toBe(false);
		}
	});

	it("labels only the matching aborted tool placeholder with the TTSR rule reason", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const readToolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_innocent_read",
			name: "read",
			arguments: { path: "history://Eval1WithSkill" },
		};
		const matchedToolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_ttsr_abort_reason",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap(" },
		};

		const makeToolCallMsg = (stopReason: "toolUse" | "aborted" = "toolUse"): AssistantMessage => ({
			role: "assistant",
			content: [readToolCallContent, matchedToolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						if (signal) {
							signal.addEventListener(
								"abort",
								() => {
									stream.push({
										type: "error",
										reason: "aborted",
										error: makeToolCallMsg("aborted"),
									});
								},
								{ once: true },
							);
						}
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 1, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 1,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						// The abort placeholder is only minted for tool calls that reached
						// `toolcall_end`: the agent loop drops incomplete tool calls from an
						// aborted turn (partial args are unsafe to replay). Complete the
						// innocent read before the rule-driven abort fires so its placeholder
						// survives and can carry the neutral sibling label.
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: readToolCallContent, partial });
					});
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const toolResults = sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
			.map(entry => (entry.type === "message" && entry.message.role === "toolResult" ? entry.message : undefined))
			.filter(message => message !== undefined);
		const toolResultText = (toolCallId: string): string =>
			toolResults
				.find(message => message.toolCallId === toolCallId)
				?.content.find((part): part is { type: "text"; text: string } => part.type === "text")?.text ?? "";

		const readText = toolResultText(readToolCallContent.id);
		expect(readText).toContain("Tool execution was aborted: TTSR interrupt on another tool call");
		expect(readText).not.toContain("TTSR matched rule: no-unwrap");
		// The matching call never reached `toolcall_end`, so the loop drops it from
		// the aborted turn (partial args are unsafe to replay) and no placeholder is
		// minted. The rule label for a completed matching call is covered by the
		// single-call test above.
		expect(toolResultText(matchedToolCallContent.id)).toBe("");
	});

	it("relativizes the rule file path in the TTSR interrupt injection (no absolute leak)", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const sessionManager = SessionManager.inMemory();
		const cwd = sessionManager.getCwd();
		const ruleAbsPath = path.join(cwd, ".omp", "rules", "no-unwrap.md");
		const expectedRel = path.relative(cwd, ruleAbsPath);
		const rule: Rule = {
			name: "no-unwrap",
			path: ruleAbsPath,
			content: "Do not use .unwrap()",
			condition: ["\\.unwrap\\("],
			_source: { provider: "test", providerName: "test", path: ruleAbsPath, level: "project" },
		};

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(rule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					pushAbortableTtsrStream(stream, options?.signal);
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const injection = sessionManager
			.getEntries()
			.find(e => e.type === "custom_message" && e.customType === "ttsr-injection");
		expect(injection?.type).toBe("custom_message");
		const content = injection?.type === "custom_message" ? injection.content : undefined;
		expect(typeof content).toBe("string");
		const text = content as string;
		// The rendered interrupt the model receives references the rule by a
		// project-relative path, never the absolute home path.
		expect(text).toContain('reason="rule_violation"');
		expect(text).toContain(`path="${expectedRel}"`);
		expect(text).not.toContain(ruleAbsPath);
	});

	it("prompt() blocks until TTSR deferred continuation completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		// interruptMode: "never" -> TTSR match queues deferred injection instead of aborting
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, _options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();

				if (streamCallCount === 1) {
					// First stream: emit matching text and complete normally
					queueMicrotask(() => {
						const partial = makeMsg("");
						stream.push({ type: "start", partial });
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: "let val = result.unwrap(",
							partial: makeMsg("let val = result.unwrap("),
						});
						// Complete normally (no abort) -- deferred path
						stream.push({
							type: "done",
							reason: "stop",
							message: makeMsg("let val = result.unwrap()"),
						});
					});
				} else {
					// Continuation stream after deferred TTSR injection
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the deferred TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the deferred continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("prompt() waits for TTSR continuation with tool calls to finish", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecutionFinished = false;
		let allTurnsCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({}),
			execute: async () => {
				toolExecutionFinished = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_test_001",
			name: "mock_edit",
			arguments: {},
		};

		function makeToolCallMsg(): AssistantMessage {
			return {
				role: "assistant",
				content: [toolCallContent],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
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
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else if (streamCallCount === 2) {
					// Continuation: return assistant message with a tool call
					queueMicrotask(() => {
						const msg = makeToolCallMsg();
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					});
				} else {
					// After tool execution: return final response
					queueMicrotask(() => {
						allTurnsCompleted = true;
						const msg = makeMsg('Fixed: let val = result.expect("msg")');
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation (including tool execution) completes.
		// Before the fix, prompt() returned after the continuation's first assistant message_end,
		// while the agent was still executing tool calls in the background.
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, ALL turns must have completed
		expect(toolExecutionFinished).toBe(true);
		expect(allTurnsCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(3);
		expect(session.isStreaming).toBe(false);
	});
	it("interruptMode never folds tool-match reminder into the toolResult instead of driving an extra turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecuted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({ snippet: "string?" }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_never_001",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap()" },
		};

		const makeToolCallMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
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
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					// Emit a tool call whose argument delta matches the TTSR rule.
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCallContent, partial });
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					// Continuation after tool result; finish cleanly.
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		// Tool ran (no interrupt) and the loop didn't spawn an extra follow-up turn for injection.
		expect(toolExecuted).toBe(true);
		expect(streamCallCount).toBe(2);

		// The matched tool's result must carry the in-band reminder.
		const toolResult = agent.state.messages.find(
			(m): m is Extract<typeof m, { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === toolCallContent.id,
		);
		expect(toolResult).toBeDefined();
		const text = Array.isArray(toolResult?.content)
			? toolResult.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("\n")
			: "";
		expect(text).toContain("<system-reminder");
		expect(text).toContain('rule="no-unwrap"');
		expect(text).toContain("Do not use .unwrap()");
		expect(text.indexOf("<system-reminder")).toBeLessThan(text.indexOf("edit applied"));
	});

	it("interruptMode never deduplicates the reminder across sibling tool calls in one batch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let executedCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({ snippet: "string?" }),
			execute: async () => {
				executedCount++;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallA: ToolCall = {
			type: "toolCall",
			id: "call_dup_A",
			name: "mock_edit",
			arguments: { snippet: "a.unwrap()" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: "call_dup_B",
			name: "mock_edit",
			arguments: { snippet: "b.unwrap()" },
		};
		const toolCallC: ToolCall = {
			type: "toolCall",
			id: "call_dup_C",
			name: "mock_edit",
			arguments: { snippet: "c.unwrap()" },
		};

		const makeBatchMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallA, toolCallB, toolCallC],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
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
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeBatchMsg();
						stream.push({ type: "start", partial });
						const calls: ToolCall[] = [toolCallA, toolCallB, toolCallC];
						for (let i = 0; i < calls.length; i++) {
							const call = calls[i]!;
							stream.push({ type: "toolcall_start", contentIndex: i, partial });
							stream.push({
								type: "toolcall_delta",
								contentIndex: i,
								delta: `let val = result.unwrap("oops-${call.id}")`,
								partial,
							});
							stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial });
						}
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		expect(executedCount).toBe(3);
		const toolResults = agent.state.messages.filter(
			(m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(3);
		const withReminder = toolResults.filter(r =>
			Array.isArray(r.content)
				? r.content.some(c => c.type === "text" && c.text.includes("<system-reminder"))
				: false,
		);
		expect(withReminder).toHaveLength(1);
	});

	it("prompt() waits for context-promotion continuation to finish", async () => {
		collapseSchedulerSettleDelays();
		const authStorage = sharedAuthStorage;
		// The bundled catalog has no codex model whose promotion target carries a
		// strictly larger window (gpt-5.5's bundled target gpt-5.4 is same-window),
		// so pin gpt-5.5 (272k) -> gpt-5.6-sol (372k) via modelOverrides.
		const modelsConfigPath = path.join(tempDir, "models-promo.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-5.5": { contextPromotionTarget: "openai-codex/gpt-5.6-sol" },
						},
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const smallModel = modelRegistry.find("openai-codex", "gpt-5.5");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-sol");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		let streamCallCount = 0;
		let continuationCompleted = false;

		const makeOverflowMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: smallModel.api,
			provider: smallModel.provider,
			model: smallModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "context_length_exceeded: Your input exceeds the context window of this model.",
			timestamp: Date.now(),
		});

		const makeSuccessMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "Recovered after promotion" }],
			api: largeModel.api,
			provider: largeModel.provider,
			model: largeModel.id,
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

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: smallModel, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const message = makeOverflowMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
					});
				} else {
					queueMicrotask(() => {
						continuationCompleted = true;
						const message = makeSuccessMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
				}
				return stream;
			},
		});

		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": true }),
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Handle overflow");

		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.model?.id).toBe(largeModel.id);
		expect(session.isStreaming).toBe(false);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});
