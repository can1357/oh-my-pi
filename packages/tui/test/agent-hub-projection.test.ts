import { treeAgentLabel } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
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

describe("treeAgentLabel", () => {
	it("strips parent prefix when child is rendered under its parent", () => {
		expect(treeAgentLabel("Parent.Child", "Parent", 1)).toBe("Child");
		expect(treeAgentLabel("A.B.C", "A.B", 2)).toBe("C");
	});

	it("preserves full id when agent is rendered at root depth", () => {
		expect(treeAgentLabel("Solo", undefined, 0)).toBe("Solo");
		expect(treeAgentLabel("Parent.Child", undefined, 0)).toBe("Parent.Child");
		expect(treeAgentLabel("Parent.Child", "Main", 0)).toBe("Parent.Child");
	});

	it("preserves full id when prefix does not match displayed parent", () => {
		expect(treeAgentLabel("Other.Child", "Parent", 1)).toBe("Other.Child");
		expect(treeAgentLabel("Child", "Parent", 1)).toBe("Child");
	});

	it("preserves dots within the child name segment", () => {
		expect(treeAgentLabel("Parent.step1.5", "Parent", 1)).toBe("step1.5");
	});
});
