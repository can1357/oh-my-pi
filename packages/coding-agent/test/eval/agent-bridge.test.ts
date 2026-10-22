import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	runEvalAgent,
	type EvalAgentBridgeOptions,
	type EvalAgentResult,
} from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalBudget } from "@oh-my-pi/pi-coding-agent/eval/budget-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

import { cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";

const jobManagers = new Set<AsyncJobManager>();

function isEvalAgentResult(value: unknown): value is EvalAgentResult {
	return (
		value !== null &&
		typeof value === "object" &&
		"details" in value &&
		"text" in value &&
		typeof value.text === "string" &&
		value.details !== null &&
		typeof value.details === "object"
	);
}

async function runEvalAgentAndWait(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentResult> {
	let manager = options.session.asyncJobManager;
	if (!manager) {
		manager = new AsyncJobManager({});
		Object.assign(options.session, { asyncJobManager: manager });
	}
	jobManagers.add(manager);
	const handle = await runEvalAgent(args, options);
	const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, options);
	const snapshot = waited.items[0];
	if (!snapshot || snapshot.status === "running") throw new Error(`Agent handle ${handle.id} did not settle`);
	if (snapshot.status === "failed" || snapshot.status === "cancelled") {
		throw new Error(snapshot.error || `Agent handle ${handle.id} failed`);
	}
	const result = manager.getJob(handle.id)?.latestDetails?.evalResult;
	if (!isEvalAgentResult(result)) throw new Error(`Agent handle ${handle.id} returned no eval result`);
	return result;
}

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function createUsage(output: number) {
	return {
		input: 9_000,
		output,
		cacheRead: 8_000,
		cacheWrite: 7_000,
		totalTokens: 24_000 + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createBudgetSession(sessionManager: SessionManager): ToolSession {
	return {
		cwd: "/tmp",
		settings: Settings.isolated(),
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		getTurnBudget: () => sessionManager.getTurnBudget(),
		recordEvalSubagentUsage: (output: number) => sessionManager.recordEvalSubagentOutput(output),
	} as unknown as ToolSession;
}

describe("runEvalAgent", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([...jobManagers].map(manager => manager.dispose()));
		jobManagers.clear();
	});

	it("updates the real turn budget by output tokens only", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ usage: createUsage(1_234) }));

		await runEvalAgentAndWait({ prompt: "do work", agent: "task" }, { session: createBudgetSession(sessionManager) });

		expect(sessionManager.getTurnBudget()).toEqual({
			total: 100_000,
			spent: 1_234,
			hard: true,
		});
	});

	it("charges output exactly once when an eval-spawned subagent returns an error", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, false);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			createResult({
				exitCode: 1,
				error: "agent failed",
				stderr: "agent failed",
				usage: createUsage(2_345),
			}),
		);

		await expect(
			runEvalAgentAndWait({ prompt: "do work", agent: "task" }, { session: createBudgetSession(sessionManager) }),
		).rejects.toThrow("agent failed");

		expect(sessionManager.getTurnBudget().spent).toBe(2_345);
	});

	it("charges isolated output before a later cleanup failure", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, true);
		const session = createBudgetSession(sessionManager);
		cfgTaskIsolationEnabled.set(session.settings, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" });
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			options.onSubprocessResult?.(createResult({ usage: createUsage(4_567) }));
			throw new Error("cleanup failed");
		});

		await expect(
			runEvalAgentAndWait({ prompt: "do work", agent: "task", isolated: true }, { session }),
		).rejects.toThrow("cleanup failed");

		expect(sessionManager.getTurnBudget().spent).toBe(4_567);
	});

	it("blocks admission exactly when the budget() ceiling is hard and exhausted", async () => {
		// Disabled spawns turn a passed budget guard into a deterministic policy refusal, so nothing launches.
		const spawnRefusal = "spawns disabled for this agent";
		const cases: Array<{
			turn: { total: number | null; hard: boolean; spent: number };
			goal?: { tokenBudget?: number; tokensUsed: number };
			error: string;
		}> = [
			{ turn: { total: null, hard: false, spent: 0 }, error: spawnRefusal },
			{
				turn: { total: null, hard: false, spent: 0 },
				goal: { tokenBudget: 20, tokensUsed: 20 },
				error: "Goal Mode token budget exhausted (20/20 tokens)",
			},
			{ turn: { total: null, hard: false, spent: 0 }, goal: { tokensUsed: 50 }, error: spawnRefusal },
			{ turn: { total: 10, hard: true, spent: 10 }, error: "turn token budget exhausted (10/10 output tokens)" },
			{ turn: { total: 10, hard: false, spent: 10 }, error: spawnRefusal },
			{ turn: { total: 10, hard: true, spent: 9 }, error: spawnRefusal },
			// An unexhausted +Nk! directive overrides an exhausted goal budget.
			{ turn: { total: 10, hard: true, spent: 9 }, goal: { tokenBudget: 20, tokensUsed: 20 }, error: spawnRefusal },
		];
		for (const { turn, goal, error } of cases) {
			const sessionManager = SessionManager.inMemory();
			sessionManager.beginTurnBudget(turn.total, turn.hard);
			sessionManager.recordEvalSubagentOutput(turn.spent);
			const session = {
				...createBudgetSession(sessionManager),
				getSessionSpawns: () => "",
				getGoalModeState: () => (goal ? { enabled: true, goal } : undefined),
			} as unknown as ToolSession;
			const budget = await runEvalBudget({}, { session });
			const blocked = budget.hard && budget.total !== null && budget.spent >= budget.total;
			expect(blocked).toBe(error !== spawnRefusal);
			await expect(runEvalAgent({ prompt: "local", agent: "task" }, { session })).rejects.toThrow(error);
		}
	});

	it("counts the in-flight assistant request toward the goal budget before admitting agent()", async () => {
		let state: GoalModeState | undefined = {
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "ship",
				status: "active",
				tokenBudget: 100,
				tokensUsed: 90,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		};
		let usage: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const steers: string[] = [];
		const runtime = new GoalRuntime({
			getState: () => state && { ...state, goal: { ...state.goal } },
			setState: next => {
				state = next && { ...next, goal: { ...next.goal } };
			},
			getCurrentUsage: () => ({ ...usage }),
			emit: () => {},
			persist: () => {},
			sendHiddenMessage: async message => {
				steers.push(message.customType);
			},
			now: () => 0,
		});
		runtime.onTurnStart("turn-1", usage);
		// The assistant request that invoked eval has landed; its tool call has not completed yet.
		usage = { ...usage, output: 10 };
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(null, false);
		const session = {
			...createBudgetSession(sessionManager),
			getSessionSpawns: () => "",
			getGoalRuntime: () => runtime,
			getGoalModeState: () => state,
		} as unknown as ToolSession;

		expect(await runEvalBudget({}, { session })).toEqual({ total: 100, spent: 100, hard: true });
		expect(steers).toEqual([]);
		await expect(runEvalAgent({ prompt: "local", agent: "task" }, { session })).rejects.toThrow(
			"Goal Mode token budget exhausted (100/100 tokens)",
		);
		expect(steers).toEqual([]);
		// Another tool can finish concurrently; only the eval boundary delivers its deferred steer.
		await runtime.onToolCompleted("read");
		expect(steers).toEqual([]);
		await runtime.onToolCompleted("eval");
		expect(steers).toEqual(["goal-budget-limit"]);
		await runtime.onToolCompleted("eval");
		expect(steers).toEqual(["goal-budget-limit"]);
	});

	it("does not route ordinary task subagents through the eval budget accumulator", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const recordEvalSubagentUsage = vi.fn();
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			recordEvalSubagentUsage,
		} as unknown as ToolSession;
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ usage: createUsage(3_456) }));

		await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "do work",
			agent: "task",
		});

		expect(recordEvalSubagentUsage).not.toHaveBeenCalled();
	});
});
