import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type { ThemeColor } from "../theme/index";
export type ContextUsageLevel = "normal" | "warning" | "purple" | "error";

const CONTEXT_WARNING_PERCENT_THRESHOLD = 50;
const CONTEXT_WARNING_TOKEN_THRESHOLD = 150_000;
const CONTEXT_PURPLE_PERCENT_THRESHOLD = 70;
const CONTEXT_PURPLE_TOKEN_THRESHOLD = 270_000;
const CONTEXT_ERROR_PERCENT_THRESHOLD = 90;
const CONTEXT_ERROR_TOKEN_THRESHOLD = 500_000;

function reachesThreshold(
	contextPercent: number,
	contextWindow: number,
	percentThreshold: number,
	tokenThreshold: number,
): boolean {
	if (!Number.isFinite(contextPercent) || contextPercent <= 0) {
		return false;
	}

	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return contextPercent >= percentThreshold;
	}

	const tokenPercentThreshold = (tokenThreshold / contextWindow) * 100;
	return contextPercent >= Math.min(percentThreshold, tokenPercentThreshold);
}

export function getContextUsageLevel(contextPercent: number, contextWindow: number): ContextUsageLevel {
	if (
		reachesThreshold(contextPercent, contextWindow, CONTEXT_ERROR_PERCENT_THRESHOLD, CONTEXT_ERROR_TOKEN_THRESHOLD)
	) {
		return "error";
	}

	if (
		reachesThreshold(contextPercent, contextWindow, CONTEXT_PURPLE_PERCENT_THRESHOLD, CONTEXT_PURPLE_TOKEN_THRESHOLD)
	) {
		return "purple";
	}

	if (
		reachesThreshold(
			contextPercent,
			contextWindow,
			CONTEXT_WARNING_PERCENT_THRESHOLD,
			CONTEXT_WARNING_TOKEN_THRESHOLD,
		)
	) {
		return "warning";
	}

	return "normal";
}

/** Used share (0–1) where a level starts: the percent or token threshold, whichever comes first. */
function thresholdShare(contextWindow: number, percentThreshold: number, tokenThreshold: number): number {
	const percent =
		Number.isFinite(contextWindow) && contextWindow > 0
			? Math.min(percentThreshold, (tokenThreshold / contextWindow) * 100)
			: percentThreshold;
	return percent / 100;
}

/**
 * `meter` tone switches matching {@link getContextUsageLevel}: warning from the
 * warning level, error from the error level, as shares of `contextWindow`.
 */
export function getContextMeterThresholds(contextWindow: number): { warn: number; bad: number } {
	return {
		warn: thresholdShare(contextWindow, CONTEXT_WARNING_PERCENT_THRESHOLD, CONTEXT_WARNING_TOKEN_THRESHOLD),
		bad: thresholdShare(contextWindow, CONTEXT_ERROR_PERCENT_THRESHOLD, CONTEXT_ERROR_TOKEN_THRESHOLD),
	};
}

/**
 * Format context usage as `<percent>%/<window>` when the model window is known.
 * Unknown windows render as `<tokens>/?`, because `0.0%/0` suggests a real
 * empty context instead of missing provider metadata.
 */
export function formatContextUsage(
	contextPercent: number | null | undefined,
	contextWindow: number,
	usedTokens?: number,
): string {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return `${formatNumber(usedTokens ?? 0)}/?`;
	}
	const pct = contextPercent === null || contextPercent === undefined ? "?" : `${contextPercent.toFixed(1)}%`;
	return `${pct}/${formatNumber(contextWindow)}`;
}

/** Chrome tone for a context-usage level; undefined while usage is normal. */
export function getContextUsageTone(level: ContextUsageLevel): TspTone | undefined {
	switch (level) {
		case "error":
			return "error";
		case "purple":
		case "warning":
			return "warning";
		case "normal":
			return undefined;
	}
}

export function getContextUsageThemeColor(level: ContextUsageLevel): ThemeColor {
	switch (level) {
		case "error":
			return "error";
		case "purple":
			return "thinkingHigh";
		case "warning":
			return "warning";
		case "normal":
			return "statusLineContext";
	}
}
