import { useMemo, useState } from "react";
import { formatCompact, formatCost } from "../../data/formatters";
import { Card, type Column, Segmented, Table } from "../../ui";
import type { ContextAgentUsage, ContextTimeline } from "../../types";
import { ContextFleetGraph } from "./ContextFleetGraph";

type FleetView = "graph" | "table";

export function FleetTab({
	timeline,
	onOpenAgent,
}: {
	timeline: ContextTimeline;
	onOpenAgent: (agent: ContextAgentUsage) => void;
}) {
	const [view, setView] = useState<FleetView>("graph");
	const columns = useMemo<Column<ContextAgentUsage>[]>(
		() => [
			{
				key: "label",
				header: "Label",
				render: agent => <span className="mono">{agent.label}</span>,
				sort: agent => agent.label,
			},
			{
				key: "agent",
				header: "Agent",
				render: agent => <span>{agent.agent ?? "-"}</span>,
				sort: agent => agent.agent ?? "",
			},
			{
				key: "model",
				header: "Model",
				render: agent => <span className="mono truncate">{agent.model ?? "-"}</span>,
				sort: agent => agent.model ?? "",
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				render: agent => <span className="num">{agent.requests}</span>,
				sort: agent => agent.requests,
			},
			{
				key: "peak",
				header: "Peak",
				align: "right",
				render: agent => <span className="num">{formatCompact(agent.peakTokens)}</span>,
				sort: agent => agent.peakTokens,
			},
			{
				key: "last",
				header: "Last",
				align: "right",
				render: agent => (
					<span className="num">{agent.lastTokens === undefined ? "-" : formatCompact(agent.lastTokens)}</span>
				),
				sort: agent => agent.lastTokens ?? 0,
			},
			{
				key: "cost",
				header: "Cost",
				align: "right",
				render: agent => (
					<span className="num">{agent.costTotal === undefined ? "-" : formatCost(agent.costTotal)}</span>
				),
				sort: agent => agent.costTotal ?? 0,
			},
			{
				key: "status",
				header: "Status",
				render: agent => <span className="badge">{agent.status}</span>,
				sort: agent => agent.status,
			},
		],
		[],
	);
	const graph = view === "graph";
	return (
		<Card
			title="Fleet"
			description="Flat fan: one session, every child transcript."
			actions={
				<Segmented
					aria-label="Fleet view"
					size="sm"
					value={view}
					onChange={setView}
					options={[
						{ value: "graph", label: "Graph" },
						{ value: "table", label: "Table" },
					]}
				/>
			}
		>
			{graph ? (
				<ContextFleetGraph timeline={timeline} onOpenAgent={onOpenAgent} />
			) : (
				<Table
					columns={columns}
					rows={timeline.agents}
					rowKey={agent => agent.trackId}
					onRowClick={agent => agent.status === "subagent" && onOpenAgent(agent)}
					initialSort={{ key: "requests", dir: "desc" }}
					empty={<p className="dim">No child transcripts recorded.</p>}
				/>
			)}
		</Card>
	);
}
