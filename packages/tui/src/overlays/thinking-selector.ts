import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(
		currentLevel: ConfiguredThinkingLevel | undefined,
		availableLevels: ConfiguredThinkingLevel[],
		onSelect: (level: ConfiguredThinkingLevel) => void,
		onCancel: () => void,
	) {
		super("Thinking Level", "omp.overlay.thinking");

		const thinkingLevels: SelectItem[] = availableLevels.map(getConfiguredThinkingLevelMetadata);

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ConfiguredThinkingLevel);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: "Thinking level",
			icon: "brain",
			noun: "levels",
			current: currentLevel ? [currentLevel] : [],
			// How hard each level thinks, as a meter from off (empty) to the deepest effort (full); auto has none.
			columns: [{ id: "depth", format: "bar" }],
			decorate: item => {
				if (item.value === AUTO_THINKING) return undefined;
				const effort = THINKING_EFFORTS.indexOf(item.value as (typeof THINKING_EFFORTS)[number]);
				return { facts: { depth: (effort + 1) / THINKING_EFFORTS.length } };
			},
		});
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
