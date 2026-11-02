import { useMemo } from "react";
import { formatTimestamp } from "../../data/formatters";
import { Badge, Card, type Column, Table } from "../../ui";
import type { ContextEvent, ContextTimeline } from "../../types";
import { eventKinds, filterContextEvents } from "./view-models";

export function EventsTab({
	timeline,
	onSelect,
	kindFilter,
	onKindFilterChange,
}: {
	timeline: ContextTimeline;
	onSelect: (index: number) => void;
	kindFilter: readonly string[];
	onKindFilterChange: (kinds: string[]) => void;
}) {
	const selectedKinds = kindFilter;
	const kinds = useMemo(() => eventKinds(timeline.events), [timeline.events]);
	const events = useMemo(() => filterContextEvents(timeline.events, selectedKinds), [timeline.events, selectedKinds]);
	const columns = useMemo<Column<ContextEvent>[]>(
		() => [
			{
				key: "time",
				header: "Time",
				render: event => <span className="micro">{formatTimestamp(event.timestamp)}</span>,
				sort: event => event.timestamp,
			},
			{
				key: "kind",
				header: "Kind",
				render: event => <Badge>{event.inferred ? `~ ${event.kind}` : event.kind}</Badge>,
				sort: event => event.kind,
			},
			{
				key: "label",
				header: "Label",
				render: event => <span className="mono">{event.label}</span>,
				sort: event => event.label,
			},
			{
				key: "jump",
				header: "Step",
				align: "right",
				render: event => {
					const index =
						event.stepIndex === undefined ? -1 : timeline.steps.findIndex(step => step.index === event.stepIndex);
					return index >= 0 ? (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => onSelect(index)}
						>
							#{event.stepIndex}
						</button>
					) : (
						<span className="dim">outside window</span>
					);
				},
			},
		],
		[onSelect, timeline.steps],
	);
	return (
		<Card
			title="Events"
			description={timeline.omittedEvents ? `+${timeline.omittedEvents} events omitted` : undefined}
		>
			<div className="context-kind-chips">
				{kinds.map(kind => (
					<button
						type="button"
						className="badge"
						data-active={selectedKinds.includes(kind)}
						key={kind}
						onClick={() =>
							onKindFilterChange(
								selectedKinds.includes(kind)
									? selectedKinds.filter(item => item !== kind)
									: [...selectedKinds, kind],
							)
						}
					>
						{kind}
					</button>
				))}
			</div>
			<Table
				columns={columns}
				rows={events}
				rowKey={event => event.id}
				initialSort={{ key: "time", dir: "asc" }}
				empty={<p className="dim">No events recorded.</p>}
			/>
		</Card>
	);
}
