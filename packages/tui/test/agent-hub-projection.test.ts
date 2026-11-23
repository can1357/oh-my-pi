import { describe, expect, it } from "bun:test";
import {
	type AgentMetrics,
	aggregateCost,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import { sessionThroughput } from "../src/overlays/usage-row";
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

describe("aggregateCost", () => {
	it("refreshes SDK fallback usage and retains the last successful charge through teardown", () => {
		const messages = [assistant(100, 0.6), assistant(200, 0.3)];
		const session = {
			agent: { state: { messages } },
			getSessionStats: () => ({ contextUsage: undefined }),
		};
		const ref = { id: "worker", session } as unknown as AgentRecordLike;
		const args = { rows: [ref], observedById: new Map(), sessionCosts: new WeakMap() };
		expect(aggregateCost(args)).toBeCloseTo(0.9);
		messages[1].usage.cost.total = 0.5;
		expect(aggregateCost(args)).toBeCloseTo(1.1);
		messages.push(assistant(300, 0));
		session.getSessionStats = () => {
			throw new Error("session is stopping");
		};
		const observed = liveObserver(0.2);
		args.observedById.set(ref.id, observed);
		expect(aggregateCost(args)).toBeCloseTo(1.1);
		args.observedById.clear();
		expect(aggregateCost(args)).toBe(0);
		ref.session = null;
		expect(aggregateCost(args)).toBeCloseTo(1.1);
		ref.history = { directCost: 1.2 };
		expect(aggregateCost(args)).toBeCloseTo(1.2);
	});

	it("does not invent a parked row from direct-cost history without a retained snapshot", () => {
		const ref = { id: "worker", session: null, history: { directCost: 2 } } as unknown as AgentRecordLike;
		const args = { rows: [ref], observedById: new Map(), sessionCosts: new WeakMap() };
		expect(aggregateCost(args)).toBe(0);
		ref.history!.metrics = { tokens: 1, requests: 1, tools: 0, durationMs: 0, cost: 0.4 };
		expect(aggregateCost(args)).toBe(2);
	});

	it("preserves observer validity and history precedence without counting shared sessions twice", () => {
		const session = {
			sessionManager: { getUsageStatistics: () => ({ cost: 99.9, subagentCost: 99 }) },
			getSessionStats: () => {
				throw new Error("Cost projection must not read the transcript");
			},
		};
		const observed = liveObserver(0.2);
		const ref = {
			id: "worker",
			session: null,
			history: { metrics: { tokens: 1, requests: 1, tools: 0, durationMs: 0, cost: 0.1 } },
		} as unknown as AgentRecordLike;
		const args = {
			rows: [ref],
			observedById: new Map([[ref.id, observed]]),
			sessionCosts: new WeakMap(),
		};
		expect(aggregateCost(args)).toBeCloseTo(0.2);
		ref.history!.directCost = 0.4;
		expect(aggregateCost(args)).toBeCloseTo(0.4);
		ref.session = session as unknown as AgentRecordLike["session"];
		args.rows.push({ ...ref, id: "alias" });
		expect(aggregateCost(args)).toBeCloseTo(0.9);
		args.rows.pop();
		observed.progress!.tokens = Number.NaN;
		expect(aggregateCost(args)).toBe(0);
	});

	it("falls back to direct assistant usage when the indexed bill is invalid", () => {
		const indexed = { cost: Number.NaN, subagentCost: 0 };
		const session = {
			sessionManager: { getUsageStatistics: () => indexed },
			agent: { state: { messages: [assistant(100, 0.6)] } },
			getSessionStats: () => ({ cost: 99.6, contextUsage: undefined }),
		};
		const args = {
			rows: [{ id: "worker", session }] as unknown as AgentRecordLike[],
			observedById: new Map(),
			sessionCosts: new WeakMap(),
		};
		expect(aggregateCost(args)).toBeCloseTo(0.6);
		indexed.cost = 0.1;
		indexed.subagentCost = 1;
		expect(aggregateCost(args)).toBeCloseTo(0.6);
	});
});

describe("hubRowMetrics tokensPerSecond", () => {
	it("reads live rate from streaming session tokenRate meter", () => {
		const session = {
			isStreaming: true,
			tokenRate: { rate: () => 85.5 },
			getSessionStats: () => ({
				tokens: { input: 10, output: 100, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 0,
				cost: 0.01,
			}),
		};
		const ref = { id: "worker", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		aggregateMetrics({
			rows: [ref],
			observedById: new Map(),
			metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback: true,
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(85.5);
	});

	it("calculates tokensPerSecond from the last completed assistant turn", () => {
		const messages = [
			{
				role: "assistant",
				duration: 2000,
				content: [],
				usage: { input: 10, output: 150, cacheWrite: 0, cost: { total: 0.01 } },
			},
		];
		const session = {
			agent: { state: { messages } },
			getSessionStats: () => ({
				tokens: { input: 10, output: 150, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 0,
				cost: 0.01,
			}),
		};
		const ref = { id: "worker", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		aggregateMetrics({
			rows: [ref],
			observedById: new Map(),
			metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback: true,
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(75);
	});

	it("omits tokensPerSecond when duration is too short to be meaningful", () => {
		const messages = [
			{
				role: "assistant",
				duration: 50,
				content: [],
				usage: { input: 10, output: 150, cacheWrite: 0, cost: { total: 0.01 } },
			},
		];
		const session = {
			agent: { state: { messages } },
			getSessionStats: () => ({
				tokens: { input: 10, output: 150, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 0,
				cost: 0.01,
			}),
		};
		const ref = { id: "worker", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		aggregateMetrics({
			rows: [ref],
			observedById: new Map(),
			metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback: true,
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBeUndefined();
	});

	it("resamples live rate dynamically on hubRowMetrics even without aggregate re-read", () => {
		let rate = 50.0;
		const session = {
			isStreaming: true,
			tokenRate: { rate: () => rate },
			getSessionStats: () => ({
				tokens: { input: 10, output: 100, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 0,
				cost: 0.01,
			}),
		};
		const ref = { id: "worker", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		aggregateMetrics({
			rows: [ref],
			observedById: new Map(),
			metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
			fallbackStatsSession: hubFallbackStatsSession,
			sessionMetrics,
			refreshFallback: true,
		});
		expect(hubRowMetrics(ref, undefined, sessionMetrics)?.tokensPerSecond).toBe(50.0);
		rate = 92.4;
		expect(hubRowMetrics(ref, undefined, sessionMetrics)?.tokensPerSecond).toBe(92.4);
	});

	it("preserves retained completed tokensPerSecond when session is parked with an observer progress frame", () => {
		const ref = { id: "worker", session: null } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		sessionMetrics.set(ref, {
			metrics: { tokens: 150, requests: 1, tools: 0, cost: 0.01, durationMs: 2000, tokensPerSecond: 75.0 },
		});
		const observed = liveObserver(0.01);
		const metrics = hubRowMetrics(ref, observed, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(75.0);
	});

	it("prefers current live completed throughput over persisted historical throughput when live session is attached", () => {
		const session = {
			agent: { state: { messages: [] } },
			getSessionStats: () => ({
				tokens: { input: 10, output: 150, cacheWrite: 0 },
				assistantMessages: 1,
				toolCalls: 0,
				cost: 0.01,
			}),
		};
		const ref = {
			id: "worker",
			session,
			history: {
				metrics: { tokens: 100, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 50.0 },
			},
		} as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		sessionMetrics.set(session, {
			metrics: { tokens: 150, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 150.0 },
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(150.0);
	});

	it("prefers fresh park-time throughput over older historical metrics when session parks", () => {
		const ref = {
			id: "worker",
			session: null,
			history: {
				tokensPerSecond: 150.0,
				metrics: { tokens: 100, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 50.0 },
			},
		} as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(150.0);
	});

	it("extracts tokensPerSecond from observer progress for observer-only / collab-guest clients", () => {
		const ref = { id: "collab-worker", session: null } as unknown as AgentRecordLike;
		const observed: ObservableSession = {
			progress: {
				tokens: 80,
				requests: 4,
				toolCount: 3,
				cost: 0.05,
				durationMs: 800,
				contextTokens: 64,
				contextWindow: 2048,
				tokensPerSecond: 100.0,
			},
		} as unknown as ObservableSession;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const metrics = hubRowMetrics(ref, observed, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(100.0);
	});

	it("preserves newer retained throughput when a resumed worker is killed", () => {
		const ref = {
			id: "worker",
			session: null,
			history: {
				tokensPerSecond: 75.0,
				metrics: { tokens: 100, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 75.0 },
			},
		} as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		sessionMetrics.set(ref, {
			metrics: { tokens: 250, requests: 2, tools: 1, cost: 0.02, durationMs: 2000, tokensPerSecond: 150.0 },
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(150.0);
	});

	it("prefers a park-stamped history rate over a stale retained rate", () => {
		const ref = {
			id: "worker",
			session: null,
			history: {
				tokensPerSecond: 150.0,
				tokensPerSecondSource: "park",
				metrics: { tokens: 100, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 150.0 },
			},
		} as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		sessionMetrics.set(ref, {
			metrics: { tokens: 100, requests: 1, tools: 0, cost: 0.01, durationMs: 1000, tokensPerSecond: 75.0 },
		});
		const metrics = hubRowMetrics(ref, undefined, sessionMetrics);
		expect(metrics?.tokensPerSecond).toBe(150.0);
	});
});

describe("sessionThroughput", () => {
	it("returns live rate when stream meter has evidence", () => {
		const session = { isStreaming: true, tokenRate: { rate: () => 120.0 } };
		expect(sessionThroughput(session)).toBe(120.0);
	});

	it("falls back to completed turn throughput when live meter is null", () => {
		const messages = [
			{
				role: "assistant",
				duration: 1000,
				content: [],
				usage: { input: 10, output: 80, cacheWrite: 0, cost: { total: 0.01 } },
			},
		];
		const session = { isStreaming: true, tokenRate: { rate: () => null }, agent: { state: { messages } } };
		expect(sessionThroughput(session)).toBe(80.0);
	});
});
