export type ReduceMotionLevel = "off" | "on" | "strict";

/** Strict mode's minimum interval between content repaints (~4fps). */
export const REDUCE_MOTION_STRICT_RENDER_INTERVAL_MS = 250;

let level: ReduceMotionLevel = "off";

/** The host applies its display preference without coupling TUI components to settings. */
export function setReduceMotion(value: ReduceMotionLevel): void {
	level = value;
}

export function reduceMotionLevel(): ReduceMotionLevel {
	return level;
}

export function isReduceMotion(): boolean {
	return level !== "off";
}
