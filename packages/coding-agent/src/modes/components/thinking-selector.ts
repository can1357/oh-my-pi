import type { Effort } from "@oh-my-pi/pi-ai";
import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		currentLevel: Effort,
		availableLevels: Effort[],
		onSelect: (level: Effort) => void,
		onCancel: () => void,
	) {
		super("Thinking Level");

		const thinkingLevels: SelectItem[] = availableLevels.map(getThinkingLevelMetadata);

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as Effort);
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
