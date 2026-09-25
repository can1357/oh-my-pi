import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
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
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type MouseRoutable,
	type SgrMouseEvent,
	type Tab,
	TabBar,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import type {
	ContextLineMode,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../status-line/schema";
import {
	SETTING_TABS,
	TAB_METADATA,
	type SettingTab,
	type SettingsHost,
	type SettingsDisplayEntry,
} from "./settings-defs";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import { getTabBarTheme } from "../chrome/shared";
import { type ComposerPreviewStatusSource, ComposerShapePreview } from "./composer-shape-preview";
import { getComposerShapeOptions } from "./composer-shape-registry";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { PluginSettingsComponent, type PluginSettingsHost } from "./plugin-settings";
import { getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { SnapcompactShapePreview } from "./snapcompact-shape-preview";
import { getPreset } from "../status-line/presets";
import { FormField, SelectFormField, TextFormField } from "../components/form";
import { formTheme } from "../chrome/form-theme";

/**
 * Free-text string setting field backed by the shared text form field.
 * Current values prefill, including secrets retained behind Input masking;
 * submitting an empty string clears the setting and validation errors stay inline.
 */
function createSettingsTextField(
	label: string,
	description: string,
	currentValue: string,
	secret: boolean,
	onSubmit: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): TextFormField {
	return new TextFormField({
		theme: formTheme,
		label,
		description: description || undefined,
		secret,
		initialValue: currentValue || undefined,
		empty: "submit",
		hint: "  Enter to save · Esc to cancel · Clear field to unset",
		onSubmit,
		onCancel,
		requestRender,
	});
}

/**
 * Single-choice setting field backed by the shared select form field.
 * Preserves the current selection, live async previews, footer previews,
 * and select/cancel dispatch of the bespoke submenu it replaces.
 */
function createSettingsSelectField(
	title: string,
	description: string,
	options: ReadonlyArray<SelectItem>,
	currentValue: string,
	onSelect: (value: string) => void,
	onCancel: () => void,
	onSelectionChange?: (value: string) => void | Promise<void>,
	getPreview?: () => string,
	footer?: Component,
	requestRender?: () => void,
): SelectFormField {
	return new SelectFormField({
		theme: formTheme,
		label: title,
		description: description || undefined,
		items: options,
		currentValue,
		maxVisible: 10,
		selectTheme: getSelectListTheme(),
		getPreview,
		onSelectionChange,
		onSubmit: onSelect,
		onCancel,
		hint: "  Enter to select · Esc to go back",
		footer,
		requestRender,
	});
}

/**
 * Submenu for array-of-enum settings: every option is a toggle row. Enter or
 * Space flips membership; ordered lists render 1-based positions and reorder
 * the highlighted member with ←/→. Changes apply live; Esc goes back.
 */
class MultiSelectSubmenu extends Container {
	#selectList!: SelectList;
	#field!: FormField;
	#value: string[];
	#cursor = 0;
	#pressedItemId: string | undefined;
	#dropItemId: string | undefined;
	readonly #title: string;
	readonly #description: string;
	readonly #options: ReadonlyArray<SelectItem>;
	readonly #ordered: boolean;
	readonly #onApply: (value: string[]) => void;
	readonly #onClose: () => void;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		initial: readonly string[],
		ordered: boolean,
		onApply: (value: string[]) => void,
		onClose: () => void,
	) {
		super();
		this.#title = title;
		this.#description = description;
		this.#options = options;
		this.#ordered = ordered;
		this.#onApply = onApply;
		this.#onClose = onClose;
		// Drop stale ids (renamed/removed providers) so positions stay contiguous.
		this.#value = initial.filter(id => options.some(option => option.value === id));
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();

		const items = this.#options.map((option): SelectItem => {
			const position = this.#value.indexOf(option.value);
			const mark =
				position === -1
					? theme.fg("dim", this.#ordered ? " · " : " ○ ")
					: this.#ordered
						? theme.fg("accent", `${String(position + 1).padStart(2)}.`)
						: theme.fg("accent", " ● ");
			return { value: option.value, label: `${mark} ${option.label}`, description: option.description };
		});
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		this.#selectList.setSelectedIndex(this.#cursor);
		this.#selectList.onSelect = item => this.#toggle(item.value);
		this.#selectList.onSelectionChange = item => {
			this.#cursor = this.#options.findIndex(option => option.value === item.value);
		};
		this.#selectList.onCancel = this.#onClose;
		const hint = this.#ordered
			? "  Click to toggle · drag selected items to reorder · ←/→ move · 1-9 place · Esc to go back"
			: "  Click/Enter/Space to toggle · Esc to go back";
		this.#field = new FormField(this.#selectList, {
			theme: formTheme,
			label: this.#title,
			description: this.#description || undefined,
			hint,
		});
		this.addChild(this.#field);
	}

	#apply(next: string[]): void {
		this.#value = next;
		this.#onApply([...next]);
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

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const controlLine = this.#field.controlLineAt(line);
		if (controlLine === undefined) return;
		const itemIndex = this.#selectList.hitTest(controlLine);
		if (event.wheel !== null) {
			routeSelectListMouse(this.#selectList, event, controlLine);
			return;
		}
		if (event.motion) {
			this.#selectList.setHoverIndex(itemIndex ?? null);
			const target = itemIndex === undefined ? undefined : this.#options[itemIndex]?.value;
			if (
				this.#ordered &&
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
			const item = this.#options[itemIndex];
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
		if (this.#ordered && dropItemId !== undefined && dropItemId !== pressedItemId) {
			this.#moveBefore(pressedItemId, dropItemId);
			return;
		}
		this.#toggle(pressedItemId);
	}

	handleInput(data: string): void {
		const current = this.#options[this.#cursor]?.value;
		if (data === " " && current !== undefined) {
			this.#toggle(current);
			return;
		}
		if (this.#ordered && current !== undefined && (data === "\x1b[D" || data === "\x1b[C")) {
			this.#move(current, data === "\x1b[D" ? -1 : 1);
			return;
		}
		if (this.#ordered && current !== undefined && data.length === 1 && data >= "1" && data <= "9") {
			this.#placeAt(current, Number(data));
			return;
		}
		this.#selectList.handleInput(data);
	}
}

class ProviderLimitsSubmenu extends Container {
	#listField: SelectFormField | undefined;
	readonly #settings: SettingsHost;
	readonly #providers: readonly string[];
	readonly #onChange: (value: Record<string, number>) => void;
	readonly #onCancel: () => void;
	readonly #requestRender: (() => void) | undefined;

	constructor(
		settings: SettingsHost,
		providers: readonly string[],
		onChange: (value: Record<string, number>) => void,
		onCancel: () => void,
		requestRender?: () => void,
	) {
		super();
		this.#settings = settings;
		this.#providers = providers;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
		return [...new Set([...this.#providers, ...Object.keys(limits)])].sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();

		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
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
		this.#listField = new SelectFormField({
			theme: formTheme,
			label: "Max In-Flight Requests",
			description:
				"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: "  Enter to edit provider · Esc to go back",
			onSubmit: value => {
				if (value === "__clear_all") {
					this.#settings.set("providers.maxInFlightRequests", {});
					this.#onChange({});
					this.#showProviderList();
					this.#requestRender?.();
					return;
				}
				this.#showProviderEditor(value);
			},
			onCancel: this.#onCancel,
			requestRender: this.#requestRender,
		});
		this.addChild(this.#listField);
	}

	#showProviderEditor(provider: string): void {
		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#listField = undefined;
		this.addChild(
			new TextFormField({
				theme: formTheme,
				label: `Max In-Flight Requests: ${provider}`,
				description:
					"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				initialValue: limits[provider]?.toString() ?? undefined,
				empty: "submit",
				hint: "  Enter to save · Esc to cancel · Clear field to unset",
				validate: value => {
					if (value.trim() === "") return undefined;
					const limit = Number(value.trim());
					if (!Number.isFinite(limit) || limit <= 0) return "Limit must be a positive number.";
					return undefined;
				},
				onSubmit: value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = this.#settings.validateProviderLimits(next);
					this.#settings.set("providers.maxInFlightRequests", normalized);
					this.#onChange(normalized);
					this.#showProviderList();
					this.#requestRender?.();
				},
				onCancel: () => {
					this.#showProviderList();
					this.#requestRender?.();
				},
				requestRender: this.#requestRender,
			}),
		);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#listField?.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		if (this.#listField) {
			this.#listField.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/** Stable sidebar width derived from the tabs exposed by this selector. */
function settingsSidebarWidth(entries: readonly SettingsDisplayEntry[], tabs: readonly SettingTab[]): number {
	let nameWidth = 0;
	for (const tab of tabs) {
		for (const def of getSettingsForTab(entries, tab)) {
			if (def.group) nameWidth = Math.max(nameWidth, visibleWidth(def.group));
		}
	}
	return Math.min(22, nameWidth) + 4;
}

export type SettingsNavigationTab = SettingTab | "plugins" | "profiles";

export interface SettingsTabContent extends Component {
	/**
	 * `sidebarWidth` is the host's stable native settings-sidebar width, for
	 * embedded content that composes its own split pane.
	 */
	render(width: number, height?: number, sidebarWidth?: number): readonly string[];
}

function getSettingsTabs(
	availableTabs: readonly SettingTab[],
	includePlugins: boolean,
	includeProfiles: boolean,
): Tab[] {
	const tabs: Tab[] = availableTabs.map(id => {
		const meta = TAB_METADATA[id];
		const icon = theme.symbol(meta.icon);
		return { id, label: `${icon} ${meta.label}`, short: icon };
	});
	if (includePlugins) {
		tabs.push({ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package });
	}
	if (includeProfiles) {
		const icon = theme.symbol("tab.profiles");
		tabs.push({ id: "profiles", label: `${icon} Profiles`, short: icon });
	}
	return tabs;
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	settings: SettingsHost;
	/** Plugin host is optional for isolated/schema-only settings surfaces. */
	plugins?: PluginSettingsHost;
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Provider/source ids shown in /model. */
	providers: string[];
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
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}
/** A native section in an opt-in continuous settings surface. */
export interface SettingsSelectorSection {
	id: string;
	label: string;
	items: readonly (
		| SettingItem
		| {
				setting: string;
				disabled?: boolean;
				descriptionSuffix?: string;
		  }
	)[];
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: string, newValue: unknown) => void;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void | Promise<void>;
	/** Called when the embedded Profiles tab is entered. */
	onProfilesSelected?: () => void;
	/** Accept changes and return to an embedding surface. Omit on global Settings. */
	onDone?: () => void;
	/** Save an embedding surface. Invoked by Ctrl+S only from the composed main list. */
	onSave?: () => void;
	/** Called when the selected composed row changes. */
	onSelectionChange?: (id: string | undefined) => void;
	/** Called when settings panel is closed */
	onCancel: () => void;
}

export interface SettingsSelectorOptions {
	/** Schema tabs available on this surface, in display order. */
	availableTabs?: readonly SettingTab[];
	/** Initial tab. Defaults to the first available schema tab. */
	initialTab?: SettingsNavigationTab;
	/** Include the plugin settings tab when a plugin host is available. */
	includePlugins?: boolean;
	/** Frame title for embedded settings surfaces. */
	title?: string;
	/** Explicit terminal height for embedded/supervised surfaces. */
	terminalHeight?: number;
	/** Explanatory copy pinned above the editable content. */
	notice?: string;
	/** Content rendered directly inside the Profiles tab. Omit to hide the tab. */
	profiles?: SettingsTabContent;
	/**
	 * Render one continuous native settings list grouped under these sections.
	 * Supplying sections removes the local tab bar; schema references and raw
	 * action rows share the same searchable list.
	 */
	sections?: () => readonly SettingsSelectorSection[];
}

/**
 * Settings selector with the ordinary tabbed surface and an opt-in continuous,
 * sectioned surface. Both use the same native definition and field editors.
 */
export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#profilesContent: SettingsTabContent | undefined;
	#currentTabId: SettingsNavigationTab;
	#preSearchTabId: SettingsNavigationTab;
	#searchQuery = "";
	/** Single-line editor backing the search banner (cursor, word ops, paste). */
	#searchInput = new Input();
	#searchMatchCount = 0;
	/** First matching item id per tab id, for Tab-key jumps while searching. */
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	#hasSectionJump = false;
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;
	#contentColCount = 0;
	#doneActionRow = -1;
	#doneActionEnd = 0;
	#sidebarWidth: number;
	readonly #availableTabs: readonly SettingTab[];
	readonly #includePlugins: boolean;
	readonly #includeProfiles: boolean;
	readonly #title: string;
	readonly #terminalHeight: number | undefined;
	readonly #notice: string | undefined;
	readonly #context: SettingsRuntimeContext;
	readonly #callbacks: SettingsCallbacks;
	readonly #sections: (() => readonly SettingsSelectorSection[]) | undefined;
	readonly #composedMode: boolean;

	constructor(context: SettingsRuntimeContext, callbacks: SettingsCallbacks, options: SettingsSelectorOptions = {}) {
		this.#context = context;
		this.#callbacks = callbacks;
		this.#sections = options.sections;
		this.#composedMode = this.#sections !== undefined;
		const requestedTabs = options.availableTabs ?? SETTING_TABS;
		const availableTabs = SETTING_TABS.filter(tab => requestedTabs.includes(tab));
		if (availableTabs.length === 0 && !this.#composedMode) {
			throw new Error("Settings selector requires at least one settings tab");
		}
		// TabBar remains an internal implementation detail in composed mode;
		// keep one hidden tab so its ordinary-mode invariant stays intact.
		this.#availableTabs = availableTabs.length > 0 ? availableTabs : [SETTING_TABS[0]!];
		this.#includePlugins = !this.#composedMode && options.includePlugins !== false && context.plugins !== undefined;
		this.#includeProfiles = !this.#composedMode && options.profiles !== undefined;
		this.#profilesContent = options.profiles;
		this.#title = options.title ?? "Settings";
		this.#terminalHeight = options.terminalHeight;
		this.#notice = options.notice;
		const tabs = getSettingsTabs(this.#availableTabs, this.#includePlugins, this.#includeProfiles);
		const requestedInitialTab = options.initialTab;
		let initialTab: SettingsNavigationTab = this.#availableTabs[0]!;
		if (requestedInitialTab && tabs.some(tab => tab.id === requestedInitialTab)) {
			initialTab = requestedInitialTab;
		}
		this.#currentTabId = initialTab;
		this.#preSearchTabId = initialTab;
		if (this.#sections) {
			let nameWidth = 0;
			for (const section of this.#sections()) nameWidth = Math.max(nameWidth, visibleWidth(section.label));
			this.#sidebarWidth = Math.min(22, nameWidth) + 4;
		} else {
			this.#sidebarWidth = settingsSidebarWidth(context.settings.entries, this.#availableTabs);
		}
		// No label prefix (the frame title already names this surface) and no
		// "(tab to cycle)" hint (folded into the footer hint line).
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.setActiveById(initialTab);
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingsNavigationTab;
			if (this.#searchList) {
				// While searching, tabs act as jump targets into the result list.
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		if (this.#composedMode) {
			this.#showComposedSections();
		} else {
			this.#switchToTab(initialTab);
		}
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
		this.#profilesContent?.invalidate?.();
	}
	/** Replace the retained content rendered inside the Profiles tab. */
	setProfilesContent(content: SettingsTabContent): void {
		this.#profilesContent = content;
	}

	/** Select one of the tabs exposed by this Settings surface. */
	selectTab(tab: SettingsNavigationTab): void {
		if (this.#composedMode) return;
		if (!this.#tabBar.setActiveById(tab) || (tab === this.#currentTabId && !this.#searchList)) return;
		this.#switchToTab(tab);
	}

	/** Re-evaluate live conditions and replace the visible items without resetting list state. */
	refreshItems(): void {
		if (this.#composedMode) {
			this.#refreshComposedItems();
		} else if (this.#searchList) {
			this.#setSearchQuery(this.#searchQuery);
		} else if (this.#currentTabId !== "plugins" && this.#currentTabId !== "profiles") {
			this.#refreshCurrentTabItems(getSettingsForTab(this.#context.settings.entries, this.#currentTabId));
		}
	}

	/** Select a visible schema or action row by its stable id. */
	selectItem(id: string): boolean {
		return (this.#searchList ?? this.#currentList)?.selectItem(id) ?? false;
	}

	/** Clear either the composed list filter or the cross-tab search without closing the selector. */
	clearSearch(): void {
		if (this.#composedMode) {
			this.#currentList?.clearSearch();
		} else if (this.#searchList) {
			this.#endSearch(false);
		}
	}

	/** True while a native field editor owns input. */
	hasOpenSubmenu(): boolean {
		return (this.#searchList ?? this.#currentList)?.hasOpenSubmenu() ?? false;
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingsNavigationTab): void {
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else if (tabId === "profiles") {
				this.#hasSectionJump = false;
			} else {
				this.#showSettingsTab(tabId);
			}
		});
		if (tabId === "profiles") this.#callbacks.onProfilesSelected?.();
	}

	#footerHintText(width = Number.POSITIVE_INFINITY): string {
		if (this.#composedMode) {
			const save = this.#callbacks.onSave ? "Ctrl+S save · " : "";
			if (this.#currentList?.sectionFocused) {
				const detailed = `↑/↓ sections · Tab/Enter settings · ${save}Esc cancel`;
				if (visibleWidth(detailed) <= width) return detailed;
				return `Enter settings · ${save}Esc cancel`;
			}
			const detailed = `Enter/Space change · ${this.#hasSectionJump ? "Tab sections · " : ""}${save}Esc cancel`;
			if (visibleWidth(detailed) <= width) return detailed;
			return `Enter change · ${save}Esc cancel`;
		}
		if (this.#searchList) {
			return "Enter to change · Tab to jump tabs · Esc to exit search";
		}
		if (this.#currentTabId === "plugins") {
			return "Tab to switch tabs · Esc to close";
		}
		if (this.#currentTabId === "profiles") {
			return "←/→ to switch tabs";
		}
		if (this.#currentList?.sectionFocused) {
			const close = this.#callbacks.onDone ? "Esc discards draft" : "Esc to close";
			return `↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · ${close}`;
		}
		const nav = this.#hasSectionJump ? "Tab to jump sections · ←/→ to switch tabs" : "Tab to switch tabs";
		const close = this.#callbacks.onDone ? "Esc discards draft" : "Esc to close";
		return `Enter/Space to change · ${nav} · Type to search · ${close}`;
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
		const height = Math.max(14, this.#terminalHeight ?? process.stdout.rows ?? 40);
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#composedMode ? [] : this.#tabBar.render(innerWidth);
		const searching = this.#searchList !== null;
		const showPreview = !this.#composedMode && !searching && this.#currentTabId === "appearance";
		const previewLines = showPreview ? ["", theme.fg("muted", "Preview:"), this.#getStatusPreviewString()] : [];
		const noticeLines = this.#notice ? wrapTextWithAnsi(theme.fg("dim", this.#notice), innerWidth) : [];

		// Fixed chrome: top border, tabs, divider, [search row], notice, divider, hint, bottom border.
		const fixedRows = 1 + tabLines.length + 1 + (searching ? 1 : 0) + noticeLines.length + 1 + 1 + 1;
		const contentRows = Math.max(4, height - fixedRows - previewLines.length);

		const list = this.#searchList ?? this.#currentList;
		let contentLines: readonly string[];
		if (list) {
			// Composed lists retain their own search status row; tabbed lists
			// use the selector-owned search banner.
			list.setMaxVisible(contentRows - (this.#composedMode ? 5 : 4));
			contentLines = list.render(innerWidth);
		} else if (this.#pluginComponent) {
			contentLines = this.#pluginComponent.render(innerWidth);
		} else if (this.#currentTabId === "profiles" && this.#profilesContent) {
			contentLines = this.#profilesContent.render(innerWidth, contentRows, this.#sidebarWidth);
		} else {
			contentLines = [];
		}

		const out: string[] = [];
		out.push(topBorder(width, this.#title));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		if (searching) {
			out.push(row(this.#renderSearchBanner(innerWidth), width));
		}
		for (const line of noticeLines) {
			out.push(row(line, width));
		}
		this.#contentRowStart = out.length;
		this.#contentColCount = innerWidth;
		this.#contentRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) {
			out.push(row(contentLines[i] ?? "", width));
		}
		for (const line of previewLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		const doneAction = "[Ctrl+S Use group changes]";
		const showDoneAction = !this.#composedMode && this.#callbacks.onDone !== undefined;
		this.#doneActionRow = showDoneAction ? out.length : -1;
		this.#doneActionEnd = showDoneAction ? visibleWidth(doneAction) : 0;
		const footerHint = this.#footerHintText(this.#composedMode ? innerWidth : undefined);
		const footer = showDoneAction
			? `${theme.fg("accent", doneAction)}  ${theme.fg("dim", footerHint)}`
			: theme.fg("dim", footerHint);
		out.push(row(footer, width));
		out.push(bottomBorder(width));
		return out;
	}

	/**
	 * Route an SGR mouse report against the frame geometry of the last render.
	 * Tabs and settings lists keep their existing hit testing; the embedded
	 * Profiles pane receives every pointer report in child-local coordinates.
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const list = this.#searchList ?? this.#currentList;
		const profilesContent = this.#profilesContent;
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
		if (
			this.#callbacks.onDone &&
			event.leftClick &&
			event.row === this.#doneActionRow &&
			innerCol >= 0 &&
			innerCol < this.#doneActionEnd
		) {
			this.#callbacks.onDone();
			return true;
		}

		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;
		const overProfilesContent =
			overContent &&
			innerCol >= 0 &&
			innerCol < this.#contentColCount &&
			this.#currentTabId === "profiles" &&
			profilesContent !== undefined;

		if (event.wheel !== null) {
			if (overProfilesContent) {
				this.#routeProfilesMouse(profilesContent, event, contentLine, innerCol);
			} else if (overContent) {
				list?.handleWheelAt(event.wheel, contentLine, innerCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			if (overProfilesContent) {
				this.#routeProfilesMouse(profilesContent, event, contentLine, innerCol);
			} else {
				// hoverTest: never light up pane rows while the pointer is on the
				// sidebar — only rows the pointer is actually on.
				list?.setHoverItem(overContent ? (list.hoverTest(contentLine, innerCol) ?? null) : null);
			}
			return true;
		}

		if (overTabs && event.leftClick) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return true;
		}
		if (overProfilesContent) {
			this.#routeProfilesMouse(profilesContent, event, contentLine, innerCol);
			return true;
		}
		if (!event.leftClick) return true;
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

	#routeProfilesMouse(content: SettingsTabContent, event: SgrMouseEvent, contentLine: number, innerCol: number): void {
		if ("routeMouse" in content && typeof content.routeMouse === "function") {
			(content as SettingsTabContent & MouseRoutable).routeMouse(event, contentLine, innerCol);
		}
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
			(id, newValue) => this.#onSearchSettingChange(id, newValue),
			() => this.#callbacks.onCancel(),
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
		for (const tab of this.#availableTabs) {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(this.#context.settings.entries, tab)) {
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
				order: this.#availableTabs.indexOf(tab),
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon)} ${meta.label}`,
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
		const selectedDef = selected ? getSettingDef(this.#context.settings.entries, selected.id) : undefined;
		const targetTab: SettingsNavigationTab = selectedDef?.tab ?? this.#preSearchTabId;

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(
			getSettingsTabs(this.#availableTabs, this.#includePlugins, this.#includeProfiles),
			targetTab,
		);
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
			const icon = theme.symbol(meta.icon);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${meta.label} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of this.#availableTabs) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon);
			empty.push({ id, label: `${icon} ${meta.label}`, short: icon, muted: true });
		}
		// Plugins hosts its own UI; it is not part of the schema-backed search.
		if (this.#includePlugins) {
			empty.push({
				id: "plugins",
				label: `${theme.icon.package} Plugins`,
				short: theme.icon.package,
				muted: true,
			});
		}
		if (this.#includeProfiles) {
			const icon = theme.symbol("tab.profiles");
			empty.push({ id: "profiles", label: `${icon} Profiles`, short: icon, muted: true });
		}
		return [...matched, ...empty];
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(this.#context.settings.entries, item.id);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	/** Value-change dispatch for the search result list (any tab's setting). */
	#onSearchSettingChange(path: string, newValue: string): void {
		const def = getSettingDef(this.#context.settings.entries, path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			this.#context.settings.set(path, boolValue);
			this.#callbacks.onChange(path, boolValue);
		} else if (def.type === "enum") {
			this.#context.settings.set(path, newValue);
			this.#callbacks.onChange(path, newValue);
		}
		// Submenu/text types already persisted inside their own done callbacks.
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
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
		if (def.condition && !def.condition()) {
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
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return this.#context.settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		const defaultValue: unknown = def.defaultValue;
		if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
			return (
				currentValue.length !== defaultValue.length ||
				currentValue.some((entry, index) => entry !== defaultValue[index])
			);
		}
		return !Object.is(currentValue, defaultValue);
	}

	#getSubmenuCurrentValue(path: string, value: unknown): string {
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
	): Component {
		let options = def.options;

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			// Prepend `auto`; the rest are the model's runtime-supported efforts.
			const levels: ConfiguredThinkingLevel[] = [AUTO_THINKING, ...this.#context.availableThinkingLevels];
			options = levels.map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.#context.availableThemes.map(t => ({ value: t, label: t }));
		} else if (def.path === "composer.shape") {
			options = getComposerShapeOptions();
		}
		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		let footer: Component | undefined;

		const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => {
				return this.#callbacks.onThemePreview?.(value);
			};
			onPreviewCancel = () => {
				this.#callbacks.onThemePreview?.(activeThemeBeforePreview);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.#callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = this.#context.settings.get("statusLine.preset") as StatusLinePreset;
				const presetDef = getPreset(currentPreset);
				this.#callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.#callbacks.onStatusLinePreview?.({ separator: value as StatusLineSeparatorStyle });
			};
			onPreviewCancel = () => {
				const separator = this.#context.settings.get("statusLine.separator") as StatusLineSeparatorStyle;
				this.#callbacks.onStatusLinePreview?.({ separator });
			};
		} else if (def.path === "statusLine.contextLine") {
			onPreview = value => {
				this.#callbacks.onStatusLinePreview?.({ contextLine: value as ContextLineMode });
			};
			onPreviewCancel = () => {
				this.#callbacks.onStatusLinePreview?.({
					contextLine: this.#context.settings.get("statusLine.contextLine") as ContextLineMode,
				});
			};
		} else if (def.path === "snapcompact.shape") {
			const shapePreview = new SnapcompactShapePreview(currentValue, {
				model: this.#context.model,
				imageBudget: this.#context.imageBudget,
				requestRender: this.#context.requestRender,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		} else if (def.path === "composer.shape") {
			const shapePreview = new ComposerShapePreview(String(currentValue ?? "band"), {
				requestRender: this.#context.requestRender,
				status: this.#context.composerPreviewStatus,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		}
		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.#callbacks.getStatusLinePreview : undefined;

		return createSettingsSelectField(
			def.label,
			def.description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.#callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
			this.#context.requestRender,
		);
	}

	/**
	 * Create a text input submenu for a plain string setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Component {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return createSettingsTextField(
			def.label,
			def.description,
			this.#formatTextInputEditValue(def.path, this.#context.settings.get(def.path)),
			def.secret,
			value => {
				// An empty field removes the persisted value, so the default (or an
				// environment fallback) applies again instead of a pinned "".
				if (value === "") this.#context.settings.unset(def.path);
				else this.#setSettingValue(def.path, value);
				this.#callbacks.onChange(def.path, this.#context.settings.get(def.path));
				wrappedDone(this.#formatTextInputValue(def, this.#context.settings.get(def.path)));
			},
			() => wrappedDone(),
			this.#context.requestRender,
		);
	}

	#createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.#context.settings,
			this.#context.providers,
			value => {
				this.#callbacks.onChange("providers.maxInFlightRequests", value);
				done(this.#formatProviderLimitsValue(value));
			},
			() => done(),
			this.#context.requestRender,
		);
	}

	#formatProviderLimitsValue(value: unknown): string {
		const limits = this.#context.settings.normalizeProviderLimits(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return "Unlimited";
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	#getMultiSelectOptions(def: SettingDef & { type: "multiselect" }) {
		if (def.path !== "providers.webSearchOrder") return def.options;
		const excluded: unknown = this.#context.settings.get("providers.webSearchExclude");
		if (!Array.isArray(excluded)) return def.options;
		return def.options.filter(option => !excluded.includes(option.value));
	}

	#createMultiSelect(def: SettingDef & { type: "multiselect" }, done: (value?: string) => void): Container {
		const options = this.#getMultiSelectOptions(def);
		const current: unknown = this.#context.settings.get(def.path);
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
				this.#context.settings.set(def.path, value);
				this.#callbacks.onChange(def.path, value);
			},
			() => done(this.#formatMultiSelectValue(def, this.#context.settings.get(def.path))),
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

	#formatTextInputEditValue(_path: string, value: unknown): string {
		if (value === undefined || value === null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: string, value: string): void {
		const currentValue = this.#context.settings.get(path);
		const schemaType = getSettingDef(this.#context.settings.entries, path)?.schemaType;
		if (path === "compaction.thresholdPercent" && value === "default") {
			this.#context.settings.set(path, -1);
		} else if (path === "compaction.thresholdTokens" && value === "default") {
			this.#context.settings.set(path, -1);
		} else if (schemaType === "record") {
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
				parsed = this.#context.settings.validateProviderLimits(parsed);
			}
			this.#context.settings.set(path, parsed);
		} else if (typeof currentValue === "number") {
			this.#context.settings.set(path, Number(value));
		} else if (typeof currentValue === "boolean") {
			this.#context.settings.set(path, value === "true");
		} else {
			this.#context.settings.set(path, value);
		}
	}

	/** Build condition-filtered schema fields and raw action rows for the continuous surface. */
	#buildComposedItems(): SettingItem[] {
		const items: SettingItem[] = [];
		for (const section of this.#sections?.() ?? []) {
			const sectionItems: SettingItem[] = [];
			for (const entry of section.items) {
				if ("setting" in entry) {
					const def = getSettingDef(this.#context.settings.entries, entry.setting);
					if (!def) {
						// A valid host entry may intentionally be config-file-only
						// (for example a number without declared choices). Match
						// ordinary Settings by omitting it from the native surface.
						if (this.#context.settings.entries.some(candidate => candidate.path === entry.setting)) continue;
						throw new Error(`Unknown setting: ${entry.setting}`);
					}
					const item = this.#defToItem(def);
					if (!item) continue;
					const suffix = entry.descriptionSuffix?.trim();
					sectionItems.push({
						...item,
						description: suffix
							? item.description
								? `${item.description}\n${suffix}`
								: suffix
							: item.description,
						disabled: item.disabled === true || entry.disabled === true,
					});
				} else {
					sectionItems.push({ ...entry });
				}
			}
			if (sectionItems.length === 0) continue;
			items.push({
				id: `__section:${section.id}`,
				label: section.label,
				currentValue: "",
				heading: true,
			});
			items.push(...sectionItems);
		}
		return items;
	}

	#showComposedSections(): void {
		const items = this.#buildComposedItems();
		this.#hasSectionJump = items.filter(item => item.heading).length >= 2;
		this.#setContent(() => {
			const list = new SettingsList(
				items,
				10,
				getSettingsListTheme(),
				(id, newValue) => this.#onComposedSettingChange(id, newValue),
				() => this.#callbacks.onCancel(),
				{ hint: "", sidebarWidth: this.#sidebarWidth },
			);
			list.onSelectionChange = item => this.#callbacks.onSelectionChange?.(item?.id);
			this.#currentList = list;
		});
	}

	#refreshComposedItems(): void {
		if (!this.#currentList) return;
		const items = this.#buildComposedItems();
		this.#hasSectionJump = items.filter(item => item.heading).length >= 2;
		this.#currentList.setItems(items);
	}

	#onComposedSettingChange(path: string, newValue: string): void {
		const def = getSettingDef(this.#context.settings.entries, path);
		if (def?.type === "boolean") {
			const boolValue = newValue === "true";
			this.#context.settings.set(path, boolValue);
			this.#callbacks.onChange(path, boolValue);
		} else if (def?.type === "enum") {
			this.#context.settings.set(path, newValue);
			this.#callbacks.onChange(path, newValue);
		} else if (!def) {
			this.#callbacks.onChange(path, newValue);
		}
		if (def?.tab === "appearance") this.#triggerStatusLinePreview();
		this.#refreshComposedItems();
	}

	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(this.#context.settings.entries, tabId);

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
					this.#context.settings.set(path, boolValue);
					this.#callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					this.#context.settings.set(path, newValue);
					this.#callbacks.onChange(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Re-run the
				// definition-to-item mapping so condition-gated settings (e.g. the
				// Hindsight cluster guarded by memory.backend) appear/disappear
				// immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#callbacks.onCancel(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", sidebarWidth: this.#sidebarWidth },
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
		if (this.#currentTabId === "plugins" || this.#currentTabId === "profiles" || !this.#currentList) {
			return;
		}
		this.#currentList.setItems(this.#buildItemsForDefs(defs));
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.#callbacks.getStatusLinePreview) {
			return this.#callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: this.#context.settings.get("statusLine.preset") as StatusLinePreset,
			leftSegments: this.#context.settings.get("statusLine.leftSegments") as StatusLineSegmentId[],
			rightSegments: this.#context.settings.get("statusLine.rightSegments") as StatusLineSegmentId[],
			separator: this.#context.settings.get("statusLine.separator") as StatusLineSeparatorStyle,
			sessionAccent: this.#context.settings.get("statusLine.sessionAccent") as boolean,
			transparent: this.#context.settings.get("statusLine.transparent") as boolean,
		};
		this.#callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		const plugins = this.#context.plugins;
		if (!plugins) return;
		this.#pluginComponent = new PluginSettingsComponent(plugins, {
			onClose: () => this.#callbacks.onCancel(),
			onPluginChanged: () => this.#callbacks.onPluginsChanged?.(),
			requestRender: this.#context.requestRender,
		});
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
		if (this.#composedMode) {
			if (this.#callbacks.onSave && matchesKey(data, "ctrl+s")) {
				this.#callbacks.onSave();
				return;
			}
			if (
				(matchesKey(data, "tab") || matchesKey(data, "shift+tab")) &&
				this.#currentList?.hasSectionFocusTargets()
			) {
				this.#currentList.toggleSectionFocus();
				return;
			}
			this.#currentList?.handleInput(data);
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}
		if (this.#currentTabId === "profiles") {
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				this.#tabBar.handleInput(data);
			} else if (this.#profilesContent?.handleInput) {
				this.#profilesContent.handleInput(data);
			} else if (getKeybindings().matches(data, "tui.select.cancel")) {
				this.#callbacks.onCancel();
			}
			return;
		}
		if (this.#callbacks.onDone && matchesKey(data, "ctrl+s")) {
			this.#callbacks.onDone();
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

		// Printable characters start a search across every schema-backed
		// settings tab. Virtual action/plugin tabs do not enter global search.
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
