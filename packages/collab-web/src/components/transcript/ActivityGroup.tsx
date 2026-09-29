import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import type { ToolRenderHost } from "../../tool-render";
import { type ActivityItem, summarizeActivity } from "./activity";
import { ToolCard } from "./ToolCard";

interface ActivityGroupProps {
	items: readonly ActivityItem[];
	host?: ToolRenderHost;
}

/** Items are rebuilt per render; re-render only when an item's content or pairing changed. */
function activityGroupEqual(prev: ActivityGroupProps, next: ActivityGroupProps): boolean {
	if (prev.host !== next.host || prev.items.length !== next.items.length) return false;
	for (let i = 0; i < next.items.length; i++) {
		const a = prev.items[i]!;
		const b = next.items[i]!;
		if (
			a.id !== b.id ||
			a.name !== b.name ||
			a.args !== b.args ||
			a.result !== b.result ||
			a.running !== b.running ||
			a.partialResult !== b.partialResult ||
			a.intent !== b.intent
		) {
			return false;
		}
	}
	return true;
}

/** A stable, collapsed-by-default work summary. Live updates never change the reader's disclosure choice. */
export const ActivityGroup = memo(function ActivityGroup({ items, host }: ActivityGroupProps): ReactNode {
	const [open, setOpen] = useState(false);
	const summary = summarizeActivity(items);
	const isWorking = summary.running > 0;
	const steps = summary.steps > summary.distinct ? `${summary.steps} steps` : "";

	return (
		<div className={open ? "tr-activity tr-activity--open" : "tr-activity"}>
			<button type="button" className="tr-activity-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				{isWorking ? (
					<span className="tr-activity-spin" aria-hidden="true" />
				) : (
					<ChevronRight size={13} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden="true" />
				)}
				<span className="tr-activity-text">{summary.text}</span>
				{summary.failed > 0 && <span className="tr-activity-failed">{summary.failed} failed</span>}
				{steps && <span className="tr-activity-steps">{steps}</span>}
			</button>
			{open && (
				<div className="tr-trail">
					{items.map(item => (
						<ToolCard
							key={item.id}
							toolCallId={item.id}
							name={item.name}
							intent={item.intent}
							args={item.args}
							result={item.result}
							host={host}
							running={item.running}
							partialResult={item.partialResult}
						/>
					))}
				</div>
			)}
		</div>
	);
}, activityGroupEqual);
