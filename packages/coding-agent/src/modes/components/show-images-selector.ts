import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super("Show Images");

		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		// Create selector
		this.#selectList = new SelectList(items, 5, getSelectListTheme());

		// Preselect current value
		this.#selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.#selectList.onSelect = item => {
			onSelect(item.value === "yes");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
