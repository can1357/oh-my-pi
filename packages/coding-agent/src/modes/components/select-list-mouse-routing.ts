import type { SelectList, SgrMouseEvent } from "@oh-my-pi/pi-tui";

interface RoutableSelectList {
	routeMouse?: (event: SgrMouseEvent, line: number, col: number) => void;
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

export function routeSelectListMouseWithTopBorder(
	selectList: SelectList,
	event: SgrMouseEvent,
	line: number,
	col: number,
): void {
	const localLine = line - 1;
	const target = selectList as RoutableSelectList;
	if (typeof target.routeMouse === "function") {
		target.routeMouse(event, localLine, col);
		return;
	}
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return;
	}
	const index = target.hitTest(localLine);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
	}
}
