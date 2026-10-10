import { describe, expect, it } from "bun:test";
import {
	type AgentMetrics,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { ObservableSession } from "../src/overlays/session-observer-registry";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";

function assistant(output: number, cost = output / 1000) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		usage: { input: 10, output, cacheWrite: 0, cost: { total: cost } },
	};
}

function liveObserver(cost: number): ObservableSession {
	return {
		progress: {
			tokens: 80,
			requests: 4,
			toolCount: 3,
			cost,
			durationMs: 800,
			contextTokens: 64,
			contextWindow: 2048,
		},
	} as unknown as ObservableSession;
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
	it("uses cached lifetime session cost with live progress and refreshes it", () => {
		const messages = [assistant(100, 0.6), assistant(200, 0.3)];
		const session = {
			agent: { state: { messages } },
			getSessionStats: () => ({ contextUsage: undefined }),
		};
		const childSession = {
			agent: { state: { messages: [assistant(50, 0.2)] } },
			getSessionStats: () => ({ contextUsage: undefined }),
		};
		const ref = { id: "main", session } as unknown as AgentRecordLike;
		const childRef = { id: "child", session: childSession } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const observed = liveObserver(0.3);
		const childObserved = liveObserver(0.2);
		const run = () =>
			aggregateMetrics({
				rows: [ref, childRef],
				observedById: new Map([
					["main", observed],
					["child", childObserved],
				]),
				metricsFor: (row, current) => hubRowMetrics(row, current, sessionMetrics),
				fallbackStatsSession: hubFallbackStatsSession,
				sessionMetrics,
				refreshFallback: true,
			});

		const first = run();
		expect(first.metrics.cost).toBeCloseTo(1.1);
		expect(first.metrics).toMatchObject({
			tokens: 160,
			requests: 8,
			tools: 6,
			durationMs: 1600,
			durationKind: "active",
			activeDurationAgents: 2,
		});
		const firstRow = hubRowMetrics(ref, observed, sessionMetrics);
		expect(firstRow?.cost).toBeCloseTo(0.9);
		expect(firstRow).toMatchObject({
			tokens: 80,
			requests: 4,
			tools: 3,
			durationMs: 800,
			durationKind: "active",
			contextTokens: 64,
			contextWindow: 2048,
		});

		messages.push(assistant(300, 0.2));
		observed.progress!.cost = 0.2;
		const refreshed = run();
		expect(refreshed.metrics.cost).toBeCloseTo(1.3);
		expect(refreshed.metrics).toMatchObject({
			tokens: 160,
			requests: 8,
			tools: 6,
			durationMs: 1600,
			activeDurationAgents: 2,
		});
		expect(hubRowMetrics(ref, observed, sessionMetrics)?.cost).toBeCloseTo(1.1);
		messages.push(assistant(400, 0));
		session.getSessionStats = () => {
			throw new Error("session is stopping");
		};
		const tearingDown = run();
		expect(tearingDown.metrics.cost).toBeCloseTo(1.3);

		ref.session = null;
		const parked = run();
		expect(parked.metrics.cost).toBeCloseTo(1.3);
		expect(parked.metrics.reportedAgents).toBe(2);
		expect(hubRowMetrics(ref, observed, sessionMetrics)?.cost).toBeCloseTo(1.1);
	});

	it("excludes nested task result usage while counting the child row once", () => {
		const parentSession = {
			agent: {
				state: {
					messages: [
						assistant(100, 0.6),
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "task-call", name: "task", arguments: {} }],
							usage: { input: 0, output: 0, cacheWrite: 0, cost: { total: 0 } },
						},
						{
							role: "toolResult",
							toolCallId: "task-call",
							toolName: "task",
							content: [],
							details: { usage: { cost: { total: 99 } } },
						},
					],
				},
			},
			getSessionStats: () => ({ cost: 99.8, contextUsage: undefined }),
		};
		const childSession = {
			agent: { state: { messages: [assistant(20, 0.2)] } },
			getSessionStats: () => ({ cost: 0.2, contextUsage: undefined }),
		};
		const rows = [
			{ id: "parent", session: parentSession },
			{ id: "child", session: childSession },
		] as unknown as AgentRecordLike[];
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const metrics = aggregateMetrics({
			rows,
			observedById: new Map([
				["parent", liveObserver(0.6)],
				["child", liveObserver(0.2)],
			]),
			metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback: true,
		}).metrics;

		expect(metrics.cost).toBeCloseTo(0.8);
		expect(metrics.reportedAgents).toBe(2);
	});
});
