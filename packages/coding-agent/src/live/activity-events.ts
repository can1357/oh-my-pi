import { isRecord } from "@oh-my-pi/pi-utils";
import type { LivePhase } from "./visualizer";

/** Shared EventBus channel for privacy-bounded realtime voice activity. */
export const LIVE_ACTIVITY_EVENT_CHANNEL = "live:activity";

/** Semantic state of the realtime voice session. */
export type LiveActivityPhase = LivePhase | "inactive";
const LIVE_ACTIVITY_PHASES: Record<LiveActivityPhase, true> = {
	inactive: true,
	connecting: true,
	listening: true,
	working: true,
	speaking: true,
	muted: true,
	error: true,
};

/**
 * Realtime voice activity exposed to local extensions.
 *
 * Levels are normalized scalar RMS values in the inclusive range 0..1.
 * The payload intentionally excludes audio samples, transcripts, and identifiers.
 */
export interface LiveActivityEvent {
	phase: LiveActivityPhase;
	inputLevel: number;
	outputLevel: number;
}

/** Narrow an unknown shared-bus payload to the public live activity contract. */
export function isLiveActivityEvent(value: unknown): value is LiveActivityEvent {
	if (!isRecord(value)) return false;
	return (
		typeof value.phase === "string" &&
		Object.hasOwn(LIVE_ACTIVITY_PHASES, value.phase) &&
		typeof value.inputLevel === "number" &&
		Number.isFinite(value.inputLevel) &&
		value.inputLevel >= 0 &&
		value.inputLevel <= 1 &&
		typeof value.outputLevel === "number" &&
		Number.isFinite(value.outputLevel) &&
		value.outputLevel >= 0 &&
		value.outputLevel <= 1
	);
}
