import { useMemo } from "react";
import { getRecentRequests } from "../api";
import { formatDurationMs, formatInteger, formatMessageCost, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function RequestsRoute({ active, refreshTrigger, onRequestClick }: RequestsRouteProps) {
	const { i18n } = useStatsI18n();
	const {
		data: recentRequests,
		error,
		loading,
	} = useResource(["recent-requests-dense", refreshTrigger], signal => getRecentRequests(50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = useMemo(
		() => [
			{
				key: "model",
				header: i18n.t("stats.table.model"),
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: i18n.t("stats.table.time"),
				render: (item: MessageStats) => formatRelativeTime(item.timestamp, i18n.locale),
			},
			{
				key: "tokens",
				header: i18n.t("stats.table.tokens"),
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: i18n.t("stats.metrics.apiEstimate"),
				numeric: true,
				render: (item: MessageStats) => formatMessageCost(item, 4),
			},
			{
				key: "duration",
				header: i18n.t("stats.drawer.duration"),
				numeric: true,
				render: (item: MessageStats) => formatDurationMs(item.duration),
			},
			{
				key: "status",
				header: i18n.t("stats.table.status"),
				className: "stats-text-center",
				render: (item: MessageStats) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? i18n.t("stats.table.failed") : i18n.t("stats.table.success")}
					</StatusPill>
				),
			},
		],
		[i18n],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? i18n.t("stats.table.failed") : i18n.t("stats.table.success")}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.table.time")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp, i18n.locale)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.apiEstimate")}</div>
					<div className="stats-mobile-card-value">{formatMessageCost(item, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.table.tokens")}</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.drawer.duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={i18n.t("stats.requests.title")} subtitle={i18n.t("stats.requests.subtitle")}>
				<AsyncBoundary loading={loading} error={error} data={recentRequests}>
					<DataTable
						columns={columns}
						data={recentRequests || []}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText={i18n.t("stats.requests.noResults")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
