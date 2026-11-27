/**
 * Layout kinds: `col`, `row`, `spacer`, `rule`, `text`, `canvas`, `rows`.
 *
 * Generic looks for the structural vocabulary; screens that need a specific
 * look style a role (see `defineRolePainter`).
 */
import type { TspSpace, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { CanvasProps, UiNode } from "../../node";
import type { Theme } from "../../theme/contract";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "../../text/width";
import { type Block, type Cell, definePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "../paint";
import {
	blockText,
	clipRenderedText,
	decorationText,
	lazyText,
	mapWrappedText,
	offsetRenderedText,
	type RenderedText,
	type RenderedTextRow,
	type RenderedTextSpan,
	shownText,
	sliceRenderedText,
	withSpans,
} from "../text-layout";

/** Blank rows a spacing step stands for. */
export function spaceRows(space: TspSpace | undefined): number {
	switch (space) {
		case "xs":
		case "sm":
			return 1;
		case "md":
			return 2;
		case "lg":
			return 3;
		default:
			return 0;
	}
}

/** Styled text of `content` (plain string or spans) under `theme`. */
export function styledText(theme: Theme, content: TspText | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	let out = "";
	for (const span of content as readonly TspSpan[]) out += span.s ? theme.style(span.s, span.t) : span.t;
	return out;
}

/** Shift a block's cursor and hits down by `rows` and right by `cols`. */
export function offsetBlock(block: Block, rows: number, cols: number): { cursor?: Cell; hits?: Hit[] } {
	const cursor = block.cursor ? { row: block.cursor.row + rows, col: block.cursor.col + cols } : undefined;
	const hits = block.hits?.map(hit => ({ ...hit, row: hit.row + rows, col: hit.col + cols }));
	return { cursor, hits };
}

/** Logical text of stacked `blocks` (all non-empty) with `gap` decoration rows between them. */
function stackText(blocks: readonly Block[], gap: number): RenderedText {
	const text: (RenderedTextRow | undefined)[] = [];
	for (const block of blocks) {
		if (text.length > 0) for (let i = 0; i < gap; i++) text.push(undefined);
		for (const row of blockText(block)) text.push(row);
	}
	return text;
}

/**
 * Stack child blocks vertically with `gap` blank rows between non-empty ones.
 * The stack's stable head runs through every leading child that is wholly
 * stable plus the stable head of the first that is not (a child without
 * `stable` promises nothing). Its text is the children's, gap rows decoration.
 */
export function stack(blocks: readonly Block[], gap: number): Block {
	const rows: string[] = [];
	const shown: Block[] = [];
	let cursor: Cell | undefined;
	let hits: Hit[] | undefined;
	let stable = 0;
	let open = true;
	let covering = 0;
	for (const block of blocks) {
		if (block.rows.length === 0) continue;
		shown.push(block);
		covering += block.covering ?? 0;
		if (rows.length > 0) for (let i = 0; i < gap; i++) rows.push("");
		const top = rows.length;
		const shifted = offsetBlock(block, top, 0);
		cursor ??= shifted.cursor;
		if (shifted.hits) (hits ??= []).push(...shifted.hits);
		rows.push(...block.rows);
		if (open) {
			const head = Math.min(block.stable ?? 0, block.rows.length);
			if (head > 0) stable = top + head;
			open = head === block.rows.length;
		}
	}
	if (rows.length === 0) return EMPTY_BLOCK;
	const only = shown.length === 1 ? shown[0]! : undefined;
	return {
		rows,
		...(stable > 0 ? { stable } : {}),
		...(covering > 0 ? { covering } : {}),
		...(cursor ? { cursor } : {}),
		...(hits ? { hits } : {}),
		// One child: its text as is (no copy).
		text: only ? (only.text ?? (() => blockText(only))) : lazyText(() => stackText(shown, gap)),
	};
}

function paintCol(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { gap?: TspSpace };
	const blocks = node.children().map(child => cx.paint(child, cx.width));
	return stack(blocks, spaceRows(props.gap));
}

interface RowChildProps {
	grow?: number;
	shrink?: number;
	basis?: "auto" | "content" | number;
}

/**
 * Horizontal flex: children get their natural width (`basis` or content),
 * spare cells go to `grow`, overflow is taken from `shrink`. Rows align at
 * the top and are padded to their column's width.
 */
function paintRow(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { gap?: TspSpace; justify?: "start" | "between" | "end" };
	const children = node.children();
	if (children.length === 0) return EMPTY_BLOCK;
	const gap = spaceRows(props.gap);
	const available = Math.max(0, cx.width - gap * (children.length - 1));
	const natural = children.map(child => {
		const p = child.props() as RowChildProps;
		if (typeof p.basis === "number") return p.basis;
		const block = cx.paint(child, available);
		let width = 0;
		for (const row of block.rows) width = Math.max(width, visibleWidth(row));
		return width;
	});
	const widths = [...natural];
	let total = widths.reduce((sum, w) => sum + w, 0);
	if (total < available) {
		const grows = children.map(child => (child.props() as RowChildProps).grow ?? 0);
		const growTotal = grows.reduce((sum, g) => sum + g, 0);
		if (growTotal > 0) {
			let spare = available - total;
			for (let i = 0; i < widths.length && spare > 0; i++) {
				const share = i === widths.length - 1 ? spare : Math.floor(((available - total) * grows[i]!) / growTotal);
				widths[i]! += Math.min(share, spare);
				spare -= Math.min(share, spare);
			}
			total = available;
		}
	} else if (total > available) {
		const shrinks = children.map(child => (child.props() as RowChildProps).shrink ?? 1);
		let excess = total - available;
		for (let i = widths.length - 1; i >= 0 && excess > 0; i--) {
			if (shrinks[i] === 0) continue;
			const take = Math.min(excess, widths[i]!);
			widths[i]! -= take;
			excess -= take;
		}
		total = available;
	}
	const blocks = children.map((child, i) => (widths[i]! > 0 ? cx.paint(child, widths[i]!) : EMPTY_BLOCK));
	const height = blocks.reduce((max, block) => Math.max(max, block.rows.length), 0);
	let lead = 0;
	let between = gap;
	const slack = Math.max(0, cx.width - total - gap * (children.length - 1));
	if (props.justify === "end") lead = slack;
	else if (props.justify === "between" && children.length > 1)
		between = gap + Math.floor(slack / (children.length - 1));
	const rows: string[] = [];
	for (let r = 0; r < height; r++) {
		let line = " ".repeat(lead);
		for (let i = 0; i < blocks.length; i++) {
			if (i > 0) line += " ".repeat(between);
			const cell = blocks[i]!.rows[r] ?? "";
			line += i === blocks.length - 1 ? cell : padTo(cell, widths[i]!);
		}
		rows.push(line.trimEnd() === "" ? "" : line);
	}
	let cursor: Cell | undefined;
	const hits: Hit[] = [];
	let col = lead;
	for (let i = 0; i < blocks.length; i++) {
		const shifted = offsetBlock(blocks[i]!, 0, col);
		cursor ??= shifted.cursor;
		if (shifted.hits) hits.push(...shifted.hits);
		col += widths[i]! + between;
	}
	return {
		rows,
		...(cursor ? { cursor } : {}),
		...(hits.length > 0 ? { hits } : {}),
		text: lazyText(() => rowText(blocks, widths, lead, between, height)),
	};
}

/**
 * Logical text of a `row`: each row shows its children's runs. Runs that sit
 * alone on the row (a key beside its value) share one line, in order; a run
 * whose line goes on over other rows (a wrapped paragraph beside a gutter)
 * keeps it, and the runs beside it are left out of the text.
 */
function rowText(
	blocks: readonly Block[],
	widths: readonly number[],
	lead: number,
	between: number,
	height: number,
): RenderedText {
	const texts = blocks.map(blockText);
	const columns: number[] = [];
	let col = lead;
	for (let i = 0; i < blocks.length; i++) {
		columns.push(col);
		col += widths[i]! + between;
	}
	const place = (row: RenderedTextRow, child: number): RenderedTextRow | undefined => {
		const placed = offsetRenderedText(row, columns[child]!);
		return child < blocks.length - 1 ? clipRenderedText(placed, columns[child]! + widths[child]!) : placed;
	};
	const out: (RenderedTextRow | undefined)[] = [];
	for (let r = 0; r < height; r++) {
		const runs: { row: RenderedTextRow; child: number }[] = [];
		for (let i = 0; i < texts.length; i++) {
			const row = texts[i]![r];
			if (row) runs.push({ row, child: i });
		}
		// Blank lines beside text are padding.
		const content = runs.length > 1 ? runs.filter(run => run.row.line.text !== "") : runs;
		const chosen = content.length > 0 ? content : runs.slice(0, 1);
		if (chosen.length <= 1) {
			out.push(chosen[0] && place(chosen[0].row, chosen[0].child));
			continue;
		}
		const spanning = chosen.find(
			({ row, child }) => texts[child]![r - 1]?.line === row.line || texts[child]![r + 1]?.line === row.line,
		);
		if (spanning) {
			out.push(place(spanning.row, spanning.child));
			continue;
		}
		let line = "";
		const spans: RenderedTextSpan[] = [];
		for (let k = 0; k < chosen.length; k++) {
			const { row, child } = chosen[k]!;
			if (k > 0) line += " ";
			const base = line.length;
			line += row.line.text;
			const placed = place(row, child)!;
			for (const span of placed.spans ?? [placed])
				spans.push({ start: base + span.start, end: base + span.end, column: span.column });
		}
		out.push(withSpans({ text: line }, spans));
	}
	return out;
}

function paintSpacer(node: UiNode): Block {
	const size = (node.props() as { size?: TspSpace }).size ?? "sm";
	const count = spaceRows(size);
	return count === 0 ? EMPTY_BLOCK : { rows: Array.from({ length: count }, () => "") };
}

function paintRule(node: UiNode, cx: PaintContext): Block {
	const label = (node.props() as { label?: TspText }).label;
	const theme = cx.theme;
	const line = theme.symbols.box.horizontal;
	const text = styledText(theme, label);
	if (!text) return { rows: [theme.fg("border", line.repeat(cx.width))], text: decorationText(1) };
	const lead = line.repeat(3);
	const room = cx.width - 5;
	if (room < 1) return { rows: [theme.fg("border", line.repeat(cx.width))], text: decorationText(1) };
	const shown = truncate(text, room);
	const fitted = ` ${shown} `;
	const rest = Math.max(0, cx.width - 3 - visibleWidth(fitted));
	return {
		rows: [`${theme.fg("border", lead)}${fitted}${theme.fg("border", line.repeat(rest))}`],
		// The label is content; the line around it is not.
		text: lazyText(() => [offsetRenderedText(shownText(text, shown), 4)]),
	};
}

interface TextProps {
	text?: string;
	spans?: readonly TspSpan[];
	wrap?: "word" | "char" | "none";
	truncate?: "end" | "start" | "middle";
	lines?: number;
}

function paintText(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as TextProps;
	const content = props.spans ?? props.text;
	const styled = replaceTabs(styledText(cx.theme, content));
	if (styled === "") return EMPTY_BLOCK;
	const ellipsis = cx.theme.symbols.ellipsis;
	const cut = props.wrap === "none" || props.truncate !== undefined;
	const drawn = cut ? styled.split("\n").map(line => truncate(line, cx.width, ellipsis)) : wrap(styled, cx.width);
	let rows = drawn;
	if (props.lines !== undefined && rows.length > props.lines) {
		rows = rows.slice(0, props.lines);
		const last = rows.length - 1;
		if (last >= 0) rows[last] = truncate(`${rows[last]}${ellipsis}`, cx.width, ellipsis);
	}
	return { rows, text: lazyText(() => paragraphText(styled, drawn, rows, cut, ellipsis)) };
}

/**
 * Logical text of a `text` node: its lines as wrapped (or cut one row each),
 * limited to what `rows` keeps of `drawn`, its last row re-cut for the
 * ellipsis; cut lines keep only what is shown.
 */
function paragraphText(
	styled: string,
	drawn: readonly string[],
	rows: readonly string[],
	cut: boolean,
	ellipsis: string,
): RenderedText {
	const full = cut
		? styled.split("\n").map((line, i) => shownText(line, drawn[i]!))
		: [...mapWrappedText(styled, drawn)];
	if (rows === drawn) return full;
	const last = rows.length - 1;
	if (last >= 0) full[last] = clipRenderedText(full[last], visibleWidth(rows[last]!) - visibleWidth(ellipsis));
	return sliceRenderedText(full, 0, rows.length);
}

function paintCanvas(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as CanvasProps;
	return { rows: props.paint(cx.width) };
}

function paintRows(node: UiNode): Block {
	return { rows: (node.props() as { lines?: readonly string[] }).lines ?? [] };
}

definePainter("col", paintCol);
definePainter("row", paintRow);
definePainter("spacer", paintSpacer);
definePainter("rule", paintRule);
definePainter("text", paintText);
definePainter("canvas", paintCanvas);
definePainter("rows", paintRows);
