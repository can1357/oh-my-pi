/**
 * Soft status band composer (the rust omp default): the full status line sits
 * flush against the terminal's left edge as a filled powerline band with a
 * soft opening cap — no frame, rules, or corners — above an unboxed prompt
 * anchored by a single curved `╰─ ` cue.
 */
import { truncateToWidth } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

export const bandComposerStyle: ComposerStyle = {
	id: "band",
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-band",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: "╰─ ",

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(): number {
		return 0;
	},

	renderTop(ctx: ComposerChromeContext): string {
		const { topBorder, width } = ctx;
		// The band always owns one chrome row (`verticalChrome: 1`): keep it
		// reserved while the status line has nothing to show yet — the startup
		// prepaint mounts the editor before the session-aware status line
		// attaches — so the band fills in later without shifting the layout.
		if (!topBorder?.content) return "";
		// The band builder already sizes its groups + gauge to the full width;
		// truncation only guards against a stale provider during resize.
		return topBorder.width > width ? truncateToWidth(topBorder.content, width) : topBorder.content;
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [(ctx.gutter ? ctx.borderColor(ctx.gutter) : "") + ctx.text + ctx.pad];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
