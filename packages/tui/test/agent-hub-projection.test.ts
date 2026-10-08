import { describe, expect, it } from "bun:test";
import {
	type AgentMetrics,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";

function assistant(output: number) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		usage: { input: 10, output, cacheWrite: 0, cost: { total: output / 1000 } },
	};
}

describe("aggregateMetrics fallback reads", () => {
	it("refreshes when the streaming last message's usage changes in place", () => {
		const tail = assistant(5);
		const messages = [{ role: "user", content: "hi" }, tail];
		const session = {
			agent: { state: { messages } },
			getSessionStats: () => ({ contextUsage: undefined }),
		};
		const ref = { id: "main", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const run = () =>
			aggregateMetrics({
				rows: [ref],
				observedById: new Map(),
				metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
				fallbackStatsSession: hubFallbackStatsSession,
				sessionMetrics,
				refreshFallback: true,
			}).metrics.tokens;

		expect(run()).toBe(15);
		tail.usage.output = 40;
		expect(run()).toBe(50);
	});
});
