/**
 * Terminal look of the footer (`src/ui/status/footer.tsx`), all dim:
 *
 * - `omp.footer` (`status`): the path (and branch) on its own row, cut in the
 *   middle when too long; then the counters, billing and context joined by
 *   spaces (the context in its level color once past normal), with the model
 *   right-aligned at least two cells away — cut to fit, or left off when no
 *   more than three cells remain for it; the left part itself is cut first.
 * - `omp.footer.panel` (`col`): the bar, then the extension statuses.
 * - `omp.footer.extensions` (`text`): one row, cut to the width.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspSegProps } from "@oh-my-pi/pi-wire";

/** Columns kept between the stats and the model. */
const MODEL_GAP = 2;

function spansText(node: UiNode): string {
	const props = node.props() as TspSegProps;
	return (props.spans ?? []).map(span => span.t).join("");
}

/** `text` cut in the middle (by characters) to fit `width`. */
function middleCut(text: string, width: number): string {
	if (text.length <= width) return text;
	const half = Math.floor(width / 2) - 1;
	if (half <= 1) return text.slice(0, Math.max(1, width));
	return `${text.slice(0, half)}…${text.slice(-(half - 1))}`;
}

function paintFooterBar(node: UiNode, cx: PaintContext): Block {
	const { theme, width } = cx;
	const ellipsis = theme.symbols.ellipsis;
	const segs = new Map(node.children().map(child => [child.key() ?? "", child]));
	const path = segs.get("path");
	const rows: string[] = [theme.style("dim", middleCut(path ? spansText(path) : "", width))];

	const parts: string[] = [];
	let plainLeft = "";
	for (const [key, seg] of segs) {
		const props = seg.props() as TspSegProps;
		if (key === "path" || props.side === "right") continue;
		const text = spansText(seg);
		plainLeft += plainLeft ? ` ${text}` : text;
		const color = props.spans?.[0]?.s;
		parts.push(key === "context" && color && color !== "statusLineContext" ? theme.style(color, text) : text);
	}
	let left = parts.join(" ");
	let leftWidth = visibleWidth(left);
	if (leftWidth > width) {
		left = truncate(plainLeft, width, ellipsis);
		leftWidth = visibleWidth(left);
	}
	const model = segs.get("model");
	const right = model ? spansText(model) : "";
	const rightWidth = visibleWidth(right);
	let tail = "";
	if (leftWidth + MODEL_GAP + rightWidth <= width) tail = spaces(width - leftWidth - rightWidth) + right;
	else if (width - leftWidth - MODEL_GAP > 3) {
		const cut = truncate(right, width - leftWidth - MODEL_GAP, ellipsis);
		tail = spaces(width - leftWidth - visibleWidth(cut)) + cut;
	}
	rows.push(theme.style("dim", left) + theme.style("dim", tail));
	return { rows };
}

function paintFooterPanel(node: UiNode, cx: PaintContext): Block {
	return stack(
		node.children().map(child => cx.paint(child, cx.width)),
		0,
	);
}

function paintExtensions(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { text?: string };
	return props.text ? { rows: [truncate(props.text, cx.width, cx.theme.symbols.ellipsis)] } : EMPTY_BLOCK;
}

defineRolePainter("status", "omp.footer", paintFooterBar);
defineRolePainter("col", "omp.footer.panel", paintFooterPanel);
defineRolePainter("text", "omp.footer.extensions", paintExtensions);
