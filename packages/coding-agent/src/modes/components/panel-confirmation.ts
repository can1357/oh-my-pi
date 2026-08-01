import { Container, type SelectItem, SelectList, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

/** A bounded decision prompt shown in the editor slot before or after a panel run. */
export interface PanelConfirmationOptions {
	title: string;
	details: readonly string[];
	confirmLabel: string;
	cancelLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * Editor-slot confirmation for panel dispatch and partial-result synthesis.
 * Selection stays explicit: Escape always takes the cancel path.
 */
export class PanelConfirmationComponent extends Container {
	#selectList: SelectList;

	constructor(options: PanelConfirmationOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 1, 0));
		this.addChild(new Spacer(1));
		for (const detail of options.details) {
			this.addChild(new Text(theme.fg("muted", detail), 1, 0));
		}
		this.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{ value: "confirm", label: options.confirmLabel },
			{ value: "cancel", label: options.cancelLabel },
		];
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "confirm") options.onConfirm();
			else options.onCancel();
		};
		this.#selectList.onCancel = options.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter choose · Esc cancel"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
