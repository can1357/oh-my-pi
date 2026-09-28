import { popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { getMenuWindow, MenuSelection } from "./menu-selection";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { type MouseRoutable, routeSelectListMouse, type SgrMouseEvent } from "../mouse";
import type { SymbolTheme } from "../symbols";
import type { Component } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { ScrollView } from "./scroll-view";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const DEFAULT_CURSOR_SYMBOL = ">";

function sanitizeSingleLine(text: string): string {
	return replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/** Optional type-indicator glyph rendered in an aligned column before the label */
	icon?: string;
	/** Dim hint text shown inline after cursor when this item is selected */
	hint?: string;
	/** Disabled rows stay visible but are skipped by navigation and cannot activate. */
	disabled?: boolean;
	/** When set, activation requires a second Enter/click and this text becomes the status line. */
	confirmation?: string;
	/** Additional text included by the default fuzzy filter without being rendered. */
	searchText?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
	/** Style for the type-icon column on unselected rows. Defaults to plain text. */
	icon?: (text: string) => string;
	/** Hover band applied to the full row under the mouse pointer. */
	hovered?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

/** State supplied to a rich SelectList row renderer or measurer. */
export interface SelectListRenderItemContext {
	item: SelectItem;
	index: number;
	width: number;
	selected: boolean;
	hovered: boolean;
	pendingConfirmation: boolean;
	theme: SelectListTheme;
}

/** Current controlled menu state supplied to a custom status renderer. */
export interface SelectListStatusContext {
	query: string;
	selectedIndex: number;
	visibleCount: number;
	totalCount: number;
	pendingItem: SelectItem | undefined;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	/** Enable type-to-filter search when the item count exceeds maxVisible. Defaults to true. */
	overflowSearch?: boolean;
	/** Search activation policy. `overflowSearch` remains authoritative when this is omitted. */
	search?: "overflow" | "always" | "never";
	/** Domain-specific filtering/ranking. Selection is retained by item value when possible. */
	filterItems?: (items: readonly SelectItem[], query: string) => readonly SelectItem[];
	/** Custom rich-row renderer. Every returned line is mouse-hit-tested as the same item. */
	renderItem?: (context: SelectListRenderItemContext) => readonly string[];
	/** Cheap row measurement for custom renderers; defaults to calling renderItem and reading its length. */
	measureItem?: (context: SelectListRenderItemContext) => number;
	/** Empty-list message (before a query is entered). */
	emptyText?: string;
	/** No-match message (after filtering). */
	noMatchText?: string;
	/** Optional status renderer. Return undefined to omit the status row. */
	statusText?: (context: SelectListStatusContext) => string | undefined;
	/** Whether single-step keyboard navigation wraps at the edges. Defaults to true. */
	wrapNavigation?: boolean;
	/**
	 * Wrap long descriptions onto continuation rows indented under the
	 * description column instead of truncating. Defaults to false so existing
	 * single-line consumers are unaffected. Navigation remains item-to-item;
	 * the scrollbar tracks visual rows so the thumb stays correct when items
	 * wrap unevenly.
	 */
	wrapDescription?: boolean;
	/**
	 * Cap wrapped descriptions at this many visual rows; the last kept row is
	 * ellipsized. Only meaningful with `wrapDescription`.
	 */
	maxDescriptionRows?: number;
}

type SelectItemLayout =
	| {
			kind: "description";
			prefix: string;
			iconCell: string;
			truncatedValue: string;
			spacing: string;
			descriptionSingleLine: string;
			descriptionStart: number;
			remainingWidth: number;
	  }
	| {
			kind: "primary";
			prefix: string;
			iconCell: string;
			truncatedValue: string;
			spacing: "";
	  };

export class SelectList implements Component, MouseRoutable {
	/**
	 * Sanitized `{label, description}` per item object. `sanitizeSingleLine`
	 * is 3 passes + 2 regex execs per call and render() used to run it up to
	 * 3x per item per frame (column widths, row counts, item render). Items
	 * are host-owned and stable across frames; the map is cleared when the
	 * visible item list identity changes.
	 */
	#sanitized = new WeakMap<
		SelectItem,
		{ sourceLabel: string; sourceDescription: string | undefined; label: string; description: string | undefined }
	>();
	#maxVisible: number;
	#selection: MenuSelection<SelectItem>;
	#hoveredIndex: number | null = null;
	/** Per-render map of 0-based output line → filtered-item index. */
	#hitRows: (number | undefined)[] = [];

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(
		items: ReadonlyArray<SelectItem>,
		maxVisible: number,
		private readonly theme: SelectListTheme,
		private readonly layout: SelectListLayoutOptions = {},
	) {
		this.#maxVisible = Math.max(1, Math.trunc(maxVisible));
		this.#selection = new MenuSelection(items, {
			getKey: item => item.value,
			getSearchText: item => this.#getFilterText(item),
			isDisabled: item => item.disabled === true,
			requiresConfirmation: item => item.confirmation !== undefined,
			filter: layout.filterItems,
		});
	}
	/** Return item, selection, and filter state for debug inspection. */
	debugState(): Record<string, unknown> {
		const selected = this.#selection.selectedItem;
		return {
			itemCount: this.#selection.items.length,
			filteredItemCount: this.#selection.visibleItems.length,
			selectedIndex: this.#selection.selectedIndex,
			selectedItemId: selected?.value ?? null,
			selectedItemLabel: selected?.label ?? null,
			filterText: this.#selection.query,
			pendingItemId: this.#selection.pendingKey ?? null,
			maxVisible: this.#maxVisible,
		};
	}

	/** Refit the visible row budget (hosts clamp the list to available height). */
	setMaxVisible(rows: number): void {
		this.#maxVisible = Math.max(1, Math.trunc(rows));
	}

	setFilter(filter: string): void {
		this.#setFilter(filter, true);
	}

	/** Replace controlled items while retaining the selected value when possible. */
	setItems(items: readonly SelectItem[]): void {
		if (this.#selection.setItems(items)) this.#notifySelectionChange();
	}

	setSelectedIndex(index: number): void {
		this.#selection.setSelectedIndex(index);
	}

	/** Select a visible item by its stable value. */
	setSelectedValue(value: string): void {
		this.#selection.setSelectedKey(value);
	}

	getFilter(): string {
		return this.#selection.query;
	}

	/** Resolve a 0-based rendered-line index to a filtered-item index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Highlight the item under the pointer (null clears). */
	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index;
	}

	/** Move the selection one step for a wheel notch. */
	handleWheel(delta: -1 | 1): void {
		if (this.#selection.move(delta)) this.#notifySelectionChange();
	}

	/** Mouse click: select the item under the pointer and request activation. */
	clickItem(index: number): void {
		const item = this.#selection.visibleItems[index];
		if (!item || item.disabled) return;
		if (this.#selection.setSelectedIndex(index)) this.#notifySelectionChange();
		this.#activateSelected();
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this, event, line);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];
		let showSearchStatus = this.#shouldRenderSearchStatus();

		// If no items match filter, distinguish an empty data set from no search matches.
		if (this.#selection.visibleItems.length === 0) {
			if (showSearchStatus) {
				lines.push(this.#renderStatusLine(width));
			}
			const message =
				this.#selection.query.trim().length > 0
					? (this.layout.noMatchText ?? "No matching items")
					: (this.layout.emptyText ?? "No items");
			lines.push(this.theme.noMatch(`  ${message}`));
			return lines;
		}

		const primaryColumnWidth = this.#getPrimaryColumnWidth();
		const iconColumnWidth = this.#getIconColumnWidth();
		const wrapEnabled = this.layout.wrapDescription === true;
		// `maxVisible` is the picker's visual row budget. For non-wrap layouts
		// every item is one row, so the budget matches the original item count.
		const visualBudget = this.#maxVisible;

		// Compute per-item visual row counts at the conservative width (i.e.
		// assume the scrollbar column might be reserved). For non-wrap layouts
		// every count is 1, so total visual rows equal the visible item count.
		const conservativeRowWidth = Math.max(0, width - 1);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rowCounts = new Array<number>(this.#selection.visibleItems.length);
		for (let i = 0; i < this.#selection.visibleItems.length; i++) {
			const item = this.#selection.visibleItems[i];
			if (!item) {
				rowCounts[i] = 0;
				continue;
			}
			const context = this.#renderContext(item, i, conservativeRowWidth);
			rowCounts[i] = this.layout.measureItem
				? Math.max(1, Math.trunc(this.layout.measureItem(context)))
				: this.layout.renderItem
					? Math.max(1, this.layout.renderItem(context).length)
					: wrapEnabled
						? this.#computeItemRowCount(item, conservativeRowWidth, primaryColumnWidth, iconColumnWidth)
						: 1;
		}

		const window = getMenuWindow(rowCounts, this.#selection.selectedIndex, visualBudget);
		const overflow = window.totalRows > visualBudget;
		showSearchStatus = this.#shouldRenderSearchStatus();
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));

		// Pick a window centered on the selected item that fits in visualBudget
		// rows. Falls through to the original item-count window when every row
		// count is 1.
		const { startIndex, endIndex, rowOffset } = window;

		// Render visible items. Cap rows at the budget so a single item that
		// wraps to more than `visualBudget` rows (pathological — e.g. a 5-row
		// description with maxVisible=3) still keeps the popup bounded; the
		// scrollbar carries the offscreen rows.
		const rows: string[] = [];
		for (let i = startIndex; i < endIndex && rows.length < visualBudget; i++) {
			const item = this.#selection.visibleItems[i];
			if (!item) continue;
			const isSelected = i === this.#selection.selectedIndex;
			const hovered = i === this.#hoveredIndex && !isSelected;
			const context = this.#renderContext(item, i, rowWidth);
			const itemRows = this.layout.renderItem
				? [...this.layout.renderItem(context)]
				: this.#renderItem(item, isSelected, rowWidth, primaryColumnWidth, iconColumnWidth);
			for (const row of itemRows) {
				if (rows.length >= visualBudget) break;
				this.#hitRows[rows.length] = i;
				const styled =
					this.layout.renderItem !== undefined
						? row
						: item.disabled
							? this.theme.description(row)
							: hovered && this.theme.hovered
								? this.theme.hovered(row)
								: row;
				rows.push(styled);
			}
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: window.totalRows,
			theme: { track: t => this.theme.scrollInfo(t), thumb: t => this.theme.selectedPrefix(t) },
		});
		sv.setScrollOffset(rowOffset);
		lines.push(...sv.render(width));

		// Add search status when relevant (scrollbar now indicates overflow)
		if (showSearchStatus) {
			lines.push(this.#renderStatusLine(width));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (!this.#selection.cancelConfirmation()) this.onCancel?.();
			return;
		}

		if (this.#handleSearchInput(keyData)) return;
		if (this.#selection.visibleItems.length === 0) return;

		let selectionChanged = false;
		if (kb.matches(keyData, "tui.select.up")) {
			selectionChanged = this.#selection.move(-1, this.layout.wrapNavigation !== false);
		} else if (kb.matches(keyData, "tui.select.down")) {
			selectionChanged = this.#selection.move(1, this.layout.wrapNavigation !== false);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			selectionChanged = this.#selection.move(-this.#maxVisible);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			selectionChanged = this.#selection.move(this.#maxVisible);
		} else if (matchesKey(keyData, "home")) {
			selectionChanged = this.#selection.moveToBoundary("first");
		} else if (matchesKey(keyData, "end")) {
			selectionChanged = this.#selection.moveToBoundary("last");
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.#activateSelected();
		}
		if (selectionChanged) this.#notifySelectionChange();
	}

	#renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		primaryColumnWidth: number,
		iconColumnWidth: number,
	): string[] {
		const layout = this.#computeItemLayout(item, isSelected, width, primaryColumnWidth, iconColumnWidth);
		const { prefix, truncatedValue, spacing } = layout;
		const iconCell =
			layout.iconCell && !isSelected && this.theme.icon ? this.theme.icon(layout.iconCell) : layout.iconCell;

		if (layout.kind === "description") {
			const { descriptionSingleLine, descriptionStart, remainingWidth } = layout;
			if (this.layout.wrapDescription) {
				const wrapped = this.#wrapDescription(descriptionSingleLine, remainingWidth);
				if (wrapped.length === 0) wrapped.push("");
				const indent = padding(descriptionStart);
				const first = wrapped[0] ?? "";
				if (isSelected) {
					const rows = [this.theme.selectedText(`${prefix}${iconCell}${truncatedValue}${spacing}${first}`)];
					for (let i = 1; i < wrapped.length; i++) {
						rows.push(this.theme.selectedText(`${indent}${wrapped[i]}`));
					}
					return rows;
				}
				const rows = [prefix + iconCell + truncatedValue + this.theme.description(spacing + first)];
				for (let i = 1; i < wrapped.length; i++) {
					rows.push(this.theme.description(`${indent}${wrapped[i]}`));
				}
				return rows;
			}

			const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, Ellipsis.Omit);
			if (isSelected) {
				return [this.theme.selectedText(`${prefix}${iconCell}${truncatedValue}${spacing}${truncatedDesc}`)];
			}
			return [prefix + iconCell + truncatedValue + this.theme.description(spacing + truncatedDesc)];
		}

		if (isSelected) {
			return [this.theme.selectedText(`${prefix}${iconCell}${truncatedValue}`)];
		}
		return [prefix + iconCell + truncatedValue];
	}

	#computeItemRowCount(item: SelectItem, width: number, primaryColumnWidth: number, iconColumnWidth: number): number {
		// Selection style does not change row count; pass isSelected=false to
		// keep the cheap path uniform for items outside the visible window.
		const layout = this.#computeItemLayout(item, false, width, primaryColumnWidth, iconColumnWidth);
		if (layout.kind !== "description") return 1;
		const wrapped = this.#wrapDescription(layout.descriptionSingleLine, layout.remainingWidth);
		return Math.max(1, wrapped.length);
	}
	/** Wrap a description, capping it at `maxDescriptionRows` with a trailing ellipsis. */
	#wrapDescription(description: string, width: number): string[] {
		const wrapped = wrapTextWithAnsi(description, width);
		const cap = this.layout.maxDescriptionRows;
		if (cap === undefined || cap < 1 || wrapped.length <= cap) return wrapped;
		const kept = wrapped.slice(0, cap);
		kept[cap - 1] = truncateToWidth(`${kept[cap - 1]} …`, width, Ellipsis.Unicode);
		return kept;
	}

	#computeItemLayout(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		primaryColumnWidth: number,
		iconColumnWidth: number,
	): SelectItemLayout {
		const cursor = this.theme.symbols?.cursor ?? DEFAULT_CURSOR_SYMBOL;
		const prefix = isSelected ? `${cursor} ` : padding(visibleWidth(cursor) + 1);
		// Icon column: every row reserves the same width so labels stay aligned
		// whether or not an individual item carries an icon.
		const iconWidth = item.icon ? visibleWidth(item.icon) : 0;
		const iconCell = iconColumnWidth > 0 ? (item.icon ?? "") + padding(iconColumnWidth - iconWidth + 1) : "";
		const prefixWidth = visibleWidth(prefix) + (iconColumnWidth > 0 ? iconColumnWidth + 1 : 0);
		const descriptionSingleLine = this.#sanitizedDescription(item);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.#truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = padding(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				return {
					kind: "description",
					prefix,
					iconCell,
					truncatedValue,
					spacing,
					descriptionSingleLine,
					descriptionStart,
					remainingWidth,
				};
			}
		}

		const fallbackMax = width - prefixWidth - 2;
		const truncatedValue = this.#truncatePrimary(item, isSelected, fallbackMax, fallbackMax);
		return {
			kind: "primary",
			prefix,
			iconCell,
			truncatedValue,
			spacing: "",
		};
	}

	#getIconColumnWidth(): number {
		let widest = 0;
		for (const item of this.#selection.visibleItems) {
			if (item.icon) widest = Math.max(widest, visibleWidth(item.icon));
		}
		return widest;
	}

	#getPrimaryColumnWidth(): number {
		const { min, max } = this.#getPrimaryColumnBounds();
		const widestPrimary = this.#selection.visibleItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.#getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	#getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	#truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.#getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, Ellipsis.Omit);

		return truncateToWidth(truncatedValue, maxWidth, Ellipsis.Omit);
	}

	#getDisplayValue(item: SelectItem): string {
		return this.#sanitizedLabel(item);
	}

	#sanitizedLabel(item: SelectItem): string {
		return this.#sanitizedEntry(item).label;
	}

	#sanitizedDescription(item: SelectItem): string | undefined {
		return this.#sanitizedEntry(item).description;
	}

	#sanitizedEntry(item: SelectItem): { label: string; description: string | undefined } {
		const sourceLabel = item.label || item.value;
		const sourceDescription = item.description;
		const cached = this.#sanitized.get(item);
		if (
			cached !== undefined &&
			cached.sourceLabel === sourceLabel &&
			cached.sourceDescription === sourceDescription
		) {
			return cached;
		}
		const entry = {
			sourceLabel,
			sourceDescription,
			label: sanitizeSingleLine(sourceLabel),
			description: sourceDescription ? sanitizeSingleLine(sourceDescription) : undefined,
		};
		this.#sanitized.set(item, entry);
		return entry;
	}

	#renderStatusLine(width: number): string {
		const pendingItem =
			this.#selection.pendingKey === undefined
				? undefined
				: this.#selection.visibleItems.find(item => item.value === this.#selection.pendingKey);
		const query = sanitizeSingleLine(this.#selection.query);
		const custom = this.layout.statusText?.({
			query,
			selectedIndex: this.#selection.selectedIndex,
			visibleCount: this.#selection.visibleItems.length,
			totalCount: this.#selection.items.length,
			pendingItem,
		});
		const statusText =
			this.layout.statusText !== undefined
				? (custom ?? "")
				: (pendingItem?.confirmation ??
					(query ? `  Search: ${query}` : this.#canEditSearch() ? "  Type to search" : ""));
		return this.theme.scrollInfo(truncateToWidth(statusText, Math.max(1, width - 2), Ellipsis.Omit));
	}

	#shouldRenderSearchStatus(): boolean {
		const policy = this.layout.search ?? (this.layout.overflowSearch === false ? "never" : "overflow");
		return (
			this.#selection.pendingKey !== undefined ||
			this.layout.statusText !== undefined ||
			(policy !== "never" && this.#selection.query.length > 0) ||
			(this.#canEditSearch() && this.#selection.items.length > this.#maxVisible)
		);
	}

	#canEditSearch(): boolean {
		const policy = this.layout.search ?? (this.layout.overflowSearch === false ? "never" : "overflow");
		return policy === "always" || (policy === "overflow" && this.#selection.items.length > this.#maxVisible);
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#canEditSearch()) return false;

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.#selection.query.length === 0) return false;
			const chars = [...this.#selection.query];
			chars.pop();
			this.#setFilter(chars.join(""), true);
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#selection.query.length === 0 && printableText.trim().length === 0) return false;

		this.#setFilter(this.#selection.query + printableText, true);
		return true;
	}

	#setFilter(filter: string, notify: boolean): void {
		let changed: boolean;
		if (filter.trim()) {
			pushLoopPhase("ui.select-filter");
			try {
				changed = this.#selection.setQuery(filter);
			} finally {
				popLoopPhase();
			}
		} else {
			changed = this.#selection.setQuery(filter);
		}
		if (notify && changed) this.#notifySelectionChange();
	}

	#getFilterText(item: SelectItem): string {
		let text = `${item.label} ${item.value}`;
		if (item.description) {
			text += ` ${item.description}`;
		}
		if (item.hint) {
			text += ` ${item.hint}`;
		}
		if (item.searchText) {
			text += ` ${item.searchText}`;
		}
		return sanitizeSingleLine(text);
	}

	#renderContext(item: SelectItem, index: number, width: number): SelectListRenderItemContext {
		return {
			item,
			index,
			width,
			selected: index === this.#selection.selectedIndex,
			hovered: index === this.#hoveredIndex,
			pendingConfirmation: this.#selection.isPending(item),
			theme: this.theme,
		};
	}

	#activateSelected(): void {
		const activation = this.#selection.requestActivation();
		if (activation.kind === "confirmed") this.onSelect?.(activation.item);
	}

	#notifySelectionChange(): void {
		const selectedItem = this.#selection.selectedItem;
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		return this.#selection.selectedItem ?? null;
	}
}
