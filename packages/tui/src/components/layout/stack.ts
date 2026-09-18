import type { MouseRoutable, SgrMouseEvent } from "../../mouse";
import type { Component } from "../../tui";
import { padding } from "../../utils";
import {
	allocateLayoutSpace,
	equalLayoutInsets,
	fitLayoutLine,
	isLayoutMouseRoutable,
	layoutAlignmentOffset,
	type LayoutAlignment,
	type LayoutContent,
	layoutInsets,
	type LayoutInsets,
	type LayoutRect,
	layoutSize,
	optionalLayoutSize,
	renderLayoutContent,
	uniqueLayoutComponents,
} from "./geometry";

/** One child and its vertical row-budget constraints. */
export interface StackChild {
	content: LayoutContent;
	height?: number;
	grow?: number;
	minHeight?: number;
	maxHeight?: number;
	padding?: LayoutInsets;
	align?: LayoutAlignment;
}

/** Construction options for {@link Stack}. */
export interface StackOptions {
	children: readonly StackChild[];
	height?: number;
	align?: LayoutAlignment;
}

/** A stack hit translated into the child's local coordinates. */
export interface StackHit {
	index: number;
	content: LayoutContent;
	line: number;
	col: number;
	rect: LayoutRect;
}

interface StackMemo {
	width: number;
	height: number | undefined;
	heights: readonly number[];
	lines: readonly (readonly string[])[];
	result: readonly string[];
}

function sameChild(left: StackChild, right: StackChild): boolean {
	return (
		left.content === right.content &&
		left.height === right.height &&
		left.grow === right.grow &&
		left.minHeight === right.minHeight &&
		left.maxHeight === right.maxHeight &&
		left.align === right.align &&
		equalLayoutInsets(left.padding, right.padding)
	);
}

/**
 * Vertical component layout with fixed and growing regions, exact height
 * budgets, ANSI-aware clipping, padding, and local mouse translation.
 */
export class Stack implements Component, MouseRoutable {
	#children: StackChild[];
	#height: number | undefined;
	#align: LayoutAlignment;
	#frames: LayoutRect[] = [];
	#memo: StackMemo | undefined;
	#ignoreTight = false;

	constructor(options: StackOptions) {
		this.#children = options.children.map(child => ({ ...child, padding: { ...child.padding } }));
		this.#height = optionalLayoutSize(options.height);
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

	/** Replace the stack's children without recreating the layout component. */
	setChildren(children: readonly StackChild[]): void {
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

	/** Set the exact total row budget, or clear it to use natural height. */
	setHeight(height: number | undefined): void {
		const next = optionalLayoutSize(height);
		if (next === this.#height) return;
		this.#height = next;
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

	/** Translate a stack-local point into a child's local coordinates. */
	locate(line: number, col: number): StackHit | undefined {
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
		const insets = this.#children.map(child => layoutInsets(child.padding));
		let heights = this.#children.map(child => {
			if (child.height !== undefined) return layoutSize(child.height);
			return this.#height !== undefined && layoutSize(child.grow) > 0 ? layoutSize(child.minHeight) : -1;
		});
		const childLines: (readonly string[])[] = Array.from({ length: this.#children.length }, () => []);
		const rendered = this.#children.map(() => false);

		for (let index = 0; index < this.#children.length; index++) {
			if ((heights[index] ?? -1) >= 0) continue;
			const inset = insets[index]!;
			const contentWidth = Math.max(0, width - inset.left - inset.right);
			const lines =
				contentWidth > 0 ? renderLayoutContent(this.#children[index]!.content, contentWidth, undefined) : [];
			childLines[index] = lines;
			rendered[index] = true;
			heights[index] = lines.length + inset.top + inset.bottom;
		}

		const naturalTotal = heights.reduce((sum, height) => sum + Math.max(0, height), 0);
		heights = allocateLayoutSpace(
			this.#children.map((child, index) => ({
				fixed:
					child.height !== undefined || this.#height === undefined || layoutSize(child.grow) === 0
						? heights[index]
						: undefined,
				grow: child.grow,
				min: child.minHeight,
				max: child.maxHeight,
			})),
			this.#height ?? naturalTotal,
		);

		for (let index = 0; index < this.#children.length; index++) {
			if (rendered[index] || (heights[index] ?? 0) <= 0) continue;
			const inset = insets[index]!;
			const contentWidth = Math.max(0, width - inset.left - inset.right);
			const contentHeight = Math.max(0, (heights[index] ?? 0) - inset.top - inset.bottom);
			childLines[index] =
				contentWidth > 0 ? renderLayoutContent(this.#children[index]!.content, contentWidth, contentHeight) : [];
			rendered[index] = true;
		}

		let row = 0;
		this.#frames = this.#children.map((_child, index) => {
			const inset = insets[index]!;
			const allocated = heights[index] ?? 0;
			const rect: LayoutRect = {
				row: row + inset.top,
				col: inset.left,
				width: Math.max(0, width - inset.left - inset.right),
				height: Math.max(0, allocated - inset.top - inset.bottom),
			};
			row += allocated;
			return rect;
		});

		const memo = this.#memo;
		if (
			memo &&
			memo.width === width &&
			memo.height === this.#height &&
			memo.heights.length === heights.length &&
			memo.heights.every((value, index) => value === heights[index]) &&
			memo.lines.length === childLines.length &&
			memo.lines.every((lines, index) => lines === childLines[index])
		) {
			return memo.result;
		}

		const result: string[] = [];
		for (let index = 0; index < this.#children.length; index++) {
			const child = this.#children[index]!;
			const inset = insets[index]!;
			const allocated = heights[index] ?? 0;
			const viewportHeight = Math.max(0, allocated - inset.top - inset.bottom);
			const lines = childLines[index]!;
			const visibleHeight = Math.min(viewportHeight, lines.length);
			const offset = layoutAlignmentOffset(viewportHeight - visibleHeight, child.align ?? this.#align);
			for (let line = 0; line < allocated; line++) {
				const childLine = line - inset.top - offset;
				const content = childLine >= 0 && childLine < visibleHeight ? (lines[childLine] ?? "") : "";
				const innerWidth = Math.max(0, width - inset.left - inset.right);
				result.push(
					fitLayoutLine(padding(inset.left) + fitLayoutLine(content, innerWidth) + padding(inset.right), width),
				);
			}
		}
		while (this.#height !== undefined && result.length < this.#height) result.push(padding(width));
		this.#memo = { width, height: this.#height, heights, lines: childLines, result };
		return result;
	}
}
