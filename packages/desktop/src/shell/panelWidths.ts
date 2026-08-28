/**
 * How wide the side columns may be.
 *
 * The clamping lives here rather than in the drag handler because it is the
 * part that can be wrong in a way you would not notice by dragging once: the
 * chat has to keep a floor no matter what the other two columns are doing, and
 * that floor is what a naive `clamp(min, wanted, max)` loses.
 */

export const SIDEBAR_DEFAULT = 260;
export const PANEL_DEFAULT = 420;

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const PANEL_MIN = 220;
const PANEL_MAX = 640;

/**
 * The chat's floor. Matches the `minmax(280px, 1fr)` the grid already declares,
 * so dragging can never ask for a layout the grid would then refuse to honour —
 * which is how a column ends up overlapping its neighbour.
 */
const CHAT_MIN = 280;

function clamp(wanted: number, low: number, high: number): number {
	// `high` can fall below `low` in a window narrow enough that no arrangement
	// fits. The floor wins there: a cramped chat beats an invisible sidebar.
	return Math.round(Math.min(Math.max(wanted, low), Math.max(low, high)));
}

export function clampSidebar(wanted: number, context: { viewport: number; panel: number; panelOpen: boolean }): number {
	const taken = CHAT_MIN + (context.panelOpen ? context.panel : 0);
	return clamp(wanted, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, context.viewport - taken));
}

export function clampPanel(
	wanted: number,
	context: { viewport: number; sidebar: number; sidebarOpen: boolean },
): number {
	const taken = CHAT_MIN + (context.sidebarOpen ? context.sidebar : 0);
	return clamp(wanted, PANEL_MIN, Math.min(PANEL_MAX, context.viewport - taken));
}
