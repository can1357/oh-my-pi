import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	type Component,
	Container,
	extractPrintableText,
	fuzzyRank,
	getKeybindings,
	getSettingItemFilterText,
	type ImageBudget,
	Input,
	matchesKey,
	replaceTabs,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Spacer,
	type Tab,
	TabBar,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import {
	getDefault,
	getType,
	isCredential,
	isSettingsInitialized,
	normalizeProviderMaxInFlightRequests,
	onProjectSettingsReconciled,
	type SettingPath,
	Settings,
	type SettingsScope,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../config/settings";
import type {
	ContextLineMode,
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../../config/settings-schema";
import { SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import {
	detectTerminalAppearance,
	getCurrentThemeName,
	getSelectListTheme,
	getSettingsListTheme,
	type SymbolPreset,
	theme,
} from "../../modes/theme/theme";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { getTabBarTheme } from "../shared";
import { type ComposerPreviewStatusSource, ComposerShapePreview } from "./composer-shape-preview";
import { getComposerShapeOptions } from "./composer-shape-registry";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { SnapcompactShapePreview } from "./snapcompact-shape-preview";
import { getPreset } from "./status-line/presets";

/**
 * A submenu component for selecting from a list of options.
 */
/**
 * Submenu component for free-text string settings.
 * Mirrors the ConfigInputSubmenu pattern from plugin-settings.ts.
 */
class TextInputSubmenu extends Container {
	#input: Input;
	#error: Text;

	constructor(
		label: string,
		description: string,
		currentValue: string,
		secret: boolean,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.#input = new Input();
		this.#input.mask = secret;
		if (currentValue) {
			this.#input.setValue(currentValue);
		}
		this.#error = new Text("", 0, 0);
		this.#input.onSubmit = value => {
			try {
				this.onSubmit(value); // empty string clears the setting
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#error.setText(theme.fg("error", truncateToWidth(replaceTabs(message).replace(/[\r\n]+/g, " "), 100)));
			}
		};
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#error);
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel · Clear field to unset"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

class SelectSubmenu extends Container {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId: number = 0;
	#selectListLineOffset = 0;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void | Promise<void>,
		private readonly getPreview?: () => string,
		footer?: Component,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Preview (if provided)
		if (getPreview) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			this.#previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.#previewText);
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex(o => o.value === currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.#selectList.onSelectionChange = item => {
				const requestId = ++this.#previewUpdateRequestId;
				const result = onSelectionChange(item.value);
				if (result && typeof (result as Promise<void>).then === "function") {
					void (result as Promise<void>).finally(() => {
						if (requestId === this.#previewUpdateRequestId) {
							this.#updatePreview();
						}
					});
					return;
				}
				if (requestId === this.#previewUpdateRequestId) {
					this.#updatePreview();
				}
			};
		}

		this.addChild(this.#selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));

		// Footer (e.g. the snapcompact shape preview) below the interactive rows,
		// so the list never shifts while browsing.
		if (footer) {
			this.addChild(new Spacer(1));
			this.addChild(footer);
		}
	}

	#updatePreview(): void {
		if (this.#previewText && this.getPreview) {
			this.#previewText.setText(this.getPreview());
		}
	}

	/**
	 * Concatenate children like Container.render, recording where the select
	 * list lands so routed mouse events can be hit-tested against it.
	 */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) {
				this.#selectListLineOffset = lines.length;
			}
			lines.push(...childLines);
		}
		return lines;
	}

	/** Mouse routed from the host: wheel steps, hover lights, click confirms. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/**
 * Submenu for array-of-enum settings: every option is a toggle row. Enter or
 * Space flips membership; ordered lists render 1-based positions and reorder
 * the highlighted member with ←/→. Changes apply live; Esc goes back.
 */
class MultiSelectSubmenu extends Container {
	#selectList!: SelectList;
	#value: string[];
	#cursor = 0;
	#selectListLineOffset = 0;
	#pressedItemId: string | undefined;
	#dropItemId: string | undefined;
	constructor(
		private readonly title: string,
		private readonly description: string,
		private readonly options: ReadonlyArray<SelectItem>,
		initial: readonly string[],
		private readonly ordered: boolean,
		private readonly onApply: (value: string[]) => void,
		private readonly onClose: () => void,
	) {
		super();
		// Drop stale ids (renamed/removed providers) so positions stay contiguous.
		this.#value = initial.filter(id => options.some(option => option.value === id));
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", this.title)), 0, 0));
		if (this.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", this.description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items = this.options.map((option): SelectItem => {
			const position = this.#value.indexOf(option.value);
			const mark =
				position === -1
					? theme.fg("dim", this.ordered ? " · " : " ○ ")
					: this.ordered
						? theme.fg("accent", `${String(position + 1).padStart(2)}.`)
						: theme.fg("accent", " ● ");
			return { value: option.value, label: `${mark} ${option.label}`, description: option.description };
		});
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		this.#selectList.setSelectedIndex(this.#cursor);
		this.#selectList.onSelect = item => this.#toggle(item.value);
		this.#selectList.onSelectionChange = item => {
			this.#cursor = this.options.findIndex(option => option.value === item.value);
		};
		this.#selectList.onCancel = this.onClose;
		this.addChild(this.#selectList);

		this.addChild(new Spacer(1));
		const hint = this.ordered
			? "  Click to toggle · drag selected items to reorder · ←/→ move · 1-9 place · Esc to go back"
			: "  Click/Enter/Space to toggle · Esc to go back";
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	#apply(next: string[]): void {
		this.#value = next;
		this.onApply([...next]);
		this.#rebuild();
	}

	#toggle(id: string): void {
		const next = this.#value.includes(id) ? this.#value.filter(v => v !== id) : [...this.#value, id];
		this.#apply(next);
	}

	#move(id: string, delta: -1 | 1): void {
		const from = this.#value.indexOf(id);
		if (from === -1) return;
		const to = from + delta;
		if (to < 0 || to >= this.#value.length) return;
		const next = [...this.#value];
		next[from] = next[to]!;
		next[to] = id;
		this.#apply(next);
	}

	/** Move a selected item before another selected item, retaining every other preference. */
	#moveBefore(id: string, beforeId: string): void {
		if (id === beforeId) return;
		const next = this.#value.filter(value => value !== id);
		const target = next.indexOf(beforeId);
		if (target === -1) return;
		next.splice(target, 0, id);
		this.#apply(next);
	}

	/** Splice the option into the 1-based `position` of the selection (adding it if unselected). */
	#placeAt(id: string, position: number): void {
		const next = this.#value.filter(v => v !== id);
		next.splice(Math.min(position - 1, next.length), 0, id);
		this.#apply(next);
	}

	/** Concatenate children, recording the select list's line offset for mouse routing. */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) {
				this.#selectListLineOffset = lines.length;
			}
			lines.push(...childLines);
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const itemIndex = this.#selectList.hitTest(line - this.#selectListLineOffset);
		if (event.wheel !== null) {
			routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
			return;
		}
		if (event.motion) {
			this.#selectList.setHoverIndex(itemIndex ?? null);
			const target = itemIndex === undefined ? undefined : this.options[itemIndex]?.value;
			if (
				this.ordered &&
				this.#pressedItemId !== undefined &&
				target !== undefined &&
				target !== this.#pressedItemId &&
				this.#value.includes(target)
			) {
				this.#dropItemId = target;
			}
			return;
		}
		if (event.leftClick && itemIndex !== undefined) {
			const item = this.options[itemIndex];
			if (!item) return;
			this.#cursor = itemIndex;
			this.#selectList.setSelectedIndex(itemIndex);
			this.#pressedItemId = item.value;
			this.#dropItemId = item.value;
			return;
		}
		if (!event.release) return;

		const pressedItemId = this.#pressedItemId;
		const dropItemId = this.#dropItemId;
		this.#pressedItemId = undefined;
		this.#dropItemId = undefined;
		if (!pressedItemId) return;
		if (this.ordered && dropItemId !== undefined && dropItemId !== pressedItemId) {
			this.#moveBefore(pressedItemId, dropItemId);
			return;
		}
		this.#toggle(pressedItemId);
	}

	handleInput(data: string): void {
		const current = this.options[this.#cursor]?.value;
		if (data === " " && current !== undefined) {
			this.#toggle(current);
			return;
		}
		if (this.ordered && current !== undefined && (data === "\x1b[D" || data === "\x1b[C")) {
			this.#move(current, data === "\x1b[D" ? -1 : 1);
			return;
		}
		if (this.ordered && current !== undefined && data.length === 1 && data >= "1" && data <= "9") {
			this.#placeAt(current, Number(data));
			return;
		}
		this.#selectList.handleInput(data);
	}
}

class ProviderLimitsSubmenu extends Container {
	#selectList: SelectList | undefined;

	constructor(
		private readonly providers: readonly string[],
		private readonly getLimits: () => Record<string, number>,
		private readonly onChange: (value: Record<string, number>) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = this.getLimits();
		return [...new Set([...this.providers, ...Object.keys(limits)])].sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Max In-Flight Requests")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const limits = this.getLimits();
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? "Unlimited" : `Limit: ${limit}`,
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: "Clear all limits", description: "Make every provider unlimited" }];
		const items = [...providerItems, ...clearItem];
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "__clear_all") {
				this.onChange({});
				this.#showProviderList();
				this.requestRender?.();
				return;
			}
			this.#showProviderEditor(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit provider · Esc to go back"), 0, 0));
	}

	#showProviderEditor(provider: string): void {
		const limits = this.getLimits();
		this.clear();
		this.#selectList = undefined;
		this.addChild(
			new TextInputSubmenu(
				`Max In-Flight Requests: ${provider}`,
				"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				limits[provider]?.toString() ?? "",
				false,
				value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = validateProviderMaxInFlightRequests(next);
					this.onChange(normalized);
					this.#showProviderList();
					this.requestRender?.();
				},
				() => {
					this.#showProviderList();
					this.requestRender?.();
				},
			),
		);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

let cachedSidebarWidth: number | undefined;
/**
 * Split-sidebar width derived from every group name in the schema (not just
 * the visible tab), so the divider column never moves when switching tabs or
 * when condition-gated groups appear.
 */
function settingsSidebarWidth(): number {
	if (cachedSidebarWidth === undefined) {
		let nameWidth = 0;
		for (const tab of SETTING_TABS) {
			for (const def of getSettingsForTab(tab)) {
				if (def.group) nameWidth = Math.max(nameWidth, visibleWidth(def.group));
			}
		}
		cachedSidebarWidth = Math.min(22, nameWidth) + 4;
	}
	return cachedSidebarWidth;
}

function getSettingsTabs(): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			return { id, label: `${icon} ${meta.label}`, short: icon };
		}),
		{ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package },
	];
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Provider/source ids shown in /model. */
	providers: string[];
	/** Working directory for plugins tab */
	cwd: string;
	/** Active model (api + id); resolves what the snapcompact `auto` shape maps to. */
	model?: ShapeTarget;
	/** Shared TUI image budget (graphics ids + transmit-once) for image previews. */
	imageBudget?: ImageBudget;
	/** Schedules a re-render after async preview work completes. */
	requestRender?: () => void;
	/** Live status renderer for composer-shape previews (the session's status line). */
	composerPreviewStatus?: ComposerPreviewStatusSource;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	contextLine?: ContextLineMode;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	showHookStatus?: boolean;
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
	segmentOptions?: Record<string, unknown>;
}
export interface ThemePreviewOptions {
	symbolPreset?: SymbolPreset;
	colorBlindMode?: boolean;
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: SettingPath, newValue: unknown) => void;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string, options?: ThemePreviewOptions) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void | Promise<void>;
	/** Called when settings panel is closed */
	onCancel: () => void;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#scope: SettingsScope;
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#searchQuery = "";
	/** Single-line editor backing the search banner (cursor, word ops, paste). */
	#searchInput = new Input();
	#searchMatchCount = 0;
	/** First matching item id per tab id, for Tab-key jumps while searching. */
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	#hasSectionJump = false;
	#unsubscribeProjectSettings?: () => void;
	/** Cached overlay title for project scope; VCS discovery is not render-safe. */
	#projectLabel: string;
	/** Live theme before the first scoped preview; close restores this if the effective name cannot load. */
	#themeBeforePreview: string | undefined;
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
	) {
		this.#themeBeforePreview = getCurrentThemeName();
		this.#projectLabel = settingsProjectLabel(this.context.cwd);
		this.#scope = settings.hasProjectConfig() ? "project" : "global";
		// No label prefix (the frame title already says Settings) and no
		// "(tab to cycle)" hint (folded into the footer hint line).
		this.#tabBar = new TabBar("", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				// While searching, tabs act as jump targets into the result list.
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};
		// Initialize with first tab and preview the selected scope's
		// appearance so an overlay cannot pin the live theme/status.
		this.#switchToTab("appearance");
		this.#previewAppearanceForScope();
		this.#unsubscribeProjectSettings = onProjectSettingsReconciled((paths, source) => {
			if (!isSettingsInitialized() || source !== Settings.instance) return;
			this.#resyncItemsFromSettings(paths);
		});
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
			}
		});
	}

	#footerHintText(): string {
		if (this.#searchList) {
			return "Enter to change · Tab to jump tabs · Alt+S to switch scope · Esc to exit search";
		}
		if (this.#currentTabId === "plugins") {
			return "Tab to switch tabs · Esc to close";
		}
		const scope = this.#scope === "project" ? "Alt+S to switch scope · Del to inherit" : "Alt+S to switch scope";
		if (this.#currentList?.sectionFocused) {
			return `↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · ${scope} · Esc to close`;
		}
		const nav = this.#hasSectionJump ? "Tab to jump sections · ←/→ to switch tabs" : "Tab to switch tabs";
		return `Enter/Space to change · ${nav} · ${scope} · Type to search · Esc to close`;
	}

	/** Single-line search banner: accent icon, editable query with live cursor, right-aligned match count. */
	#renderSearchBanner(width: number): string {
		const icon = theme.symbol("icon.search");
		const countText = this.#searchMatchCount === 1 ? "1 match" : `${this.#searchMatchCount} matches`;
		const rightWidth = visibleWidth(countText) + 1; // trailing margin
		const prefix = ` ${theme.fg("accent", icon)} `;
		// The input pads itself to exactly this width and keeps the cursor in view.
		const inputWidth = Math.max(4, width - visibleWidth(prefix) - rightWidth - 1);
		const inputLine = this.#searchInput.render(inputWidth)[0] ?? "";
		const count = theme.fg(this.#searchMatchCount > 0 ? "dim" : "warning", countText);
		return truncateToWidth(`${prefix}${theme.bold(inputLine)} ${count} `, width);
	}

	/**
	 * Fullscreen frame: title border, tab row, divider, optional search banner,
	 * the active content sized to fill the terminal, the appearance preview,
	 * then a footer hint pinned above the bottom border.
	 */
	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#tabBar.render(innerWidth);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance";
		const previewLines = showPreview ? ["", theme.fg("muted", "Preview:"), this.#getStatusPreviewString()] : [];

		// Fixed chrome: top border, tabs, divider, [search row], divider, hint, bottom border.
		const fixedRows = 1 + tabLines.length + 1 + (searching ? 1 : 0) + 1 + 1 + 1;
		const contentRows = Math.max(7, height - fixedRows - previewLines.length);

		const list = this.#searchList ?? this.#currentList;
		let contentLines: readonly string[];
		if (list) {
			// SettingsList pads itself to viewport + blank + 3 description rows.
			list.setMaxVisible(contentRows - 4);
			contentLines = list.render(innerWidth);
		} else if (this.#pluginComponent) {
			contentLines = this.#pluginComponent.render(innerWidth);
		} else {
			contentLines = [];
		}

		const out: string[] = [];
		out.push(topBorder(width, this.#title()));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		if (searching) {
			out.push(row(this.#renderSearchBanner(innerWidth), width));
		}
		this.#contentRowStart = out.length;
		this.#contentRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) {
			out.push(row(contentLines[i] ?? "", width));
		}
		for (const line of previewLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		out.push(row(theme.fg("dim", this.#footerHintText()), width));
		out.push(bottomBorder(width));
		return out;
	}

	/**
	 * Route an SGR mouse report against the frame geometry of the last render.
	 * Wheel scrolls the focused list, motion drives the hover highlights (tabs
	 * and rows), and a left click activates: tabs switch (or jump, while
	 * searching), a row click selects, and a click on the already-selected row
	 * activates it (toggle / open submenu).
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const list = this.#searchList ?? this.#currentList;
		// row() insets content by the border column plus a space.
		const contentColInset = 2;
		const innerCol = event.col - contentColInset;
		const contentLine = event.row - this.#contentRowStart;

		// An open submenu owns the pointer: wheel, hover, and clicks route into
		// it (text-input submenus ignore routed events).
		if (list?.hasOpenSubmenu()) {
			list.routeSubmenuMouse(event, contentLine, innerCol);
			return true;
		}

		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;

		if (event.wheel !== null) {
			if (overContent) {
				list?.handleWheelAt(event.wheel, contentLine, innerCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			// hoverTest: never light up pane rows while the pointer is on the
			// sidebar — only rows the pointer is actually on.
			list?.setHoverItem(overContent ? (list.hoverTest(contentLine, innerCol) ?? null) : null);
			return true;
		}
		if (!event.leftClick) return true;

		if (overTabs) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return true;
		}
		if (overContent && list) {
			const itemId = list.hoverTest(contentLine, innerCol);
			const id = itemId ?? list.hitTest(contentLine, innerCol);
			if (id !== undefined) {
				const wasSelected = list.getSelectedItem()?.id === id;
				list.selectItem(id);
				// Only repeated setting-row clicks activate. Sidebar section clicks navigate.
				if (wasSelected && itemId !== undefined) list.handleInput("\n");
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Global search (type-to-search across every tab)
	// ═══════════════════════════════════════════════════════════════════════

	/** Swap the tab content for the global search result list. */
	#startSearch(initialQuery: string): void {
		this.#preSearchTabId = this.#currentTabId;
		this.#searchInput = new Input();
		this.#searchInput.prompt = "";
		this.#searchInput.setValue(initialQuery);
		const list = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			(id, newValue) => this.#onSearchSettingChange(id as SettingPath, newValue),
			() => this.#close(),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: "No matching settings",
				hint: "",
			},
		);
		// Keep the footer tab highlight on the tab owning the selected result.
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		this.#setContent(() => {
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	/**
	 * Recompute matches across every settings tab. Results render as one flat
	 * list with a heading row per tab; the footer tab bar reorders to show
	 * matching tabs (with counts) first and the rest muted at the end.
	 */
	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		if (query.length === 0) {
			this.#endSearch(false);
			return;
		}
		this.#searchQuery = query;

		const counts = new Map<SettingTab, number>();
		const items: SettingItem[] = [];
		const tabResults: { tab: SettingTab; matched: SettingItem[]; bestScore: number; order: number }[] = [];
		this.#searchFirstMatch.clear();
		let total = 0;
		for (const tab of SETTING_TABS) {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(tab)) {
				const item = this.#defToItem(def);
				if (item) candidates.push(item);
			}
			const ranked = fuzzyRank(candidates, query, getSettingItemFilterText);
			const matched = ranked.map(result => result.item);
			counts.set(tab, matched.length);
			if (matched.length === 0) continue;
			total += matched.length;
			tabResults.push({
				tab,
				matched,
				bestScore: ranked[0]?.score ?? 0,
				order: SETTING_TABS.indexOf(tab),
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0])} ${meta.label}`,
				currentValue: "",
				heading: true,
			});
			this.#searchFirstMatch.set(result.tab, result.matched[0]?.id ?? "");
			items.push(...result.matched);
		}

		this.#searchList.setItems(items);
		this.#searchMatchCount = total;
		this.#tabBar.setTabs(
			this.#buildSearchTabs(
				counts,
				tabResults.map(result => result.tab),
			),
		);
		this.#syncTabBarToSelection(this.#searchList.getSelectedItem());
	}

	/**
	 * Leave search mode. With `jumpToSelection`, land on the tab containing
	 * the selected result and keep it selected there — search doubles as
	 * navigation. Otherwise restore the pre-search tab.
	 */
	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selected = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selected ? getSettingDef(selected.id as SettingPath) : undefined;
		const targetTab: SettingTab | "plugins" = selectedDef?.tab ?? this.#preSearchTabId;

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(getSettingsTabs(), targetTab);
		this.#switchToTab(targetTab);
		if (selectedDef) {
			this.#currentList?.selectItem(selectedDef.path);
		}
	}

	/** Matching tabs first (counts attached), ordered by best result score; the rest stay muted at the end. */
	#buildSearchTabs(counts: Map<SettingTab, number>, matchedTabOrder: readonly SettingTab[]): Tab[] {
		const matched: Tab[] = [];
		const empty: Tab[] = [];
		const matchedIds = new Set<SettingTab>(matchedTabOrder);
		for (const id of matchedTabOrder) {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${meta.label} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of SETTING_TABS) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			empty.push({ id, label: `${icon} ${meta.label}`, short: icon, muted: true });
		}
		// Plugins hosts its own UI; it is not part of the schema-backed search.
		empty.push({ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package, muted: true });
		return [...matched, ...empty];
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(item.id as SettingPath);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	/** Value-change dispatch for the search result list (any tab's setting). */
	#onSearchSettingChange(path: SettingPath, newValue: string): void {
		const def = getSettingDef(path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			this.#persistSetting(path, boolValue);
		} else if (def.type === "enum") {
			this.#persistSetting(path, newValue);
		}
		// Submenu/text types already persisted inside their own done callbacks.
		// Reapply the full scoped appearance so a shadowed global theme commit
		// cannot leave the live theme on the project-effective mapping.
		if (def.tab === "appearance") {
			this.#previewAppearanceForScope();
		}
		// Values feed the searchable text and condition gates may have flipped:
		// recompute results in place (selection is preserved by item id).
		this.#setSearchQuery(this.#searchQuery);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	#defToItem(def: SettingDef): SettingItem | null {
		// Check condition: applies to every variant — booleans, enums, submenus, text inputs.
		if (def.condition && !def.condition(this.#scope)) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);
		const item = {
			id: def.path,
			label: def.label,
			description: def.description,
			warning: def.warning,
			changed: this.#isChanged(def, currentValue),
		};

		switch (def.type) {
			case "boolean":
				return { ...item, currentValue: currentValue ? "true" : "false", values: ["true", "false"] };

			case "enum":
				return { ...item, currentValue: String(currentValue ?? ""), values: [...def.values] };

			case "submenu":
				return {
					...item,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					submenu: (cv, done) => this.#createSubmenu(def, cv, done),
				};

			case "text":
				return {
					...item,
					currentValue: this.#formatTextInputValue(def, currentValue),
					submenu: (cv, done) => this.#createTextInput(def, cv, done),
				};

			case "providerLimits":
				return {
					...item,
					currentValue: this.#formatProviderLimitsValue(currentValue),
					submenu: (_cv, done) => this.#createProviderLimitsInput(done),
				};

			case "multiselect":
				return {
					...item,
					currentValue: this.#formatMultiSelectValue(def, currentValue),
					submenu: (_cv, done) => this.#createMultiSelect(def, done),
				};
		}
	}

	/**
	 * Value shown and edited for a setting in the active persistence scope:
	 * the global-layer value in global scope, or global plus project sources
	 * in project scope. Overlays and runtime overrides are excluded so a
	 * `--config` pin cannot freeze the row while edits write below it.
	 */
	#scopedValue(path: SettingPath): unknown {
		return this.#scope === "global" ? settings.getGlobalValue(path) : settings.getProjectScopedValue(path);
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return this.#scopedValue(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		const defaultValue: unknown = getDefault(def.path);
		if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
			return (
				currentValue.length !== defaultValue.length ||
				currentValue.some((entry, index) => entry !== defaultValue[index])
			);
		}
		return !Object.is(currentValue, defaultValue);
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (path === "compaction.thresholdPercent" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		if (path === "compaction.thresholdTokens" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		return rawValue;
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		let options = def.options;

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			// Prepend `auto`; the rest are the model's runtime-supported efforts.
			const levels: ConfiguredThinkingLevel[] = [AUTO_THINKING, ...this.context.availableThinkingLevels];
			options = levels.map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.context.availableThemes.map(t => ({ value: t, label: t }));
		} else if (def.path === "composer.shape") {
			options = getComposerShapeOptions();
		}
		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		let footer: Component | undefined;

		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => {
				return this.callbacks.onThemePreview?.(
					value,
					this.#themePreviewOptions(this.#scopedValue("symbolPreset"), this.#scopedValue("colorBlindMode")),
				);
			};
			onPreviewCancel = () => {
				this.#triggerThemePreview(
					this.#loadableScopedThemeName(),
					this.#themePreviewOptions(this.#scopedValue("symbolPreset"), this.#scopedValue("colorBlindMode")),
				);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.#triggerStatusLinePreview({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
			onPreviewCancel = () => {
				this.#triggerStatusLinePreview();
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.#triggerStatusLinePreview({ separator: value as StatusLineSeparatorStyle });
			};
			onPreviewCancel = () => {
				this.#triggerStatusLinePreview();
			};
		} else if (def.path === "statusLine.contextLine") {
			onPreview = value => {
				this.#triggerStatusLinePreview({ contextLine: value as ContextLineMode });
			};
			onPreviewCancel = () => {
				this.#triggerStatusLinePreview();
			};
		} else if (def.path === "snapcompact.shape") {
			const shapePreview = new SnapcompactShapePreview(currentValue, {
				model: this.context.model,
				imageBudget: this.context.imageBudget,
				requestRender: this.context.requestRender,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		} else if (def.path === "composer.shape") {
			const shapePreview = new ComposerShapePreview(String(currentValue ?? "band"), {
				requestRender: this.context.requestRender,
				status: this.context.composerPreviewStatus,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		}
		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			def.description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				done(this.#getSubmenuCurrentValue(def.path, this.#scopedValue(def.path)));
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
		);
	}

	/**
	 * Create a text input submenu for a plain string setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Container {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return new TextInputSubmenu(
			def.label,
			def.description,
			this.#formatTextInputEditValue(def.path, this.#scopedValue(def.path)),
			def.secret,
			value => {
				// Empty string clears the setting; undefined-typed string settings
				// store "" which the browser.ts expandPath ignores (no-op fallback).
				this.#setSettingValue(def.path, value);
				wrappedDone(this.#formatTextInputValue(def, this.#scopedValue(def.path)));
			},
			() => wrappedDone(),
		);
	}

	#createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.context.providers,
			() => normalizeProviderMaxInFlightRequests(this.#scopedValue("providers.maxInFlightRequests")),
			value => {
				this.#persistRecordScopeSetting("providers.maxInFlightRequests", value);
				done(this.#formatProviderLimitsValue(this.#scopedValue("providers.maxInFlightRequests")));
			},
			() => done(),
			this.context.requestRender,
		);
	}

	#formatProviderLimitsValue(value: unknown): string {
		const limits = normalizeProviderMaxInFlightRequests(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return "Unlimited";
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	#getMultiSelectOptions(def: SettingDef & { type: "multiselect" }) {
		if (def.path !== "providers.webSearchOrder") return def.options;
		const excluded: unknown = this.#scopedValue("providers.webSearchExclude");
		if (!Array.isArray(excluded)) return def.options;
		return def.options.filter(option => !excluded.includes(option.value));
	}

	#createMultiSelect(def: SettingDef & { type: "multiselect" }, done: (value?: string) => void): Container {
		const options = this.#getMultiSelectOptions(def);
		const current: unknown = this.#scopedValue(def.path);
		const initial = Array.isArray(current)
			? current.filter((entry): entry is string => typeof entry === "string")
			: [];
		return new MultiSelectSubmenu(
			def.label,
			def.description,
			options,
			initial,
			def.ordered,
			value => {
				this.#persistSetting(def.path, value);
			},
			() => done(this.#formatMultiSelectValue(def, this.#scopedValue(def.path))),
		);
	}

	#formatMultiSelectValue(def: SettingDef & { type: "multiselect" }, value: unknown): string {
		const options = this.#getMultiSelectOptions(def);
		const labels = Array.isArray(value)
			? value.flatMap(entry => {
					if (typeof entry !== "string") return [];
					const option = options.find(candidate => candidate.value === entry);
					return option ? [option.label] : [];
				})
			: [];
		if (labels.length === 0) return def.ordered ? "default" : "none";
		return def.ordered ? labels.join(" → ") : labels.join(", ");
	}

	#formatTextInputValue(def: SettingDef & { type: "text" }, value: unknown): string {
		if (def.secret) return value ? "••••••••" : "";
		return this.#formatTextInputEditValue(def.path, value);
	}

	#formatTextInputEditValue(_path: SettingPath, value: unknown): string {
		if (value === undefined || value === null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Persist a setting in the selected scope and return the recomputed merged
	 * effective value. Row display reads {@link #scopedValue} separately, while
	 * runtime callbacks must stay aligned with the active project configuration.
	 * Shadowed-scope writes that leave the merged value unchanged skip the live
	 * callback so session/editor side effects are not reapplied.
	 */
	#persistSetting(path: SettingPath, value: unknown): unknown {
		if (this.#scope === "project" && isCredential(path)) {
			const inherited = settings.getProjectInheritedValue(path);
			if (Bun.deepEquals(value, inherited) && Bun.deepEquals(this.#scopedValue(path), inherited)) {
				return settings.get(path);
			}
		}
		const previous = settings.get(path);
		settings.set(path, value as never, this.#scope);
		return this.#notifyLiveChange(path, previous, settings.get(path));
	}
	/**
	 * Persist a record setting in the selected scope. Editors submit the full
	 * effective map; write only keys that differ from the inherited (global +
	 * non-native project) layer, plus `null` tombstones for cleared keys.
	 * Existing native overrides that still differ are kept.
	 */
	#persistRecordScopeSetting(path: SettingPath, value: Record<string, unknown>): unknown {
		const previous = settings.get(path);
		if (this.#scope === "global") {
			settings.set(path, value as never, "global");
			return this.#notifyLiveChange(path, previous, settings.get(path));
		}
		if (path === "providers.maxInFlightRequests") {
			const inherited = normalizeProviderMaxInFlightRequests(settings.getProjectInheritedValue(path));
			const limits = normalizeProviderMaxInFlightRequests(value);
			const next: Record<string, number | null> = {};
			for (const provider of new Set([...Object.keys(inherited), ...Object.keys(limits)])) {
				const nextLimit = limits[provider];
				if (nextLimit === undefined) {
					next[provider] = null;
					continue;
				}
				if (nextLimit !== inherited[provider]) next[provider] = nextLimit;
			}
			settings.set(path, next as never, "project");
			return this.#notifyLiveChange(path, previous, settings.get(path));
		}
		const inheritedRaw = settings.getProjectInheritedValue(path);
		const inherited =
			inheritedRaw && typeof inheritedRaw === "object" && !Array.isArray(inheritedRaw)
				? (inheritedRaw as Record<string, unknown>)
				: {};
		const next: Record<string, unknown> = {};
		for (const key of new Set([...Object.keys(inherited), ...Object.keys(value)])) {
			const nextValue = value[key];
			if (nextValue === undefined) {
				next[key] = null;
				continue;
			}
			if (!Bun.deepEquals(nextValue, inherited[key])) next[key] = nextValue;
		}
		settings.set(path, next as never, "project");
		return this.#notifyLiveChange(path, previous, settings.get(path));
	}

	#notifyLiveChange(path: SettingPath, previous: unknown, next: unknown): unknown {
		if (!Bun.deepEquals(previous, next)) {
			this.callbacks.onChange(path, next);
		}
		return next;
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: SettingPath, value: string): unknown {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (path === "compaction.thresholdPercent" && value === "default") {
			return this.#persistSetting(path, -1);
		}
		if (path === "compaction.thresholdTokens" && value === "default") {
			return this.#persistSetting(path, -1);
		}
		if (schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			return this.#persistRecordScopeSetting(path, parsed as Record<string, unknown>);
		}
		if (typeof currentValue === "number") {
			return this.#persistSetting(path, Number(value));
		}
		if (typeof currentValue === "boolean") {
			return this.#persistSetting(path, value === "true");
		}
		return this.#persistSetting(path, value);
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);

		const items = this.#buildItemsForDefs(defs);
		// Mirror SettingsList's section detection (leading ungrouped items form
		// an implicit section) so the footer hint only advertises PgUp/PgDn
		// when the jump actually changes sections.
		const sectionCount = items.filter(item => item.heading).length + (items.length > 0 && !items[0].heading ? 1 : 0);
		this.#hasSectionJump = sectionCount >= 2;

		this.#currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					this.#persistSetting(path, boolValue);
				} else if (def.type === "enum") {
					this.#persistSetting(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Boolean
				// appearance edits and search-mode edits already reapply the scoped
				// preview; do the same here so a global submenu commit cannot leave
				// the live theme or status line on the project-effective mapping.
				if (tabId === "appearance") {
					this.#previewAppearanceForScope();
				}
				// Re-run the definition-to-item mapping so condition-gated settings
				// (e.g. the Hindsight cluster guarded by memory.backend) appear or
				// disappear immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#close(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", sidebarWidth: settingsSidebarWidth() },
		);
	}

	/**
	 * Map a definition list to UI items, dropping any whose condition is false.
	 * Inserts a heading row whenever the (group-sorted) definition list crosses
	 * into a new group; groups whose items are all condition-hidden emit none.
	 */
	#buildItemsForDefs(defs: SettingDef[]): SettingItem[] {
		const items: SettingItem[] = [];
		let lastGroup: string | undefined;
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.group && def.group !== lastGroup) {
				items.push({ id: `__heading:${def.group}`, label: def.group, currentValue: "", heading: true });
				lastGroup = def.group;
			}
			items.push(item);
		}
		return items;
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs));
	}

	/**
	 * Rebuild the visible list after a project save adopts disk values so a
	 * skipped same-key edit cannot leave stale item snapshots on screen.
	 * Open submenus are recreated only in project scope when their backing
	 * setting (or a setting they filter by) was adopted: SettingsList leaves
	 * them untouched across setItems, an unrelated sibling adoption must not
	 * discard in-progress text or select cursor state, and a global editor
	 * is backed by the global layer so a project adoption cannot change it.
	 */
	#resyncItemsFromSettings(adoptedPaths: readonly SettingPath[]): void {
		const list = this.#searchList ?? this.#currentList;
		const openSubmenuId = list?.getOpenSubmenuItemId() ?? null;
		if (this.#searchList) {
			this.#setSearchQuery(this.#searchQuery);
		} else if (this.#currentTabId !== "plugins") {
			const selectedId = this.#currentList?.getSelectedItem()?.id;
			this.#refreshCurrentTabItems(getSettingsForTab(this.#currentTabId));
			if (selectedId) this.#currentList?.selectItem(selectedId);
		}
		const shouldRefreshOpenSubmenu =
			this.#scope === "project" &&
			openSubmenuId !== null &&
			list !== null &&
			(!list.hasItem(openSubmenuId) || this.#openSubmenuDependsOnAdoptedPaths(openSubmenuId, adoptedPaths));
		if (shouldRefreshOpenSubmenu && list) {
			const refreshed = list.refreshOpenSubmenu();
			if (!refreshed && this.#textInputActive && !list.hasOpenSubmenu()) {
				this.#textInputActive = false;
			}
		}
		// Adopted theme/status/symbol/color-blind values first apply the
		// project-effective appearance through setting hooks. Reassert the
		// selected scope even when the current tab or search result is not an
		// appearance editor; otherwise global-scope rows keep rendering the
		// project-effective preview until the next scope/tab action.
		if (adoptedPaths.some(path => getSettingDef(path)?.tab === "appearance")) {
			this.#previewAppearanceForScope();
		}
		this.context.requestRender?.();
	}

	#openSubmenuDependsOnAdoptedPaths(itemId: string, adoptedPaths: readonly SettingPath[]): boolean {
		if (adoptedPaths.includes(itemId as SettingPath)) return true;
		return itemId === "providers.webSearchOrder" && adoptedPaths.includes("providers.webSearchExclude");
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(overrides?: StatusLinePreviewSettings): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: this.#scopedValue("statusLine.preset") as StatusLinePreset,
			leftSegments: this.#scopedValue("statusLine.leftSegments") as StatusLineSegmentId[],
			rightSegments: this.#scopedValue("statusLine.rightSegments") as StatusLineSegmentId[],
			separator: this.#scopedValue("statusLine.separator") as StatusLineSeparatorStyle,
			showHookStatus: this.#scopedValue("statusLine.showHookStatus") as boolean,
			sessionAccent: this.#scopedValue("statusLine.sessionAccent") as boolean,
			transparent: this.#scopedValue("statusLine.transparent") as boolean,
			compactThinkingLevel: this.#scopedValue("statusLine.compactThinkingLevel") as boolean,
			contextLine: this.#scopedValue("statusLine.contextLine") as ContextLineMode,
			segmentOptions: this.#scopedValue("statusLine.segmentOptions") as Record<string, unknown>,
			...overrides,
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.#close(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
			requestRender: this.context.requestRender,
		});
	}

	#title(): string {
		if (this.#currentTabId === "plugins") return "Settings";
		if (this.#scope === "global") return "Settings · global";
		return `Settings · ${this.#projectLabel}`;
	}

	#switchScope(): void {
		this.#scope = this.#scope === "project" ? "global" : "project";
		if (this.#searchList) {
			this.#setSearchQuery(this.#searchQuery);
		} else if (this.#currentTabId !== "plugins") {
			const selectedId = this.#currentList?.getSelectedItem()?.id;
			this.#switchToTab(this.#currentTabId);
			if (selectedId) this.#currentList?.selectItem(selectedId);
		}
		this.#previewAppearanceForScope();
		this.context.requestRender?.();
	}

	#previewAppearanceForScope(): void {
		this.#triggerThemePreview(
			this.#loadableScopedThemeName(),
			this.#themePreviewOptions(this.#scopedValue("symbolPreset"), this.#scopedValue("colorBlindMode")),
		);
		this.#triggerStatusLinePreview();
	}

	#scopedThemeName(): string | undefined {
		return this.#themeName(this.#scopedValue("theme.dark"), this.#scopedValue("theme.light"));
	}

	#loadableScopedThemeName(): string | undefined {
		const name = this.#scopedThemeName();
		if (name && this.context.availableThemes.includes(name)) return name;
		// Deleted or overlay-only names must not keep the previous scope's
		// preview. Startup falls back to dark when this mapping is effective.
		return name ? "dark" : undefined;
	}

	#effectiveThemeName(): string | undefined {
		return this.#themeName(settings.get("theme.dark"), settings.get("theme.light"));
	}

	#themePreviewOptions(symbolPreset: unknown, colorBlindMode: unknown): ThemePreviewOptions {
		return {
			symbolPreset:
				symbolPreset === "unicode" || symbolPreset === "nerd" || symbolPreset === "ascii"
					? symbolPreset
					: undefined,
			colorBlindMode: typeof colorBlindMode === "boolean" ? colorBlindMode : undefined,
		};
	}

	#themeName(dark: unknown, light: unknown): string | undefined {
		const preferred = detectTerminalAppearance() === "light" ? light : dark;
		if (typeof preferred === "string" && preferred.length > 0) return preferred;
		if (typeof dark === "string" && dark.length > 0) return dark;
		if (typeof light === "string" && light.length > 0) return light;
		return undefined;
	}

	#triggerThemePreview(themeName: string | undefined, options: ThemePreviewOptions): void {
		if (themeName) void this.callbacks.onThemePreview?.(themeName, options);
	}

	/**
	 * Prefer a theme the selector can load. Deleted custom names and overlay
	 * paths that never made `availableThemes` restore the live fallback captured
	 * before the first scoped preview, then `dark`.
	 */
	#loadableThemeName(name: string | undefined): string | undefined {
		if (name && this.context.availableThemes.includes(name)) return name;
		return this.#themeBeforePreview ?? (name ? "dark" : undefined);
	}

	/**
	 * Close the selector. Alt+S previews the selected layer's theme and
	 * status line; reload the effective appearance so closing does not keep
	 * rendering a scope that was never persisted. If the effective name
	 * cannot load (deleted custom theme, overlay pointing at a missing file),
	 * restore the live fallback captured before the first scoped preview.
	 */
	#close(): void {
		this.#unsubscribeProjectSettings?.();
		this.#unsubscribeProjectSettings = undefined;
		this.#triggerThemePreview(
			this.#loadableThemeName(this.#effectiveThemeName()),
			this.#themePreviewOptions(settings.get("symbolPreset"), settings.get("colorBlindMode")),
		);
		this.#triggerEffectiveStatusLinePreview();
		this.callbacks.onCancel();
	}

	#triggerEffectiveStatusLinePreview(): void {
		this.callbacks.onStatusLinePreview?.({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
			contextLine: settings.get("statusLine.contextLine"),
			segmentOptions: settings.get("statusLine.segmentOptions"),
		});
	}

	#inheritSelectedSetting(): void {
		const item = this.#currentList?.getSelectedItem();
		const def = item ? getSettingDef(item.id as SettingPath) : undefined;
		if (!def) return;
		const previous = settings.get(def.path);
		if (!settings.clearProject(def.path)) return;
		this.#notifyLiveChange(def.path, previous, settings.get(def.path));
		if (def.tab === "appearance") {
			this.#previewAppearanceForScope();
		}
		this.#refreshCurrentTabItems(getSettingsForTab(def.tab));
		this.context.requestRender?.();
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// Text-input submenus take every byte: arrow keys must reach the
		// cursor and Tab must not switch tabs.
		if (this.#textInputActive) {
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;

		// An open submenu owns input entirely — Tab/arrows/typing belong to it.
		if (activeList?.hasOpenSubmenu()) {
			activeList.handleInput(data);
			return;
		}

		if (this.#currentTabId !== "plugins" && matchesKey(data, "alt+s")) {
			this.#switchScope();
			return;
		}
		if (!this.#searchList && this.#scope === "project" && matchesKey(data, "delete")) {
			this.#inheritSelectedSetting();
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}

		// Tab toggles keyboard focus between section headings and setting rows
		// (fast section hopping); tabs without sections keep Tab switching tabs.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#currentList?.hasSectionFocusTargets()) {
				this.#currentList.toggleSectionFocus();
				return;
			}
			this.#tabBar.handleInput(data);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.#tabBar.handleInput(data);
			return;
		}

		// Printable characters start a search across every settings tab. The
		// plugins tab keeps its own local filtering instead.
		if (this.#currentTabId !== "plugins") {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#startSearch(printable);
				return;
			}
		}

		if (this.#currentList) {
			this.#currentList.handleInput(data);
		} else if (this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
		}
	}

	#handleSearchModeInput(data: string, list: SettingsList): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			// Exit search, landing on the tab of the selected result.
			this.#endSearch(true);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// Jump between tabs that have matches (muted tabs are skipped).
			this.#tabBar.handleInput(data);
			return;
		}
		// Selection, paging, and activation stay with the result list.
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.select.confirm") ||
			data === "\n"
		) {
			list.handleInput(data);
			return;
		}
		// Everything else edits the query like a regular single-line editor:
		// cursor movement, word ops, kill ring, undo, paste.
		this.#searchInput.handleInput(data);
		const value = this.#searchInput.getValue();
		if (value !== this.#searchQuery) this.#setSearchQuery(value);
	}
}

function settingsProjectLabel(cwd: string): string {
	let primary: string | null = null;
	try {
		primary = vcs.repo(cwd)?.primaryRoot() ?? null;
	} catch {
		primary = null;
	}
	const base = path.basename(primary ?? cwd);
	const name = base.endsWith(".git") ? base.slice(0, -4) : base;
	const cleaned = replaceTabs(sanitizeText(name))
		.replace(/[\r\n]+/g, " ")
		.trim();
	return cleaned || "project";
}
