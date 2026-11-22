import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import { runEvalWait } from "../../src/eval/handle-bridge";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import * as taskDiscovery from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

/**
 * The eval bridges own no role policy: they hand the caller's raw `modelRole`
 * to the shared preflight and to the child dispatch so one central check
 * decides. Only agent discovery and the child process are stubbed, so these
 * observe the route each child actually launches on.
 */

const ROLES = { smol: "mock/fast", slow: "mock/deep", task: "mock/task-route" };

const AGENT: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	model: ["@task"],
};

const managers = new Set<AsyncJobManager>();

function makeSession(): ToolSession {
	const asyncJobManager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(asyncJobManager);
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.maxConcurrency": 2,
			"task.perCallModel": "on",
			modelRoles: ROLES,
		}),
		asyncJobManager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
	};
}

function stubChild() {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
	const launched: ExecutorOptions[] = [];
	const firstLaunch = Promise.withResolvers<void>();
	vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
		launched.push(options);
		firstLaunch.resolve();
		return {
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
	});
	return { launched, firstLaunch: firstLaunch.promise };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers) await manager.dispose();
	managers.clear();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
	resetRegisteredArtifactDirsForTests();
});

describe("eval agent() modelRole", () => {
	it.each([
		{ args: { modelRole: "smol" }, model: ROLES.smol, role: "smol" },
		{ args: {}, model: ROLES.task, role: "task" },
	])("launches the child for $args on its route", async ({ args, model, role }) => {
		const { launched } = stubChild();
		const session = makeSession();
		const handle = await runEvalAgent({ prompt: "work", ...args }, { session });
		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		expect(waited.items[0]?.status).toBe("completed");
		expect(launched.map(options => ({ model: options.modelOverride, role: options.modelRole }))).toEqual([
			{ model: [model], role },
		]);
	});

	it.each([
		{ args: { modelRole: 42 }, error: /Invalid `modelRole`/ },
		{ args: { modelRole: "default" }, error: /Invalid `modelRole`/ },
		{ args: { modelRole: "smol", model: "p/exact" }, error: /both `modelRole` and `model`/ },
	])("rejects $args before allocating a handle", async ({ args, error }) => {
		const { launched } = stubChild();
		const session = makeSession();
		await expect(runEvalAgent({ prompt: "work", ...args }, { session })).rejects.toThrow(error);
		expect(session.asyncJobManager?.getAllJobs()).toHaveLength(0);
		expect(launched).toHaveLength(0);
	});
});

describe("eval workpool() modelRole", () => {
	it.each([
		{ args: { modelRole: "slow" }, model: ROLES.slow, role: "slow" },
		{ args: {}, model: ROLES.task, role: "task" },
	])("launches each new worker for $args on its route", async ({ args, model, role }) => {
		const { launched, firstLaunch } = stubChild();
		const session = makeSession();
		await runEvalWorkpool({ op: "create", name: "tiered", ...args }, { session });
		await runEvalWorkpool({ op: "push", name: "tiered", items: ["one"] }, { session });
		await firstLaunch;
		expect(launched.map(options => ({ model: options.modelOverride, role: options.modelRole }))).toEqual([
			{ model: [model], role },
		]);
		WorkPoolRegistry.global().get("Main", "tiered")?.close();
	});

	it.each([
		{ args: { modelRole: false }, error: /Invalid `modelRole`/ },
		{ args: { modelRole: "smol:high" }, error: /Invalid `modelRole`/ },
		{ args: { modelRole: "slow", model: "p/exact" }, error: /both `modelRole` and `model`/ },
	])("rejects $args before registering a pool", async ({ args, error }) => {
		const { launched } = stubChild();
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "create", name: "bad", ...args }, { session })).rejects.toThrow(error);
		expect(WorkPoolRegistry.global().get("Main", "bad")).toBeUndefined();
		expect(launched).toHaveLength(0);
	});
});
