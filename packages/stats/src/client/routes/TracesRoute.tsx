/**
 * Traces section: root-session list (subagents folded in) that opens the
 * flamegraph trace viewer for a selected session.
 */

import { useMemo, useState } from "react";
import { getSessions } from "../api";
import { formatCompact, formatCost, formatDurationMs, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { TraceView } from "../traces/TraceView";
import type { SessionSummary } from "../types";
import { AsyncBoundary, DataTable, Panel } from "../ui";

export interface TracesRouteProps {
	active: boolean;
	session: string | null;
	onOpenSession: (file: string | null) => void;
	refreshTrigger: number;
}

function ModelChips({ models }: { models: string[] }) {
	const shown = models.slice(0, 3);
	return (
		<div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
			{shown.map(model => (
				<span
					key={model}
					className="stats-text-muted truncate"
					style={{
						fontSize: 10,
						border: "1px solid var(--border)",
						borderRadius: 999,
						padding: "1px 6px",
						maxWidth: 140,
					}}
				>
					{model}
				</span>
			))}
			{models.length > 3 && (
				<span className="stats-text-muted" style={{ fontSize: 10 }}>
					+{models.length - 3}
				</span>
			)}
		</div>
	);
}

export function TracesRoute({ active, session, onOpenSession, refreshTrigger }: TracesRouteProps) {
	const [filter, setFilter] = useState("");

	const {
		data: sessions,
		error,
		loading,
	} = useResource(["sessions", refreshTrigger], signal => getSessions(200, undefined, signal), {
		pollMs: 30000,
		enabled: active && session === null,
	});

	const filtered = useMemo(() => {
		if (!sessions) return [];
		const needle = filter.trim().toLowerCase();
		if (!needle) return sessions;
		return sessions.filter(
			row =>
				(row.title ?? "").toLowerCase().includes(needle) ||
				row.folder.toLowerCase().includes(needle) ||
				row.models.some(model => model.toLowerCase().includes(needle)),
		);
	}, [sessions, filter]);

	const columns = useMemo(
		() => [
			{
				key: "title",
				header: "Title",
				render: (item: SessionSummary) => (
					<div className="stats-font-medium stats-text-primary truncate" style={{ maxWidth: 280 }}>
						{item.title ?? item.file.split("/").pop()}
					</div>
				),
			},
			{
				key: "folder",
				header: "Project",
				render: (item: SessionSummary) => (
					<span className="stats-text-muted truncate" style={{ maxWidth: 160, display: "inline-block" }}>
						{item.folder.split("/").slice(-2).join("/")}
					</span>
				),
			},
			{
				key: "started",
				header: "Started",
				render: (item: SessionSummary) => formatRelativeTime(item.startedAt),
			},
			{
				key: "duration",
				header: "Duration",
				numeric: true,
				render: (item: SessionSummary) => formatDurationMs(item.endedAt - item.startedAt),
			},
			{ key: "requests", header: "Requests", numeric: true, render: (item: SessionSummary) => item.requests },
			{ key: "toolCalls", header: "Tools", numeric: true, render: (item: SessionSummary) => item.toolCalls },
			{ key: "subagents", header: "Agents", numeric: true, render: (item: SessionSummary) => item.subagents },
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: SessionSummary) => formatCompact(item.totalTokens),
			},
			{ key: "cost", header: "Cost", numeric: true, render: (item: SessionSummary) => formatCost(item.costTotal) },
			{ key: "models", header: "Models", render: (item: SessionSummary) => <ModelChips models={item.models} /> },
		],
		[],
	);

	const renderMobileCard = (item: SessionSummary, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div className="stats-font-semibold stats-text-primary truncate">
					{item.title ?? item.file.split("/").pop()}
				</div>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Started</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.startedAt)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Duration</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.endedAt - item.startedAt)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Requests</div>
					<div className="stats-mobile-card-value">{item.requests}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cost</div>
					<div className="stats-mobile-card-value">{formatCost(item.costTotal)}</div>
				</div>
			</div>
		</div>
	);

	if (session !== null) {
		return <TraceView file={session} active={active} onBack={() => onOpenSession(null)} />;
	}

	return (
		<div className="stats-route-container">
			<Panel
				title="Sessions"
				subtitle="Recent sessions with subagent activity folded in — click one to open its trace"
				actions={
					<input
						type="search"
						value={filter}
						onChange={event => setFilter(event.target.value)}
						placeholder="Filter by title, project, model…"
						aria-label="Filter sessions"
						spellCheck={false}
						className="stats-trace-input"
						style={{ width: 220 }}
					/>
				}
			>
				<AsyncBoundary loading={loading} error={error} data={sessions}>
					<DataTable
						columns={columns}
						data={filtered}
						keyExtractor={item => item.file}
						onRowClick={item => onOpenSession(item.file)}
						renderMobileCard={renderMobileCard}
						emptyText="No sessions found — run a Sync to index recent activity"
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
