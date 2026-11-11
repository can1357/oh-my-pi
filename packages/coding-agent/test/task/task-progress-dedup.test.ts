/**
 * Contracts: Task progress snapshot isolation, unchanged-sibling snapshot reuse,
 * prompt string deduplication (`task` / `assignment`), and `taskFile` provenance.
 *
 * 1. Mutating a running child's progress across `markRunning`, streaming ticks,
 *    and settlement produces a fresh `TaskToolDetails.progress[i]` snapshot for
 *    that child without mutating previously emitted snapshots, while unchanged
 *    siblings reuse their exact snapshot object identity.
 * 2. Sync batch fan-out (`async.enabled=false`) preserves earlier emitted
 *    snapshots and reuses unchanged sibling snapshot references across ticks.
 * 3. `task` and `assignment` reuse a single canonical `JSString` allocation across
 *    `TaskTool`, `structured-subagent`, `SubagentWorker` (`runSubprocessPlaced`),
 *    streaming progress ticks, and settled `SingleResult` payloads instead of
 *    retaining N structured-clone copies across ticks.
 * 4. `assignment`, `task`, `taskFile`, and `taskFileSha256` remain intact on
 *    every emitted `TaskToolDetails.progress[i]` record (downstream session
 *    consumers read them directly from persisted `toolResult` entries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { deserialize, fullGC, heapStats, serialize } from "bun:jsc";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions, SubagentRunRequest } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunnerModule from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as structuredSubagentModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { renderSubagentUserPrompt, runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { runSubprocessPlaced } from "@oh-my-pi/pi-coding-agent/thread/executor-routing";
import { type SubagentWorker, SubagentWorkerPool } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const BLOCKING_AGENT: AgentDefinition = {
	name: "reviewer",
	description: "Blocking inline agent",
	systemPrompt: "You review inline.",
	source: "bundled",
	blocking: true,
};

interface ControlledChild {
	options: ExecutorOptions;
	finish: (overrides?: Partial<SingleResult>) => void;
	fail: (error: Error) => void;
	emitProgress: (overrides: Partial<AgentProgress>) => void;
}

interface DetailsWaiter {
	predicate: (details: TaskToolDetails) => boolean;
	deferred: PromiseWithResolvers<TaskToolDetails>;
}

interface DetailsRecorder {
	readonly history: TaskToolDetails[];
	onUpdate: (update: { details?: TaskToolDetails }) => void;
	waitFor: (predicate: (details: TaskToolDetails) => boolean) => Promise<TaskToolDetails>;
}

function createDetailsRecorder(): DetailsRecorder {
	const history: TaskToolDetails[] = [];
	const waiters: DetailsWaiter[] = [];
	let cursor = 0;

	return {
		history,
		onUpdate: update => {
			if (!update.details) return;
			history.push(update.details);
			while (waiters.length > 0 && waiters[0]!.predicate(update.details)) {
				const waiter = waiters.shift()!;
				cursor = history.length;
				waiter.deferred.resolve(update.details);
			}
		},
		waitFor: predicate => {
			if (waiters.length === 0) {
				for (let index = cursor; index < history.length; index++) {
					const candidate = history[index]!;
					if (predicate(candidate)) {
						cursor = index + 1;
						return Promise.resolve(candidate);
					}
				}
			}
			const deferred = Promise.withResolvers<TaskToolDetails>();
			waiters.push({ predicate, deferred });
			return deferred.promise;
		},
	};
}

function cloneAcrossStructuredWire<T>(value: T): T {
	return deserialize(serialize(value)) as T;
}

function makeProgress(options: ExecutorOptions, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		status: "running",
		task: options.task,
		assignment: options.assignment,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 5,
		...overrides,
	};
}

function makeSingleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 0,
		output: `Done ${options.id}`,
		stderr: "",
		truncated: false,
		durationMs: 12,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("task progress snapshot deduplication and provenance", () => {
	let directory: string;
	let customRunSubprocess: ((options: ExecutorOptions) => Promise<SingleResult>) | undefined;
	const managers: AsyncJobManager[] = [];
	const children = new Map<string, ControlledChild>();
	const childEntered = new Map<string, PromiseWithResolvers<ControlledChild>>();

	function waitForChild(id: string): Promise<ControlledChild> {
		let entry = childEntered.get(id);
		if (!entry) {
			entry = Promise.withResolvers<ControlledChild>();
			childEntered.set(id, entry);
			const existing = children.get(id);
			if (existing) entry.resolve(existing);
		}
		return entry.promise;
	}

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	async function createTool(options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
	}): Promise<TaskTool> {
		return TaskTool.create({
			cwd: directory,
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": options.manager !== undefined,
				"task.batch": true,
				"task.file": true,
				...options.settings,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
			asyncJobManager: options.manager,
		} as unknown as ToolSession);
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-progress-dedup-"));
		customRunSubprocess = undefined;
		children.clear();
		childEntered.clear();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [TASK_AGENT, BLOCKING_AGENT],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (customRunSubprocess) return customRunSubprocess(options);
			const settled = Promise.withResolvers<SingleResult>();
			const controlled: ControlledChild = {
				options,
				finish: overrides => settled.resolve(makeSingleResult(options, overrides)),
				fail: error => settled.reject(error),
				emitProgress: overrides => options.onProgress?.(makeProgress(options, overrides)),
			};
			children.set(options.id, controlled);
			childEntered.get(options.id)?.resolve(controlled);
			return settled.promise;
		});
	});

	afterEach(async () => {
		for (const child of children.values()) child.finish();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1_000 });
		}
		customRunSubprocess = undefined;
		children.clear();
		childEntered.clear();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.rm(directory, { recursive: true, force: true });
	});

	it("keeps async progress snapshots immutable across ticks, reuses unchanged sibling snapshots, shares pre-rendered task prompts, and preserves taskFile provenance", async () => {
		const inlineAssignment = `Audit module A thoroughly and report concrete defects. ${"x".repeat(512)}`;
		const fileContent = `  Review module B invariants.\r\nPreserve exact file hash. ${"y".repeat(512)}\n`;
		const fileBytes = new TextEncoder().encode(fileContent);
		const expectedSha256 = new Bun.CryptoHasher("sha256").update(fileBytes).digest("hex");
		const expectedFileAssignment = fileContent.trim();
		const taskFile = path.join(directory, "beta-task.md");
		await Bun.write(taskFile, fileBytes);

		const expectedAlphaTask = renderSubagentUserPrompt(inlineAssignment);
		const expectedBetaTask = renderSubagentUserPrompt(expectedFileAssignment);

		const renderSpy = vi.spyOn(structuredSubagentModule, "renderSubagentUserPrompt");
		const manager = createManager();
		const tool = await createTool({ manager });
		const recorder = createDetailsRecorder();

		const initialResult = await tool.execute(
			"tc-async-dedup",
			{
				context: "Shared review context.",
				tasks: [
					{ name: "Alpha", task: `  ${inlineAssignment}  ` },
					{ name: "Beta", taskFile },
				],
			} as TaskParams,
			undefined,
			recorder.onUpdate,
		);
		expect(renderSpy).toHaveBeenCalledTimes(2);

		const initialDetails = initialResult.details!;
		expect(initialDetails.progress).toHaveLength(2);
		const initialAlpha = initialDetails.progress![0]!;
		const initialBeta = initialDetails.progress![1]!;
		expect(initialAlpha).toMatchObject({
			id: "Alpha",
			index: 0,
			status: "pending",
			assignment: inlineAssignment,
			task: expectedAlphaTask,
			tokens: 0,
			toolCount: 0,
		});
		expect(initialBeta).toMatchObject({
			id: "Beta",
			index: 1,
			status: "pending",
			assignment: expectedFileAssignment,
			task: expectedBetaTask,
			taskFile,
			taskFileSha256: expectedSha256,
			tokens: 0,
			toolCount: 0,
		});

		// Spawn-time onUpdate and execute() return share unchanged snapshots before jobs mutate state.
		const spawnedUpdate = await recorder.waitFor(details => details.progress?.length === 2);
		expect(spawnedUpdate.progress?.[0]).toBe(initialAlpha);
		expect(spawnedUpdate.progress?.[1]).toBe(initialBeta);

		const [alpha, beta] = await Promise.all([waitForChild("Alpha"), waitForChild("Beta")]);
		await recorder.waitFor(
			details => details.progress?.[0]?.status === "running" && details.progress?.[1]?.status === "running",
		);
		// `#runSpawn` and `structured-subagent` reuse `spawn.progress.task` instead of rendering extra copies.
		expect(renderSpy).toHaveBeenCalledTimes(2);
		expect(alpha.options.task).toBe(initialAlpha.task);
		expect(alpha.options.assignment).toBe(initialAlpha.assignment);
		expect(beta.options.task).toBe(initialBeta.task);
		expect(beta.options.assignment).toBe(initialBeta.assignment);

		alpha.emitProgress({
			tokens: 120,
			requests: 1,
			toolCount: 1,
			currentTool: "read",
			recentTools: [{ tool: "read", args: "a.ts", endMs: 1 }],
		});
		const afterAlphaTick1 = await recorder.waitFor(details => details.progress?.[0]?.tokens === 120);

		alpha.emitProgress({
			tokens: 340,
			requests: 2,
			toolCount: 2,
			currentTool: "grep",
			recentTools: [
				{ tool: "grep", args: "foo", endMs: 2 },
				{ tool: "read", args: "a.ts", endMs: 1 },
			],
		});
		const afterAlphaTick2 = await recorder.waitFor(details => details.progress?.[0]?.tokens === 340);

		// Earlier snapshots for Alpha are never mutated by subsequent ticks.
		expect(initialAlpha.status).toBe("pending");
		expect(initialAlpha.tokens).toBe(0);
		expect(afterAlphaTick1.progress![0]).toMatchObject({
			id: "Alpha",
			status: "running",
			tokens: 120,
			toolCount: 1,
			currentTool: "read",
			assignment: inlineAssignment,
			task: initialAlpha.task,
		});
		expect(afterAlphaTick2.progress![0]).toMatchObject({
			id: "Alpha",
			status: "running",
			tokens: 340,
			toolCount: 2,
			currentTool: "grep",
			assignment: inlineAssignment,
			task: initialAlpha.task,
		});
		expect(afterAlphaTick2.progress![0]).not.toBe(afterAlphaTick1.progress![0]);

		// Unchanged sibling Beta reuses the exact same snapshot object reference across Alpha's ticks.
		expect(afterAlphaTick2.progress![1]).toBe(afterAlphaTick1.progress![1]);
		expect(afterAlphaTick2.progress![1]).toMatchObject({
			id: "Beta",
			status: "running",
			assignment: expectedFileAssignment,
			task: initialBeta.task,
			taskFile,
			taskFileSha256: expectedSha256,
		});

		// Settling Alpha updates Alpha's snapshot while still reusing Beta's unchanged snapshot.
		alpha.finish({ tokens: 500, requests: 3, durationMs: 42 });
		await manager.getJob("Alpha")!.promise;
		const afterAlphaSettled = await recorder.waitFor(details => details.progress?.[0]?.status === "completed");
		expect(afterAlphaTick2.progress![0]!.status).toBe("running");
		expect(afterAlphaTick2.progress![0]!.tokens).toBe(340);
		expect(afterAlphaSettled.progress![0]).toMatchObject({
			id: "Alpha",
			status: "completed",
			tokens: 500,
			requests: 3,
			durationMs: 42,
			assignment: inlineAssignment,
			task: initialAlpha.task,
		});
		expect(afterAlphaSettled.progress![1]).toBe(afterAlphaTick2.progress![1]);

		// Now Beta ticks and settles; settled sibling Alpha reuses its exact snapshot reference.
		beta.emitProgress({ tokens: 210, requests: 1, toolCount: 1, currentTool: "ast_grep" });
		const afterBetaTick = await recorder.waitFor(details => details.progress?.[1]?.tokens === 210);
		expect(afterBetaTick.progress![0]).toBe(afterAlphaSettled.progress![0]);
		expect(afterBetaTick.progress![1]).not.toBe(afterAlphaSettled.progress![1]);
		expect(afterAlphaSettled.progress![1]!.tokens).toBe(0);
		expect(afterBetaTick.progress![1]).toMatchObject({
			id: "Beta",
			status: "running",
			tokens: 210,
			currentTool: "ast_grep",
			assignment: expectedFileAssignment,
			task: initialBeta.task,
			taskFile,
			taskFileSha256: expectedSha256,
		});

		beta.finish({ tokens: 260, requests: 2, durationMs: 55 });
		await manager.getJob("Beta")!.promise;
		const finalDetails = await recorder.waitFor(details => details.async?.state === "completed");
		expect(finalDetails.progress![0]).toBe(afterAlphaSettled.progress![0]);
		expect(afterBetaTick.progress![1]!.status).toBe("running");
		expect(finalDetails.progress![1]).toMatchObject({
			id: "Beta",
			status: "completed",
			tokens: 260,
			requests: 2,
			durationMs: 55,
			assignment: expectedFileAssignment,
			task: initialBeta.task,
			taskFile,
			taskFileSha256: expectedSha256,
		});
	});

	it("reuses unchanged sibling snapshots and preserves immutable history in sync fan-out", async () => {
		const fileContent = "Sync file-backed task body.\n";
		const fileBytes = new TextEncoder().encode(fileContent);
		const expectedSha256 = new Bun.CryptoHasher("sha256").update(fileBytes).digest("hex");
		const taskFile = path.join(directory, "sync-beta.md");
		await Bun.write(taskFile, fileBytes);

		const renderSpy = vi.spyOn(structuredSubagentModule, "renderSubagentUserPrompt");
		const tool = await createTool({});
		const recorder = createDetailsRecorder();
		const executionPromise = tool.execute(
			"tc-sync-dedup",
			{
				context: "Sync batch context.",
				tasks: [
					{ name: "SyncAlpha", task: "Inspect sync path A." },
					{ name: "SyncBeta", taskFile },
				],
			} as TaskParams,
			undefined,
			recorder.onUpdate,
		);

		const [alpha, beta] = await Promise.all([waitForChild("SyncAlpha"), waitForChild("SyncBeta")]);
		// Sync fan-out renders exactly once per spawn inside `structured-subagent` (never redundantly in `TaskTool`).
		expect(renderSpy).toHaveBeenCalledTimes(2);

		beta.emitProgress({ tokens: 80, toolCount: 1, currentTool: "read" });
		alpha.emitProgress({ tokens: 100, toolCount: 1, currentTool: "grep" });
		const afterFirstPair = await recorder.waitFor(
			details => details.progress?.length === 2 && details.progress[0]?.tokens === 100,
		);

		alpha.emitProgress({ tokens: 250, toolCount: 2, currentTool: "read" });
		const afterSecondAlpha = await recorder.waitFor(details => details.progress?.[0]?.tokens === 250);

		// Earlier SyncAlpha snapshot stays at tokens=100 while new snapshot advances to tokens=250.
		expect(afterFirstPair.progress![0]).toMatchObject({
			id: "SyncAlpha",
			index: 0,
			tokens: 100,
			currentTool: "grep",
			assignment: "Inspect sync path A.",
			task: alpha.options.task,
		});
		expect(afterSecondAlpha.progress![0]).toMatchObject({
			id: "SyncAlpha",
			index: 0,
			tokens: 250,
			currentTool: "read",
			assignment: "Inspect sync path A.",
			task: alpha.options.task,
		});
		expect(afterSecondAlpha.progress![0]).not.toBe(afterFirstPair.progress![0]);

		// Unchanged SyncBeta snapshot reference is reused identically.
		expect(afterSecondAlpha.progress![1]).toBe(afterFirstPair.progress![1]);
		expect(afterSecondAlpha.progress![1]).toMatchObject({
			id: "SyncBeta",
			index: 1,
			tokens: 80,
			assignment: fileContent.trim(),
			task: beta.options.task,
			taskFile,
			taskFileSha256: expectedSha256,
		});

		alpha.finish({ tokens: 300 });
		beta.finish({ tokens: 95 });
		const settled = await executionPromise;
		expect(settled.details?.results).toHaveLength(2);
		expect(settled.details?.results[1]).toMatchObject({
			id: "SyncBeta",
			assignment: fileContent.trim(),
			taskFile,
			taskFileSha256: expectedSha256,
		});
	});

	it("marks inline-blocking and registration-failed spawns dirty without mutating earlier snapshots", async () => {
		const manager = createManager();
		const originalRegister = manager.register.bind(manager);
		vi.spyOn(manager, "register").mockImplementation((type, label, run, options) => {
			if (label === "BrokenAsync") {
				throw new Error("queue full");
			}
			return originalRegister(type, label, run, options);
		});

		const tool = await createTool({ manager });
		const recorder = createDetailsRecorder();
		const executePromise = tool.execute(
			"tc-mixed-dedup",
			{
				context: "Mixed inline + async context.",
				tasks: [
					{ name: "InlineRev", agent: "reviewer", task: "Review inline." },
					{ name: "LiveAsync", agent: "task", task: "Run async." },
					{ name: "BrokenAsync", agent: "task", task: "Fails registration." },
				],
			} as TaskParams,
			undefined,
			recorder.onUpdate,
		);

		const [inlineRev, liveAsync] = await Promise.all([waitForChild("InlineRev"), waitForChild("LiveAsync")]);
		inlineRev.emitProgress({ tokens: 60, currentTool: "read" });
		const duringInline = await recorder.waitFor(details => details.progress?.[0]?.tokens === 60);
		expect(duringInline.progress![0]).toMatchObject({ id: "InlineRev", status: "running", tokens: 60 });
		expect(duringInline.progress![2]).toMatchObject({ id: "BrokenAsync", status: "failed" });

		inlineRev.finish({ tokens: 90, durationMs: 33 });
		const returned = await executePromise;

		// Settling InlineRev must not mutate the snapshot emitted while InlineRev was running.
		const returnedProgress = returned.details!.progress!;
		expect(duringInline.progress![0]!.status).toBe("running");
		expect(returnedProgress[0]).toMatchObject({
			id: "InlineRev",
			status: "completed",
			durationMs: 33,
		});
		// Unchanged BrokenAsync snapshot is reused across inline progress and call return.
		expect(returnedProgress[2]).toBe(duringInline.progress![2]);

		liveAsync.finish({ tokens: 110 });
		await manager.getJob("LiveAsync")!.promise;
		const afterAsyncSettled = await recorder.waitFor(details => details.progress?.[1]?.status === "completed");
		expect(afterAsyncSettled.progress![0]).toBe(returnedProgress[0]);
		expect(afterAsyncSettled.progress![2]).toBe(returnedProgress[2]);
		expect(afterAsyncSettled.progress![1]).toMatchObject({ id: "LiveAsync", status: "completed", tokens: 110 });
	});

	it("reuses canonical task and assignment JSString allocations across structured-clone worker ticks", async () => {
		const promptBytes = 256 * 1024;
		const tickCount = 32;
		const canonicalAssignment = `Investigate worker serialization retention.\n${"z".repeat(promptBytes)}`;
		const canonicalTask = renderSubagentUserPrompt(canonicalAssignment);

		// Baseline proof: retaining 32 un-deduplicated structured-clone ticks holds >= 15 MiB of JSString backing stores.
		fullGC();
		const baselineExtra = heapStats().extraMemorySize;
		const rawWireCopies = Array.from({ length: tickCount }, () => ({
			task: cloneAcrossStructuredWire(canonicalTask),
			assignment: cloneAcrossStructuredWire(canonicalAssignment),
		}));
		fullGC();
		const unDedupedBytes = heapStats().extraMemorySize - baselineExtra;
		expect(rawWireCopies).toHaveLength(tickCount);
		expect(unDedupedBytes).toBeGreaterThan(tickCount * promptBytes);
		rawWireCopies.length = 0;

		// 1. SubagentWorker boundary (`runSubprocessPlaced`): 32 RPC-deserialized progress ticks + SingleResult
		//    drop their cloned backing stores and retain only the single `options.task` / `options.assignment`.
		const pool = new SubagentWorkerPool({ maxWorkers: () => 0 });
		const observedWorkerTicks: AgentProgress[] = [];
		const fakeWorker = {
			alive: true,
			threadId: "w1",
			link: {
				call: async (_method: string, request: SubagentRunRequest): Promise<SingleResult> => {
					for (let tick = 1; tick <= tickCount; tick++) {
						request.options.onProgress?.(
							cloneAcrossStructuredWire(makeProgress(request.options, { tokens: tick * 10, toolCount: tick })),
						);
					}
					return cloneAcrossStructuredWire(makeSingleResult(request.options, { tokens: 999 }));
				},
			},
		} as unknown as SubagentWorker;
		const placement = { worker: fakeWorker, release: () => {} };
		vi.spyOn(pool, "place").mockReturnValue(placement);
		vi.spyOn(pool, "settle").mockResolvedValue(placement);

		const routedResult = await runSubprocessPlaced(
			pool,
			{
				cwd: directory,
				agent: TASK_AGENT,
				task: canonicalTask,
				assignment: canonicalAssignment,
				index: 0,
				id: "WorkerRouted",
				onProgress: progress => observedWorkerTicks.push(progress),
			},
			async () => {
				throw new Error("expected worker placement");
			},
		);
		pool.dispose();

		expect(observedWorkerTicks).toHaveLength(tickCount);
		for (const tick of observedWorkerTicks) {
			expect(tick.task).toBe(canonicalTask);
			expect(tick.assignment).toBe(canonicalAssignment);
		}
		expect(routedResult.task).toBe(canonicalTask);
		expect(routedResult.assignment).toBe(canonicalAssignment);

		// 2. Sync TaskTool.#runSpawn path: latches the first observed task string and deduplicates
		//    subsequent deserialized ticks + final SingleResult without extra parent-side renders.
		customRunSubprocess = async options => {
			for (let tick = 1; tick <= tickCount; tick++) {
				options.onProgress?.(
					cloneAcrossStructuredWire(makeProgress(options, { tokens: tick * 10, toolCount: tick })),
				);
			}
			return cloneAcrossStructuredWire(makeSingleResult(options, { tokens: 1_000 }));
		};

		const tool = await createTool({});
		const recorder = createDetailsRecorder();
		const syncSettled = await tool.execute(
			"tc-worker-sync-cells",
			{ name: "SyncWorkerChild", task: `  ${canonicalAssignment}  ` } as TaskParams,
			undefined,
			recorder.onUpdate,
		);
		fullGC();
		const combinedRetainedBytes = heapStats().extraMemorySize - baselineExtra;

		expect(recorder.history).toHaveLength(tickCount);
		const finalSingleResult = syncSettled.details!.results[0]!;
		for (const details of recorder.history) {
			expect(details.progress?.[0]?.task).toBe(canonicalTask);
			expect(details.progress?.[0]?.assignment).toBe(canonicalAssignment);
		}
		expect(finalSingleResult.task).toBe(canonicalTask);
		expect(finalSingleResult.assignment).toBe(canonicalAssignment);
		// Retaining all 64 worker + sync snapshots + both final results stays far below un-deduplicated 32 MiB.
		expect(combinedRetainedBytes).toBeLessThan(4 * 1024 * 1024);

		// 3. Isolated runs keep `buildFailureResult` prompt rendering lazy until an error occurs.
		vi.spyOn(isolationRunnerModule, "prepareIsolationContext").mockResolvedValue({ repoRoot: directory });
		let capturedBuildFailure: ((error: unknown) => SingleResult) | undefined;
		vi.spyOn(isolationRunnerModule, "runIsolatedSubprocess").mockImplementation(async opts => {
			capturedBuildFailure = opts.buildFailureResult;
			return makeSingleResult(opts.baseOptions);
		});
		const isolatedRenderSpy = vi.spyOn(structuredSubagentModule, "renderSubagentUserPrompt");
		const isolatedSession = {
			cwd: directory,
			hasUI: false,
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.isolation.apply": false,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
		} as unknown as ToolSession;

		await runStructuredSubagent({
			session: isolatedSession,
			invocationKind: "task",
			assignment: `  ${canonicalAssignment}  `,
			isolation: { requested: true },
		});
		expect(isolatedRenderSpy).toHaveBeenCalledTimes(1);
		const failureResult = capturedBuildFailure!(new Error("workspace setup failed"));
		expect(isolatedRenderSpy).toHaveBeenCalledTimes(2);
		expect(failureResult.task).toBe(canonicalTask);
		expect(failureResult.assignment).toBe(canonicalAssignment);
	});
});
