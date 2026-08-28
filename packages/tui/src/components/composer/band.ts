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

	renderTop(ctx: ComposerChromeContext): string | undefined {
		const { topBorder, width } = ctx;
		if (!topBorder?.content) return undefined;
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
