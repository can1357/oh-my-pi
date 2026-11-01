import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor";

describe("AdvisorRuntime strikes across context maintenance", () => {
	it("drops a batch that fails three times even when maintenance re-primes before every attempt", async () => {
		let prompts = 0;
		const agent: AdvisorAgent = {
			prompt: async () => {
				prompts++;
				throw new Error("429 Rate limit exceeded: max_parallel_requests retry-after-ms=60000");
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const messages: AgentMessage[] = [{ role: "user", content: "one update", timestamp: 1 } as AgentMessage];
		const notified = Promise.withResolvers<void>();
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			// No compaction candidate: maintenance falls back to a re-prime every time.
			maintainContext: async () => true,
			// The provider-wait budget is spent, so recovery declines and the runtime's own strikes decide.
			onTurnError: async () => false,
			notifyFailure: () => notified.resolve(),
		};
		const runtime = new AdvisorRuntime(agent, host, 0);

		runtime.onTurnEnd();
		await notified.promise;

		expect(prompts).toBe(3);
		expect(runtime.backlog).toBe(0);
		runtime.dispose();
	}, 2_000);
});
