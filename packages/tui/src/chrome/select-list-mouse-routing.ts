import type { SelectList } from "../components/select-list";
import type { SgrMouseEvent } from "../mouse";
/** Route overlay-local mouse input past a panel's top border into its SelectList child. */
export function routeSelectListMouseWithTopBorder(
	selectList: SelectList,
	event: SgrMouseEvent,
	line: number,
	col: number,
): void {
	selectList.routeMouse(event, line - 1, col);
}
