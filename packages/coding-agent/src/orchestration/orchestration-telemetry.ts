/**
 * Routing and learning telemetry for orchestration decisions.
 */

import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { EventBus } from "../utils/event-bus";

export const ORCHESTRATION_TELEMETRY_CHANNEL = "orchestration:telemetry" as const;

export type OrchestrationTelemetryEventKind =
	| "spawn"
	| "spawn_result"
	| "blocker"
	| "completion_gate"
	| "advisor_intervention"
	| "approach_update";

export interface OrchestrationTelemetryEvent {
	readonly kind: OrchestrationTelemetryEventKind;
	readonly timestamp: number;
	readonly sessionId?: string;
	readonly correlationId?: string;
	readonly taskContractClass?: string;
	readonly strategyFamily?: string;
	readonly workerMode?: string;
	readonly contextPolicy?: string;
	readonly routeLabel?: string;
	readonly agentName?: string;
	readonly blockerFingerprint?: string;
	readonly verificationOutcome?: string;
	readonly completionGateOutcome?: string;
	readonly failedCriteriaCount?: number;
	readonly unprovenCriteriaCount?: number;
	readonly advisorSeverity?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OrchestrationTelemetrySink {
	emit(event: OrchestrationTelemetryEvent): void;
	readonly events: readonly OrchestrationTelemetryEvent[];
}

export function createOrchestrationTelemetrySink(eventBus?: EventBus): OrchestrationTelemetrySink {
	const events: OrchestrationTelemetryEvent[] = [];
	return {
		get events() {
			return Object.freeze([...events]);
		},
		emit(event: OrchestrationTelemetryEvent) {
			events.push(event);
			logger.debug("orchestration telemetry", { ...event });
			eventBus?.emit(ORCHESTRATION_TELEMETRY_CHANNEL, event);
		},
	};
}

export function recordSpawnTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly correlationId?: string;
		readonly agentName: string;
		readonly strategyFamily?: string;
		readonly workerMode?: string;
		readonly contextPolicy?: string;
		readonly routeLabel?: string;
		readonly taskContractClass?: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "spawn",
			timestamp: Date.now(),
			...fields,
		}),
	);
}

export function recordCompletionGateTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly completionGateOutcome: string;
		readonly failedCriteriaCount?: number;
		readonly unprovenCriteriaCount?: number;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "completion_gate",
			timestamp: Date.now(),
			...fields,
		}),
	);
}

export function recordAdvisorInterventionTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly advisorSeverity: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "advisor_intervention",
			timestamp: Date.now(),
			...fields,
		}),
	);
}

export function recordBlockerTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly strategyFamily?: string;
		readonly blockerFingerprint: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "blocker",
			timestamp: Date.now(),
			...fields,
		}),
	);
}

export function recordSpawnResultTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly correlationId?: string;
		readonly agentName: string;
		readonly strategyFamily?: string;
		readonly workerMode?: string;
		readonly verificationOutcome?: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "spawn_result",
			timestamp: Date.now(),
			...fields,
		}),
	);
}

export function recordApproachUpdateTelemetry(
	sink: OrchestrationTelemetrySink,
	fields: {
		readonly sessionId?: string;
		readonly strategyFamily: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
	},
): void {
	sink.emit(
		Object.freeze({
			kind: "approach_update",
			timestamp: Date.now(),
			...fields,
		}),
	);
}
