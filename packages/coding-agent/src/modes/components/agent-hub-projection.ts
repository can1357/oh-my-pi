import type { AgentMetricsSummary, AgentRef, AgentStatus } from "../../registry/agent-registry";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import { sessionFileBelongsToRoot } from "../../registry/persisted-agents";
import type { SessionEntry } from "../../session/session-entries";
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
	const { tokens, requests, toolCount: tools, durationMs } = progress;
	const cost = progress.cost + (observed.priorTurnCost ?? 0);
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
 * Read direct child ids from completed root `task` results. The root branch is
 * the only durable source that can prove a direct synchronous child was already
 * represented in the root session's aggregate usage. Keep this parser tolerant
 * of old and malformed entries: a bad result contributes no ids.
 */
function completedRootTaskChildIds(activeRootBranch: readonly SessionEntry[] | undefined): Set<string> {
	const ids = new Set<string>();
	if (!activeRootBranch) return ids;
	for (const entry of activeRootBranch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") {
			continue;
		}
		const details = entry.message.details;
		if (
			!details ||
			typeof details !== "object" ||
			Array.isArray(details) ||
			!("results" in details) ||
			!Array.isArray(details.results)
		) {
			continue;
		}
		const results = details.results;
		if (!Array.isArray(results)) continue;
		for (const result of results) {
			if (!result || typeof result !== "object" || Array.isArray(result) || !("id" in result)) continue;
			const id = result.id;
			if (typeof id === "string" && id.length > 0) ids.add(id);
		}
	}
	return ids;
}

/**
 * Sum subagent spend omitted from the root session's own status-line usage.
 * Every root-owned subagent contributes its direct metrics exactly once, while
 * direct children already represented by a completed root `task` result are
 * excluded because that spend is already inside root SessionStats. Detached,
 * eval, legacy, and nested rows are otherwise all eligible.
 */
export function aggregateUnreportedSubagentCost(
	refs: readonly AgentRef[],
	sessions: readonly ObservableSession[],
	rootSessionFile?: string,
	activeRootBranch?: readonly SessionEntry[],
): number {
	const observedById = new Map(sessions.map(session => [session.id, session]));
	const representedRootChildIds = completedRootTaskChildIds(activeRootBranch);
	let total = 0;
	for (const ref of refs) {
		if (ref.kind !== "sub") continue;
		const observed = observedById.get(ref.id);
		const sessionFile = typeof ref.sessionFile === "string" ? ref.sessionFile : observed?.sessionFile;
		if (
			typeof sessionFile === "string"
				? !rootSessionFile || !sessionFileBelongsToRoot(sessionFile, rootSessionFile)
				: !observed
		) {
			continue;
		}
		const directRoot = ref.parentId === undefined || ref.parentId === null || ref.parentId === MAIN_AGENT_ID;
		if (directRoot && representedRootChildIds.has(ref.id)) continue;
		const metrics =
			progressMetrics(observed) ??
			ref.history?.metrics ??
			(ref.session ? readSessionMetrics(ref.session) : undefined);
		if (metrics && metrics.cost > 0) total += metrics.cost;
	}
	return total;
}

/**
 * Read direct assistant usage from a live session. SessionStats also includes
 * usage embedded in completed `task` tool results, so using it for a parent
 * row would double-count child rows in the aggregate. Only the assistant
 * messages themselves are therefore used as the fallback metric.
 */
function readSessionMetrics(session: NonNullable<AgentRef["session"]>): AgentMetrics | undefined {
	try {
		const messages = session.agent?.state?.messages;
		if (!Array.isArray(messages)) return undefined;
		let contextTokens: number | undefined;
		let contextWindow: number | undefined;
		try {
			const stats = session.getSessionStats();
			contextTokens = stats.contextUsage?.tokens;
			contextWindow = stats.contextUsage?.contextWindow;
		} catch {
			// Direct assistant usage below remains usable when stats are tearing down.
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
			contextTokens,
			contextWindow,
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
