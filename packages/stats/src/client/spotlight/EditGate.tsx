import { formatInteger } from "../data/formatters";
import type { SpotlightDashboardStats, SpotlightEditGateReads, SpotlightEstimate } from "../types";
import { Card, type Column, Table } from "../ui";
import { CUT_GROUP, formatInterval, formatShare, formatSignedCost } from "./meta";

/** Cut beside whole, each in its group's ink. */
function Pair({ cut, whole, title }: { cut: string; whole: string; title?: string }) {
	return (
		<span className="spot-gate-pair num" title={title}>
			<span style={{ color: CUT_GROUP.applied.color }}>{cut}</span>
			<span className="dim"> vs </span>
			<span style={{ color: CUT_GROUP.gated.color }}>{whole}</span>
		</span>
	);
}

function rateTitle(label: string, estimate: SpotlightEstimate): string {
	const interval = formatInterval(estimate, formatShare);
	return interval
		? `${label}: ${formatShare(estimate.value)}, 90% ${interval}`
		: `${label}: ${formatShare(estimate.value)}`;
}

const COLUMNS: Column<SpotlightEditGateReads>[] = [
	{
		key: "reads",
		header: (
			<>
				<span style={{ color: CUT_GROUP.applied.color }}>Cut</span> vs{" "}
				<span style={{ color: CUT_GROUP.gated.color }}>whole</span>
			</>
		),
		align: "right",
		sort: row => row.cut + row.gated + row.heldOut,
		title: "Edit-likely reads the model saw cut, against those it saw whole (kept by the gate, or held out)",
		render: row => (
			<span title={`${formatInteger(row.gated)} gated · ${formatInteger(row.heldOut)} held out`}>
				<Pair cut={formatInteger(row.cut)} whole={formatInteger(row.gated + row.heldOut)} />
			</span>
		),
	},
	{
		key: "fetchBack",
		header: "Fetched back",
		align: "right",
		sort: row => row.cutFetchBack.value ?? -1,
		title: "Share the agent fetched more of within 12 calls (the fetch-back card's rule)",
		render: row => (
			<Pair
				cut={formatShare(row.cutFetchBack.value)}
				whole={formatShare(row.wholeFetchBack.value)}
				title={`${rateTitle("Cut", row.cutFetchBack)}\n${rateTitle("Whole", row.wholeFetchBack)}`}
			/>
		),
	},
	{
		key: "turns",
		header: "Fetch-back requests /100",
		align: "right",
		sort: row => row.cutTurnsPer100,
		title: "Requests that did nothing but fetch back, per 100 reads",
		render: row => (
			<Pair
				cut={row.cut > 0 ? row.cutTurnsPer100.toFixed(1) : "–"}
				whole={row.gated + row.heldOut > 0 ? row.wholeTurnsPer100.toFixed(1) : "–"}
			/>
		),
	},
	{
		key: "net",
		header: "Net /100 cut",
		align: "right",
		sort: row => row.cutNetUsdPer100.value ?? Number.NEGATIVE_INFINITY,
		title: "Holdout-adjusted net dollars per 100 edit-likely reads cut: negative means the gate saves money",
		render: row => {
			const net = row.cutNetUsdPer100;
			if (net.value === null) return <span className="dim">–</span>;
			const interval = formatInterval(net, formatSignedCost);
			const tone = net.value < 0 ? "bad" : net.value > 0 ? "ok" : "neutral";
			return (
				<span className="num">
					<span className="spot-gate-net" data-tone={tone}>
						{formatSignedCost(net.value)}
					</span>
					{interval && <span className="dim spot-gate-interval"> 90% {interval}</span>}
				</span>
			);
		},
	},
];

/**
 * Edit-likely reads cut against those shown whole: whether cutting what the agent is about to edit only buys
 * fetch-backs.
 */
export function EditGate({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const { reads, editLikelyShare } = stats.editGate;
	const rows = reads === null ? [] : [reads];
	return (
		<Card
			index={3}
			title="Edit-aware gate"
			description="Reads the agent was likely to edit: cut, against kept whole by the gate or held out"
			actions={
				editLikelyShare !== null && (
					<span className="spot-gate-share" title="Share of shaped read results that are edit-likely">
						<span className="num">{formatShare(editLikelyShare)}</span> of reads edit-likely
					</span>
				)
			}
			flush
			stale={stale}
			footer={`A read is edit-likely when it reads a code file (by extension) and either the session is a main agent (not a task subagent) or it already read or edited that file; pi marks such reads and keeps a share of them whole (spotlight.experiment.editGate). Reads journaled before pi marked them are classified here by the same rule. Whole reads are the gated and held-out ones together. Fetch-back requests did nothing but fetch back, counted by the fetch-back card's rule for both groups. Net is holdout-adjusted: the cuts' carried saving, less the fetched-back tokens beyond what held-out edit-likely reads fetch anyway (all held-out reads while under 30) and the fetch-back requests beyond the whole reads' rate, less Spotlight's bill; intervals are 90% session bootstrap, from 3 sessions.`}
		>
			<Table
				rows={rows}
				rowKey={() => "reads"}
				columns={COLUMNS}
				dense
				empty={<div className="empty">No edit-likely reads in this range.</div>}
			/>
		</Card>
	);
}
