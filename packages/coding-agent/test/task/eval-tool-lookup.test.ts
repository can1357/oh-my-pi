/**
 * Eval-defined tool descriptors resolve once per task call: dispatch queries
 * the retained kernels one time for the union of every item's `tools` names,
 * and preflight, the sync fan-out, and background job bodies all reuse the
 * resolved descriptors instead of re-querying per item per phase.
 *
 * The JavaScript kernel is real (a retained worker), so the spies count
 * actual kernel round-trips — `invokeJsTool` describe requests and
 * `describePythonTools` — not wiring.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as jsContext from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import * as pyExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

/**
 * Shared retained JS worker identity: `describeEvalTools` resolves the same
 * session key from the tool session, so kernel describes hit this worker.
 * Spawning it once serves every test in this file.
 */
const EVAL_SESSION_ID = "task-eval-tool-lookup";
const JS_KERNEL_KEY = `js:${EVAL_SESSION_ID}`;

const managers = new Set<AsyncJobManager>();

function createSession(cwd: string, settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.enabled": false, "async.enabled": false, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getEvalSessionId: () => EVAL_SESSION_ID,
	} as unknown as ToolSession;
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

/** Define (or redefine) `word_count` in the shared retained JS kernel. */
async function defineKernelTool(cwd: string, description: string): Promise<void> {
	const result = await executeJs(
		`tool(function word_count() { return { count: 1 }; }, { description: ${JSON.stringify(description)} })`,
		{ sessionId: JS_KERNEL_KEY, session: createSession(cwd), cwd },
	);
	if (result.exitCode !== 0) throw new Error(`JS kernel cell failed: ${result.output}`);
}

/** A batch call body whose three items all request the same eval tool. */
function threeItemBatch(): TaskParams {
	return {
		context: "Shared background for the batch.",
		tasks: [
			{ task: "one", tools: ["word_count"] },
			{ task: "two", tools: ["word_count"] },
			{ task: "three", tools: ["word_count"] },
		],
	};
}

beforeEach(() => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	await Promise.all([...managers].map(manager => manager.dispose()));
	managers.clear();
});
afterAll(async () => {
	await jsContext.disposeAllVmContexts();
	await pyExecutor.disposeAllKernelSessions();
});

describe("task eval tool descriptor lookups", () => {
	it("queries the kernels once for a sync batch call whose items share one eval tool", async () => {
		using tempDir = TempDir.createSync("@omp-task-eval-lookup-sync-");
		const session = createSession(tempDir.path(), { "task.batch": true });
		await defineKernelTool(tempDir.path(), "Count words");
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const jsSpy = vi.spyOn(jsContext, "invokeJsTool");
		const pySpy = vi.spyOn(pyExecutor, "describePythonTools");

		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-sync-dedup", threeItemBatch());

		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(3);
		for (const call of run.mock.calls) {
			expect(call[0]?.customTools?.map(custom => custom.name)).toEqual(["word_count"]);
		}
		const jsDescribes = jsSpy.mock.calls.filter(([request]) => request.op === "describe");
		expect(jsDescribes).toHaveLength(1);
		expect(jsDescribes[0]?.[0]).toMatchObject({ names: ["word_count"] });
		expect(pySpy).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("queries the kernels once when the batch items run as background jobs", async () => {
		using tempDir = TempDir.createSync("@omp-task-eval-lookup-async-");
		const manager = new AsyncJobManager({ retentionMs: 0 });
		managers.add(manager);
		const session = {
			...createSession(tempDir.path(), { "task.batch": true, "async.enabled": true }),
			asyncJobManager: manager,
		} as unknown as ToolSession;
		await defineKernelTool(tempDir.path(), "Count words");
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const jsSpy = vi.spyOn(jsContext, "invokeJsTool");
		const pySpy = vi.spyOn(pyExecutor, "describePythonTools");

		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-async-dedup", threeItemBatch());
		await manager.waitForAll();

		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(3);
		for (const call of run.mock.calls) {
			expect(call[0]?.customTools?.map(custom => custom.name)).toEqual(["word_count"]);
		}
		const jsDescribes = jsSpy.mock.calls.filter(([request]) => request.op === "describe");
		expect(jsDescribes).toHaveLength(1);
		expect(jsDescribes[0]?.[0]).toMatchObject({ names: ["word_count"] });
		expect(pySpy).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("sees a redefined tool description on the next task call", async () => {
		using tempDir = TempDir.createSync("@omp-task-eval-lookup-stale-");
		const session = createSession(tempDir.path());
		await defineKernelTool(tempDir.path(), "Count words");
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const jsSpy = vi.spyOn(jsContext, "invokeJsTool");
		const tool = await TaskTool.create(session);

		const first = await tool.execute("tc-stale-first", { task: "count", tools: ["word_count"] } as TaskParams);
		expect(first.isError).not.toBe(true);
		expect(run.mock.calls[0]?.[0].customTools?.[0]?.description).toBe("Count words");

		await defineKernelTool(tempDir.path(), "Count characters");

		const second = await tool.execute("tc-stale-second", {
			task: "count again",
			tools: ["word_count"],
		} as TaskParams);
		expect(second.isError).not.toBe(true);
		expect(run.mock.calls[1]?.[0].customTools?.[0]?.description).toBe("Count characters");

		// One describe per task call: the resolved descriptors never survive
		// the call that produced them.
		const wordCountDescribes = jsSpy.mock.calls.filter(
			([request]) => request.op === "describe" && request.names.includes("word_count"),
		);
		expect(wordCountDescribes).toHaveLength(2);
	}, 60_000);

	it("reports unknown eval tools once per call", async () => {
		using tempDir = TempDir.createSync("@omp-task-eval-lookup-unknown-");
		const session = createSession(tempDir.path());
		await defineKernelTool(tempDir.path(), "Count words");
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id));
		const jsSpy = vi.spyOn(jsContext, "invokeJsTool");

		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-unknown-tool", {
			task: "count",
			tools: ["no_such_tool"],
		} as TaskParams);

		expect(result.isError).toBe(true);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("Unknown eval tool(s): no_such_tool");
		expect(text.split("Unknown eval tool(s)").length - 1).toBe(1);
		expect(run).not.toHaveBeenCalled();
		const unknownDescribes = jsSpy.mock.calls.filter(
			([request]) => request.op === "describe" && request.names.includes("no_such_tool"),
		);
		expect(unknownDescribes).toHaveLength(1);
	}, 60_000);
	it("gives each item only its own tools when a batch mixes items with and without tools", async () => {
		using tempDir = TempDir.createSync("@omp-task-eval-lookup-mixed-");
		const session = createSession(tempDir.path(), { "task.batch": true });
		await defineKernelTool(tempDir.path(), "Count words");
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const jsSpy = vi.spyOn(jsContext, "invokeJsTool");

		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-mixed-items", {
			context: "Shared background for the batch.",
			tasks: [{ task: "one", tools: ["word_count"] }, { task: "two" }, { task: "three", tools: ["word_count"] }],
		} as TaskParams);

		expect(result.isError).not.toBe(true);
		expect(run).toHaveBeenCalledTimes(3);
		const toolNamesPerChild = run.mock.calls
			.map(call => call[0]?.customTools?.map(custom => custom.name)?.join(",") ?? "")
			.sort();
		expect(toolNamesPerChild).toEqual(["", "word_count", "word_count"]);
		const jsDescribes = jsSpy.mock.calls.filter(([request]) => request.op === "describe");
		expect(jsDescribes).toHaveLength(1);
		expect(jsDescribes[0]?.[0]).toMatchObject({ names: ["word_count"] });
	}, 60_000);
});
