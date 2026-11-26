/**
 * `legacy`: a tool whose render hooks draw its terminal rows (`term.parts`,
 * see `src/ui/tools/legacy.ts`: rows objects and nodes, in order), inside the
 * transcript's custom-tool box: one cell of padding left and right, one blank
 * row above and below; nothing at all when the hooks draw nothing.
 */
import { isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { paintRows } from "../../extensions/render-output";
import type { LegacyTerm, ToolRenderPart } from "../../tools/legacy";
import { tint, tintRow } from "./default";
import { defineToolLook, toolProps } from "./look";

/** The rows of a tool's drawn parts at `width`. */
export function legacyPartRows(cx: PaintContext, parts: readonly ToolRenderPart[], width: number): string[] {
	const lines: string[] = [];
	for (const part of parts) lines.push(...(isUiNode(part) ? cx.paint(part, width).rows : paintRows(part, width)));
	return lines;
}

function paintLegacy(node: UiNode, cx: PaintContext): Block {
	const term = toolProps(node).term as Partial<LegacyTerm> | undefined;
	const width = cx.width;
	const inner = term?.boxed ? Math.max(1, width - 2) : width;
	const lines = legacyPartRows(cx, term?.parts ?? [], inner);
	if (lines.length === 0) return EMPTY_BLOCK;
	if (!term?.boxed) return { rows: lines };
	const key = tint(toolProps(node));
	return { rows: ["", ...lines.map(line => ` ${line}`), ""].map(row => tintRow(cx.theme, key, row, width)) };
}

defineToolLook("legacy", { paint: paintLegacy });
