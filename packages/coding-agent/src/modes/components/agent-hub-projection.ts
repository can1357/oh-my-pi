import type { AgentMetricsSummary, AgentRef, AgentStatus } from "../../registry/agent-registry";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { ObservableSession } from "../session-observer-registry";

export type AgentMetrics = AgentMetricsSummary;

export interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
	/** Rows whose duration is an observer-measured active runtime. */
	activeDurationAgents: number;
}

interface AgentTreeProjection {
	rows: AgentRef[];
	depthById: Map<string, number>;
	parentById: Map<string, string>;
	lastSiblingById: Map<string, boolean>;
}

export const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

function finiteMetric(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Exact observer usage for one roster entry. */
export function progressMetrics(observed: ObservableSession | undefined): AgentMetrics | undefined {
	const progress = observed?.progress;
	if (!progress) return undefined;
	const { tokens, requests, toolCount: tools, cost, durationMs } = progress;
	if (
		typeof tokens !== "number" ||
		!Number.isFinite(tokens) ||
		typeof requests !== "number" ||
		!Number.isFinite(requests) ||
		typeof tools !== "number" ||
		!Number.isFinite(tools) ||
		typeof cost !== "number" ||
		!Number.isFinite(cost) ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs)
	) {
		return undefined;
	}
	return {
		tokens,
		requests,
		tools,
		cost,
		durationMs,
		durationKind: "active",
		contextTokens:
			typeof progress.contextTokens === "number" && Number.isFinite(progress.contextTokens)
				? progress.contextTokens
				: undefined,
		contextWindow:
			typeof progress.contextWindow === "number" && Number.isFinite(progress.contextWindow)
				? progress.contextWindow
				: undefined,
	};
}

/**
 * Read direct assistant usage from a live session. SessionStats also includes
 * usage embedded in completed `task` tool results, so using it for a parent
 * row would double-count child rows in the aggregate.
 */
function readSessionMetrics(session: NonNullable<AgentRef["session"]>): AgentMetrics | undefined {
	try {
		const stats = session.getSessionStats();
		const messages = session.agent?.state?.messages;
		if (!Array.isArray(messages)) {
			return {
				tokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
				requests: stats.assistantMessages,
				tools: stats.toolCalls,
				cost: stats.cost,
				durationMs: 0,
				durationKind: "unknown",
				contextTokens: stats.contextUsage?.tokens,
				contextWindow: stats.contextUsage?.contextWindow,
			};
		}

		let tokens = 0;
		let requests = 0;
		let tools = 0;
		let cost = 0;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			requests++;
			tokens += message.usage.input + message.usage.output + message.usage.cacheWrite;
			tools += message.content.filter(content => content.type === "toolCall").length;
			cost += message.usage.cost.total;
		}
		return {
			tokens,
			requests,
			tools,
			cost,
			durationMs: 0,
			durationKind: "unknown",
			contextTokens: stats.contextUsage?.tokens,
			contextWindow: stats.contextUsage?.contextWindow,
		};
	} catch {
		// Render-only doubles and sessions being torn down may not expose a
		// complete statistics host. Missing metrics are preferable to a broken hub.
		return undefined;
	}
}

export function aggregateMetrics(args: {
	rows: readonly AgentRef[];
	observedById: ReadonlyMap<string, ObservableSession>;
	metricsFor: (ref: AgentRef, observed: ObservableSession | undefined) => AgentMetrics | undefined;
	fallbackStatsSession: (
		ref: AgentRef,
		observed: ObservableSession | undefined,
	) => NonNullable<AgentRef["session"]> | undefined;
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>;
	refreshFallback: boolean;
}): { metrics: AggregateMetrics; hasFallbackLiveSessions: boolean } {
	const total: AggregateMetrics = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: 0,
		durationKind: "active",
		reportedAgents: 0,
		activeDurationAgents: 0,
	};
	let hasFallbackLiveSessions = false;
	const countedFallbackSessions = new Set<NonNullable<AgentRef["session"]>>();
	for (const ref of args.rows) {
		const observed = args.observedById.get(ref.id);
		const fallbackSession = args.fallbackStatsSession(ref, observed);
		if (fallbackSession) {
			hasFallbackLiveSessions = true;
			if (args.refreshFallback || !args.sessionMetrics.has(fallbackSession)) {
				args.sessionMetrics.set(fallbackSession, { metrics: readSessionMetrics(fallbackSession) });
			}
		}
		const metrics = args.metricsFor(ref, observed);
		if (!metrics || (fallbackSession && countedFallbackSessions.has(fallbackSession))) continue;
		if (fallbackSession) countedFallbackSessions.add(fallbackSession);
		total.reportedAgents++;
		total.tokens += finiteMetric(metrics.tokens);
		total.requests += finiteMetric(metrics.requests);
		total.tools += finiteMetric(metrics.tools);
		total.cost += finiteMetric(metrics.cost);
		if (metrics.durationKind === "active") {
			total.durationMs += finiteMetric(metrics.durationMs);
			total.activeDurationAgents++;
		}
	}
	return { metrics: total, hasFallbackLiveSessions };
}

/** Parent-before-child projection preserving the roster's stable sibling order. */
export function projectAgentTree(refs: readonly AgentRef[]): AgentTreeProjection {
	const ids = new Set<string>();
	const operationalIndex = new Map<string, number>();
	for (let i = 0; i < refs.length; i++) {
		ids.add(refs[i].id);
		operationalIndex.set(refs[i].id, i);
	}

	const parentById = new Map<string, string>();
	const children = new Map<string, AgentRef[]>();
	for (const ref of refs) {
		const parent =
			ref.parentId && ref.parentId !== MAIN_AGENT_ID && ids.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
		parentById.set(ref.id, parent);
		const siblings = children.get(parent);
		if (siblings) siblings.push(ref);
		else children.set(parent, [ref]);
	}

	// A tree group occupies the position of its earliest operational row.
	// Compute subtree minima iteratively so pathological lineage depth remains stack-safe.
	const subtreeOrder = new Map<string, number>();
	const visiting = new Set<string>();
	const ranked = new Set<string>();
	for (const start of refs) {
		if (ranked.has(start.id)) continue;
		const stack: Array<{ ref: AgentRef; expanded: boolean }> = [{ ref: start, expanded: false }];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) continue;
			if (current.expanded) {
				let order = operationalIndex.get(current.ref.id) ?? Number.MAX_SAFE_INTEGER;
				for (const child of children.get(current.ref.id) ?? []) {
					order = Math.min(order, subtreeOrder.get(child.id) ?? Number.MAX_SAFE_INTEGER);
				}
				subtreeOrder.set(current.ref.id, order);
				visiting.delete(current.ref.id);
				ranked.add(current.ref.id);
				continue;
			}
			if (ranked.has(current.ref.id) || visiting.has(current.ref.id)) continue;
			visiting.add(current.ref.id);
			stack.push({ ref: current.ref, expanded: true });
			const descendants = children.get(current.ref.id);
			if (!descendants) continue;
			for (let i = descendants.length - 1; i >= 0; i--) {
				const child = descendants[i];
				if (!ranked.has(child.id) && !visiting.has(child.id)) stack.push({ ref: child, expanded: false });
			}
		}
	}
	for (const siblings of children.values()) {
		siblings.sort(
			(a, b) =>
				(subtreeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (subtreeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
				(operationalIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
					(operationalIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	const lastSiblingById = new Map<string, boolean>();
	for (const siblings of children.values()) {
		for (let i = 0; i < siblings.length; i++) lastSiblingById.set(siblings[i].id, i === siblings.length - 1);
	}

	const rows: AgentRef[] = [];
	const visited = new Set<string>();
	const depthById = new Map<string, number>();
	const visit = (root: AgentRef, rootDepth: number): void => {
		const stack: Array<{ ref: AgentRef; depth: number }> = [{ ref: root, depth: rootDepth }];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || visited.has(current.ref.id)) continue;
			visited.add(current.ref.id);
			depthById.set(current.ref.id, current.depth);
			rows.push(current.ref);
			const descendants = children.get(current.ref.id);
			if (!descendants) continue;
			for (let i = descendants.length - 1; i >= 0; i--)
				stack.push({ ref: descendants[i], depth: current.depth + 1 });
		}
	};
	for (const root of children.get(MAIN_AGENT_ID) ?? []) visit(root, 0);
	// Corrupt persisted parent cycles remain visible as roots instead of disappearing.
	for (const ref of refs) visit(ref, 0);
	return { rows, depthById, parentById, lastSiblingById };
}
