/**
 * The classic omp composer: rounded frame, status line embedded in the top
 * border, and the last content row merged into the bottom border
 * (`╰─ text … ─╯`), keeping a one-line prompt at two rows total.
 */
import { padding, truncateToWidth, visibleWidth } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

export const boxComposerStyle: ComposerStyle = {
	id: "box",
	sideBorders: true,
	verticalChrome: 2,
	statusAttachment: "top-border",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: undefined,

	defaultPaddingX(themePaddingX: number | undefined): number {
		return Math.max(0, themePaddingX ?? 2);
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX + 1;
	},

	renderTop(ctx: ComposerChromeContext): string {
		const { box, paddingX, width, borderColor, topBorder } = ctx;
		const topLeft = borderColor(`${box.topLeft}${box.horizontal.repeat(paddingX)}`);
		const topRight = borderColor(`${box.horizontal.repeat(paddingX)}${box.topRight}`);
		const topFillWidth = Math.max(0, width - this.sideChromeWidth(paddingX) * 2);
		if (!topBorder) {
			return topLeft + borderColor(box.horizontal.repeat(topFillWidth)) + topRight;
		}
		const { content, width: statusWidth } = topBorder;
		if (statusWidth <= topFillWidth) {
			// Status fits - add fill after it
			const fillWidth = topFillWidth - statusWidth;
			return topLeft + content + borderColor(box.horizontal.repeat(fillWidth)) + topRight;
		}
		// Status too long - truncate it
		const truncated = truncateToWidth(content, Math.max(0, topFillWidth - 1));
		const truncatedWidth = visibleWidth(truncated);
		const fillWidth = Math.max(0, topFillWidth - truncatedWidth);
		return topLeft + truncated + borderColor(box.horizontal.repeat(fillWidth)) + topRight;
	},

	renderRow(ctx: ComposerRowContext): string[] {
		const { box, paddingX, width, borderColor, text, pad, isLastRow } = ctx;
		// When the end-of-line cursor glyph (or a wide trailing grapheme) extends
		// past the content width, shrink the right chrome by the exact overflow
		// count: drop padding spaces first, then the trailing `─`, but never the
		// corner/vertical bar itself.
		const rightChromeCells = Math.max(1, paddingX + 1 - ctx.cursorOverflow);
		if (isLastRow && ctx.imeSafeCursorTail) {
			// Terminal frontends render IME marked text locally before committed
			// bytes reach the application. Keep the end-of-input cursor row empty
			// to its right so insertion cannot shift box chrome onto the next row.
			const leftBorder = borderColor(`${box.vertical}${padding(paddingX)}`);
			const bottomBorder = borderColor(
				`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`,
			);
			return [leftBorder + text, bottomBorder];
		}
		if (isLastRow) {
			const bottomLeft = borderColor(`${box.bottomLeft}${box.horizontal}${padding(Math.max(0, paddingX - 1))}`);
			const rightPad = Math.max(0, rightChromeCells - 2);
			const includeHorizontal = rightChromeCells >= 2;
			const bottomRightAdjusted = borderColor(
				`${padding(rightPad)}${includeHorizontal ? box.horizontal : ""}${box.bottomRight}`,
			);
			return [`${bottomLeft}${text}${pad}${bottomRightAdjusted}`];
		}
		const leftBorder = borderColor(`${box.vertical}${padding(paddingX)}`);
		// When the scrollbar is active, replace the right border vertical with a
		// thumb glyph (█) inside the thumb range, keeping the track (│) elsewhere.
		const rightGlyph = ctx.scrollbarThumb ? "█" : box.vertical;
		const rightBorder = borderColor(`${padding(Math.max(0, rightChromeCells - 1))}${rightGlyph}`);
		return [leftBorder + text + pad + rightBorder];
	},

	renderBottom(): undefined {
		// The bottom border is merged into the last content row.
		return undefined;
	},
};
