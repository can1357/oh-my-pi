import { useMemo } from "react";
import { getFolderStats } from "../api";
import { formatDurationMs, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import type { TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ProjectsRoute({ active, range, refreshTrigger }: ProjectsRouteProps) {
	const { i18n } = useStatsI18n();
	const {
		data: foldersData,
		error,
		loading,
	} = useResource(["projects", range, refreshTrigger], signal => getFolderStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const folderRows = useMemo(() => {
		if (!foldersData) return [];
		return buildFolderRows(foldersData);
	}, [foldersData]);

	const columns = useMemo(
		() => [
			{
				key: "folder",
				header: i18n.t("stats.projects.projectFolder"),
				render: (item: FolderRowView) => (
					<div
						className="stats-font-medium stats-text-primary truncate max-w-[440px]"
						title={item.folder || "(root)"}
					>
						{item.folder || "(root)"}
					</div>
				),
			},
			{
				key: "totalRequests",
				header: i18n.t("stats.metrics.requests"),
				numeric: true,
				render: (item: FolderRowView) => (
					<div className="stats-text-right">
						<div className="font-mono">{formatInteger(item.totalRequests)}</div>
						<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
							<div
								className="stats-progress-bar-fill"
								data-variant="link"
								style={{ width: `${item.requestsPercentage}%` }}
							/>
						</div>
					</div>
				),
			},
			{
				key: "totalCost",
				header: i18n.t("stats.metrics.apiEstimate"),
				numeric: true,
				render: (item: FolderRowView) => (
					<div className="stats-text-right">
						<div className="font-mono">{formatEstimatedCost(item.totalCost, item.unpricedRequests)}</div>
						<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
							<div
								className="stats-progress-bar-fill"
								data-variant="success"
								style={{ width: `${item.costPercentage}%` }}
							/>
						</div>
					</div>
				),
			},
			{
				key: "totalTokens",
				header: i18n.t("stats.metrics.outputTokens"),
				numeric: true,
				render: (item: FolderRowView) => (
					<div className="font-mono">{formatInteger(item.totalInputTokens + item.totalOutputTokens)}</div>
				),
			},
			{
				key: "cacheRate",
				header: i18n.t("stats.metrics.cacheRate"),
				numeric: true,
				render: (item: FolderRowView) => <span className="font-mono">{formatPercent(item.cacheRate)}</span>,
			},
			{
				key: "cacheSavings",
				header: i18n.t("stats.metrics.cacheSavings"),
				numeric: true,
				render: (item: FolderRowView) => (
					<span className={`${item.cacheSavings < 0 ? "stats-text-danger" : "stats-text-success"} font-medium`}>
						{formatPercent(item.cacheSavings)}
					</span>
				),
			},
			{
				key: "errorRate",
				header: i18n.t("stats.metrics.errorRate"),
				numeric: true,
				render: (item: FolderRowView) => (
					<StatusPill variant={item.errorRate > 0.1 ? "danger" : item.errorRate > 0 ? "warning" : "success"}>
						{formatPercent(item.errorRate)}
					</StatusPill>
				),
			},
			{
				key: "avgDuration",
				header: i18n.t("stats.metrics.avgDuration"),
				numeric: true,
				render: (item: FolderRowView) => formatDurationMs(item.avgDuration),
			},
		],
		[i18n],
	);

	const renderMobileCard = (item: FolderRowView) => (
		<div className="stats-mobile-card">
			<div className="stats-mobile-card-header mb-2">
				<div className="stats-font-semibold stats-text-primary">{item.folder || "(root)"}</div>
				<StatusPill variant={item.errorRate > 0.1 ? "danger" : item.errorRate > 0 ? "warning" : "success"}>
					{formatPercent(item.errorRate)} {i18n.t("stats.projects.err")}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.requests")}</div>
					<div className="stats-mobile-card-value font-mono">{formatInteger(item.totalRequests)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.apiEstimate")}</div>
					<div className="stats-mobile-card-value font-mono">
						{formatEstimatedCost(item.totalCost, item.unpricedRequests)}
					</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.cacheRate")}</div>
					<div className="stats-mobile-card-value">{formatPercent(item.cacheRate)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.cacheSavings")}</div>
					<div className="stats-mobile-card-value">{formatPercent(item.cacheSavings)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.drawer.duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.avgDuration)}</div>
				</div>
			</div>
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={i18n.t("stats.projects.title")} subtitle={i18n.t("stats.projects.subtitle")}>
				<AsyncBoundary
					loading={loading}
					error={error}
					data={foldersData}
					emptyText={i18n.t("stats.projects.noResults")}
				>
					<DataTable
						columns={columns}
						data={folderRows}
						keyExtractor={item => item.folder}
						renderMobileCard={renderMobileCard}
						emptyText={i18n.t("stats.projects.noResults")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
