/**
 * The attachment band in the terminal (`row` role `omp.composer.chips` of
 * `card`s with role `omp.composer.chip`): cards of 12×4 cells inside a
 * rounded border in the chip's color, two cells apart, as many as fit. The
 * top border carries the chip's token, the bottom one its caption, both
 * bold and centred. A text chip shows its first lines muted; an image or
 * video chip its picture centred, where the terminal draws images as cells
 * of text (kitty Unicode placeholders, or SIXEL/iTerm2 drawn over blank
 * cells: the forms that fit between the card's borders), else its glyph.
 */
import type { TspImageProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { pictureRows } from "@oh-my-pi/pi-tui/term/painters/image";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import { replaceTabs, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { fileLink } from "../tools/file-common";

/** Terminal-only facts of a chip card (its `term` prop). */
export type ChipCardTerm = {
	/** The chip's color (`#rrggbb`). */
	readonly color: string;
	readonly kind: "paste" | "image" | "video";
};

const INNER_COLS = 12;
const INNER_ROWS = 4;
const CARD_GAP = 2;

function plain(text: TspText | undefined): string {
	if (text === undefined) return "";
	return typeof text === "string" ? text : (text as readonly TspSpan[]).map(span => span.t).join("");
}

function textOf(node: UiNode | undefined): string {
	const p = (node?.props() ?? {}) as { text?: string; spans?: readonly TspSpan[] };
	return p.spans ? plain(p.spans) : (p.text ?? "");
}

/** `rows` (each `columns` cells) centred in the card's interior. */
function centred(rows: readonly string[], columns: number): string[] {
	const top = Math.floor((INNER_ROWS - rows.length) / 2);
	const pad = Math.max(0, INNER_COLS - columns);
	return Array.from({ length: INNER_ROWS }, (_, i) => {
		const row = rows[i - top];
		return row === undefined
			? " ".repeat(INNER_COLS)
			: `${" ".repeat(Math.floor(pad / 2))}${row}${" ".repeat(Math.ceil(pad / 2))}`;
	});
}

/** One card's six rows. */
function paintCard(node: UiNode, cx: PaintContext): string[] {
	const theme = cx.theme;
	const props = node.props() as { head?: TspText; term?: ChipCardTerm };
	const color = props.term?.color;
	const depth = "depth" in theme && (theme.depth === "256" || theme.depth === "16") ? theme.depth : "truecolor";
	const ink = (text: string): string => (color ? `${fgSgr(color, depth)}${text}\x1b[39m` : theme.fg("accent", text));
	const box = theme.symbols.box;
	const border = (caption: string, top: boolean, href?: string): string => {
		const left = top ? box.topLeft : box.bottomLeft;
		const right = top ? box.topRight : box.bottomRight;
		if (!caption) return ink(`${left}${box.horizontal.repeat(INNER_COLS)}${right}`);
		const cut = truncate(caption, INNER_COLS - 2);
		const fill = INNER_COLS - visibleWidth(cut) - 2;
		const leftFill = Math.max(0, Math.floor(fill / 2));
		return ink(
			`${left}${box.horizontal.repeat(leftFill)} \x1b[1m${fileLink(cx, cut, href)}\x1b[22m ${box.horizontal.repeat(Math.max(0, fill - leftFill))}${right}`,
		);
	};
	const children = node.children();
	const kind = props.term?.kind ?? "paste";
	const caption = textOf(children.at(-1));
	let interior: string[];
	if (kind === "paste") {
		const lines = textOf(children[0]).split("\n").slice(0, INNER_ROWS);
		interior = Array.from({ length: INNER_ROWS }, (_, i) => {
			const line = truncate(replaceTabs(lines[i] ?? ""), INNER_COLS, "");
			return `${line ? theme.fg("muted", line) : ""}${" ".repeat(INNER_COLS - visibleWidth(line))}`;
		});
	} else {
		const picture = children.find(child => child.kind === "image");
		const drawn =
			picture && pictureRows(picture.props() as TspImageProps, cx, { label: "", cells: true, anchored: true });
		if (drawn?.state === "image") {
			interior = centred(drawn.rows, drawn.columns);
		} else {
			const glyph = theme.symbols.symbol(`chip.${kind}`);
			interior = centred([theme.fg("muted", glyph)], visibleWidth(glyph));
		}
	}
	const side = ink(box.vertical);
	const href = typeof props.head === "string" ? undefined : props.head?.find(span => span.href)?.href;
	return [
		border(plain(props.head), true, href),
		...interior.map(row => `${side}${row}${side}`),
		border(caption, false),
	];
}

function paintChips(node: UiNode, cx: PaintContext): Block {
	const cards = node.children();
	if (cards.length === 0) return EMPTY_BLOCK;
	const rows = Array.from({ length: INNER_ROWS + 2 }, () => "");
	let x = 0;
	for (const card of cards) {
		if (x + INNER_COLS + 2 > cx.width) break;
		const drawn = paintCard(card, cx);
		for (let r = 0; r < rows.length; r++) rows[r] += (x > 0 ? " ".repeat(CARD_GAP) : "") + drawn[r];
		x += (x > 0 ? CARD_GAP : 0) + INNER_COLS + 2;
	}
	return x === 0 ? EMPTY_BLOCK : { rows };
}

defineRolePainter("row", "omp.composer.chips", paintChips);
defineRolePainter("card", "omp.composer.chip", (node, cx) => ({ rows: paintCard(node, cx) }));
