/**
 * Headline chips for one trace: wall/model/tool/idle time, turns, requests,
 * tool calls, agents, tokens, cost.
 */

import { formatCompact, formatDurationMs, formatEstimatedCost, formatInteger } from "../data/formatters";
import type { TraceSummary } from "../types";
import { useStatsI18n } from "../i18n";

export interface SummaryStripProps {
	summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
	const { i18n } = useStatsI18n();
	const chips: Array<{ label: string; value: string }> = [
		{ label: i18n.t("stats.trace.wall"), value: formatDurationMs(summary.wallMs) },
		{ label: i18n.t("stats.trace.model"), value: formatDurationMs(summary.modelMs) },
		{ label: i18n.t("stats.trace.tools"), value: formatDurationMs(summary.toolMs) },
		{ label: i18n.t("stats.trace.idle"), value: formatDurationMs(summary.idleMs) },
		{ label: i18n.t("stats.trace.turns"), value: formatInteger(summary.turns) },
		{ label: i18n.t("stats.trace.requests"), value: formatInteger(summary.requests) },
		{ label: i18n.t("stats.trace.toolCalls"), value: formatInteger(summary.toolCalls) },
		{ label: i18n.t("stats.trace.agents"), value: formatInteger(summary.subagents) },
		{ label: i18n.t("stats.trace.tokens"), value: formatCompact(summary.totalTokens) },
		{ label: i18n.t("stats.trace.cost"), value: formatEstimatedCost(summary.costTotal, summary.unpricedRequests) },
	];

	return (
		<div className="stats-trace-summary">
			{chips.map(chip => (
				<div key={chip.label} className="stats-trace-summary-cell">
					<span className="stats-trace-summary-label">{chip.label}</span>
					<span className="stats-trace-summary-value">{chip.value}</span>
				</div>
			))}
		</div>
	);
}
