import { useState } from "react";
import { DotWhisker, type DotWhiskerMark, type DotWhiskerRow } from "../charts";
import { formatInteger } from "../data/formatters";
import type {
	SpotlightCutGroup,
	SpotlightDashboardStats,
	SpotlightFetchBackCell,
	SpotlightGapCount,
	SpotlightTool,
} from "../types";
import { Card } from "../ui";
import { GroupLegend, MoreTools } from "./chips";
import { CUT_GROUP, CUT_GROUPS, foldTools, formatShare, GAP_BINS, toolIcon, toolsBySaving } from "./meta";

/** Vertical spread of a row's marks, so overlapping intervals stay readable. */
const MARK_OFFSET: Record<SpotlightCutGroup, number> = {
	applied: -12,
	scoreFree: -6,
	holdout: 0,
	gated: 6,
	reference: 12,
};

/** What a scored cut's rate is read against, in the row's small print: the score-free cut, then the baselines. */
const COMPARISONS: readonly SpotlightCutGroup[] = ["scoreFree", "holdout", "reference"];

/** Groups the gap histogram counts (`SpotlightGapCount` fields). */
type GapGroup = "applied" | "holdout";
const GAP_GROUPS: readonly GapGroup[] = ["applied", "holdout"];

const FETCH_BACK_RULE =
	"One rule for every group: within 12 calls, a read of the same path overlapping the result's own window (the whole file without a selector), a rerun of the call (a similar bash command; for other tools, ≥ 60% shared argument tokens), or a read of an artifact it named; not after an edit of that path (reads) or any edit (reruns), nor from the same request.";

export interface FetchBackProps {
	stats: SpotlightDashboardStats;
	stale: boolean;
}

/** Fetch-back rate per tool: the scored cut against the score-free one, the random holdout and the unchanged results. */
export function FetchBack({ stats, stale }: FetchBackProps) {
	const [expanded, setExpanded] = useState(false);
	const cells = new Map<string, SpotlightFetchBackCell>();
	for (const cell of stats.fetchBack) cells.set(`${cell.tool}/${cell.group}`, cell);
	const measured = new Set(stats.fetchBack.filter(cell => cell.results > 0).map(cell => cell.tool));
	const { listed, rest } = foldTools(toolsBySaving(stats).filter(tool => measured.has(tool)));
	// Only reads were gated, and only while pi's former edit gate ran: the legend names the group where it has results.
	const legend = CUT_GROUPS.filter(
		group => group !== "gated" || stats.fetchBack.some(cell => cell.group === "gated" && cell.results > 0),
	);

	const rows: DotWhiskerRow[] = [];
	for (const tool of expanded ? [...listed, ...rest] : listed) {
		const Icon = toolIcon(tool);
		const groups = CUT_GROUPS.flatMap(group => {
			const cell = cells.get(`${tool}/${group}`);
			return cell !== undefined && cell.results > 0 ? [cell] : [];
		});
		if (groups.length === 0) continue;
		const byGroup = new Map(groups.map(cell => [cell.group, cell]));
		const applied = byGroup.get("applied");
		const marks: DotWhiskerMark[] = groups.map(cell => ({
			key: cell.group,
			...cell.rate,
			color: CUT_GROUP[cell.group].color,
			shape: CUT_GROUP[cell.group].shape,
			offset: MARK_OFFSET[cell.group],
			title: `${CUT_GROUP[cell.group].label}: ${formatShare(cell.rate.value)} of ${formatInteger(cell.results)} results in ${formatInteger(cell.sessions)} sessions`,
		}));
		rows.push({
			key: tool,
			label: (
				<span className="spot-fb-tool" title={tool}>
					<Icon size={13} aria-hidden="true" />
					<span className="spot-fb-tool-name">{tool}</span>
				</span>
			),
			marks,
			figure: (
				<span style={{ color: CUT_GROUP.applied.color }} title={CUT_GROUP.applied.rule}>
					{applied === undefined ? "–" : formatShare(applied.rate.value)}
				</span>
			),
			detail: (
				<>
					{COMPARISONS.map((group, i) => {
						const cell = byGroup.get(group);
						return (
							<span key={group} title={`${CUT_GROUP[group].label}: ${CUT_GROUP[group].rule}`}>
								{i > 0 && " · "}
								<span className="spot-fb-detail" data-group={group}>
									{cell === undefined ? "–" : formatShare(cell.rate.value)}
								</span>
							</span>
						);
					})}
				</>
			),
		});
	}

	return (
		<Card
			index={3}
			title="Does the agent come back for it?"
			description="Share of results the agent fetched more of within 12 calls: cut with Spotlight's scores, cut without them, held out at random, kept whole by pi's former edit gate, and left unchanged"
			stale={stale}
			footer={`${FETCH_BACK_RULE} Held-out results are the true counterfactual: drawn at random from the would-be cuts and shown whole; until they accumulate, unchanged results stand in, re-weighted to the cuts' size mix. Score-free cuts skip Spotlight by a second coin and take the no-score fallback rules: if they come back as often as scored cuts, the scores add nothing. Gated reads are reads pi's former edit gate (removed) kept whole, listed only where the range has any. Small print: score-free · held out · unchanged. Whiskers are 90% session bootstrap intervals, from 3 sessions.`}
		>
			{rows.length === 0 ? (
				<div className="empty">No evaluated results in this range.</div>
			) : (
				<div className="spot-fb">
					<GroupLegend groups={legend} />
					<DotWhisker rows={rows} format={formatShare} formatTick={v => `${Math.round(v * 100)}%`} />
					{rest.length > 0 && (
						<MoreTools hidden={rest} expanded={expanded} onToggle={() => setExpanded(value => !value)} />
					)}
				</div>
			)}
		</Card>
	);
}

/** Fetch-backs per gap bin as each group's share of its own fetch-backs (the groups differ in size). */
function GapPanel({ tool, counts }: { tool: SpotlightTool; counts: readonly SpotlightGapCount[] }) {
	const Icon = toolIcon(tool);
	const byBin = new Map(counts.map(c => [c.gap, c]));
	let applied = 0;
	let holdout = 0;
	for (const c of counts) {
		applied += c.applied;
		holdout += c.holdout;
	}
	const totals: Record<GapGroup, number> = { applied, holdout };
	let top = 0;
	for (const c of counts) {
		if (applied > 0) top = Math.max(top, c.applied / applied);
		if (holdout > 0) top = Math.max(top, c.holdout / holdout);
	}

	return (
		<section className="spot-gap" aria-label={`${tool} fetch-back gaps`}>
			<h3 className="spot-panel-title row spot-gap-title">
				<Icon size={13} aria-hidden="true" />
				{tool}
				<span className="dim">
					<span className="num">{formatInteger(applied)}</span> shortened ·{" "}
					<span className="num">{formatInteger(holdout)}</span> held out
				</span>
			</h3>
			{applied + holdout === 0 ? (
				<div className="spot-gap-empty dim">No fetch-backs</div>
			) : (
				<div className="spot-gap-bins">
					{GAP_BINS.map(bin => {
						const count = byBin.get(bin);
						return (
							<div key={bin} className="spot-gap-bin">
								<div className="spot-gap-bars">
									{GAP_GROUPS.map(group => {
										const n = count?.[group] ?? 0;
										const total = totals[group];
										const share = total > 0 ? n / total : 0;
										const noun = bin === "1" ? "call" : "calls";
										return (
											<span
												key={group}
												className="spot-gap-bar"
												data-group={group}
												data-empty={total === 0}
												title={`${bin} ${noun} later: ${formatInteger(n)} of ${formatInteger(total)} ${CUT_GROUP[group].label.toLowerCase()} fetch-backs`}
											>
												{total > 0 && <span className="spot-gap-value num">{formatShare(share)}</span>}
												<span
													className="spot-gap-fill"
													style={{ height: `${top > 0 ? (share / top) * 100 : 0}%` }}
												/>
											</span>
										);
									})}
								</div>
								<span className="spot-gap-label num">{bin}</span>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

/** How many calls after the cut the agent fetched back, per tool, shortened against held out. */
export function FetchBackGaps({ stats, stale }: FetchBackProps) {
	const [expanded, setExpanded] = useState(false);
	const counted = new Set(stats.gaps.map(count => count.tool));
	const { listed, rest } = foldTools(toolsBySaving(stats).filter(tool => counted.has(tool)));
	return (
		<Card
			index={3}
			title="How soon it comes back"
			description="Calls between a result and the first fetch-back after it"
			stale={stale}
			footer="Bars are each group's share of its own fetch-backs, so shortened and held-out results compare despite their different counts (next to each tool). Same rule as above; nothing after 12 calls counts."
		>
			{listed.length === 0 ? (
				<div className="empty">No fetch-backs in this range.</div>
			) : (
				<>
					<GroupLegend groups={GAP_GROUPS} />
					<div className="spot-gaps">
						{(expanded ? [...listed, ...rest] : listed).map(tool => (
							<GapPanel key={tool} tool={tool} counts={stats.gaps.filter(c => c.tool === tool)} />
						))}
					</div>
					{rest.length > 0 && (
						<MoreTools hidden={rest} expanded={expanded} onToggle={() => setExpanded(value => !value)} />
					)}
				</>
			)}
		</Card>
	);
}
