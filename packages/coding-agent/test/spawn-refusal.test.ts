/**
 * Contracts: `task.concurrencyPolicy` — what a spawn does when every
 * `task.maxConcurrency` slot is already taken.
 *
 * 1. `"queue"` (the default) preserves the historic behavior byte for byte:
 *    the spawn parks in the session semaphore FIFO and starts when a slot frees.
 * 2. `"refuse"` fails the spawn instead of parking it, with a model-visible
 *    error naming the running count, the waiting count (when any) and the
 *    configured limit, and telling the model not to retry.
 * 3. `SpawnRun`'s permit is the single refusal point, taken main-side before
 *    `runSubprocess` — so a refused spawn never reaches the executor (and
 *    therefore never a worker thread), and a refused run never runs its body.
 * 4. A refused spawn reports `refusalReason` on the existing
 *    `task:subagent:progress` frame — no new event channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { Semaphore } from "@oh-my-pi/pi-coding-agent/task/parallel";
import { cfgTaskConcurrencyPolicy } from "@oh-my-pi/pi-coding-agent/task/settings";
import { SpawnRefusedError, SpawnRun } from "@oh-my-pi/pi-coding-agent/task/spawn-run";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	type SubagentProgressPayload,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

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

function createSession(options: {
	manager?: AsyncJobManager;
	settings?: Record<string, unknown> | Settings;
	eventBus?: EventBus;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: options.settings instanceof Settings ? options.settings : Settings.isolated(options.settings ?? {}),
		eventBus: options.eventBus,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
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

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

const CONCURRENCY_REFUSAL = (running: string, limit: number, waiting?: number): string =>
	`Concurrent subagent limit reached (${running}${waiting === undefined ? "" : `, ${waiting} waiting`}; ` +
	`task.maxConcurrency=${limit}). Do not retry; wait for running tasks or ask the user to raise task.maxConcurrency.`;

describe("spawn semaphore refusal seam", () => {
	it("takes a slot without queueing and reports the live counts", async () => {
		const semaphore = new Semaphore(1);
		expect(semaphore.running).toBe(0);
		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.running).toBe(1);
		// Full: the non-blocking take declines instead of parking the caller.
		expect(semaphore.tryAcquire()).toBe(false);
		expect(semaphore.waiting).toBe(0);

		// A queueing acquire still parks and is admitted by the release.
		const parked = semaphore.acquire();
		expect(semaphore.waiting).toBe(1);
		semaphore.release();
		await parked;
		expect(semaphore.running).toBe(1);
		expect(semaphore.waiting).toBe(0);
	});

	it("always admits when task.maxConcurrency is unlimited", () => {
		const semaphore = new Semaphore(0);
		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.tryAcquire()).toBe(true);
		expect(semaphore.running).toBe(2);
	});

	it("never runs a refused run's body and never releases a slot it did not take", async () => {
		let releases = 0;
		let bodyRan = false;
		const run = new SpawnRun(
			{
				acquire: async () => {
					throw new SpawnRefusedError({ running: 1, waiting: 0, limit: 1 });
				},
				release: () => {
					releases += 1;
				},
			},
			async () => {
				bodyRan = true;
				return { content: [{ type: "text", text: "done" }] } as AgentToolResult<TaskToolDetails>;
			},
			{ detached: false },
		);

		await expect(run.started).rejects.toBeInstanceOf(SpawnRefusedError);
		await expect(run.result).rejects.toBeInstanceOf(SpawnRefusedError);
		expect(bodyRan).toBe(false);
		expect(releases).toBe(0);
	});
});

describe("SpawnRefusedError", () => {
	it("names the running count, the configured limit and the no-retry instruction", () => {
		const error = new SpawnRefusedError({ running: 3, waiting: 0, limit: 3 });
		expect(error.message).toBe(CONCURRENCY_REFUSAL("3 running", 3));
		expect(error.message).toContain("Do not retry");
		expect(error.reason).toBe("concurrency_limit");
		expect(error.running).toBe(3);
		expect(error.waiting).toBe(0);
		expect(error.limit).toBe(3);
	});

	it("adds the waiting count when other spawns are parked behind the cap", () => {
		const error = new SpawnRefusedError({ running: 1, waiting: 2, limit: 1 });
		expect(error.message).toBe(CONCURRENCY_REFUSAL("1 running", 1, 2));
	});
});

describe("task.concurrencyPolicy", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** Gates every executor body so a spawn can hold its permit while the test inspects the next one. */
	function gateExecutions(): {
		started: string[];
		gates: Map<string, PromiseWithResolvers<void>>;
	} {
		const started: string[] = [];
		const gates = new Map<string, PromiseWithResolvers<void>>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});
		return { started, gates };
	}

	it("defaults to queue", () => {
		expect(cfgTaskConcurrencyPolicy.get(Settings.isolated())).toBe("queue");
	});

	it("keeps the queue policy: a spawn over the cap waits for a slot instead of failing", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		await Promise.resolve();
		// Parked, not failed: the historic behavior is untouched — nothing but a
		// release can admit it, so flushing the microtask queue is enough to see it.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);
		expect(secondJob.status).toBe("running");

		gates.get("First")!.resolve();
		await pollUntil(() => started.length === 2);
		gates.get("Second")!.resolve();
		await Promise.all([firstJob.promise, secondJob.promise]);
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("refuses a background spawn over the cap with the running count and the limit", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "task.maxConcurrency": 1, "task.concurrencyPolicy": "refuse" },
			}),
		);

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		await secondJob.promise;

		expect(secondJob.status).toBe("failed");
		expect(secondJob.errorText).toBe(CONCURRENCY_REFUSAL("1 running", 1));
		// Refusal is main-side: the refused spawn never reached the executor.
		expect(started).toEqual(["First"]);

		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
	});

	it("refuses an inline blocking spawn with a tool error the model can act on", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "task.maxConcurrency": 1, "task.concurrencyPolicy": "refuse", "async.enabled": true },
			}),
		);

		const first = tool.execute("tc-1", { agent: "scout", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-2", { agent: "scout", name: "Second", task: "Work B." } as TaskParams);
		expect(second.isError).toBe(true);
		expect(second.content.find(part => part.type === "text")?.text).toBe(
			`Task Second failed: ${CONCURRENCY_REFUSAL("1 running", 1)}`,
		);

		gates.get("First")!.resolve();
		await first;
	});

	it("refuses the blocking item of a mixed batch, keeps the sibling job, and frames the refusal", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const eventBus = new EventBus();
		const frames: SubagentProgressPayload[] = [];
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
			frames.push(data as SubagentProgressPayload);
		});
		const tool = await TaskTool.create(
			createSession({
				manager,
				eventBus,
				settings: {
					"task.batch": true,
					"task.maxConcurrency": 1,
					"task.concurrencyPolicy": "refuse",
					"async.enabled": true,
				},
			}),
		);

		// The non-blocking sibling registers as a background job and takes the only
		// slot first, so the inline (blocking) item of the same batch is refused,
		// not queued.
		const result = await tool.execute("tc-mixed", {
			context: "Shared context.",
			tasks: [
				{ agent: "task", name: "Background", task: "Work A." },
				{ agent: "scout", name: "Inline", task: "Work B." },
			],
		} as TaskParams);

		expect(result.isError).toBe(true);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain(`Task Inline failed: ${CONCURRENCY_REFUSAL("1 running", 1)}`);
		// The sibling kept running: only the refused item failed.
		const background = manager.getJob("Background");
		expect(background).toBeDefined();
		expect(frames.find(frame => frame.refusalReason !== undefined)).toMatchObject({
			refusalReason: "concurrency_limit",
			detached: false,
			index: 1,
			progress: { id: "Inline", status: "failed" },
		});

		await pollUntil(() => started.length === 1);
		gates.get("Background")!.resolve();
		await background!.promise;
		expect(background!.status).toBe("completed");
	});

	it("counts parked spawns when the policy flips mid-session", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 1 });
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings,
			}),
		);

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);
		// Second parks under the default queue policy.
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		await pollUntil(() => secondJob.queued === true);

		cfgTaskConcurrencyPolicy.override(settings, "refuse");
		const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await thirdJob.promise;

		expect(thirdJob.status).toBe("failed");
		expect(thirdJob.errorText).toBe(CONCURRENCY_REFUSAL("1 running", 1, 1));

		// The already-parked spawn keeps its place: the policy applies at acquire time.
		gates.get("First")!.resolve();
		await pollUntil(() => started.length === 2);
		gates.get("Second")!.resolve();
		await Promise.all([manager.getJob(first.details!.async!.jobId)!.promise, secondJob.promise]);
		expect(secondJob.status).toBe("completed");
	});

	it("reports refusalReason on the existing subagent progress frame", async () => {
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const eventBus = new EventBus();
		const frames: SubagentProgressPayload[] = [];
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
			frames.push(data as SubagentProgressPayload);
		});
		const tool = await TaskTool.create(
			createSession({
				manager,
				eventBus,
				settings: { "task.maxConcurrency": 1, "task.concurrencyPolicy": "refuse" },
			}),
		);

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		await manager.getJob(second.details!.async!.jobId)!.promise;

		const refusal = frames.find(frame => frame.refusalReason !== undefined);
		expect(refusal).toBeDefined();
		expect(refusal).toMatchObject({
			refusalReason: "concurrency_limit",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			detached: true,
			progress: { id: "Second", status: "failed" },
		});
		// A refused spawn never created a child session, so the frame links no transcript.
		expect(refusal?.sessionFile).toBeUndefined();

		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
	});

	it("refuses before dispatch when subagents run on worker threads", async () => {
		// Worker placement happens inside `runSubprocess`; the permit is taken in
		// `SpawnRun` before that call, so a refusal never reaches placement. A real
		// worker needs a CLI worker host, which unit tests do not have — the flag is
		// what the placement decision reads, so it is set here.
		const { started, gates } = gateExecutions();
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"task.maxConcurrency": 1,
					"task.concurrencyPolicy": "refuse",
					"task.workerThreads": 4,
				},
			}),
		);

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		await secondJob.promise;

		expect(secondJob.status).toBe("failed");
		expect(secondJob.errorText).toBe(CONCURRENCY_REFUSAL("1 running", 1));
		expect(started).toEqual(["First"]);

		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
	});
});
