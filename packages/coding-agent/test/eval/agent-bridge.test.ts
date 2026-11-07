import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

import { cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";

const jobManagers = new Set<AsyncJobManager>();

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
		const manager = new AsyncJobManager({});
		jobManagers.add(manager);
		const session = Object.assign(createBudgetSession(sessionManager), { asyncJobManager: manager });
		const report: TaskReportReference = Object.freeze({
			version: 1,
			runId: "eval-budget-success",
			status: "complete",
			artifact: Object.freeze({ id: "101", uri: "artifact://101", sha256: "a".repeat(64), bytes: 4 }),
		});
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ usage: createUsage(1_234), report }));

		const handle = await runEvalAgent({ prompt: "do work", agent: "task" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({ status: "completed" });
		const job = manager.getJob(handle.id);
		expect(job?.status).toBe("completed");
		expect(job?.resultText).toBe("done");
		expect(job?.errorText).toBeUndefined();
		expect(job?.latestDetails?.evalResult).toMatchObject({ text: "done", details: { structured: false } });
		expect(job?.report).toBe(report);

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
		const manager = new AsyncJobManager({});
		jobManagers.add(manager);
		const session = Object.assign(createBudgetSession(sessionManager), { asyncJobManager: manager });
		const report: TaskReportReference = Object.freeze({
			version: 1,
			runId: "eval-budget-failure",
			status: "partial",
			reason: "failed",
		});
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			createResult({
				exitCode: 1,
				error: "agent failed",
				stderr: "agent failed",
				usage: createUsage(2_345),
				report,
			}),
		);

		const handle = await runEvalAgent({ prompt: "do work", agent: "task" }, { session });
		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({ status: "failed", error: "agent failed" });
		const job = manager.getJob(handle.id);
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toBe("agent failed");
		expect(job?.resultText).toBeUndefined();
		expect(job?.report).toBe(report);

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
		const manager = new AsyncJobManager({});
		jobManagers.add(manager);
		const session = Object.assign(createBudgetSession(sessionManager), { asyncJobManager: manager });
		const report: TaskReportReference = Object.freeze({
			version: 1,
			runId: "eval-budget-cleanup-failure",
			status: "complete",
			artifact: Object.freeze({ id: "102", uri: "artifact://102", sha256: "b".repeat(64), bytes: 4 }),
		});
		cfgTaskIsolationEnabled.set(session.settings, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" });
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			options.onSubprocessResult?.(createResult({ usage: createUsage(4_567), report }));
			throw new Error("cleanup failed");
		});

		const handle = await runEvalAgent({ prompt: "do work", agent: "task", isolated: true }, { session });
		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({
			status: "failed",
			error: expect.stringContaining("Subagent execution failed: cleanup failed"),
		});
		const job = manager.getJob(handle.id);
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toContain("Subagent execution failed: cleanup failed");
		expect(job?.resultText).toBeUndefined();
		expect(job?.report).toBe(report);
		expect(job?.report?.status).toBe("complete");
		expect(job?.report?.reason).toBeUndefined();

		expect(sessionManager.getTurnBudget().spent).toBe(4_567);
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
