/**
 * Contract: worker ids keep only [A-Za-z0-9_-] from the user's label,
 * otherwise they fall back to a generated name.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one named worker and capture the ExecutorOptions handed to the executor. */
async function spawnAndCaptureOptions(name: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const settings = Settings.isolated({
		modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
	});
	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings), { cli: "good", name, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn names", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("removes path separators and punctuation from custom worker ids", async () => {
		const options = await spawnAndCaptureOptions("../My Worker!");

		expect(options.id).toBe("MyWorker");
	});

	it("generates a valid worker id when no label characters survive", async () => {
		const options = await spawnAndCaptureOptions("!!!");

		expect(options.id).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});
