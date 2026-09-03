/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the irc follow-up / `history://<id>` hint.
 * 2. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (missing agent / missing task) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
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
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

describe("task spawn routing", () => {
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

	it("returns immediately on spawn and delivers the follow-up hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ ...taskAgent, model: ["anthropic/claude-sonnet-4"] }],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "task.agentModelOverrides": { task: "openai/gpt-4.1-mini" } } }),
		);

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			name: "Spawnling",
			task: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("Spawnling is now idle");
		expect(job!.resultText).toContain("message it via `hub` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual(["openai/gpt-4.1-mini"]);
	});

	it("retains the temporary artifacts directory for a completed async spawn (in-memory session)", async () => {
		// Regression: with no session file (in-memory session), leaseArtifacts()
		// allocates a temporary directory that runStructuredSubagent() deletes
		// on completion unless retainArtifacts is requested. Detached (async)
		// spawns advertise `agent://<id>` handles in the eventual async-result
		// delivery, so the directory must survive past this call returning
		// (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-retain", {
			agent: "task",
			name: "Retainling",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(capturedArtifactsDir).toBeTruthy();
		await expect(fs.stat(capturedArtifactsDir!)).resolves.toBeDefined();
		await fs.rm(capturedArtifactsDir!, { recursive: true, force: true });
	});

	it("cleans up the retained artifacts directory once the job is evicted", async () => {
		// Regression: retainArtifacts kept the temp directory alive past
		// completion, but nothing ever deleted it afterward — a long-running
		// SDK process accumulated every detached task's transcript forever.
		// Cleanup must run once the job actually leaves the manager (eviction
		// or disposal), not never (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		// Cleanup runs fire-and-forget off the job's own settle chain; spy on
		// the real `fs.rm` call to await its actual completion instead of
		// guessing a wait duration.
		const rmCalled = deferred();
		const realRm = fs.rm.bind(fs);
		vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
			const outcome = await realRm(target as Parameters<typeof fs.rm>[0], opts as Parameters<typeof fs.rm>[1]);
			if (capturedArtifactsDir && target === capturedArtifactsDir) rmCalled.resolve();
			return outcome;
		});

		// retentionMs: 0 evicts synchronously once the job settles so the
		// test does not have to wait out the real 5-minute default
		// retention window.
		const manager = new AsyncJobManager({
			onJobComplete: () => {},
			retentionMs: 0,
			retainedArtifactsCleanupGraceMs: 0,
		});
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-evict", {
			agent: "task",
			name: "Evictling",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(capturedArtifactsDir).toBeTruthy();
		expect(manager.getJob(jobId!)).toBeUndefined();
		await rmCalled.promise;
		await expect(fs.stat(capturedArtifactsDir!)).rejects.toThrow();
	});

	it("attaches retained-artifacts cleanup to the collision-suffixed job, not the pre-existing row", async () => {
		// Regression: `AsyncJobManager.register()` suffixes the requested job
		// id when it collides with another live job (e.g. a task id reusing a
		// vibe turn's job id). The cleanup wiring looked the job back up by
		// the *requested* id, which — after a collision — resolves to the
		// unrelated pre-existing row instead of the newly registered task, so
		// cleanup attached to (and could later delete artifacts alongside)
		// the wrong job (PR #10625 review).
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		let capturedArtifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedArtifactsDir = options.artifactsDir;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		// Placeholder job occupying "Foo", the id the fresh task would
		// otherwise be allocated — its own agent output id is unique per
		// AgentOutputManager, independent of the job manager's id map, so
		// this simulates the collision without needing a second spawn.
		const placeholderGate = deferred();
		manager.register(
			"bash",
			"placeholder",
			async () => {
				await placeholderGate.promise;
				return "placeholder done";
			},
			{ id: "Foo" },
		);

		const tool = await TaskTool.create(createSession({ manager }));
		const result = await tool.execute("tc-collide", {
			agent: "task",
			name: "Foo",
			task: "Do the thing.",
		} as TaskParams);

		const jobId = result.details?.async?.jobId;
		expect(jobId).toBe("Foo-2");
		const job = manager.getJob(jobId!);
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.retainedArtifactsCleanup).toBeDefined();
		const placeholder = manager.getJob("Foo");
		expect(placeholder!.retainedArtifactsCleanup).toBeUndefined();

		placeholderGate.resolve();
		if (capturedArtifactsDir) await fs.rm(capturedArtifactsDir, { recursive: true, force: true });
	});

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the
		// semaphore — still flagged queued because markRunning never ran.
		await pollUntil(() => started.length >= 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled spawn while it is queued behind the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		const queuedResult = await Promise.race([
			secondJob.promise.then(() => "settled" as const),
			Bun.sleep(75).then(() => "timeout" as const),
		]);

		gates.get("First")!.resolve();
		await firstJob.promise;
		await secondJob.promise;

		expect(queuedResult).toBe("settled");
		expect(started).toEqual(["First"]);
		expect(secondJob.status).toBe("cancelled");
	});

	it("keeps the concurrency cap intact when a queued spawn is cancelled (no permit leak)", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		// A holds the only permit, gated inside the executor.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		// B parks at the semaphore, then is cancelled while queued. Its
		// teardown must NOT release a permit it never acquired.
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		expect(secondJob.status).toBe("cancelled");

		// C must stay parked while A still holds the cap. A phantom release
		// from B's cancellation would admit C here, running 2 bodies at cap 1.
		const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First"]);
		expect(thirdJob.queued).toBe(true);

		// A finishing admits C — the cap still cycles normally.
		gates.get("First")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Third"]);

		// D queued behind running C stays serialized: if B's teardown had
		// double-released, two permits would be free and D would start now.
		const fourth = await tool.execute("tc-4", { agent: "task", name: "Fourth", task: "Work D." } as TaskParams);
		const fourthJob = manager.getJob(fourth.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First", "Third"]);
		expect(fourthJob.queued).toBe(true);

		gates.get("Third")!.resolve();
		await thirdJob.promise;
		await pollUntil(() => started.length === 3);
		gates.get("Fourth")!.resolve();
		await fourthJob.promise;

		expect(started).toEqual(["First", "Third", "Fourth"]);
		expect(firstJob.status).toBe("completed");
		expect(thirdJob.status).toBe("completed");
		expect(fourthJob.status).toBe("completed");
	});

	for (const maxConcurrency of [0, 0.5]) {
		it(`runs spawn job bodies unbounded when task.maxConcurrency is ${maxConcurrency}`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const started: string[] = [];
			const gates = new Map<string, Deferred>();
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const id = options.id ?? "?";
				started.push(id);
				const gate = deferred();
				gates.set(id, gate);
				await gate.promise;
				return makeResult(id);
			});

			const manager = createManager();
			const tool = await TaskTool.create(
				createSession({ manager, settings: { "task.maxConcurrency": maxConcurrency } }),
			);

			const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);

			// All three job bodies clear the spawn semaphore in parallel — none stays queued.
			await pollUntil(() => started.length === 3);
			expect(started.sort()).toEqual(["First", "Second", "Third"]);

			for (const id of ["First", "Second", "Third"]) gates.get(id)!.resolve();
			await Promise.all([
				manager.getJob(first.details!.async!.jobId)!.promise,
				manager.getJob(second.details!.async!.jobId)!.promise,
				manager.getJob(third.details!.async!.jobId)!.promise,
			]);
		});
	}

	it("re-reads task.maxConcurrency on each spawn so a mid-session change applies on the next acquire", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		// Prime the semaphore at the initial high cap.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		// Tighten the cap mid-session. The next spawn MUST see the new ceiling.
		settings.override("task.maxConcurrency", 1);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First is still running (and holding the only slot under the new cap),
		// so Second is parked at the semaphore — queued, not running.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing First admits Second.
		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
	});

	it("applies a lowered maxConcurrency to work already queued in the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const jobs: AsyncJob[] = [];
		for (const id of ["First", "Second", "Third", "Fourth", "Fifth"]) {
			const result = await tool.execute(`tc-${id}`, { agent: "task", name: id, task: `Work ${id}.` } as TaskParams);
			jobs.push(manager.getJob(result.details!.async!.jobId)!);
		}
		const fifthJob = jobs[4]!;

		await pollUntil(() => started.length === 4);
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		settings.override("task.maxConcurrency", 1);
		gates.get("First")!.resolve();
		await jobs[0]!.promise;
		await Promise.resolve();
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		for (const id of ["Second", "Third", "Fourth"]) gates.get(id)!.resolve();
		await pollUntil(() => started.length === 5);
		expect([...started].sort()).toEqual(["Fifth", "First", "Fourth", "Second", "Third"]);

		gates.get("Fifth")!.resolve();
		await Promise.all(jobs.map(job => job.promise));
	});
});
