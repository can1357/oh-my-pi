import { formatCompact, formatCost, formatInteger, formatPercent } from "../data/formatters";
import type { CacheMissStats } from "../types";
import { DataTable, type DataTableColumn } from "../ui";
import { AGENT_META } from "./AgentTokenShare";

/** Plain-language definition shown as the panel's hover help. */
export const CACHE_MISS_HELP =
	"Consecutive requests in one session, same provider and model, neither errored, both prompts >= 1024 tokens, " +
	"prompt not shrunk below 97% (compaction), and under 5 minutes idle. Models that never reported a cache read " +
	"are excluded. The smaller prompt is the expected cache hit; miss rate is the share of it not read from cache. " +
	"A bad turn misses more than max(2048 tokens, 10%). " +
	"Avoidable $ prices missed tokens at the model's input minus cache-read rate.";

function AgentCell({ item }: { item: CacheMissStats }) {
	const meta = AGENT_META[item.agentType];
	return (
		<div className="flex items-center gap-2">
			<span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: meta.color }} />
			<span>{meta.label}</span>
		</div>
	);
}

const COLUMNS: DataTableColumn<CacheMissStats>[] = [
	{
		key: "provider",
		header: "Provider",
		render: item => <span className="stats-font-medium stats-text-primary">{item.provider}</span>,
	},
	{ key: "agent", header: "Agent", render: item => <AgentCell item={item} /> },
	{
		key: "missRate",
		header: "Miss rate",
		numeric: true,
		render: item => (
			<span title={`${formatInteger(item.missedTokens)} of ${formatInteger(item.expectedTokens)} cacheable tokens`}>
				{formatPercent(item.missRate, 2)}
			</span>
		),
	},
	{
		key: "badPairs",
		header: "Bad turns",
		numeric: true,
		render: item => (
			<span title={`${formatInteger(item.badPairs)} of ${formatInteger(item.pairs)} warm turns`}>
				{formatPercent(item.badPairRate, 2)}
			</span>
		),
	},
	{ key: "missed", header: "Missed tokens", numeric: true, render: item => formatCompact(item.missedTokens) },
	{ key: "avoidable", header: "Avoidable $", numeric: true, render: item => formatCost(item.avoidableCost) },
];

function renderMobileCard(item: CacheMissStats) {
	return (
		<div className="stats-mobile-card">
			<div className="stats-mobile-card-header">
				<div className="stats-font-semibold stats-text-primary">{item.provider}</div>
				<AgentCell item={item} />
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Miss rate</div>
					<div className="stats-mobile-card-value">{formatPercent(item.missRate, 2)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Bad turns</div>
					<div className="stats-mobile-card-value">{formatPercent(item.badPairRate, 2)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Missed tokens</div>
					<div className="stats-mobile-card-value">{formatCompact(item.missedTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Avoidable $</div>
					<div className="stats-mobile-card-value">{formatCost(item.avoidableCost)}</div>
				</div>
			</div>
		</div>
	);
}

export interface CacheMissTableProps {
	stats: CacheMissStats[];
}

/** Per provider + agent breakdown of prompt tokens missed while the cache should have been warm. */
export function CacheMissTable({ stats }: CacheMissTableProps) {
	return (
		<DataTable
			columns={COLUMNS}
			data={stats}
			keyExtractor={item => `${item.provider}:${item.agentType}`}
			renderMobileCard={renderMobileCard}
			emptyText="No warm-cache turns in this range"
		/>
	);
}
