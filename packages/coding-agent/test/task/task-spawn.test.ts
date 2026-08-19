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
 * Param validation (missing agent / missing assignment) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async/job-manager";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import {
	ASSIGNMENT_CONTRACT_VERSION,
	ASSIGNMENT_RESULT_VERSION,
	withAssignmentContractDigest,
} from "@pk-nerdsaver-ai/pi-coding-agent/task/assignment-contract";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

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
		getModelString: () => "anthropic/claude-sonnet-4-5",
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
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			id: "Spawnling",
			description: "background work",
			assignment: "Do the thing.",
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
		expect(job!.resultText).toContain("message it via `irc` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("clears assignment contract snapshots after success, error, and cancellation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		for (const outcome of ["success", "error", "cancellation"] as const) {
			const gate = deferred();
			const manager = createManager();
			const session = createSession({ manager });
			let activeContract: ReturnType<NonNullable<ToolSession["getActiveTaskContract"]>>;
			session.setActiveTaskContract = contract => {
				activeContract = contract;
			};
			session.getActiveTaskContract = () => activeContract;
			vi.spyOn(executorModule, "runSubprocess").mockImplementationOnce(async options => {
				await gate.promise;
				if (outcome === "error") return makeResult(options.id ?? "?", { exitCode: 1, isError: true });
				if (outcome === "cancellation") return makeResult(options.id ?? "?", { aborted: true, exitCode: 1 });
				return makeResult(options.id ?? "?");
			});
			const tool = await TaskTool.create(session);
			const assignmentContract = withAssignmentContractDigest({
				version: ASSIGNMENT_CONTRACT_VERSION,
				id: `terminal-${outcome}`,
				revision: 1,
				role: "task",
				workClass: "mechanical",
				autonomy: "bound",
				objective: `Verify ${outcome} snapshot cleanup`,
				deliverables: ["packages/coding-agent/src/task/index.ts"],
				scope: { allowedPaths: ["packages/coding-agent/src/task/index.ts"] },
				acceptance: [{ id: "cleared", description: "The snapshot is cleared", check: "content_match" }],
				reporting: ASSIGNMENT_RESULT_VERSION,
			});

			const result = await tool.execute("tc-contract", {
				agent: "task",
				id: `Contract-${outcome}`,
				assignment: "Run the assigned task.",
				assignmentContract,
			} as TaskParams);
			const job = manager.getJob(result.details!.async!.jobId)!;
			expect(session.getActiveTaskContract?.()).toMatchObject({ objective: assignmentContract.objective });

			if (outcome === "cancellation") expect(manager.cancel(job.id)).toBe(true);
			gate.resolve();
			await job.promise;
			expect(session.getActiveTaskContract?.()).toBeUndefined();
		}
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

		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
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

			const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", {
				agent: "task",
				id: "Second",
				assignment: "Work B.",
			} as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", id: "Third", assignment: "Work C." } as TaskParams);

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
});
