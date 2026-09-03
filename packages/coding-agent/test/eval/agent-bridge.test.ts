import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult, StructuredSubagentOutput } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			mcpManager,
			localProtocolOptions,
			getAgentId: () => "BridgeParent",
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
		expect(options?.parentAgentId).toBe("BridgeParent");
	});

	it("returns executor-parsed structured data through the public eval bridge", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
			output: { type: "object" },
		};
		const structuredOutput: StructuredSubagentOutput = {
			source: "agent",
			mode: "strict",
			status: "valid",
			data: { status: "ok" },
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ output: "not JSON", structuredOutput }));
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		} as unknown as ToolSession;

		const result = await runEvalAgent({ prompt: "do work", agent: "task", schemaMode: "strict" }, { session });

		expect(result.data).toEqual({ status: "ok" });
		expect(result.details).toMatchObject({ structured: true, schemaSource: "agent", schemaMode: "strict" });
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

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session: createBudgetSession(sessionManager) });

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
			runEvalAgent({ prompt: "do work", agent: "task" }, { session: createBudgetSession(sessionManager) }),
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
		session.settings.set("task.isolation.enabled", true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
			baseline: {
				root: {
					repoRoot: "/tmp",
					headCommit: "base",
					staged: "",
					unstaged: "",
					untracked: [],
					untrackedPatch: "",
				},
				nested: [],
			},
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			options.onSubprocessResult?.(createResult({ usage: createUsage(4_567) }));
			throw new Error("cleanup failed");
		});

		await expect(runEvalAgent({ prompt: "do work", agent: "task", isolated: true }, { session })).rejects.toThrow(
			"cleanup failed",
		);

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
