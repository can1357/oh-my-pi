import type { MouseRoutable, SgrMouseEvent } from "../../mouse";
import type { Component } from "../../tui";
import { padding, visibleWidth } from "../../utils";
import {
	allocateLayoutSpace,
	equalLayoutInsets,
	fitLayoutLine,
	isLayoutMouseRoutable,
	layoutAlignmentOffset,
	type LayoutAlignment,
	type LayoutContent,
	layoutDecorationText,
	type LayoutDecoration,
	layoutInsets,
	type LayoutInsets,
	type LayoutRect,
	layoutSize,
	optionalLayoutSize,
	renderLayoutContent,
	uniqueLayoutComponents,
} from "./geometry";

/** One child and its horizontal sizing and alignment constraints. */
export interface RowChild {
	content: LayoutContent;
	width?: number;
	grow?: number;
	minWidth?: number;
	maxWidth?: number;
	padding?: LayoutInsets;
	align?: LayoutAlignment;
}

/** Construction options for {@link Row}. */
export interface RowOptions {
	children: readonly RowChild[];
	height?: number;
	gap?: LayoutDecoration;
	prefix?: LayoutDecoration;
	suffix?: LayoutDecoration;
	align?: LayoutAlignment;
}

/** A child hit translated into that child's local coordinates. */
export interface RowHit {
	index: number;
	content: LayoutContent;
	line: number;
	col: number;
	rect: LayoutRect;
}

interface RowMemo {
	width: number;
	height: number | undefined;
	prefix: string;
	gap: string;
	suffix: string;
	widths: readonly number[];
	lines: readonly (readonly string[])[];
	result: readonly string[];
}

function sameChild(left: RowChild, right: RowChild): boolean {
	return (
		left.content === right.content &&
		left.width === right.width &&
		left.grow === right.grow &&
		left.minWidth === right.minWidth &&
		left.maxWidth === right.maxWidth &&
		left.align === right.align &&
		equalLayoutInsets(left.padding, right.padding)
	);
}

/**
 * Horizontal component layout with fixed/proportional slots, exact row budgets,
 * ANSI-aware clipping, alignment, and local mouse-coordinate translation.
 */
export class Row implements Component, MouseRoutable {
	#children: RowChild[];
	#height: number | undefined;
	#gap: LayoutDecoration | undefined;
	#prefix: LayoutDecoration | undefined;
	#suffix: LayoutDecoration | undefined;
	#align: LayoutAlignment;
	#frames: LayoutRect[] = [];
	#memo: RowMemo | undefined;
	#ignoreTight = false;

	constructor(options: RowOptions) {
		this.#children = options.children.map(child => ({ ...child, padding: { ...child.padding } }));
		this.#height = optionalLayoutSize(options.height);
		this.#gap = options.gap;
		this.#prefix = options.prefix;
		this.#suffix = options.suffix;
		this.#align = options.align ?? "start";
	}

	/** Concrete component children exposed to the debug tree. */
	get debugChildren(): readonly Component[] {
		return uniqueLayoutComponents(this.#children.map(child => child.content));
	}

	/** Last-rendered content rectangle for `index`, excluding its padding. */
	childRect(index: number): LayoutRect | undefined {
		return this.#frames[index];
	}

	/** Replace the row's children without recreating the layout component. */
	setChildren(children: readonly RowChild[]): void {
		if (
			children.length === this.#children.length &&
			children.every((child, index) => sameChild(child, this.#children[index]!))
		) {
			return;
		}
		this.#children = children.map(child => ({ ...child, padding: { ...child.padding } }));
		if (this.#ignoreTight) {
			for (const child of uniqueLayoutComponents(this.#children.map(item => item.content))) {
				child.setIgnoreTight?.(true);
			}
		}
		this.#memo = undefined;
	}

	/** Set the exact rendered row count, or clear it to use natural height. */
	setHeight(height: number | undefined): void {
		const next = optionalLayoutSize(height);
		if (next === this.#height) return;
		this.#height = next;
		this.#memo = undefined;
	}

	/** Update outer and inter-child decorations. */
	setDecorations(
		prefix: LayoutDecoration | undefined,
		gap: LayoutDecoration | undefined,
		suffix: LayoutDecoration | undefined,
	): void {
		if (prefix === this.#prefix && gap === this.#gap && suffix === this.#suffix) return;
		this.#prefix = prefix;
		this.#gap = gap;
		this.#suffix = suffix;
		this.#memo = undefined;
	}

	setIgnoreTight(ignore: boolean): this {
		if (ignore === this.#ignoreTight) return this;
		this.#ignoreTight = ignore;
		for (const child of uniqueLayoutComponents(this.#children.map(item => item.content))) {
			child.setIgnoreTight?.(ignore);
		}
		this.#memo = undefined;
		return this;
	}

	invalidate(): void {
		this.#memo = undefined;
		for (const child of uniqueLayoutComponents(this.#children.map(item => item.content))) {
			child.invalidate?.();
		}
	}

	dispose(): void {
		for (const child of uniqueLayoutComponents(this.#children.map(item => item.content))) {
			child.dispose?.();
		}
	}

	/** Translate a row-local point into a child's local coordinates. */
	locate(line: number, col: number): RowHit | undefined {
		for (let index = 0; index < this.#frames.length; index++) {
			const rect = this.#frames[index];
			if (!rect) continue;
			if (line < rect.row || line >= rect.row + rect.height || col < rect.col || col >= rect.col + rect.width)
				continue;
			return {
				index,
				content: this.#children[index]!.content,
				line: line - rect.row,
				col: col - rect.col,
				rect,
			};
		}
		return undefined;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const hit = this.locate(line, col);
		if (hit && isLayoutMouseRoutable(hit.content)) hit.content.routeMouse(event, hit.line, hit.col);
	}

	render(width: number): readonly string[] {
		width = layoutSize(width);
		const prefix = layoutDecorationText(this.#prefix);
		const gap = layoutDecorationText(this.#gap);
		const suffix = layoutDecorationText(this.#suffix);
		const decorationWidth =
			visibleWidth(prefix) + visibleWidth(suffix) + Math.max(0, this.#children.length - 1) * visibleWidth(gap);
		const available = Math.max(0, width - decorationWidth);
		const widths = allocateLayoutSpace(
			this.#children.map(child => ({
				fixed: child.width,
				grow: child.width === undefined ? layoutSize(child.grow, 1) : 0,
				min: child.minWidth,
				max: child.maxWidth,
			})),
			available,
		);
		const childLines: (readonly string[])[] = [];
		const insets = this.#children.map(child => layoutInsets(child.padding));
		for (let index = 0; index < this.#children.length; index++) {
			const slotWidth = widths[index] ?? 0;
			const inset = insets[index]!;
			const contentWidth = Math.max(0, slotWidth - inset.left - inset.right);
			const contentHeight =
				this.#height === undefined ? undefined : Math.max(0, this.#height - inset.top - inset.bottom);
			childLines.push(
				contentWidth > 0 ? renderLayoutContent(this.#children[index]!.content, contentWidth, contentHeight) : [],
			);
		}
		const naturalHeight = childLines.reduce(
			(maximum, lines, index) => Math.max(maximum, lines.length + insets[index]!.top + insets[index]!.bottom),
			0,
		);
		const rowHeight = this.#height ?? naturalHeight;

		let column = visibleWidth(prefix);
		this.#frames = this.#children.map((_child, index) => {
			const inset = insets[index]!;
			const slotWidth = widths[index] ?? 0;
			const rect: LayoutRect = {
				row: inset.top,
				col: column + inset.left,
				width: Math.max(0, slotWidth - inset.left - inset.right),
				height: Math.max(0, rowHeight - inset.top - inset.bottom),
			};
			column += slotWidth + (index + 1 < this.#children.length ? visibleWidth(gap) : 0);
			return rect;
		});

		const memo = this.#memo;
		if (
			memo &&
			memo.width === width &&
			memo.height === this.#height &&
			memo.prefix === prefix &&
			memo.gap === gap &&
			memo.suffix === suffix &&
			memo.widths.length === widths.length &&
			memo.widths.every((value, index) => value === widths[index]) &&
			memo.lines.length === childLines.length &&
			memo.lines.every((lines, index) => lines === childLines[index])
		) {
			return memo.result;
		}

		const result: string[] = [];
		for (let line = 0; line < rowHeight; line++) {
			let rendered = prefix;
			for (let index = 0; index < this.#children.length; index++) {
				const child = this.#children[index]!;
				const inset = insets[index]!;
				const slotWidth = widths[index] ?? 0;
				const contentWidth = Math.max(0, slotWidth - inset.left - inset.right);
				const lines = childLines[index]!;
				const viewportHeight = Math.max(0, rowHeight - inset.top - inset.bottom);
				const visibleHeight = Math.min(viewportHeight, lines.length);
				const offset = layoutAlignmentOffset(viewportHeight - visibleHeight, child.align ?? this.#align);
				const childLine = line - inset.top - offset;
				const content = childLine >= 0 && childLine < visibleHeight ? (lines[childLine] ?? "") : "";
				rendered += padding(inset.left) + fitLayoutLine(content, contentWidth) + padding(inset.right);
				if (index + 1 < this.#children.length) rendered += gap;
			}
			const currentWidth = visibleWidth(rendered) + visibleWidth(suffix);
			rendered += padding(Math.max(0, width - currentWidth)) + suffix;
			result.push(fitLayoutLine(rendered, width));
		}
		this.#memo = { width, height: this.#height, prefix, gap, suffix, widths, lines: childLines, result };
		return result;
	}
}
