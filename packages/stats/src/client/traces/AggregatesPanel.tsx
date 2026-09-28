/**
 * Per-tool duration aggregates for one trace (sortable; server order is total
 * time descending).
 */

import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceToolStat } from "../types";
import { Badge, Card, type Column, MeterCell, Table } from "../ui";

export interface AggregatesPanelProps {
	toolStats: TraceToolStat[];
	index?: number;
}

export function AggregatesPanel({ toolStats, index }: AggregatesPanelProps) {
	if (toolStats.length === 0) return null;
	const maxTotal = Math.max(...toolStats.map(stat => stat.totalMs));
	const columns: Column<TraceToolStat>[] = [
		{ key: "tool", header: "Tool", render: row => <span className="mono">{row.tool}</span>, sort: row => row.tool },
		{
			key: "calls",
			header: "Calls",
			align: "right",
			render: row => <span className="num">{formatInteger(row.calls)}</span>,
			sort: row => row.calls,
		},
		{
			key: "errors",
			header: "Errors",
			align: "right",
			render: row =>
				row.errors > 0 ? (
					<Badge tone="bad">{formatInteger(row.errors)} failed</Badge>
				) : (
					<span className="num dim">0</span>
				),
			sort: row => row.errors,
		},
		{
			key: "total",
			header: "Total",
			align: "right",
			width: 200,
			render: row => (
				<MeterCell value={row.totalMs} max={maxTotal} display={formatDurationMs(row.totalMs)} color="var(--warn)" />
			),
			sort: row => row.totalMs,
		},
		{
			key: "avg",
			header: "Avg",
			align: "right",
			render: row => <span className="num">{formatDurationMs(row.calls > 0 ? row.totalMs / row.calls : 0)}</span>,
			sort: row => (row.calls > 0 ? row.totalMs / row.calls : 0),
		},
		{
			key: "max",
			header: "Max",
			align: "right",
			render: row => <span className="num">{formatDurationMs(row.maxMs)}</span>,
			sort: row => row.maxMs,
		},
	];
	return (
		<Card title="Tool aggregates" description={`${toolStats.length} tools, by total time`} flush index={index}>
			<Table columns={columns} rows={toolStats} rowKey={row => row.tool} dense limit={12} />
		</Card>
	);
}
