/**
 * ExtensionDashboard - Tabbed layout for the Extension Control Center.
 *
 * Layout:
 * - Top: Horizontal tab bar for provider selection
 * - Body: 2-column grid (inventory list | preview panel)
 *
 * Navigation:
 * - TAB/Shift+TAB: Cycle through provider tabs
 * - Up/Down/j/k: Navigate list
 * - Space: Toggle selected item (or master switch)
 * - Esc: Close dashboard (clears search first if active)
 */

import {
	type Component,
	Container,
	isCtrlC,
	isEscape,
	isShiftTab,
	isTab,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { SettingsManager } from "../../../../core/settings-manager";
import { theme } from "../../theme/theme";
import { DynamicBorder } from "../dynamic-border";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import { applyFilter, createInitialState, filterByProvider, refreshState, toggleProvider } from "./state-manager";
import type { DashboardState } from "./types";

export class ExtensionDashboard extends Container {
	private state: DashboardState;
	private mainList: ExtensionList;
	private inspector: InspectorPanel;
	private settingsManager: SettingsManager | null;
	private cwd: string;

	public onClose?: () => void;

	constructor(cwd: string, settingsManager: SettingsManager | null = null) {
		super();
		this.cwd = cwd;
		this.settingsManager = settingsManager;
		const disabledIds = settingsManager?.getDisabledExtensions() ?? [];
		this.state = createInitialState(cwd, disabledIds);

		// Create main list - always focused
		this.mainList = new ExtensionList(this.state.searchFiltered, {
			onSelectionChange: (ext) => {
				this.state.selected = ext;
				this.inspector.setExtension(ext);
			},
			onToggle: (extensionId, enabled) => {
				this.handleExtensionToggle(extensionId, enabled);
			},
			onMasterToggle: (providerId) => {
				this.handleProviderToggle(providerId);
			},
			masterSwitchProvider: this.getActiveProviderId(),
		});
		this.mainList.setFocused(true);

		// Create inspector
		this.inspector = new InspectorPanel();
		if (this.state.selected) {
			this.inspector.setExtension(this.state.selected);
		}

		this.buildLayout();
	}

	private getActiveProviderId(): string | null {
		const tab = this.state.tabs[this.state.activeTabIndex];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	private buildLayout(): void {
		this.clear();

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", " Extension Control Center")), 0, 0));

		// Tab bar
		this.addChild(new Text(this.renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		// Help text
		// 2-column body
		this.addChild(new TwoColumnBody(this.mainList, this.inspector));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " ↑/↓: navigate  Space: toggle  Tab: next provider  Esc: close"), 0, 0));

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	private renderTabBar(): string {
		const parts: string[] = [" "];

		for (let i = 0; i < this.state.tabs.length; i++) {
			const tab = this.state.tabs[i];
			const isActive = i === this.state.activeTabIndex;
			const isEmpty = tab.count === 0 && tab.id !== "all";
			const isDisabled = !tab.enabled && tab.id !== "all";

			// Build label with count
			let label = tab.label;
			if (tab.count > 0) {
				label += ` (${tab.count})`;
			}

			// Apply strikethrough for disabled providers
			const displayLabel = isDisabled ? `${label.split("").join("\u0336")}\u0336` : label;

			if (isActive) {
				// Active tab: background highlight
				parts.push(theme.bg("selectedBg", ` ${displayLabel} `));
			} else if (isDisabled) {
				// Disabled provider: strikethrough + dim
				parts.push(theme.fg("dim", ` ${displayLabel} `));
			} else if (isEmpty) {
				// Empty enabled provider: very dim, unselectable
				parts.push(`\x1b[38;5;238m ${label} \x1b[0m`);
			} else {
				// Normal enabled provider
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}

		return parts.join("");
	}

	private handleProviderToggle(providerId: string): void {
		toggleProvider(providerId);
		this.refreshFromState();
	}

	private handleExtensionToggle(extensionId: string, enabled: boolean): void {
		if (!this.settingsManager) return;

		if (enabled) {
			this.settingsManager.enableExtension(extensionId);
		} else {
			this.settingsManager.disableExtension(extensionId);
		}

		this.refreshFromState();
	}

	private refreshFromState(): void {
		// Remember current tab ID before refresh
		const currentTabId = this.state.tabs[this.state.activeTabIndex]?.id;

		const disabledIds = this.settingsManager?.getDisabledExtensions() ?? [];
		this.state = refreshState(this.state, this.cwd, disabledIds);

		// Find the same tab in the new (re-sorted) list
		if (currentTabId) {
			const newIndex = this.state.tabs.findIndex((t) => t.id === currentTabId);
			if (newIndex >= 0) {
				this.state.activeTabIndex = newIndex;
			}
		}

		this.mainList.setExtensions(this.state.searchFiltered);
		this.mainList.setMasterSwitchProvider(this.getActiveProviderId());

		if (this.state.selected) {
			this.inspector.setExtension(this.state.selected);
		}

		this.buildLayout();
	}

	private switchTab(direction: 1 | -1): void {
		const numTabs = this.state.tabs.length;
		if (numTabs === 0) return;

		// Find next selectable tab (skip empty+enabled providers)
		let nextIndex = this.state.activeTabIndex;
		for (let i = 0; i < numTabs; i++) {
			nextIndex = (nextIndex + direction + numTabs) % numTabs;
			const tab = this.state.tabs[nextIndex];
			const isEmptyEnabled = tab.count === 0 && tab.enabled && tab.id !== "all";
			if (!isEmptyEnabled) break;
		}
		this.state.activeTabIndex = nextIndex;

		// Re-filter for new tab
		const tab = this.state.tabs[this.state.activeTabIndex];
		this.state.tabFiltered = filterByProvider(this.state.extensions, tab.id);
		this.state.searchFiltered = applyFilter(this.state.tabFiltered, this.state.searchQuery);
		this.state.listIndex = 0;
		this.state.scrollOffset = 0;
		this.state.selected = this.state.searchFiltered[0] ?? null;

		// Update list
		this.mainList.setExtensions(this.state.searchFiltered);
		this.mainList.setMasterSwitchProvider(this.getActiveProviderId());
		this.mainList.resetSelection();

		if (this.state.selected) {
			this.inspector.setExtension(this.state.selected);
		}

		this.buildLayout();
	}

	handleInput(data: string): void {
		// Ctrl+C - close immediately
		if (isCtrlC(data)) {
			this.onClose?.();
			return;
		}

		// Escape - clear search first, then close
		if (isEscape(data)) {
			if (this.state.searchQuery.length > 0) {
				this.state.searchQuery = "";
				this.state.searchFiltered = this.state.tabFiltered;
				this.mainList.setExtensions(this.state.searchFiltered);
				this.mainList.clearSearch();
				this.buildLayout();
				return;
			}
			this.onClose?.();
			return;
		}

		// Tab/Shift+Tab: Cycle through tabs
		if (isTab(data)) {
			this.switchTab(1);
			return;
		}
		if (isShiftTab(data)) {
			this.switchTab(-1);
			return;
		}

		// All other input goes to the list
		this.mainList.handleInput(data);

		// Sync search query back to state
		const query = this.mainList.getSearchQuery();
		if (query !== this.state.searchQuery) {
			this.state.searchQuery = query;
			this.state.searchFiltered = applyFilter(this.state.tabFiltered, query);
		}
	}
}

/**
 * Two-column body component for side-by-side rendering.
 */
class TwoColumnBody implements Component {
	private leftPane: ExtensionList;
	private rightPane: InspectorPanel;

	constructor(left: ExtensionList, right: InspectorPanel) {
		this.leftPane = left;
		this.rightPane = right;
	}

	render(width: number): string[] {
		const leftWidth = Math.floor(width * 0.5);
		const rightWidth = width - leftWidth - 3;

		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);

		const maxLines = Math.max(leftLines.length, rightLines.length);
		const combined: string[] = [];
		const separator = theme.fg("dim", " │ ");

		for (let i = 0; i < maxLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			combined.push(leftPadded + separator + right);
		}

		return combined;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
