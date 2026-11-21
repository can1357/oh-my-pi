/**
 * Headline tiles for one trace: wall time split into model/tool/idle, then
 * turns, requests, tool calls, agents, tokens, cost.
 */

import { formatCompact, formatElapsed, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import type { TraceSummary } from "../types";
import { Stat, StatGrid } from "../ui";

export interface SummaryStripProps {
	summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
	const share = (ms: number) => (summary.wallMs > 0 ? `${formatPercent(ms / summary.wallMs)} of wall` : undefined);
	return (
		<StatGrid min={112}>
			<Stat size="sm" label="Wall time" value={formatElapsed(summary.wallMs)} />
			<Stat size="sm" label="Model time" value={formatElapsed(summary.modelMs)} hint={share(summary.modelMs)} />
			<Stat size="sm" label="Tool time" value={formatElapsed(summary.toolMs)} hint={share(summary.toolMs)} />
			<Stat size="sm" label="Idle" value={formatElapsed(summary.idleMs)} hint={share(summary.idleMs)} />
			<Stat size="sm" label="Turns" value={formatInteger(summary.turns)} />
			<Stat
				size="sm"
				label="Requests"
				value={formatInteger(summary.requests)}
				hint={`${formatInteger(summary.toolCalls)} tool calls`}
			/>
			<Stat size="sm" label="Agents" value={formatInteger(summary.subagents)} />
			<Stat size="sm" label="Tokens" value={formatCompact(summary.totalTokens)} />
			<Stat size="sm" label="Cost" value={formatEstimatedCost(summary.costTotal, summary.unpricedRequests)} />
		</StatGrid>
	);
}
