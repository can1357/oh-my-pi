/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The theme selector: every installed theme with a swatch mark seeded by its
 * name; moving the selection previews the theme.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { SelectSheet } from "./select-sheet";

export interface ThemeSelectorProps {
	readonly current: string;
	readonly themes: readonly string[];
	onSelect(theme: string): void;
	onCancel(): void;
	/** The selection moved: preview `theme`. */
	onPreview(theme: string): void;
}

/** A theme as a picker row: its name and a swatch mark (the native sheet checks the current theme). */
export function themeItem(name: string): TspPickerItem {
	return { id: name, label: name, detail: "", mark: { text: name.slice(0, 2), seed: name } };
}

export function ThemeSelector(props: ThemeSelectorProps): JSXNode {
	return (
		<SelectSheet
			title="Theme"
			icon="ink"
			noun="themes"
			items={props.themes.map(themeItem)}
			initial={props.current}
			current={[props.current]}
			confirmLabel="Apply"
			query=""
			// The terminal list marks the current theme in its detail column.
			term={{
				title: "Theme",
				hint: null,
				search: false,
				labels: { [props.current]: { label: props.current, detail: "(current)" } },
			}}
			onPick={props.onSelect}
			onCancel={props.onCancel}
			onHighlight={props.onPreview}
		/>
	);
}
