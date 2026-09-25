/**
 * ExtensionList - Inventory list with Master Switch and fuzzy search.
 *
 * When viewing a specific provider (not "ALL"), Row #0 is the Master Switch
 * that toggles the entire provider. All items below are dimmed when the
 * master switch is off.
 */
import type { Component } from "../../tui";
import { matchesKey } from "../../keys";
import { padding, truncateToWidth, visibleWidth } from "../../utils";
import { theme } from "../../theme";
import { matchesSelectDown, matchesSelectUp } from "../../keybinding-matchers";
import { contentRowWidth, renderScrollableList, searchableChar } from "../../chrome/selector-helpers";
import { MenuSelection } from "../../components/menu-selection";
import { scrollOffsetForRow, viewportRange } from "../../components/scroll-viewport";
import { sanitizeDisplayLine } from "./display-text";
import {
	formatExtensionListHint,
	joinListHints,
	liveToolsForExtension,
	projectListHint,
	type ToolRuntimeSource,
} from "./inspector-model";
import { snapshotToolRuntimeSource } from "./live-tool-session";
import {
	formatMcpListHint,
	isDiscoveredMcpServer,
	type MCPConnectionHealth,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
} from "./mcp-runtime";
import { applyFilter } from "./state-manager";
import {
	type Extension,
	type ExtensionKind,
	type ExtensionProvider,
	type ExtensionState,
	isShadowedExtension,
} from "./types";

export interface ExtensionListCallbacks {
	getProviders?: () => readonly ExtensionProvider[];
	onSelectionChange?: (extension: Extension | null) => void;
	onToggle?: (extensionId: string, enabled: boolean) => void;
	onMasterToggle?: (providerId: string) => void;
	onUserSourceToggle?: (providerId: string) => void;
	masterSwitchProvider?: string | null;
	mcpSource?: MCPRuntimeSource;
	toolSource?: ToolRuntimeSource;
}

const DEFAULT_MAX_VISIBLE = 15;

/** Stable identity for menu selection retention across rebuilds and filtering. */
function getListItemKey(item: ListItem): string {
	switch (item.type) {
		case "master":
			return `master:${item.providerId}`;
		case "user-source":
			return `user-source:${item.providerId}`;
		case "kind-header":
			return `kind:${item.kind}`;
		case "extension":
			// Shadowed same-name rows share the winner's id; the source path disambiguates them.
			return `extension:${item.item.id}:${item.item.path}`;
	}
}

/** Searchable text for a flattened row (the menu filter rebuilds via applyFilter; this covers headers/switches). */
function getListItemSearchText(item: ListItem): string {
	switch (item.type) {
		case "master":
			return `Enable ${item.providerName} Master Switch ${item.providerId}`;
		case "user-source":
			return `Load ${item.providerName} config user source ${item.providerId}`;
		case "kind-header":
			return `${item.label} ${item.kind}`;
		case "extension":
			return `${item.item.displayName} ${item.item.name} ${item.item.description ?? ""} ${item.item.trigger ?? ""}`;
	}
}

/** Flattened list item for rendering */
type ListItem =
	| { type: "master"; providerId: string; providerName: string; enabled: boolean }
	| { type: "user-source"; providerId: string; providerName: string; enabled: boolean }
	| { type: "kind-header"; kind: ExtensionKind; label: string; icon: string; count: number }
	| { type: "extension"; item: Extension };

export class ExtensionList implements Component {
	#menu: MenuSelection<ListItem>;
	#scrollOffset = 0;
	#focused = false;
	#masterSwitchProvider: string | null = null;
	#maxVisible: number;
	#hoveredIndex: number | null = null;
	/** Item rows rendered in the last frame, for mouse hit-testing. */
	#visibleCount = 0;
	#mcpSource: MCPRuntimeSource | undefined;
	#toolSource: ToolRuntimeSource | undefined;
	#toolFrame: ToolRuntimeSource | undefined;

	#extensions: Extension[];
	readonly #callbacks: ExtensionListCallbacks;

	constructor(extensions: Extension[], callbacks: ExtensionListCallbacks = {}, maxVisible?: number) {
		this.#extensions = extensions;
		this.#callbacks = callbacks;
		this.#masterSwitchProvider = callbacks.masterSwitchProvider ?? null;
		this.#mcpSource = callbacks.mcpSource;
		this.#toolSource = callbacks.toolSource;
		this.#maxVisible = maxVisible ?? DEFAULT_MAX_VISIBLE;
		this.#menu = new MenuSelection<ListItem>(this.#buildListItems(""), {
			getKey: getListItemKey,
			getSearchText: getListItemSearchText,
			filter: (_items, query) => this.#buildListItems(query),
		});
	}

	setMaxVisible(maxVisible: number): void {
		this.#maxVisible = maxVisible;
		this.#syncScroll();
	}

	setExtensions(extensions: Extension[]): void {
		this.#extensions = extensions;
		const keepIndex = this.#menu.selectedIndex;
		this.#menu.setItems(this.#buildListItems(""));
		this.#menu.setSelectedIndex(keepIndex);
		this.#syncScroll();
	}

	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	setMasterSwitchProvider(providerId: string | null): void {
		this.#masterSwitchProvider = providerId;
		this.#menu.setItems(this.#buildListItems(""));
		this.#syncScroll();
	}

	setMcpSource(source: MCPRuntimeSource | undefined): void {
		this.#mcpSource = source;
	}

	setToolSource(source: ToolRuntimeSource | undefined): void {
		this.#toolSource = source;
	}

	getSearchQuery(): string {
		return this.#menu.query;
	}

	resetSelection(): void {
		this.#menu.moveToBoundary("first");
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	getSelectedExtension(): Extension | null {
		const item = this.#menu.selectedItem;
		return item?.type === "extension" ? item.item : null;
	}

	/** Get the currently selected kind header (for preview purposes) */
	getSelectedKind(): ExtensionKind | null {
		const item = this.#menu.selectedItem;
		return item?.type === "kind-header" ? item.kind : null;
	}

	setSearchQuery(query: string): void {
		this.#menu.setQuery(query, false);
		this.#scrollOffset = 0;
		this.#notifySelectionChange();
	}

	clearSearch(): void {
		this.setSearchQuery("");
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		this.#toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		const lines: string[] = [];
		this.#visibleCount = 0;

		// Search bar
		const searchPrefix = theme.fg("muted", "Search: ");
		const query = this.#menu.query;
		const searchText = query || (this.#focused ? "" : theme.fg("dim", "type to filter"));
		const cursor = this.#focused ? theme.fg("accent", "_") : "";
		lines.push(searchPrefix + searchText + cursor);
		lines.push("");

		const items = this.#menu.visibleItems;
		if (items.length === 0) {
			lines.push(theme.fg("muted", "  No extensions found for this provider."));
			return lines;
		}

		// Determine if master switch is off (for dimming child items)
		const masterDisabled =
			this.#masterSwitchProvider !== null &&
			this.#callbacks.getProviders?.().find(provider => provider.id === this.#masterSwitchProvider)?.enabled ===
				false;

		// Calculate visible range (one fixed row per item)
		const { start: startIdx, end: endIdx } = viewportRange(items.length, this.#maxVisible, this.#scrollOffset);

		// Reserve the rightmost column for the scrollbar when overflowing
		const rowWidth = contentRowWidth(width, items.length, this.#maxVisible);

		// Render visible items
		const rows: string[] = [];
		for (let i = startIdx; i < endIdx; i++) {
			const listItem = items[i];
			if (!listItem) continue;
			const isSelected = this.#focused && i === this.#menu.selectedIndex;
			const isHovered = this.#focused && i === this.#hoveredIndex && !isSelected;

			let rowStr: string;
			if (listItem.type === "master") {
				rowStr = this.#renderMasterSwitch(listItem, isSelected, rowWidth);
			} else if (listItem.type === "user-source") {
				rowStr = this.#renderUserSourceSwitch(listItem, isSelected, masterDisabled, rowWidth);
			} else if (listItem.type === "kind-header") {
				rowStr = this.#renderKindHeader(listItem, isSelected, rowWidth);
			} else {
				rowStr = this.#renderExtensionRow(listItem.item, isSelected, rowWidth, masterDisabled);
			}
			if (isHovered) rowStr = theme.bg("selectedBg", rowStr);
			rows.push(rowStr);
		}
		this.#visibleCount = rows.length;

		lines.push(
			...renderScrollableList(rows, {
				width,
				totalRows: items.length,
				scrollOffset: this.#scrollOffset,
			}),
		);

		return lines;
	}

	#renderUserSourceSwitch(
		item: ListItem & { type: "user-source" },
		isSelected: boolean,
		masterDisabled: boolean,
		width: number,
	): string {
		const checkbox = item.enabled
			? theme.fg("success", theme.checkbox.checked)
			: theme.fg("dim", theme.checkbox.unchecked);
		const label = `Load ~/ ${item.providerName} config`;
		const badge = theme.fg("muted", "(opt-in; project config always loads)");

		let line = `${checkbox} ${theme.icon.folder} ${label}  ${badge}`;

		if (isSelected) {
			line = theme.bold(theme.fg("accent", line));
			line = theme.bg("selectedBg", line);
		} else if (!item.enabled || masterDisabled) {
			line = theme.fg("dim", line);
		}

		return truncateToWidth(line, width);
	}

	#renderMasterSwitch(item: ListItem & { type: "master" }, isSelected: boolean, width: number): string {
		const checkbox = item.enabled
			? theme.fg("success", theme.checkbox.checked)
			: theme.fg("dim", theme.checkbox.unchecked);
		const icon = theme.icon.package;
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

	#renderKindHeader(item: ListItem & { type: "kind-header" }, isSelected: boolean, width: number): string {
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

	#renderExtensionRow(ext: Extension, isSelected: boolean, width: number, masterDisabled: boolean): string {
		const shadowed = isShadowedExtension(ext);
		const effectivelyDisabled = masterDisabled || ext.state === "disabled";
		const mcpSnap =
			ext.kind === "mcp" && isDiscoveredMcpServer(ext.raw) && !shadowed
				? snapshotMcpRuntime(ext.raw, this.#mcpSource, {
						enabled: !effectivelyDisabled,
						shadowed: false,
					})
				: undefined;

		const stateIcon = shadowed
			? this.#getStateIcon("shadowed", masterDisabled)
			: mcpSnap
				? this.#getMcpHealthIcon(mcpSnap.health, masterDisabled)
				: this.#getStateIcon(ext.state, masterDisabled);
		let name = sanitizeDisplayLine(ext.displayName);
		const nameWidth = Math.min(24, width - 16);

		// Build the line with indentation (visually "inside" the master switch)
		let line = `   ${stateIcon} `;

		if (isSelected && !masterDisabled) {
			name = theme.bold(theme.fg("accent", name));
		} else if (effectivelyDisabled) {
			name = theme.fg("dim", name);
		} else if (shadowed) {
			name = theme.fg("warning", name);
		}

		// Pad name
		const namePadded = this.#padText(name, nameWidth);
		line += namePadded;

		const hint = mcpSnap
			? joinListHints(formatMcpListHint(mcpSnap), projectListHint(ext))
			: formatExtensionListHint(ext, ext.kind === "tool" ? liveToolsForExtension(ext, this.#toolFrame) : []);
		if (hint) {
			const triggerStyle = effectivelyDisabled
				? "dim"
				: mcpSnap?.health === "disconnected" || mcpSnap?.health === "inactive"
					? mcpSnap.health === "inactive"
						? "warning"
						: "dim"
					: "muted";
			const remainingWidth = width - visibleWidth(line) - 2;
			if (remainingWidth > 5) {
				line += `  ${truncateToWidth(theme.fg(triggerStyle, sanitizeDisplayLine(hint)), remainingWidth)}`;
			}
		}

		// Apply selection background
		if (isSelected) {
			line = theme.bg("selectedBg", line);
		}

		return truncateToWidth(line, width);
	}

	#getKindIcon(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return theme.icon.extensionTool;
			case "skill":
				return theme.icon.extensionSkill;
			case "tool":
				return theme.icon.extensionTool;
			case "slash-command":
				return theme.icon.extensionSlashCommand;
			case "mcp":
				return theme.icon.extensionMcp;
			case "rule":
				return theme.icon.extensionRule;
			case "hook":
				return theme.icon.extensionHook;
			case "prompt":
				return theme.icon.extensionPrompt;
			case "context-file":
				return theme.icon.extensionContextFile;
			case "instruction":
				return theme.icon.extensionInstruction;
			default:
				return theme.format.bullet;
		}
	}

	#getStateIcon(state: ExtensionState, masterDisabled: boolean): string {
		if (masterDisabled) {
			return theme.fg("dim", theme.status.disabled);
		}
		switch (state) {
			case "active":
				return theme.fg("success", theme.status.enabled);
			case "disabled":
				return theme.fg("dim", theme.status.disabled);
			case "shadowed":
				return theme.fg("warning", theme.status.shadowed);
		}
	}

	#getMcpHealthIcon(health: MCPConnectionHealth, masterDisabled: boolean): string {
		if (masterDisabled) {
			return theme.fg("dim", theme.status.disabled);
		}
		switch (health) {
			case "connected":
				return theme.fg("success", theme.status.enabled);
			case "connecting":
				return theme.fg("muted", theme.status.running);
			case "disconnected":
				return theme.fg("dim", theme.status.shadowed);
			case "inactive":
				return theme.fg("warning", theme.status.disabled);
		}
	}

	#padText(text: string, targetWidth: number): string {
		const width = visibleWidth(text);
		if (width >= targetWidth) {
			return truncateToWidth(text, targetWidth);
		}
		return text + padding(targetWidth - width);
	}

	/**
	 * Rebuild the flattened list for `query`: a flat applyFilter hit list while
	 * searching, otherwise the master-switch rows (provider scope) or the
	 * kind-grouped ALL view with headers.
	 */
	#buildListItems(query: string): ListItem[] {
		const items: ListItem[] = [];

		// Apply search filter
		const filtered = query.length > 0 ? applyFilter(this.#extensions, query) : this.#extensions;

		// When searching, show flat list
		if (query.length > 0) {
			for (const ext of filtered) {
				items.push({ type: "extension", item: ext });
			}
			return items;
		}

		// Provider-specific view: Master switch + flat list
		if (this.#masterSwitchProvider) {
			const providerName = filtered[0]?.source.providerName ?? this.#masterSwitchProvider;
			const provider = this.#callbacks.getProviders?.().find(provider => provider.id === this.#masterSwitchProvider);
			const enabled = provider?.enabled ?? true;

			items.push({
				type: "master",
				providerId: this.#masterSwitchProvider,
				providerName,
				enabled,
			});
			if (provider?.foreignUserSource) {
				items.push({
					type: "user-source",
					providerId: this.#masterSwitchProvider,
					providerName,
					enabled: provider.userSourceEnabled,
				});
			}

			for (const ext of filtered) {
				items.push({ type: "extension", item: ext });
			}
			return items;
		}

		// ALL view: Group by kind with headers
		const byKind = new Map<ExtensionKind, Extension[]>();
		for (const ext of filtered) {
			const list = byKind.get(ext.kind) ?? [];
			list.push(ext);
			byKind.set(ext.kind, list);
		}

		const kindOrder: ExtensionKind[] = [
			"extension-module",
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
			const kindItems = byKind.get(kind);
			if (!kindItems || kindItems.length === 0) continue;

			items.push({
				type: "kind-header",
				kind,
				label: this.#getKindLabel(kind),
				icon: this.#getKindIcon(kind),
				count: kindItems.length,
			});

			for (const ext of kindItems) {
				items.push({ type: "extension", item: ext });
			}
		}
		return items;
	}

	#getKindLabel(kind: ExtensionKind): string {
		switch (kind) {
			case "extension-module":
				return "Extension Modules";
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

	/** Keep the selection inside the one-row fixed viewport. */
	#syncScroll(): void {
		this.#scrollOffset = scrollOffsetForRow(
			this.#scrollOffset,
			this.#menu.selectedIndex,
			this.#menu.visibleItems.length,
			this.#maxVisible,
			"nearest",
		);
	}

	/** Toggle the selected item, or flip the provider master switch when on it. */
	#activateSelected(): void {
		const item = this.#menu.selectedItem;
		if (item?.type === "master") {
			this.#callbacks.onMasterToggle?.(item.providerId);
		} else if (item?.type === "user-source") {
			if (this.#callbacks.getProviders?.().find(provider => provider.id === item.providerId)?.enabled !== false)
				this.#callbacks.onUserSourceToggle?.(item.providerId);
		} else if (item?.type === "extension") {
			// Shadowed same-name rows share the winner's id (`mcp:github`).
			// Toggling them would mutate whichever config `find(id)` hits first.
			if (isShadowedExtension(item.item)) return;
			const masterDisabled =
				this.#masterSwitchProvider !== null &&
				this.#callbacks.getProviders?.().find(provider => provider.id === this.#masterSwitchProvider)?.enabled ===
					false;
			if (!masterDisabled) {
				const newEnabled = item.item.state === "disabled";
				this.#callbacks.onToggle?.(item.item.id, newEnabled);
			}
		}
	}

	/** Highlight the row under the pointer (null clears). */
	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index;
	}

	/**
	 * Map a 0-based line within this component's render to the absolute list-item
	 * index, or null when the line is the search banner, a padding row, or outside
	 * the visible window. The first two lines are the search banner and a blank
	 * separator; item rows follow, windowed at the current scroll offset.
	 */
	hitTest(line: number): number | null {
		const rowLine = line - 2;
		if (rowLine < 0 || rowLine >= this.#visibleCount) return null;
		const index = this.#scrollOffset + rowLine;
		return index < this.#menu.visibleItems.length ? index : null;
	}

	/** Wheel notch: move the selection (and the inspector) one row. */
	handleWheel(delta: -1 | 1): void {
		if (delta < 0) this.#moveSelectionUp();
		else this.#moveSelectionDown();
	}

	/** Click: select the row under the pointer, or activate it when already selected. */
	handleClick(line: number): void {
		const index = this.hitTest(line);
		if (index === null) return;
		if (index === this.#menu.selectedIndex) {
			this.#activateSelected();
			return;
		}
		this.#menu.setSelectedIndex(index);
		this.#notifySelectionChange();
	}

	handleInput(data: string): void {
		// Navigation (arrow keys / configurable tui.select.up/down). Bare j/k are
		// intentionally NOT navigation here: the search filter is always active, so
		// those letters must reach the query (e.g. searching for "jira"/"json").
		if (matchesSelectUp(data)) {
			this.#moveSelectionUp();
			return;
		}

		if (matchesSelectDown(data)) {
			this.#moveSelectionDown();
			return;
		}

		// Space or Enter: activate the selected row (toggle item / master switch)
		if (data === " " || matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateSelected();
			return;
		}

		// Backspace: Delete from search query
		if (matchesKey(data, "backspace")) {
			if (this.#menu.query.length > 0) {
				this.setSearchQuery(this.#menu.query.slice(0, -1));
			}
			return;
		}

		// Printable characters -> search
		const char = searchableChar(data);
		if (char !== null) {
			this.setSearchQuery(this.#menu.query + char);
		}
	}

	#moveSelectionUp(): void {
		if (this.#menu.move(-1, false)) {
			this.#syncScroll();
			this.#notifySelectionChange();
		}
	}

	#moveSelectionDown(): void {
		if (this.#menu.move(1, false)) {
			this.#syncScroll();
			this.#notifySelectionChange();
		}
	}

	#notifySelectionChange(): void {
		const ext = this.getSelectedExtension();
		this.#callbacks.onSelectionChange?.(ext);
	}
}
