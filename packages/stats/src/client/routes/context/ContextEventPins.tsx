import { formatTimestamp } from "../../data/formatters";
import type { ContextEvent, ContextStep } from "../../types";

const EVENT_COLOR: Record<string, string> = {
	compact: "var(--warn)",
	prune: "var(--ctx-unattributed)",
	switch: "var(--context-accent)",
	reset: "var(--bad)",
	branch: "var(--ok)",
	mode: "var(--ctx-system-context)",
	inject: "var(--ctx-system-tools)",
};

export function ContextEventPins({
	events,
	steps,
	onSelect,
}: {
	events: readonly ContextEvent[];
	steps: readonly ContextStep[];
	onSelect: (index: number) => void;
}) {
	const pins = events
		.map(event => {
			if (event.stepIndex === undefined) return null;
			const index = steps.findIndex(step => step.index === event.stepIndex);
			return index >= 0 ? { event, index } : null;
		})
		.filter((pin): pin is { event: ContextEvent; index: number } => pin !== null);
	if (pins.length === 0) return null;
	return (
		<div className="context-event-pins" aria-label="Context events">
			{pins.map(({ event, index }) => (
				<button
					type="button"
					key={event.id}
					className="context-event-pin"
					style={{ background: EVENT_COLOR[event.kind] ?? "var(--line-3)" }}
					aria-label={`${event.kind}: ${event.label} at ${formatTimestamp(event.timestamp)}`}
					title={`${event.kind}: ${event.label}`}
					onClick={() => onSelect(index)}
				/>
			))}
		</div>
	);
}
