import { theme } from "@oh-my-pi/pi-tui/theme";

/** Whether the active symbol preset can render Nerd Fonts glyphs. */
export function nerdGlyphsActive(): boolean {
	return typeof theme !== "undefined" && theme.getSymbolPreset() === "nerd";
}
