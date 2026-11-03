import { Fragment, type ReactNode, useState } from "react";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats, SpotlightSizeBin, SpotlightStepCell, SpotlightTool } from "../types";
import { Card } from "../ui";
import { MoreTools } from "./chips";
import { foldTools, formatInterval, formatShare, SIZE_BINS, toolIcon, toolsBySaving } from "./meta";

/** Under this many cuts a cell's share swings on a handful of fetch-backs: it renders dimmed. */
const THIN_CUTS = 10;

/** Tint of a cell kept entirely (or lost entirely, or worse); the rest scale with the distance from half kept. */
const MAX_TINT = 30;
const MIN_TINT = 4;

/** Σ over a step's sizes, for its "all sizes" column. */
interface StepTotal {
	cuts: number;
	savedTokens: number;
	excessTokens: number;
}

interface StepRow {
	steps: string;
	bySize: Map<SpotlightSizeBin, SpotlightStepCell>;
	total: StepTotal;
}

/** Steps of one tool, the biggest saving first and `other` last. */
function stepRows(cells: readonly SpotlightStepCell[], tool: SpotlightTool): StepRow[] {
	const rows = new Map<string, StepRow>();
	for (const cell of cells) {
		if (cell.tool !== tool) continue;
		let row = rows.get(cell.steps);
		if (row === undefined) {
			row = { steps: cell.steps, bySize: new Map(), total: { cuts: 0, savedTokens: 0, excessTokens: 0 } };
			rows.set(cell.steps, row);
		}
		row.bySize.set(cell.size, cell);
		row.total.cuts += cell.cuts;
		row.total.savedTokens += cell.savedTokens;
		row.total.excessTokens += cell.excessTokens;
	}
	return [...rows.values()].sort(
		(a, b) => Number(a.steps === "other") - Number(b.steps === "other") || b.total.savedTokens - a.total.savedTokens,
	);
}

/** Green above half the saving kept, red below; strength grows toward all or nothing. */
function KeptCell({
	kept,
	cuts,
	title,
	children,
}: {
	kept: number | null;
	cuts: number;
	title: string;
	children: ReactNode;
}) {
	if (kept === null) {
		return (
			<div className="spot-econ-cell" data-empty="true" title={title}>
				<span className="dim">No saving</span>
			</div>
		);
	}
	// keptShare goes negative when the excess fetch-back outweighs the saving: as red as a total loss.
	const tint = MIN_TINT + Math.min(1, Math.abs(kept - 0.5) * 2) * (MAX_TINT - MIN_TINT);
	return (
		<div
			className="spot-econ-cell"
			data-tone={kept >= 0.5 ? "ok" : "bad"}
			data-thin={cuts < THIN_CUTS}
			style={{ "--tint": `${tint}%` }}
			title={title}
		>
			<span className="spot-econ-net num">
				{formatShare(kept)}
				<span className="spot-steps-unit"> kept</span>
			</span>
			<dl className="spot-econ-facts">{children}</dl>
		</div>
	);
}

/** Tool × shaping steps × cut size: how much of each kind of cut's saving stays saved after fetch-backs. */
export function Steps({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const all = toolsBySaving(stats).flatMap(tool => {
		const rows = stepRows(stats.steps, tool);
		return rows.length === 0 ? [] : [{ tool, rows }];
	});
	const { listed, rest } = foldTools(all);
	const tools = expanded ? all : listed;

	return (
		<Card
			index={5}
			title="Which cuts pay"
			description="Share of each kind of cut's saving that stays saved after fetch-backs beyond the holdout baseline, by size"
			actions={
				<span className="spot-econ-scale" aria-hidden="true">
					<span className="num">0%</span>
					<span className="spot-econ-ramp" />
					<span className="num">100% kept</span>
				</span>
			}
			stale={stale}
			footer={`Scored and score-free cuts. Kept = (saved − fetch-back beyond the tool's holdout baseline) ÷ saved; fetched back is the share of cuts the agent came back for within 12 calls. Sizes are the tokens a cut saved against plain; step combinations under 10 cuts fold into "other". Cells under ${THIN_CUTS} cuts are dimmed.`}
		>
			{tools.length === 0 ? (
				<div className="empty">No shortened results in this range.</div>
			) : (
				<>
					<div className="spot-steps-scroll">
						<table className="spot-econ spot-steps">
							<thead>
								<tr>
									<th scope="col">Steps</th>
									{SIZE_BINS.map(size => (
										<th key={size} scope="col" className="num">
											{size} <span className="dim">saved</span>
										</th>
									))}
									<th scope="col">All sizes</th>
								</tr>
							</thead>
							<tbody>
								{tools.map(({ tool, rows }) => {
									const Icon = toolIcon(tool);
									return (
										<Fragment key={tool}>
											<tr className="spot-steps-tool">
												<th scope="rowgroup" colSpan={SIZE_BINS.length + 2}>
													<span className="row spot-econ-tool">
														<Icon size={13} aria-hidden="true" />
														{tool}
													</span>
												</th>
											</tr>
											{rows.map(row => {
												const { total } = row;
												const totalKept =
													total.savedTokens > 0
														? (total.savedTokens - total.excessTokens) / total.savedTokens
														: null;
												return (
													<tr key={row.steps}>
														<th scope="row" className="spot-steps-name" title={row.steps}>
															{row.steps}
														</th>
														{SIZE_BINS.map(size => {
															const cell = row.bySize.get(size);
															if (cell === undefined || cell.cuts === 0) {
																return (
																	<td key={size}>
																		<div className="spot-econ-cell" data-empty="true">
																			<span className="dim">–</span>
																		</div>
																	</td>
																);
															}
															const interval = formatInterval(cell.fetchBackRate, formatShare);
															return (
																<td key={size}>
																	<KeptCell
																		kept={cell.keptShare}
																		cuts={cell.cuts}
																		title={[
																			`${tool} · ${row.steps} · ${size} saved: ${formatInteger(cell.cuts)} cuts`,
																			`Saved ${formatCompact(cell.savedTokens)}, fetched back ${formatCompact(cell.recoveredTokens)}, ${formatCompact(cell.excessTokens)} beyond the baseline`,
																			`Fetched back after ${formatShare(cell.fetchBackRate.value)} of cuts${interval === "" ? "" : ` (${interval})`}`,
																		].join("\n")}
																	>
																		<div>
																			<dt>cuts</dt>
																			<dd className="num">{formatInteger(cell.cuts)}</dd>
																		</div>
																		<div>
																			<dt>fetched back</dt>
																			<dd className="num">
																				{formatShare(cell.fetchBackRate.value)}
																			</dd>
																		</div>
																	</KeptCell>
																</td>
															);
														})}
														<td>
															<KeptCell
																kept={totalKept}
																cuts={total.cuts}
																title={`${tool} · ${row.steps}: ${formatInteger(total.cuts)} cuts saved ${formatCompact(total.savedTokens)}, ${formatCompact(total.excessTokens)} fetched back beyond the baseline`}
															>
																<div>
																	<dt>cuts</dt>
																	<dd className="num">{formatInteger(total.cuts)}</dd>
																</div>
																<div>
																	<dt>saved</dt>
																	<dd className="num">{formatCompact(total.savedTokens)}</dd>
																</div>
															</KeptCell>
														</td>
													</tr>
												);
											})}
										</Fragment>
									);
								})}
							</tbody>
						</table>
					</div>
					{rest.length > 0 && (
						<MoreTools
							hidden={rest.map(item => item.tool)}
							expanded={expanded}
							onToggle={() => setExpanded(value => !value)}
						/>
					)}
				</>
			)}
		</Card>
	);
}
