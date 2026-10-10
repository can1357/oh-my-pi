import type { AgentMetricsSummary, AgentRecordLike, AgentStatus } from "./agent-hub-types";
import { MAIN_AGENT_ID } from "./agent-hub-types";
import type { ObservableSession } from "./session-observer-registry";

export type AgentMetrics = AgentMetricsSummary;

export interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
	/** Rows whose duration is an observer-measured active runtime. */
	activeDurationAgents: number;
}

interface AgentTreeProjection<TRecord extends AgentRecordLike> {
	rows: TRecord[];
	depthById: Map<string, number>;
	parentById: Map<string, string>;
	lastSiblingById: Map<string, boolean>;
}

export const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

function finiteMetric(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Message list a fallback metrics read was taken from; unchanged list ⇒ unchanged metrics. */
interface FallbackReadStamp {
	messages: readonly unknown[];
	length: number;
	last: unknown;
	/** Usage and block count of the last message, which a streaming turn mutates in place. */
	lastShape: string;
	/** Session model, whose context window the context gauge reports. */
	model: unknown;
	contextWindow: number | null | undefined;
}

/** Stamp of each cached fallback read, keyed by the cache entry so it cannot outlive that read. */
const fallbackReadStamps = new WeakMap<object, FallbackReadStamp>();

function lastMessageShape(last: unknown): string {
	if (!last || typeof last !== "object") return "";
	const { usage, content } = last as {
		usage?: { input?: number; output?: number; cacheWrite?: number; cost?: { total?: number } };
		content?: unknown;
	};
	const blocks = Array.isArray(content) ? content.length : -1;
	return `${usage?.input}:${usage?.output}:${usage?.cacheWrite}:${usage?.cost?.total}:${blocks}`;
}

function fallbackReadStamp(session: NonNullable<AgentRecordLike["session"]>): FallbackReadStamp | undefined {
	try {
		const messages = session.agent?.state?.messages;
		if (!Array.isArray(messages)) return undefined;
		const last = messages[messages.length - 1];
		return {
			messages,
			length: messages.length,
			last,
			lastShape: lastMessageShape(last),
			model: session.model,
			contextWindow: session.model?.contextWindow,
		};
	} catch {
		return undefined;
	}
}

/**
 * Whether a cached fallback read still matches the session's message list
 * (append, compaction, rewrite, streaming tail) and model (context window).
 */
function fallbackReadCurrent(entry: object, session: NonNullable<AgentRecordLike["session"]>): boolean {
	const stamp = fallbackReadStamps.get(entry);
	if (!stamp) return false;
	const current = fallbackReadStamp(session);
	return (
		current !== undefined &&
		current.messages === stamp.messages &&
		current.length === stamp.length &&
		current.last === stamp.last &&
		current.lastShape === stamp.lastShape &&
		current.model === stamp.model &&
		current.contextWindow === stamp.contextWindow
	);
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
export function readSessionMetrics(session: NonNullable<AgentRecordLike["session"]>): AgentMetrics | undefined {
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
			// Persisted and imported transcripts can predate usage metadata despite
			// the current message type, the same case `getSessionStats` skips.
			// Dereferencing it threw, and the catch below turned one legacy entry
			// into no metrics at all for the whole session.
			const usage = message.usage;
			if (usage) {
				tokens += usage.input + usage.output + usage.cacheWrite;
				cost += usage.cost.total;
			}
			tools += message.content.filter(content => content.type === "toolCall").length;
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

/** Live session whose own messages back a row's metrics when no observer progress exists. */
export function hubFallbackStatsSession<TRecord extends AgentRecordLike>(
	ref: TRecord,
	observed: ObservableSession | undefined,
): NonNullable<TRecord["session"]> | undefined {
	if (observed?.progress) return undefined;
	const session = ref.session;
	return session && typeof session.getSessionStats === "function" ? session : undefined;
}

/**
 * One roster row's usage: live observer progress, then persisted history, then
 * the cached fallback read of a live session (populated by {@link aggregateMetrics}).
 */
export function hubRowMetrics<TRecord extends AgentRecordLike>(
	ref: TRecord,
	observed: ObservableSession | undefined,
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>,
): AgentMetrics | undefined {
	if (observed?.progress) return progressMetrics(observed);
	if (ref.history?.metrics) return ref.history.metrics;
	const session = hubFallbackStatsSession(ref, observed);
	return session ? sessionMetrics.get(session)?.metrics : undefined;
}

export function aggregateMetrics<TRecord extends AgentRecordLike>(args: {
	rows: readonly TRecord[];
	observedById: ReadonlyMap<string, ObservableSession>;
	metricsFor: (ref: TRecord, observed: ObservableSession | undefined) => AgentMetrics | undefined;
	fallbackStatsSession: (
		ref: TRecord,
		observed: ObservableSession | undefined,
	) => NonNullable<AgentRecordLike["session"]> | undefined;
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
	const countedFallbackSessions = new Set<NonNullable<AgentRecordLike["session"]>>();
	for (const ref of args.rows) {
		const observed = args.observedById.get(ref.id);
		const fallbackSession = args.fallbackStatsSession(ref, observed);
		if (fallbackSession) {
			hasFallbackLiveSessions = true;
			const cached = args.sessionMetrics.get(fallbackSession);
			// A refresh rescans every assistant message (plus the host's stats);
			// skip it while the message list is provably the one already read.
			if (!cached || (args.refreshFallback && !fallbackReadCurrent(cached, fallbackSession))) {
				const stamp = fallbackReadStamp(fallbackSession);
				const entry = { metrics: readSessionMetrics(fallbackSession) };
				if (stamp) fallbackReadStamps.set(entry, stamp);
				args.sessionMetrics.set(fallbackSession, entry);
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

/** Parent-before-child projection preserving initial subtree rank and prepending new siblings. */
export function projectAgentTree<TRecord extends AgentRecordLike>(
	refs: readonly TRecord[],
	rosterRank: ReadonlyMap<TRecord, number> | undefined,
): AgentTreeProjection<TRecord> {
	const ids = new Set<string>();
	const operationalIndex = new Map<string, number>();
	for (let i = 0; i < refs.length; i++) {
		ids.add(refs[i].id);
		operationalIndex.set(refs[i].id, i);
	}

	const parentById = new Map<string, string>();
	const children = new Map<string, TRecord[]>();
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
		const stack: Array<{ ref: TRecord; expanded: boolean }> = [{ ref: start, expanded: false }];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) continue;
			if (current.expanded) {
				let order = operationalIndex.get(current.ref.id) ?? Number.MAX_SAFE_INTEGER;
				const parentRank = rosterRank?.get(current.ref);
				for (const child of children.get(current.ref.id) ?? []) {
					const childRank = rosterRank?.get(child);
					// A child spawned later cannot move an existing parent's group.
					if (parentRank !== undefined && childRank !== undefined && childRank < 0 && childRank < parentRank)
						continue;
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

	const rows: TRecord[] = [];
	const visited = new Set<string>();
	const depthById = new Map<string, number>();
	const visit = (root: TRecord, rootDepth: number): void => {
		const stack: Array<{ ref: TRecord; depth: number }> = [{ ref: root, depth: rootDepth }];
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
