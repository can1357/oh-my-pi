/**
 * `yield`: a status box (see `tintBox`): `⢿ Submit Result: target ⟦badge⟧
 * meta`, then the error in full, the data (a JSON tree, or the Markdown
 * source as muted lines, four while collapsed) and a note.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { displayLines } from "@oh-my-pi/pi-tui/text/sanitize";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { boxTint, liveMark, nodePlain, nodeStyle, styledLines, tintBox } from "./agent-common";
import { bracketed, expandHint, moreLinesHint } from "./frame";
import { COLLAPSED_TREE, EXPANDED_TREE, jsonTreeRows } from "./json-tree";
import { defineToolLook, isExpanded, type ToolProps, toolProps } from "./look";

/** Markdown source lines a collapsed box shows. */
const TEXT_ROWS_COLLAPSED = 4;

/** `glyph Title: target ⟦badge⟧ meta`. */
export function statusHead(cx: PaintContext, props: ToolProps, mark = liveMark(cx, props)): string {
	const theme = cx.theme;
	let head = `${mark} ${theme.fg("accent", styledText(theme, props.title))}`;
	if (props.target !== undefined) head += `: ${theme.fg("muted", styledText(theme, props.target))}`;
	for (const badge of props.badges ?? []) head += ` ${theme.fg(badge.tone ?? "muted", bracketed(theme, badge.text))}`;
	if (props.meta && props.meta.length > 0)
		head += ` ${theme.fg("dim", props.meta.map(fact => styledText(theme, fact)).join(" "))}`;
	return head;
}

/** Rows of a JSON tree, an expand hint (collapsed) or `…` (expanded) when cut. */
export function jsonRows(theme: Theme, value: unknown, expanded: boolean): string[] {
	const tree = jsonTreeRows(theme, value, expanded ? EXPANDED_TREE : COLLAPSED_TREE);
	if (tree.truncated) tree.rows.push(expanded ? theme.fg("dim", "…") : expandHint(theme));
	return tree.rows;
}

/** Body lines of a status box's children (wrapped later by the box). */
export function statusBodyLines(node: UiNode, cx: PaintContext, expanded: boolean): string[] {
	const theme = cx.theme;
	const content = Math.max(1, cx.width - 2);
	const lines: string[] = [];
	for (const child of node.children()) {
		const props = child.props() as { value?: unknown; text?: string };
		switch (child.kind) {
			case "json":
				lines.push(...jsonRows(theme, props.value, expanded));
				break;
			case "md": {
				const source = displayLines((props.text ?? "").trimEnd());
				const shown = expanded ? source : source.slice(0, TEXT_ROWS_COLLAPSED);
				for (const line of shown) {
					const styled = theme.fg("muted", line);
					lines.push(expanded ? styled : truncate(styled, content));
				}
				if (!expanded && source.length > TEXT_ROWS_COLLAPSED)
					lines.push(moreLinesHint(theme, source.length - TEXT_ROWS_COLLAPSED));
				break;
			}
			case "code":
				lines.push(...styledLines(theme, "error", props.text ?? ""));
				break;
			default:
				lines.push(...styledLines(theme, nodeStyle(child), nodePlain(child)));
		}
	}
	return lines;
}

function paintYield(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const lines = [statusHead(cx, props), ...statusBodyLines(node, cx, isExpanded(props))];
	return { rows: tintBox(cx.theme, boxTint(props), cx.width, lines) };
}

defineToolLook("yield", { paint: paintYield, margin: true, animated: true });
