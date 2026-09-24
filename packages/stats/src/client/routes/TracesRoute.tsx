/**
 * Traces section: root-session list (subagents folded in) that opens the
 * flamegraph trace viewer for a selected session.
 */

import { useMemo, useState } from "react";
import { getSessions } from "../api";
import { formatCompact, formatDurationMs, formatEstimatedCost, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
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
	const { i18n } = useStatsI18n();
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
				header: i18n.t("stats.traces.title"),
				render: (item: SessionSummary) => (
					<div className="stats-font-medium stats-text-primary truncate" style={{ maxWidth: 280 }}>
						{item.title ?? item.file.split("/").pop()}
					</div>
				),
			},
			{
				key: "folder",
				header: i18n.t("stats.traces.project"),
				render: (item: SessionSummary) => (
					<span className="stats-text-muted truncate" style={{ maxWidth: 160, display: "inline-block" }}>
						{item.folder.split("/").slice(-2).join("/")}
					</span>
				),
			},
			{
				key: "started",
				header: i18n.t("stats.traces.started"),
				render: (item: SessionSummary) => formatRelativeTime(item.startedAt, i18n.locale),
			},
			{
				key: "duration",
				header: i18n.t("stats.drawer.duration"),
				numeric: true,
				render: (item: SessionSummary) => formatDurationMs(item.endedAt - item.startedAt),
			},
			{
				key: "requests",
				header: i18n.t("stats.trace.requests"),
				numeric: true,
				render: (item: SessionSummary) => item.requests,
			},
			{
				key: "toolCalls",
				header: i18n.t("stats.trace.tools"),
				numeric: true,
				render: (item: SessionSummary) => item.toolCalls,
			},
			{
				key: "subagents",
				header: i18n.t("stats.trace.agents"),
				numeric: true,
				render: (item: SessionSummary) => item.subagents,
			},
			{
				key: "tokens",
				header: i18n.t("stats.trace.tokens"),
				numeric: true,
				render: (item: SessionSummary) => formatCompact(item.totalTokens),
			},
			{
				key: "cost",
				header: i18n.t("stats.trace.cost"),
				numeric: true,
				render: (item: SessionSummary) => formatEstimatedCost(item.costTotal, item.unpricedRequests),
			},
			{
				key: "models",
				header: i18n.t("stats.nav.models"),
				render: (item: SessionSummary) => <ModelChips models={item.models} />,
			},
		],
		[i18n],
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
					<div className="stats-mobile-card-label">{i18n.t("stats.traces.started")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.startedAt, i18n.locale)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.drawer.duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.endedAt - item.startedAt)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.trace.requests")}</div>
					<div className="stats-mobile-card-value">{item.requests}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.trace.cost")}</div>
					<div className="stats-mobile-card-value">
						{formatEstimatedCost(item.costTotal, item.unpricedRequests)}
					</div>
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
				title={i18n.t("stats.traces.sessions")}
				subtitle={i18n.t("stats.traces.sessionsSubtitle")}
				actions={
					<input
						type="search"
						value={filter}
						onChange={event => setFilter(event.target.value)}
						placeholder={i18n.t("stats.traces.filterPlaceholder")}
						aria-label={i18n.t("stats.traces.filterSessions")}
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
						emptyText={i18n.t("stats.traces.noSessions")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
