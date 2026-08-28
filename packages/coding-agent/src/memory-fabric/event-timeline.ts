/**
 * Event timeline projection — read-only observability over lifecycle events.
 *
 * `projectEventTimeline(events)` folds a snapshot of memory-lifecycle events
 * (the shape the event gateway emits) into structured, human-readable
 * timeline rows — one per event — plus a per-session roll-up, so a later
 * surface can render "what happened, in what order, how long apart" without
 * touching the journal or the running agent.
 *
 * Discipline, identical to every additive module in this fabric:
 *   - PURE: reads a snapshot; never opens a journal, never writes, never
 *     mutates its inputs, never executes anything.
 *   - Observe-only: the output is a report (`mode: "observe"`) and carries
 *     no authority.
 *   - Fail-open: malformed events are skipped or defaulted; never throws.
 *
 * Honesty about the source model: lifecycle events record **memory
 * lifecycle** (write / update / delete / checkpoint / maintenance), not raw
 * tool calls or per-event token counts. This projection surfaces only the
 * fields those events actually carry (session, agent, task, memory type,
 * verification/operation result) and *derives* timing from the event
 * timestamps. It never fabricates tokens or tool spans — token accounting
 * lives in `token-accounting/` and stays there.
 */

import type { MemoryRecord, MemoryRecordType } from "./types";

/** Lifecycle event kinds the timeline understands. */
export const LIFECYCLE_EVENT_TYPES = [
	"memory-write",
	"memory-update",
	"memory-delete",
	"checkpoint",
	"maintenance",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

/** Checkpoint payload fields the timeline reads. Extra fields are ignored. */
export interface LifecycleCheckpointData {
	/** Human-readable current step at checkpoint time. */
	currentStep?: string;
	/** Last known test status ("passing", "failing", ...). */
	testStatus?: string;
}

/** Maintenance payload fields the timeline reads. Extra fields are ignored. */
export interface LifecycleMaintenanceData {
	/** Maintenance operation name ("decay", "dedup", "compaction", ...). */
	operation?: string;
	/** Record ids the operation touched. */
	affectedIds?: readonly string[];
}

/**
 * One memory-lifecycle event, as emitted by the event gateway. This is a
 * *projection input* shape: callers adapting the persistence journal's
 * generic `JournalEvent` rows map them into this structure first.
 */
export interface MemoryLifecycleEvent {
	/** Monotonic sequence number (primary order key). */
	seq: number;
	/** Lifecycle event kind. */
	type: LifecycleEventType;
	/** ISO timestamp of the event. */
	timestamp: string;
	/** Session that produced the event. */
	sessionId: string;
	/** Affected record id, when the record itself is not attached. */
	recordId?: string;
	/** Full record snapshot (write/update events). */
	record?: MemoryRecord;
	/** Checkpoint payload (checkpoint events). */
	checkpoint?: LifecycleCheckpointData;
	/** Maintenance payload (maintenance events). */
	maintenance?: LifecycleMaintenanceData;
}

export type TimelineCategory = "memory" | "checkpoint" | "maintenance";

export interface TimelineRow {
	/** Journal sequence number (primary order key). */
	seq: number;
	/** Raw ISO timestamp copied from the event. */
	timestamp: string;
	/** Parsed epoch ms, or null if the timestamp is unparseable. */
	epochMs: number | null;
	/** ms since the previous row in timeline order, or null if unknown. */
	deltaMs: number | null;
	/** ms since the first row in timeline order, or null if unknown. */
	elapsedMs: number | null;
	/** The raw lifecycle event type. */
	kind: LifecycleEventType;
	/** Coarse grouping of `kind`. */
	category: TimelineCategory;
	/** Session that produced the event. */
	sessionId: string;
	/** 0-based ordinal of this event within its session (timeline order). */
	sessionEventIndex: number;
	/** Affected record id (for memory events), else null. */
	recordId: string | null;
	/** Project scope (record events only), else null. */
	projectId: string | null;
	/** Agent scope (record events only), else null. */
	agentId: string | null;
	/** Task scope (record events only), else null. */
	taskId: string | null;
	/** Canonical memory type (write/update events only), else null. */
	memoryType: MemoryRecordType | null;
	/**
	 * Best-available "result" signal: memory verification, maintenance
	 * operation, or checkpoint test-status. Null when the event carries none.
	 */
	result: string | null;
	/** One-line, human-readable description of the event. */
	summary: string;
}

export interface TimelineSession {
	sessionId: string;
	eventCount: number;
	firstSeq: number;
	lastSeq: number;
	firstTimestamp: string | null;
	lastTimestamp: string | null;
	/** Wall-clock span of the session in ms, or null if timestamps are unusable. */
	durationMs: number | null;
	/** Distinct agent ids seen in the session (sorted). */
	agents: string[];
	/** Distinct project ids seen in the session (sorted). */
	projects: string[];
	/** Event counts by category. */
	byCategory: Record<TimelineCategory, number>;
}

export interface EventTimeline {
	mode: "observe";
	rowCount: number;
	rows: TimelineRow[];
	sessions: TimelineSession[];
}

export interface TimelineOptions {
	/** Only include events for these sessions (by id). Omit for all sessions. */
	sessionIds?: readonly string[];
	/** Only include events of these categories. Omit for all. */
	categories?: readonly TimelineCategory[];
}

const CATEGORY_OF: Record<LifecycleEventType, TimelineCategory> = {
	"memory-write": "memory",
	"memory-update": "memory",
	"memory-delete": "memory",
	checkpoint: "checkpoint",
	maintenance: "maintenance",
};

function parseEpoch(ts: unknown): number | null {
	if (typeof ts !== "string") return null;
	const ms = Date.parse(ts);
	return Number.isFinite(ms) ? ms : null;
}

function isEvent(value: unknown): value is MemoryLifecycleEvent {
	if (!value || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	return (
		typeof e.seq === "number" &&
		typeof e.type === "string" &&
		e.type in CATEGORY_OF &&
		typeof e.timestamp === "string" &&
		typeof e.sessionId === "string"
	);
}

function resultOf(event: MemoryLifecycleEvent): string | null {
	if (event.record) return event.record.verification ?? null;
	if (event.maintenance) return event.maintenance.operation ?? null;
	if (event.checkpoint) {
		const status = event.checkpoint.testStatus;
		return typeof status === "string" && status.length > 0 ? status : null;
	}
	return null;
}

function summarize(event: MemoryLifecycleEvent): string {
	switch (event.type) {
		case "memory-write":
		case "memory-update": {
			const r = event.record;
			if (!r) return `${event.type} (no record)`;
			const verb = event.type === "memory-write" ? "wrote" : "updated";
			return `${verb} ${r.type} ${r.id}`;
		}
		case "memory-delete":
			return `deleted ${event.recordId ?? "(unknown record)"}`;
		case "checkpoint": {
			const c = event.checkpoint;
			const hasStep = c && typeof c.currentStep === "string" && c.currentStep.length > 0;
			return `checkpoint: ${hasStep ? c.currentStep : "checkpoint"}`;
		}
		case "maintenance": {
			const m = event.maintenance;
			const op = m?.operation ?? "maintenance";
			const n = m?.affectedIds?.length ?? 0;
			return `maintenance: ${op} (${n} affected)`;
		}
		default:
			return String(event.type);
	}
}

/**
 * Project a snapshot of lifecycle events into a structured, read-only
 * timeline. Pure and fail-open; input is never mutated. Rows are ordered by
 * `seq` asc (stable for equal seq), and timing deltas are computed in that
 * order.
 */
export function projectEventTimeline(
	events: readonly MemoryLifecycleEvent[],
	options: TimelineOptions = {},
): EventTimeline {
	try {
		const source = Array.isArray(events) ? events : [];
		const sessionFilter = options.sessionIds ? new Set(options.sessionIds) : null;
		const categoryFilter = options.categories ? new Set(options.categories) : null;

		const valid = source
			.filter(isEvent)
			.filter(e => (sessionFilter ? sessionFilter.has(e.sessionId) : true))
			.filter(e => (categoryFilter ? categoryFilter.has(CATEGORY_OF[e.type]) : true));

		// Stable sort by seq ascending (index tiebreak preserves input order).
		const ordered = valid
			.map((event, index) => ({ event, index }))
			.sort((a, b) => (a.event.seq !== b.event.seq ? a.event.seq - b.event.seq : a.index - b.index))
			.map(w => w.event);

		const perSessionIndex = new Map<string, number>();
		let firstEpoch: number | null = null;
		let prevEpoch: number | null = null;

		const rows: TimelineRow[] = ordered.map(event => {
			const epochMs = parseEpoch(event.timestamp);
			if (firstEpoch === null && epochMs !== null) firstEpoch = epochMs;

			const deltaMs = epochMs !== null && prevEpoch !== null ? epochMs - prevEpoch : null;
			const elapsedMs = epochMs !== null && firstEpoch !== null ? epochMs - firstEpoch : null;
			if (epochMs !== null) prevEpoch = epochMs;

			const sessionEventIndex = perSessionIndex.get(event.sessionId) ?? 0;
			perSessionIndex.set(event.sessionId, sessionEventIndex + 1);

			const record = event.record;
			const isRecordEvent = event.type === "memory-write" || event.type === "memory-update";

			return {
				seq: event.seq,
				timestamp: event.timestamp,
				epochMs,
				deltaMs,
				elapsedMs,
				kind: event.type,
				category: CATEGORY_OF[event.type],
				sessionId: event.sessionId,
				sessionEventIndex,
				recordId: record?.id ?? event.recordId ?? null,
				projectId: record?.projectId ?? null,
				agentId: record?.agentId ?? null,
				taskId: record?.taskId ?? null,
				memoryType: isRecordEvent ? (record?.type ?? null) : null,
				result: resultOf(event),
				summary: summarize(event),
			};
		});

		return { mode: "observe", rowCount: rows.length, rows, sessions: rollUpSessions(rows) };
	} catch {
		return { mode: "observe", rowCount: 0, rows: [], sessions: [] };
	}
}

function rollUpSessions(rows: readonly TimelineRow[]): TimelineSession[] {
	const bySession = new Map<string, TimelineRow[]>();
	for (const row of rows) {
		const list = bySession.get(row.sessionId);
		if (list) list.push(row);
		else bySession.set(row.sessionId, [row]);
	}

	const sessions: TimelineSession[] = [];
	for (const [sessionId, sessionRows] of bySession) {
		const agents = new Set<string>();
		const projects = new Set<string>();
		const byCategory: Record<TimelineCategory, number> = { memory: 0, checkpoint: 0, maintenance: 0 };
		let firstEpoch: number | null = null;
		let lastEpoch: number | null = null;
		let firstTimestamp: string | null = null;
		let lastTimestamp: string | null = null;

		for (const row of sessionRows) {
			if (row.agentId) agents.add(row.agentId);
			if (row.projectId) projects.add(row.projectId);
			byCategory[row.category] += 1;
			if (row.epochMs !== null) {
				if (firstEpoch === null || row.epochMs < firstEpoch) {
					firstEpoch = row.epochMs;
					firstTimestamp = row.timestamp;
				}
				if (lastEpoch === null || row.epochMs > lastEpoch) {
					lastEpoch = row.epochMs;
					lastTimestamp = row.timestamp;
				}
			}
		}

		const first = sessionRows[0];
		const last = sessionRows[sessionRows.length - 1];
		sessions.push({
			sessionId,
			eventCount: sessionRows.length,
			firstSeq: first ? first.seq : 0,
			lastSeq: last ? last.seq : 0,
			firstTimestamp,
			lastTimestamp,
			durationMs: firstEpoch !== null && lastEpoch !== null ? lastEpoch - firstEpoch : null,
			agents: [...agents].sort(),
			projects: [...projects].sort(),
			byCategory,
		});
	}

	// Order sessions by their first sequence number for a stable report.
	return sessions.sort((a, b) => a.firstSeq - b.firstSeq);
}
