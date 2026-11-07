/**
 * Contract: `vibe_send` to a worker that is mid-turn steers it as the parent agent.
 *
 * The steer persists as a user-role message, so its `attribution` is the only
 * record of who wrote it. Consumers such as the Copilot `X-Initiator` header and
 * permission classifiers read that field; a parent instruction stamped "user"
 * reads as something the human typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager, type AsyncJobDeliverySink } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult, TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

const ATTRIBUTION_OWNER = "vibe-parent";

function resultFor(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("vibe_send attribution", () => {
	let manager: AsyncJobManager;
	let parent: ToolSession;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		parent = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			asyncJobManager: manager,
			getAgentId: () => ATTRIBUTION_OWNER,
			getSessionId: () => "vibe-parent-session",
			getSessionFile: () => null,
			getArtifactsDir: () => null,
			taskDepth: 0,
			enableLsp: false,
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.dispose({ timeoutMs: 100 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function captureDelivery() {
		const sink = vi.fn((..._args: Parameters<AsyncJobDeliverySink>) => {});
		manager.registerDeliverySink(ATTRIBUTION_OWNER, sink);
		return sink;
	}

	function completeReport() {
		return {
			version: 1,
			runId: "vibe-report-run",
			status: "complete",
			artifact: { id: "101", uri: "artifact://101", sha256: "a".repeat(64), bytes: 42 },
		} satisfies TaskReportReference;
	}

	it.each([0, 1])("delivers worker text and its report for exit code %i", async exitCode => {
		const sink = captureDelivery();
		const report: TaskReportReference =
			exitCode === 0 ? completeReport() : { ...completeReport(), status: "partial", reason: "failed" };
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
			...resultFor(options),
			exitCode,
			output: "worker report body",
			error: exitCode === 0 ? undefined : "worker execution failed",
			report,
		}));

		const spawned = await VibeSessionRegistry.global().spawn(parent, { cli: "fast", prompt: "report work" });
		await manager.getJob(spawned.jobId)?.promise;
		await manager.drainDeliveries();

		expect(sink).toHaveBeenCalledTimes(1);
		const [jobId, text, job] = sink.mock.calls[0];
		expect(jobId).toBe(spawned.jobId);
		expect(job).toBe(manager.getJob(spawned.jobId));
		expect(job?.status).toBe(exitCode === 0 ? "completed" : "failed");
		expect(text).toContain(`<vibe-turn session="${spawned.id}"`);
		expect(text).toContain(`status="${exitCode === 0 ? "completed" : "failed"}"`);
		expect(text).toContain("worker report body");
		expect(exitCode === 0 ? job?.resultText : job?.errorText).toBe(text);
		if (exitCode !== 0) expect(text).toContain("worker execution failed");
		expect(job?.report).toBe(report);
		expect(job?.structured).toBeUndefined();
	});

	it("marks a pre-result executor rejection partial without inventing a report artifact", async () => {
		const sink = captureDelivery();
		vi.spyOn(executorModule, "runSubprocess").mockRejectedValue(new Error("executor unavailable"));

		const spawned = await VibeSessionRegistry.global().spawn(parent, { cli: "fast", prompt: "report work" });
		await manager.getJob(spawned.jobId)?.promise;
		await manager.drainDeliveries();

		expect(sink).toHaveBeenCalledTimes(1);
		const [jobId, text, job] = sink.mock.calls[0];
		expect(jobId).toBe(spawned.jobId);
		expect(job?.status).toBe("failed");
		expect(text).toContain(`[vibe:${spawned.id}`);
		expect(text).toContain("turn failed: executor unavailable");
		expect(job?.errorText).toBe(text);
		expect(job?.resultText).toBeUndefined();
		const report = job?.report;
		expect(report?.status).toBe("partial");
		expect(report?.reason).toBe("failed");
		expect(report?.artifact).toBeUndefined();
		expect(Object.isFrozen(report)).toBe(true);
		const delivered = buildAsyncResultBatchMessage([{ jobId, result: text, job, durationMs: 0, epoch: 0 }]);
		// The consumer must receive explicit incompleteness, not mistake the error preview for a full legacy report.
		expect(delivered?.details?.jobs[0]?.report).toBe(report);
		expect(delivered?.details?.jobs[0]?.status).toBe("failed");
		expect(job?.structured).toBeUndefined();
	});

	it("preserves the producer's complete report when successful work fails turn bookkeeping", async () => {
		const sink = captureDelivery();
		const report = completeReport();
		const original = structuredClone(report);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			// Arm only after execution: the first post-result lookup fails, then cleanup retries normally.
			vi.spyOn(AgentRegistry.global(), "get").mockImplementationOnce(() => {
				throw new Error("turn bookkeeping failed");
			});
			return { ...resultFor(options), report };
		});

		const spawned = await VibeSessionRegistry.global().spawn(parent, { cli: "fast", prompt: "report work" });
		await manager.getJob(spawned.jobId)?.promise;
		await manager.drainDeliveries();

		expect(sink).toHaveBeenCalledTimes(1);
		const [jobId, text, job] = sink.mock.calls[0];
		expect(jobId).toBe(spawned.jobId);
		expect(job?.status).toBe("failed");
		expect(text).toContain(`[vibe:${spawned.id}`);
		expect(text).toContain("turn failed: turn bookkeeping failed");
		expect(job?.errorText).toBe(text);
		expect(job?.resultText).toBeUndefined();
		expect(job?.report).toBe(report);
		expect(job?.report).toEqual(original);
		expect(report).toEqual(original);
		expect(job?.structured).toBeUndefined();
	});

	it("marks a busy worker steer as agent-authored", async () => {
		const release = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await release.promise;
			return resultFor(options);
		});
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(parent, { cli: "fast", prompt: "initial work" });
		const steer = vi.fn(async () => {});
		const live = { isStreaming: true, steer } as unknown as AgentSession;
		AgentRegistry.global().register({
			id: spawned.id,
			displayName: spawned.id,
			kind: "sub",
			parentId: ATTRIBUTION_OWNER,
			session: live,
			status: "running",
		});

		const outcome = await registry.send(parent, { session: spawned.id, message: "new constraint" });

		expect(outcome).toEqual({ id: spawned.id, mode: "steered" });
		expect(steer).toHaveBeenCalledWith("new constraint", undefined, { attribution: "agent" });
		release.resolve();
		await manager.getJob(spawned.jobId)?.promise;
	});

	it("keeps an idle worker message on the existing new-turn path", async () => {
		const firstTurn = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await firstTurn.promise;
			return resultFor(options);
		});
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(parent, { cli: "fast", prompt: "initial work" });
		const steer = vi.fn(async () => {});
		const live = { isStreaming: false, steer } as unknown as AgentSession;
		AgentRegistry.global().register({
			id: spawned.id,
			displayName: spawned.id,
			kind: "sub",
			parentId: ATTRIBUTION_OWNER,
			session: live,
			status: "idle",
		});
		firstTurn.resolve();
		await manager.getJob(spawned.jobId)?.promise;
		const followUp = Promise.withResolvers<Parameters<typeof executorModule.runSubagentFollowUpTurn>[0]>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUp.resolve(options);
			return resultFor({ ...options, cwd: "/tmp", task: options.message } as ExecutorOptions);
		});

		const outcome = await registry.send(parent, { session: spawned.id, message: "next task" });

		expect(outcome.mode).toBe("turn");
		expect((await followUp.promise).message).toBe("next task");
		expect(steer).not.toHaveBeenCalled();
	});
});
