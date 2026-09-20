import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Theme } from "../theme";
import type { ContextBreakdown } from "./context-usage";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "../chrome/context-thresholds";

const SEGMENT_KEYS = ["systemPrompt", "systemContext", "systemTools", "skills", "messages"] as const;

/** Compact segmented bar for root context only (never includes offload bytes). */
export function renderCompactContextBar(breakdown: ContextBreakdown, theme: Theme, maxWidth: number): string {
	if (breakdown.contextWindow <= 0 || maxWidth < 12) return "";
	const pct = (breakdown.usedTokens / breakdown.contextWindow) * 100;
	const level = getContextUsageLevel(pct, breakdown.contextWindow);
	const color = getContextUsageThemeColor(level);
	const label = formatContextUsage(pct, breakdown.contextWindow, breakdown.usedTokens);
	const barWidth = Math.max(4, Math.min(16, maxWidth - label.length - 5));
	const window = breakdown.contextWindow;
	let bar = "";
	let filled = 0;
	for (const key of SEGMENT_KEYS) {
		const cat = breakdown.categories.find(c => c.id === key);
		if (!cat || cat.tokens <= 0) continue;
		const w = Math.max(1, Math.round((cat.tokens / window) * barWidth));
		filled += w;
		if (filled > barWidth) break;
		bar += theme.fg(cat.color, "▮");
	}
	while (bar.length < barWidth) bar += theme.fg("dim", "░");
	return `${theme.fg(color, "CTX")} ${theme.fg(color, label)} ${bar}`;
}

export function formatOffloadIndicator(externalBytes: number, reintroducedTokens: number): string | null {
	if (externalBytes <= 0 && reintroducedTokens <= 0) return null;
	const ext =
		externalBytes >= 1_000_000
			? `${(externalBytes / 1_000_000).toFixed(1)}M`
			: externalBytes >= 1_000
				? `${(externalBytes / 1_000).toFixed(1)}k`
				: String(externalBytes);
	const re = formatNumber(reintroducedTokens);
	return `↓${ext}→${re}t`;
}
