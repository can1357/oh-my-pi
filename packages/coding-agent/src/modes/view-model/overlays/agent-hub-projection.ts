import type { AgentMetricsSummary, AgentRecordLike } from "../../../registry/agent-hub-types";
import type { ObservableSession } from "../../../task/session-observer-registry";
import { type AiuTotals, addCallAiu, callAiu } from "../../../session/aiu-billing";

export type AgentMetrics = AgentMetricsSummary;

export interface AgentCostSnapshot {
	cost: number | undefined;
	/** Own-session AI credits beside `cost`; absent when the source carries none. */
	aiu?: AiuTotals;
}

export interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
	/** Rows whose duration is an observer-measured active runtime. */
	activeDurationAgents: number;
}

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

/** Lifetime direct spend from the authoritative session index, excluding task-result child billing. */
function readSessionDirectSpend(session: NonNullable<AgentRecordLike["session"]>): AgentCostSnapshot | undefined {
	try {
		const usage = session.sessionManager?.getUsageStatistics();
		if (
			usage &&
			Number.isFinite(usage.cost) &&
			Number.isFinite(usage.subagentCost) &&
			usage.cost >= usage.subagentCost
		) {
			return {
				cost: usage.cost - usage.subagentCost,
				...(usage.aiuNano === undefined
					? {}
					: { aiu: { nano: usage.aiuNano, unknownCalls: usage.aiuUnknownCalls ?? 0 } }),
			};
		}
	} catch {
		// A session stopping during render may have already closed its stats host.
	}
	return undefined;
}

/** Lifetime direct cost; see {@link readSessionDirectSpend}. */
function readSessionDirectCost(session: NonNullable<AgentRecordLike["session"]>): number | undefined {
	return readSessionDirectSpend(session)?.cost;
}

/** AI credits of a session's assistant messages, for sessions without a usage index. */
function readMessagesAiu(session: NonNullable<AgentRecordLike["session"]>): AiuTotals | undefined {
	const messages = session.agent?.state?.messages;
	if (!Array.isArray(messages)) return undefined;
	const totals: AiuTotals = { nano: 0, unknownCalls: 0 };
	for (const message of messages) {
		if (message.role === "assistant") addCallAiu(totals, callAiu(message));
	}
	return totals;
}

/**
 * Read direct assistant usage from a live session. SessionStats also includes
 * usage embedded in completed `task` tool results, so using it for a parent
 * row would double-count child rows in the aggregate.
 */
function readSessionMetrics(
	session: NonNullable<AgentRecordLike["session"]>,
	directCost: number | undefined,
): AgentMetrics | undefined {
	try {
		const stats = session.getSessionStats();
		const messages = session.agent?.state?.messages;
		if (!Array.isArray(messages)) {
			return {
				tokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
				requests: stats.assistantMessages,
				tools: stats.toolCalls,
				cost: directCost ?? stats.cost,
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
			cost: directCost ?? cost,
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

/** Live session used to cache a row's direct assistant usage, including with observer progress. */
export function hubFallbackStatsSession<TRecord extends AgentRecordLike>(
	ref: TRecord,
	observed: ObservableSession | undefined,
): NonNullable<TRecord["session"]> | undefined {
	void observed;
	const session = ref.session;
	return session && typeof session.getSessionStats === "function" ? session : undefined;
}

/**
 * Shared row policy for the Agent Hub and the status-line cost total.
 * Non-cost metrics come from live progress, then persisted history, then the retained
 * snapshot (parked rows only), then the live session. Cost always overlays the cumulative
 * direct-session bill: live, then `history.directCost` (written at park), then retained.
 * Persisted `history.metrics.cost` is a leaf-scoped snapshot, so it never wins.
 */
function projectRowMetrics<TMetrics extends AgentCostSnapshot>(
	ref: AgentRecordLike,
	observed: ObservableSession | undefined,
	live: TMetrics | undefined,
	retained: TMetrics | undefined,
	hasLiveSession: boolean,
): TMetrics | AgentMetrics | undefined {
	const cost = live?.cost ?? ref.history?.directCost ?? retained?.cost;
	const metrics = observed?.progress
		? progressMetrics(observed)
		: (ref.history?.metrics ?? (!hasLiveSession ? retained : undefined) ?? live);
	return metrics && cost !== undefined ? { ...metrics, cost } : metrics;
}

/** Full Agent Hub row metrics; see {@link projectRowMetrics} for source precedence. */
export function hubRowMetrics<TRecord extends AgentRecordLike>(
	ref: TRecord,
	observed: ObservableSession | undefined,
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>,
): AgentMetrics | undefined {
	const session = hubFallbackStatsSession(ref, observed);
	const liveEntry = session ? sessionMetrics.get(session) : undefined;
	const retainedEntry = sessionMetrics.get(ref);
	return projectRowMetrics(ref, observed, liveEntry?.metrics, retainedEntry?.metrics, session !== undefined);
}

/** A subagent tree's spend: dollars and server-reported AI credits. */
export interface AgentTreeSpend {
	cost: number;
	aiu: AiuTotals;
}

/** Cost-only projection for frequent status updates; full roster metrics keep their own cache. */
export function aggregateCost<TRecord extends AgentRecordLike>(args: {
	rows: readonly TRecord[];
	observedById: ReadonlyMap<string, ObservableSession>;
	sessionCosts: WeakMap<object, AgentCostSnapshot>;
}): AgentTreeSpend {
	const total: AgentTreeSpend = { cost: 0, aiu: { nano: 0, unknownCalls: 0 } };
	const countedSessions = new Set<NonNullable<AgentRecordLike["session"]>>();
	for (const ref of args.rows) {
		const observed = args.observedById.get(ref.id);
		const session = hubFallbackStatsSession(ref, observed);
		let cached = session ? args.sessionCosts.get(session) : undefined;
		if (session) {
			const direct = readSessionDirectSpend(session);
			if (direct !== undefined) {
				cached = direct;
				args.sessionCosts.set(session, cached);
			} else if (!cached || !fallbackReadCurrent(cached, session)) {
				const stamp = fallbackReadStamp(session);
				cached = { cost: readSessionMetrics(session, undefined)?.cost, aiu: readMessagesAiu(session) };
				if (stamp) fallbackReadStamps.set(cached, stamp);
				args.sessionCosts.set(session, cached);
			}
			if (cached?.cost !== undefined) args.sessionCosts.set(ref, cached);
		}
		const live = cached?.cost !== undefined ? cached : undefined;
		const retained = args.sessionCosts.get(ref);
		const cost = projectRowMetrics(ref, observed, live, retained, session !== undefined)?.cost;
		// Same precedence as cost: the live session, then the park-time snapshot, then the retained read.
		const aiu = live?.aiu ?? ref.history?.directAiu ?? retained?.aiu;
		if ((cost === undefined && aiu === undefined) || (session && countedSessions.has(session))) continue;
		if (session) countedSessions.add(session);
		total.cost += finiteMetric(cost);
		if (aiu) {
			total.aiu.nano += finiteMetric(aiu.nano);
			total.aiu.unknownCalls += finiteMetric(aiu.unknownCalls);
		}
	}
	return total;
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
			let cached = args.sessionMetrics.get(fallbackSession);
			const directCost = readSessionDirectCost(fallbackSession);
			// Refresh cost independently from the message scan: model_usage entries
			// are cumulative but do not alter the agent's live message list.
			if (!cached || (args.refreshFallback && !fallbackReadCurrent(cached, fallbackSession))) {
				const stamp = fallbackReadStamp(fallbackSession);
				const entry = { metrics: readSessionMetrics(fallbackSession, directCost) };
				if (stamp) fallbackReadStamps.set(entry, stamp);
				args.sessionMetrics.set(fallbackSession, entry);
				cached = entry;
			} else if (cached.metrics && directCost !== undefined) {
				cached.metrics.cost = directCost;
			}
			// Preserve valid direct-session snapshots through parking or a failed teardown read.
			if (cached.metrics) args.sessionMetrics.set(ref, cached);
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
