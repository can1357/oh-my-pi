import { useMemo, useState } from "react";
import { type ChartSeries, Legend, TimeChart, Waterfall, type WaterfallStep } from "../charts";
import { formatCompact, formatCost, formatInteger } from "../data/formatters";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { SpotlightAdjustedTool, SpotlightDashboardStats, SpotlightToolRow, TimeRange } from "../types";
import { Card, Segmented } from "../ui";
import {
	bucketNoun,
	formatInterval,
	formatShare,
	formatSignedCompact,
	formatSignedCost,
	foldTools,
	OTHER_TOOLS,
	RECOVERY_KIND,
	RECOVERY_KINDS,
	toolIcon,
} from "./meta";

type Unit = "tokens" | "usd";

const UNIT_OPTIONS = [
	{ value: "tokens", label: "Tokens" },
	{ value: "usd", label: "$" },
] as const;

function UnitToggle({ value, onChange }: { value: Unit; onChange: (unit: Unit) => void }) {
	return <Segmented size="sm" aria-label="Unit" options={UNIT_OPTIONS} value={value} onChange={onChange} />;
}

export interface SavingsProps {
	stats: SpotlightDashboardStats;
	range: TimeRange;
	stale: boolean;
}

/** Cumulative gross vs net per bucket, with what recoveries took back hanging below zero. */
export function SavingsOverTime({ stats, range, stale }: SavingsProps) {
	const [unit, setUnit] = useState<Unit>("tokens");
	const meta = rangeMeta(range);

	const chart = useMemo(() => {
		const buckets = bucketAxis(
			range,
			stats.series.map(b => b.timestamp),
			meta.bucketMs,
		);
		const usd = unit === "usd";
		const saved = densify(stats.series, buckets, b => (usd ? b.savedUsd : b.savedTokens));
		const net = densify(stats.series, buckets, b => (usd ? b.netUsd : b.netTokens));
		let grossRun = 0;
		let netRun = 0;
		const series: ChartSeries[] = [
			{
				key: "gross",
				label: "Gross (cumulative)",
				color: "var(--spot-gross)",
				kind: "area",
				values: saved.map(v => (grossRun += v)),
			},
			{
				key: "clawback",
				label: usd ? "Recoveries + Spotlight cost" : "Fetched back",
				color: "var(--spot-clawback)",
				kind: "bars",
				values: saved.map((v, i) => net[i] - v),
			},
			{
				key: "net",
				label: "Net of every fetch-back (cumulative)",
				color: "var(--spot-net)",
				kind: "line",
				values: net.map(v => (netRun += v)),
			},
		];
		return { buckets, series };
	}, [stats.series, range, meta.bucketMs, unit]);

	const format = unit === "usd" ? formatSignedCost : formatSignedCompact;
	return (
		<Card
			index={1}
			title="Savings over time"
			description={`Running gross and net per ${bucketNoun(meta.bucketMs)}; what recoveries took back hangs below zero`}
			actions={<UnitToggle value={unit} onChange={setUnit} />}
			stale={stale}
			footer={
				unit === "usd"
					? "Dollars price each saved token at the cache-read rate of every later request that would have carried it (plus one cache write); recoveries are priced the same way."
					: "Gross is what the cuts removed against what plain would have shown; this net subtracts every later call that fetched hidden output back, including the share held-out results show comes back anyway (the headline adds that back). Each lands in the bucket of its own timestamp."
			}
		>
			<div className="spot-chart-legend">
				<Legend items={chart.series.map(s => ({ key: s.key, label: s.label, color: s.color }))} />
			</div>
			<TimeChart
				buckets={chart.buckets}
				bucketMs={meta.bucketMs}
				series={chart.series}
				stacked={false}
				// Tall enough to sit level with the bridge and per-tool list beside it.
				height={480}
				format={format}
				formatTooltip={
					unit === "usd" ? formatSignedCost : v => (v < 0 ? `−${formatInteger(-v)}` : formatInteger(v))
				}
				showTotal={false}
				emptyLabel="No shortened results in this range"
			/>
		</Card>
	);
}

/** Bridge from gross to the holdout-adjusted net: every way the saving was undone, and what would have come back anyway. */
export function WhereSavingsWent({ stats, stale }: Omit<SavingsProps, "range">) {
	const [unit, setUnit] = useState<Unit>("tokens");
	const { gross, clawback, compounding, adjusted } = stats;

	const steps = useMemo((): WaterfallStep[] => {
		const usd = unit === "usd";
		const top = usd ? compounding.savedUsd : gross.savedTokens;
		const share = (v: number) => (top > 0 ? formatShare(v / top) : "");
		const kindSteps = RECOVERY_KINDS.map((kind): WaterfallStep => {
			const totals = clawback.byKind[kind];
			const value = usd ? totals.usd : totals.tokens;
			return {
				key: kind,
				label: (
					<>
						<span className="spot-step-swatch" style={{ background: RECOVERY_KIND[kind].color }} />
						{RECOVERY_KIND[kind].plural}
						<span className="dim num">{formatInteger(totals.events)}</span>
					</>
				),
				kind: "delta",
				value: -value,
				color: RECOVERY_KIND[kind].color,
				note: share(value),
				title: RECOVERY_KIND[kind].rule,
			};
		});
		const steps: WaterfallStep[] = [
			{
				key: "gross",
				label: usd ? "Gross saved" : "Gross vs plain",
				kind: "total",
				value: top,
				color: "var(--spot-gross)",
				title: usd
					? "Avoided context priced at each later request's cache-read rate, plus one cache write"
					: "Σ (plain − shortened) tokens over shortened results; a cut that showed more than plain counts negative",
			},
			...kindSteps,
		];
		if (usd) {
			steps.push(
				{
					key: "turns",
					label: (
						<>
							<span className="spot-step-swatch" style={{ background: "var(--spot-turns)" }} />
							Extra turns
							<span className="dim num">{formatInteger(clawback.turns)}</span>
						</>
					),
					kind: "delta",
					value: -clawback.turnsUsd,
					color: "var(--spot-turns)",
					note: share(clawback.turnsUsd),
					title: "Provider cost of requests that issued nothing but recovery calls",
				},
				{
					key: "spotlight",
					label: (
						<>
							<span className="spot-step-swatch" style={{ background: "var(--spot-cost)" }} />
							Spotlight cost
						</>
					),
					kind: "delta",
					value: -compounding.spotlightUsd,
					color: "var(--spot-cost)",
					note: share(compounding.spotlightUsd),
					title: "Spotlight's own scoring bill",
				},
			);
		}
		// Without holdouts there is no baseline to add back: the net is unadjusted.
		const unadjusted = usd ? compounding.netUsd : clawback.netTokens;
		const adjustedNet = usd ? adjusted.netUsd.value : adjusted.netTokens.value;
		if (adjustedNet !== null) {
			const anyway = adjustedNet - unadjusted;
			steps.push({
				key: "anyway",
				label: (
					<>
						<span className="spot-step-swatch" style={{ background: "var(--spot-anyway)" }} />
						Back anyway
					</>
				),
				kind: "delta",
				value: anyway,
				color: "var(--spot-anyway)",
				note: share(anyway),
				title: "Fetch-backs held-out results (shown whole) show the agent makes regardless, per tool: not the cut's cost",
			});
		}
		const net = adjustedNet ?? unadjusted;
		steps.push({
			key: "net",
			label: adjustedNet === null ? "Net (no holdout baseline yet)" : "Net",
			kind: "total",
			value: net,
			color: "var(--spot-net-fill)",
			note: share(net),
		});
		return steps;
	}, [unit, gross, clawback, compounding, adjusted]);

	return (
		<Card
			index={2}
			title="Where the savings went"
			description="Gross, minus each way hidden output came back"
			actions={<UnitToggle value={unit} onChange={setUnit} />}
			stale={stale}
			footer={
				unit === "usd"
					? "Recoveries are priced as carried context; extra turns are requests that only recovered; Spotlight cost is its own scoring bill. What comes back anyway is the recovery $ in proportion to the tokens held-out results fetch regardless."
					: "Recovered tokens are the full results of the recovery calls (estimated as chars ÷ 4 where no exact count exists). What comes back anyway is, per tool, the tokens a held-out result gets fetched back times the tool's cuts."
			}
		>
			<Waterfall steps={steps} format={unit === "usd" ? formatCost : formatCompact} />
			<div className="spot-by-tool">
				<div className="section-label">Net by tool, tokens</div>
				<ToolNetList byTool={gross.byTool} adjusted={adjusted.byTool} />
			</div>
		</Card>
	);
}

/** Tools the net-by-tool list names before folding the rest into `other`. */
const NET_LIST_TOOLS = 3;

/** One row of the net-by-tool list: a tool, or the folded rest summed. */
interface ToolNetRow {
	tool: string;
	totals: SpotlightToolRow;
	excess: number | null;
	title: string | undefined;
}

/**
 * Each tool's gross as a bar, its fetch-back beyond the holdout baseline hatched off the end: what is left solid is the
 * tool's net. The top tools by saving are listed; the rest fold into one `other` row.
 */
function ToolNetList({
	byTool,
	adjusted,
}: {
	byTool: readonly SpotlightToolRow[];
	adjusted: readonly SpotlightAdjustedTool[];
}) {
	const adjustedByTool = new Map(adjusted.map(row => [row.tool, row]));
	// Fewer rows than other cards: the list sits under the waterfall, beside the savings chart it should not outgrow.
	const { listed, rest } = foldTools(byTool, NET_LIST_TOOLS);
	const rows: ToolNetRow[] = listed.map(totals => {
		const row = adjustedByTool.get(totals.tool);
		const excessInterval = row === undefined ? "" : formatInterval(row.excessTokens, formatCompact);
		const baseline = row?.baselinePerCut.value ?? null;
		return {
			tool: totals.tool,
			totals,
			excess: row?.excessTokens.value ?? null,
			title:
				row === undefined
					? undefined
					: [
							`${formatInteger(row.cuts)} cuts fetched back ${formatCompact(row.recoveredTokens)} tokens`,
							baseline === null
								? "No held-out baseline yet"
								: `${formatInteger(row.holdouts)} held-out results get ${formatCompact(baseline)} each fetched back anyway`,
							excessInterval === "" ? "" : `Beyond the baseline: ${excessInterval} (90%)`,
						]
							.filter(Boolean)
							.join("\n"),
		};
	});
	if (rest.length > 0) {
		const totals: SpotlightToolRow = {
			tool: OTHER_TOOLS,
			results: 0,
			shaped: 0,
			inTokens: 0,
			plainTokens: 0,
			outTokens: 0,
			savedTokens: 0,
			fullSavedTokens: 0,
		};
		let excess: number | null = null;
		for (const row of rest) {
			totals.results += row.results;
			totals.shaped += row.shaped;
			totals.savedTokens += row.savedTokens;
			const own = adjustedByTool.get(row.tool)?.excessTokens.value ?? null;
			if (own !== null) excess = (excess ?? 0) + own;
		}
		rows.push({
			tool: OTHER_TOOLS,
			totals,
			excess,
			title: `${formatInteger(rest.length)} more tools: ${rest.map(row => row.tool).join(", ")}`,
		});
	}
	const top = Math.max(0, ...rows.map(row => row.totals.savedTokens));
	return (
		<ul className="spot-tool-net">
			{rows.map(({ tool, totals, excess, title }) => {
				const net = excess === null ? null : totals.savedTokens - excess;
				const Icon = toolIcon(tool);
				// A tool whose cuts showed more than plain nets below zero: no bar.
				const width = top > 0 ? (Math.max(0, totals.savedTokens) / top) * 100 : 0;
				const excessShare =
					excess !== null && totals.savedTokens > 0 ? Math.min(1, excess / totals.savedTokens) : 0;
				return (
					<li key={tool} className="spot-tool-net-row" title={title}>
						<div className="row spot-tool-net-head">
							<Icon size={13} aria-hidden="true" />
							<span className="cell-primary">{tool}</span>
							<span className="dim num">
								{formatInteger(totals.shaped)} of {formatInteger(totals.results)} shortened
							</span>
							<span
								className="spot-tool-net-value num"
								title={net === null ? "No holdout baseline yet" : undefined}
							>
								{formatSignedCompact(net ?? totals.savedTokens)}
							</span>
						</div>
						<div className="spot-tool-net-track" aria-hidden="true">
							<span className="spot-tool-net-bar" style={{ width: `${width}%` }}>
								<span className="spot-tool-net-excess" style={{ width: `${excessShare * 100}%` }} />
							</span>
						</div>
						<div className="micro spot-tool-net-detail">
							{formatSignedCompact(totals.savedTokens)} gross
							{excess !== null && <> − {formatCompact(excess)} beyond baseline</>}
						</div>
					</li>
				);
			})}
		</ul>
	);
}
