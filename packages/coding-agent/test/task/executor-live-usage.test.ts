/**
 * Contract: `AgentProgress` carries a live usage breakdown (prompt volume split
 * into uncached input / cache read / cache write, plus output) and the summed
 * model wait time per turn (`turn_start` → assistant `message_end`), so the HUD
 * and inline rows can show in/out volume, cache hit rate, and output rate while
 * the agent is still running. Only assistant `message_end` events count;
 * tool-result usage is ignored, and a `message_end` with no open turn adds no
 * generation time. The window starts at the request, not `message_start`:
 * non-streaming providers emit start and end back-to-back.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function assistantMessage(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}): AssistantMessage {
	// Executor reads role/content/usage only; the cast documents the structural double.
	return {
		role: "assistant",
		content: [],
		usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
	} as unknown as AssistantMessage;
}

function yieldEvents(): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolCallId: "final-yield",
			toolName: "yield",
			result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data: {} } },
			isError: false,
		},
	] as AgentSessionEvent[];
}

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/** Runs the executor against a scripted event stream; `clock` advances `Date.now()` between events. */
async function runScript(
	steps: Array<{ atMs: number; event: AgentSessionEvent }>,
): Promise<{ snapshots: AgentProgress[]; exitCode: number }> {
	let nowMs = 0;
	vi.spyOn(Date, "now").mockImplementation(() => nowMs);
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			// Listeners may unsubscribe during dispatch; iterate a snapshot.
			const dispatch = (event: AgentSessionEvent) => {
				for (const listener of listeners.slice()) listener(event);
			};
			for (const step of steps) {
				nowMs = step.atMs;
				dispatch(step.event);
			}
			for (const event of yieldEvents()) dispatch(event);
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		isAborted: () => false,
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: session as unknown as AgentSession,
	} as CreateAgentSessionResult);

	const snapshots: AgentProgress[] = [];
	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "usage scenario",
		description: "live usage",
		index: 0,
		id: `live-usage-${Math.random().toString(36).slice(2)}`,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as ModelRegistry,
		enableLsp: false,
		signal: new AbortController().signal,
		eventBus: new EventBus(),
		onProgress: progress => snapshots.push(progress),
	});
	return { snapshots, exitCode: result.exitCode };
}

describe("subagent live usage breakdown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accumulates prompt/output split and per-turn model wait time across turns", async () => {
		const turn1 = assistantMessage({ input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 });
		const turn2 = assistantMessage({ input: 20, output: 30, cacheRead: 1000, cacheWrite: 80, totalTokens: 1130 });
		const { snapshots, exitCode } = await runScript([
			{ atMs: 1_000, event: { type: "turn_start" } as AgentSessionEvent },
			// A non-streaming provider: start and end land together, long after the request.
			{ atMs: 2_999, event: { type: "message_start", message: turn1 } as AgentSessionEvent },
			{ atMs: 3_000, event: { type: "message_end", message: turn1 } as AgentSessionEvent },
			// Tool-result usage never counts: neither the breakdown nor the clock moves.
			{
				atMs: 4_000,
				event: {
					type: "message_end",
					message: { role: "toolResult", content: [], usage: { input: 999, output: 999 } },
				} as unknown as AgentSessionEvent,
			},
			{ atMs: 5_000, event: { type: "turn_start" } as AgentSessionEvent },
			{ atMs: 5_200, event: { type: "message_start", message: turn2 } as AgentSessionEvent },
			{ atMs: 6_000, event: { type: "message_end", message: turn2 } as AgentSessionEvent },
		]);
		expect(exitCode).toBe(0);
		const final = snapshots[snapshots.length - 1];
		expect(final).toMatchObject({
			inputTokens: 120,
			outputTokens: 80,
			cacheReadTokens: 1900,
			cacheWriteTokens: 80,
			generationMs: 3_000,
			requests: 2,
		});
	});

	it("leaves the breakdown absent until the first assistant turn settles", async () => {
		const turn = assistantMessage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
		const { snapshots } = await runScript([
			{ atMs: 1_000, event: { type: "turn_start" } as AgentSessionEvent },
			{ atMs: 1_100, event: { type: "message_start", message: turn } as AgentSessionEvent },
			{
				atMs: 1_500,
				event: { type: "tool_execution_start", toolCallId: "t0", toolName: "read", args: {} } as AgentSessionEvent,
			},
			{
				atMs: 1_600,
				event: {
					type: "tool_execution_end",
					toolCallId: "t0",
					toolName: "read",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent,
			},
			{ atMs: 2_000, event: { type: "message_end", message: turn } as AgentSessionEvent },
		]);
		const beforeTurnEnd = snapshots.find(snapshot => snapshot.requests === 0);
		expect(beforeTurnEnd).toBeDefined();
		expect(beforeTurnEnd?.inputTokens).toBeUndefined();
		expect(beforeTurnEnd?.generationMs).toBeUndefined();
		const final = snapshots[snapshots.length - 1];
		expect(final).toMatchObject({ inputTokens: 10, outputTokens: 5, generationMs: 1_000 });
	});

	it("adds no generation time for a message_end outside an open turn", async () => {
		const turn = assistantMessage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
		const { snapshots } = await runScript([
			{ atMs: 2_000, event: { type: "message_end", message: turn } as AgentSessionEvent },
		]);
		const final = snapshots[snapshots.length - 1];
		expect(final.outputTokens).toBe(5);
		expect(final.generationMs).toBeUndefined();
	});
});
