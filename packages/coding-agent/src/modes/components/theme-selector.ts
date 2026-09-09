import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a theme selector.
 * Themes must be pre-loaded and passed to the constructor.
 */
export class ThemeSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super("Theme");
		this.#onPreview = onPreview;

		// Create select items from provided themes
		const themeItems: SelectItem[] = themes.map(name => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Create selector
		this.#selectList = new SelectList(themeItems, 10, getSelectListTheme());

		// Preselect current theme
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.#selectList.onSelectionChange = item => {
			this.#onPreview(item.value);
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
