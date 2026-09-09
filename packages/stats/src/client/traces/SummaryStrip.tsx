/**
 * Headline chips for one trace: wall/model/tool/idle time, turns, requests,
 * tool calls, agents, tokens, cost.
 */

import { formatCompact, formatCost, formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceSummary } from "../types";

export interface SummaryStripProps {
	summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
	const chips: Array<{ label: string; value: string }> = [
		{ label: "Wall", value: formatDurationMs(summary.wallMs) },
		{ label: "Model", value: formatDurationMs(summary.modelMs) },
		{ label: "Tools", value: formatDurationMs(summary.toolMs) },
		{ label: "Idle", value: formatDurationMs(summary.idleMs) },
		{ label: "Turns", value: formatInteger(summary.turns) },
		{ label: "Requests", value: formatInteger(summary.requests) },
		{ label: "Tool Calls", value: formatInteger(summary.toolCalls) },
		{ label: "Agents", value: formatInteger(summary.subagents) },
		{ label: "Tokens", value: formatCompact(summary.totalTokens) },
		{ label: "Cost", value: formatCost(summary.costTotal) },
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
