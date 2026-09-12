export type HealthStatus = "healthy" | "low" | "critical" | "exhausted" | "unknown" | "neutral";

export interface HealthInfo {
	status: HealthStatus;
	symbol: string;
	color: "success" | "warning" | "error" | "muted" | "dim";
	label: string;
}

export function classifyHealth(remainingFraction: number | undefined, isExhaustedFlag?: boolean): HealthInfo {
	if (remainingFraction === undefined) {
		return {
			status: "unknown",
			symbol: "?",
			color: "muted",
			label: "unknown",
		};
	}

	const clamped = Math.min(Math.max(remainingFraction, 0), 1);

	if (isExhaustedFlag || clamped <= 0) {
		return {
			status: "exhausted",
			symbol: "✕",
			color: "error",
			label: "exhausted",
		};
	}
	if (clamped <= 0.2) {
		return {
			status: "critical",
			symbol: "!",
			color: "error",
			label: "critical",
		};
	}
	if (clamped <= 0.5) {
		return {
			status: "low",
			symbol: "⚠",
			color: "warning",
			label: "low",
		};
	}
	return {
		status: "healthy",
		symbol: "✓",
		color: "success",
		label: "healthy",
	};
}

/** Coarse duration string, e.g. "6d", "4h", "32m", "45s". */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

/** Percent string: e.g. "100%", "93%", "29%", "0.4%". */
export function formatPercent(fraction: number): string {
	const pct = Math.min(Math.max(fraction, 0), 1) * 100;
	return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

export const BAR_WIDTH = 12;

/**
 * 12-cell bar representing REMAINING quota.
 * Plain-text version (for snapshot/fallback).
 */
export function renderRemainingBarPlain(fraction: number | undefined, width = BAR_WIDTH): string {
	if (fraction === undefined) return "·".repeat(width);
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export interface MinimalTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * 12-cell bar representing REMAINING quota with semantic theme styling.
 */
export function renderRemainingBarStyled(
	fraction: number | undefined,
	health: HealthInfo,
	theme: MinimalTheme,
	width = BAR_WIDTH,
): string {
	if (fraction === undefined) {
		return theme.fg("muted", "·".repeat(width));
	}
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * width);
	const empty = Math.max(0, width - filled);

	if (health.status === "exhausted" || filled === 0) {
		return theme.fg("dim", "░".repeat(width));
	}

	const filledStr = theme.fg(health.color, "█".repeat(filled));
	const emptyStr = empty > 0 ? theme.fg("dim", "░".repeat(empty)) : "";
	return `${filledStr}${emptyStr}`;
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

export function visibleWidth(text: string): number {
	if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
		return Bun.stringWidth(text);
	}
	return stripAnsi(text).length;
}

export function padEndVisible(text: string, targetWidth: number): string {
	const current = visibleWidth(text);
	if (current >= targetWidth) return text;
	return text + " ".repeat(targetWidth - current);
}

export function replaceTabs(text: string): string {
	return text.replaceAll("\t", "   ");
}

export function sanitizeText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	const current = visibleWidth(text);
	if (current <= maxWidth) return text;
	const ellipsisW = visibleWidth(ellipsis);
	if (maxWidth <= ellipsisW) return ellipsis.slice(0, maxWidth);

	let result = "";
	for (const char of text) {
		if (visibleWidth(result + char) + ellipsisW > maxWidth) break;
		result += char;
	}
	return result + ellipsis;
}
