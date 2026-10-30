import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

/**
 * Component that renders a queue mode selector with borders
 */
export class QueueModeSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
	) {
		super(__ompTranslate("Queue Mode"), "omp.overlay.queue-mode");

		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: __ompTranslate("one-at-a-time"),
				description: __ompTranslate("Process queued messages one by one (recommended)"),
			},
			{
				value: "all",
				label: __ompTranslate("all\u0004queue.mode.all"),
				description: __ompTranslate("Process all queued messages at once"),
			},
		];

		// Create selector
		this.#selectList = new SelectList(queueModes, 2, getSelectListTheme());

		// Preselect current mode
		const currentIndex = queueModes.findIndex(item => item.value === currentMode);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as "all" | "one-at-a-time");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: __ompTranslate("Queue mode"),
			subtitle: __ompTranslate("How messages you send while omp works are delivered"),
			icon: "list",
			noun: __ompTranslate("modes"),
			current: [currentMode],
			// The terminal list shows the setting's values; the sheet names them for people.
			decorate: item =>
				item.value === "one-at-a-time"
					? {
							label: __ompTranslate("One at a time"),
							detail: __ompTranslate("Each queued message gets its own turn"),
							badges: [{ text: __ompTranslate("recommended") }],
						}
					: {
							label: __ompTranslate("All at once"),
							detail: __ompTranslate("Queued messages are sent together in one turn"),
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
