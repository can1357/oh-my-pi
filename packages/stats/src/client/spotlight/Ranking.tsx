import { DotWhisker, type DotWhiskerMark, type DotWhiskerRow } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats, SpotlightHeatPosition, SpotlightRankingCell } from "../types";
import { Card } from "../ui";
import { GroupLegend } from "./chips";
import { CUT_GROUP, formatInterval } from "./meta";

type RankingGroup = SpotlightRankingCell["group"];

/** Scored cuts first (the figure), then what they are read against. */
const GROUPS: readonly RankingGroup[] = ["applied", "scoreFree", "holdout"];

const MARK_OFFSET: Record<RankingGroup, number> = { applied: -7, scoreFree: 0, holdout: 7 };

interface Measure {
	key: "auc" | "topLift" | "keptLift";
	title: string;
	/** What the chance line means for this measure. */
	chanceLabel: string;
	chance: number;
	rule: string;
	format: (value: number) => string;
}

const MEASURES: readonly Measure[] = [
	{
		key: "auc",
		title: "Heat ranks needed lines higher",
		chanceLabel: "AUC · chance 0.5",
		chance: 0.5,
		rule: "P(a needed line is hotter than an unneeded line of the same result), ties half",
		format: v => v.toFixed(2),
	},
	{
		key: "topLift",
		title: "Hottest tenth holds them",
		chanceLabel: "lift · chance 1.0",
		chance: 1,
		rule: "Needed-line rate among each result's hottest 10% of lines over its rate among all lines",
		format: v => `${v.toFixed(2)}×`,
	},
	{
		key: "keptLift",
		title: "The cut keeps them",
		chanceLabel: "lift · random cut 1.0",
		chance: 1,
		rule: "Share of needed lines the cut kept over the share of all lines it kept",
		format: v => `${v.toFixed(2)}×`,
	},
];

const NEED_SOURCES = [
	{ key: "reread", label: "Read again", rule: "A later read of the same file selected the lines" },
	{ key: "edit", label: "Edited", rule: "A later edit's Find text matched the lines" },
] as const;

/** Per-line ranking quality: Spotlight's heat and the cut against the lines the agent needed later. */
export function Ranking({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const { ranking } = stats;
	const cells: ReadonlyMap<RankingGroup, SpotlightRankingCell> = new Map(
		ranking.cells.map(cell => [cell.group, cell]),
	);
	const measured = GROUPS.some(group => (cells.get(group)?.results ?? 0) > 0);

	return (
		<Card
			index={4}
			title="Does Spotlight keep what the agent needs?"
			description="Lines of a shaped read the agent read again or edited later, against Spotlight's heat and the cut"
			actions={<GroupLegend groups={GROUPS} />}
			stale={stale}
			footer="Shaped reads with at least one needed line, until the file's first edit or a later whole-file read. Scored and score-free cuts are biased alike (the agent re-reads what a cut hid), so compare them with each other; held-out would-be cuts, shown whole, are the unbiased measure. Score-free cuts have no heat, so only the cut's lift exists for them. Dashed lines are chance; whiskers are 90% session bootstrap intervals, from 3 sessions."
		>
			{!measured ? (
				<div className="empty">No shaped read was needed again in this range.</div>
			) : (
				<div className="spot-rank">
					<div className="spot-rank-panels">
						{MEASURES.map(measure => (
							<RankPanel key={measure.key} measure={measure} cells={cells} />
						))}
					</div>
					<div className="spot-rank-foot">
						<SampleTable cells={cells} />
						<PositionHeat positions={ranking.position} />
						<section className="spot-rank-sources" aria-label="How the need was seen">
							<h3 className="spot-panel-title">How the need was seen</h3>
							<dl className="spot-facts spot-rank-facts">
								{NEED_SOURCES.map(source => (
									<div key={source.key} title={source.rule}>
										<dt>{source.label}</dt>
										<dd className="num">
											{formatInteger(ranking.sources[source.key])}
											<span className="dim"> results</span>
										</dd>
									</div>
								))}
							</dl>
						</section>
					</div>
				</div>
			)}
		</Card>
	);
}

function RankPanel({ measure, cells }: { measure: Measure; cells: ReadonlyMap<RankingGroup, SpotlightRankingCell> }) {
	const marks: DotWhiskerMark[] = GROUPS.flatMap(group => {
		const cell = cells.get(group);
		if (cell === undefined || cell.results === 0) return [];
		const estimate = cell[measure.key];
		const interval = formatInterval(estimate, measure.format);
		return [
			{
				key: group,
				...estimate,
				color: CUT_GROUP[group].color,
				shape: CUT_GROUP[group].shape,
				offset: MARK_OFFSET[group],
				title: `${CUT_GROUP[group].label}: ${estimate.value === null ? "–" : measure.format(estimate.value)}${interval === "" ? "" : ` (${interval})`} over ${formatInteger(cell.results)} results, ${formatInteger(cell.neededLines)} needed lines`,
			},
		];
	});
	const applied = cells.get("applied")?.[measure.key].value ?? null;
	const rows: DotWhiskerRow[] = [
		{
			key: "reads",
			label: "Shaped reads",
			marks,
			figure: (
				<span style={{ color: CUT_GROUP.applied.color }}>{applied === null ? "–" : measure.format(applied)}</span>
			),
			detail: (
				<>
					{(["scoreFree", "holdout"] as const).map((group, i) => {
						const value = cells.get(group)?.[measure.key].value ?? null;
						return (
							<span key={group} title={CUT_GROUP[group].label}>
								{i > 0 && " · "}
								<span className="spot-fb-detail" data-group={group}>
									{value === null ? "–" : measure.format(value)}
								</span>
							</span>
						);
					})}
				</>
			),
		},
	];
	return (
		<section className="spot-rank-panel" aria-label={measure.title}>
			<h3 className="spot-panel-title" title={measure.rule}>
				{measure.title}
				<span className="spot-rank-chance">{measure.chanceLabel}</span>
			</h3>
			<DotWhisker
				rows={rows}
				guides={[{ key: "chance", value: measure.chance, color: "var(--ink-3)" }]}
				format={measure.format}
				formatTick={v => String(Number(v.toFixed(2)))}
			/>
		</section>
	);
}

/** Results and needed lines behind every cell of the panels. */
function SampleTable({ cells }: { cells: ReadonlyMap<RankingGroup, SpotlightRankingCell> }) {
	return (
		<section aria-label="Sample per cell">
			<h3 className="spot-panel-title">
				Sample per cell
				<span className="spot-rank-chance">results · needed lines</span>
			</h3>
			<table className="spot-rank-n">
				<thead>
					<tr>
						{GROUPS.map(group => (
							<th key={group} scope="col" title={CUT_GROUP[group].rule}>
								{CUT_GROUP[group].label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					<tr>
						{GROUPS.map(group => {
							const cell = cells.get(group);
							return (
								<td key={group} className="num" data-thin={cell !== undefined && cell.results < 20}>
									{cell === undefined || cell.results === 0 ? (
										<span className="dim">–</span>
									) : (
										<span title={`${formatInteger(cell.neededLines)} needed lines`}>
											{formatInteger(cell.results)}
											<span className="dim"> · {formatCompact(cell.neededLines)}</span>
										</span>
									)}
								</td>
							);
						})}
					</tr>
				</tbody>
			</table>
		</section>
	);
}

/** Mean heat by line position. */
function PositionHeat({ positions }: { positions: readonly SpotlightHeatPosition[] }) {
	const top = Math.max(0, ...positions.map(p => p.meanHeat));
	return (
		<section className="spot-rank-pos" aria-label="Mean heat by position">
			<h3 className="spot-panel-title">
				Mean heat by position
				<span className="spot-rank-chance">0–9, outputs ≥ 40 lines</span>
			</h3>
			{positions.length === 0 || top === 0 ? (
				<div className="dim spot-gap-empty">No heat recorded</div>
			) : (
				<>
					<div className="spot-rank-bars">
						{positions.map(p => (
							<div
								key={p.label}
								className="spot-rank-bar"
								title={`${p.label}: mean heat ${p.meanHeat.toFixed(2)} over ${formatInteger(p.lines)} lines`}
							>
								<span className="spot-rank-bar-track">
									<span className="spot-rank-bar-value num">{p.meanHeat.toFixed(1)}</span>
									{/* The value's line (14px) stays clear above the tallest bar. */}
									<span
										className="spot-rank-bar-fill"
										style={{ height: `calc((100% - 14px) * ${p.meanHeat / top})` }}
									/>
								</span>
								{/* `line 1` → `L1`, `lines 2–3` → `L2–3`, `0–10%` → `0–10`: short enough to sit under a bar. */}
								<span className="spot-rank-bar-label num">
									{p.label.replace(/^lines? /, "L").replace(/%$/, "")}
								</span>
							</div>
						))}
					</div>
					<div className="micro spot-rank-axis">L = line of the output, then each tenth of it (% into it)</div>
				</>
			)}
		</section>
	);
}
