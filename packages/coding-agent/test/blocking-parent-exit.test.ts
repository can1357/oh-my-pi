/**
 * Regression: blocking (sync) spawns receive the parent abort signal and
 * reconcile as aborted when the parent turn is cancelled mid-flight.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const blockingLuna: AgentDefinition = {
	name: "estate-luna",
	description: "Blocking luna",
	systemPrompt: "luna",
	source: "project",
	blocking: true,
};

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, ...options.settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "estate-luna, reviewer",
		getAgentId: () => "ParentLead",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "estate-luna",
		agentSource: "project",
		task: "task",
		assignment: "Do work.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("blocking parent-exit reconciliation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes parent abort signal to blocking inline spawn and marks aborted on cancel", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingLuna],
			projectAgentsDir: null,
		});

		let capturedSignal: AbortSignal | undefined;
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedSignal = options.signal;
			await new Promise<void>((resolve, reject) => {
				if (!options.signal) {
					resolve();
					return;
				}
				if (options.signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				gate.promise.then(resolve).catch(reject);
			});
			return makeResult(options.id ?? "Child", { aborted: options.signal?.aborted === true, exitCode: 1 });
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = await TaskTool.create(createSession({ manager }));
		const controller = new AbortController();

		const run = tool.execute(
			"tc-blocking-abort",
			{ agent: "estate-luna", task: "Blocking work." } satisfies TaskParams,
			controller.signal,
		);

		const deadline = Date.now() + 1_000;
		while (!capturedSignal) {
			if (Date.now() > deadline) throw new Error("Blocking spawn never reached executor");
			await Bun.sleep(5);
		}

		controller.abort();
		gate.resolve();

		const result = await run;
		expect(capturedSignal?.aborted).toBe(true);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toMatch(/aborted|Task execution failed/i);
	});
});
