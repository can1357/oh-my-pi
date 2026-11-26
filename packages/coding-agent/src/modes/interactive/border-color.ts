/**
 * The composer border's color: the input mode, the Vim mode, the session accent or the
 * thinking level, first that applies. The interactive mode recolors from its live state;
 * the startup frame draws the same border from the predicted thinking level.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { thinkingColor } from "@oh-my-pi/pi-tui/theme/schema";
import type { VimMode } from "../../ui/composer/vim";
import { sessionAccentHex } from "../../ui/status/accent";

/** What the border's color reflects. */
export interface BorderState {
	/** A `!`, `$` or `/btw` draft. */
	readonly inputMode: "bash" | "python" | "btw" | undefined;
	/** `null` when modal editing is off. */
	readonly vimMode: VimMode | null;
	/** Session title, when `statusLine.sessionAccent` is on. */
	readonly sessionName: string | undefined;
	readonly thinkingLevel: string;
}

/** The theme color (key or hex) of the composer border in `state`. */
export function composerBorderColor(state: BorderState): string {
	if (state.inputMode === "bash") return "bashMode";
	if (state.inputMode === "python") return "pythonMode";
	if (state.inputMode === "btw") return "btwMode";
	if (state.vimMode === "visual" || state.vimMode === "visual-line") return "warning";
	if (state.vimMode === "normal") return "accent";
	// Insert gets its own colour rather than the session accent: with Normal and Visual both
	// coloured, an uncoloured Insert made the border unreadable as a mode.
	if (state.vimMode === "insert") return "success";
	return sessionAccentHex(currentTheme(), state.sessionName) ?? thinkingColor(state.thinkingLevel);
}
