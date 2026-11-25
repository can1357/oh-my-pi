/** @jsxImportSource @oh-my-pi/pi-tui */
/** The queue mode selector: whether messages sent while omp works go one per turn or together. */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { SelectSheet } from "./select-sheet";

export type QueueMode = "all" | "one-at-a-time";

export interface QueueModeSelectorProps {
	readonly current: QueueMode;
	onSelect(mode: QueueMode): void;
	onCancel(): void;
}

export function QueueModeSelector(props: QueueModeSelectorProps): JSXNode {
	return (
		<SelectSheet
			title="Queue mode"
			subtitle="How messages you send while omp works are delivered"
			icon="list"
			noun="modes"
			items={[
				{
					id: "one-at-a-time",
					label: "One at a time",
					detail: "Each queued message gets its own turn",
					badges: [{ text: "recommended" }],
				},
				{ id: "all", label: "All at once", detail: "Queued messages are sent together in one turn" },
			]}
			initial={props.current}
			current={[props.current]}
			// The terminal list shows the setting's values; the sheet names them for people.
			term={{
				title: "Queue Mode",
				hint: null,
				labels: {
					"one-at-a-time": {
						label: "one-at-a-time",
						detail: "Process queued messages one by one (recommended)",
					},
					all: { label: "all", detail: "Process all queued messages at once" },
				},
			}}
			onPick={id => props.onSelect(id as QueueMode)}
			onCancel={props.onCancel}
		/>
	);
}
