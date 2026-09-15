/**
 * Contract: `vibe_send` to a worker that is mid-turn steers it as the parent agent.
 *
 * The steer persists as a user-role message, so its `attribution` is the only
 * record of who wrote it. Consumers such as the Copilot `X-Initiator` header and
 * permission classifiers read that field; a parent instruction stamped "user"
 * reads as something the human typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
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
