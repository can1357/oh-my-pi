/** Terminal padding state: settings set the density, and terminal painters read the resulting inset. */
import { signal } from "@oh-my-pi/pi-tui/reactive";

const tightLayout = signal(false);

/** Set whether terminal output removes one cell of horizontal padding on each side. */
export const setTightLayout = tightLayout.set;

/** Horizontal padding of terminal output at the current layout density. */
export function terminalPaddingX(base = 1): number {
	return base !== 0 && tightLayout() ? Math.max(0, base - 1) : base;
}
