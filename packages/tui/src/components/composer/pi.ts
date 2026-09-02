/**
 * Upstream-pi composer: full-width horizontal rules above and below plain
 * padded text — no side borders, no prompt gutter. The status bar renders as
 * a plain standalone bottom bar with both segment groups.
 */
import { padding } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

export const piComposerStyle: ComposerStyle = {
	id: "pi",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: false,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 1;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [padding(this.sideChromeWidth(ctx.paddingX)) + ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},
};
