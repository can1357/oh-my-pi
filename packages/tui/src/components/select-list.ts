import { popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { fuzzyFilter } from "../fuzzy";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
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

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	/** Enable type-to-filter search when the item count exceeds maxVisible. Defaults to true. */
	overflowSearch?: boolean;
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
	#maxVisible: number;
	#filteredItems: ReadonlyArray<SelectItem>;
	#filterQuery = "";
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	/** Per-render map of 0-based output line → filtered-item index. */
	#hitRows: (number | undefined)[] = [];

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(
		private readonly items: ReadonlyArray<SelectItem>,
		maxVisible: number,
		private readonly theme: SelectListTheme,
		private readonly layout: SelectListLayoutOptions = {},
	) {
		this.#maxVisible = Math.max(1, Math.trunc(maxVisible));
		this.#filteredItems = items;
	}
	/** Return item, selection, and filter state for debug inspection. */
	debugState(): Record<string, unknown> {
		const selected = this.#filteredItems[this.#selectedIndex];
		return {
			itemCount: this.items.length,
			filteredItemCount: this.#filteredItems.length,
			selectedIndex: this.#filteredItems.length > 0 ? this.#selectedIndex : -1,
			selectedItemId: selected?.value ?? null,
			selectedItemLabel: selected?.label ?? null,
			filterText: this.#filterQuery,
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

	setSelectedIndex(index: number): void {
		this.#selectedIndex = Math.max(0, Math.min(index, this.#filteredItems.length - 1));
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
		if (this.#filteredItems.length === 0) return;
		const next = clamp(this.#selectedIndex + delta, 0, this.#filteredItems.length - 1);
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#notifySelectionChange();
	}

	/** Mouse click: select the item under the pointer and confirm it. */
	clickItem(index: number): void {
		const item = this.#filteredItems[index];
		if (!item) return;
		if (index !== this.#selectedIndex) {
			this.#selectedIndex = index;
			this.#notifySelectionChange();
		}
		this.onSelect?.(item);
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
		const showSearchStatus = this.#shouldRenderSearchStatus();

		// If no items match filter, show message
		if (this.#filteredItems.length === 0) {
			if (showSearchStatus) {
				lines.push(this.#renderStatusLine(width));
			}
			lines.push(this.theme.noMatch("  No matching items"));
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
		// every count is 1, so visualTotal == #filteredItems and overflow falls
		// back to the original `N > maxVisible` predicate exactly.
		const conservativeRowWidth = Math.max(0, width - 1);
		const rowCounts = new Array<number>(this.#filteredItems.length);
		let visualTotal = 0;
		for (let i = 0; i < this.#filteredItems.length; i++) {
			const item = this.#filteredItems[i];
			if (!item) {
				rowCounts[i] = 0;
				continue;
			}
			rowCounts[i] = wrapEnabled
				? this.#computeItemRowCount(item, conservativeRowWidth, primaryColumnWidth, iconColumnWidth)
				: 1;
			visualTotal += rowCounts[i];
		}

		const overflow = visualTotal > visualBudget;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));

		// Pick a window centered on the selected item that fits in visualBudget
		// rows. Falls through to the original item-count window when every row
		// count is 1.
		const { startIndex, endIndex, visualOffset } = this.#pickWindow(rowCounts, visualBudget);

		// Render visible items. Cap rows at the budget so a single item that
		// wraps to more than `visualBudget` rows (pathological — e.g. a 5-row
		// description with maxVisible=3) still keeps the popup bounded; the
		// scrollbar carries the offscreen rows.
		const rows: string[] = [];
		for (let i = startIndex; i < endIndex && rows.length < visualBudget; i++) {
			const item = this.#filteredItems[i];
			if (!item) continue;
			const hovered = this.theme.hovered !== undefined && i === this.#hoveredIndex && i !== this.#selectedIndex;
			const itemRows = this.#renderItem(
				item,
				i === this.#selectedIndex,
				rowWidth,
				primaryColumnWidth,
				iconColumnWidth,
			);
			for (const row of itemRows) {
				if (rows.length >= visualBudget) break;
				this.#hitRows[rows.length] = i;
				rows.push(hovered && this.theme.hovered ? this.theme.hovered(row) : row);
			}
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: visualTotal,
			theme: { track: t => this.theme.scrollInfo(t), thumb: t => this.theme.selectedPrefix(t) },
		});
		sv.setScrollOffset(visualOffset);
		lines.push(...sv.render(width));

		// Add search status when relevant (scrollbar now indicates overflow)
		if (showSearchStatus) {
			lines.push(this.#renderStatusLine(width));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (this.#filteredItems.length === 0) return;
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
			this.#notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#notifySelectionChange();
		}
		// PageUp - jump up by one visible page
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible);
			this.#notifySelectionChange();
		}
		// PageDown - jump down by one visible page
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredItems.length - 1, this.#selectedIndex + this.#maxVisible);
			this.#notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
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

	/**
	 * Pick a contiguous window of items containing `selectedIndex` such that
	 * their visual rows fit within `budget`. Centers the selection roughly
	 * mid-window: first expands up by ⌊budget/2⌋ rows, then fills downward,
	 * then back upward with any remaining budget. For non-wrap layouts (every
	 * `rowCounts[i] === 1`) this resolves to the same `[start, start+maxVisible)`
	 * window the prior arithmetic produced.
	 */
	#pickWindow(
		rowCounts: ReadonlyArray<number>,
		budget: number,
	): { startIndex: number; endIndex: number; visualOffset: number } {
		const n = rowCounts.length;
		const selected = Math.max(0, Math.min(this.#selectedIndex, n - 1));
		if (n === 0) return { startIndex: 0, endIndex: 0, visualOffset: 0 };

		const half = Math.floor(budget / 2);
		let lo = selected;
		let rowsAboveSelected = 0;
		// Step 1: expand upward up to `half` rows above the selection so it
		// lands near the visual middle, matching the prior centering.
		while (lo > 0 && rowsAboveSelected + (rowCounts[lo - 1] ?? 0) <= half) {
			lo--;
			rowsAboveSelected += rowCounts[lo] ?? 0;
		}

		// Step 2: expand downward until the budget is filled. The selected
		// item's own rows are always counted; if it alone exceeds `budget`
		// the surplus is clipped at render time and the scrollbar carries it.
		let hi = selected + 1;
		let used = rowsAboveSelected + (rowCounts[selected] ?? 0);
		while (hi < n && used + (rowCounts[hi] ?? 0) <= budget) {
			used += rowCounts[hi] ?? 0;
			hi++;
		}

		// Step 3: if room remains (selection sat near the bottom), keep
		// expanding upward.
		while (lo > 0 && used + (rowCounts[lo - 1] ?? 0) <= budget) {
			lo--;
			used += rowCounts[lo] ?? 0;
		}

		let visualOffset = 0;
		for (let i = 0; i < lo; i++) visualOffset += rowCounts[i] ?? 0;
		return { startIndex: lo, endIndex: hi, visualOffset };
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
		const descriptionSingleLine = item.description ? sanitizeSingleLine(item.description) : undefined;

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
		for (const item of this.#filteredItems) {
			if (item.icon) widest = Math.max(widest, visibleWidth(item.icon));
		}
		return widest;
	}

	#getPrimaryColumnWidth(): number {
		const { min, max } = this.#getPrimaryColumnBounds();
		const widestPrimary = this.#filteredItems.reduce((widest, item) => {
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
		return sanitizeSingleLine(item.label || item.value);
	}

	#renderStatusLine(width: number): string {
		const query = sanitizeSingleLine(this.#filterQuery);
		const statusText = query ? `  Search: ${query}` : "  Type to search";
		return this.theme.scrollInfo(truncateToWidth(statusText, Math.max(1, width - 2), Ellipsis.Omit));
	}

	#shouldRenderSearchStatus(): boolean {
		return (
			this.layout.overflowSearch !== false && (this.items.length > this.#maxVisible || this.#filterQuery.length > 0)
		);
	}

	#canEditSearch(): boolean {
		return this.layout.overflowSearch !== false && this.items.length > this.#maxVisible;
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#canEditSearch()) return false;

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.#filterQuery.length === 0) return false;
			const chars = [...this.#filterQuery];
			chars.pop();
			this.#setFilter(chars.join(""), true);
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#filterQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setFilter(this.#filterQuery + printableText, true);
		return true;
	}

	#setFilter(filter: string, notify: boolean): void {
		this.#filterQuery = filter;
		if (filter.trim()) {
			// Breadcrumb the fuzzy match so the loop watchdog can attribute a
			// large-list filter stall instead of logging it as "unknown".
			pushLoopPhase("ui.select-filter");
			try {
				this.#filteredItems = fuzzyFilter([...this.items], filter, item => this.#getFilterText(item));
			} finally {
				popLoopPhase();
			}
		} else {
			this.#filteredItems = this.items;
		}
		this.#selectedIndex = 0;
		if (notify) {
			this.#notifySelectionChange();
		}
	}

	#getFilterText(item: SelectItem): string {
		let text = `${item.label} ${item.value}`;
		if (item.description) {
			text += ` ${item.description}`;
		}
		if (item.hint) {
			text += ` ${item.hint}`;
		}
		return sanitizeSingleLine(text);
	}

	#notifySelectionChange(): void {
		const selectedItem = this.#filteredItems[this.#selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.#filteredItems[this.#selectedIndex];
		return item || null;
	}
}
