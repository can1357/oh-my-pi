/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError, type AgentMessage, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, Message, ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async";
import type { Rule } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { TtsrManager } from "@pk-nerdsaver-ai/pi-coding-agent/export/ttsr";
import type { ExtensionRunner } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

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

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

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
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (abortSignal) {
						abortSignal.addEventListener(
							"abort",
							() => {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		return session;
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(1);
		}

		throw new Error("Timed out waiting for condition");
	}

	it("should throw when prompt() called while streaming", async () => {
		await createSession();

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = session.prompt("First message");

		await waitFor(() => session.isStreaming);

		// Second prompt should reject
		await expect(session.prompt("Second message")).rejects.toBeInstanceOf(AgentBusyError);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should allow steer() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		// steer should work while streaming
		await session.steer("Steer while streaming");
		expect(session.queuedMessageCount).toBe(1);

		// Cleanup
		session.agent.clearAllQueues();
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow followUp() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		// followUp should work while streaming
		await session.followUp("Follow-up while streaming");
		expect(session.queuedMessageCount).toBe(1);

		// Cleanup
		session.agent.clearAllQueues();
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("delivers hidden nextTurn stop reactions through the next LLM call without exposing them in the visible queue", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let firstStream: AssistantMessageEventStream | undefined;
		const callMessages: Message[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callMessages.length > 1) {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Resumed") });
						return;
					}
				});
				firstStream = stream;
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming && firstStream !== undefined && callMessages.length === 1);

		await session.sendCustomMessage(
			{
				customType: "autoresearch-resume",
				content: "Hidden stop reaction",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		expect(session.queuedMessageCount).toBe(0);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		firstStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
		await firstPrompt;
		await session.waitForIdle();

		expect(callMessages).toHaveLength(2);
		expect(
			callMessages[1]?.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Hidden stop reaction");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Hidden stop reaction"),
				);
			}),
		).toBe(true);
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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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

	it("does not continue session_stop feedback after aborting a slow hook", async () => {
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
		const stopHook = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		const emitSessionStop = vi.fn(() => (emitSessionStop.mock.calls.length === 1 ? stopHook.promise : undefined));
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop,
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const promptPromise = session.prompt("First message");
		await waitFor(() => emitSessionStop.mock.calls.length === 1);
		const abortPromise = session.abort();
		stopHook.resolve({ continue: true, additionalContext: "Should not run after abort." });

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-idle-followup.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-idle-followup.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
	it("subscriber may prompt() synchronously from agent_end without AgentBusyError", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const observedIsStreamingAtAgentEnd: boolean[] = [];
		const reentrantPromptResults: Array<"resolved" | { error: string }> = [];
		let reentrantPrompted = false;

		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			observedIsStreamingAtAgentEnd.push(session.isStreaming);
			if (reentrantPrompted) return;
			reentrantPrompted = true;
			void session
				.prompt("Second message")
				.then(() => reentrantPromptResults.push("resolved"))
				.catch((err: Error) => reentrantPromptResults.push({ error: err.message }));
		});

		await session.prompt("First message");
		await waitFor(() => reentrantPromptResults.length > 0, 2000);
		await session.waitForIdle();

		expect(observedIsStreamingAtAgentEnd).not.toContain(true);
		expect(reentrantPromptResults).toEqual(["resolved"]);
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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-idle.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-idle.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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

	it("runs drained ACP async completions as owned follow-up turns despite deferred client turns", async () => {
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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-async.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-async.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const ownerId = "acp-session-a";
		const deliveryGate = Promise.withResolvers<void>();
		let deliveryStarted = false;
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 2,
			retentionMs: 1_000,
			onJobComplete: async () => {
				deliveryStarted = true;
				await deliveryGate.promise;
				await session.sendCustomMessage(
					{
						customType: "async-result",
						content: "Background result",
						display: true,
						attribution: "agent",
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: ownerId,
			ownedAsyncJobManager: asyncJobManager,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		try {
			asyncJobManager.register("bash", "owned job", async () => "Background result", {
				id: "owned-job",
				ownerId,
			});
			await waitFor(() => deliveryStarted);

			const drainedPromise = session.drainAsyncJobDeliveriesForAcp({ timeoutMs: 1_000 });
			await waitFor(() => asyncJobManager.getDeliveryState({ ownerId }).delivering);
			deliveryGate.resolve();

			await expect(drainedPromise).resolves.toBe(true);
			await session.waitForIdle();

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
		} finally {
			deliveryGate.resolve();
		}
	});

	it("scopes ACP async job snapshots and drains to the owning session id", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-acp-scope.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models-acp-scope.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated();
		const deliveryGate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const started = new Set<string>();
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 3,
			retentionMs: 1_000,
			onJobComplete: async jobId => {
				started.add(jobId);
				if (jobId === "job-a") {
					await deliveryGate.promise;
				}
				delivered.push(jobId);
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const agentA = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const agentB = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const sessionB = new AgentSession({
			agent: agentB,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-b",
			asyncJobManager,
		});
		session = new AgentSession({
			agent: agentA,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-a",
			ownedAsyncJobManager: asyncJobManager,
		});

		try {
			asyncJobManager.register("bash", "A", async () => "A", { id: "job-a", ownerId: "acp-session-a" });
			await waitFor(() => started.has("job-a"));
			asyncJobManager.register("bash", "B", async () => "B", { id: "job-b", ownerId: "acp-session-b" });
			await waitFor(() => asyncJobManager.getDeliveryState({ ownerId: "acp-session-b" }).queued > 0);

			expect(sessionB.getAsyncJobSnapshot()?.delivery.pendingJobIds).not.toContain("job-a");
			await expect(sessionB.drainAsyncJobDeliveriesForAcp({ timeoutMs: 1_000 })).resolves.toBe(true);
			expect(delivered).toEqual(["job-b"]);
		} finally {
			deliveryGate.resolve();
			await sessionB.dispose();
		}
	});
});

describe("AgentSession TTSR resume gate", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ttsr-gate-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
	});

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(1);
		}

		throw new Error("Timed out waiting for condition");
	}
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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-int.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-abort-reason.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-rel.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-def.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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

	it("prompt() returns immediately when session is aborted during TTSR wait", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

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
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				queueMicrotask(() => {
					const partial = makeMsg("");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "result.unwrap(",
						partial: makeMsg("result.unwrap("),
					});
					if (signal) {
						signal.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: makeMsg("result.unwrap(", "aborted"),
								});
							},
							{ once: true },
						);
					}
				});

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-abt.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// Start prompt (will trigger TTSR and create resume gate)
		const promptPromise = session.prompt("Write some Rust code");
		await waitFor(() => session.isStreaming);

		// Abort session — prompt() should unblock
		await session.abort();
		await promptPromise;

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-tool.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-never-tool.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-dup.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

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
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth-promo.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		let streamCallCount = 0;
		let continuationCompleted = false;

		const makeOverflowMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: sparkModel.api,
			provider: sparkModel.provider,
			model: sparkModel.id,
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
			api: codexModel.api,
			provider: codexModel.provider,
			model: codexModel.id,
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
			initialState: { model: sparkModel, systemPrompt: ["Test"], tools: [] },
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
		expect(session.model?.id).toBe(codexModel.id);
		expect(session.isStreaming).toBe(false);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});
