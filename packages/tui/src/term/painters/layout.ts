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

/**
 * Stack child blocks vertically with `gap` blank rows between non-empty ones.
 * The stack's stable head runs through every leading child that is wholly
 * stable plus the stable head of the first that is not (a child without
 * `stable` promises nothing).
 */
export function stack(blocks: readonly Block[], gap: number): Block {
	const rows: string[] = [];
	let cursor: Cell | undefined;
	let hits: Hit[] | undefined;
	let stable = 0;
	let open = true;
	let covering = 0;
	for (const block of blocks) {
		if (block.rows.length === 0) continue;
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
	return {
		rows,
		...(stable > 0 ? { stable } : {}),
		...(covering > 0 ? { covering } : {}),
		...(cursor ? { cursor } : {}),
		...(hits ? { hits } : {}),
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
	return { rows, ...(cursor ? { cursor } : {}), ...(hits.length > 0 ? { hits } : {}) };
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
	if (!text) return { rows: [theme.fg("border", line.repeat(cx.width))] };
	const lead = line.repeat(3);
	const room = cx.width - 5;
	if (room < 1) return { rows: [theme.fg("border", line.repeat(cx.width))] };
	const fitted = ` ${truncate(text, room)} `;
	const rest = Math.max(0, cx.width - 3 - visibleWidth(fitted));
	return { rows: [`${theme.fg("border", lead)}${fitted}${theme.fg("border", line.repeat(rest))}`] };
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
	let rows =
		props.wrap === "none" || props.truncate !== undefined
			? styled.split("\n").map(line => truncate(line, cx.width, cx.theme.symbols.ellipsis))
			: wrap(styled, cx.width);
	if (props.lines !== undefined && rows.length > props.lines) {
		rows = rows.slice(0, props.lines);
		const last = rows.length - 1;
		if (last >= 0)
			rows[last] = truncate(`${rows[last]}${cx.theme.symbols.ellipsis}`, cx.width, cx.theme.symbols.ellipsis);
	}
	return { rows };
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
