/**
 * An auto-backgrounded eval cell returns its call before its `wait()` calls consume agent jobs, so the
 * call's own result cannot hold their credits. The job's delivery (or a wait/cancel snapshot that takes
 * it over) must carry them — each consumed job exactly once, including ones consumed before the cell was
 * backgrounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { EVAL_JOB_BILLING_OP } from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/eval";
import type { CoordinationDetails } from "@oh-my-pi/pi-coding-agent/tools/details/wait";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

const SELF_ID = "Main";

function chargedUsage(nano: number): Usage {
	return {
		input: 5,
		output: 7,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 15,
		cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.75 },
		aiu: { nano },
	};
}

function makeSession(settings: Settings, asyncJobManager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => SELF_ID,
		agentRegistry: AgentRegistry.global(),
		settings,
		asyncJobManager,
	} as unknown as ToolSession;
}

function backendResult() {
	return {
		output: "done\n",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
	};
}

type StatusSink = (event: { op: string; [key: string]: unknown }) => void;

/**
 * A cell that consumes job `Early` at once, waits on a gate, then consumes job `Late`. Backgrounding is
 * decided by the tool's own threshold, never by a guessed sleep.
 */
function mockTwoWaitCell(): { release: () => void } {
	const gate = Promise.withResolvers<void>();
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onStatus?: StatusSink },
	) => {
		options.onStatus?.({ op: EVAL_JOB_BILLING_OP, jobId: "Early", usage: chargedUsage(33), aiuUnreportedTurns: 1 });
		await gate.promise;
		options.onStatus?.({ op: EVAL_JOB_BILLING_OP, jobId: "Late", usage: chargedUsage(10) });
		return backendResult();
	}) as never);
	return { release: gate.resolve };
}

function persistToolResult(
	sessionManager: SessionManager,
	result: AgentToolResult<EvalToolDetails | CoordinationDetails | undefined>,
	toolName: string,
	callId: string,
): void {
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

describe("credits of jobs consumed by an auto-backgrounded eval cell", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("delivers every consumed row once and leaves earlier ones off the initial result", async () => {
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const cell = mockTwoWaitCell();
		const tool = new EvalTool(
			makeSession(
				Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 10 }),
				asyncJobManager,
			),
		);

		const initial = await tool.execute("call-bg", { language: "js", code: "await wait(a); await wait(b)" });
		expect(initial.details?.async?.state).toBe("running");
		// `Early` was consumed before the call returned; the job's delivery carries it, not this result.
		expect(initial.details?.consumedJobs).toBeUndefined();

		const jobId = initial.details?.async?.jobId;
		if (!jobId) throw new Error("expected an auto-backgrounded job id");
		cell.release();
		const job = asyncJobManager.getJob(jobId);
		await job?.promise;

		const delivery = buildAsyncResultBatchMessage([
			{ jobId, result: "done", job: asyncJobManager.getJob(jobId), durationMs: 1, epoch: 0 },
		]);
		if (!delivery) throw new Error("expected a delivery message");

		const sessionManager = SessionManager.inMemory();
		persistToolResult(sessionManager, initial, "eval", "call-bg");
		sessionManager.appendMessage(delivery);
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 43, cost: 0, subagentCost: 0 });
		await asyncJobManager.dispose();
	});

	it("carries a cell that starts backgrounded (zero threshold) the same way", async () => {
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const cell = mockTwoWaitCell();
		cell.release();
		const tool = new EvalTool(
			makeSession(
				Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 0 }),
				asyncJobManager,
			),
		);

		const initial = await tool.execute("call-zero", { language: "js", code: "await wait(a); await wait(b)" });
		expect(initial.details?.async?.state).toBe("running");
		expect(initial.details?.consumedJobs).toBeUndefined();
		const jobId = initial.details?.async?.jobId;
		if (!jobId) throw new Error("expected a backgrounded job id");
		await asyncJobManager.getJob(jobId)?.promise;

		const delivery = buildAsyncResultBatchMessage([
			{ jobId, result: "done", job: asyncJobManager.getJob(jobId), durationMs: 1, epoch: 0 },
		]);
		if (!delivery) throw new Error("expected a delivery message");
		const sessionManager = SessionManager.inMemory();
		persistToolResult(sessionManager, initial, "eval", "call-zero");
		sessionManager.appendMessage(delivery);
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 43 });
		await asyncJobManager.dispose();
	});

	it("a wait that recovers the settled eval job carries the rows, and a delivered job adds nothing after it", async () => {
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const cell = mockTwoWaitCell();
		cell.release();
		const session = makeSession(
			Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 0 }),
			asyncJobManager,
		);
		const initial = await new EvalTool(session).execute("call-recover", { language: "js", code: "await wait(a)" });
		const jobId = initial.details?.async?.jobId;
		if (!jobId) throw new Error("expected a backgrounded job id");
		const settled = asyncJobManager.getJob(jobId);
		await settled?.promise;

		const recovered = buildJobResult(session, asyncJobManager, "wait", [asyncJobManager.getJob(jobId)!], []);
		const sessionManager = SessionManager.inMemory();
		persistToolResult(sessionManager, initial, "eval", "call-recover");
		persistToolResult(sessionManager, recovered, "wait", "wait-1");
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 43 });

		// The recovery took the result over, so a repeat snapshot reports state only.
		const repeat = buildJobResult(session, asyncJobManager, "wait", [asyncJobManager.getJob(jobId)!], []);
		persistToolResult(sessionManager, repeat, "wait", "wait-2");
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 43 });
		await asyncJobManager.dispose();
	});

	it("a background cell that fails after its last live frame still carries a row consumed since", async () => {
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const gate = Promise.withResolvers<void>();
		let emit: StatusSink | undefined;
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onStatus?: StatusSink },
		) => {
			emit = options.onStatus;
			emit?.({ op: EVAL_JOB_BILLING_OP, jobId: "Early", usage: chargedUsage(33), aiuUnreportedTurns: 1 });
			await gate.promise;
			return backendResult();
		}) as never);
		// The run fails after the cell loop already published its last frame; a wait() that settled during the
		// teardown consumes its job in that gap, so only the live rows know it.
		const session = {
			...makeSession(
				Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 10 }),
				asyncJobManager,
			),
			trackEvalExecution: (execution: Promise<unknown>) =>
				execution.then(() => {
					emit?.({ op: EVAL_JOB_BILLING_OP, jobId: "Late", usage: chargedUsage(10) });
					throw new Error("teardown failed");
				}),
		} as unknown as ToolSession;

		const initial = await new EvalTool(session).execute("call-fail", { language: "js", code: "await wait(a)" });
		const jobId = initial.details?.async?.jobId;
		if (!jobId) throw new Error("expected an auto-backgrounded job id");
		gate.resolve();
		await asyncJobManager.getJob(jobId)?.promise.catch(() => undefined);
		expect(asyncJobManager.getJob(jobId)?.status).toBe("failed");

		const delivery = buildAsyncResultBatchMessage([
			{ jobId, result: "teardown failed", job: asyncJobManager.getJob(jobId), durationMs: 1, epoch: 0 },
		]);
		if (!delivery) throw new Error("expected a delivery message");
		const sessionManager = SessionManager.inMemory();
		persistToolResult(sessionManager, initial, "eval", "call-fail");
		sessionManager.appendMessage(delivery);
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 43 });
		await asyncJobManager.dispose();
	});

	/**
	 * A cell that consumes `Early`, then blocks until the test opens the gate. The call is aborted while it
	 * blocks, before any throttled progress frame could have published the consumed row.
	 */
	async function abortWhileBlocked(consume: boolean): Promise<{
		result: Awaited<ReturnType<EvalTool["execute"]>> | undefined;
		error: unknown;
	}> {
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const gate = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<void>();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onStatus?: StatusSink },
		) => {
			if (consume) {
				options.onStatus?.({
					op: EVAL_JOB_BILLING_OP,
					jobId: "Early",
					usage: chargedUsage(33),
					aiuUnreportedTurns: 1,
				});
			}
			blocked.resolve();
			await gate.promise;
			return backendResult();
		}) as never);
		const tool = new EvalTool(
			makeSession(
				// High threshold: only the abort ends the foreground wait.
				Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 60_000 }),
				asyncJobManager,
			),
		);
		const controller = new AbortController();
		const call = tool.execute("call-abort", { language: "js", code: "await wait(a)" }, controller.signal);
		await blocked.promise;
		controller.abort();
		try {
			return { result: await call, error: undefined };
		} catch (error) {
			return { result: undefined, error };
		} finally {
			gate.resolve();
			await asyncJobManager.dispose();
		}
	}

	it("an abort after a wait consumed a job still returns the consumed rows to the session", async () => {
		const { result, error } = await abortWhileBlocked(true);

		expect(error).toBeUndefined();
		expect(result?.isError).toBe(true);
		expect(result?.details?.consumedJobs).toEqual([
			{ jobId: "Early", usage: chargedUsage(33), aiuUnreportedTurns: 1 },
		]);

		const sessionManager = SessionManager.inMemory();
		persistToolResult(sessionManager, result!, "eval", "call-abort");
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 33, cost: 0 });
	});

	it("an abort with nothing consumed still ends the call with the abort error", async () => {
		const { result, error } = await abortWhileBlocked(false);

		expect(result).toBeUndefined();
		expect(error).toMatchObject({ name: "ToolAbortError" });
	});
});
