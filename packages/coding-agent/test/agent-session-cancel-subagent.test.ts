import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// cancel_subagent routes a detached background subagent's run signal through
// the normal abort path (AsyncJobManager.cancel aborts the job's
// AbortController), so the subagent finalizes as aborted (salvaged result +
// lifecycle event) instead of running to completion. Idempotent:
// unknown/already-finished subagents and jobs owned by another agent are
// no-ops.
const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: [],
};

/** Output the real executor salvages for a cancelled run that produced nothing
 *  (kept free of HTML-escapable characters so it survives the summary render
 *  verbatim). */
const SALVAGED_OUTPUT = "[cancelled after 1 req, 0 tok - last activity: partway]";

describe("AgentSession.cancelSubagent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let manager: AsyncJobManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-cancel-subagent-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			agentId: "Main",
			asyncJobManager: manager,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("cancels a running background subagent through the real task spawn path and finalizes it as aborted", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TASK_AGENT], projectAgentsDir: null });
		// Mirror the executor's abort contract: hold until the run signal
		// aborts, then return an aborted SingleResult with salvaged output.
		const abortObserved = Promise.withResolvers<boolean>();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (options.signal?.aborted) resolve();
			else options.signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			abortObserved.resolve(options.signal?.aborted === true);
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				exitCode: 1,
				aborted: true,
				output: SALVAGED_OUTPUT,
				stderr: "",
				truncated: false,
				durationMs: 12,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});

		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": true,
				"task.isolation.mode": "none",
				"task.enableLsp": false,
			}),
			asyncJobManager: manager,
			getAgentId: () => "Main",
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getPlanModeState: () => undefined,
		};
		const tool = await TaskTool.create(toolSession);
		const updates: TaskToolDetails[] = [];
		const result = await tool.execute("tool-call", { task: "long-running work" }, undefined, update => {
			if (update.details) updates.push(update.details);
		});

		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeDefined();
		const job = manager.getJob(jobId!);
		expect(job).toBeDefined();
		expect(job!.status).toBe("running");
		expect(job!.ownerId).toBe("Main");

		expect(session!.cancelSubagent(jobId!)).toBe(true);
		await manager.waitForAll();

		// The run signal reached the executor boundary: the subagent run
		// resolved because its signal aborted, not because it finished.
		expect(await abortObserved.promise).toBe(true);
		expect(runSubprocess).toHaveBeenCalledTimes(1);
		// The job settled as cancelled carrying the salvaged output the real
		// finalize path produced from the aborted run.
		expect(job!.status).toBe("cancelled");
		expect(job!.errorText).toContain(SALVAGED_OUTPUT);
		// The real task job body stamped progress.status = "aborted" from the
		// aborted SingleResult, surfaced through the tool's progress updates.
		expect(updates.at(-1)?.progress?.[0]?.status).toBe("aborted");
	});

	it("is an idempotent no-op for an unknown subagent", () => {
		expect(session!.cancelSubagent("ghost-agent")).toBe(false);
		expect(manager.getRunningJobs()).toHaveLength(0);
	});

	it("does not cancel a job owned by a different agent", () => {
		const jobId = manager.register(
			"task",
			"other agent's job",
			async ({ signal }) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal.aborted) {
					resolve();
				} else {
					signal.addEventListener("abort", () => resolve(), { once: true });
				}
				await promise;
				return "done";
			},
			{ id: "agent-2", ownerId: "OtherAgent", agentId: "agent-2" },
		);
		expect(session!.cancelSubagent("agent-2")).toBe(false);
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(manager.getJob(jobId)?.abortController.signal.aborted).toBe(false);
	});
});
