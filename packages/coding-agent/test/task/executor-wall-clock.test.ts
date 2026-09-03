import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Contract: when `task.maxRuntimeMs` is set, a subagent whose inference call
 * never resolves (provider stream hang the watchdog couldn't catch) MUST be
 * aborted within ~maxRuntimeMs and surface a clear "runtime limit exceeded"
 * reason — not a generic "Cancelled by caller" — so on-call engineers don't
 * mistake it for a user cancellation.
 *
 * Without this defense, the executor's `await session.waitForIdle()` waits
 * indefinitely (see session 019e2b4d-fa25-7000-a725-955278e9b293, subagent 7,
 * which stayed silent for ~2 hours).
 */

interface HangingSessionHandle {
	session: AgentSession;
	abortCalls: () => number;
}

function createHangingSession(): HangingSessionHandle {
	let abortCount = 0;
	const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
	const session: Partial<AgentSession> = {
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: {
			appendSessionInit: () => {},
		} as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_names: string[]) => {},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await hang;
			return true;
		},
		waitForIdle: async () => {
			await hang;
		},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {
			abortCount += 1;
			releaseHang();
		},
		dispose: async () => {},
	};
	return {
		session: session as AgentSession,
		abortCalls: () => abortCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

describe("runSubprocess wall clock (task.maxRuntimeMs)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-walltime",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};

	it("aborts a stalled subagent and surfaces a runtime-limit reason", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const handle = createHangingSession();
		mockCreateAgentSession(handle.session);

		const startedAt = Date.now();
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-timeout",
			settings,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=50");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		// Sanity: must finish in roughly the configured window (allow generous slack
		// for CI; the contract is "doesn't hang for hours", not "exactly 50 ms").
		expect(elapsedMs).toBeLessThan(10_000);
	});

	it("does not abort early when the runtime budget is unlimited", async () => {
		// Stub session resolves immediately to a no-op yield so we don't actually
		// hang; we only need to assert that NO timeout fires when maxRuntimeMs=0.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const fastSession: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				// Fire a synthetic yield on the next tick to drive runSubprocess to
				// completion without depending on the real agent loop.
				queueMicrotask(() => {
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-fast",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				return () => {};
			},
			prompt: async () => true,
			waitForIdle: async () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			abort: async () => {},
			dispose: async () => {},
		};
		mockCreateAgentSession(fastSession as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-no-limit",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
	});

	it("aborts before prompting when the timer fires during session setup", async () => {
		// Delay createAgentSession longer than maxRuntimeMs so the wall-clock
		// timer fires while the executor is still doing async setup, well before
		// it ever calls session.prompt(). The fix must observe abortSignal
		// immediately before prompting and return the runtime-limit result.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 30 });
		const handle = createHangingSession();
		let promptCalls = 0;
		const originalPrompt = handle.session.prompt;
		handle.session.prompt = async (text, options) => {
			promptCalls += 1;
			return originalPrompt.call(handle.session, text, options);
		};
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
			return {
				session: handle.session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-setup-timeout",
			settings,
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=30");
		// The whole point: we never reached session.prompt(), because the abort
		// was observed before issuing the model call.
		expect(promptCalls).toBe(0);
	});

	it("a cancelled late initializer cannot replace a newer same-id worker", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const creationGate = Promise.withResolvers<void>();
		const creationStarted = Promise.withResolvers<CreateAgentSessionOptions>();
		const lateDisposed = Promise.withResolvers<void>();
		const lateSession = {
			dispose: async () => lateDisposed.resolve(),
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
		} as unknown as AgentSession;
		let lateInstall = registry.get("late-generation");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			creationStarted.resolve(options);
			await creationGate.promise;
			lateInstall = registry.registerIfAvailable(
				{
					id: "late-generation",
					displayName: "late A",
					kind: "sub",
					parentId: "Main",
					session: null,
					status: "running",
				},
				options.expectedAgentRef ?? null,
			);
			return {
				session: lateSession,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});
		const abortController = new AbortController();
		const run = runSubprocess({
			...baseOptions,
			id: "late-generation",
			settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
			signal: abortController.signal,
		});
		const creationOptions = await creationStarted.promise;
		expect(creationOptions.expectedAgentRef).toBeNull();
		abortController.abort();
		const cancelled = await run;
		expect(cancelled.aborted).toBe(true);

		const replacementSession = {
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
		} as unknown as AgentSession;
		const replacement = registry.register({
			id: "late-generation",
			displayName: "replacement B",
			kind: "sub",
			parentId: "Main",
			session: replacementSession,
			status: "idle",
		});
		creationGate.resolve();
		await lateDisposed.promise;

		expect(lateInstall).toBeUndefined();
		expect(registry.get("late-generation")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: replacementSession });
	});

	it("a late successful yield does not flip a timed-out run to success", async () => {
		// A hung subagent emits a successful `yield` event during teardown (after
		// the timer has already aborted). Without the fix, `hasYield=true` would
		// make finalizeSubprocessOutput zero the exit code and `wasAborted`
		// would resolve to false — silently masking the runtime-limit breach.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 30 });
		const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			prompt: async (_text: string, _options?: PromptOptions) => {
				await hang;
				return true;
			},
			waitForIdle: async () => {
				await hang;
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				abortCount += 1;
				// Simulate a late yield arriving while the executor is tearing
				// the session down in response to the wall-clock abort.
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-late-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { lateButLanded: true } },
					},
					isError: false,
				} as AgentSessionEvent);
				releaseHang();
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-late-yield",
			settings,
		});

		expect(abortCount).toBeGreaterThanOrEqual(1);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		// Yield data is preserved for inspection — the regression was only in
		// the exit status / abort flag, not in the captured payload.
		expect(result.extractedToolData?.yield).toBeDefined();
	});

	it("commits a yield tool call before the soft request budget aborts the turn", async () => {
		const settings = Settings.isolated({ "task.softRequestBudget": 1 });
		const firstAssistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "finishing the task" }],
			stopReason: "stop" as const,
		};
		const yieldAssistantMessage = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "tool-yield-budget",
					name: "yield",
					arguments: { result: { data: { finished: "unvalidated" } } },
				},
			],
			stopReason: "toolUse" as const,
		};
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let waitForIdleCalls = 0;
		let abortCount = 0;
		let abortCountBeforeYieldExecutionEnd: number | undefined;
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			prompt: async () => true,
			waitForIdle: async () => {
				waitForIdleCalls += 1;
				if (waitForIdleCalls !== 1) return;
				listenerRef?.({
					type: "message_end",
					message: firstAssistantMessage,
				} as unknown as AgentSessionEvent);
				listenerRef?.({
					type: "message_end",
					message: yieldAssistantMessage,
				} as unknown as AgentSessionEvent);
				abortCountBeforeYieldExecutionEnd = abortCount;
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-yield-budget",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { finished: "validated" } },
					},
					isError: false,
				} as AgentSessionEvent);
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => yieldAssistantMessage as never,
			abort: async () => {
				abortCount += 1;
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-yield",
			settings,
		});

		expect(abortCountBeforeYieldExecutionEnd).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.requests).toBe(2);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ finished: "validated" });
	});

	it("does not finalize rejected yield arguments after crossing the soft request budget", async () => {
		const settings = Settings.isolated({ "task.softRequestBudget": 1 });
		const firstAssistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "finishing the task" }],
			stopReason: "stop" as const,
		};
		const rejectedYieldMessage = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "tool-yield-rejected",
					name: "yield",
					arguments: { result: { data: { finished: "rejected-before-validation" } } },
				},
			],
			stopReason: "toolUse" as const,
		};
		const validYieldMessage = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "tool-yield-valid",
					name: "yield",
					arguments: { result: { data: { finished: "unvalidated-later" } } },
				},
			],
			stopReason: "toolUse" as const,
		};
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let lastAssistantMessage:
			| typeof firstAssistantMessage
			| typeof rejectedYieldMessage
			| typeof validYieldMessage
			| undefined;
		let waitForIdleCalls = 0;
		let abortCount = 0;
		let abortCountBeforeRejectedYieldExecutionEnd: number | undefined;
		let abortCountBeforeValidYieldExecutionEnd: number | undefined;
		const promptCalls: Array<{ text: string; options?: PromptOptions }> = [];
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			prompt: async (text: string, options?: PromptOptions) => {
				promptCalls.push({ text, options });
				return true;
			},
			waitForIdle: async () => {
				waitForIdleCalls += 1;
				if (waitForIdleCalls === 1) {
					lastAssistantMessage = firstAssistantMessage;
					listenerRef?.({
						type: "message_end",
						message: firstAssistantMessage,
					} as unknown as AgentSessionEvent);
					lastAssistantMessage = rejectedYieldMessage;
					listenerRef?.({
						type: "message_end",
						message: rejectedYieldMessage,
					} as unknown as AgentSessionEvent);
					abortCountBeforeRejectedYieldExecutionEnd = abortCount;
					listenerRef?.({
						type: "tool_execution_end",
						toolCallId: "tool-yield-rejected",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Yield rejected." }],
							details: { status: "error", data: { finished: "rejected-before-validation" } },
						},
						isError: true,
					} as AgentSessionEvent);
					return;
				}
				if (waitForIdleCalls === 2) {
					lastAssistantMessage = validYieldMessage;
					listenerRef?.({
						type: "message_end",
						message: validYieldMessage,
					} as unknown as AgentSessionEvent);
					abortCountBeforeValidYieldExecutionEnd = abortCount;
					listenerRef?.({
						type: "tool_execution_end",
						toolCallId: "tool-yield-valid",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { finished: "validated-later" } },
						},
						isError: false,
					} as AgentSessionEvent);
				}
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => lastAssistantMessage as never,
			abort: async () => {
				abortCount += 1;
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-rejected-yield",
			settings,
		});

		expect(abortCountBeforeRejectedYieldExecutionEnd).toBe(0);
		expect(abortCountBeforeValidYieldExecutionEnd).toBe(0);
		expect(promptCalls.length).toBeGreaterThanOrEqual(2);
		expect(promptCalls[1]?.options?.synthetic).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.requests).toBe(3);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ finished: "validated-later" });
		expect(result.extractedToolData?.yield).toEqual([
			{
				data: { finished: "validated-later" },
				status: "success",
				error: undefined,
				type: undefined,
				useLastTurn: undefined,
				schemaOverridden: undefined,
			},
		]);
	});

	it("resumes the hard budget guard after an incremental yield commits", async () => {
		const settings = Settings.isolated({ "task.softRequestBudget": 1 });
		const firstAssistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "still working" }],
			stopReason: "stop" as const,
		};
		const incrementalYieldMessage = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "tool-yield-incremental",
					name: "yield",
					arguments: { type: ["findings"], result: { data: { id: "saved" } } },
				},
			],
			stopReason: "toolUse" as const,
		};
		const followingAssistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "continuing after the saved section" }],
			stopReason: "stop" as const,
		};
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let lastAssistantMessage:
			| typeof firstAssistantMessage
			| typeof incrementalYieldMessage
			| typeof followingAssistantMessage
			| undefined;
		let waitForIdleCalls = 0;
		let abortCount = 0;
		let abortCountBeforeYieldExecutionEnd: number | undefined;
		let abortCountAfterFollowingTurn: number | undefined;
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			prompt: async () => true,
			waitForIdle: async () => {
				waitForIdleCalls += 1;
				if (waitForIdleCalls !== 1) return;
				lastAssistantMessage = firstAssistantMessage;
				listenerRef?.({
					type: "message_end",
					message: firstAssistantMessage,
				} as unknown as AgentSessionEvent);
				lastAssistantMessage = incrementalYieldMessage;
				listenerRef?.({
					type: "message_end",
					message: incrementalYieldMessage,
				} as unknown as AgentSessionEvent);
				abortCountBeforeYieldExecutionEnd = abortCount;
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-yield-incremental",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Section submitted." }],
						details: {
							status: "success",
							data: { id: "saved" },
							type: ["findings"],
						},
					},
					isError: false,
				} as AgentSessionEvent);
				lastAssistantMessage = followingAssistantMessage;
				listenerRef?.({
					type: "message_end",
					message: followingAssistantMessage,
				} as unknown as AgentSessionEvent);
				abortCountAfterFollowingTurn = abortCount;
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => lastAssistantMessage as never,
			abort: async () => {
				abortCount += 1;
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-soft-budget-incremental-yield",
			settings,
		});

		expect(abortCountBeforeYieldExecutionEnd).toBe(0);
		expect(abortCountAfterFollowingTurn).toBe(1);
		expect(result.requests).toBe(3);
		expect(result.extractedToolData?.yield).toEqual([
			{
				data: { id: "saved" },
				status: "success",
				error: undefined,
				type: ["findings"],
				useLastTurn: undefined,
				schemaOverridden: undefined,
			},
		]);
	});

	it("propagates per-turn context tokens onto the SingleResult", async () => {
		// Async task consumers (index.ts) copy `singleResult.contextTokens` and
		// `singleResult.contextWindow` onto AgentProgress. This test pins the
		// upstream contract: when an assistant message_end carries totalTokens,
		// executor must surface it on SingleResult.contextTokens.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const fastSession: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				queueMicrotask(() => {
					listener({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 12345 },
						},
					} as unknown as AgentSessionEvent);
					listener({
						type: "tool_execution_end",
						toolCallId: "tool-ok",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				return () => {};
			},
			prompt: async () => true,
			waitForIdle: async () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			abort: async () => {},
			dispose: async () => {},
		};
		mockCreateAgentSession(fastSession as AgentSession);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-context-tokens",
			settings,
		});

		expect(result.aborted).toBe(false);
		expect(result.contextTokens).toBe(12345);
		// contextWindow is only populated when the model registry resolves one;
		// here we mock createAgentSession so it stays undefined. The async-task
		// consumer's assignment is a straight copy, so undefined is acceptable.
		expect(result.contextWindow).toBeUndefined();
	});

	it("attributes a budget hard-abort to the budget, not a timer that fires during teardown", async () => {
		// softRequestBudget=1 -> stop at 1.5 requests, hard abort at 1.5 + grace.
		// The child burns 8 requests immediately, so the budget kills the run at
		// t~0. maxRuntimeMs=400 then fires while the budget abort's teardown is
		// still in flight (abort() holds the run open past the deadline). The
		// wall-clock timer must not rewrite the already-committed budget outcome.
		const settings = Settings.isolated({ "task.softRequestBudget": 1, "task.maxRuntimeMs": 400 });
		const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			hasPendingAsyncWork: () => false,
			prompt: async () => {
				for (let i = 0; i < 8; i++) {
					listenerRef?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] },
					} as unknown as AgentSessionEvent);
				}
				await hang;
				return true;
			},
			waitForIdle: async () => {
				await hang;
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				abortCount += 1;
				// Genuine delay: the defect is the real interleaving between the
				// executor's setTimeout(maxRuntimeMs) and its async teardown, so the
				// teardown must outlast the deadline against the real clock. Fake
				// timers would dictate that ordering instead of observing it.
				await Bun.sleep(1500);
				releaseHang();
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-budget-then-timer", settings });

		expect(abortCount).toBeGreaterThanOrEqual(1);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toContain("Soft request budget exceeded");
		expect(result.abortReason).not.toContain("runtime limit exceeded");
	});

	it("does not flip a committed pre-deadline yield to an aborted timeout", async () => {
		// The child yields a full report at t~0, well inside the 400ms budget.
		// Post-yield teardown then runs past the deadline; a timer that fires
		// after the outcome is committed must be a no-op — the run succeeded.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 400 });
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;
		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			hasPendingAsyncWork: () => false,
			prompt: async () => {
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { finding: "complete report" } },
					},
					isError: false,
				} as AgentSessionEvent);
				return true;
			},
			waitForIdle: async () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				abortCount += 1;
				// Genuine delay: post-yield teardown must outlast the real
				// setTimeout(maxRuntimeMs) so the timer fires after the yield has
				// committed. See the budget test above for why fake timers do not fit.
				await Bun.sleep(1500);
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-yield-then-timer", settings });

		expect(abortCount).toBeGreaterThanOrEqual(1);
		expect(result.extractedToolData?.yield).toBeDefined();
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
	});
});
