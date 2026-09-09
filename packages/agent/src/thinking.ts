import { Effort } from "@oh-my-pi/pi-ai";

/**
 * Agent-local thinking selector.
 *
 * `off` disables reasoning, while `inherit` defers to a higher-level selector.
 */
export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: Effort.Minimal,
	Low: Effort.Low,
	Medium: Effort.Medium,
	High: Effort.High,
	XHigh: Effort.XHigh,
	Max: Effort.Max,
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ResolvedThinkingLevel = Exclude<ThinkingLevel, "inherit">;
