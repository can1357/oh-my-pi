import { Sparkline } from "../../charts";
import { formatCompact, formatInteger, formatRelativeTime } from "../../data/formatters";
import type { ContextSessionRow } from "../../types";
import { formatContextCost } from "./view-models";

export function ContextSessionCard({ row, onOpen }: { row: ContextSessionRow; onOpen: (file: string) => void }) {
	const open = () => onOpen(row.file);
	return (
		<article
			className="context-session-card"
			role="button"
			tabIndex={0}
			onClick={open}
			onKeyDown={event => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			}}
		>
			<header>
				<h3 title={row.title ?? row.file}>{row.title ?? row.file.split("/").pop()}</h3>
				<span className="context-session-cost">{formatContextCost(row.costTotal, row.unpricedRequests)}</span>
			</header>
			<p className="context-session-folder mono" title={row.folder}>
				{row.folder}
			</p>
			<div className="context-session-metrics">
				<span>
					<b>{formatInteger(row.requests)}</b> req
				</span>
				<span>
					<b>{formatCompact(row.peakPromptTokens)}</b> peak
				</span>
				<span>
					<b>{formatCompact(row.avgPromptTokens)}</b> avg
				</span>
			</div>
			<div className="context-session-spark">
				<Sparkline values={row.sparkline} color="var(--context-accent)" height={32} />
			</div>
			<footer>
				<span className="context-session-models">
					{row.models.slice(0, 2).map(model => (
						<em key={model}>{model}</em>
					))}
					{row.models.length > 2 && <em>+{row.models.length - 2}</em>}
				</span>
				<small>{formatRelativeTime(row.endedAt)}</small>
			</footer>
		</article>
	);
}
