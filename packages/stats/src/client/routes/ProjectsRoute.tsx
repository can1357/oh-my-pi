import { useDeferredValue, useMemo, useState } from "react";
import { getFolderStats } from "../api";
import { BarList } from "../charts";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatFolder,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import type { TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./projects.css";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
}

/** Rows rendered before "Show all": keeps the first paint cheap with tens of thousands of folders. */
const TABLE_LIMIT = 100;
const TOP_LIMIT = 8;

export function ProjectsRoute({ active, range }: ProjectsRouteProps) {
	const folders = useQuery(["projects", range], () => getFolderStats(range), { enabled: active });
	const [search, setSearch] = useState("");
	// Benchmarks and scratch sessions can leave tens of thousands of one-off temp folders; hide them by default.
	const [hideTemporary, setHideTemporary] = useState(true);
	const query = useDeferredValue(search.trim().toLowerCase());
	const meta = rangeMeta(range);

	const view = useMemo(() => buildFolderRows(folders.data ?? []), [folders.data]);
	const scoped = useMemo(
		() => (hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows),
		[view, hideTemporary],
	);
	const matching = useMemo(
		() => (query ? scoped.filter(row => row.folder.toLowerCase().includes(query)) : scoped),
		[scoped, query],
	);
	const top = useMemo(
		() => ({
			cost: [...scoped].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_LIMIT),
			requests: [...scoped].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, TOP_LIMIT),
		}),
		[scoped],
	);
	const topEmpty = (
		<EmptyState
			title={view.rows.length === 0 ? "No project folders in this range" : "Only temporary folders in this range"}
		/>
	);
	// Meter scales follow the whole range so a bar's length does not change while filtering.
	const columns = useMemo(() => folderColumns(view.maxRequests, view.maxCost), [view]);

	return (
		<div className="page">
			<PageHeader title="Projects" description={`Usage by session folder in ${meta.windowLabel}.`} />

			<QueryView query={folders} skeleton={<ChartSkeleton height={96} />}>
				{() => (
					<div data-stale={folders.stale}>
						<StatGrid min={180}>
							<Stat
								label="Folders"
								value={formatInteger(view.rows.length)}
								hint={view.temporaryCount > 0 ? `${formatInteger(view.temporaryCount)} temporary` : undefined}
							/>
							<Stat
								label="Requests"
								value={formatInteger(view.totalRequests)}
								hint={`${formatInteger(view.failedRequests)} failed`}
							/>
							<Stat
								label="API-equivalent cost"
								title="What this usage would cost at public API rates"
								value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
								hint={
									view.unpricedRequests > 0 ? `${formatInteger(view.unpricedRequests)} unpriced` : undefined
								}
							/>
							<Stat
								label="Conversation tokens"
								title="Uncached input + cache reads + cache writes + output"
								value={formatCompact(view.conversationTokens)}
							/>
							<Stat
								label="Cache rate"
								title="Cache reads ÷ (uncached input + cache reads), across every folder"
								value={formatPercent(view.cacheRate)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-2">
				<Card index={1} title="Top by cost" description="Share of API-equivalent cost" stale={folders.stale}>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.cost.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.cost.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder)}</span>,
									value: row.totalCost,
									display: `${formatEstimatedCost(row.totalCost, row.unpricedRequests)} · ${formatPercent(row.costShare)}`,
									color: "var(--chart-secondary)",
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
				<Card index={2} title="Top by requests" description="Share of all requests" stale={folders.stale}>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.requests.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.requests.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder)}</span>,
									value: row.totalRequests,
									display: `${formatInteger(row.totalRequests)} · ${formatPercent(row.requestShare)}`,
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title="Folders"
				description={
					folders.data
						? matching.length === view.rows.length
							? `${formatInteger(view.rows.length)} folders`
							: `${formatInteger(matching.length)} of ${formatInteger(view.rows.length)} folders`
						: undefined
				}
				actions={
					<>
						{view.temporaryCount > 0 && (
							<label className="check" title="Session folders under /tmp or /var/folders">
								<input
									type="checkbox"
									checked={hideTemporary}
									onChange={e => setHideTemporary(e.target.checked)}
								/>
								Hide temporary ({formatInteger(view.temporaryCount)})
							</label>
						)}
						<SearchInput value={search} onChange={setSearch} placeholder="Filter folders…" width={240} />
					</>
				}
				flush
				stale={folders.stale}
			>
				<QueryView query={folders} skeleton={<TableSkeleton rows={10} />}>
					{() => (
						<Table
							rows={matching}
							rowKey={row => row.folder}
							columns={columns}
							initialSort={{ key: "cost", dir: "desc" }}
							limit={TABLE_LIMIT}
							dense
							empty={
								<EmptyState
									title={view.rows.length === 0 ? "No project folders in this range" : "No folders match"}
									hint={
										view.rows.length === 0
											? "Try a longer range."
											: hideTemporary && view.temporaryCount > 0
												? "Temporary folders are hidden."
												: undefined
									}
								/>
							}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function folderColumns(maxRequests: number, maxCost: number): Column<FolderRowView>[] {
	return [
		{
			key: "folder",
			header: "Folder",
			sort: row => row.folder,
			render: row => (
				<span className="row projects-folder" title={row.folder || "(root)"}>
					<span className="mono truncate">{formatFolder(row.folder)}</span>
					{row.temporary && <Badge>temp</Badge>}
				</span>
			),
		},
		{
			key: "requests",
			header: "Requests",
			align: "right",
			sort: row => row.totalRequests,
			render: row => (
				<span title={`${formatPercent(row.requestShare)} of all requests`}>
					<MeterCell value={row.totalRequests} max={maxRequests} display={formatInteger(row.totalRequests)} />
				</span>
			),
		},
		{
			key: "cost",
			header: "Cost",
			title: "API-equivalent cost at public API rates",
			align: "right",
			sort: row => row.totalCost,
			render: row => (
				<span title={`${formatPercent(row.costShare)} of all cost`}>
					<MeterCell
						value={row.totalCost}
						max={maxCost}
						display={formatEstimatedCost(row.totalCost, row.unpricedRequests)}
						color="var(--chart-secondary)"
					/>
				</span>
			),
		},
		{
			key: "tokens",
			header: "Tokens",
			title: "Uncached input + cache reads + cache writes + output",
			align: "right",
			sort: row => row.conversationTokens,
			render: row => (
				<span className="num" title={formatInteger(row.conversationTokens)}>
					{formatCompact(row.conversationTokens)}
				</span>
			),
		},
		{
			key: "cacheRate",
			header: "Cache rate",
			title: "Cache reads ÷ (uncached input + cache reads)",
			align: "right",
			sort: row => row.cacheRate,
			render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
		},
		{
			key: "cacheSavings",
			header: "Cache savings",
			title: "Prompt-input cost saved versus billing the same tokens uncached",
			align: "right",
			sort: row => row.cacheSavings,
			render: row => (
				<span className={`num ${row.cacheSavings < 0 ? "tone-bad" : "muted"}`}>
					{formatPercent(row.cacheSavings)}
				</span>
			),
		},
		{
			key: "errorRate",
			header: "Errors",
			align: "right",
			sort: row => row.errorRate,
			render: row => (
				<span title={`${formatInteger(row.failedRequests)} failed`}>
					<Badge tone={row.failedRequests > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
						{formatErrorRate(row.errorRate)}
					</Badge>
				</span>
			),
		},
		{
			key: "duration",
			header: "Avg duration",
			align: "right",
			sort: row => row.avgDuration ?? -1,
			render: row => <span className="num">{formatDurationMs(row.avgDuration)}</span>,
		},
		{
			key: "last",
			header: "Last active",
			align: "right",
			sort: row => row.lastTimestamp,
			render: row => <span className="dim">{formatRelativeTime(row.lastTimestamp)}</span>,
		},
	];
}
