import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CompactionMethod } from "../session/compaction-methods";

/** Opaque journal checkpoint plus message identities used to identify one core attempt. */
export interface AdvisorHistoryCheckpoint {
	readonly id: string;
	readonly generation: number;
	readonly rewriteVersion: number;
	readonly messages: readonly AgentMessage[];
}

/** Context recovery has one owner; only not-applicable reaches ordinary retry. */
export type AdvisorTurnDisposition =
	| { kind: "not-applicable" }
	| { kind: "continue"; mode: "retry" | "auto" }
	| { kind: "terminal"; error?: unknown };

export type AdvisorContinuationMode = "retry" | "auto";

export const ADVISOR_CONTEXT_MAINTENANCE_CUSTOM_TYPE = "advisor-context-maintenance";
export const ADVISOR_CONTEXT_MAINTENANCE_VERSION = 1;

/**
 * Optional synchronous controller diagnostic port. A producer MUST capture the
 * sink and emit `start` before the run's first await, retain one run ID, assign
 * a unique ID to every real attempt, and emit attempt/commit outcomes only at
 * the corresponding controller boundaries. `applied` MUST describe an actual
 * working-history commit; it MUST NOT be inferred from `auto_compaction_end`.
 * Callers never await transcript I/O.
 */
export type AdvisorMaintenanceEventSink = (event: AdvisorMaintenanceEvent) => void;

export type AdvisorMaintenanceEventKind =
	| "start"
	| "attempt"
	| "commit"
	| "completion"
	| "discard"
	| "promotion"
	| "checkpoint"
	| "reset";

export type AdvisorMaintenanceStatus =
	| "started"
	| "applied"
	| "prepared-only"
	| "no-progress"
	| "failed"
	| "skipped"
	| "cancelled"
	| "discarded";

export type AdvisorMaintenancePhase =
	| "pre_turn"
	| "mid_turn"
	| "post_turn"
	| "standalone_turn"
	| "recovery"
	| "lifecycle";

export type AdvisorMaintenanceTrigger =
	| "threshold"
	| "overflow"
	| "incomplete"
	| "idle"
	| "speculation"
	| "manual"
	| "fallback"
	| "lifecycle";

export type AdvisorMaintenanceMeasurement =
	| {
			/** The provider does not expose a truthful value. */
			readonly value: null;
			readonly source: "unknown";
	  }
	| {
			readonly value: number;
			readonly source: "provider" | "estimated";
	  };

export interface AdvisorMaintenanceModel {
	readonly provider: string;
	readonly id: string;
}

export type AdvisorMaintenanceContinuation =
	| { readonly decision: "scheduled"; readonly mode: AdvisorContinuationMode }
	| { readonly decision: "blocked" | "none"; readonly mode: null };

export interface AdvisorMaintenanceSafeError {
	readonly name: string | null;
	readonly message: string;
}

/**
 * Versioned diagnostic payload stored as an `advisor-context-maintenance`
 * custom entry. Journal IDs always refer to the advisor's working journal,
 * never to the append-only diagnostic transcript.
 */
export interface AdvisorMaintenanceEvent {
	readonly version: typeof ADVISOR_CONTEXT_MAINTENANCE_VERSION;
	readonly kind: AdvisorMaintenanceEventKind;
	readonly status: AdvisorMaintenanceStatus;
	readonly runId: string;
	readonly attemptId: string | null;
	readonly advisorId: string;
	readonly advisorGeneration: number;
	readonly phase: AdvisorMaintenancePhase;
	readonly trigger: AdvisorMaintenanceTrigger;
	readonly method: CompactionMethod | null;
	readonly candidateModel: AdvisorMaintenanceModel | null;
	readonly ownerModel: AdvisorMaintenanceModel;
	readonly ownerContextWindow: number;
	readonly ownerThreshold: number;
	readonly before: AdvisorMaintenanceMeasurement;
	readonly after: AdvisorMaintenanceMeasurement;
	readonly historyChanged: boolean;
	readonly continuation: AdvisorMaintenanceContinuation;
	readonly workingJournalBoundaryEntryId: string | null;
	readonly workingJournalCheckpointId: string | null;
	readonly reason: string | null;
	readonly error: AdvisorMaintenanceSafeError | null;
}

export function advisorMaintenanceModel(model: Model): AdvisorMaintenanceModel {
	return { provider: model.provider, id: model.id };
}

export function createAdvisorMaintenanceRunId(): string {
	return crypto.randomUUID();
}

export function createAdvisorMaintenanceAttemptId(): string {
	return crypto.randomUUID();
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 512;

function boundedDiagnosticText(value: string): string {
	const normalized = value
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
		.replace(/([?&](?:access[-_]?token|api[-_]?key|key|token|secret|password)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(
			/((?:authorization|api[-_]?key|private[-_]?key|access[-_]?key|token|secret|passw(?:or)?d|pwd|credential)"?\s*[:=]\s*"?)[^"\s,;}]+/gi,
			"$1[redacted]",
		)
		.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.trim();
	return normalized.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
		? normalized
		: `${normalized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 1)}…`;
}

/** Reduce an exception to bounded text; callers should still avoid attaching secret-bearing payloads. */
export function advisorMaintenanceSafeError(error: unknown): AdvisorMaintenanceSafeError {
	if (error instanceof Error) {
		return {
			name: boundedDiagnosticText(error.name) || null,
			message: boundedDiagnosticText(error.message),
		};
	}
	return { name: null, message: boundedDiagnosticText(String(error)) };
}

/** Bound a non-sensitive controller reason before it enters the durable transcript. */
export function advisorMaintenanceReason(reason: string): string {
	return boundedDiagnosticText(reason);
}
