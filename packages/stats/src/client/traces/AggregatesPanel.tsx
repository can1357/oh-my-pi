/**
 * Collapsible per-tool duration aggregates for one trace, sorted by total
 * time descending (as produced by the server).
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceToolStat } from "../types";
import { DataTable } from "../ui/DataTable";

export interface AggregatesPanelProps {
	toolStats: TraceToolStat[];
}

export function AggregatesPanel({ toolStats }: AggregatesPanelProps) {
	const [open, setOpen] = useState(false);

	const columns = useMemo(
		() => [
			{ key: "tool", header: "Tool", render: (item: TraceToolStat) => item.tool },
			{ key: "calls", header: "Calls", numeric: true, render: (item: TraceToolStat) => formatInteger(item.calls) },
			{
				key: "errors",
				header: "Errors",
				numeric: true,
				render: (item: TraceToolStat) => formatInteger(item.errors),
			},
			{
				key: "total",
				header: "Total",
				numeric: true,
				render: (item: TraceToolStat) => formatDurationMs(item.totalMs),
			},
			{
				key: "avg",
				header: "Avg",
				numeric: true,
				render: (item: TraceToolStat) => formatDurationMs(item.calls > 0 ? item.totalMs / item.calls : 0),
			},
			{ key: "max", header: "Max", numeric: true, render: (item: TraceToolStat) => formatDurationMs(item.maxMs) },
		],
		[],
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
				<span className="stats-panel-title">Tool Aggregates</span>
				<span className="stats-text-muted" style={{ fontSize: 11 }}>
					{toolStats.length} tools
				</span>
			</button>
			{open && (
				<div className="stats-panel-body">
					<DataTable
						columns={columns}
						data={toolStats}
						keyExtractor={item => item.tool}
						emptyText="No tool calls"
					/>
				</div>
			)}
		</div>
	);
}
