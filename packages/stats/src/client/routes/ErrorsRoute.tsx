import { useMemo } from "react";
import { getRecentErrors } from "../api";
import { formatInteger, formatMessageCost, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function ErrorsRoute({ active, range, refreshTrigger, onRequestClick }: ErrorsRouteProps) {
	const {
		data: recentErrors,
		error,
		loading,
	} = useResource(["recent-errors-dense", range, refreshTrigger], signal => getRecentErrors(range, 50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = useMemo(
		() => [
			{
				key: "model",
				header: "Model",
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: "Time",
				render: (item: MessageStats) => formatRelativeTime(item.timestamp),
			},
			{
				key: "errorMessage",
				header: "Error Message",
				render: (item: MessageStats) => (
					<div
						className="stats-text-xs stats-text-danger stats-truncate stats-max-w-md stats-font-mono"
						title={item.errorMessage || ""}
					>
						{item.errorMessage || "Unknown error"}
					</div>
				),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: "API-equivalent estimate",
				numeric: true,
				render: (item: MessageStats) => formatMessageCost(item, 4),
			},
		],
		[],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card stats-border-danger" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant="danger">Failed</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Time</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">API-equivalent estimate</div>
					<div className="stats-mobile-card-value">{formatMessageCost(item, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Tokens</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error mt-2 stats-font-mono">{item.errorMessage}</div>}
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title="Recent Errors" subtitle="Up to 50 most recent failed requests in the stats database">
				<AsyncBoundary
					loading={loading}
					error={error}
					data={recentErrors}
					emptyText="No recent failures in the local stats database"
				>
					<DataTable
						columns={columns}
						data={recentErrors || []}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText="No recent failures in the local stats database"
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
