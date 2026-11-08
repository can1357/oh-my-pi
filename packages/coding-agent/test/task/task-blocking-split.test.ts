/**
 * Contracts: per-item blocking split in `task` spawns.
 *
 * An item whose agent type declares `blocking: true` holds the call (the
 * caller waits on its result); non-blocking items in the same call still
 * spawn as background jobs. Previously blocking was all-or-nothing per call:
 * one scout in a batch silently dragged every sibling down the sync path.
 *
 * 1. A mixed batch splits: the blocking item's result returns inline, the
 *    non-blocking item registers a job that keeps running past the return.
 * 2. Returned details reflect settled jobs (async.state converges), and
 *    post-return job updates keep the inline results — they never regress to
 *    an empty-results skeleton.
 * 3. An all-blocking batch that sees no message returns inline (no visible
 *    job, no delivery), with the same result as with async jobs off.
 * 4. Async schedule failure in a mixed call still returns the inline results
 *    and reports the failed spawn.
 * 5. A message (`ctx.toolCall.wakeSignal`) ends the wait: finished blocking
 *    items report inline, running ones continue as background jobs that
 *    deliver once; with async jobs off the call stays inline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
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

	it("yields a blocking child on a delivered wake and delivers its later result once", async () => {
		mockDiscovery();
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const deliveries: Array<{ jobId: string; text: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			await gate.promise;
			return makeResult(options.id ?? "?", options.agent.name);
		});
		const manager = new AsyncJobManager({
			onJobComplete: (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));
		const wake = new AbortController();
		const pending = tool.execute(
			"tc-wake",
			{
				context: "ctx",
				tasks: [{ name: "ScoutWake", agent: "scout", task: "Research." }],
			} as TaskParams,
			undefined,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await started.promise;
		wake.abort("aside");
		const result = await pending;

		// A delivered aside no longer waits for the blocking child. The returned
		// call names the continuing agent/job and the child stays observable.
		expect(firstText(result)).toContain("ScoutWake");
		expect(firstText(result)).toContain("Returned early so you can read an incoming message");
		expect(result.details?.async).toMatchObject({ state: "running", jobId: "ScoutWake", type: "task" });
		expect(manager.getJob("ScoutWake")?.status).toBe("running");

		gate.resolve();
		await manager.getJob("ScoutWake")?.promise;
		await manager.drainDeliveries({ timeoutMs: 100 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.jobId).toBe("ScoutWake");
		expect(deliveries[0]?.text).toContain("ScoutWake output.");
	});

	it("keeps blocking work inline when async jobs are disabled despite a wake", async () => {
		mockDiscovery();
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			await gate.promise;
			return makeResult(options.id ?? "?", options.agent.name);
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": true } }));
		const wake = new AbortController();
		const pending = tool.execute(
			"tc-async-off",
			{ context: "ctx", tasks: [{ name: "ScoutInline", agent: "scout", task: "Research." }] } as TaskParams,
			undefined,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await started.promise;
		wake.abort("aside");
		gate.resolve();
		const result = await pending;

		// Jobs are deliberately off: the child remains inside the caller turn.
		expect(firstText(result)).toContain("ScoutInline output.");
		expect(result.details?.async).toBeUndefined();
	});

	it("reports a finished blocking sibling inline and hands only the running one to the background on a wake", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const started = new Set<string>();
		const bothStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			started.add(id);
			if (started.size === 2) bothStarted.resolve();
			await gate.promise;
			return makeResult(id, options.agent.name);
		});
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ onJobComplete: (jobId, text) => void deliveries.push({ jobId, text }) });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));
		const wake = new AbortController();
		const pending = tool.execute(
			"tc-fanout-wake",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutFast", agent: "scout", task: "Quick." },
					{ name: "ScoutSlow", agent: "scout", task: "Slow." },
				],
			} as TaskParams,
			undefined,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await bothStarted.promise;
		gates.get("ScoutFast")!.resolve();
		await manager.getJob("ScoutFast")?.promise;
		wake.abort("irc");
		const result = await pending;

		// The finished sibling's result is in this call; it never also arrives
		// as a background delivery. The running one continues as a job.
		const text = firstText(result);
		expect(text).toContain("ScoutFast output.");
		expect(text).toContain("`ScoutSlow` (job `ScoutSlow`)");
		expect(text).not.toContain("ScoutSlow output.");
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutFast"]);
		expect(result.details?.async?.state).toBe("running");
		expect(manager.getRunningJobs().map(job => job.id)).toEqual(["ScoutSlow"]);

		gates.get("ScoutSlow")!.resolve();
		await manager.getJob("ScoutSlow")?.promise;
		await manager.drainDeliveries({ timeoutMs: 100 });
		expect(deliveries.map(delivery => delivery.jobId)).toEqual(["ScoutSlow"]);
	});

	it("hands a mixed call's blocking subset to the background on a wake and lists both kinds of job", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const bothStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			if (gates.size === 2) bothStarted.resolve();
			await gate.promise;
			return makeResult(id, options.agent.name);
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const wake = new AbortController();
		const pending = tool.execute(
			"tc-mixed-wake",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutMix", agent: "scout", task: "Research." },
					{ name: "WorkerMix", agent: "task", task: "Build." },
				],
			} as TaskParams,
			undefined,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await bothStarted.promise;
		wake.abort("aside");
		const result = await pending;

		const text = firstText(result);
		expect(text).toContain("`ScoutMix` (job `ScoutMix`)");
		expect(text).toContain("- `WorkerMix` (job `WorkerMix`)");
		expect(result.details?.results).toEqual([]);
		expect(result.details?.async?.state).toBe("running");
		expect(
			manager
				.getRunningJobs()
				.map(job => job.id)
				.sort(),
		).toEqual(["ScoutMix", "WorkerMix"]);
		for (const gate of gates.values()) gate.resolve();
		await Promise.all([manager.getJob("ScoutMix")?.promise, manager.getJob("WorkerMix")?.promise]);
	});

	it("returns the aborted inline result and leaves no job behind when the call is cancelled", async () => {
		mockDiscovery();
		const started = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			if (options.signal?.aborted) resolve();
			else options.signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			return makeResult(options.id ?? "?", options.agent.name, { aborted: true, exitCode: 1 });
		});
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (_jobId, text) => void deliveries.push(text) });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));
		const cancel = new AbortController();
		const pending = tool.execute(
			"tc-abort",
			{ context: "ctx", tasks: [{ name: "ScoutAbort", agent: "scout", task: "Research." }] } as TaskParams,
			cancel.signal,
		);
		await started.promise;
		cancel.abort();
		const result = await pending;

		expect(result.details?.results.map(r => [r.id, r.aborted])).toEqual([["ScoutAbort", true]]);
		expect(result.details?.async).toBeUndefined();
		await manager.drainDeliveries({ timeoutMs: 100 });
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(deliveries).toHaveLength(0);
	});

	it("returns the same result with async jobs on as inline when no message arrives", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", options.agent.name),
		);
		const params = {
			context: "ctx",
			tasks: [{ name: "ScoutSame", agent: "scout", task: "Research." }],
		} as TaskParams;
		const manager = createManager();
		const hosted = await (
			await TaskTool.create(createSession({ manager }))
		).execute("tc-same-hosted", params, undefined, undefined, {
			toolCall: { wakeSignal: new AbortController().signal },
		} as AgentToolContext);
		AgentRegistry.resetGlobalForTests();
		const inline = await (
			await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": true } }))
		).execute("tc-same-inline", params);

		// A blocking call that sees no message keeps the inline result contract.
		// `duration` is the child's wall clock, the one field the two runs cannot share.
		const stable = (text: string) => text.replace(/duration="[^"]*"/, 'duration=""');
		expect(stable(firstText(hosted))).toBe(stable(firstText(inline)));
		expect(hosted.isError).toBe(inline.isError);
		expect(hosted.details?.results).toEqual(inline.details?.results);
		expect(hosted.details?.async).toBeUndefined();
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	it("cancels the child when the call is cancelled right after a wake", async () => {
		// A wake that lands with a cancellation must not hand a cancelled
		// child to the background, where it would keep running and deliver.
		mockDiscovery();
		const started = Promise.withResolvers<void>();
		let childAborted = false;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			if (options.signal?.aborted) resolve();
			else options.signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			childAborted = true;
			return makeResult(options.id ?? "?", options.agent.name, { aborted: true, exitCode: 1 });
		});
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (_jobId, text) => void deliveries.push(text) });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager }));
		const wake = new AbortController();
		const cancel = new AbortController();
		const pending = tool.execute(
			"tc-wake-then-abort",
			{ context: "ctx", tasks: [{ name: "ScoutRace", agent: "scout", task: "Research." }] } as TaskParams,
			cancel.signal,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await started.promise;
		wake.abort("aside");
		cancel.abort();
		const result = await pending;

		expect(childAborted).toBe(true);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(r => [r.id, r.aborted])).toEqual([["ScoutRace", true]]);
		await manager.drainDeliveries({ timeoutMs: 100 });
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(deliveries).toHaveLength(0);
	});

	it("tells reply waits the caller is blocked on its child when no wake can end the call", async () => {
		// interruptMode "wait" gives the call no wake signal: a child that asks
		// its parent must learn the parent cannot answer before it finishes,
		// or both wait on each other. With a wake signal a message ends the
		// call, so the parent can answer.
		mockDiscovery();
		const gates: Array<PromiseWithResolvers<void>> = [];
		const started: Array<PromiseWithResolvers<void>> = [Promise.withResolvers(), Promise.withResolvers()];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const gate = Promise.withResolvers<void>();
			gates.push(gate);
			started[gates.length - 1]?.resolve();
			await gate.promise;
			return makeResult(options.id ?? "?", options.agent.name);
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const blockedWhileWaiting = async (name: string, context: AgentToolContext, position: number) => {
			const pending = tool.execute(
				`tc-${name}`,
				{ context: "ctx", tasks: [{ name, agent: "scout", task: "Research." }] } as TaskParams,
				undefined,
				undefined,
				context,
			);
			await started[position]!.promise;
			const blocked = AgentRegistry.global().awaits.blocksOn(MAIN_AGENT_ID, name, Date.now() + 1000);
			gates[position]!.resolve();
			await pending;
			return blocked;
		};

		expect(await blockedWhileWaiting("ScoutWaitMode", { toolCall: {} } as AgentToolContext, 0)).toBe(true);
		expect(
			await blockedWhileWaiting(
				"ScoutWakeable",
				{ toolCall: { wakeSignal: new AbortController().signal } } as AgentToolContext,
				1,
			),
		).toBe(false);
	});

	for (const shape of ["single", "fanout", "mixed"] as const) {
		it(`never hands a child off once the call is cancelled, whatever the cancel's delay after a wake (${shape})`, async () => {
			// For each delay (in promise continuations) between the wake and the
			// cancel: unless the call had already handed the blocking child to
			// the background when the cancel landed, the child must be cancelled
			// and nothing may be delivered later.
			for (let ticks = 0; ticks <= 8; ticks++) {
				vi.restoreAllMocks();
				AgentRegistry.resetGlobalForTests();
				mockDiscovery();
				const started: string[] = [];
				const startedAll = Promise.withResolvers<void>();
				const expected = shape === "single" ? 1 : 2;
				const aborted = new Set<string>();
				vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
					const id = options.id ?? "?";
					started.push(id);
					if (started.length === expected) startedAll.resolve();
					const { promise, resolve } = Promise.withResolvers<void>();
					if (options.signal?.aborted) resolve();
					else options.signal?.addEventListener("abort", () => resolve(), { once: true });
					await promise;
					aborted.add(id);
					return makeResult(id, options.agent.name, { aborted: true, exitCode: 1 });
				});
				const deliveries: string[] = [];
				const manager = new AsyncJobManager({ onJobComplete: jobId => void deliveries.push(jobId) });
				managers.push(manager);
				const tool = await TaskTool.create(createSession({ manager }));
				const tasks =
					shape === "single"
						? [{ name: `Race${ticks}A`, agent: "scout", task: "Research." }]
						: [
								{ name: `Race${ticks}A`, agent: "scout", task: "Research." },
								{ name: `Race${ticks}B`, agent: shape === "fanout" ? "scout" : "task", task: "More." },
							];
				const wake = new AbortController();
				const cancel = new AbortController();
				const pending = tool.execute(
					`tc-race-${shape}-${ticks}`,
					{ context: "ctx", tasks } as TaskParams,
					cancel.signal,
					undefined,
					{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
				);
				await startedAll.promise;
				wake.abort("aside");
				for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
				const handedOffAtCancel = manager.getRunningJobs().some(job => job.id === `Race${ticks}A`);
				cancel.abort();
				await pending;
				if (!handedOffAtCancel) {
					expect([ticks, aborted.has(`Race${ticks}A`)]).toEqual([ticks, true]);
					// The non-blocking sibling of a mixed call is an ordinary job the cancel does not own.
					await manager.getJob(`Race${ticks}A`)?.promise;
					await manager.drainDeliveries({ timeoutMs: 100 });
					expect([ticks, deliveries.filter(id => id === `Race${ticks}A`)]).toEqual([ticks, []]);
				}
				for (const job of manager.getRunningJobs()) manager.cancel(job.id);
				await Promise.all(manager.getAllJobs().map(job => job.promise));
			}
		});
	}

	it("keeps reporting a cancelled blocking child as waited on until its cancellation finishes", async () => {
		// No handoff happened: the child's last progress and its aborted
		// lifecycle event must not claim it ran detached.
		mockDiscovery();
		const started = Promise.withResolvers<void>();
		let waitedDuringCancel: boolean | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			waitedDuringCancel = options.parentWaits?.();
			return makeResult(options.id ?? "?", options.agent.name, { aborted: true, exitCode: 1 });
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const cancel = new AbortController();
		const pending = tool.execute(
			"tc-cancel-label",
			{ context: "ctx", tasks: [{ name: "ScoutCancelLabel", agent: "scout", task: "Research." }] } as TaskParams,
			cancel.signal,
			undefined,
			{ toolCall: { wakeSignal: new AbortController().signal } } as AgentToolContext,
		);
		await started.promise;
		cancel.abort();
		await pending;
		expect(waitedDuringCancel).toBe(true);
	});

	it("reports a blocking child as waited on until a wake hands it to the background", async () => {
		// Lifecycle/progress payloads (RPC `detached`, HUD filters) read this:
		// a child the call still waits on renders inline, a handed-off one is a
		// detached background job.
		mockDiscovery();
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let parentWaits: (() => boolean) | undefined;
		let detached: boolean | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			parentWaits = options.parentWaits;
			detached = options.detached;
			started.resolve();
			await gate.promise;
			return makeResult(options.id ?? "?", options.agent.name);
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const wake = new AbortController();
		const pending = tool.execute(
			"tc-waited-label",
			{ context: "ctx", tasks: [{ name: "ScoutLabel", agent: "scout", task: "Research." }] } as TaskParams,
			undefined,
			undefined,
			{ toolCall: { wakeSignal: wake.signal } } as AgentToolContext,
		);
		await started.promise;
		expect(detached).toBe(true);
		expect(parentWaits?.()).toBe(true);
		wake.abort("aside");
		await pending;
		expect(parentWaits?.()).toBe(false);
		gate.resolve();
		await manager.getJob("ScoutLabel")?.promise;
	});
});
