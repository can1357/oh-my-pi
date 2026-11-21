import { TriangleAlert } from "lucide-react";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats } from "../types";
import { Stat } from "../ui";
import { foldTools, formatInterval, formatShare, formatSignedCompact, formatSignedCost, OTHER_TOOLS } from "./meta";

export interface SpotlightHeroProps {
	stats: SpotlightDashboardStats;
	/** Prose window ("the last 7 days"). */
	windowLabel: string;
	stale: boolean;
}

/**
 * Headline: the holdout-adjusted net (tokens and $, with intervals) against what `plain` would have shown, the old
 * full-output figure struck through as the baseline note, then gross, the excess fetch-back and the sample.
 */
export function SpotlightHero({ stats, windowLabel, stale }: SpotlightHeroProps) {
	const { gross, clawback, adjusted } = stats;
	const net = adjusted.netTokens;
	const netUsd = adjusted.netUsd;
	const tokenInterval = formatInterval(net, formatSignedCompact);
	const usdInterval = formatInterval(netUsd, formatSignedCost);
	// A tool's baseline only matters when it has cuts to adjust; `adjusted.byTool` runs the largest saving first.
	const thin = adjusted.byTool.filter(row => row.cuts > 0 && row.holdouts < adjusted.minHoldouts).map(row => row.tool);
	// Prose list: `read`, `read and bash`, `read, bash and eval`, `read, bash, … and 4 more tools`.
	const thinFold = foldTools(thin);
	const thinNames = thinFold.rest.length > 0 ? [...thinFold.listed, `${thinFold.rest.length} more tools`] : thin;
	const thinProse =
		thinNames.length < 2 ? (thinNames[0] ?? "") : `${thinNames.slice(0, -1).join(", ")} and ${thinNames.at(-1)}`;
	const heldFold = foldTools(adjusted.byTool);
	const heldRows = heldFold.listed.map(row => ({
		tool: row.tool,
		holdouts: row.holdouts,
		thin: thin.includes(row.tool),
	}));
	if (heldFold.rest.length > 0) {
		heldRows.push({
			tool: OTHER_TOOLS,
			holdouts: heldFold.rest.reduce((sum, row) => sum + row.holdouts, 0),
			thin: heldFold.rest.some(row => thin.includes(row.tool)),
		});
	}
	const overstated = gross.fullSavedTokens > 0 ? 1 - gross.savedTokens / gross.fullSavedTokens : null;

	return (
		<section className="card rise spot-hero" data-stale={stale} aria-label="Spotlight savings summary">
			<div className="spot-hero-main">
				<div className="spot-hero-headline">
					<div className="spot-eyebrow">Net saved in {windowLabel}, after fetch-backs a cut caused</div>
					<div className="spot-hero-figures">
						<span
							className="spot-hero-value gradient-text"
							title={net.value === null ? undefined : `${formatInteger(net.value)} tokens`}
						>
							{net.value === null ? "–" : formatSignedCompact(net.value)}
						</span>
						<span className="spot-hero-unit">tokens</span>
						{netUsd.value !== null && (
							<span
								className="spot-hero-usd"
								data-negative={netUsd.value < 0}
								title="Avoided context priced at each later request's cache rates, minus the fetch-backs beyond the holdout baseline (priced the same way) and Spotlight's own bill"
							>
								{formatSignedCost(netUsd.value)}
							</span>
						)}
					</div>
					{(tokenInterval !== "" || usdInterval !== "") && (
						<div className="spot-hero-interval">
							90% interval{" "}
							<span className="num">{[tokenInterval, usdInterval].filter(Boolean).join(" · ")}</span>
						</div>
					)}
				</div>
				<div className="spot-hero-aside">
					<p className="spot-hero-note">
						Counted against what pi would have shown unshaped (<code>plain</code>) for the same call (its inline
						cap and read page), with fetch-backs that held-out results show happen anyway added back.{" "}
						{gross.fullSavedTokens > gross.savedTokens && (
							<>
								Against the full output the shaping read, the cuts would claim{" "}
								<s className="spot-struck num">{formatCompact(gross.fullSavedTokens)}</s>, overstating the gross
								by {formatShare(overstated)}.{" "}
							</>
						)}
						{gross.widerThanPlain > 0 &&
							`${formatInteger(gross.widerThanPlain)} ${gross.widerThanPlain === 1 ? "result was" : "results were"} wider than plain would have shown: cuts shown that way count as losses, results pi capped at plain's text save nothing. `}
						{gross.estimatedPlain > 0 &&
							`${formatInteger(gross.estimatedPlain)} older ${gross.estimatedPlain === 1 ? "result estimates" : "results estimate"} plain from the inline cap.`}
					</p>
					{thin.length > 0 && (
						<p className="spot-hero-warn" role="note">
							<TriangleAlert size={14} aria-hidden="true" />
							<span>
								{thinProse} {thin.length === 1 ? "has" : "have"} fewer than{" "}
								{formatInteger(adjusted.minHoldouts)} held-out results: {thin.length === 1 ? "its" : "their"}{" "}
								part of the net rests on a thin baseline.
							</span>
						</p>
					)}
				</div>
			</div>

			<div className="spot-hero-stats">
				<Stat
					size="sm"
					label="Gross vs plain"
					title="Σ (plain − shortened) tokens over shortened results; a cut that showed more than plain counts negative"
					value={formatSignedCompact(gross.savedTokens)}
					hint={`${formatShare(gross.ofToolOutput)} of tool output · ${formatInteger(gross.shaped)} of ${formatInteger(gross.results)} results shortened`}
				/>
				<Stat
					size="sm"
					label="Fetched back beyond baseline"
					title="Fetch-back tokens beyond what held-out results (shown whole) fetch anyway, per tool (reads split by whether the agent was likely to edit them); 90% interval below"
					value={adjusted.excessTokens.value === null ? "–" : formatSignedCompact(-adjusted.excessTokens.value)}
					hint={
						<>
							of {formatCompact(clawback.tokens)} fetched back
							{adjusted.excessTokens.lo !== null && adjusted.excessTokens.hi !== null && (
								<>
									{" "}
									<span className="dim">
										·{" "}
										<span className="spot-nowrap">
											90% {formatInterval(adjusted.excessTokens, formatCompact)}
										</span>
									</span>
								</>
							)}
						</>
					}
				/>
				<Stat
					size="sm"
					label="Held out"
					title={`Would-be cuts shown whole at random: the baseline per tool (under ${adjusted.minHoldouts} is thin)`}
					value={formatInteger(stats.holdouts)}
					hint={
						<span className="spot-hero-tools">
							{heldRows.map(row => (
								<span
									key={row.tool}
									data-thin={row.thin}
									title={
										row.tool === OTHER_TOOLS
											? heldFold.rest.map(rest => `${rest.tool} ${formatInteger(rest.holdouts)}`).join(", ")
											: row.thin
												? `${row.tool}: under ${adjusted.minHoldouts} held out`
												: undefined
									}
								>
									{row.tool} <span className="num">{formatInteger(row.holdouts)}</span>
									{row.thin && <TriangleAlert size={11} aria-label="thin baseline" />}
								</span>
							))}
						</span>
					}
				/>
				<Stat
					size="sm"
					label="Score-free cuts"
					title="Cuts a random coin made without Spotlight (the no-score fallback rules): what Spotlight's scores add is the difference"
					value={formatInteger(stats.scoreFree)}
					hint="cut without Spotlight, for comparison"
				/>
				<Stat
					size="sm"
					label="Sessions"
					value={formatInteger(stats.sessions)}
					hint="experiment sessions, all shaped"
				/>
			</div>
		</section>
	);
}
