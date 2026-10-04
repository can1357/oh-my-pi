import { format } from "@oh-my-pi/pi-utils/dates";
import { type ReactNode, useMemo, useState } from "react";
import { getProviderDashboardStats, getProviderWindowStats } from "../api";
import { Chart, type ChartSeries, Legend, ShareBar, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR, SERIES_COLORS } from "../data/colors";
import {
	formatCompact,
	formatCost,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
	formatTokensPerSecond,
} from "../data/formatters";
import { type QueryResult, useQuery } from "../data/query";
import { bucketAxis, formatBucket, formatTick, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import type {
	ProviderAggregate,
	ProviderHourlyPoint,
	ProviderWindowInsight,
	ProviderWindowStats,
	TimeRange,
	UsageWindowSeries,
} from "../types";
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
import "./providers.css";

export interface ProvidersRouteProps {
	active: boolean;
	range: TimeRange;
}

type BurnMetric = "tokens" | "cost" | "requests";

const BURN_OPTIONS = [
	{ value: "tokens" as const, label: "Tokens" },
	{ value: "cost" as const, label: "Cost", title: "API-equivalent estimate" },
	{ value: "requests" as const, label: "Requests" },
];

/** Providers stacked individually in the burn chart; the rest fold into "Other". */
const TOP_PROVIDERS = 6;

const TOKEN_MIX = [
	{ key: "input", label: "Uncached input", color: "#5b8cff" },
	{ key: "cacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "cacheWrite", label: "Cache write", color: "#f5b54a" },
	{ key: "output", label: "Output", color: "var(--chart-secondary)" },
] as const;

const SNAPSHOT_HINT = "Usage snapshots accumulate whenever usage limits are fetched (TUI footer, /usage, omp usage).";

interface WindowRef {
	provider: string;
	windowKey: string;
}

export function ProvidersRoute({ active, range }: ProvidersRouteProps) {
	const stats = useQuery(["providers", range], () => getProviderDashboardStats(range), { enabled: active });
	const [metric, setMetric] = useState<BurnMetric>("tokens");
	const [hidden, toggleHidden] = useHiddenSeries();
	const meta = rangeMeta(range);

	// Subscription windows load independently: insights for every provider
	// first, then utilization series for the one provider being charted.
	const windows = useQuery(["provider-windows", range], () => getProviderWindowStats(range, null), {
		enabled: active,
	});
	const [picked, setPicked] = useState<WindowRef | null>(null);
	const selected = resolveWindow(windows.data?.windowInsights ?? [], picked);
	const selectedProvider = selected?.provider ?? null;
	const accounts = useQuery(
		["provider-windows", range, selectedProvider],
		() => getProviderWindowStats(range, selectedProvider),
		{ enabled: active && selectedProvider !== null },
	);

	const view = useMemo(() => {
		const providers = stats.data?.providers ?? [];
		const points = stats.data?.series ?? [];
		const colors = buildColorLookup(providers.map(p => ({ key: p.provider, weight: p.totalTokens })));
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		const totals = { requests: 0, failed: 0, tokens: 0, cost: 0, unpriced: 0 };
		for (const p of providers) {
			totals.requests += p.totalRequests;
			totals.failed += p.failedRequests;
			totals.tokens += p.totalTokens;
			totals.cost += p.totalCost;
			totals.unpriced += p.unpricedRequests;
		}
		// Zero slots become gaps so the tooltip lists only providers active in that bucket.
		const pivot = (value: (p: (typeof points)[number]) => number) =>
			pivotSeries(points, { buckets, key: p => p.provider, value, limit: TOP_PROVIDERS, colors }).map(s => ({
				...s,
				values: s.values.map(v => v || null),
			}));
		return {
			colors,
			buckets,
			totals,
			burn: {
				tokens: pivot(p => p.totalTokens),
				cost: pivot(p => p.cost),
				requests: pivot(p => p.requests),
			} satisfies Record<BurnMetric, ChartSeries[]>,
			spark: {
				tokens: densify(points, buckets, p => p.totalTokens),
				cost: densify(points, buckets, p => p.cost),
				requests: densify(points, buckets, p => p.requests),
			},
			topProvider: providers.reduce<ProviderAggregate | null>(
				(top, p) => (top === null || p.totalTokens > top.totalTokens ? p : top),
				null,
			),
		};
	}, [stats.data, range]);

	const burnSeries = view.burn[metric];
	const burnFormat = metric === "cost" ? (v: number) => formatCost(v) : formatCompact;
	const t = view.totals;

	return (
		<div className="page">
			<PageHeader
				title="Providers"
				description={`Burn, reliability and subscription headroom per provider over ${meta.windowLabel}.`}
			/>

			<QueryView query={stats} skeleton={<ChartSkeleton height={112} />}>
				{({ providers }) => (
					<div data-stale={stats.stale}>
						<StatGrid min={190}>
							<Stat
								label="Providers"
								value={formatInteger(providers.length)}
								hint={view.topProvider ? `Most tokens: ${view.topProvider.provider}` : undefined}
							/>
							<Stat
								label="Requests"
								value={formatInteger(t.requests)}
								hint={`${formatInteger(t.failed)} failed`}
								spark={view.spark.requests}
							/>
							<Stat
								label="Tokens"
								title="Uncached input + cache reads + cache writes + output"
								value={formatCompact(t.tokens)}
								spark={view.spark.tokens}
							/>
							<Stat
								label="API-equivalent cost"
								title="What this usage would cost at public API rates"
								value={formatEstimatedCost(t.cost, t.unpriced)}
								hint={t.unpriced > 0 ? `${formatInteger(t.unpriced)} unpriced` : undefined}
								spark={view.spark.cost}
								sparkColor="var(--chart-secondary)"
							/>
							<Stat
								label="Error rate"
								value={formatErrorRate(t.requests > 0 ? t.failed / t.requests : 0)}
								hint={`${formatInteger(t.requests - t.failed)} succeeded`}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<Card
				index={1}
				title="Provider totals"
				description={
					t.unpriced > 0
						? `Cost is an API-equivalent estimate and excludes ${formatInteger(t.unpriced)} unpriced subscription request${t.unpriced === 1 ? "" : "s"}. Select a row for its token mix.`
						: "Cost is an API-equivalent estimate. Select a row for its token mix."
				}
				flush
				stale={stats.stale}
			>
				<QueryView query={stats} skeleton={<TableSkeleton rows={6} />}>
					{({ providers }) => <ProviderTotalsTable providers={providers} colors={view.colors} />}
				</QueryView>
			</Card>

			<div className="grid grid-main-side">
				<Card
					index={2}
					title="Burn by provider"
					description={
						metric === "cost" && t.unpriced > 0
							? `API-equivalent estimate per ${meta.bucketMs < 86_400_000 ? "hour" : "day"}; excludes unpriced subscription requests`
							: `Per ${meta.bucketMs < 3_600_000 ? "5 minutes" : meta.bucketMs < 86_400_000 ? "hour" : "day"}, top ${TOP_PROVIDERS} providers stacked`
					}
					actions={<Segmented size="sm" options={BURN_OPTIONS} value={metric} onChange={setMetric} />}
					stale={stats.stale}
				>
					<QueryView query={stats} skeleton={<ChartSkeleton height={260} />}>
						{() => (
							<div className="stack" style={{ gap: 12 }}>
								<TimeChart
									buckets={view.buckets}
									bucketMs={meta.bucketMs}
									series={burnSeries}
									hidden={hidden}
									height={260}
									format={burnFormat}
									formatTooltip={metric === "cost" ? v => formatCost(v) : formatInteger}
									emptyLabel="No provider activity in this range"
								/>
								<Legend
									items={burnSeries.map(s => ({
										key: s.key,
										label: s.label,
										color: s.color,
										value: burnFormat(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
									}))}
									hidden={hidden}
									onToggle={toggleHidden}
								/>
							</div>
						)}
					</QueryView>
				</Card>

				<QueryView query={stats} skeleton={<ChartSkeleton height={320} />}>
					{({ hourly, providers }) => <PeakHoursCard hourly={hourly} providers={providers} stale={stats.stale} />}
				</QueryView>
			</div>

			<Card
				index={4}
				title="Subscription windows"
				description="What one usage window buys you and how many accounts peak demand needs. Select a row to chart it."
				flush
				stale={windows.stale}
			>
				<QueryView query={windows} skeleton={<TableSkeleton rows={6} />}>
					{data => <WindowInsightsTable insights={data.windowInsights} selected={selected} onSelect={setPicked} />}
				</QueryView>
			</Card>

			<WindowUtilizationCard
				insights={windows.data?.windowInsights ?? null}
				accounts={accounts}
				selected={selected}
				onSelect={setPicked}
			/>
		</div>
	);
}

/**
 * The window charted below the insights table: the user's pick when it still
 * exists, else the first window of the picked provider, else the most-burned
 * window (the insights table's first row).
 */
function resolveWindow(insights: readonly ProviderWindowInsight[], picked: WindowRef | null): WindowRef | null {
	if (picked && insights.some(i => i.provider === picked.provider && i.windowKey === picked.windowKey)) return picked;
	const fallback =
		(picked && insights.find(i => i.provider === picked.provider)) ||
		insights.reduce<ProviderWindowInsight | undefined>(
			(top, i) => (top === undefined || i.fractionConsumed > top.fractionConsumed ? i : top),
			undefined,
		);
	return fallback ? { provider: fallback.provider, windowKey: fallback.windowKey } : null;
}

// ---------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------

function ProviderTotalsTable({
	providers,
	colors,
}: {
	providers: ProviderAggregate[];
	colors: ReadonlyMap<string, string>;
}) {
	const [open, setOpen] = useState<string | null>(null);
	const columns = useMemo<Column<ProviderAggregate>[]>(() => {
		let maxRequests = 0;
		let maxTokens = 0;
		let grandTokens = 0;
		for (const p of providers) {
			maxRequests = Math.max(maxRequests, p.totalRequests);
			maxTokens = Math.max(maxTokens, p.totalTokens);
			grandTokens += p.totalTokens;
		}
		return [
			{
				key: "provider",
				header: "Provider",
				sort: p => p.provider,
				render: p => (
					<span className="row" style={{ gap: 8 }}>
						<Swatch color={colors.get(p.provider) ?? OTHER_COLOR} />
						<span className="mono cell-primary">{p.provider}</span>
					</span>
				),
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				sort: p => p.totalRequests,
				render: p => (
					<MeterCell value={p.totalRequests} max={maxRequests} display={formatInteger(p.totalRequests)} />
				),
			},
			{
				key: "errors",
				header: "Error rate",
				align: "right",
				sort: p => (p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0),
				render: p => {
					const rate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
					return (
						<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
							<span className="num dim">{formatInteger(p.failedRequests)}</span>
							<Badge tone={p.failedRequests > 0 ? errorRateTone(rate) : "neutral"} mono>
								{formatErrorRate(rate)}
							</Badge>
						</span>
					);
				},
			},
			{
				key: "models",
				header: "Models",
				title: "Distinct models used through this provider",
				align: "right",
				sort: p => p.models,
				render: p => <span className="num">{formatInteger(p.models)}</span>,
			},
			{
				key: "tokens",
				header: "Tokens",
				title: "Uncached input + cache reads + cache writes + output",
				align: "right",
				sort: p => p.totalTokens,
				render: p => (
					<MeterCell
						value={p.totalTokens}
						max={maxTokens}
						display={formatCompact(p.totalTokens)}
						color={colors.get(p.provider)}
					/>
				),
			},
			{
				key: "share",
				header: "Share",
				title: "Fraction of all tokens in range",
				align: "right",
				sort: p => p.totalTokens,
				render: p => (
					<span className="num muted">{formatPercent(grandTokens > 0 ? p.totalTokens / grandTokens : 0)}</span>
				),
			},
			{
				key: "cost",
				header: "Cost",
				title: "API-equivalent estimate",
				align: "right",
				sort: p => p.totalCost,
				render: p => (
					<span
						className="num"
						title={p.unpricedRequests > 0 ? `${formatInteger(p.unpricedRequests)} unpriced` : undefined}
					>
						{formatEstimatedCost(p.totalCost, p.unpricedRequests)}
					</span>
				),
			},
			{
				key: "tps",
				header: "Tokens/s",
				title: "Average output throughput",
				align: "right",
				sort: p => p.avgTokensPerSecond ?? -1,
				render: p => <span className="num">{formatTokensPerSecond(p.avgTokensPerSecond)}</span>,
			},
			{
				key: "premium",
				header: "Premium",
				title: "Premium requests (subscription multiplier units)",
				align: "right",
				sort: p => p.totalPremiumRequests,
				render: p => (
					<span className={p.totalPremiumRequests > 0 ? "num" : "num dim"}>
						{formatInteger(Math.round(p.totalPremiumRequests * 100) / 100)}
					</span>
				),
			},
		];
	}, [providers, colors]);

	return (
		<Table
			rows={providers}
			rowKey={p => p.provider}
			columns={columns}
			initialSort={{ key: "tokens", dir: "desc" }}
			limit={12}
			selectedKey={open}
			onRowClick={p => setOpen(prev => (prev === p.provider ? null : p.provider))}
			expanded={p => (p.provider === open ? <TokenMix provider={p} /> : null)}
			empty={<EmptyState title="No requests in this range" />}
		/>
	);
}

function TokenMix({ provider }: { provider: ProviderAggregate }) {
	const mix = {
		input: provider.totalInputTokens,
		cacheRead: provider.totalCacheReadTokens,
		cacheWrite: provider.totalCacheWriteTokens,
		output: provider.totalOutputTokens,
	};
	return (
		<div className="providers-mix">
			<ShareBar segments={TOKEN_MIX.map(m => ({ key: m.key, label: m.label, value: mix[m.key], color: m.color }))} />
			<Legend
				items={TOKEN_MIX.map(m => ({
					key: m.key,
					label: m.label,
					color: m.color,
					value: `${formatCompact(mix[m.key])} · ${provider.totalTokens > 0 ? formatPercent(mix[m.key] / provider.totalTokens, 0) : "–"}`,
				}))}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Peak burn hours
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = "";

function PeakHoursCard({
	hourly,
	providers,
	stale,
}: {
	hourly: ProviderHourlyPoint[];
	providers: ProviderAggregate[];
	stale: boolean;
}) {
	const [provider, setProvider] = useState(ALL_PROVIDERS);
	const current =
		provider === ALL_PROVIDERS || providers.some(p => p.provider === provider) ? provider : ALL_PROVIDERS;

	const hours = useMemo(() => {
		const tokens = Array.from({ length: 24 }, () => 0);
		const output = Array.from({ length: 24 }, () => 0);
		const requests = Array.from({ length: 24 }, () => 0);
		for (const point of hourly) {
			if (current !== ALL_PROVIDERS && point.provider !== current) continue;
			tokens[point.hour] += point.totalTokens;
			output[point.hour] += point.outputTokens;
			requests[point.hour] += point.requests;
		}
		let peak = 0;
		for (let hour = 1; hour < 24; hour++) if (tokens[hour] > tokens[peak]) peak = hour;
		const hasData = tokens[peak] > 0;
		const series: ChartSeries[] = [
			{
				key: "tokens",
				label: "Tokens",
				color: "var(--chart-primary)",
				values: tokens.map((v, hour) => (hasData && hour === peak ? null : v)),
			},
			{
				key: "peak",
				label: "Tokens (peak hour)",
				color: "var(--chart-secondary)",
				values: tokens.map((v, hour) => (hasData && hour === peak ? v : null)),
			},
		];
		return { series, output, requests, peak, hasData };
	}, [hourly, current]);

	const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

	return (
		<Card
			index={3}
			title="Peak burn hours"
			description={
				hours.hasData
					? `Tokens by local hour of day; peak at ${hourLabel(hours.peak)}`
					: "Tokens by local hour of day"
			}
			actions={
				<select
					className="input providers-select"
					value={current}
					onChange={e => setProvider(e.target.value)}
					aria-label="Provider"
				>
					<option value={ALL_PROVIDERS}>All providers</option>
					{providers.map(p => (
						<option key={p.provider} value={p.provider}>
							{p.provider}
						</option>
					))}
				</select>
			}
			stale={stale}
		>
			<Chart
				slots={24}
				tickLabel={hour => String(hour).padStart(2, "0")}
				tooltipTitle={hour => `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`}
				series={hours.series}
				height={260}
				showTotal={false}
				formatTooltip={formatInteger}
				emptyLabel="No activity in this range"
				tooltipExtra={hour => (
					<>
						<div className="chart-tooltip-row">
							<span className="chart-tooltip-label">Output</span>
							<span className="chart-tooltip-value">{formatInteger(hours.output[hour])}</span>
						</div>
						<div className="chart-tooltip-row">
							<span className="chart-tooltip-label">Requests</span>
							<span className="chart-tooltip-value">{formatInteger(hours.requests[hour])}</span>
						</div>
					</>
				)}
			/>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Subscription window insights
// ---------------------------------------------------------------------------

function WindowInsightsTable({
	insights,
	selected,
	onSelect,
}: {
	insights: ProviderWindowInsight[];
	selected: WindowRef | null;
	onSelect: (ref: WindowRef) => void;
}) {
	return (
		<Table
			rows={insights}
			rowKey={i => `${i.provider}::${i.windowKey}`}
			columns={INSIGHT_COLUMNS}
			initialSort={{ key: "consumed", dir: "desc" }}
			limit={12}
			selectedKey={selected ? `${selected.provider}::${selected.windowKey}` : null}
			onRowClick={i => onSelect({ provider: i.provider, windowKey: i.windowKey })}
			empty={<EmptyState title="No usage snapshots in this range" hint={SNAPSHOT_HINT} />}
		/>
	);
}

const INSIGHT_COLUMNS: Column<ProviderWindowInsight>[] = [
	{
		key: "window",
		header: "Window",
		sort: i => `${i.provider} ${i.windowLabel}`,
		render: i => <LabelCell primary={i.windowLabel} secondary={<span className="mono">{i.provider}</span>} />,
	},
	{
		key: "accounts",
		header: "Accounts",
		title: "Accounts with at least one snapshot for this window in range",
		align: "right",
		sort: i => i.accounts,
		render: i => <span className="num">{formatInteger(i.accounts)}</span>,
	},
	{
		key: "cycles",
		header: "Resets",
		title: "Window resets observed (drops in used fraction)",
		align: "right",
		sort: i => i.cycles,
		render: i => <span className="num muted">{formatInteger(i.cycles)}</span>,
	},
	{
		key: "consumed",
		header: "Windows burned",
		title: "Subscription-window equivalents consumed in range (sum of used-fraction increases across accounts)",
		align: "right",
		sort: i => i.fractionConsumed,
		render: i => <span className="num">{i.fractionConsumed.toFixed(2)}</span>,
	},
	{
		key: "capacity",
		header: "Tokens / window",
		title: "Provider tokens burned in range ÷ windows burned — what one full window is worth",
		align: "right",
		sort: i => i.estTokensPerWindow ?? -1,
		render: i =>
			i.estTokensPerWindow !== null ? (
				<span className="num">{formatCompact(i.estTokensPerWindow)}</span>
			) : (
				<span className="dim" title="Too little of the window was consumed to extrapolate">
					–
				</span>
			),
	},
	{
		key: "peak",
		header: "Peak utilization",
		title: "Peak of summed used fraction across accounts at any sampled instant; the bar is relative to fleet capacity",
		align: "right",
		sort: i => i.peakConcurrentFraction,
		render: i => {
			const load = i.accounts > 0 ? i.peakConcurrentFraction / i.accounts : 0;
			return (
				<MeterCell
					value={i.peakConcurrentFraction}
					max={i.accounts}
					display={formatPercent(i.peakConcurrentFraction, 0)}
					color={load >= 0.9 ? "var(--warn)" : undefined}
				/>
			);
		},
	},
	{
		key: "ideal",
		header: "Accounts needed",
		title: "Accounts needed to keep peak demand under 90% of fleet capacity",
		align: "right",
		sort: i => i.idealAccounts - i.accounts,
		render: i =>
			i.idealAccounts > i.accounts ? (
				<Badge tone="warn" mono>
					{formatInteger(i.idealAccounts)} · have {formatInteger(i.accounts)}
				</Badge>
			) : (
				<span className="num">{formatInteger(i.idealAccounts)}</span>
			),
	},
	{
		key: "exhausted",
		header: "Exhaustions",
		title: "Transitions into an exhausted state observed in range",
		align: "right",
		sort: i => i.exhaustedEvents,
		render: i =>
			i.exhaustedEvents > 0 ? (
				<Badge tone="warn" mono>
					{formatInteger(i.exhaustedEvents)} exhausted
				</Badge>
			) : (
				<span className="num dim">0</span>
			),
	},
];

// ---------------------------------------------------------------------------
// Window utilization
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Candidate utilization bucket sizes; the finest one within {@link MAX_UTIL_SLOTS} wins. */
const UTIL_STEPS = [
	5 * MINUTE_MS,
	15 * MINUTE_MS,
	30 * MINUTE_MS,
	HOUR_MS,
	2 * HOUR_MS,
	3 * HOUR_MS,
	6 * HOUR_MS,
	12 * HOUR_MS,
	DAY_MS,
];
const MAX_UTIL_SLOTS = 240;
/**
 * Snapshots are recorded whenever usage is fetched, so an account's samples
 * are irregular. A reading holds until the next one, but only this long —
 * longer silences render as gaps rather than invented plateaus.
 */
const MAX_HOLD_MS = 6 * HOUR_MS;

interface AccountRow {
	series: UsageWindowSeries;
	/** Account label, numbered when another account shares it. */
	name: string;
	color: string | null;
	latest: { fraction: number; exhausted: boolean; timestamp: number } | null;
	peak: number | null;
	samples: number;
}

function WindowUtilizationCard({
	insights,
	accounts,
	selected,
	onSelect,
}: {
	/** Every provider's window insights; `null` while they load. */
	insights: ProviderWindowInsight[] | null;
	/** Window stats whose `usageSeries` covers only the selected provider. */
	accounts: QueryResult<ProviderWindowStats>;
	selected: WindowRef | null;
	onSelect: (ref: WindowRef) => void;
}) {
	const [hidden, toggleHidden] = useHiddenSeries();

	const providers = useMemo(() => [...new Set((insights ?? []).map(i => i.provider))], [insights]);
	const windows = useMemo(
		() =>
			(insights ?? [])
				.filter(i => i.provider === selected?.provider)
				.map(i => ({ key: i.windowKey, label: i.windowLabel })),
		[insights, selected?.provider],
	);
	// While another provider's series are still on screen, show none of them.
	const providerSeries = useMemo(
		() => (accounts.data?.usageSeries ?? []).filter(s => s.provider === selected?.provider),
		[accounts.data, selected?.provider],
	);
	const loadingSeries = providerSeries.length === 0 && (accounts.loading || accounts.stale);

	// Distinct accounts can share a label (one email in two orgs): number the repeats.
	const names = useMemo(() => {
		const keysByLabel = new Map<string, string[]>();
		for (const s of providerSeries) {
			const keys = keysByLabel.get(s.accountLabel) ?? [];
			if (!keys.includes(s.accountKey)) keys.push(s.accountKey);
			keysByLabel.set(s.accountLabel, keys);
		}
		const out = new Map<string, string>();
		for (const [label, keys] of keysByLabel) {
			keys.sort();
			keys.forEach((key, i) => out.set(key, keys.length > 1 ? `${label} #${i + 1}` : label));
		}
		return out;
	}, [providerSeries]);

	const chart = useMemo(
		() =>
			buildUtilization(
				providerSeries.filter(s => s.windowKey === selected?.windowKey),
				names,
			),
		[providerSeries, names, selected?.windowKey],
	);

	const rows = useMemo<AccountRow[]>(() => {
		const colorOf = new Map(chart.series.map(s => [s.key, s.color]));
		return providerSeries
			.map(series => {
				let latest: AccountRow["latest"] = null;
				let peak: number | null = null;
				for (const p of series.points) {
					if (p.usedFraction === null) continue;
					peak = Math.max(peak ?? 0, p.usedFraction);
					if (!latest || p.timestamp >= latest.timestamp)
						latest = { fraction: p.usedFraction, exhausted: p.exhausted, timestamp: p.timestamp };
				}
				const color = series.windowKey === selected?.windowKey ? (colorOf.get(series.accountKey) ?? null) : null;
				const name = names.get(series.accountKey) ?? series.accountLabel;
				return { series, name, color, latest, peak, samples: series.points.length };
			})
			.sort(
				(a, b) =>
					Number(b.color !== null) - Number(a.color !== null) ||
					a.series.windowLabel.localeCompare(b.series.windowLabel) ||
					(b.latest?.fraction ?? -1) - (a.latest?.fraction ?? -1),
			);
	}, [providerSeries, names, chart.series, selected?.windowKey]);

	const windowLabel = windows.find(w => w.key === selected?.windowKey)?.label;

	return (
		<Card
			index={5}
			title="Window utilization"
			description={
				chart.buckets.length > 0
					? `${windowLabel ?? "Window"} used fraction per account, ${format(new Date(chart.first), "MMM d HH:mm")} – ${format(new Date(chart.last), "MMM d HH:mm")}`
					: "Recorded limit utilization per account"
			}
			actions={
				selected && (
					<div className="row" style={{ gap: 6 }}>
						<select
							className="input providers-select"
							value={selected.provider}
							onChange={e => {
								const next = e.target.value;
								const first = insights?.find(i => i.provider === next);
								if (first) onSelect({ provider: next, windowKey: first.windowKey });
							}}
							aria-label="Provider"
						>
							{providers.map(p => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
						<select
							className="input providers-select"
							value={selected.windowKey}
							onChange={e => onSelect({ provider: selected.provider, windowKey: e.target.value })}
							aria-label="Window"
						>
							{windows.map(w => (
								<option key={w.key} value={w.key}>
									{w.label}
								</option>
							))}
						</select>
					</div>
				)
			}
			stale={accounts.stale}
		>
			{insights === null ? (
				<ChartSkeleton height={260} />
			) : selected === null ? (
				<EmptyState title="No usage snapshots in this range" hint={SNAPSHOT_HINT} />
			) : (
				<QueryView query={accounts} skeleton={<ChartSkeleton height={260} />}>
					{() =>
						loadingSeries ? (
							<ChartSkeleton height={260} />
						) : (
							<div className="stack" style={{ gap: 16 }}>
								<div className="stack" style={{ gap: 12 }}>
									<Chart
										slots={chart.buckets.length}
										tickLabel={i =>
											formatTick(
												chart.buckets[i],
												chart.last - chart.first > DAY_MS ? DAY_MS : chart.bucketMs,
											)
										}
										tooltipTitle={i => formatBucket(chart.buckets[i], HOUR_MS)}
										series={chart.series}
										hidden={hidden}
										kind="line"
										stacked={false}
										height={260}
										yMax={Math.max(1, chart.max)}
										format={v => formatPercent(v, 0)}
										formatTooltip={v => formatPercent(v, 1)}
										references={[{ value: 1, label: "100%" }]}
										emptyLabel="No utilization readings for this window"
										tooltipExtra={i => {
											const exhausted = chart.exhausted[i];
											return exhausted.length > 0 ? (
												<div className="chart-tooltip-row">
													<span className="chart-tooltip-label tone-bad">Exhausted</span>
													<span className="chart-tooltip-value">{exhausted.join(", ")}</span>
												</div>
											) : null;
										}}
									/>
									{chart.series.length > 1 && (
										<Legend
											items={chart.series.map(s => ({ key: s.key, label: s.label, color: s.color }))}
											hidden={hidden}
											onToggle={toggleHidden}
										/>
									)}
								</div>
								<div className="providers-accounts">
									<Table
										rows={rows}
										rowKey={r => `${r.series.windowKey}::${r.series.accountKey}`}
										columns={ACCOUNT_COLUMNS}
										limit={16}
										onRowClick={r => onSelect({ provider: r.series.provider, windowKey: r.series.windowKey })}
										dense
									/>
								</div>
							</div>
						)
					}
				</QueryView>
			)}
		</Card>
	);
}

interface UtilizationChart {
	buckets: number[];
	bucketMs: number;
	first: number;
	last: number;
	max: number;
	series: ChartSeries[];
	/** Accounts seen exhausted per bucket. */
	exhausted: string[][];
}

/** One line per account over a shared axis spanning the window's recorded snapshots. */
function buildUtilization(accounts: UsageWindowSeries[], names: ReadonlyMap<string, string>): UtilizationChart {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const s of accounts) {
		for (const p of s.points) {
			if (p.timestamp < first) first = p.timestamp;
			if (p.timestamp > last) last = p.timestamp;
		}
	}
	if (!(last >= first))
		return { buckets: [], bucketMs: HOUR_MS, first: 0, last: 0, max: 0, series: [], exhausted: [] };

	const span = last - first;
	const bucketMs = UTIL_STEPS.find(step => span / step < MAX_UTIL_SLOTS) ?? DAY_MS;
	const buckets = bucketAxis("all", [first], bucketMs, last);
	const index = (ts: number) => Math.floor((ts - buckets[0]) / bucketMs);
	const exhausted = buckets.map((): string[] => []);
	let max = 0;

	const nameOf = (account: UsageWindowSeries) => names.get(account.accountKey) ?? account.accountLabel;
	const ordered = [...accounts].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
	const series = ordered.map((account, rank): ChartSeries => {
		// Last reading in each bucket, then hold it forward across short silences.
		const values: (number | null)[] = buckets.map(() => null);
		const readAt: number[] = buckets.map(() => 0);
		for (const p of account.points) {
			const i = index(p.timestamp);
			if (i < 0 || i >= buckets.length) continue;
			if (p.exhausted && !exhausted[i].includes(nameOf(account))) exhausted[i].push(nameOf(account));
			if (p.usedFraction === null || p.timestamp < readAt[i]) continue;
			values[i] = p.usedFraction;
			readAt[i] = p.timestamp;
			max = Math.max(max, p.usedFraction);
		}
		let held: number | null = null;
		let heldAt = 0;
		for (let i = 0; i < buckets.length; i++) {
			if (values[i] !== null) {
				held = values[i];
				heldAt = readAt[i];
			} else if (held !== null && buckets[i] - heldAt <= MAX_HOLD_MS) {
				values[i] = held;
			}
		}
		return {
			key: account.accountKey,
			label: nameOf(account),
			color: SERIES_COLORS[rank % SERIES_COLORS.length],
			values,
		};
	});

	return { buckets, bucketMs, first, last, max, series, exhausted };
}

function statusBadge(latest: AccountRow["latest"]): ReactNode {
	if (!latest) return <span className="dim">No reading</span>;
	if (latest.exhausted) return <Badge tone="bad">Exhausted</Badge>;
	if (latest.fraction >= 0.8) return <Badge tone="warn">High</Badge>;
	return <Badge tone="ok">OK</Badge>;
}

const ACCOUNT_COLUMNS: Column<AccountRow>[] = [
	{
		key: "account",
		header: "Account",
		sort: r => r.name,
		render: r => (
			<span className="row" style={{ gap: 8 }}>
				<span className="providers-swatch-slot">{r.color && <Swatch color={r.color} />}</span>
				<span className="truncate providers-account" title={r.series.accountKey}>
					{r.name}
				</span>
			</span>
		),
	},
	{
		key: "window",
		header: "Window",
		sort: r => r.series.windowLabel,
		render: r => <span className={r.color ? undefined : "muted"}>{r.series.windowLabel}</span>,
	},
	{
		key: "latest",
		header: "Latest used",
		align: "right",
		sort: r => r.latest?.fraction ?? -1,
		render: r =>
			r.latest ? (
				<MeterCell
					value={r.latest.fraction}
					max={1}
					display={formatPercent(r.latest.fraction, 0)}
					color={r.latest.exhausted ? "var(--bad)" : r.latest.fraction >= 0.8 ? "var(--warn)" : "var(--ok)"}
				/>
			) : (
				<span className="dim">–</span>
			),
	},
	{
		key: "status",
		header: "Status",
		sort: r => (r.latest?.exhausted ? 2 : (r.latest?.fraction ?? 0) >= 0.8 ? 1 : 0),
		render: r => statusBadge(r.latest),
	},
	{
		key: "peak",
		header: "Peak in range",
		align: "right",
		sort: r => r.peak ?? -1,
		render: r => <span className="num">{r.peak === null ? "–" : formatPercent(r.peak, 0)}</span>,
	},
	{
		key: "samples",
		header: "Snapshots",
		align: "right",
		sort: r => r.samples,
		render: r => <span className="num muted">{formatInteger(r.samples)}</span>,
	},
	{
		key: "recorded",
		header: "Recorded",
		align: "right",
		sort: r => r.latest?.timestamp ?? 0,
		render: r => <span className="muted">{r.latest ? formatRelativeTime(r.latest.timestamp) : "–"}</span>,
	},
];
