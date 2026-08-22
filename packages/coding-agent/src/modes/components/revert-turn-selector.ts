import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

export interface RevertTurn {
	entryId: string;
	timestamp: string;
	preview: string;
}

/** Pick a user turn to rewind to (context only — files untouched). */
export class RevertTurnSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		turns: RevertTurn[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
	) {
		super();
		const items: SelectItem[] = [...turns].reverse().map(turn => ({
			value: turn.entryId,
			label: turn.preview,
			description: new Date(turn.timestamp).toLocaleString(),
		}));
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		this.#selectList.onSelect = item => onSelect(item.value as string);
		this.#selectList.onCancel = () => onCancel();
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
