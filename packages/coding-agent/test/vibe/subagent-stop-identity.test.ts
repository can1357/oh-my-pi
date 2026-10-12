/**
 * Contract: a vibe worker's turns report the spawning session to
 * `subagent_stop` — the event's `parent_session_id` comes from the options the
 * vibe runtime hands the executor, on the first spawn and on every later turn,
 * because the child session cannot derive it. The parent transcript path needs a
 * persisted parent session (vibe then writes lifecycle records), so it is not
 * covered here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions, FollowUpTurnOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const OWNER_ID = "vibe-parent";

function resultFor(id: string, task: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("vibe worker spawn identity for subagent_stop", () => {
	let manager: AsyncJobManager;
	let parent: ToolSession;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		parent = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			asyncJobManager: manager,
			getAgentId: () => OWNER_ID,
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

	it("hands the first spawn the spawning session's id", async () => {
		const spawned = Promise.withResolvers<ExecutorOptions>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.resolve(options);
			return resultFor(options.id, options.task);
		});

		await VibeSessionRegistry.global().spawn(parent, { cli: "fast", prompt: "initial work" });

		const options = await spawned.promise;
		expect(options.parentSessionId).toBe("vibe-parent-session");
	});

	it("hands a later turn the spawning session's id", async () => {
		// The worker must still look live when its first turn settles, so the
		// first turn is held until the live session is registered.
		const firstTurn = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await firstTurn.promise;
			return resultFor(options.id, options.task);
		});
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(parent, { cli: "fast", prompt: "initial work" });
		AgentRegistry.global().register({
			id: spawned.id,
			displayName: spawned.id,
			kind: "sub",
			parentId: OWNER_ID,
			session: { isStreaming: false } as unknown as AgentSession,
			status: "idle",
		});
		firstTurn.resolve();
		await manager.getJob(spawned.jobId)?.promise;
		const followUp = Promise.withResolvers<FollowUpTurnOptions>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUp.resolve(options);
			return resultFor(options.id, options.message);
		});

		await registry.send(parent, { session: spawned.id, message: "next task" });

		expect((await followUp.promise).parentSessionId).toBe("vibe-parent-session");
	});
});
