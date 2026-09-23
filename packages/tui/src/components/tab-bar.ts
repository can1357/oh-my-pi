/**
 * Tab Bar Component
 *
 * A horizontal tab bar for switching between views/panels.
 * Renders as: "Label:  Tab1   Tab2   Tab3  (tab to cycle)"
 *
 * Navigation:
 * - Tab / Arrow Right: Next tab (wraps around)
 * - Shift+Tab / Arrow Left: Previous tab (wraps around)
 */
import { matchesKey } from "../keys";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";

/** Tab definition */
export interface Tab {
	/** Unique identifier for the tab */
	id: string;
	/** Display label shown in the tab bar */
	label: string;
	/** Compact form (e.g. just the icon) used when the bar must shrink to fit one line. */
	short?: string;
	/** Render with the muted style and skip during keyboard navigation. */
	muted?: boolean;
}

/** Theme for styling the tab bar */
export interface TabBarTheme {
	/** Style for the label prefix (e.g., "Settings:") */
	label: (text: string) => string;
	/** Style for the currently active tab */
	activeTab: (text: string) => string;
	/** Style for inactive tabs */
	inactiveTab: (text: string) => string;
	/** Style for the hint text (e.g., "(tab to cycle)") */
	hint: (text: string) => string;
	/** Style for muted tabs. Falls back to `inactiveTab` when omitted. */
	mutedTab?: (text: string) => string;
	/** Style for the tab under the mouse pointer. Falls back to `inactiveTab` when omitted. */
	hoverTab?: (text: string) => string;
}

/**
 * Horizontal tab bar component.
 *
 * @example
 * ```ts
 * const tabs = [
 *   { id: "config", label: "Config" },
 *   { id: "tools", label: "Tools" },
 * ];
 * const tabBar = new TabBar("Settings", tabs, theme);
 * tabBar.onTabChange = (tab) => console.log(`Switched to ${tab.id}`);
 * ```
 */
export class TabBar implements Component {
	#tabs: Tab[];
	#activeIndex: number = 0;
	#theme: TabBarTheme;
	#label: string;
	#hoverTabId: string | null = null;
	/** Per-render tab hit zones: 0-based line + [start, end) columns. */
	#hitZones: { line: number; start: number; end: number; index: number }[] = [];

	/** Callback fired when the active tab changes */
	onTabChange?: (tab: Tab, index: number) => void;

	/** Render the trailing "(tab to cycle)" hint. Disable when the host folds the hint into its own footer. */
	showHint = true;

	constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex: number = 0) {
		this.#label = label;
		this.#tabs = tabs;
		this.#theme = theme;
		this.#activeIndex = initialIndex;
	}
	/** Return tab identities and active-tab state for debug inspection. */
	debugState(): Record<string, unknown> {
		const active = this.#tabs[this.#activeIndex];
		return {
			label: this.#label,
			tabs: this.#tabs.map(tab => ({ id: tab.id, label: tab.label })),
			activeIndex: this.#tabs.length > 0 ? this.#activeIndex : -1,
			activeTabId: active?.id ?? null,
			activeTabLabel: active?.label ?? null,
		};
	}

	/** Get the currently active tab */
	getActiveTab(): Tab {
		return this.#tabs[this.#activeIndex];
	}

	/** Get the index of the currently active tab */
	getActiveIndex(): number {
		return this.#activeIndex;
	}

	/** Set the active tab by index (clamped to valid range) */
	setActiveIndex(index: number): void {
		const newIndex = Math.max(0, Math.min(index, this.#tabs.length - 1));
		if (newIndex !== this.#activeIndex) {
			this.#activeIndex = newIndex;
			this.onTabChange?.(this.#tabs[this.#activeIndex], this.#activeIndex);
		}
	}

	/**
	 * Replace the tab set without firing onTabChange. The active tab is
	 * preserved by id when it survives the swap (or forced via `activeId`);
	 * otherwise the index is clamped.
	 */
	setTabs(tabs: Tab[], activeId?: string): void {
		const targetId = activeId ?? this.#tabs[this.#activeIndex]?.id;
		this.#tabs = tabs;
		const index = tabs.findIndex(tab => tab.id === targetId);
		this.#activeIndex = index >= 0 ? index : Math.max(0, Math.min(this.#activeIndex, tabs.length - 1));
	}

	/** Set the active tab by id without firing onTabChange. Returns false when the id is unknown. */
	setActiveById(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1) return false;
		this.#activeIndex = index;
		return true;
	}

	/** Activate the tab with `id`, firing onTabChange when it changes. Muted tabs are ignored. */
	selectTab(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1 || this.#tabs[index]?.muted) return false;
		this.setActiveIndex(index);
		return true;
	}

	/** Move to the next non-muted tab (wraps to first tab after last) */
	nextTab(): void {
		this.#stepTab(1);
	}

	/** Move to the previous non-muted tab (wraps to last tab before first) */
	prevTab(): void {
		this.#stepTab(-1);
	}

	/** Step to the nearest non-muted tab in `delta` direction; no-op when none exists. */
	#stepTab(delta: -1 | 1): void {
		const len = this.#tabs.length;
		if (len === 0) return;
		for (let step = 1; step <= len; step++) {
			const index = (((this.#activeIndex + delta * step) % len) + len) % len;
			if (!this.#tabs[index]?.muted) {
				this.setActiveIndex(index);
				return;
			}
		}
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	/**
	 * Handle keyboard input for tab navigation.
	 * @returns true if the input was handled, false otherwise
	 */
	handleInput(data: string): boolean {
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.nextTab();
			return true;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.prevTab();
			return true;
		}
		return false;
	}

	/**
	 * Render the tab bar. When the full labels overflow the width, tabs are
	 * collapsed to their `short` form one by one — starting with the tabs
	 * farthest from the active one — until the bar fits on a single line.
	 * Wrapping to multiple lines is the last resort.
	 */
	render(width: number): readonly string[] {
		const maxWidth = Math.max(1, width);

		interface TabChunk {
			text: string;
			/** Index into #tabs when this chunk is a clickable tab button. */
			tabIndex?: number;
		}

		const buildChunks = (labels: readonly string[]): TabChunk[] => {
			const chunks: TabChunk[] = [];
			// Label prefix (omitted when the label is empty)
			if (this.#label) {
				chunks.push({ text: this.#theme.label(`${this.#label}:`) });
				chunks.push({ text: "  " });
			}
			for (let i = 0; i < this.#tabs.length; i++) {
				const tab = this.#tabs[i];
				// Muted tabs never take the active highlight: they are skipped by
				// navigation and only become "active" transiently via setTabs swaps.
				// A hovered (non-active) tab lights up so mouse users see the target.
				const hovered = tab.id === this.#hoverTabId && !tab.muted && i !== this.#activeIndex;
				const style = tab.muted
					? (this.#theme.mutedTab ?? this.#theme.inactiveTab)
					: i === this.#activeIndex
						? this.#theme.activeTab
						: hovered
							? (this.#theme.hoverTab ?? this.#theme.inactiveTab)
							: this.#theme.inactiveTab;
				chunks.push({ text: style(` ${labels[i]} `), tabIndex: i });
				if (i < this.#tabs.length - 1) {
					chunks.push({ text: "  " });
				}
			}
			// Navigation hint
			if (this.showHint) {
				chunks.push({ text: "  " });
				chunks.push({ text: this.#theme.hint("(tab to cycle)") });
			}
			return chunks;
		};
		const totalWidth = (chunks: TabChunk[]): number =>
			chunks.reduce((sum, chunk) => sum + visibleWidth(chunk.text), 0);

		const labels = this.#tabs.map(tab => tab.label);
		let chunks = buildChunks(labels);

		if (totalWidth(chunks) > maxWidth) {
			const collapseOrder = this.#tabs
				.map((_, index) => index)
				.filter(index => index !== this.#activeIndex && this.#tabs[index].short !== undefined)
				.sort((a, b) => Math.abs(b - this.#activeIndex) - Math.abs(a - this.#activeIndex));
			for (const index of collapseOrder) {
				labels[index] = this.#tabs[index].short ?? this.#tabs[index].label;
				chunks = buildChunks(labels);
				if (totalWidth(chunks) <= maxWidth) break;
			}
		}

		this.#hitZones = [];
		const lines: string[] = [];
		let currentLine = "";
		let currentWidth = 0;

		for (const chunk of chunks) {
			const chunkWidth = visibleWidth(chunk.text);
			if (chunkWidth <= 0) {
				continue;
			}

			if (chunkWidth > maxWidth) {
				if (currentLine) {
					lines.push(currentLine);
					currentLine = "";
					currentWidth = 0;
				}
				if (chunk.tabIndex !== undefined) {
					this.#hitZones.push({ line: lines.length, start: 0, end: maxWidth, index: chunk.tabIndex });
				}
				lines.push(truncateToWidth(chunk.text, maxWidth));
				continue;
			}

			if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}

			if (chunk.tabIndex !== undefined) {
				this.#hitZones.push({
					line: lines.length,
					start: currentWidth,
					end: currentWidth + chunkWidth,
					index: chunk.tabIndex,
				});
			}
			currentLine += chunk.text;
			currentWidth += chunkWidth;
		}

		if (currentLine) {
			lines.push(currentLine);
		}

		return lines.length > 0 ? lines : [""];
	}

	/**
	 * Resolve a pointer position against the last rendered frame. `line` is the
	 * 0-based line index within this component's render output, `col` the
	 * 0-based column.
	 */
	tabAt(line: number, col: number): Tab | undefined {
		for (const zone of this.#hitZones) {
			if (zone.line === line && col >= zone.start && col < zone.end) {
				return this.#tabs[zone.index];
			}
		}
		return undefined;
	}

	/** Highlight the tab under the pointer (null clears). */
	setHoverTab(id: string | null): void {
		this.#hoverTabId = id;
	}
}
