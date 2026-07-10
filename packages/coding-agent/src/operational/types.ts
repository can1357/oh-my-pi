/**
 * Persistent operational-state contracts for Hermes-style shell workflows.
 *
 * This layer is intentionally separate from coding-agent memory, session
 * history, and skill stores. It owns scoped key-value state, episodic task
 * history, durable jobs/schedules/checkpoints, notifications, and trajectory
 * events in one SQLite database.
 */

/** JSON-serializable value used for operational payloads. */
export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

/** Mutable JSON object used when building capped/sanitized payloads. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Scope identity for key-value operational state.
 * Project scope requires a non-empty absolute or normalized projectPath.
 */
export type StateScope = { readonly kind: "user" } | { readonly kind: "project"; readonly projectPath: string };

export interface ScopedStateEntry {
	readonly scope: StateScope;
	readonly key: string;
	readonly value: JsonValue;
	readonly updatedAt: number;
}

export interface EpisodeRecord {
	readonly id: string;
	readonly sessionId: string | null;
	readonly title: string;
	readonly summary: string;
	readonly tags: readonly string[];
	readonly metadata: JsonValue;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreateEpisodeInput {
	readonly title: string;
	readonly summary: string;
	readonly sessionId?: string | null;
	readonly tags?: readonly string[];
	readonly metadata?: JsonValue;
	readonly id?: string;
}

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

/**
 * Narrow payload stored on recurring schedules and expanded into durable jobs.
 * Callers MUST keep secrets out of `jobPayload`. Remote notification delivery
 * auth/security is the injected NotificationSink's responsibility.
 */
export interface ScheduledJobPayload extends JsonObject {
	readonly jobType: string;
	readonly jobPayload: JsonValue;
}

export interface DurableJob {
	readonly id: string;
	readonly type: string;
	readonly status: JobStatus;
	readonly payload: JsonValue;
	readonly result: JsonValue | null;
	readonly error: string | null;
	readonly leaseOwner: string | null;
	readonly leaseExpiresAt: number | null;
	readonly checkpoint: JsonValue | null;
	readonly scheduleId: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
}

export interface CreateJobInput {
	readonly type: string;
	readonly payload?: JsonValue;
	readonly scheduleId?: string | null;
	readonly id?: string;
	readonly status?: Extract<JobStatus, "queued" | "paused">;
}

export interface JobTransitionInput {
	readonly to: JobStatus;
	readonly leaseOwner?: string | null;
	readonly result?: JsonValue | null;
	readonly error?: string | null;
	readonly leaseMs?: number;
}

export interface JobListFilter {
	readonly status?: JobStatus | readonly JobStatus[];
	readonly type?: string;
	readonly limit?: number;
}

export interface JobCheckpoint {
	readonly jobId: string;
	readonly data: JsonValue;
	readonly updatedAt: number;
}

/**
 * Recurring schedule row. `cron` is a standard 5-field expression; `payload`
 * SHOULD be a {@link ScheduledJobPayload}. Next-fire computation and job
 * execution live in `cron.ts` / `runner.ts`.
 */
export interface RecurringSchedule {
	readonly id: string;
	readonly name: string;
	readonly cron: string;
	readonly nextRunAt: number | null;
	readonly enabled: boolean;
	readonly payload: JsonValue;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface UpsertScheduleInput {
	readonly id?: string;
	readonly name: string;
	readonly cron: string;
	readonly nextRunAt?: number | null;
	readonly enabled?: boolean;
	readonly payload?: JsonValue;
}

/**
 * Compare-and-swap materialization of one due schedule occurrence into a
 * single queued job. Losers of the CAS return `null` (no duplicate job).
 */
export interface MaterializeDueScheduleInput {
	readonly scheduleId: string;
	readonly expectedNextRunAt: number;
	readonly nextRunAt: number | null;
	readonly jobType: string;
	readonly jobPayload?: JsonValue;
	readonly jobId?: string;
}

export interface NotificationRecord {
	readonly id: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly read: boolean;
	readonly metadata: JsonValue;
	readonly createdAt: number;
}

export interface CreateNotificationInput {
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly metadata?: JsonValue;
	readonly id?: string;
}

/**
 * Trajectory event kinds for observability / audit export.
 *
 * Payload contract: callers MUST omit secrets (API keys, tokens, passwords,
 * private credentials). The store additionally caps oversized payloads before
 * persistence and marks truncation in the stored JSON.
 */
export type TrajectoryEventKind =
	| "model_decision"
	| "tool_decision"
	| "context_retrieval"
	| "patch"
	| "verification"
	| "outcome"
	| "human_correction"
	| "skill_candidate"
	| "job_state";

export interface TrajectoryEvent {
	readonly id: string;
	readonly kind: TrajectoryEventKind;
	readonly jobId: string | null;
	readonly sessionId: string | null;
	readonly payload: JsonValue;
	readonly createdAt: number;
}

export interface AppendEventInput {
	readonly kind: TrajectoryEventKind;
	readonly payload?: JsonValue;
	readonly jobId?: string | null;
	readonly sessionId?: string | null;
	readonly id?: string;
}

export interface EventListFilter {
	readonly kind?: TrajectoryEventKind | readonly TrajectoryEventKind[];
	readonly jobId?: string;
	readonly sessionId?: string;
	readonly afterCreatedAt?: number;
	readonly limit?: number;
}

export interface EpisodeSearchOptions {
	readonly limit?: number;
	readonly sessionId?: string;
}

export const JOB_STATUSES: readonly JobStatus[] = [
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;

export const TRAJECTORY_EVENT_KINDS: readonly TrajectoryEventKind[] = [
	"model_decision",
	"tool_decision",
	"context_retrieval",
	"patch",
	"verification",
	"outcome",
	"human_correction",
	"skill_candidate",
	"job_state",
] as const;

/** Default max serialized event payload size before truncation. */
export const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 16_384;
