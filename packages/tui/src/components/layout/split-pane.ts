import type { MouseRoutable, SgrMouseEvent } from "../../mouse";
import type { Component } from "../../tui";
import { visibleWidth } from "../../utils";
import {
	isLayoutComponent,
	isLayoutMouseRoutable,
	type LayoutAlignment,
	type LayoutContent,
	layoutDecorationText,
	type LayoutDecoration,
	type LayoutRect,
	layoutRatio,
	layoutSize,
	optionalLayoutSize,
	uniqueLayoutComponents,
} from "./geometry";
import { Row } from "./row";

/** Pane selected when a split collapses below its width constraints. */
export type PaneSide = "left" | "right";

/** Fixed or proportional sizing constraints for the left pane. */
export interface SplitPaneSize {
	fixed?: number;
	ratio?: number;
	min?: number;
	max?: number;
}

/** Construction options for {@link SplitPane}. */
export interface SplitPaneOptions {
	left: LayoutContent;
	right: LayoutContent;
	leftSize?: SplitPaneSize;
	rightMinWidth?: number;
	splitAt?: number;
	narrowPane?: PaneSide;
	height?: number;
	prefix?: LayoutDecoration;
	divider?: LayoutDecoration;
	suffix?: LayoutDecoration;
	align?: LayoutAlignment;
}

/** Resolved pane mode and local rectangles for a width. */
export interface SplitPaneGeometry {
	mode: "split" | "narrow";
	left?: LayoutRect;
	right?: LayoutRect;
	dividerCol?: number;
}

/** A pane hit translated into the pane child's local coordinates. */
export interface SplitPaneHit {
	pane: PaneSide;
	content: LayoutContent;
	line: number;
	col: number;
	rect: LayoutRect;
}

interface SplitMeasureMemo {
	width: number;
	prefix: string;
	divider: string;
	suffix: string;
	geometry: SplitPaneGeometry;
}

/**
 * Adaptive two-pane layout over {@link Row}. It owns width bounds, an optional
 * narrow fallback, exact height budgets, and pane-local mouse translation.
 */
export class SplitPane implements Component, MouseRoutable {
	readonly #left: LayoutContent;
	readonly #right: LayoutContent;
	readonly #row: Row;
	#leftSize: SplitPaneSize;
	#rightMinWidth: number;
	#splitAt: number;
	#narrowPane: PaneSide | undefined;
	#height: number | undefined;
	#prefix: LayoutDecoration | undefined;
	#divider: LayoutDecoration | undefined;
	#suffix: LayoutDecoration | undefined;
	#align: LayoutAlignment;
	#lastGeometry: SplitPaneGeometry = { mode: "split" };
	#measureMemo: SplitMeasureMemo | undefined;
	#rowMode: "split" | PaneSide = "split";
	#rowLeftWidth = -1;

	constructor(options: SplitPaneOptions) {
		this.#left = options.left;
		this.#right = options.right;
		this.#leftSize = {
			fixed: optionalLayoutSize(options.leftSize?.fixed),
			ratio: options.leftSize?.ratio === undefined ? undefined : layoutRatio(options.leftSize.ratio, 0),
			min: optionalLayoutSize(options.leftSize?.min),
			max: optionalLayoutSize(options.leftSize?.max),
		};
		this.#rightMinWidth = layoutSize(options.rightMinWidth);
		this.#splitAt = layoutSize(options.splitAt);
		this.#narrowPane = options.narrowPane;
		this.#height = optionalLayoutSize(options.height);
		this.#prefix = options.prefix;
		this.#divider = options.divider;
		this.#suffix = options.suffix;
		this.#align = options.align ?? "start";
		this.#row = new Row({
			children: [
				{ content: this.#left, grow: 1, align: this.#align },
				{ content: this.#right, grow: 1, align: this.#align },
			],
			height: this.#height,
			prefix: this.#prefix,
			gap: this.#divider,
			suffix: this.#suffix,
			align: this.#align,
		});
	}

	/** Concrete pane children exposed to the debug tree. */
	get debugChildren(): readonly Component[] {
		return uniqueLayoutComponents([this.#left, this.#right]);
	}

	/** Mode used by the last render. */
	get mode(): "split" | "narrow" {
		return this.#lastGeometry.mode;
	}

	/** Left-pane content width from the last render. */
	get leftWidth(): number {
		return this.#lastGeometry.left?.width ?? 0;
	}

	/** Right-pane content width from the last render. */
	get rightWidth(): number {
		return this.#lastGeometry.right?.width ?? 0;
	}

	/** Column where the divider begins in the last split render. */
	get dividerCol(): number | undefined {
		return this.#lastGeometry.dividerCol;
	}

	/** Set the exact pane row budget, or clear it to use natural height. */
	setHeight(height: number | undefined): void {
		const next = optionalLayoutSize(height);
		if (next === this.#height) return;
		this.#height = next;
		this.#measureMemo = undefined;
		this.#row.setHeight(this.#height);
	}

	/** Change which pane is shown in narrow mode; `undefined` disables collapse. */
	setNarrowPane(pane: PaneSide | undefined): void {
		if (pane === this.#narrowPane) return;
		this.#narrowPane = pane;
		this.#measureMemo = undefined;
	}

	/** Update fixed/proportional left-pane constraints. */
	setLeftSize(size: SplitPaneSize): void {
		const next: SplitPaneSize = {
			fixed: optionalLayoutSize(size.fixed),
			ratio: size.ratio === undefined ? undefined : layoutRatio(size.ratio, 0),
			min: optionalLayoutSize(size.min),
			max: optionalLayoutSize(size.max),
		};
		if (
			next.fixed === this.#leftSize.fixed &&
			next.ratio === this.#leftSize.ratio &&
			next.min === this.#leftSize.min &&
			next.max === this.#leftSize.max
		) {
			return;
		}
		this.#leftSize = next;
		this.#measureMemo = undefined;
	}

	/** Update the minimum width at which both panes may be shown. */
	setSplitAt(width: number): void {
		const next = layoutSize(width);
		if (next === this.#splitAt) return;
		this.#splitAt = next;
		this.#measureMemo = undefined;
	}

	/** Update the minimum content width reserved for the right pane. */
	setRightMinWidth(width: number): void {
		const next = layoutSize(width);
		if (next === this.#rightMinWidth) return;
		this.#rightMinWidth = next;
		this.#measureMemo = undefined;
	}

	/** Update outer and divider decorations. */
	setDecorations(
		prefix: LayoutDecoration | undefined,
		divider: LayoutDecoration | undefined,
		suffix: LayoutDecoration | undefined,
	): void {
		if (prefix === this.#prefix && divider === this.#divider && suffix === this.#suffix) return;
		this.#prefix = prefix;
		this.#divider = divider;
		this.#suffix = suffix;
		this.#measureMemo = undefined;
	}

	/** Resolve split/narrow geometry without rendering either pane. */
	measure(width: number): SplitPaneGeometry {
		width = layoutSize(width);
		const prefix = layoutDecorationText(this.#prefix);
		const divider = layoutDecorationText(this.#divider);
		const suffix = layoutDecorationText(this.#suffix);
		const memo = this.#measureMemo;
		if (
			memo &&
			memo.width === width &&
			memo.prefix === prefix &&
			memo.divider === divider &&
			memo.suffix === suffix
		) {
			return memo.geometry;
		}
		const prefixWidth = visibleWidth(prefix);
		const dividerWidth = visibleWidth(divider);
		const suffixWidth = visibleWidth(suffix);
		const splitAvailable = Math.max(0, width - prefixWidth - dividerWidth - suffixWidth);
		const leftMinimum = layoutSize(this.#leftSize.min);
		const leftMaximum =
			this.#leftSize.max === undefined
				? Number.MAX_SAFE_INTEGER
				: Math.max(leftMinimum, layoutSize(this.#leftSize.max));
		const canSplit =
			this.#narrowPane === undefined ||
			(width >= this.#splitAt && splitAvailable >= leftMinimum + this.#rightMinWidth);
		if (!canSplit) {
			const available = Math.max(0, width - prefixWidth - suffixWidth);
			const rect: LayoutRect = { row: 0, col: prefixWidth, width: available, height: this.#height ?? 0 };
			const geometry: SplitPaneGeometry =
				this.#narrowPane === "right" ? { mode: "narrow", right: rect } : { mode: "narrow", left: rect };
			this.#measureMemo = { width, prefix, divider, suffix, geometry };
			return geometry;
		}

		const desired =
			this.#leftSize.fixed !== undefined
				? this.#leftSize.fixed
				: Math.floor(width * layoutRatio(this.#leftSize.ratio, 0.5));
		const maximumForRight = Math.max(0, splitAvailable - this.#rightMinWidth);
		const leftWidth = Math.max(0, Math.min(leftMaximum, maximumForRight, Math.max(leftMinimum, desired)));
		const rightWidth = Math.max(0, splitAvailable - leftWidth);
		const geometry: SplitPaneGeometry = {
			mode: "split",
			left: { row: 0, col: prefixWidth, width: leftWidth, height: this.#height ?? 0 },
			right: {
				row: 0,
				col: prefixWidth + leftWidth + dividerWidth,
				width: rightWidth,
				height: this.#height ?? 0,
			},
			dividerCol: prefixWidth + leftWidth,
		};
		this.#measureMemo = { width, prefix, divider, suffix, geometry };
		return geometry;
	}

	/** Translate a split-local point into pane-local coordinates. */
	locate(line: number, col: number): SplitPaneHit | undefined {
		const panes: readonly [PaneSide, LayoutContent, LayoutRect | undefined][] = [
			["left", this.#left, this.#lastGeometry.left],
			["right", this.#right, this.#lastGeometry.right],
		];
		for (const [pane, content, rect] of panes) {
			if (!rect) continue;
			if (line < rect.row || line >= rect.row + rect.height || col < rect.col || col >= rect.col + rect.width)
				continue;
			return { pane, content, line: line - rect.row, col: col - rect.col, rect };
		}
		return undefined;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const hit = this.locate(line, col);
		if (hit && isLayoutMouseRoutable(hit.content)) hit.content.routeMouse(event, hit.line, hit.col);
	}

	setIgnoreTight(ignore: boolean): this {
		for (const child of uniqueLayoutComponents([this.#left, this.#right])) child.setIgnoreTight?.(ignore);
		return this;
	}

	invalidate(): void {
		this.#row.invalidate();
		const visibleLeft = this.#lastGeometry.left !== undefined;
		const visibleRight = this.#lastGeometry.right !== undefined;
		if (!visibleLeft && isLayoutComponent(this.#left)) this.#left.invalidate?.();
		if (!visibleRight && isLayoutComponent(this.#right) && this.#right !== this.#left) this.#right.invalidate?.();
	}

	dispose(): void {
		for (const child of uniqueLayoutComponents([this.#left, this.#right])) child.dispose?.();
	}

	render(width: number): readonly string[] {
		const measured = this.measure(width);
		this.#row.setHeight(this.#height);
		if (measured.mode === "split") {
			this.#row.setDecorations(this.#prefix, this.#divider, this.#suffix);
			const leftWidth = measured.left?.width ?? 0;
			if (this.#rowMode !== "split" || leftWidth !== this.#rowLeftWidth) {
				this.#row.setChildren([
					{ content: this.#left, width: leftWidth, align: this.#align },
					{ content: this.#right, grow: 1, minWidth: this.#rightMinWidth, align: this.#align },
				]);
				this.#rowMode = "split";
				this.#rowLeftWidth = leftWidth;
			}
		} else {
			const pane = this.#narrowPane ?? "left";
			if (this.#rowMode !== pane) {
				const content = pane === "right" ? this.#right : this.#left;
				this.#row.setChildren([{ content, grow: 1, align: this.#align }]);
				this.#rowMode = pane;
				this.#rowLeftWidth = -1;
			}
			this.#row.setDecorations(this.#prefix, undefined, this.#suffix);
		}
		const lines = this.#row.render(width);
		if (measured.mode === "split") {
			const left = this.#row.childRect(0);
			const right = this.#row.childRect(1);
			this.#lastGeometry = {
				mode: "split",
				left,
				right,
				dividerCol: left ? left.col + left.width : measured.dividerCol,
			};
		} else {
			const rect = this.#row.childRect(0);
			this.#lastGeometry =
				this.#narrowPane === "right" ? { mode: "narrow", right: rect } : { mode: "narrow", left: rect };
		}
		return lines;
	}
}
