/**
 * Reserved child tool names at the task and eval pre-dispatch boundary.
 *
 * Flat and batch `task.tools`, plus eval workpool tools, must fail with the
 * exact reservation error after the descriptor resolves, and must not spawn.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalWorkpool } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as evalTools from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const RESERVED: Array<"yield" | "handback"> = ["yield", "handback"];

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function createSession(settings: Record<string, unknown> = {}): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function mockResolvedDescriptors(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	vi.spyOn(evalTools, "describeEvalTools").mockImplementation(async (_session, names) =>
		names.map(name => ({
			name,
			description: `custom ${name}`,
			parameters: { type: "object", properties: {} },
			language: "python" as const,
		})),
	);
}

afterEach(async () => {
	vi.restoreAllMocks();
	WorkPoolRegistry.resetForTests();
	await Promise.all([...managers].map(manager => manager.dispose()));
	managers.clear();
});

describe("reserved task.tools names", () => {
	it.each(RESERVED)("flat task.tools resolving %s fails before any child spawn", async name => {
		mockResolvedDescriptors();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ "task.batch": false }));

		const result = await tool.execute(`flat-${name}`, { task: "report", tools: [name] } as TaskParams);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`tool name "${name}" is reserved`);
		expect(textOf(result)).not.toContain("Unknown eval tool");
		expect(run).not.toHaveBeenCalled();
	});

	it.each(RESERVED)("batch task.tools resolving %s fails before any child spawn", async name => {
		mockResolvedDescriptors();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ "task.batch": true }));

		const result = await tool.execute(`batch-${name}`, {
			context: "Shared background for the batch.",
			tasks: [
				{ task: "reserved child", tools: [name] },
				{ task: "ordinary child", tools: ["word_count"] },
			],
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`tool name "${name}" is reserved`);
		expect(textOf(result)).not.toContain("Unknown eval tool");
		expect(run).not.toHaveBeenCalled();
	});

	it("still spawns a flat child for a nonreserved custom tool", async () => {
		mockResolvedDescriptors();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("WordCount"));
		const tool = await TaskTool.create(createSession({ "task.batch": false }));

		const result = await tool.execute("flat-ok", { task: "count", tools: ["word_count"] } as TaskParams);

		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0].customTools?.map(tool => tool.name)).toEqual(["word_count"]);
	});
});

describe("reserved eval workpool tools", () => {
	it.each(RESERVED)("workpool create resolving %s fails before a pool exists", async name => {
		mockResolvedDescriptors();
		const run = vi.spyOn(executorModule, "runSubprocess");
		const session = createSession();

		await expect(
			runEvalWorkpool({ op: "create", name: `pool-${name}`, tools: [name] }, { session }),
		).rejects.toThrow(`tool name "${name}" is reserved`);
		expect(run).not.toHaveBeenCalled();
		expect(WorkPoolRegistry.global().get("Main", `pool-${name}`)).toBeUndefined();
	});
});
