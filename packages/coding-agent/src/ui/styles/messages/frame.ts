/**
 * Framed extension and hook messages (`card` roles `omp.custom`,
 * `omp.custom.delegation`, `omp.hook`): a rounded outline in the border
 * color around a `customMessageBg` fill, one row and one cell of padding
 * inside; the bold `customMessageLabel` type tag (with its glyph) and a blank
 * row, then the body as Markdown in `customMessageText`, folded to its first
 * lines and a `…` row while collapsed.
 *
 * An extension renderer's nodes (`col` with the same roles) are drawn one
 * cell in from the left, like other transcript text; a rows object (`canvas`)
 * keeps the full width, flush at the left edge.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { fillRow, propsOf, termOf } from "./fill";

interface FrameTerm {
	glyph?: string;
	icon?: string;
	tag: string;
	border: string;
	collapseAfterLines?: number;
}

/** Rows of `content` inside a rounded outline in `border` around a `bg` fill with one cell of padding. */
export function outlinedRows(
	theme: Theme,
	content: readonly string[],
	width: number,
	border: string,
	bg: string,
): string[] {
	const box = theme.symbols.box;
	const inner = Math.max(0, width - 2);
	const edge = theme.fg(border, box.vertical);
	return [
		theme.fg(border, `${box.topLeft}${box.horizontal.repeat(inner)}${box.topRight}`),
		...content.map(row => `${edge}${fillRow(theme, bg, row === "" ? "" : ` ${row}`, inner)}${edge}`),
		theme.fg(border, `${box.bottomLeft}${box.horizontal.repeat(inner)}${box.bottomRight}`),
	];
}

function paintFrameCard(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const props = propsOf<{ head: unknown; collapsed: boolean }>(node);
	const term = termOf<FrameTerm>(node);
	const contentWidth = Math.max(1, cx.width - 4);
	const content: string[] = [""];
	if (props.head !== undefined) {
		const glyph = term.glyph ?? (term.icon ? theme.symbols.icon(term.icon) : "");
		const tag = glyph ? `${glyph} ${term.tag ?? ""}` : (term.tag ?? "");
		content.push(...wrap(theme.fg("customMessageLabel", `\x1b[1m${tag}\x1b[22m`), contentWidth), "");
	}
	const body = node.children().find(child => child.kind === "md");
	let text = body ? (propsOf<{ text: string }>(body).text ?? "") : "";
	const fold = term.collapseAfterLines;
	let folded = false;
	if (fold !== undefined && props.collapsed === true) {
		const lines = text.split("\n");
		folded = lines.length > fold;
		if (folded) text = lines.slice(0, fold).join("\n");
	}
	const { rows } = renderMarkdownFrame(replaceTabs(text), contentWidth, {
		theme,
		textStyle: "customMessageText",
		hyperlinks: cx.hyperlinks,
	});
	content.push(...rows);
	if (folded) content.push("…");
	content.push("");
	return {
		rows: outlinedRows(theme, content, cx.width, term.border ?? "borderMuted", "customMessageBg"),
	};
}

function paintFrameCustom(node: UiNode, cx: PaintContext): Block {
	const inner = Math.max(1, cx.width - 2);
	const block = stack(
		node.children().map(child => {
			// A rows object owns its columns, as the old frame drew its component.
			if (child.kind === "canvas") return cx.paint(child, cx.width);
			const { rows } = cx.paint(child, inner);
			return { rows: rows.map(row => (row === "" ? row : ` ${row}`)) };
		}),
		0,
	);
	return { rows: block.rows };
}

for (const role of ["omp.custom", "omp.custom.delegation", "omp.hook"]) {
	defineRolePainter("card", role, paintFrameCard);
	defineRolePainter("col", role, paintFrameCustom);
}
