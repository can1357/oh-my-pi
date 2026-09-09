/**
 * Contracts: per-item blocking split in `task` spawns.
 *
 * An item whose agent type declares `blocking: true` runs inline (the call
 * waits on its result); non-blocking items in the same call still spawn as
 * background jobs. Previously blocking was all-or-nothing per call: one scout
 * in a batch silently dragged every sibling down the sync path — no job ids
 * despite the tool description promising them, the whole turn blocked on the
 * slowest worker, and every spawn died with the turn signal.
 *
 * 1. A mixed batch splits: the blocking item's result returns inline, the
 *    non-blocking item registers a job that keeps running past the return.
 * 2. Returned details reflect settled jobs (async.state converges), and
 *    post-return job updates keep the inline results — they never regress to
 *    an empty-results skeleton.
 * 3. An all-blocking batch stays fully synchronous (no jobs).
 * 4. Async schedule failure in a mixed call still returns the inline results
 *    and reports the failed spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? { "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent, scoutAgent],
		projectAgentsDir: null,
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task per-item blocking split", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("runs blocking items inline while non-blocking siblings spawn as jobs", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const started: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const executePromise = tool.execute("tc-mixed", {
			context: "ctx",
			tasks: [
				{ name: "ScoutOne", agent: "scout", task: "Research A." },
				{ name: "WorkerOne", agent: "task", task: "Build B." },
			],
		} as TaskParams);

		// Both spawns run concurrently: the async job is registered immediately,
		// the blocking scout gates the call's return.
		const deadline = Date.now() + 2_000;
		while (started.length < 2) {
			if (Date.now() > deadline) throw new Error(`spawns never started: ${JSON.stringify(started)}`);
			await Bun.sleep(5);
		}
		const workerJob = manager.getJob("WorkerOne");
		expect(workerJob).toBeDefined();
		expect(workerJob!.status).toBe("running");

		// Releasing only the scout settles the call; the worker keeps running.
		gates.get("ScoutOne")!.resolve();
		const result = await executePromise;

		const text = firstText(result);
		expect(text).toContain('id="ScoutOne"');
		expect(text).toContain("ScoutOne output.");
		expect(text).toContain("Spawned 1 background agent");
		expect(text).toContain("- `WorkerOne` (job `WorkerOne`)");
		expect(text).not.toContain("WorkerOne output.");

		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutOne"]);
		expect(result.details?.async?.state).toBe("running");
		const progressById = new Map(result.details?.progress?.map(p => [p.id, p.status]));
		expect(progressById.get("ScoutOne")).toBe("completed");
		expect(progressById.get("WorkerOne")).toBe("running");
		expect(manager.getJob("WorkerOne")!.status).toBe("running");

		gates.get("WorkerOne")!.resolve();
		await manager.getJob("WorkerOne")!.promise;
		expect(manager.getJob("WorkerOne")!.status).toBe("completed");
	});

	it("keeps inline results in post-return job updates and converges async state", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const started: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const updates: Array<{ text: string; details: TaskToolDetails }> = [];
		const executePromise = tool.execute(
			"tc-mixed-settle",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutTwo", agent: "scout", task: "Research." },
					{ name: "WorkerTwo", agent: "task", task: "Build." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push({ text: firstText(update), details: update.details });
			},
		);

		const deadline = Date.now() + 2_000;
		while (started.length < 2) {
			if (Date.now() > deadline) throw new Error(`spawns never started: ${JSON.stringify(started)}`);
			await Bun.sleep(5);
		}

		// The async job settles BEFORE the blocking subset: the returned result
		// must already report the converged async state, not a stale "running".
		gates.get("WorkerTwo")!.resolve();
		await manager.getJob("WorkerTwo")!.promise;
		gates.get("ScoutTwo")!.resolve();
		const result = await executePromise;

		expect(result.details?.async?.state).toBe("completed");
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutTwo"]);

		// The job's completion update carries the shared aggregate — inline
		// results included — never an empty-results skeleton, and exactly once.
		const completionUpdates = updates.filter(u => u.text.includes("Background task WorkerTwo complete."));
		expect(completionUpdates).toHaveLength(1);
	});

	it("keeps an all-blocking batch fully synchronous", async () => {
		mockDiscovery();
		const executed: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executed.push(options.id ?? "?");
			return makeResult(options.id ?? "?", options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-all-blocking", {
			context: "ctx",
			tasks: [
				{ name: "ScoutA", agent: "scout", task: "Research A." },
				{ name: "ScoutB", agent: "scout", task: "Research B." },
			],
		} as TaskParams);

		expect(executed.sort()).toEqual(["ScoutA", "ScoutB"]);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(r => r.id).sort()).toEqual(["ScoutA", "ScoutB"]);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	it("returns inline results and reports the failure when async scheduling fails", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", options.agent.name),
		);

		// A running non-queued filler job exhausts maxRunningJobs, so the
		// worker spawn's registration throws while the scout still runs inline.
		const filler = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: () => {} });
		managers.push(manager);
		manager.register("bash", "filler", () => filler.promise, { id: "filler" });

		const tool = await TaskTool.create(createSession({ manager }));
		const result = await tool.execute("tc-mixed-schedfail", {
			context: "ctx",
			tasks: [
				{ name: "ScoutThree", agent: "scout", task: "Research." },
				{ name: "WorkerThree", agent: "task", task: "Build." },
			],
		} as TaskParams);
		filler.resolve("done");

		const text = firstText(result);
		expect(text).toContain('id="ScoutThree"');
		expect(text).toContain("Failed to schedule 1 spawn");
		expect(text).toContain("WorkerThree");
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutThree"]);
		expect(result.details?.async?.state).toBe("failed");
		expect(manager.getJob("WorkerThree")).toBeUndefined();
	});
});
