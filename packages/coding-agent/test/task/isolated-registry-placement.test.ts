import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type ExecutorOptions, runSubprocess, type SubagentRunRequest } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";

/**
 * Contract: worker threads serve the process-global registry, IRC bus and lifecycle, so main's
 * pool may place only subagents of the global registry. A subagent of an isolated session
 * registry must stay on the main thread (in a worker it would register and message in the global
 * world), and a placed run must not carry the registry object across the thread link.
 */
describe("subagent worker placement and isolated registries", () => {
	afterEach(() => {
		setSubagentWorkerPoolForTests(undefined);
		vi.restoreAllMocks();
	});

	function fakePool() {
		const requests: SubagentRunRequest[] = [];
		const worker = {
			alive: true,
			threadId: 7,
			link: {
				call: async (_method: string, request: SubagentRunRequest) => {
					requests.push(request);
					return { id: request.options.id, exitCode: 0 } as unknown as SingleResult;
				},
			},
		};
		const place = vi.fn(() => ({ worker, release: () => {} }));
		const pool = { place, settle: async (placement: unknown) => placement } as unknown as SubagentWorkerPool;
		return { pool, place, requests };
	}

	function options(overrides: Partial<ExecutorOptions>): ExecutorOptions {
		return {
			cwd: process.cwd(),
			agent: { name: "task", description: "", systemPrompt: "", source: "bundled" } as unknown as AgentDefinition,
			task: "noop",
			index: 0,
			id: "Placed",
			settings: Settings.isolated({}),
			// Pre-aborted: a run kept on this thread returns at once instead of starting a session.
			signal: AbortSignal.abort(),
			...overrides,
		};
	}

	it("keeps a subagent of an isolated registry on the main thread", async () => {
		const { pool, place } = fakePool();
		setSubagentWorkerPoolForTests(pool);

		const result = await runSubprocess(options({ agentRegistry: new AgentRegistry() }));

		expect(place).not.toHaveBeenCalled();
		expect(result.aborted).toBe(true);
	});

	it("places a global-registry subagent without sending the registry over the link", async () => {
		const { pool, place, requests } = fakePool();
		setSubagentWorkerPoolForTests(pool);

		await runSubprocess(options({ agentRegistry: AgentRegistry.global() }));

		expect(place).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.options.id).toBe("Placed");
		expect("agentRegistry" in requests[0]!.options).toBe(false);
	});
});
