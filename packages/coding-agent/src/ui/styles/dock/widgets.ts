/**
 * Terminal looks of the editor's surroundings.
 *
 * - `text` with `term.role` `omp.widget.line`: an extension widget's line one
 *   cell in, word-wrapped, its own SGR kept (the truncation notice muted).
 * - `col` with `term.role` `omp.editor-gap`: one blank row while open.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { paddedText, termOf } from "../messages/fill";

function paintWidgetLine(node: UiNode, cx: PaintContext): Block {
	const { line, color } = termOf<{ line: string; color: string }>(node);
	if (!line || line.trim() === "") return EMPTY_BLOCK;
	return {
		rows: paddedText(color ? cx.theme.fg(color, line) : line, cx.width),
	};
}

function paintEditorGap(node: UiNode): Block {
	const open = termOf<{ open: () => boolean }>(node).open;
	return open?.() === false ? EMPTY_BLOCK : { rows: [""] };
}

defineRolePainter("text", "omp.widget.line", paintWidgetLine);
defineRolePainter("col", "omp.editor-gap", paintEditorGap);
