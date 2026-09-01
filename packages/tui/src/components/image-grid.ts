import { getKittyGraphics } from "../kitty-graphics";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Component } from "../tui";
import { padding, truncateToWidth, visibleWidth } from "../utils";

const DEFAULT_GAP = 2;
const DEFAULT_ROW_GAP = 1;
const DEFAULT_MIN_COLUMN_WIDTH = 32;
const DEFAULT_MAX_COLUMNS = 4;

export interface ImageGridOptions {
	/** Number of terminal cells between columns. */
	gap?: number;
	/** Number of blank rows between grid rows. */
	rowGap?: number;
	/** Minimum width required before another column is added. */
	minColumnWidth?: number;
	/** Maximum number of columns. */
	maxColumns?: number;
	/** Optional callback invoked with the clicked child image index. */
	onClick?: (index: number) => void;
}

interface KittyPlaceholderAware {
	canRenderAsKittyPlaceholders?: (width: number) => boolean;
}

interface MouseTargetAware {
	hasMouseTargets?: () => boolean;
	routeMouse?: (event: SgrMouseEvent, line: number, col: number) => boolean | void;
}

interface ChildLayout {
	child: Component;
	index: number;
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * Render image components in a responsive contact sheet.
 *
 * Kitty Unicode placeholders are ordinary text-cell output, so they can be
 * composed horizontally without losing placement or scrollback accounting.
 * Cursor-positioned image protocols cannot be safely spliced into a row: the
 * TUI's image pipeline needs to see each placement as a complete frame line.
 * Those paths deliberately use this component's vertical layout instead.
 */
export class ImageGrid implements Component, MouseRoutable {
	readonly children: readonly Component[];
	#gap: number;
	#rowGap: number;
	#minColumnWidth: number;
	#maxColumns: number;
	#onClick?: (index: number) => void;
	#layouts: ChildLayout[] = [];

	constructor(children: readonly Component[], options: ImageGridOptions = {}) {
		this.children = [...children];
		this.#gap = normalizeInteger(options.gap, DEFAULT_GAP, 0);
		this.#rowGap = normalizeInteger(options.rowGap, DEFAULT_ROW_GAP, 0);
		this.#minColumnWidth = normalizeInteger(options.minColumnWidth, DEFAULT_MIN_COLUMN_WIDTH, 1);
		this.#maxColumns = normalizeInteger(options.maxColumns, DEFAULT_MAX_COLUMNS, 1);
		this.#onClick = options.onClick;
	}

	setIgnoreTight(ignore: boolean): this {
		for (const child of this.children) child.setIgnoreTight?.(ignore);
		return this;
	}

	hasMouseTargets(): boolean {
		if (TERMINAL.imageProtocol === null) return false;
		if (this.#onClick !== undefined) return true;
		return this.children.some(child => this.#hasMouseTargets(child));
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		const target = this.#layouts.find(
			layout =>
				line >= layout.top &&
				line < layout.top + layout.height &&
				col >= layout.left &&
				col < layout.left + layout.width &&
				(this.#onClick !== undefined || this.#hasMouseTargets(layout.child)),
		);
		if (!target) return false;
		if (event.leftClick && this.#onClick !== undefined) {
			this.#onClick(target.index);
			return true;
		}
		const child = target.child as Component & MouseTargetAware;
		if (child.routeMouse === undefined) return false;
		const routed = child.routeMouse(event, line - target.top, col - target.left);
		return routed !== false;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.children) child.dispose?.();
	}

	render(width: number): readonly string[] {
		this.#layouts = [];
		if (this.children.length === 0) return [];
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const columns = this.#columnCount(safeWidth);
		if (!this.#canComposeHorizontally(safeWidth, columns)) return this.#renderStack(safeWidth);

		const tileWidth = Math.max(1, Math.floor((safeWidth - this.#gap * (columns - 1)) / columns));
		const output: string[] = [];
		for (let start = 0; start < this.children.length; start += columns) {
			const rowChildren = this.children.slice(start, start + columns);
			const rowLines = rowChildren.map(child => child.render(tileWidth));
			const rowTop = output.length;
			for (let column = 0; column < rowLines.length; column++) {
				const lines = rowLines[column]!;
				this.#layouts.push({
					child: rowChildren[column]!,
					index: start + column,
					top: rowTop,
					left: column * (tileWidth + this.#gap),
					width: tileWidth,
					height: lines.length,
				});
			}
			const rowHeight = Math.max(...rowLines.map(lines => lines.length), 0);

			for (let row = 0; row < rowHeight; row++) {
				let line = "";
				for (let column = 0; column < rowLines.length; column++) {
					if (column > 0) line += padding(this.#gap);
					const childLine = rowLines[column]?.[row] ?? "";
					const fittedLine =
						visibleWidth(childLine) > tileWidth ? truncateToWidth(childLine, tileWidth, "") : childLine;
					line += fittedLine;
					line += padding(Math.max(0, tileWidth - visibleWidth(fittedLine)));
				}
				line += padding(Math.max(0, safeWidth - visibleWidth(line)));
				output.push(line);
			}

			if (start + columns < this.children.length) {
				for (let gap = 0; gap < this.#rowGap; gap++) output.push("");
			}
		}
		return output;
	}

	#columnCount(width: number): number {
		let columns = Math.min(this.children.length, this.#maxColumns);
		while (columns > 1 && columns * this.#minColumnWidth + (columns - 1) * this.#gap > width) {
			columns--;
		}
		return Math.max(1, columns);
	}

	#canComposeHorizontally(width: number, columns: number): boolean {
		const protocol = TERMINAL.imageProtocol;
		if (protocol !== null && (protocol !== ImageProtocol.Kitty || !getKittyGraphics().unicodePlaceholders)) {
			return false;
		}
		const tileWidth = Math.max(1, Math.floor((width - this.#gap * (columns - 1)) / columns));
		if (protocol === ImageProtocol.Kitty && getKittyGraphics().unicodePlaceholders) {
			return this.children.every(child => {
				const probe = child as KittyPlaceholderAware;
				return (
					probe.canRenderAsKittyPlaceholders !== undefined &&
					probe.canRenderAsKittyPlaceholders(tileWidth) === true
				);
			});
		}
		return true;
	}

	#renderStack(width: number): string[] {
		const output: string[] = [];
		for (let index = 0; index < this.children.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.#rowGap; gap++) output.push("");
			}
			const child = this.children[index]!;
			const top = output.length;
			const lines = child.render(width);
			this.#layouts.push({ child, index, top, left: 0, width, height: lines.length });
			output.push(...lines);
		}
		return output;
	}

	#hasMouseTargets(child: Component): boolean {
		const target = child as Component & MouseTargetAware;
		return target.hasMouseTargets?.() === true;
	}
}

function normalizeInteger(value: number | undefined, fallback: number, minimum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.trunc(value));
}
