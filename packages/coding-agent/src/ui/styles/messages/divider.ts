/**
 * Dividers and turn markers (`rule` role `omp.divider`, `row`/`rule` roles
 * `omp.marker.*`): a blank row, then a short rule in the rule color and the
 * label in its color, then a blank row.
 *
 * The rule is at most `ruleWidth` cells (10) and gives way to the label;
 * when no cell of it is left, the label stands alone, truncated to the width
 * (or, with `truncateWhenNarrow: false`, as long as the width allows).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { termOf } from "./fill";

/** Terminal facts of a divider. */
export interface DividerTerm {
	label: string;
	glyph?: string;
	labelColor: string;
	ruleColor?: string;
	ruleWidth?: number;
	truncateWhenNarrow?: boolean;
}

/** The divider line of `term` at `width`. */
export function dividerLine(cx: PaintContext, term: Partial<DividerTerm>): string {
	const theme = cx.theme;
	const glyph = term.glyph ? theme.symbols.icon(term.glyph) : "";
	const label = glyph ? `${glyph} ${term.label ?? ""}` : (term.label ?? "");
	const painted = theme.fg(term.labelColor ?? "dim", label);
	const rule = Math.min(term.ruleWidth ?? 10, cx.width - visibleWidth(label) - 1);
	// A label that runs past the width is cut there either way: rows never exceed it.
	if (rule < 1) return truncate(painted, cx.width);
	return `${theme.fg(term.ruleColor ?? "dim", theme.symbols.box.horizontal.repeat(rule))} ${painted}`;
}

function paintDivider(node: UiNode, cx: PaintContext): Block {
	return { rows: ["", dividerLine(cx, termOf<DividerTerm>(node)), ""] };
}

defineRolePainter("rule", "omp.divider", paintDivider);
defineRolePainter("rule", "omp.marker", paintDivider, { prefix: true });
defineRolePainter("row", "omp.marker", paintDivider, { prefix: true });
