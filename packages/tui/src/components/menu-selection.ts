import { fuzzyFilter } from "../fuzzy";

/** Describes how a menu identifies, searches, disables, and confirms its items. */
export interface MenuSelectionAdapter<T> {
	/** Stable identity used to retain selection while data or filtering changes. */
	getKey: (item: T) => string;
	/** Searchable text used by the default fuzzy filter. */
	getSearchText: (item: T) => string;
	/** Disabled items remain visible but are skipped by navigation and cannot activate. */
	isDisabled?: (item: T) => boolean;
	/** Items returning true require two activation requests without an intervening state change. */
	requiresConfirmation?: (item: T) => boolean;
	/** Optional domain-specific filtering/ranking. */
	filter?: (items: readonly T[], query: string) => readonly T[];
}

/** Result of requesting activation of the current menu item. */
export type MenuActivation<T> =
	| { kind: "empty" }
	| { kind: "disabled"; item: T }
	| { kind: "pending"; item: T }
	| { kind: "confirmed"; item: T };

/** A viewport over variable-height items. */
export interface MenuWindow {
	startIndex: number;
	endIndex: number;
	/** Number of visual rows before startIndex, for scrollbar positioning. */
	rowOffset: number;
	/** Total visual rows across every item. */
	totalRows: number;
}

/**
 * Pick a selection-centered, contiguous window whose visual rows fit `rowBudget`.
 * A selected item taller than the budget is retained and clipped by the renderer.
 */
export function getMenuWindow(rowCounts: readonly number[], selectedIndex: number, rowBudget: number): MenuWindow {
	let totalRows = 0;
	for (const count of rowCounts) totalRows += Math.max(0, count);
	if (rowCounts.length === 0) return { startIndex: 0, endIndex: 0, rowOffset: 0, totalRows };

	const budget = Math.max(1, Math.trunc(rowBudget));
	const selected = Math.max(0, Math.min(Math.trunc(selectedIndex), rowCounts.length - 1));
	const selectedRows = Math.max(0, rowCounts[selected] ?? 0);
	const targetRowsBeforeSelection = Math.floor(Math.max(0, budget - Math.min(selectedRows, budget)) / 2);
	let startIndex = selected;
	let rowsBeforeSelection = 0;
	while (startIndex > 0) {
		const cost = Math.max(0, rowCounts[startIndex - 1] ?? 0);
		if (rowsBeforeSelection + cost > targetRowsBeforeSelection) break;
		startIndex--;
		rowsBeforeSelection += cost;
	}

	let endIndex = selected + 1;
	let used = rowsBeforeSelection + selectedRows;
	while (endIndex < rowCounts.length) {
		const cost = Math.max(0, rowCounts[endIndex] ?? 0);
		if (used + cost > budget) break;
		used += cost;
		endIndex++;
	}
	while (startIndex > 0) {
		const cost = Math.max(0, rowCounts[startIndex - 1] ?? 0);
		if (used + cost > budget) break;
		startIndex--;
		used += cost;
	}

	let rowOffset = 0;
	for (let index = 0; index < startIndex; index++) rowOffset += Math.max(0, rowCounts[index] ?? 0);
	return { startIndex, endIndex, rowOffset, totalRows };
}

/**
 * Controlled menu data, filtering, selection, disabled-row navigation, and
 * confirmation state. Renderers remain domain-owned and consume `visibleItems`.
 */
export class MenuSelection<T> {
	#items: readonly T[];
	#visibleItems: readonly T[];
	#query = "";
	#selectedIndex = -1;
	#pendingKey: string | undefined;

	constructor(
		items: readonly T[],
		readonly adapter: MenuSelectionAdapter<T>,
		initialKey?: string,
	) {
		this.#items = items;
		this.#visibleItems = items;
		this.#selectedIndex = this.#findInitialIndex(initialKey);
	}

	get items(): readonly T[] {
		return this.#items;
	}

	get visibleItems(): readonly T[] {
		return this.#visibleItems;
	}

	get query(): string {
		return this.#query;
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	get selectedItem(): T | undefined {
		return this.#visibleItems[this.#selectedIndex];
	}

	get selectedKey(): string | undefined {
		const item = this.selectedItem;
		return item === undefined ? undefined : this.adapter.getKey(item);
	}

	get pendingKey(): string | undefined {
		return this.#pendingKey;
	}

	isDisabled(item: T): boolean {
		return this.adapter.isDisabled?.(item) ?? false;
	}

	isPending(item: T): boolean {
		return this.#pendingKey === this.adapter.getKey(item);
	}

	/** Replace controlled data, retaining the selected key when it remains visible. */
	setItems(items: readonly T[], selectedKey = this.selectedKey): boolean {
		const previousKey = this.selectedKey;
		this.#items = items;
		this.#applyFilter(selectedKey);
		this.#pendingKey = undefined;
		return previousKey !== this.selectedKey;
	}

	/** Set the query and retain the selected key when it survives filtering. */
	setQuery(query: string, retainSelection = true): boolean {
		if (query === this.#query) return false;
		const previousKey = this.selectedKey;
		this.#query = query;
		this.#pendingKey = undefined;
		this.#applyFilter(retainSelection ? previousKey : undefined);
		return previousKey !== this.selectedKey;
	}

	/** Select a visible row, coercing disabled rows to the nearest enabled row. */
	setSelectedIndex(index: number, direction: -1 | 1 = 1): boolean {
		const next = this.#coerceIndex(index, direction);
		if (next === this.#selectedIndex) return false;
		this.#selectedIndex = next;
		this.#pendingKey = undefined;
		return true;
	}

	setSelectedKey(key: string): boolean {
		const index = this.#visibleItems.findIndex(item => this.adapter.getKey(item) === key);
		return index >= 0 ? this.setSelectedIndex(index) : false;
	}

	/** Move by item count, optionally wrapping at list edges. */
	move(delta: number, wrap = false): boolean {
		const total = this.#visibleItems.length;
		if (total === 0 || delta === 0) return false;
		const direction: -1 | 1 = delta < 0 ? -1 : 1;
		let remaining = Math.max(1, Math.abs(Math.trunc(delta)));
		let index = this.#selectedIndex;
		for (let attempts = 0; attempts < total && remaining > 0; attempts++) {
			let next = index + direction;
			if (next < 0 || next >= total) {
				if (!wrap) break;
				next = direction > 0 ? 0 : total - 1;
			}
			if (next === index) break;
			index = next;
			const item = this.#visibleItems[index];
			if (item !== undefined && !this.isDisabled(item)) remaining--;
		}
		return index !== this.#selectedIndex && this.setSelectedIndex(index, direction);
	}

	moveToBoundary(boundary: "first" | "last"): boolean {
		return this.setSelectedIndex(
			boundary === "first" ? 0 : this.#visibleItems.length - 1,
			boundary === "first" ? 1 : -1,
		);
	}

	/** Clear a pending confirmation. Returns true only when one was cleared. */
	cancelConfirmation(): boolean {
		if (this.#pendingKey === undefined) return false;
		this.#pendingKey = undefined;
		return true;
	}

	requestActivation(index = this.#selectedIndex): MenuActivation<T> {
		const item = this.#visibleItems[index];
		if (item === undefined) return { kind: "empty" };
		if (this.isDisabled(item)) return { kind: "disabled", item };
		const key = this.adapter.getKey(item);
		if (this.adapter.requiresConfirmation?.(item) === true && this.#pendingKey !== key) {
			this.#pendingKey = key;
			return { kind: "pending", item };
		}
		this.#pendingKey = undefined;
		return { kind: "confirmed", item };
	}

	#applyFilter(preferredKey: string | undefined): void {
		const query = this.#query.trim();
		this.#visibleItems = query
			? (this.adapter.filter?.(this.#items, query) ??
				fuzzyFilter([...this.#items], query, item => this.adapter.getSearchText(item)))
			: this.#items;
		this.#selectedIndex = this.#findInitialIndex(preferredKey);
	}

	#findInitialIndex(preferredKey: string | undefined): number {
		if (this.#visibleItems.length === 0) return -1;
		if (preferredKey !== undefined) {
			const preferred = this.#visibleItems.findIndex(item => this.adapter.getKey(item) === preferredKey);
			if (preferred >= 0 && !this.isDisabled(this.#visibleItems[preferred]!)) return preferred;
		}
		return this.#coerceIndex(0, 1);
	}

	#coerceIndex(index: number, direction: -1 | 1): number {
		if (this.#visibleItems.length === 0) return -1;
		const clamped = Math.max(0, Math.min(Math.trunc(index), this.#visibleItems.length - 1));
		const candidate = this.#visibleItems[clamped];
		if (candidate !== undefined && !this.isDisabled(candidate)) return clamped;
		for (let next = clamped + direction; next >= 0 && next < this.#visibleItems.length; next += direction) {
			const item = this.#visibleItems[next];
			if (item !== undefined && !this.isDisabled(item)) return next;
		}
		for (let next = clamped - direction; next >= 0 && next < this.#visibleItems.length; next -= direction) {
			const item = this.#visibleItems[next];
			if (item !== undefined && !this.isDisabled(item)) return next;
		}
		return clamped;
	}
}
