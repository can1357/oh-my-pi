import type { MouseRoutable } from "../../mouse";
import type { Component } from "../../tui";
import { padding, truncateToWidth, visibleWidth } from "../../utils";

/** Alignment within space allocated by a layout component. */
export type LayoutAlignment = "start" | "center" | "end";

/** Insets reserved inside a layout child's allocated rectangle. */
export interface LayoutInsets {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Insets normalized to finite, non-negative terminal-cell counts. */
export interface NormalizedLayoutInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** Rectangle in coordinates local to a layout component. */
export interface LayoutRect {
	row: number;
	col: number;
	width: number;
	height: number;
}

/** Lazy layout child, evaluated only when the child is visible. */
export type LayoutRenderer = (width: number, height: number | undefined) => readonly string[];

/** A concrete component or a lazy renderer used as a layout child. */
export type LayoutContent = Component | LayoutRenderer;

/** Static text or a late-bound layout decoration, useful for theme-colored rules. */
export type LayoutDecoration = string | (() => string);

/** A component whose parent may assign a local row budget before rendering. */
export interface HeightConstrainedComponent extends Component {
	setHeight(height: number | undefined): void;
}

/** One fixed or growing constraint consumed by {@link allocateLayoutSpace}. */
export interface LayoutAllocation {
	fixed?: number;
	grow?: number;
	min?: number;
	max?: number;
}

/** Clamp an external size to a finite, non-negative integer cell count. */
export function layoutSize(value: number | undefined, fallback = 0): number {
	const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Number.isFinite(resolved) ? Math.max(0, Math.floor(resolved)) : 0;
}

/** Normalize an optional external size while preserving `undefined`. */
export function optionalLayoutSize(value: number | undefined): number | undefined {
	return value === undefined ? undefined : layoutSize(value);
}

/** Clamp a proportional layout input to a finite, non-negative number. */
export function layoutRatio(value: number | undefined, fallback: number): number {
	const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Number.isFinite(resolved) ? Math.max(0, resolved) : 0;
}

/** Resolve static or late-bound layout decoration text. */
export function layoutDecorationText(decoration: LayoutDecoration | undefined): string {
	return typeof decoration === "function" ? decoration() : (decoration ?? "");
}

function allocationMaximum(item: LayoutAllocation): number {
	return item.max === undefined ? Number.MAX_SAFE_INTEGER : Math.max(layoutSize(item.min), layoutSize(item.max));
}

/**
 * Allocate bounded integer cells across fixed and growing children. When the
 * minimums cannot fit, later children collapse first so output stays bounded.
 */
export function allocateLayoutSpace(items: readonly LayoutAllocation[], available: number): number[] {
	available = layoutSize(available);
	const sizes = items.map(item => {
		const minimum = layoutSize(item.min);
		const maximum = allocationMaximum(item);
		return item.fixed === undefined ? minimum : Math.max(minimum, Math.min(maximum, layoutSize(item.fixed)));
	});
	const used = sizes.reduce((sum, size) => sum + size, 0);
	if (used > available) {
		let overflow = used - available;
		for (let index = sizes.length - 1; index >= 0 && overflow > 0; index--) {
			const reduction = Math.min(sizes[index] ?? 0, overflow);
			sizes[index] = (sizes[index] ?? 0) - reduction;
			overflow -= reduction;
		}
		return sizes;
	}

	let remaining = available - used;
	let flexible = items
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => item.fixed === undefined && layoutSize(item.grow) > 0);
	while (remaining > 0 && flexible.length > 0) {
		const totalWeight = flexible.reduce((sum, { item }) => sum + layoutSize(item.grow), 0);
		let granted = 0;
		for (const { item, index } of flexible) {
			const maximum = allocationMaximum(item);
			const capacity = maximum - (sizes[index] ?? 0);
			if (capacity <= 0) continue;
			const proportional = Math.floor((remaining * layoutSize(item.grow)) / totalWeight);
			const share = Math.min(capacity, Math.max(1, proportional), remaining - granted);
			if (share <= 0) continue;
			sizes[index] = (sizes[index] ?? 0) + share;
			granted += share;
			if (granted === remaining) break;
		}
		if (granted === 0) break;
		remaining -= granted;
		flexible = flexible.filter(({ item, index }) => {
			const maximum = allocationMaximum(item);
			return (sizes[index] ?? 0) < maximum;
		});
	}
	return sizes;
}

/** Normalize every inset to a finite, non-negative integer cell count. */
export function layoutInsets(insets: LayoutInsets | undefined): NormalizedLayoutInsets {
	return {
		top: layoutSize(insets?.top),
		right: layoutSize(insets?.right),
		bottom: layoutSize(insets?.bottom),
		left: layoutSize(insets?.left),
	};
}

/** Compare optional inset objects by their normalized terminal geometry. */
export function equalLayoutInsets(left: LayoutInsets | undefined, right: LayoutInsets | undefined): boolean {
	return (
		layoutSize(left?.top) === layoutSize(right?.top) &&
		layoutSize(left?.right) === layoutSize(right?.right) &&
		layoutSize(left?.bottom) === layoutSize(right?.bottom) &&
		layoutSize(left?.left) === layoutSize(right?.left)
	);
}

/** Offset content within spare cells according to an alignment. */
export function layoutAlignmentOffset(space: number, alignment: LayoutAlignment): number {
	if (space <= 0 || alignment === "start") return 0;
	return alignment === "end" ? space : Math.floor(space / 2);
}

/** Narrow a concrete-or-lazy child to a concrete component. */
export function isLayoutComponent(content: LayoutContent): content is Component {
	return typeof content !== "function";
}

/** Narrow a layout child to a component accepting a row budget. */
export function isHeightConstrainedComponent(content: LayoutContent): content is HeightConstrainedComponent {
	return isLayoutComponent(content) && "setHeight" in content && typeof content.setHeight === "function";
}

/** Narrow a layout child to a mouse-routable component. */
export function isLayoutMouseRoutable(content: LayoutContent): content is Component & MouseRoutable {
	return isLayoutComponent(content) && "routeMouse" in content && typeof content.routeMouse === "function";
}

/** Return concrete children once each, preserving their first layout order. */
export function uniqueLayoutComponents(contents: readonly LayoutContent[]): readonly Component[] {
	const seen = new Set<Component>();
	const components: Component[] = [];
	for (const content of contents) {
		if (!isLayoutComponent(content) || seen.has(content)) continue;
		seen.add(content);
		components.push(content);
	}
	return components;
}

/** Fit one ANSI-styled row to an exact terminal-cell width. */
export function fitLayoutLine(line: string, width: number): string {
	width = layoutSize(width);
	if (width === 0) return "";
	const lineWidth = visibleWidth(line);
	const clipped = lineWidth > width ? truncateToWidth(line, width) : line;
	const clippedWidth = lineWidth > width ? visibleWidth(clipped) : lineWidth;
	return clipped + padding(Math.max(0, width - clippedWidth));
}

/** Render a concrete or lazy child with an optional local height budget. */
export function renderLayoutContent(
	content: LayoutContent,
	width: number,
	height: number | undefined,
): readonly string[] {
	if (typeof content === "function") return content(layoutSize(width), optionalLayoutSize(height));
	if (isHeightConstrainedComponent(content)) content.setHeight(optionalLayoutSize(height));
	return content.render(layoutSize(width));
}
