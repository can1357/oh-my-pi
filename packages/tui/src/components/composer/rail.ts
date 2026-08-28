/**
 * Filled composer with one strong accent rail on the left. The asymmetric
 * silhouette separates input from transcript without enclosing it in a box.
 */
import { padding } from "../../utils";
import type { ComposerRowContext, ComposerStyle } from "./types";

const ACCENT_RAIL = "▎";

/** Filled composer surface anchored by a single left accent rail. */
export const railComposerStyle: ComposerStyle = {
	id: "rail",
	sideBorders: true,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: true,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 1;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX + 1;
	},

	renderTop(): undefined {
		return undefined;
	},

	renderRow(ctx: ComposerRowContext): string[] {
		const rail = ctx.accentColor(ACCENT_RAIL);
		const leftFill = padding(ctx.paddingX) + ctx.gutter + ctx.text;
		if (ctx.imeSafeCursorTail) return [rail + ctx.surfaceColor(leftFill)];

		const rightFillCells = Math.max(0, ctx.paddingX + 1 - ctx.cursorOverflow);
		if (ctx.scrollbarThumb && rightFillCells > 0) {
			const interior = leftFill + ctx.pad + padding(rightFillCells - 1);
			return [rail + ctx.surfaceColor(interior) + ctx.accentColor("█")];
		}
		return [rail + ctx.surfaceColor(leftFill + ctx.pad + padding(rightFillCells))];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
