/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The thinking level selector: the configured levels the model offers, each
 * with a depth meter (off empty to the deepest effort full; `auto` has none).
 */
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata } from "../../../thinking/levels";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { SelectSheet } from "./select-sheet";

export interface ThinkingSelectorProps {
	readonly current: ConfiguredThinkingLevel | undefined;
	readonly levels: readonly ConfiguredThinkingLevel[];
	onSelect(level: ConfiguredThinkingLevel): void;
	onCancel(): void;
}

export function ThinkingSelector(props: ThinkingSelectorProps): JSXNode {
	const items: TspPickerItem[] = props.levels.map(level => {
		const meta = getConfiguredThinkingLevelMetadata(level);
		const item: TspPickerItem = { id: meta.value, label: meta.label, detail: meta.description };
		if (level === AUTO_THINKING) return item;
		const effort = THINKING_EFFORTS.indexOf(level as (typeof THINKING_EFFORTS)[number]);
		return { ...item, facts: { depth: (effort + 1) / THINKING_EFFORTS.length } };
	});
	return (
		<SelectSheet
			title="Thinking level"
			icon="brain"
			noun="levels"
			items={items}
			initial={props.current}
			current={props.current ? [props.current] : []}
			columns={[{ id: "depth", format: "bar" }]}
			term={{ title: "Thinking Level", hint: null }}
			onPick={id => props.onSelect(id as ConfiguredThinkingLevel)}
			onCancel={props.onCancel}
		/>
	);
}
