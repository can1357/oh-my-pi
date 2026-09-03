import { formatDistanceToNow } from "@oh-my-pi/pi-utils/dates";
import type { MessageStats } from "../types";

export function formatInteger(value: number): string {
	return value.toLocaleString();
}

export function formatCompact(value: number): string {
	return value.toLocaleString(undefined, { notation: "compact" });
}

export function formatCost(value: number, digits?: number): string {
	if (value === 0) return "$0";
	const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
	return `$${value.toLocaleString(undefined, {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	})}`;
}

/** Format an API-equivalent estimate, using N/A when all usage is unpriced. */
export function formatEstimatedCost(value: number, unpricedRequests: number, digits?: number): string {
	return value === 0 && unpricedRequests > 0 ? "N/A" : formatCost(value, digits);
}

/** Format one request's cost, distinguishing unpriced SuperGrok usage from free usage. */
export function formatMessageCost(message: Pick<MessageStats, "provider" | "usage">, digits?: number): string {
	const unpricedRequests =
		message.provider === "xai-oauth" && message.usage.totalTokens > 0 && message.usage.cost.total === 0 ? 1 : 0;
	return formatEstimatedCost(message.usage.cost.total, unpricedRequests, digits);
}

export function formatPercent(value: number, digits = 1): string {
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatDurationMs(value: number | null, digits?: number): string {
	if (value === null) return "-";
	const sec = value / 1000;
	const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
	return `${sec.toFixed(d)}s`;
}

export function formatTokensPerSecond(value: number | null): string {
	if (value === null) return "-";
	return value.toFixed(1);
}

export function formatRelativeTime(timestamp: number): string {
	return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

export function formatBytes(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
	return `${value} B`;
}
