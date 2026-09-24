/**
 * Collapsible per-tool duration aggregates for one trace, sorted by total
 * time descending (as produced by the server).
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDurationMs, formatInteger } from "../data/formatters";
import { useStatsI18n } from "../i18n";
import type { TraceToolStat } from "../types";
import { DataTable } from "../ui/DataTable";

export interface AggregatesPanelProps {
	toolStats: TraceToolStat[];
}

export function AggregatesPanel({ toolStats }: AggregatesPanelProps) {
	const { i18n } = useStatsI18n();
	const [open, setOpen] = useState(false);

	const columns = useMemo(
		() => [
			{ key: "tool", header: i18n.t("stats.trace.tool"), render: (item: TraceToolStat) => item.tool },
			{
				key: "calls",
				header: i18n.t("stats.trace.calls"),
				numeric: true,
				render: (item: TraceToolStat) => formatInteger(item.calls),
			},
			{
				key: "errors",
				header: i18n.t("stats.trace.errors"),
				numeric: true,
				render: (item: TraceToolStat) => formatInteger(item.errors),
			},
			{
				key: "total",
				header: i18n.t("stats.trace.total"),
				numeric: true,
				render: (item: TraceToolStat) => formatDurationMs(item.totalMs),
			},
			{
				key: "avg",
				header: i18n.t("stats.trace.avg"),
				numeric: true,
				render: (item: TraceToolStat) => formatDurationMs(item.calls > 0 ? item.totalMs / item.calls : 0),
			},
			{
				key: "max",
				header: i18n.t("stats.trace.max"),
				numeric: true,
				render: (item: TraceToolStat) => formatDurationMs(item.maxMs),
			},
		],
		[i18n],
	);

	if (toolStats.length === 0) return null;

	return (
		<div className="stats-panel">
			<button
				type="button"
				onClick={() => setOpen(prev => !prev)}
				aria-expanded={open}
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					width: "100%",
					background: "none",
					border: "none",
					padding: "10px 14px",
					cursor: "pointer",
					textAlign: "left",
				}}
			>
				{open ? (
					<ChevronDown size={14} className="stats-text-muted" aria-hidden="true" />
				) : (
					<ChevronRight size={14} className="stats-text-muted" aria-hidden="true" />
				)}
				<span className="stats-panel-title">{i18n.t("stats.trace.toolAggregates")}</span>
				<span className="stats-text-muted" style={{ fontSize: 11 }}>
					{toolStats.length} {i18n.t("stats.trace.tools")}
				</span>
			</button>
			{open && (
				<div className="stats-panel-body">
					<DataTable
						columns={columns}
						data={toolStats}
						keyExtractor={item => item.tool}
						emptyText={i18n.t("stats.trace.noToolCalls")}
					/>
				</div>
			)}
		</div>
	);
}
