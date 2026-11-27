/**
 * A detached task whose result an eval `wait()` takes over never gets an `async-result` push, so the
 * eval call must carry the job's credits into the session — once.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { EVAL_JOB_BILLING_OP } from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

const SELF_ID = "Main";

const usage: Usage = {
	input: 5,
	output: 7,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 15,
	cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.75 },
	aiu: { nano: 33 },
};

/** A task job that reported its billed child usage and settled. */
async function settledChargedTask(manager: AsyncJobManager, id: string): Promise<string> {
	const jobId = manager.register(
		"task",
		id,
		async ({ jobId, reportProgress }) => {
			await reportProgress("done", { progress: [{ id: jobId, usage, aiuUnreportedTurns: 2 }] });
			return { text: "<task-result>done</task-result>" };
		},
		{ ownerId: SELF_ID, agentId: id },
	);
	await manager.getJob(jobId)!.promise;
	return jobId;
}

async function waitFor(
	manager: AsyncJobManager,
	jobId: string,
): Promise<Array<{ op: string; [key: string]: unknown }>> {
	const events: Array<{ op: string; [key: string]: unknown }> = [];
	await runEvalWait(
		{ items: [{ kind: "agent", id: jobId }] },
		{
			session: { asyncJobManager: manager, getAgentId: () => SELF_ID } as Partial<ToolSession> as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	return events.filter(event => event.op === EVAL_JOB_BILLING_OP);
}

describe("credits of a background task consumed by an eval wait", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("the wait that takes the result over reports the billing and a repeat wait does not", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await settledChargedTask(manager, "Charged");

		const first = await waitFor(manager, jobId);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ jobId, usage: { aiu: { nano: 33 } }, aiuUnreportedTurns: 2 });

		expect(await waitFor(manager, jobId)).toEqual([]);
		await manager.dispose();
	});

	test("a job whose push already delivered it reports nothing", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await settledChargedTask(manager, "Pushed");
		// The delivery sink consumed the result (its async-result message carries the credits).
		manager.consumeJobResults([jobId]);

		expect(await waitFor(manager, jobId)).toEqual([]);
		await manager.dispose();
	});

	test("an abort during the final progress emission leaves the job unclaimed and still deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"Slow",
			async ({ jobId, reportProgress }) => {
				await reportProgress("running", { progress: [{ id: jobId, usage, aiuUnreportedTurns: 2 }] });
				await release.promise;
				// A newer progress object, so the wait's final emission has a frame to publish.
				await reportProgress("done", { progress: [{ id: jobId, usage, aiuUnreportedTurns: 2 }] });
				return { text: "<task-result>done</task-result>" };
			},
			{ ownerId: SELF_ID, agentId: "Slow" },
		);
		const controller = new AbortController();
		const events: Array<{ op: string; [key: string]: unknown }> = [];
		let agentFrames = 0;
		const waiting = runEvalWait(
			{ items: [{ kind: "agent", id: jobId }] },
			{
				session: { asyncJobManager: manager, getAgentId: () => SELF_ID } as Partial<ToolSession> as ToolSession,
				signal: controller.signal,
				emitStatus: event => {
					events.push(event);
					// The second frame is the final emission after settlement won the race: abort inside it.
					if (event.op === "agent" && ++agentFrames === 2) controller.abort();
				},
			},
		);
		release.resolve();

		await expect(waiting).rejects.toMatchObject({ name: "ToolAbortError" });
		expect(agentFrames).toBe(2);
		expect(events.filter(event => event.op === EVAL_JOB_BILLING_OP)).toEqual([]);
		// Not claimed: the job keeps its delivery and a later wait takes it over exactly once.
		expect(manager.isJobResultConsumed(jobId)).toBe(false);
		expect(await waitFor(manager, jobId)).toHaveLength(1);
		await manager.dispose();
	});

	test("the eval call carries the consumed billing into the session totals without rendering it", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
			options.onStatus?.({ op: EVAL_JOB_BILLING_OP, jobId: "Charged", usage, aiuUnreportedTurns: 2 });
			return {
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				artifactId: undefined,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
				displayOutputs: [],
			};
		});
		const session = {
			cwd: "/tmp/eval-test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		} as ToolSession;

		const result = await new EvalTool(session).execute("call-wait", { language: "js", code: "await wait(a)" });

		expect(result.details?.consumedJobs).toEqual([{ jobId: "Charged", usage, aiuUnreportedTurns: 2 }]);
		expect(result.details?.cells?.[0]?.statusEvents).toBeUndefined();

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-wait",
			toolName: "eval",
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		});
		// Credits are the only roll-up; the job's tokens and dollars never were session totals.
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 33, cost: 0, subagentCost: 0 });
	});
});
