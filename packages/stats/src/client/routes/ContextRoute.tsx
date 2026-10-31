import { useMemo, useState } from "react";
import { getContextOverview } from "../api";
import { formatCompact, formatInteger, formatPercent, formatRelativeTime } from "../data/formatters";
import { useQuery } from "../data/query";
import type { ContextSessionRow, TimeRange } from "../types";
import {
	Badge,
	Card,
	type Column,
	EmptyState,
	LabelCell,
	PageHeader,
	QueryView,
	SearchInput,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import { ContextActivityGrid } from "./context/ContextActivityGrid";
import { ContextDetail } from "./context/ContextDetail";
import { ContextDonut } from "./context/ContextDonut";
import { ContextNotice } from "./context/ContextNotice";
import { ContextSessionCard } from "./context/ContextSessionCard";
import { ContextUsageChart } from "./context/ContextUsageChart";
import {
	buildActivityCells,
	formatContextCost,
	modelMixSegments,
	type ContextActivityCell,
} from "./context/view-models";
import "./context/context.css";

export interface ContextRouteProps {
	active: boolean;
	range: TimeRange;
	session: string | null;
	onOpenSession: (file: string | null) => void;
}
type ContextRange = Exclude<TimeRange, "all">;
type Density = "cards" | "list";
type SortKey = "recent" | "requests" | "peak" | "cost";

const bounded = (range: TimeRange): ContextRange => (range === "all" ? "90d" : range);

export function ContextRoute({ active, range, session, onOpenSession }: ContextRouteProps) {
	const effectiveRange = bounded(range);
	const rangeLabel = range === "all" ? "90d (all-time view is bounded)" : effectiveRange;
	if (session !== null)
		return (
			<ContextDetail
				key={session}
				file={session}
				active={active}
				onBack={() => onOpenSession(null)}
				onOpenTrace={file => {
					window.location.hash = `#/traces?range=${effectiveRange}&s=${encodeURIComponent(file)}`;
				}}
			/>
		);
	return (
		<ContextOverviewPage
			active={active}
			range={effectiveRange}
			rangeLabel={rangeLabel}
			onOpenSession={onOpenSession}
		/>
	);
}

function ContextOverviewPage({
	active,
	range,
	rangeLabel,
	onOpenSession,
}: {
	active: boolean;
	range: ContextRange;
	rangeLabel: string;
	onOpenSession: (file: string | null) => void;
}) {
	const query = useQuery(["context-overview", range], ({ signal }) => getContextOverview(range, signal), {
		pollMs: 30000,
		enabled: active,
	});
	const [metric, setMetric] = useState<"requests" | "promptTokens">("requests");
	const [filter, setFilter] = useState("");
	const [sort, setSort] = useState<SortKey>("recent");
	const [density, setDensity] = useState<Density>("cards");
	const [bucketFilter, setBucketFilter] = useState<ContextActivityCell | null>(null);
	const cells = useMemo(() => (query.data ? buildActivityCells(query.data) : []), [query.data]);
	const selected = useMemo(
		() =>
			(query.data?.sessions ?? [])
				.filter(row => {
					if (!bucketFilter) return true;
					return row.startedAt < bucketFilter.end && row.endedAt >= bucketFilter.start;
				})
				.filter(row => {
					const needle = filter.trim().toLowerCase();
					return (
						!needle ||
						`${row.title ?? ""} ${row.file} ${row.folder} ${row.models.join(" ")}`.toLowerCase().includes(needle)
					);
				})
				.sort((a, b) => {
					if (sort === "requests") return b.requests - a.requests || b.endedAt - a.endedAt;
					if (sort === "peak") return b.peakPromptTokens - a.peakPromptTokens || b.endedAt - a.endedAt;
					if (sort === "cost") return b.costTotal - a.costTotal || b.endedAt - a.endedAt;
					return b.endedAt - a.endedAt || a.file.localeCompare(b.file);
				}),
		[bucketFilter, filter, query.data?.sessions, sort],
	);
	const columns = useMemo<Column<ContextSessionRow>[]>(
		() => [
			{
				key: "session",
				header: "Session",
				width: "34%",
				render: row => (
					<LabelCell
						primary={row.title ?? row.file.split("/").pop()}
						secondary={<span className="mono">{row.folder}</span>}
					/>
				),
				sort: row => (row.title ?? row.file).toLowerCase(),
			},
			{
				key: "models",
				header: "Models",
				render: row => (
					<span className="context-models">
						{row.models[0] ?? "-"}
						{row.models.length > 1 && <Badge>+{row.models.length - 1}</Badge>}
					</span>
				),
				sort: row => row.models[0] ?? "",
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				render: row => <span className="num">{formatInteger(row.requests)}</span>,
				sort: row => row.requests,
			},
			{
				key: "peak",
				header: "Peak prompt",
				align: "right",
				render: row => <span className="num">{formatCompact(row.peakPromptTokens)}</span>,
				sort: row => row.peakPromptTokens,
			},
			{
				key: "avg",
				header: "Avg prompt",
				align: "right",
				render: row => <span className="num">{formatCompact(row.avgPromptTokens)}</span>,
				sort: row => row.avgPromptTokens,
			},
			{
				key: "cost",
				header: "Est. cost",
				align: "right",
				render: row => <span className="num">{formatContextCost(row.costTotal, row.unpricedRequests)}</span>,
				sort: row => row.costTotal,
			},
			{
				key: "last",
				header: "Last active",
				align: "right",
				render: row => (
					<span className="micro" title={new Date(row.endedAt).toLocaleString()}>
						{formatRelativeTime(row.endedAt)}
					</span>
				),
				sort: row => row.endedAt,
			},
		],
		[],
	);
	return (
		<div className="stack context-page">
			<PageHeader
				title="Context"
				description={`Global prompt composition · ${rangeLabel}`}
				actions={<span className="micro">DB approximation · session detail is authoritative</span>}
			/>
			<QueryView
				query={query}
				skeleton={
					<Card title="Context overview">
						<TableSkeleton rows={6} />
					</Card>
				}
				isEmpty={data => data.kpi.requests === 0}
				empty={<EmptyState title="No context activity" hint="Choose a bounded range with indexed requests." />}
			>
				{overview => {
					const models = modelMixSegments(overview.models);
					const totalRequests = models.reduce((sum, segment) => sum + segment.value, 0);
					return (
						<>
							<StatGrid min={160}>
								{[
									["Sessions", overview.kpi.sessions, false],
									["Requests", overview.kpi.requests, false],
									["Prompt tokens", overview.kpi.promptTokens, true],
									["Cache rate", overview.kpi.cacheRate, false, "percent"],
									["Est. cost", overview.kpi.costTotal, true, "cost"],
									["Peak prompt", overview.kpi.peakPromptTokens, false],
								].map(([label, value, primary, kind]) => (
									<div
										className={primary ? "context-kpi-primary" : undefined}
										data-testid={`context-kpi-${String(label).toLowerCase().replaceAll(" ", "-")}`}
										key={String(label)}
									>
										<Stat
											label={label}
											value={
												kind === "percent"
													? formatPercent(Number(value))
													: kind === "cost"
														? formatContextCost(Number(value), overview.kpi.unpricedRequests)
														: formatCompact(Number(value))
											}
											hint={
												label === "Sessions"
													? "detail is authoritative"
													: label === "Est. cost" && overview.kpi.unpricedRequests > 0
														? `${overview.kpi.unpricedRequests} unpriced`
														: undefined
											}
										/>
									</div>
								))}
							</StatGrid>
							<div className="context-overview-split">
								<Card
									title="Usage"
									description={`${rangeLabel} · prompt and output tokens with estimated cost`}
									stale={query.stale}
								>
									<ContextUsageChart overview={overview} cells={cells} onSelect={setBucketFilter} />
								</Card>
								<Card title="Model mix" description="Requests by model · same range">
									{models.length > 0 ? (
										<ContextDonut
											segments={models}
											centerLabel="requests"
											centerValue={formatCompact(totalRequests)}
											ariaLabel="Model request mix"
										/>
									) : (
										<ContextNotice>No model activity in this range.</ContextNotice>
									)}
								</Card>
							</div>
							<Card
								title="Activity"
								description={`${rangeLabel} · buckets follow the API response`}
								actions={
									<Segmented
										aria-label="Heatmap metric"
										value={metric}
										onChange={setMetric}
										options={[
											{ value: "requests", label: "Requests" },
											{ value: "promptTokens", label: "Prompt tokens" },
										]}
										size="sm"
									/>
								}
							>
								<ContextActivityGrid
									overview={overview}
									cells={cells}
									metric={metric}
									selectedKey={bucketFilter?.key ?? null}
									onSelect={cell => setBucketFilter(current => (current?.key === cell.key ? null : cell))}
								/>
							</Card>
							<Card
								title="Sessions"
								description={`${formatInteger(selected.length)} shown · ${formatPercent(
									overview.kpi.requests
										? (overview.kpi.requests - overview.omittedRequests) / overview.kpi.requests
										: 1,
									0,
								)} of requests`}
								actions={
									<div className="context-toolbar">
										<SearchInput
											value={filter}
											onChange={setFilter}
											placeholder="Filter sessions"
											width={220}
										/>
										<Segmented
											aria-label="Sort sessions"
											value={sort}
											onChange={setSort}
											options={[
												{ value: "recent", label: "Last" },
												{ value: "requests", label: "Requests" },
												{ value: "peak", label: "Peak" },
												{ value: "cost", label: "Cost" },
											]}
											size="sm"
										/>
										<Segmented
											aria-label="Session density"
											value={density}
											onChange={setDensity}
											options={[
												{ value: "cards", label: "Cards" },
												{ value: "list", label: "List" },
											]}
											size="sm"
										/>
									</div>
								}
								flush={density === "list"}
								stale={query.stale}
							>
								{bucketFilter && (
									<div className="context-filter-chip">
										<span>Filtered: {bucketFilter.label}</span>
										<button type="button" onClick={() => setBucketFilter(null)}>
											Clear
										</button>
									</div>
								)}
								{density === "cards" ? (
									<div className="context-session-grid">
										{selected.map(row => (
											<ContextSessionCard key={row.file} row={row} onOpen={onOpenSession} />
										))}
										{selected.length === 0 && <ContextNotice>No sessions match this filter.</ContextNotice>}
									</div>
								) : (
									<Table
										columns={columns}
										rows={selected}
										rowKey={row => row.file}
										onRowClick={row => onOpenSession(row.file)}
										limit={50}
										initialSort={{ key: "last", dir: "desc" }}
										empty={<EmptyState title="No matching sessions" hint="Try a different filter." />}
									/>
								)}
							</Card>
							{(overview.omittedSessions > 0 || overview.omittedRequests > 0) && (
								<p className="context-omissions">
									+{formatInteger(overview.omittedSessions)} sessions / +
									{formatInteger(overview.omittedRequests)} requests not shown
								</p>
							)}
							<p className="micro">
								Composition lives in session detail; overview values are a DB approximation.
							</p>
						</>
					);
				}}
			</QueryView>
		</div>
	);
}
