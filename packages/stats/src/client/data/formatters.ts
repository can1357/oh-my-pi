import { formatDistanceToNow } from "date-fns";

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
