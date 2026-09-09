import type { Component } from "../tui";
import {
	getPaddingX,
	getPublishedLineWidths,
	getWidthConfigEpoch,
	padding,
	publishLineWidths,
	visibleWidth,
} from "../utils";

type Cache = {
	width: number;
	widthEpoch: number;
	bgSample: string | undefined;
	borderSample: string | undefined;
	childLines: (readonly string[])[];
	childWidths: (readonly number[] | undefined)[];
	childSnapshots: (readonly string[] | undefined)[];
	result: string[];
};

/** Box-drawing glyphs plus an optional colorizer for an outline drawn around a {@link Box}. */
export interface BoxBorder {
	chars: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	color?: (text: string) => string;
}

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;
	#border?: BoxBorder;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.#invalidateCache();
		return this;
	}

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string, border?: BoxBorder) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
		this.#border = border;
	}
	/** Return container layout and child-count state for debug inspection. */
	debugState(): Record<string, unknown> {
		return {
			childCount: this.children.length,
			paddingX: this.#paddingX,
			paddingY: this.#paddingY,
			bordered: this.#border !== undefined,
			ignoreTight: this.#ignoreTight,
		};
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.#invalidateCache();
	}

	setPaddingX(paddingX: number): void {
		if (this.#paddingX === paddingX) return;
		this.#paddingX = paddingX;
		this.#invalidateCache();
	}

	setPaddingY(paddingY: number): void {
		if (this.#paddingY === paddingY) return;
		this.#paddingY = paddingY;
		this.#invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setBorder(border?: BoxBorder): void {
		this.#border = border;
		this.#invalidateCache();
	}

	#invalidateCache(): void {
		this.#cached = undefined;
	}

	invalidate(): void {
		this.#invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): readonly string[] {
		const children = this.children;
		const count = children.length;
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		// A border eats one column on each side; skip it unless the interior can still
		// hold the horizontal padding plus at least one content column, so a bordered
		// Box never overflows the width it was given.
		const border = this.#border && width - 2 >= paddingX * 2 + 1 ? this.#border : undefined;
		const innerWidth = border ? width - 2 : width;
		const contentWidth = Math.max(1, innerWidth - paddingX * 2);
		// bgFn / border output can change without the function reference changing
		// (theme mutation); sample both so a silent palette swap still misses the cache.
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;
		const borderSample = border
			? `${border.color ? border.color("|") : "|"}${border.chars.topLeft}${border.chars.vertical}`
			: undefined;

		// Render every child every frame (renders may carry side effects); the
		// memo only skips re-deriving the padded/background rows.
		const widthEpoch = getWidthConfigEpoch();
		let contentRows = 0;
		const childLines = children.map(child => {
			const lines = child.render(contentWidth);
			contentRows += lines.length;
			return lines;
		});
		const childWidths = childLines.map(lines => getPublishedLineWidths(lines));
		const cached = this.#cached;
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.widthEpoch === widthEpoch &&
			cached.widthEpoch === getWidthConfigEpoch() &&
			cached.bgSample === bgSample &&
			cached.borderSample === borderSample &&
			cached.childLines.length === count &&
			childLines.every((lines, i) => {
				if (cached.childLines[i] !== lines) return false;
				const published = childWidths[i];
				const cachedPublished = cached.childWidths[i];
				if (published !== undefined || cachedPublished !== undefined) {
					return published === cachedPublished;
				}
				const snapshot = cached.childSnapshots[i];
				return (
					snapshot !== undefined &&
					snapshot.length === lines.length &&
					lines.every((line, j) => snapshot[j] === line)
				);
			})
		) {
			return cached.result;
		}

		const result: string[] = [];
		// Exact visible widths of `result` rows, published only when the row
		// bytes are `content + spaces` (no bg/border transform of unknown width).
		const resultWidths: number[] | undefined = !border && !this.#bgFn ? [] : undefined;
		if (contentRows > 0) {
			const leftPad = padding(paddingX);
			const interior: string[] = [];
			const pushRow = (row: string, visLen: number): void => {
				const padNeeded = Math.max(0, innerWidth - visLen);
				const padded = padNeeded > 0 ? row + padding(padNeeded) : row;
				interior.push(this.#bgFn ? this.#bgFn(padded) : padded);
				resultWidths?.push(visLen + padNeeded);
			};
			// Top padding
			for (let i = 0; i < this.#paddingY; i++) {
				pushRow("", 0);
			}
			// Content
			let childIndex = 0;
			for (const lines of childLines) {
				const widths = childWidths[childIndex++];
				for (let j = 0; j < lines.length; j++) {
					const line = lines[j] ?? "";
					const row = paddingX > 0 ? leftPad + line : line;
					const carried = widths?.[j];
					const visLen = carried !== undefined && paddingX === 0 ? carried : visibleWidth(row);
					pushRow(row, visLen);
				}
			}
			// Bottom padding
			for (let i = 0; i < this.#paddingY; i++) {
				pushRow("", 0);
			}

			if (border) {
				const paint = border.color ?? (s => s);
				const rule = border.chars.horizontal.repeat(Math.max(0, innerWidth));
				const side = paint(border.chars.vertical);
				result.push(paint(border.chars.topLeft + rule + border.chars.topRight));
				for (const row of interior) {
					result.push(side + row + side);
				}
				result.push(paint(border.chars.bottomLeft + rule + border.chars.bottomRight));
			} else {
				for (const row of interior) {
					result.push(row);
				}
			}
		}

		const finalWidthEpoch = getWidthConfigEpoch();
		if (resultWidths !== undefined) publishLineWidths(result, resultWidths);
		const childSnapshots = childLines.map((lines, i) => (childWidths[i] === undefined ? [...lines] : undefined));
		this.#cached = {
			width,
			widthEpoch: finalWidthEpoch,
			bgSample,
			borderSample,
			childLines,
			childWidths,
			childSnapshots,
			result,
		};
		return result;
	}
}
