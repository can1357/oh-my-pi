import { BarList, Legend, ShareBar } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats } from "../types";
import { Badge, Card } from "../ui";
import { foldTools, formatShare } from "./meta";

const SHAPED_COLOR = "var(--spot-applied)";
const UNSHAPED_COLOR = "var(--spot-unshaped)";

/** Which tools' output the models of experiment sessions saw, shaped and not: where shaping could reach next. */
export function Coverage({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const rows = [...stats.coverage].sort((a, b) => b.tokens - a.tokens);
	const { listed, rest } = foldTools(rows);
	let shaped = 0;
	let unshaped = 0;
	for (const row of rows) {
		if (row.shaped) shaped += row.share;
		else unshaped += row.share;
	}
	const items = listed.map(row => ({
		key: row.tool,
		label: (
			<>
				<span className="spot-coverage-tool">{row.tool}</span>
				{row.shaped && <Badge>shaped</Badge>}
				<span className="dim num">{formatInteger(row.calls)} calls</span>
			</>
		),
		value: row.share,
		display: `${formatShare(row.share)} · ${formatCompact(row.tokens)}`,
		color: row.shaped ? SHAPED_COLOR : UNSHAPED_COLOR,
	}));
	if (rest.length > 0) {
		let share = 0;
		let tokens = 0;
		let calls = 0;
		for (const row of rest) {
			share += row.share;
			tokens += row.tokens;
			calls += row.calls;
		}
		items.push({
			key: "\u0000rest",
			label: (
				<>
					<span className="spot-coverage-tool">
						{formatInteger(rest.length)} more {rest.length === 1 ? "tool" : "tools"}
					</span>
					<span className="dim num">{formatInteger(calls)} calls</span>
				</>
			),
			value: share,
			display: `${formatShare(share)} · ${formatCompact(tokens)}`,
			color: rest.some(row => row.shaped) ? SHAPED_COLOR : UNSHAPED_COLOR,
		});
	}

	return (
		<Card
			index={5}
			title="Not shaped yet"
			description="Share of the tool output experiment sessions' models saw, by tool: the unshaped ones are where shaping could reach next"
			actions={
				<Legend
					items={[
						{ key: "shaped", label: "Shaped", color: SHAPED_COLOR },
						{ key: "unshaped", label: "Not shaped", color: UNSHAPED_COLOR },
					]}
				/>
			}
			stale={stale}
			footer="Tokens are tool-result chars ÷ 4 over the experiment's sessions in the range; a tool counts as shaped when the experiment evaluated any of its results in the range."
		>
			{rows.length === 0 ? (
				<div className="empty">No tool output in this range.</div>
			) : (
				<div className="spot-coverage">
					<div className="spot-coverage-summary">
						<div className="spot-coverage-headline">
							<span className="num">{formatShare(unshaped)}</span> of tool output comes from tools the experiment
							did not shape in this range
						</div>
						<ShareBar
							height={8}
							segments={[
								{ key: "shaped", label: "Shaped", value: shaped, color: SHAPED_COLOR },
								{ key: "unshaped", label: "Not shaped", value: unshaped, color: UNSHAPED_COLOR },
							]}
						/>
					</div>
					<BarList items={items} />
				</div>
			)}
		</Card>
	);
}
