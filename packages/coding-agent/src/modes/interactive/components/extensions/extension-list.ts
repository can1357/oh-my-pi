/**
 * ExtensionList - Inventory list with Master Switch and fuzzy search.
 *
 * When viewing a specific provider (not "ALL"), Row #0 is the Master Switch
 * that toggles the entire provider. All items below are dimmed when the
 * master switch is off.
 */

import {
	type Component,
	isArrowDown,
	isArrowUp,
	isBackspace,
	isEnter,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { isProviderEnabled } from "../../../../discovery";
import { theme } from "../../theme/theme";
import { applyFilter } from "./state-manager";
import type { Extension, ExtensionKind, ExtensionState } from "./types";

export interface ExtensionListCallbacks {
	/** Called when selection changes */
	onSelectionChange?: (extension: Extension | null) => void;
	/** Called when extension is toggled */
	onToggle?: (extensionId: string, enabled: boolean) => void;
	/** Called when master switch is toggled */
	onMasterToggle?: (providerId: string) => void;
	/** Provider ID for master switch (null = no master switch) */
	masterSwitchProvider?: string | null;
}

const MAX_VISIBLE = 25;

/** Flattened list item for rendering */
type ListItem =
	| { type: "master"; providerId: string; providerName: string; enabled: boolean }
	| { type: "kind-header"; kind: ExtensionKind; label: string; icon: string; count: number }
	| { type: "extension"; item: Extension };

export class ExtensionList implements Component {
	private extensions: Extension[] = [];
	private listItems: ListItem[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private searchQuery = "";
	private focused = false;
	private callbacks: ExtensionListCallbacks;
	private masterSwitchProvider: string | null = null;

	constructor(extensions: Extension[], callbacks: ExtensionListCallbacks = {}) {
		this.extensions = extensions;
		this.callbacks = callbacks;
		this.masterSwitchProvider = callbacks.masterSwitchProvider ?? null;
		this.rebuildList();
	}

	setExtensions(extensions: Extension[]): void {
		this.extensions = extensions;
		this.rebuildList();
		this.clampSelection();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	setMasterSwitchProvider(providerId: string | null): void {
		this.masterSwitchProvider = providerId;
		this.rebuildList();
	}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	resetSelection(): void {
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.notifySelectionChange();
	}

	getSelectedExtension(): Extension | null {
		const item = this.listItems[this.selectedIndex];
		return item?.type === "extension" ? item.item : null;
	}

	/** Get the currently selected kind header (for preview purposes) */
	getSelectedKind(): ExtensionKind | null {
		const item = this.listItems[this.selectedIndex];
		return item?.type === "kind-header" ? item.kind : null;
	}

	setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.rebuildList();
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.notifySelectionChange();
	}

	clearSearch(): void {
		this.setSearchQuery("");
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Search bar
		const searchPrefix = theme.fg("muted", "Search: ");
		const searchText = this.searchQuery || (this.focused ? "" : theme.fg("dim", "type to filter"));
		const cursor = this.focused ? theme.fg("accent", "_") : "";
		lines.push(searchPrefix + searchText + cursor);
		lines.push("");

		if (this.listItems.length === 0) {
			lines.push(theme.fg("muted", "  No extensions found for this provider."));
			return lines;
		}

		// Determine if master switch is off (for dimming child items)
		const masterDisabled = this.masterSwitchProvider !== null && !isProviderEnabled(this.masterSwitchProvider);

		// Calculate visible range
		const startIdx = this.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE, this.listItems.length);

		// Render visible items
		for (let i = startIdx; i < endIdx; i++) {
			const listItem = this.listItems[i];
			const isSelected = this.focused && i === this.selectedIndex;

			if (listItem.type === "master") {
				lines.push(this.renderMasterSwitch(listItem, isSelected, width));
			} else if (listItem.type === "kind-header") {
				lines.push(this.renderKindHeader(listItem, isSelected, width));
			} else {
				lines.push(this.renderExtensionRow(listItem.item, isSelected, width, masterDisabled));
			}
		}

		// Scroll indicator
		if (this.listItems.length > MAX_VISIBLE) {
			const indicator = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.listItems.length})`);
			lines.push(indicator);
		}

		return lines;
	}

	private renderMasterSwitch(item: ListItem & { type: "master" }, isSelected: boolean, width: number): string {
		const checkbox = item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
		const icon = "📦";
		const label = `Enable ${item.providerName}`;
		const badge = theme.fg("warning", "(Master Switch)");

		let line = `${checkbox} ${icon} ${label}  ${badge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else if (!item.enabled) {
			line = theme.fg("dim", line);
		}

		return truncateToWidth(line, width);
	}

	private renderKindHeader(item: ListItem & { type: "kind-header" }, isSelected: boolean, width: number): string {
		const countBadge = theme.fg("muted", `(${item.count})`);
		let line = `${item.icon} ${item.label} ${countBadge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else {
			line = theme.fg("muted", line);
		}

		return truncateToWidth(line, width);
	}

	private renderExtensionRow(ext: Extension, isSelected: boolean, width: number, masterDisabled: boolean): string {
		// When master is disabled, all items appear dimmed
		const effectivelyDisabled = masterDisabled || ext.state === "disabled";

		// Status icon
		const stateIcon = this.getStateIcon(ext.state, masterDisabled);

		// Name
		let name = ext.displayName;
		const nameWidth = Math.min(24, width - 16);

		// Build the line with indentation (visually "inside" the master switch)
		let line = `   ${stateIcon} `;

		if (isSelected && !masterDisabled) {
			name = theme.bold(theme.fg("accent", name));
		} else if (effectivelyDisabled) {
			name = theme.fg("dim", name);
		} else if (ext.state === "shadowed") {
			name = theme.fg("warning", name);
		}

		// Pad name
		const namePadded = this.padText(name, nameWidth);
		line += namePadded;

		// Trigger hint
		if (ext.trigger) {
			const triggerStyle = effectivelyDisabled ? "dim" : "muted";
			const remainingWidth = width - visibleWidth(line) - 2;
			if (remainingWidth > 5) {
				line += `  ${truncateToWidth(theme.fg(triggerStyle as "dim" | "muted", ext.trigger), remainingWidth)}`;
			}
		}

		// Apply selection background
		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return truncateToWidth(line, width);
	}

	private getKindIcon(kind: ExtensionKind): string {
		switch (kind) {
			case "skill":
				return "⚡";
			case "tool":
				return "🔧";
			case "slash-command":
				return "🔗";
			case "mcp":
				return "🔄";
			case "rule":
				return "📋";
			case "hook":
				return "🪝";
			case "prompt":
				return "💬";
			case "context-file":
				return "📄";
			case "instruction":
				return "📌";
			default:
				return "•";
		}
	}

	private getStateIcon(state: ExtensionState, masterDisabled: boolean): string {
		if (masterDisabled) {
			return theme.fg("dim", "○");
		}
		switch (state) {
			case "active":
				return theme.fg("success", "●");
			case "disabled":
				return theme.fg("dim", "⊘");
			case "shadowed":
				return theme.fg("warning", "◐");
		}
	}

	private padText(text: string, targetWidth: number): string {
		const width = visibleWidth(text);
		if (width >= targetWidth) {
			return truncateToWidth(text, targetWidth);
		}
		return text + " ".repeat(targetWidth - width);
	}

	private rebuildList(): void {
		this.listItems = [];

		// Apply search filter
		const filtered = this.searchQuery.length > 0 ? applyFilter(this.extensions, this.searchQuery) : this.extensions;

		// When searching, show flat list
		if (this.searchQuery.length > 0) {
			for (const ext of filtered) {
				this.listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		// Provider-specific view: Master switch + flat list
		if (this.masterSwitchProvider) {
			const providerName = filtered[0]?.source.providerName ?? this.masterSwitchProvider;
			const enabled = isProviderEnabled(this.masterSwitchProvider);

			this.listItems.push({
				type: "master",
				providerId: this.masterSwitchProvider,
				providerName,
				enabled,
			});

			for (const ext of filtered) {
				this.listItems.push({ type: "extension", item: ext });
			}
			return;
		}

		// ALL view: Group by kind with headers
		const byKind = new Map<ExtensionKind, Extension[]>();
		for (const ext of filtered) {
			const list = byKind.get(ext.kind) ?? [];
			list.push(ext);
			byKind.set(ext.kind, list);
		}

		const kindOrder: ExtensionKind[] = [
			"skill",
			"tool",
			"slash-command",
			"rule",
			"mcp",
			"hook",
			"prompt",
			"context-file",
			"instruction",
		];

		for (const kind of kindOrder) {
			const items = byKind.get(kind);
			if (!items || items.length === 0) continue;

			this.listItems.push({
				type: "kind-header",
				kind,
				label: this.getKindLabel(kind),
				icon: this.getKindIcon(kind),
				count: items.length,
			});

			for (const ext of items) {
				this.listItems.push({ type: "extension", item: ext });
			}
		}
	}

	private getKindLabel(kind: ExtensionKind): string {
		switch (kind) {
			case "skill":
				return "Skills";
			case "tool":
				return "Tools";
			case "slash-command":
				return "Commands";
			case "rule":
				return "Rules";
			case "mcp":
				return "MCP Servers";
			case "hook":
				return "Hooks";
			case "prompt":
				return "Prompts";
			case "context-file":
				return "Context";
			case "instruction":
				return "Instructions";
			default:
				return kind;
		}
	}

	private clampSelection(): void {
		if (this.listItems.length === 0) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}

		this.selectedIndex = Math.min(this.selectedIndex, this.listItems.length - 1);
		this.selectedIndex = Math.max(0, this.selectedIndex);

		// Adjust scroll offset
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
		}
	}

	handleInput(data: string): void {
		const charCode = data.length === 1 ? data.charCodeAt(0) : -1;

		// Navigation
		if (isArrowUp(data) || data === "k") {
			this.moveSelectionUp();
			return;
		}

		if (isArrowDown(data) || data === "j") {
			this.moveSelectionDown();
			return;
		}

		// Space: Toggle selected item
		if (data === " ") {
			const item = this.listItems[this.selectedIndex];
			if (item?.type === "master") {
				this.callbacks.onMasterToggle?.(item.providerId);
			} else if (item?.type === "extension") {
				// Only allow toggling if master is enabled
				const masterDisabled = this.masterSwitchProvider !== null && !isProviderEnabled(this.masterSwitchProvider);
				if (!masterDisabled) {
					const newEnabled = item.item.state === "disabled";
					this.callbacks.onToggle?.(item.item.id, newEnabled);
				}
			}
			return;
		}

		// Enter: Same as space - toggle selected item
		if (isEnter(data)) {
			const item = this.listItems[this.selectedIndex];
			if (item?.type === "master") {
				this.callbacks.onMasterToggle?.(item.providerId);
			} else if (item?.type === "extension") {
				const masterDisabled = this.masterSwitchProvider !== null && !isProviderEnabled(this.masterSwitchProvider);
				if (!masterDisabled) {
					const newEnabled = item.item.state === "disabled";
					this.callbacks.onToggle?.(item.item.id, newEnabled);
				}
			}
			return;
		}

		// Backspace: Delete from search query
		if (isBackspace(data)) {
			if (this.searchQuery.length > 0) {
				this.setSearchQuery(this.searchQuery.slice(0, -1));
			}
			return;
		}

		// Printable characters -> search
		if (data.length === 1 && charCode > 32 && charCode < 127) {
			// Skip j/k as they're navigation
			if (data === "j" || data === "k") {
				return;
			}
			this.setSearchQuery(this.searchQuery + data);
			return;
		}
	}

	private moveSelectionUp(): void {
		if (this.selectedIndex > 0) {
			this.selectedIndex--;
			if (this.selectedIndex < this.scrollOffset) {
				this.scrollOffset = this.selectedIndex;
			}
			this.notifySelectionChange();
		}
	}

	private moveSelectionDown(): void {
		if (this.selectedIndex < this.listItems.length - 1) {
			this.selectedIndex++;
			if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
				this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
			}
			this.notifySelectionChange();
		}
	}

	private notifySelectionChange(): void {
		const ext = this.getSelectedExtension();
		this.callbacks.onSelectionChange?.(ext);
	}
}
