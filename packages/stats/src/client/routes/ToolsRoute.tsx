import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { getToolDashboardStats } from "../api";
import { Legend, Sparkline, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import {
	formatCompact,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import { buildToolRows, type ToolRowView } from "../data/view-models";
import type { TimeRange, ToolDashboardStats, ToolModelStats, ToolTimeSeriesPoint } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Swatch,
	Table,
	TableSkeleton,
} from "../ui";
import "./tools.css";

export interface ToolsRouteProps {
	active: boolean;
	range: TimeRange;
}

type CallMetric = "calls" | "errors";

const METRIC_OPTIONS = [
	{ value: "calls" as const, label: "Calls" },
	{ value: "errors" as const, label: "Errors" },
];

/** Tools stacked individually in the calls chart; the rest fold into "Other". */
const TOP_TOOLS = 6;

const ATTRIBUTION_NOTE =
	"Tokens and API-equivalent cost of each invoking turn, split evenly across that turn's tool calls";

const NO_CALLS = <EmptyState title="No tool calls in this range" />;

export function ToolsRoute({ active, range }: ToolsRouteProps) {
	const tools = useQuery(["tools", range], () => getToolDashboardStats(range), { enabled: active });
	const [metric, setMetric] = useState<CallMetric>("calls");
	const [hidden, toggleHidden] = useHiddenSeries();
	const [pickedTool, setToolFilter] = useState<string | null>(null);
	const meta = rangeMeta(range);

	const view = useMemo(() => buildToolsView(tools.data, range), [tools.data, range]);
	// A pick from another range only applies while that tool still has calls.
	const toolFilter = pickedTool !== null && view.toolNames.includes(pickedTool) ? pickedTool : null;

	const chartSeries = metric === "calls" ? view.callSeries : view.errorSeries;
	const isEmpty = (data: ToolDashboardStats) => data.byTool.length === 0;

	return (
		<div className="page">
			<PageHeader
				title="Tools"
				description={`Which tools omp called in ${meta.windowLabel}, how often they failed, and what they cost.`}
			/>

			<QueryView query={tools} skeleton={<ChartSkeleton height={112} />}>
				{() => {
					const t = view.totals;
					return (
						<div data-stale={tools.stale} className="stack" style={{ gap: 16 }}>
							<StatGrid min={190}>
								<Stat
									label="Tool calls"
									value={formatInteger(t.calls)}
									hint={`${formatInteger(t.errors)} failed`}
									spark={view.totalCalls}
								/>
								<Stat
									label="Distinct tools"
									value={formatInteger(t.tools)}
									hint={view.rows[0] ? `Most used: ${view.rows[0].tool}` : undefined}
								/>
								<Stat
									label="Error rate"
									title="Tool results that came back flagged as errors"
									value={formatErrorRate(t.calls > 0 ? t.errors / t.calls : 0)}
									hint={`${formatInteger(t.calls - t.errors)} succeeded`}
									spark={view.totalErrors}
									sparkColor="var(--bad)"
								/>
								<Stat
									label="Attributed tokens"
									title={ATTRIBUTION_NOTE}
									value={formatCompact(Math.round(t.tokens))}
									hint={`${formatCompact(Math.round(t.output))} output`}
								/>
								<Stat
									label="Attributed cost"
									title={`${ATTRIBUTION_NOTE}; API-equivalent estimate`}
									value={formatEstimatedCost(t.cost, t.unpriced)}
									hint={
										t.unpriced > 0
											? `${formatInteger(Math.round(t.unpriced))} unpriced requests`
											: "API-equivalent"
									}
								/>
							</StatGrid>
							<StatGrid min={150}>
								<Stat
									size="sm"
									label="Result text"
									title="Characters of tool-result text fed back into context"
									value={`${formatCompact(t.resultChars)} chars`}
								/>
								<Stat
									size="sm"
									label="Call arguments"
									title="Characters of serialized tool-call arguments"
									value={`${formatCompact(t.argsChars)} chars`}
								/>
								<Stat
									size="sm"
									label="Avg result per call"
									value={`${formatCompact(t.calls > 0 ? Math.round(t.resultChars / t.calls) : 0)} chars`}
								/>
								<Stat
									size="sm"
									label="Avg arguments per call"
									value={`${formatCompact(t.calls > 0 ? Math.round(t.argsChars / t.calls) : 0)} chars`}
								/>
							</StatGrid>
						</div>
					);
				}}
			</QueryView>

			<Card
				index={1}
				title={metric === "calls" ? "Calls over time" : "Errors over time"}
				description={`Per ${meta.bucketMs < 3_600_000 ? "5 minutes" : meta.bucketMs < 86_400_000 ? "hour" : "day"}, top ${TOP_TOOLS} tools stacked`}
				actions={<Segmented size="sm" options={METRIC_OPTIONS} value={metric} onChange={setMetric} />}
				stale={tools.stale}
			>
				<QueryView query={tools} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{() => (
						<div className="stack" style={{ gap: 12 }}>
							<TimeChart
								buckets={view.buckets}
								bucketMs={meta.bucketMs}
								series={chartSeries}
								hidden={hidden}
								height={260}
								formatTooltip={formatInteger}
								emptyLabel={metric === "errors" ? "No tool errors in this range" : undefined}
							/>
							<Legend
								items={chartSeries.map(s => ({
									key: s.key,
									label: s.label,
									color: s.color,
									value: formatCompact(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
								}))}
								hidden={hidden}
								onToggle={toggleHidden}
							/>
						</div>
					)}
				</QueryView>
			</Card>

			<Card
				index={2}
				title="By tool"
				description={`${ATTRIBUTION_NOTE}. Select a tool to break it down by model.`}
				flush
				stale={tools.stale}
			>
				<QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{() => (
						<Table
							rows={view.rows}
							rowKey={row => row.tool}
							columns={view.toolColumns}
							initialSort={{ key: "calls", dir: "desc" }}
							limit={20}
							selectedKey={toolFilter}
							onRowClick={row => setToolFilter(prev => (prev === row.tool ? null : row.tool))}
							dense
						/>
					)}
				</QueryView>
			</Card>

			<Card
				index={3}
				title="By tool and model"
				description="Which models call which tools, and how often those calls fail"
				flush
				stale={tools.stale}
				actions={
					<div className="row" style={{ gap: 6 }}>
						<select
							className="input tools-filter"
							value={toolFilter ?? ""}
							onChange={e => setToolFilter(e.target.value || null)}
							aria-label="Filter by tool"
						>
							<option value="">All tools</option>
							{view.toolNames.map(name => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
						{toolFilter !== null && (
							<button
								type="button"
								className="btn"
								data-size="sm"
								data-variant="ghost"
								data-icon="true"
								title="Clear tool filter"
								aria-label="Clear tool filter"
								onClick={() => setToolFilter(null)}
							>
								<X size={13} />
							</button>
						)}
					</div>
				}
			>
				<QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{data => <ToolModelTable rows={data.byToolModel} tool={toolFilter} colors={view.colors} />}
				</QueryView>
			</Card>
		</div>
	);
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface ToolTotals {
	calls: number;
	errors: number;
	tools: number;
	tokens: number;
	output: number;
	cost: number;
	unpriced: number;
	resultChars: number;
	argsChars: number;
}

function buildToolsView(data: ToolDashboardStats | null, range: TimeRange) {
	const byTool = data?.byTool ?? [];
	const points = data?.series ?? [];
	const rows = buildToolRows(byTool).sort((a, b) => b.calls - a.calls);
	const colors = buildColorLookup(byTool.map(t => ({ key: t.tool, weight: t.calls })));
	const buckets = bucketAxis(
		range,
		points.map(p => p.timestamp),
	);

	const totals: ToolTotals = {
		calls: 0,
		errors: 0,
		tools: byTool.length,
		tokens: 0,
		output: 0,
		cost: 0,
		unpriced: 0,
		resultChars: 0,
		argsChars: 0,
	};
	for (const t of byTool) {
		totals.calls += t.calls;
		totals.errors += t.errors;
		totals.tokens += t.totalTokensShare;
		totals.output += t.outputTokensShare;
		totals.cost += t.costShare;
		totals.unpriced += t.unpricedRequestsShare;
		totals.resultChars += t.resultChars;
		totals.argsChars += t.argsChars;
	}

	// Every tool keeps its table swatch color in both metrics; zero slots become
	// gaps so the tooltip lists only tools active in that bucket.
	const [callSeries, errorSeries] = [(p: ToolTimeSeriesPoint) => p.calls, (p: ToolTimeSeriesPoint) => p.errors].map(
		value =>
			pivotSeries(points, { buckets, key: p => p.tool, value, limit: TOP_TOOLS, colors }).map(s => ({
				...s,
				values: s.values.map(v => v || null),
			})),
	);
	// Unlimited pivot for the per-row sparklines.
	const trends = new Map(
		pivotSeries(points, { buckets, key: p => p.tool, value: p => p.calls }).map(s => [s.key, s.values as number[]]),
	);

	const maxCalls = rows[0]?.calls ?? 0;
	const toolColumns = buildToolColumns(maxCalls, colors, trends);

	return {
		rows,
		colors,
		buckets,
		totals,
		callSeries,
		errorSeries,
		totalCalls: densify(points, buckets, p => p.calls),
		totalErrors: densify(points, buckets, p => p.errors),
		toolNames: rows.map(r => r.tool).sort((a, b) => a.localeCompare(b)),
		toolColumns,
	};
}

function buildToolColumns(
	maxCalls: number,
	colors: ReadonlyMap<string, string>,
	trends: ReadonlyMap<string, number[]>,
): Column<ToolRowView>[] {
	return [
		{
			key: "tool",
			header: "Tool",
			sort: row => row.tool,
			render: row => (
				<span className="row" style={{ gap: 8 }}>
					<Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
					<span className="mono truncate tools-name" title={row.tool}>
						{row.tool}
					</span>
				</span>
			),
		},
		{
			key: "trend",
			header: "Trend",
			title: "Calls per bucket over the range",
			render: row => {
				const values = trends.get(row.tool);
				return values && values.length > 1 ? (
					<Sparkline values={values} width={80} height={20} color={colors.get(row.tool) ?? OTHER_COLOR} />
				) : (
					<span className="dim">–</span>
				);
			},
		},
		{
			key: "calls",
			header: "Calls",
			align: "right",
			sort: row => row.calls,
			render: row => (
				<MeterCell
					value={row.calls}
					max={maxCalls}
					display={
						<span title={`${formatPercent(row.callFraction)} of all tool calls`}>
							{formatInteger(row.calls)}
							<span className="dim tools-share">{formatPercent(row.callFraction, 0)}</span>
						</span>
					}
				/>
			),
		},
		{
			key: "errorRate",
			header: "Errors",
			title: "Calls whose result came back flagged as an error",
			align: "right",
			sort: row => row.errorRate,
			render: row => (
				<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
					<span className="num dim">{formatInteger(row.errors)}</span>
					<Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
						{formatErrorRate(row.errorRate)}
					</Badge>
				</span>
			),
		},
		{
			key: "args",
			header: "Args",
			title: "Characters of serialized tool-call arguments",
			align: "right",
			sort: row => row.argsChars,
			render: row => <span className="num">{formatCompact(row.argsChars)}</span>,
		},
		{
			key: "result",
			header: "Result",
			title: "Characters of tool-result text fed back into context",
			align: "right",
			sort: row => row.resultChars,
			render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
		},
		{
			key: "avgResult",
			header: "Result / call",
			title: "Mean tool-result characters per call",
			align: "right",
			sort: row => row.avgResultChars,
			render: row => <span className="num muted">{formatCompact(Math.round(row.avgResultChars))}</span>,
		},
		{
			key: "tokens",
			header: "Attr. tokens",
			title: ATTRIBUTION_NOTE,
			align: "right",
			sort: row => row.totalTokensShare,
			render: row => (
				<span className="num" title={`${formatPercent(row.tokenFraction)} of attributed tokens`}>
					{formatCompact(Math.round(row.totalTokensShare))}
					<span className="dim tools-share">{formatPercent(row.tokenFraction, 0)}</span>
				</span>
			),
		},
		{
			key: "cost",
			header: "Attr. cost",
			title: `${ATTRIBUTION_NOTE}; API-equivalent estimate`,
			align: "right",
			sort: row => row.costShare,
			render: row => (
				<span className="num" title={`${formatPercent(row.costFraction)} of attributed cost`}>
					{formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}
					<span className="dim tools-share">{formatPercent(row.costFraction, 0)}</span>
				</span>
			),
		},
		{
			key: "lastUsed",
			header: "Last used",
			align: "right",
			sort: row => row.lastUsed,
			render: row => <span className="muted">{formatRelativeTime(row.lastUsed)}</span>,
		},
	];
}

// ---------------------------------------------------------------------------
// Tool × model breakdown
// ---------------------------------------------------------------------------

interface ToolModelRow extends ToolModelStats {
	errorRate: number;
}

function ToolModelTable({
	rows,
	tool,
	colors,
}: {
	rows: ToolModelStats[];
	tool: string | null;
	colors: ReadonlyMap<string, string>;
}) {
	const filtered = useMemo<ToolModelRow[]>(
		() =>
			(tool === null ? rows : rows.filter(r => r.tool === tool)).map(r => ({
				...r,
				errorRate: r.calls > 0 ? r.errors / r.calls : 0,
			})),
		[rows, tool],
	);
	const columns = useMemo<Column<ToolModelRow>[]>(() => {
		const maxCalls = filtered.reduce((max, r) => Math.max(max, r.calls), 0);
		return [
			{
				key: "tool",
				header: "Tool",
				sort: row => row.tool,
				render: row => (
					<span className="row" style={{ gap: 8 }}>
						<Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
						<span className="mono truncate tools-name" title={row.tool}>
							{row.tool}
						</span>
					</span>
				),
			},
			{
				key: "model",
				header: "Model",
				sort: row => row.model,
				render: row => (
					<LabelCell primary={<span className="mono">{row.model || "(unknown)"}</span>} secondary={row.provider} />
				),
			},
			{
				key: "calls",
				header: "Calls",
				align: "right",
				sort: row => row.calls,
				render: row => <MeterCell value={row.calls} max={maxCalls} display={formatInteger(row.calls)} />,
			},
			{
				key: "errorRate",
				header: "Errors",
				align: "right",
				sort: row => row.errorRate,
				render: row => (
					<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
						<span className="num dim">{formatInteger(row.errors)}</span>
						<Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
							{formatErrorRate(row.errorRate)}
						</Badge>
					</span>
				),
			},
			{
				key: "result",
				header: "Result",
				title: "Characters of tool-result text fed back into context",
				align: "right",
				sort: row => row.resultChars,
				render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
			},
			{
				key: "tokens",
				header: "Attr. tokens",
				title: ATTRIBUTION_NOTE,
				align: "right",
				sort: row => row.totalTokensShare,
				render: row => <span className="num">{formatCompact(Math.round(row.totalTokensShare))}</span>,
			},
			{
				key: "cost",
				header: "Attr. cost",
				title: `${ATTRIBUTION_NOTE}; API-equivalent estimate`,
				align: "right",
				sort: row => row.costShare,
				render: row => <span className="num">{formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}</span>,
			},
			{
				key: "lastUsed",
				header: "Last used",
				align: "right",
				sort: row => row.lastUsed,
				render: row => <span className="muted">{formatRelativeTime(row.lastUsed)}</span>,
			},
		];
	}, [filtered, colors]);

	return (
		<Table
			rows={filtered}
			rowKey={row => `${row.tool}::${row.model}::${row.provider}`}
			columns={columns}
			initialSort={{ key: "calls", dir: "desc" }}
			limit={25}
			dense
			empty={<EmptyState title={tool ? `No calls to ${tool} in this range` : "No tool calls in this range"} />}
		/>
	);
}
