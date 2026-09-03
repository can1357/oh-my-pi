import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveSoftRequestBudget, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contracts under test — the soft request budget must degrade gracefully
 * instead of killing scouts into an unreachable state:
 *
 * 1. Crossing 1.5x the budget stops the free-running turn and drives ONE
 *    forced final `yield`, so the run finishes as a normal completion with a
 *    partial report — not as an abort with no output.
 * 2. If the agent still refuses to yield (grace exhausted → hard abort), a
 *    kept-alive agent stays adopted (`idle`), so `irc` can message/resume it
 *    with the same RPC lifecycle/progress frames as the original run.
 * 3. Caller-signal aborts remain terminal, and the irc bus names the aborted
 *    agent precisely instead of claiming it is unknown.
 */

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	disposeCalls: () => number;
}

function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void | Promise<void>,
	onAbort?: () => void | Promise<void>,
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let disposeCount = 0;
	let promptIndex = 0;
	let ircWakeTurnObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options });
			await onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		setIrcWakeTurnObserver: observer => {
			ircWakeTurnObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		deliverIrcMessage: async msg => {
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:incoming",
				content: msg.body,
				display: true,
				details: { id: msg.id, from: msg.from, message: msg.body },
				attribution: "agent",
				timestamp: msg.ts,
			};
			const finishObservation = ircWakeTurnObserver?.([record]);
			const yieldMessage = {
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tool-irc-yield",
						name: "yield",
						arguments: { result: { data: { report: "resumed findings" } } },
					},
				],
				stopReason: "toolUse" as const,
			};
			messages.push(yieldMessage);
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-irc-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "resumed findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({ type: "agent_end", messages: [yieldMessage] } as unknown as AgentSessionEvent);
			await finishObservation?.();
			return "woken";
		},
		abort: async () => {
			abortCount += 1;
			await onAbort?.();
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
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
// Use a bundled scout so these runSubprocess tests exercise the built-in
// ceiling together with a lower task.softRequestBudget setting.
const baseAgent: AgentDefinition = {
	name: "scout",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess soft request budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-soft-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string, eventBus?: EventBus, subagentEventBus?: EventBus) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			eventBus,
			subagentEventBus: subagentEventBus ?? eventBus,
		};
	}

	function registerRunning(id: string, session: AgentSession, sessionFile: string | null = null) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile,
			status: "running",
		});
	}

	it("a budget stop drives one forced final yield and finishes as a normal completion", async () => {
		const id = "BudgetScout";
		let abortCallsAtReminder: number | undefined;
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex === 1) {
				// Free-running exploration: budget 2 → stop threshold 3.
				for (let i = 1; i <= 3; i++) {
					const message = assistantText(`exploring ${i}`, i === 3 ? "aborted" : "stop");
					pushMessage(message);
					emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				}
				return;
			}
			// The forced wrap-up reminder: answer it with a terminal yield.
			abortCallsAtReminder = handle.abortCalls();
			const yieldMessage = {
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tool-forced-yield",
						name: "yield",
						arguments: { result: { data: { report: "partial findings" } } },
					},
				],
				stopReason: "toolUse" as const,
			};
			pushMessage(yieldMessage);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-forced-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "partial findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		// The budget stop aborted the free-running turn exactly once before the
		// wrap-up reminder; the second abort (after the terminal yield) is the
		// normal post-yield terminate.
		expect(abortCallsAtReminder).toBe(1);
		// The budget stop forces a synthetic terminal yield.
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.options?.synthetic).toBe(true);
		expect(handle.prompts[1]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		// The forced yield finalizes as a normal completion, not an abort.
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "partial findings" });
		// The agent stays a live, adopted peer.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);
	});

	it("a budget hard-abort keeps the kept-alive agent adopted and messageable via irc", async () => {
		const id = "StubbornScout";
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		let resolveFollowUpTerminal: (() => void) | undefined;
		const waitForFollowUpTerminal = (): Promise<void> => {
			const deferred = Promise.withResolvers<void>();
			resolveFollowUpTerminal = deferred.resolve;
			return deferred.promise;
		};
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type !== "subagent_lifecycle" || frame.payload.status === "started") return;
			const resolve = resolveFollowUpTerminal;
			resolveFollowUpTerminal = undefined;
			resolve?.();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			// Never yields: budget 2 → stop at 3, grace exhausted at 3 + 5 = 8.
			for (let i = 1; i <= 8; i++) {
				const message = assistantText(`burning request ${i}`);
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id, eventBus));

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toMatch(/Soft request budget exceeded/);
		// Resumable stop, not a terminal kill: the ref stays adopted and live.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);

		const expectRpcTurn = (): void => {
			expect(frames[0]).toMatchObject({
				type: "subagent_lifecycle",
				payload: { id, status: "started" },
			});
			expect(frames.some(frame => frame.type === "subagent_progress")).toBe(true);
			expect(frames.at(-1)).toMatchObject({
				type: "subagent_lifecycle",
				payload: { id, status: "completed" },
			});
		};

		frames.length = 0;
		const idleTerminal = waitForFollowUpTerminal();
		const idleReceipt = await new IrcBus().send({ from: "Main", to: id, body: "resume your inventory" });
		expect(idleReceipt.outcome).toBe("woken");
		await idleTerminal;
		expectRpcTurn();

		await AgentLifecycleManager.global().park(id);
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		frames.length = 0;
		const revivedTerminal = waitForFollowUpTerminal();
		const revivedReceipt = await new IrcBus().send({ from: "Main", to: id, body: "resume after parking" });
		expect(revivedReceipt.outcome).toBe("revived");
		await revivedTerminal;
		expectRpcTurn();
		rpcRegistry.dispose();
	});

	it("a shutdown racing a budget hard-abort follows the shutdown release path", async () => {
		// Regression: a process shutdown that lands right after the soft-budget
		// grace hard-aborts must supersede the budget reason, so the subagent is
		// released (disposed + unregistered, restorable as parked) instead of
		// being left adopted and alive past AgentLifecycleManager.dispose().
		const id = "RacedScout";
		const rootSessionFile = `${tempDir.path()}/main.jsonl`;
		const workerSessionFile = `${tempDir.path()}/main/${id}.jsonl`;
		await Bun.write(rootSessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-13T17:14:48.000Z", cwd: "/tmp" }),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:48.000Z",
					systemPrompt: "system",
					task: "work",
					tools: ["read"],
				}),
			].join("\n"),
		);
		const controller = new AbortController();
		// abort #1 = budget soft-stop (abortSent still false); abort #2 =
		// budget hard-abort's abortActiveSession (abortReason already "budget").
		// Fire the shutdown only on #2 so it must supersede the budget reason.
		let abortInvocations = 0;
		const handle = createMockSession(
			({ promptIndex, emit, pushMessage }) => {
				if (promptIndex !== 1) return;
				// Never yields: budget 2 → stop at 3, grace exhausted at 8.
				for (let i = 1; i <= 8; i++) {
					const message = assistantText(`burning request ${i}`);
					pushMessage(message);
					emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				}
			},
			() => {
				abortInvocations += 1;
				if (abortInvocations >= 2 && !controller.signal.aborted) {
					controller.abort(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
				}
			},
		);
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session, workerSessionFile);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)).toBeUndefined();
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);
		expect(await Bun.file(`${workerSessionFile}.tombstone`).exists()).toBe(false);
		const restored = new AgentRegistry();
		await registerPersistedSubagents(restored, rootSessionFile);
		expect(restored.get(id)?.status).toBe("parked");
	});

	it("manager shutdown restores a running kept-alive agent as parked without a tombstone", async () => {
		const id = "ShutdownScout";
		const rootSessionFile = `${tempDir.path()}/main.jsonl`;
		const workerSessionFile = `${tempDir.path()}/main/${id}.jsonl`;
		await Bun.write(rootSessionFile, "");
		await Bun.write(
			workerSessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-13T17:14:48.000Z", cwd: "/tmp" }),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:48.000Z",
					systemPrompt: "system",
					task: "work",
					tools: ["read"],
				}),
			].join("\n"),
		);
		const promptStarted = Promise.withResolvers<void>();
		const promptStopped = Promise.withResolvers<void>();
		const handle = createMockSession(
			async ({ promptIndex }) => {
				if (promptIndex !== 1) return;
				promptStarted.resolve();
				await promptStopped.promise;
			},
			() => promptStopped.resolve(),
		);
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session, workerSessionFile);
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		AsyncJobManager.setInstance(manager);
		manager.register(
			"task",
			"shutdown regression",
			async ({ signal }) => {
				const result = await runSubprocess({ ...baseOptions(id), signal });
				return result.output;
			},
			{ ownerId: "Main", agentId: id },
		);

		await promptStarted.promise;
		await manager.dispose({ timeoutMs: 1_000 });
		AsyncJobManager.setInstance(undefined);

		expect(await Bun.file(`${workerSessionFile}.tombstone`).exists()).toBe(false);
		expect(AgentRegistry.global().get(id)).toBeUndefined();
		const restoredRegistry = new AgentRegistry();
		await registerPersistedSubagents(restoredRegistry, rootSessionFile);
		expect(restoredRegistry.get(id)?.status).toBe("parked");
	});

	it("a nested spawn reaches the root RPC surface through the inherited observability bus", async () => {
		const id = "WiringScout";
		// Separate session and observability buses, the way the CLI wires them.
		const sessionBus = new EventBus();
		const treeBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		let resolveTerminalLatch: (() => void) | undefined;
		const waitForTerminal = (): Promise<void> => {
			const deferred = Promise.withResolvers<void>();
			resolveTerminalLatch = deferred.resolve;
			return deferred.promise;
		};
		const rpcRegistry = new RpcSubagentRegistry(treeBus, frame => {
			frames.push(frame);
			if (frame.type !== "subagent_lifecycle" || frame.payload.status === "started") return;
			resolveTerminalLatch?.();
			resolveTerminalLatch = undefined;
		});
		rpcRegistry.setSubscriptionLevel("events");
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			// The depth-2 executor publishes on the bus its spawner handed down —
			// captured from the real spawn options, not the test's own bus.
			capturedOptions?.subagentEventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: `${id}.Grandkid`,
				agent: "task",
				agentSource: "bundled",
				status: "started",
				parentToolCallId: "call-grandkid",
				index: 2,
			});
			const message = assistantText("settling");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		});
		let capturedOptions: { subagentEventBus?: EventBus } | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: handle.session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});
		registerRunning(id, handle.session);

		const terminal = waitForTerminal();
		await runSubprocess(baseOptions(id, sessionBus, treeBus));
		await terminal;

		// The spawn wiring inherited the tree bus into the nested session.
		expect(capturedOptions?.subagentEventBus).toBe(treeBus);
		// The root RPC surface observed the depth-1 run…
		expect(frames.some(frame => frame.type === "subagent_lifecycle" && frame.payload.id === id)).toBe(true);
		// …and the depth-2 frame published on the inherited bus.
		expect(frames.some(frame => frame.type === "subagent_lifecycle" && frame.payload.id === `${id}.Grandkid`)).toBe(
			true,
		);
	});

	it("an aliased observability bus does not duplicate lifecycle frames", async () => {
		const id = "AliasScout";
		// An SDK caller wiring the same EventBus into both slots must not see
		// every frame twice — the executor skips the aliased re-emit.
		const sharedBus = new EventBus();
		const settled: string[] = [];
		const terminal = Promise.withResolvers<void>();
		sharedBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
			const payload = frame as { id?: string; status?: string };
			if (payload.id !== id) return;
			if (payload.status === "started") return;
			settled.push(payload.status ?? "");
			terminal.resolve();
		});
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			const message = assistantText("settling");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			return {
				session: handle.session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});
		registerRunning(id, handle.session);

		await runSubprocess(baseOptions(id, sharedBus, sharedBus));
		await terminal.promise;

		expect(settled).toEqual(["completed"]);
	});

	it("a caller-signal abort stays terminal and irc names the aborted agent precisely", async () => {
		const id = "CancelledScout";
		const controller = new AbortController();
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			const message = assistantText("working");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			controller.abort();
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(receipt.error).toMatch(new RegExp(`history://${id}`));
	});
});

describe("resolveSoftRequestBudget", () => {
	it("lets a configured budget lower a bundled agent's ceiling", () => {
		expect(resolveSoftRequestBudget("scout", 20)).toBe(20);
		expect(resolveSoftRequestBudget("sonic", 20)).toBe(20);
	});

	it("keeps the bundled ceiling when the configured budget is higher", () => {
		expect(resolveSoftRequestBudget("scout", 200)).toBe(100);
		expect(resolveSoftRequestBudget("sonic", 200)).toBe(100);
	});

	it("uses the configured budget for agents without a bundled entry", () => {
		expect(resolveSoftRequestBudget("task", 20)).toBe(20);
	});

	it("keeps 0 disabled and normalizes negative or fractional budgets", () => {
		expect(resolveSoftRequestBudget("scout", 0)).toBe(0);
		expect(resolveSoftRequestBudget("scout", -5)).toBe(0);
		expect(resolveSoftRequestBudget("scout", 20.9)).toBe(20);
	});
});
