import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "../../../modes/theme/theme";

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
