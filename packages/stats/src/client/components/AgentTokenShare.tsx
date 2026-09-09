import { useMemo } from "react";
import { formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { buildAgentTokenShare } from "../data/view-models";
import type { AgentType, AgentTypeStats } from "../types";

/**
 * Per-agent-type display chrome. Colors follow the OMP brand palette
 * (pink -> violet -> cyan) used by the dashboard charts so the bar reads on
 * both themes without per-theme overrides.
 */
const AGENT_META: Record<AgentType, { label: string; color: string }> = {
	main: { label: "Main agent", color: "#ed4abf" },
	subagent: { label: "Subagents", color: "#9b4dff" },
	advisor: { label: "Advisor", color: "#5ad8e6" },
};

export interface AgentTokenShareProps {
	stats: AgentTypeStats[];
}

export function AgentTokenShare({ stats }: AgentTokenShareProps) {
	const view = useMemo(() => buildAgentTokenShare(stats), [stats]);

	if (view.totalTokens === 0) {
		return <div className="py-8 text-center stats-text-muted text-sm">No token usage in this range</div>;
	}

	return (
		<div className="space-y-4">
			<div className="flex h-3 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
				{view.segments.map(
					seg =>
						seg.share > 0 && (
							<div
								key={seg.agentType}
								className="h-full"
								style={{ width: `${seg.share * 100}%`, background: AGENT_META[seg.agentType].color }}
								title={`${AGENT_META[seg.agentType].label}: ${formatPercent(seg.share)}`}
							/>
						),
				)}
			</div>

			<div className="space-y-2">
				{view.segments.map(seg => (
					<div key={seg.agentType} className="flex items-center justify-between gap-3 text-sm">
						<div className="flex items-center gap-2 min-w-0">
							<span
								className="w-2.5 h-2.5 rounded-full flex-shrink-0"
								style={{ background: AGENT_META[seg.agentType].color }}
							/>
							<span className="stats-text-primary truncate">{AGENT_META[seg.agentType].label}</span>
							<span className="stats-text-muted stats-text-xs whitespace-nowrap">
								{formatInteger(seg.requests)} req
							</span>
						</div>
						<div className="flex items-center gap-3 whitespace-nowrap">
							<span className="stats-text-secondary">{formatCompact(seg.tokens)} tok</span>
							<span className="stats-font-semibold stats-text-primary tabular-nums">
								{formatPercent(seg.share)}
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
