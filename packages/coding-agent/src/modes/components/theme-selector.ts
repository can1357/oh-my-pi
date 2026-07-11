import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@pk-nerdsaver-ai/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a theme selector.
 * Themes must be pre-loaded and passed to the constructor.
 */
export class ThemeSelectorComponent extends Container {
	#selectList: SelectList;
	#onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.#onPreview = onPreview;

		// Create select items from provided themes
		const themeItems: SelectItem[] = themes.map(name => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Add top border
		this.addChild(new DynamicBorder());

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

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
