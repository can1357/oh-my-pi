import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import { ScrollView, type ScrollViewTheme } from "./scroll-view";
import { centeredViewportRange, viewportRange } from "./scroll-viewport";

/** Stable identity accepted by {@link TreeView}. Keys must be unique within one hierarchy. */
export type TreeKey = string | number;

/** One ancestor retained on a flattened hierarchy row. */
export interface TreeAncestor<K extends TreeKey> {
	key: K;
	depth: number;
	isLast: boolean;
	siblingCount: number;
}

/** Structural metadata for one item in depth-first display order. */
export interface TreeRow<T, K extends TreeKey> {
	item: T;
	key: K;
	parentKey: K | undefined;
	depth: number;
	index: number;
	siblingIndex: number;
	siblingCount: number;
	isLast: boolean;
	ancestors: readonly TreeAncestor<K>[];
}

/** Controls the iterative hierarchy projection shared by display and interactive trees. */
export interface FlattenTreeOptions<T, K extends TreeKey> {
	roots: readonly T[];
	getKey: (item: T) => K;
	getChildren: (item: T, row: TreeRow<T, K>) => readonly T[];
	/** False omits descendants while retaining the item itself. Defaults to true. */
	isExpanded?: (item: T, row: TreeRow<T, K>) => boolean;
	/** Display depth assigned to roots. Defaults to zero. */
	rootDepth?: number;
	/** Override the display depth inherited by direct children. */
	getChildDepth?: (item: T, row: TreeRow<T, K>, children: readonly T[]) => number;
	/** Stop projection after this many structural items. Omit for no traversal cap. */
	maxItems?: number;
}

/**
 * Ancestors live in a shared parent chain instead of a per-row array: a linear
 * conversation is an n-deep path, and copying the array at every level costs
 * O(n²) memory — 80k-entry sessions exhausted RAM opening `/tree`. Rows build
 * the array lazily, so only rendered rows pay O(depth).
 */
interface AncestorChain<K extends TreeKey> {
	value: TreeAncestor<K>;
	parent: AncestorChain<K> | undefined;
}

function ancestorArray<K extends TreeKey>(chain: AncestorChain<K> | undefined): readonly TreeAncestor<K>[] {
	const out: TreeAncestor<K>[] = [];
	for (let node = chain; node !== undefined; node = node.parent) out.push(node.value);
	return out.reverse();
}

interface PendingTreeRow<T, K extends TreeKey> {
	item: T;
	parentKey: K | undefined;
	depth: number;
	siblingIndex: number;
	siblingCount: number;
	chain: AncestorChain<K> | undefined;
}

interface FlattenTreeResult<T, K extends TreeKey> {
	rows: readonly TreeRow<T, K>[];
	truncated: boolean;
}

function projectTree<T, K extends TreeKey>(options: FlattenTreeOptions<T, K>): FlattenTreeResult<T, K> {
	const rows: TreeRow<T, K>[] = [];
	const roots = options.roots;
	const rootDepth = Math.max(0, Math.trunc(options.rootDepth ?? 0));
	const maxItems =
		options.maxItems === undefined || !Number.isFinite(options.maxItems)
			? Number.POSITIVE_INFINITY
			: Math.max(0, Math.trunc(options.maxItems));
	const stack: PendingTreeRow<T, K>[] = [];
	for (let index = roots.length - 1; index >= 0; index--) {
		stack.push({
			item: roots[index],
			parentKey: undefined,
			depth: rootDepth,
			siblingIndex: index,
			siblingCount: roots.length,
			chain: undefined,
		});
	}

	while (stack.length > 0 && rows.length < maxItems) {
		const pending = stack.pop()!;
		const key = options.getKey(pending.item);
		const chain = pending.chain;
		const row: TreeRow<T, K> = {
			item: pending.item,
			key,
			parentKey: pending.parentKey,
			depth: pending.depth,
			index: rows.length,
			siblingIndex: pending.siblingIndex,
			siblingCount: pending.siblingCount,
			isLast: pending.siblingIndex === pending.siblingCount - 1,
			get ancestors() {
				return ancestorArray(chain);
			},
		};
		rows.push(row);

		if (options.isExpanded && !options.isExpanded(pending.item, row)) continue;
		const children = options.getChildren(pending.item, row);
		if (children.length === 0) continue;
		const childDepth = Math.max(
			0,
			Math.trunc(options.getChildDepth?.(pending.item, row, children) ?? pending.depth + 1),
		);
		const childChain: AncestorChain<K> = {
			value: { key, depth: pending.depth, isLast: row.isLast, siblingCount: pending.siblingCount },
			parent: chain,
		};
		for (let index = children.length - 1; index >= 0; index--) {
			stack.push({
				item: children[index],
				parentKey: key,
				depth: childDepth,
				siblingIndex: index,
				siblingCount: children.length,
				chain: childChain,
			});
		}
	}
	return { rows, truncated: stack.length > 0 };
}

/** First-line and continuation prefixes for a rendered tree item. */
export interface TreePrefix {
	first: string;
	continuation: string;
}

/** Optional symbol styling for {@link treeRowPrefix}. */
export interface TreePrefixStyle {
	connector?: (symbol: string) => string;
	vertical?: (symbol: string) => string;
}

/** Render the conventional three-cell tree gutter for a flattened row. */
export function treeRowPrefix<T, K extends TreeKey>(
	row: TreeRow<T, K>,
	theme: Theme,
	style?: TreePrefixStyle,
): TreePrefix {
	const vertical = style?.vertical ? style.vertical(theme.tree.vertical) : theme.fg("dim", theme.tree.vertical);
	let ancestors = "";
	for (const ancestor of row.ancestors) {
		ancestors += ancestor.isLast ? "   " : `${vertical}  `;
	}
	const connectorSymbol = row.isLast ? theme.tree.last : theme.tree.branch;
	const connector = style?.connector ? style.connector(connectorSymbol) : theme.fg("dim", connectorSymbol);
	const continuation = row.isLast ? "   " : `${vertical}  `;
	return { first: `${ancestors}${connector} `, continuation: `${ancestors}${continuation}` };
}

/** Context supplied while laying out one visible tree row. */
export interface TreeViewRowContext<T, K extends TreeKey> {
	row: TreeRow<T, K>;
	selected: boolean;
	rowIndex: number;
	windowStart: number;
	windowEnd: number;
	windowRows: readonly TreeRow<T, K>[];
	width: number;
	contentWidth: number;
	prefix: TreePrefix;
}

/** Row bodies may be plain lines or an existing component rendered at the remaining width. */
export type TreeViewRowContent = string | readonly string[] | Component;

/** Rendering, filtering, selection, expansion, and budget policy for {@link TreeView}. */
export interface TreeViewOptions<T, K extends TreeKey> extends FlattenTreeOptions<T, K> {
	theme: Theme;
	renderRow: (item: T, context: TreeViewRowContext<T, K>) => TreeViewRowContent;
	filter?: (item: T, row: TreeRow<T, K>) => boolean;
	selectedKey?: K;
	/** Logical rows shown around the selection. Omit to render every filtered row. */
	maxRows?: number;
	/** Strict physical-line budget after multiline row expansion. */
	maxLines?: number;
	/** Defaults to true when `selectedKey` is provided. */
	centerSelection?: boolean;
	/** Custom indentation/gutter geometry. */
	renderPrefix?: (
		row: TreeRow<T, K>,
		context: Omit<TreeViewRowContext<T, K>, "prefix" | "contentWidth" | "selected">,
	) => TreePrefix;
	/** Content before the tree gutter, such as an interactive selection cursor. */
	renderLeading?: (item: T, context: TreeViewRowContext<T, K>) => string;
	/** Applied to every physical line belonging to the selected logical row. */
	styleSelected?: (line: string) => string;
	/** Bound physical rows to `render(width)`. Defaults to true; disable only for formatting adapters. */
	truncateRows?: boolean;
	/** Add a viewport scrollbar when `maxRows` hides logical rows. */
	scrollbar?: boolean;
	scrollbarTheme?: ScrollViewTheme;
}

/** Result of a tree render, including whether a row or line budget omitted content. */
export interface TreeViewRenderResult {
	lines: readonly string[];
	truncated: boolean;
	windowStart: number;
	windowEnd: number;
	totalRows: number;
}

/**
 * Reusable keyed hierarchy component. It keeps flattened and rendered arrays
 * stable by reference until its inputs, selection, filter, or width change.
 */
export class TreeView<T, K extends TreeKey = string> implements Component {
	readonly #options: TreeViewOptions<T, K>;
	#filter: ((item: T, row: TreeRow<T, K>) => boolean) | undefined;
	#selectedKey: K | undefined;
	#selectionAnchor: K | undefined;
	#allRows: readonly TreeRow<T, K>[] = [];
	#rows: readonly TreeRow<T, K>[] = [];
	#rowByKey = new Map<K, TreeRow<T, K>>();
	#visibleIndexByKey = new Map<K, number>();
	#projectionTruncated = false;
	#structureDirty = true;
	#filterDirty = true;
	#version = 0;
	#cache?: { width: number; version: number; result: TreeViewRenderResult };
	#childByKey = new Map<K, Component>();

	constructor(options: TreeViewOptions<T, K>) {
		this.#options = options;
		this.#filter = options.filter;
		this.#selectedKey = options.selectedKey;
		this.#selectionAnchor = options.selectedKey;
	}

	/** Rebuild hierarchy state on the next access and discard rendered lines. */
	invalidate(): void {
		this.#structureDirty = true;
		this.#filterDirty = true;
		for (const child of new Set(this.#childByKey.values())) child.invalidate?.();
		this.#touch();
	}

	dispose(): void {
		for (const child of new Set(this.#childByKey.values())) child.dispose?.();
		this.#childByKey.clear();
	}

	/** Replace the visible-row predicate while retaining the nearest possible selection. */
	setFilter(filter: ((item: T, row: TreeRow<T, K>) => boolean) | undefined): void {
		this.#filter = filter;
		this.#filterDirty = true;
		this.#touch();
	}

	/** Every structural row before filtering. The returned array is immutable and stable until invalidated. */
	get allRows(): readonly TreeRow<T, K>[] {
		this.#ensureRows();
		return this.#allRows;
	}

	/** Filtered rows in navigation order. The returned array is immutable and stable until invalidated. */
	get rows(): readonly TreeRow<T, K>[] {
		this.#ensureRows();
		return this.#rows;
	}

	/** Currently selected key, or undefined for an empty tree. */
	get selectedKey(): K | undefined {
		this.#ensureRows();
		return this.#selectedKey;
	}

	/** Currently selected item, or undefined for an empty tree. */
	get selectedItem(): T | undefined {
		const index = this.selectionIndex;
		return index < 0 ? undefined : this.#rows[index]?.item;
	}

	/** Index in filtered navigation order, or -1 when empty. */
	get selectionIndex(): number {
		this.#ensureRows();
		if (this.#selectedKey === undefined) return -1;
		return this.#visibleIndexByKey.get(this.#selectedKey) ?? -1;
	}

	/** Select a key, walking to its nearest visible ancestor when filtered. */
	setSelectedKey(key: K | undefined): void {
		this.#ensureRows();
		const resolved = this.#nearestVisibleKey(key);
		if (this.#selectedKey === resolved && (resolved === undefined || this.#selectionAnchor === resolved)) return;
		this.#selectedKey = resolved;
		if (resolved !== undefined) this.#selectionAnchor = resolved;
		else if (key !== undefined) this.#selectionAnchor = key;
		this.#touch();
	}

	/** Select a filtered-row index, clamped to the current range. */
	setSelectionIndex(index: number): void {
		this.#ensureRows();
		if (this.#rows.length === 0) {
			this.setSelectedKey(undefined);
			return;
		}
		const clamped = Math.max(0, Math.min(Math.trunc(index), this.#rows.length - 1));
		this.setSelectedKey(this.#rows[clamped]?.key);
	}

	/** Move by logical rows. Wrapping is opt-in for menu-style interaction. */
	moveSelection(delta: number, wrap = false): void {
		this.#ensureRows();
		const count = this.#rows.length;
		if (count === 0) return;
		const current = Math.max(0, this.selectionIndex);
		let next = current + Math.trunc(delta);
		if (wrap) next = ((next % count) + count) % count;
		this.setSelectionIndex(Math.max(0, Math.min(next, count - 1)));
	}

	/** Move to the next row in `direction` satisfying a domain predicate. */
	moveSelectionWhere(predicate: (item: T, row: TreeRow<T, K>) => boolean, direction: -1 | 1): void {
		this.#ensureRows();
		for (let index = this.selectionIndex + direction; index >= 0 && index < this.#rows.length; index += direction) {
			const row = this.#rows[index]!;
			if (predicate(row.item, row)) {
				this.setSelectedKey(row.key);
				return;
			}
		}
	}

	render(width: number): readonly string[] {
		return this.renderWithState(width).lines;
	}

	/** Render lines plus budget/window metadata for adapters that append an ellipsis. */
	renderWithState(width: number): TreeViewRenderResult {
		this.#ensureRows();
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : Number.POSITIVE_INFINITY;
		if (this.#cache?.width === safeWidth && this.#cache.version === this.#version) return this.#cache.result;

		const totalRows = this.#rows.length;
		const maxRows = this.#normalizeBudget(this.#options.maxRows, totalRows);
		const selectedIndex = this.selectionIndex;
		const centerSelection = this.#options.centerSelection ?? this.#selectedKey !== undefined;
		const window =
			centerSelection && selectedIndex >= 0
				? centeredViewportRange(selectedIndex, totalRows, maxRows)
				: viewportRange(totalRows, maxRows, 0);
		const windowStart = window.start;
		const windowEnd = window.end;
		const windowRows = this.#rows.slice(windowStart, windowEnd);
		const maxLines = this.#normalizeBudget(this.#options.maxLines, Number.POSITIVE_INFINITY);
		const lines: string[] = [];
		let truncated = this.#projectionTruncated || windowStart > 0 || windowEnd < totalRows;

		for (let localIndex = 0; localIndex < windowRows.length; localIndex++) {
			const row = windowRows[localIndex]!;
			const rowIndex = windowStart + localIndex;
			const baseContext = {
				row,
				rowIndex,
				windowStart,
				windowEnd,
				windowRows,
				width: safeWidth,
			};
			const prefix = this.#options.renderPrefix?.(row, baseContext) ?? treeRowPrefix(row, this.#options.theme);
			const selected = row.key === this.#selectedKey;
			const provisionalContext: TreeViewRowContext<T, K> = {
				...baseContext,
				selected,
				contentWidth: safeWidth,
				prefix,
			};
			const leading = this.#options.renderLeading?.(row.item, provisionalContext) ?? "";
			const contentWidth = Number.isFinite(safeWidth)
				? Math.max(0, safeWidth - visibleWidth(leading) - visibleWidth(prefix.first))
				: safeWidth;
			const context: TreeViewRowContext<T, K> = { ...baseContext, selected, contentWidth, prefix };
			const rendered = this.#options.renderRow(row.item, context);
			const linesBeforeRow = lines.length;
			let body: readonly string[];
			if (typeof rendered === "string") {
				this.#replaceChild(row.key, undefined);
				body = rendered.length > 0 ? [rendered] : [];
			} else if ("render" in rendered) {
				this.#replaceChild(row.key, rendered);
				body = rendered.render(contentWidth);
			} else {
				this.#replaceChild(row.key, undefined);
				body = rendered;
			}
			if (body.length === 0) continue;

			for (let lineIndex = 0; lineIndex < body.length; lineIndex++) {
				if (lines.length >= maxLines) {
					truncated = true;
					break;
				}
				const gutter = lineIndex === 0 ? prefix.first : prefix.continuation;
				let line = `${leading}${gutter}${replaceTabs(body[lineIndex] ?? "")}`;
				if (selected && this.#options.styleSelected) line = this.#options.styleSelected(line);
				if (this.#options.truncateRows !== false && Number.isFinite(safeWidth))
					line = truncateToWidth(line, safeWidth);
				lines.push(line);
			}
			if (lines.length >= maxLines) {
				if (body.length > lines.length - linesBeforeRow || localIndex < windowRows.length - 1) truncated = true;
				break;
			}
		}

		let renderedLines: readonly string[] = lines;
		if (this.#options.scrollbar && maxRows < totalRows && lines.length > 0 && Number.isFinite(safeWidth)) {
			const viewport = new ScrollView(lines, {
				height: lines.length,
				totalRows,
				scrollbar: "auto",
				theme: this.#options.scrollbarTheme,
			});
			viewport.setScrollOffset(windowStart);
			renderedLines = viewport.render(safeWidth);
		}

		const result: TreeViewRenderResult = { lines: renderedLines, truncated, windowStart, windowEnd, totalRows };
		this.#cache = { width: safeWidth, version: this.#version, result };
		return result;
	}

	#ensureRows(): void {
		if (this.#structureDirty) {
			const projection = projectTree(this.#options);
			this.#allRows = projection.rows;
			this.#projectionTruncated = projection.truncated;
			this.#rowByKey = new Map<K, TreeRow<T, K>>();
			for (const row of this.#allRows) this.#rowByKey.set(row.key, row);
			for (const key of this.#childByKey.keys()) {
				if (!this.#rowByKey.has(key)) this.#replaceChild(key, undefined);
			}
			this.#structureDirty = false;
			this.#filterDirty = true;
		}
		if (!this.#filterDirty) return;
		this.#rows = this.#filter ? this.#allRows.filter(row => this.#filter!(row.item, row)) : this.#allRows;
		this.#visibleIndexByKey = new Map<K, number>();
		for (let index = 0; index < this.#rows.length; index++) {
			this.#visibleIndexByKey.set(this.#rows[index]!.key, index);
		}
		this.#selectedKey = this.#nearestVisibleKey(this.#selectionAnchor);
		if (this.#selectedKey !== undefined) this.#selectionAnchor = this.#selectedKey;
		this.#filterDirty = false;
	}

	#nearestVisibleKey(key: K | undefined): K | undefined {
		if (this.#rows.length === 0) return undefined;
		if (key === undefined) return this.#rows[0]?.key;
		let candidate: K | undefined = key;
		while (candidate !== undefined) {
			if (this.#visibleIndexByKey.has(candidate)) return candidate;
			candidate = this.#rowByKey.get(candidate)?.parentKey;
		}
		return this.#rows[this.#rows.length - 1]?.key;
	}

	#replaceChild(key: K, child: Component | undefined): void {
		const previous = this.#childByKey.get(key);
		if (previous === child) return;
		if (child) this.#childByKey.set(key, child);
		else this.#childByKey.delete(key);
		if (!previous) return;
		for (const retained of this.#childByKey.values()) {
			if (retained === previous) return;
		}
		previous.dispose?.();
	}

	#normalizeBudget(value: number | undefined, fallback: number): number {
		if (value === undefined || !Number.isFinite(value)) return fallback;
		return Math.max(0, Math.trunc(value));
	}

	#touch(): void {
		this.#version++;
		this.#cache = undefined;
	}
}
