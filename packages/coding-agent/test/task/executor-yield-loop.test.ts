import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

/**
 * Contracts under test — a subagent that answers with nothing but incremental
 * `yield` sections must still be bounded:
 *
 * 1. Incremental yields are budget-bound. Every turn that carries a `yield`
 *    tool call latches the pending-commit flag, so a run whose turns are all
 *    yield turns must not slip past the soft budget stop and its hard-abort
 *    grace window.
 * 2. A forced final yield terminates the run. Once the reminder ladder pins
 *    the model to `yield` (`toolChoice`), an incremental section is the report
 *    it is going to produce: accept it instead of re-prompting forever, since
 *    an incremental yield satisfies the pin without ending the run.
 */

/** Emit budget: a guard must stop the run well before this many yield turns. */
const YIELD_TURN_CAP = 200;

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	/** Owner async work the quiescence barrier sees; the test flips it. */
	asyncPending: { value: boolean };
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void | Promise<void>,
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let promptIndex = 0;
	const asyncPending = { value: false };

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
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
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		hasPendingAsyncWork: () => asyncPending.value,
		getAsyncJobSnapshot: () => ({
			running: asyncPending.value
				? [{ id: "bg_1", label: "pytest", type: "bash" as const, status: "running" as const, startTime: 0 }]
				: [],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		}),
		settleAsyncWork: async () => {
			asyncPending.value = false;
		},
		abort: async () => {
			abortCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		asyncPending,
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

const baseAgent: AgentDefinition = {
	name: "scout",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess incremental yield loops", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-yield-loop-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string, softRequestBudget: number) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "task.softRequestBudget": softRequestBudget }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	function registerRunning(id: string, session: AgentSession) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
	}

	/** One assistant turn whose only content is a terminal `yield`. */
	function emitTerminalYieldTurn(
		label: string,
		emit: (event: AgentSessionEvent) => void,
		pushMessage: (message: unknown) => void,
	) {
		const toolCallId = `tool-final-${label}`;
		const message = {
			role: "assistant" as const,
			content: [
				{ type: "toolCall" as const, id: toolCallId, name: "yield", arguments: { data: { report: label } } },
			],
			stopReason: "toolUse" as const,
		};
		pushMessage(message);
		emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { report: label } },
			},
			isError: false,
		} as AgentSessionEvent);
	}

	/** One assistant turn whose only content is an incremental `yield` section. */
	function emitIncrementalYieldTurn(
		index: number,
		emit: (event: AgentSessionEvent) => void,
		pushMessage: (message: unknown) => void,
	) {
		const toolCallId = `tool-yield-${index}`;
		const message = {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: toolCallId,
					name: "yield",
					arguments: { type: ["progress"], result: { data: { section: `cleanup-${index}` } } },
				},
			],
			stopReason: "toolUse" as const,
		};
		pushMessage(message);
		emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_start",
			toolCallId,
			toolName: "yield",
			args: { type: ["progress"] },
		} as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Section submitted." }],
				details: { status: "success", data: { section: `cleanup-${index}` }, type: ["progress"] },
			},
			isError: false,
		} as AgentSessionEvent);
	}

	it("keeps a run of incremental-yield-only turns inside the soft budget", async () => {
		const id = "YieldLoopScout";
		// Budget 2 → stop at 3 requests, hard abort at 3 + BUDGET_STOP_GRACE_REQUESTS.
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			for (let i = 1; i <= YIELD_TURN_CAP; i++) {
				// A real agent loop keeps taking turns until the monitor aborts
				// the session; the second abort is the budget hard-abort (the
				// first is the soft stop, which does not end the run).
				if (handle.abortCalls() >= 2) break;
				emitIncrementalYieldTurn(i, emit, pushMessage);
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id, 2));

		expect(result.requests).toBeLessThan(YIELD_TURN_CAP);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toMatch(/budget/i);
	});

	it("ends the run when the forced final yield comes back incremental", async () => {
		const id = "PinnedScout";
		// Budget disabled: only the forced-yield ladder can bound this run.
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex <= 3) {
				// Text-only turns walk the reminder ladder to its final retry,
				// which pins `toolChoice` to `yield`.
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `awaiting bg_${promptIndex}` }],
					stopReason: "stop" as const,
				};
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				return;
			}
			for (let i = 1; i <= YIELD_TURN_CAP; i++) {
				if (handle.abortCalls() >= 1) break;
				emitIncrementalYieldTurn(i, emit, pushMessage);
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id, 0));

		// The final reminder pins the model to `yield`.
		expect(handle.prompts).toHaveLength(4);
		expect(handle.prompts[3]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		// The pinned yield ends the run with the section it submitted.
		expect(result.requests).toBeLessThan(YIELD_TURN_CAP);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ progress: { section: "cleanup-1" } });
	});

	it("does not finalize a section submitted after the forced yield parked", async () => {
		const id = "ParkedScout";
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex <= 3) {
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `awaiting bg_1 (${promptIndex})` }],
					stopReason: "stop" as const,
				};
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				return;
			}
			if (promptIndex === 4) {
				// Owner work starts on the forced final reminder. Its terminal
				// yield parks behind the quiescence barrier.
				handle.asyncPending.value = true;
				emitTerminalYieldTurn("PARKED", emit, pushMessage);
				return;
			}
			if (promptIndex === 5) {
				// The barrier's async-pending notice turn. The force belonged to
				// prompt 4 only: a section here is progress, not the report.
				handle.asyncPending.value = false;
				emitIncrementalYieldTurn(1, emit, pushMessage);
				return;
			}
			emitTerminalYieldTurn("FRESH", emit, pushMessage);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id, 0));

		// The notice turn's section did not end the run: the ladder ran again
		// and the run completed on the fresh terminal yield.
		expect(handle.prompts.length).toBeGreaterThan(5);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("FRESH");
	});
});
