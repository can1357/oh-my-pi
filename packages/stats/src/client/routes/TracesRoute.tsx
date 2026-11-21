/**
 * Traces section: root-session list (subagents folded in) that opens the
 * flamegraph trace viewer for a selected session.
 */

import { useMemo, useState } from "react";
import { getSessions } from "../api";
import {
	formatCompact,
	formatElapsed,
	formatEstimatedCost,
	formatInteger,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { TraceView } from "../traces/TraceView";
import type { SessionSummary } from "../types";
import {
	Card,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Table,
	TableSkeleton,
} from "../ui";
import "../traces/traces.css";

export interface TracesRouteProps {
	active: boolean;
	session: string | null;
	onOpenSession: (file: string | null) => void;
}

const SESSION_LIMIT = 200;

function ModelList({ models }: { models: string[] }) {
	if (models.length === 0) return <span className="dim">-</span>;
	return (
		<span className="traces-models" title={models.join("\n")}>
			<span className="mono truncate">{models[0]}</span>
			{models.length > 1 && <span className="badge">+{models.length - 1}</span>}
		</span>
	);
}

export function TracesRoute({ active, session, onOpenSession }: TracesRouteProps) {
	const [filter, setFilter] = useState("");
	const sessions = useQuery(
		["sessions", SESSION_LIMIT],
		({ signal }) => getSessions(SESSION_LIMIT, undefined, signal),
		{ pollMs: 30000, enabled: active && session === null },
	);

	const filtered = useMemo(() => {
		const rows = sessions.data ?? [];
		const needle = filter.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter(
			row =>
				(row.title ?? "").toLowerCase().includes(needle) ||
				row.folder.toLowerCase().includes(needle) ||
				row.models.some(model => model.toLowerCase().includes(needle)),
		);
	}, [sessions.data, filter]);

	const maxCost = useMemo(() => Math.max(0, ...filtered.map(row => row.costTotal)), [filtered]);

	const columns = useMemo<Column<SessionSummary>[]>(
		() => [
			{
				key: "title",
				header: "Session",
				width: "32%",
				render: row => (
					<LabelCell
						primary={row.title ?? row.file.split("/").pop()}
						secondary={<span className="mono">{row.folder.split("/").slice(-2).join("/")}</span>}
					/>
				),
				sort: row => (row.title ?? row.file).toLowerCase(),
			},
			{ key: "models", header: "Models", render: row => <ModelList models={row.models} /> },
			{
				key: "started",
				header: "Started",
				align: "right",
				render: row => (
					<span className="muted" title={new Date(row.startedAt).toLocaleString()}>
						{formatRelativeTime(row.startedAt)}
					</span>
				),
				sort: row => row.startedAt,
			},
			{
				key: "duration",
				header: "Duration",
				align: "right",
				render: row => <span className="num">{formatElapsed(row.endedAt - row.startedAt)}</span>,
				sort: row => row.endedAt - row.startedAt,
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				render: row => <span className="num">{formatInteger(row.requests)}</span>,
				sort: row => row.requests,
			},
			{
				key: "toolCalls",
				header: "Tools",
				align: "right",
				render: row => <span className="num">{formatInteger(row.toolCalls)}</span>,
				sort: row => row.toolCalls,
			},
			{
				key: "subagents",
				header: "Agents",
				align: "right",
				render: row =>
					row.subagents > 0 ? (
						<span className="num">{formatInteger(row.subagents)}</span>
					) : (
						<span className="num dim">0</span>
					),
				sort: row => row.subagents,
			},
			{
				key: "tokens",
				header: "Tokens",
				align: "right",
				render: row => <span className="num">{formatCompact(row.totalTokens)}</span>,
				sort: row => row.totalTokens,
			},
			{
				key: "cost",
				header: "Cost",
				align: "right",
				width: 150,
				render: row => (
					<MeterCell
						value={row.costTotal}
						max={maxCost}
						display={formatEstimatedCost(row.costTotal, row.unpricedRequests)}
					/>
				),
				sort: row => row.costTotal,
			},
		],
		[maxCost],
	);

	if (session !== null) {
		return <TraceView file={session} active={active} onBack={() => onOpenSession(null)} />;
	}

	const total = sessions.data?.length ?? 0;
	return (
		<div className="stack traces-page">
			<PageHeader
				title="Traces"
				description="Recent sessions with subagent activity folded in. Open one to inspect its timeline."
			/>
			<Card
				title="Sessions"
				description={
					sessions.data
						? filter.trim()
							? `${formatInteger(filtered.length)} of ${formatInteger(total)} most recent`
							: `${formatInteger(total)} most recent`
						: undefined
				}
				actions={
					<SearchInput
						value={filter}
						onChange={setFilter}
						placeholder="Filter by title, project, model…"
						width={260}
					/>
				}
				flush
				index={0}
				stale={sessions.stale}
			>
				<QueryView
					query={sessions}
					skeleton={<TableSkeleton rows={10} />}
					isEmpty={rows => rows.length === 0}
					empty={<EmptyState title="No sessions found" hint="Run a sync to index recent activity." />}
				>
					{() => (
						<Table
							columns={columns}
							rows={filtered}
							rowKey={row => row.file}
							onRowClick={row => onOpenSession(row.file)}
							initialSort={{ key: "started", dir: "desc" }}
							limit={50}
							empty={<EmptyState title="No matching sessions" hint="Try a different filter." />}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}
