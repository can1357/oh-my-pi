/**
 * Shared box-drawing chrome for overlays — string helpers for fullscreen
 * surfaces (the `/copy` picker, the plan-review overlay, …) and the
 * {@link OverlayPanel} container for inline overlays hosted in the editor slot
 * or an anchored container. Everything paints with `theme.boxRound` glyphs
 * (rounded corners, sharp tee/cross junctions) and the `border`/`accent` theme
 * colors so all outlined overlays read identically.
 */
import { type Component, visibleWidth } from "../tui";
import { Ellipsis, truncateToWidth } from "../utils";
import { padToWidth } from "../render/utils";
import { type ThemeColor, theme } from "../theme/index";

function paint(s: string, color: ThemeColor = "border"): string {
	return theme.fg(color, s);
}

/** Top border with an optional title inset into the rule. `color` recolors border and title (default border/accent). */
export function topBorder(width: number, title: string, color?: ThemeColor): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight, color);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal, color) +
		theme.bold(theme.fg(color ?? "accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight, color)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number): string {
	const box = theme.boxRound;
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number, color?: ThemeColor): string {
	const box = theme.boxRound;
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight, color);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number, color?: ThemeColor): string {
	const box = theme.boxRound;
	return `${paint(box.vertical, color)} ${width > 4 ? padToWidth(content, width - 4) : ""} ${paint(box.vertical, color)}`;
}

/**
 * Column index (0-based) of the inner divider for a two-column layout whose
 * sidebar content area is `sidebarWidth` columns wide. The layout is
 * `│ sidebar │ body │` with a single-column inset on every side, so the divider
 * vertical sits at `sidebarWidth + 3` and the body content area is
 * {@link splitBodyWidth} columns.
 */
function splitDividerCol(sidebarWidth: number): number {
	return sidebarWidth + 3;
}

/** Body content width for a two-column overlay of total `width`. */
export function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

/** Top border carrying the title, split by a `┬` over the column divider. */
export function topBorderSplit(width: number, title: string, sidebarWidth: number): string {
	const box = theme.boxRound;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	let left: string;
	if (!title) {
		left = paint(box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth));
	}
	return left + paint(box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
}

/** Section rule that closes the sidebar column with a `┴` over the divider. */
export function dividerSplit(width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	return paint(
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

/** A two-column content row: `│ sidebar │ body │`, each inset by one column. */
export function splitRow(sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	const bodyWidth = splitBodyWidth(width, sidebarWidth);
	const bar = paint(box.vertical);
	return `${bar} ${sidebarWidth > 0 ? padToWidth(sidebar, sidebarWidth) : ""} ${bar} ${bodyWidth > 0 ? padToWidth(body, bodyWidth) : ""} ${bar}`;
}

const NO_LINES: readonly string[] = [];

interface PanelRowsMemo {
	width: number;
	height: number | undefined;
	lines: readonly string[];
	result: readonly string[];
}

/**
 * Mutable row region for composing an {@link OverlayPanel}. Callers provide
 * already-styled logical rows and may pin the region to an exact height; extra
 * rows are clipped and missing rows are filled. This keeps dialog body budgets
 * in the layout component instead of duplicating border and padding math in
 * every overlay.
 */
export class PanelRows implements Component {
	#lines: readonly string[] = NO_LINES;
	#height: number | undefined;
	#memo: PanelRowsMemo | undefined;

	/** Replace the region rows. Byte-identical rows retain the previous render identity. */
	setLines(lines: readonly string[]): void {
		if (
			lines === this.#lines ||
			(lines.length === this.#lines.length && lines.every((line, index) => line === this.#lines[index]))
		) {
			return;
		}
		this.#lines = lines;
		this.#memo = undefined;
	}

	/** Pin the region to exactly `height` rows, or pass `undefined` for its natural height. */
	setHeight(height: number | undefined): void {
		const next = height === undefined ? undefined : Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		if (next === this.#height) return;
		this.#height = next;
		this.#memo = undefined;
	}

	invalidate(): void {
		this.#memo = undefined;
	}

	render(width: number): readonly string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const memo = this.#memo;
		if (
			memo !== undefined &&
			memo.width === safeWidth &&
			memo.height === this.#height &&
			memo.lines === this.#lines
		) {
			return memo.result;
		}

		const rowCount = this.#height ?? this.#lines.length;
		const result: string[] = [];
		for (let index = 0; index < rowCount; index++) {
			const line = this.#lines[index] ?? "";
			result.push(visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth) : line);
		}
		this.#memo = { width: safeWidth, height: this.#height, lines: this.#lines, result };
		return result;
	}
}

/** Sentinel child rendered by {@link OverlayPanel} as a `├───┤` section rule. */
export class PanelDivider implements Component {
	render(): readonly string[] {
		return NO_LINES;
	}
}

interface OverlayPanelMemo {
	width: number;
	title: string;
	children: Component[];
	childLines: (readonly string[])[];
	result: string[];
}

/** Titles inset into a single border row must never carry line breaks. */
function collapseTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

/**
 * Rounded-box container for inline overlays (selectors, run panels). Children
 * render inside `│ … │` rows between a titled top border and a bottom border,
 * so inline overlays share the chrome of fullscreen overlays. The top border
 * is exactly one row — `routeMouse` offsets written for a one-line top rule
 * stay valid — and content is inset two columns on each side.
 */
export class OverlayPanel implements Component {
	children: Component[] = [];
	#title: string;
	#memo: OverlayPanelMemo | undefined;

	constructor(title = "") {
		this.#title = collapseTitle(title);
	}

	get title(): string {
		return this.#title;
	}

	set title(value: string) {
		const next = collapseTitle(value);
		if (next === this.#title) return;
		this.#title = next;
		this.#memo = undefined;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#memo = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		this.children.splice(index, 1);
		this.#memo = undefined;
	}

	clear(): void {
		this.children = [];
		this.#memo = undefined;
	}

	invalidate(): void {
		this.#memo = undefined;
		for (const child of this.children) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.children) child.dispose?.();
	}

	setIgnoreTight(ignore: boolean): this {
		for (const child of this.children) child.setIgnoreTight?.(ignore);
		return this;
	}

	/**
	 * Body rows at the given content width, without border chrome —
	 * {@link render} draws exactly these (4 columns narrower) inside `│ … │`
	 * rows. Lets callers and tests assert on component-content coordinates
	 * instead of reverse-parsing box glyphs. `PanelDivider` children contribute
	 * no rows here (their rule is border chrome).
	 */
	renderContent(width: number): string[] {
		const result: string[] = [];
		for (const child of this.children) {
			if (child instanceof PanelDivider) continue;
			result.push(...child.render(width));
		}
		return result;
	}

	render(width: number): readonly string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const innerWidth = Math.max(1, width - 4);
		// Children render every frame (renders may carry side effects); the memo
		// only skips re-wrapping unchanged rows in border chrome.
		const childLines = this.children.map(child =>
			child instanceof PanelDivider ? NO_LINES : child.render(innerWidth),
		);
		const memo = this.#memo;
		if (
			memo !== undefined &&
			memo.width === width &&
			memo.title === this.#title &&
			memo.children.length === this.children.length &&
			this.children.every((child, i) => memo.children[i] === child && memo.childLines[i] === childLines[i])
		) {
			return memo.result;
		}
		const result: string[] = [topBorder(width, this.#title)];
		for (let i = 0; i < this.children.length; i++) {
			if (this.children[i] instanceof PanelDivider) {
				result.push(divider(width));
				continue;
			}
			for (const line of childLines[i] ?? NO_LINES) result.push(row(line, width));
		}
		result.push(bottomBorder(width));
		if (width < 4) {
			for (let index = 0; index < result.length; index++) {
				result[index] = truncateToWidth(result[index]!, width, Ellipsis.Omit);
			}
		}
		this.#memo = { width, title: this.#title, children: [...this.children], childLines, result };
		return result;
	}
}
