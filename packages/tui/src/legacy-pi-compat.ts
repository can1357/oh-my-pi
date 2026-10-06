/**
 * Pi TUI compatibility surface.
 *
 * omp serves extensions that import `@earendil-works/pi-tui` from this package
 * (see the `omp-legacy-pi-bundled:` resolver in the host). A Pi extension that
 * names an export this package lacks fails to load at all, because ESM validates
 * every named import when the module graph is linked — so this module mirrors
 * Pi's names, argument order, and child-descriptor shape rather than pointing at
 * the equivalent internal API.
 *
 * Everything here is an adapter: the layout, width, and terminal work is done by
 * this package's own components. Adding a name here does not add behaviour, and a
 * caller that needs more should call the native API directly.
 *
 * Known divergences from Pi, all bounded by the same input and output width:
 * - `shrink` is accepted and ignored. When slots overflow the granted width this
 *   package's allocator collapses the last ones down to their minimum, where Pi
 *   shrinks every slot in proportion to its `shrink` weight and size.
 * - Rows are padded to the full render width; Pi leaves the trailing gap blank.
 * - `ImageProtocol` and Pi's `StackChild`/`StackEntry`/`StackOptions` type names
 *   are already taken here by different declarations, so they are mirrored under
 *   the `HStack*` names below and `ImageProtocol` stays module-local.
 */
import type { LayoutAlignment } from "./components/layout/geometry";
import { layoutSize } from "./components/layout/geometry";
import { Row, type RowChild } from "./components/layout/row";
import type { DescribeContext, NativeNode } from "./native/node";
import { ImageProtocol as TerminalImageProtocol, TERMINAL } from "./terminal-capabilities";
import type { Component } from "./tui";
import { visibleWidth } from "./utils";

/** Inline-image protocol the terminal supports, or null when it supports none. */
type ImageProtocol = "kitty" | "iterm2" | null;

/** What the terminal can be asked to draw. */
export interface TerminalCapabilities {
	/** Inline-image protocol, or null when the terminal draws no inline images. */
	images: ImageProtocol;
	/** 24-bit colour support. */
	trueColor: boolean;
	/** OSC 8 hyperlink support. */
	hyperlinks: boolean;
}

/** The resolved capabilities of the terminal this process is attached to. */
export function getCapabilities(): TerminalCapabilities {
	// This package keys its protocol enum on the escape prefix that introduces a
	// placement sequence; Pi names the protocol itself. Sixel has no Pi
	// equivalent, so it reports as no inline-image support.
	const protocol = TERMINAL.imageProtocol;
	const images =
		protocol === TerminalImageProtocol.Kitty ? "kitty" : protocol === TerminalImageProtocol.Iterm2 ? "iterm2" : null;
	return { images, trueColor: TERMINAL.trueColor, hyperlinks: TERMINAL.hyperlinks };
}

/**
 * A Kitty graphics id in `[1, 0xfffffffe]`.
 *
 * Random rather than sequential: two copies of a plugin in one process would
 * otherwise hand the terminal the same id for two different images and the
 * second placement would replace the first.
 */
export function allocateImageId(): number {
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/** The rectangle a stack child is measured against, in Pi's shape. */
export interface LayoutViewport {
	/** Columns the whole stack is being rendered at. */
	width: number;
	/** Rows available; a horizontal stack is never height-constrained. */
	height: number;
}

/** Sizing for one {@link HStack} child, in Pi's flexbox-like descriptor shape. */
export interface HStackChildOptions {
	/** Width this slot starts from, or `"auto"` to measure the child. */
	basis?: number | "auto";
	/** Share of the leftover width this slot takes. */
	grow?: number;
	/** Accepted for compatibility; this package's allocator does not shrink. */
	shrink?: number;
	/** Lower bound in columns. */
	minSize?: number;
	/** Upper bound in columns. */
	maxSize?: number;
	/** Render this slot only while the predicate holds. */
	visible?: (viewport: LayoutViewport) => boolean;
}

/** One measured child of an {@link HStack}. */
export interface HStackEntry extends HStackChildOptions {
	/** The component rendered in this slot. */
	component: Component;
}

/** A child of an {@link HStack}: a bare component, or one carrying sizing. */
export type HStackChild = Component | HStackEntry;

/** Construction options for {@link HStack}. */
export interface HStackOptions {
	/** Columns inserted between adjacent children. Defaults to 0. */
	gap?: number;
	/** Vertical alignment of shorter children against the tallest. */
	align?: "stretch" | "start" | "center" | "end";
}

const isEntry = (child: HStackChild): child is HStackEntry => !("render" in child);

/** Normalize an optional size the way Pi's stack constructor does. */
const normalizeSize = (value: number | undefined): number =>
	value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));

/** Pi's `"stretch"` and this package's `"start"` both bottom-pad to the row. */
const toAlignment = (align: HStackOptions["align"]): LayoutAlignment =>
	align === "center" || align === "end" ? align : "start";

/** Bounds an entry may be laid out within, with Pi's max-wins-over-min rule. */
const entryBounds = (entry: HStackEntry): { minWidth?: number; maxWidth?: number } => {
	const minWidth = normalizeSize(entry.minSize);
	if (entry.maxSize === undefined) return entry.minSize === undefined ? {} : { minWidth };
	return { minWidth, maxWidth: Math.max(minWidth, Math.floor(entry.maxSize)) };
};

/**
 * One entry as a row child, starting `basis` columns wide.
 *
 * A growing slot cannot be pinned to a width or it would never grow, so its
 * clamped start becomes the floor the row allocator hands out — which is exactly
 * the width Pi's own allocator gives it before distributing the leftover.
 */
const toRowChild = (entry: HStackEntry, basis: number): RowChild => {
	const bounds = entryBounds(entry);
	const minimum = bounds.minWidth ?? 0;
	const maximum = bounds.maxWidth ?? Number.MAX_SAFE_INTEGER;
	const initial = Math.min(maximum, Math.max(minimum, normalizeSize(basis)));
	const grow = normalizeSize(entry.grow);
	if (grow > 0) return { content: entry.component, grow, ...bounds, minWidth: initial };
	return { content: entry.component, ...bounds, width: initial };
};

/** One entry as a row child sized by content, for the native description. */
const toContentRowChild = (entry: HStackEntry): RowChild => ({
	content: entry.component,
	...(entry.grow === undefined ? {} : { grow: normalizeSize(entry.grow) }),
	...entryBounds(entry),
});

/** Natural width of a child rendered at `available`, in columns. */
const intrinsicWidth = (component: Component, available: number): number => {
	let width = 0;
	for (const line of component.render(available)) width = Math.max(width, visibleWidth(line));
	return width;
};

/**
 * Horizontal layout: children side by side, sized by Pi's stack descriptors.
 *
 * Each frame re-evaluates {@link HStackChildOptions.visible} against the width
 * actually granted, so a child can appear and disappear as the terminal resizes
 * without the parent rebuilding the stack. A child with no `basis` is measured at
 * the granted width and laid out at its natural size, as in Pi.
 */
export class HStack implements Component {
	readonly #gap: string;
	readonly #row: Row;
	#entries: HStackEntry[] = [];

	constructor(children: readonly HStackChild[] = [], options: HStackOptions = {}) {
		const gap = normalizeSize(options.gap);
		this.#gap = gap > 0 ? " ".repeat(gap) : "";
		this.#row = new Row({ children: [], gap: this.#gap, align: toAlignment(options.align) });
		for (const child of children) {
			if (isEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	/** The components currently held by the stack, in layout order. */
	get children(): readonly Component[] {
		return this.#entries.map(entry => entry.component);
	}

	/** Append a child, optionally with Pi's sizing descriptor. */
	addChild(component: Component, options: HStackChildOptions = {}): void {
		this.#entries.push({ component, ...options });
		this.#syncRow();
	}

	/** Detach a child, matching by component identity. */
	removeChild(component: Component): void {
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index === -1) return;
		this.#entries.splice(index, 1);
		this.#syncRow();
	}

	/** Detach every child. */
	clear(): void {
		this.#entries = [];
		this.#syncRow();
	}

	setIgnoreTight(ignore: boolean): this {
		this.#row.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		this.#row.invalidate();
	}

	dispose(): void {
		this.#row.dispose();
	}

	/**
	 * The row's own native description. A width-dependent `visible` predicate
	 * cannot be expressed in a native node, so a stack carrying one falls back to
	 * rendering its rows; so does a stack with nothing in it.
	 */
	describe(cx: DescribeContext): NativeNode | null {
		if (this.#entries.length === 0 || this.#entries.some(entry => entry.visible !== undefined)) return null;
		this.#syncRow();
		return this.#row.describe(cx);
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, layoutSize(width));
		const viewport: LayoutViewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		const visible = this.#entries.filter(entry => entry.visible?.(viewport) ?? true);
		if (visible.length === 0) return [];
		this.#row.setChildren(
			visible.map(entry =>
				entry.basis === undefined || entry.basis === "auto"
					? toRowChild(entry, intrinsicWidth(entry.component, safeWidth))
					: toRowChild(entry, entry.basis),
			),
		);
		return this.#row.render(safeWidth);
	}

	/**
	 * Push the current entries into the row without measuring, leaving `basis`
	 * unset so the native description sizes those slots by content.
	 */
	#syncRow(): void {
		this.#row.setChildren(this.#entries.map(entry => toContentRowChild(entry)));
	}
}
