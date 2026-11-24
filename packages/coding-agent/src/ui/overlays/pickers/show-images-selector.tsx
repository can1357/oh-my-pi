/** @jsxImportSource @oh-my-pi/pi-tui */
/** The show-images selector: images inline in the terminal, or text placeholders. */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { SelectSheet } from "./select-sheet";

export interface ShowImagesSelectorProps {
	readonly current: boolean;
	onSelect(show: boolean): void;
	onCancel(): void;
}

export function ShowImagesSelector(props: ShowImagesSelectorProps): JSXNode {
	const current = props.current ? "yes" : "no";
	return (
		<SelectSheet
			title="Show images"
			icon="image"
			items={[
				{ id: "yes", label: "Yes", detail: "Show images inline in terminal" },
				{ id: "no", label: "No", detail: "Show text placeholder instead" },
			]}
			initial={current}
			current={[current]}
			term={{ title: "Show Images", hint: null }}
			onPick={id => props.onSelect(id === "yes")}
			onCancel={props.onCancel}
		/>
	);
}
