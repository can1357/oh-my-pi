import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	getCapabilities,
	isArrowLeft,
	isArrowRight,
	isEscape,
	isShiftTab,
	isTab,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	type Tab,
	TabBar,
	type TabBarTheme,
	Text,
} from "@oh-my-pi/pi-tui";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { PluginSettingsComponent } from "./plugin-settings.js";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

export interface ExaToolsConfig {
	enabled: boolean;
	enableSearch: boolean;
	enableLinkedin: boolean;
	enableCompany: boolean;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	queueMode: "all" | "one-at-a-time";
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	cwd: string;
	exa: ExaToolsConfig;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onQueueModeChange: (mode: "all" | "one-at-a-time") => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onPluginsChanged?: () => void;
	onExaSettingChange: (setting: keyof ExaToolsConfig, enabled: boolean) => void;
	onCancel: () => void;
}

function getTabBarTheme(): TabBarTheme {
	return {
		label: (text) => theme.bold(theme.fg("accent", text)),
		activeTab: (text) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text) => theme.fg("muted", text),
		hint: (text) => theme.fg("dim", text),
	};
}

/**
 * A submenu component for selecting from a list of options.
 */
class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

type TabId = "config" | "exa" | "plugins";

const SETTINGS_TABS: Tab[] = [
	{ id: "config", label: "Config" },
	{ id: "exa", label: "Exa" },
	{ id: "plugins", label: "Plugins" },
];

/**
 * Main tabbed settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private tabBar: TabBar;
	private currentList: SettingsList | null = null;
	private currentSubmenu: Container | null = null;
	private pluginComponent: PluginSettingsComponent | null = null;

	private config: SettingsConfig;
	private callbacks: SettingsCallbacks;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		this.config = config;
		this.callbacks = callbacks;

		// Add top border
		this.addChild(new DynamicBorder());

		// Tab bar
		this.tabBar = new TabBar("Settings", SETTINGS_TABS, getTabBarTheme());
		this.tabBar.onTabChange = () => {
			this.switchToTab(this.tabBar.getActiveTab().id as TabId);
		};
		this.addChild(this.tabBar);

		// Spacer after tab bar
		this.addChild(new Spacer(1));

		// Initialize with first tab
		this.switchToTab("config");

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	private switchToTab(tabId: TabId): void {
		// Remove current content
		if (this.currentList) {
			this.removeChild(this.currentList);
			this.currentList = null;
		}
		if (this.pluginComponent) {
			this.removeChild(this.pluginComponent);
			this.pluginComponent = null;
		}

		// Remove bottom border temporarily
		const bottomBorder = this.children[this.children.length - 1];
		this.removeChild(bottomBorder);

		switch (tabId) {
			case "config":
				this.showConfigTab();
				break;
			case "exa":
				this.showExaTab();
				break;
			case "plugins":
				this.showPluginsTab();
				break;
		}

		// Re-add bottom border
		this.addChild(bottomBorder);
	}

	private showConfigTab(): void {
		const supportsImages = getCapabilities().images;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: this.config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "queue-mode",
				label: "Queue mode",
				description: "How to process queued messages while agent is working",
				currentValue: this.config.queueMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: this.config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: this.config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: this.config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						this.config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							this.callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: this.config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Theme",
						"Select color theme",
						this.config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							this.callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							this.callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							this.callbacks.onThemePreview?.(value);
						},
					),
			},
		];

		// Add image toggle if supported
		if (supportsImages) {
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: this.config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
		}

		this.currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						this.callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						this.callbacks.onShowImagesChange(newValue === "true");
						break;
					case "queue-mode":
						this.callbacks.onQueueModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "hide-thinking":
						this.callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "collapse-changelog":
						this.callbacks.onCollapseChangelogChange(newValue === "true");
						break;
				}
			},
			() => this.callbacks.onCancel(),
		);

		this.addChild(this.currentList);
	}

	private showExaTab(): void {
		const items: SettingItem[] = [
			{
				id: "exa-enabled",
				label: "Exa enabled",
				description: "Master toggle for all Exa search tools",
				currentValue: this.config.exa.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "exa-search",
				label: "Exa search",
				description: "Basic search, deep search, code search, crawl",
				currentValue: this.config.exa.enableSearch ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "exa-linkedin",
				label: "Exa LinkedIn",
				description: "Search LinkedIn for people and companies",
				currentValue: this.config.exa.enableLinkedin ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "exa-company",
				label: "Exa company",
				description: "Comprehensive company research tool",
				currentValue: this.config.exa.enableCompany ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "exa-researcher",
				label: "Exa researcher",
				description: "AI-powered deep research tasks",
				currentValue: this.config.exa.enableResearcher ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "exa-websets",
				label: "Exa websets",
				description: "Webset management and enrichment tools",
				currentValue: this.config.exa.enableWebsets ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const enabled = newValue === "true";
				switch (id) {
					case "exa-enabled":
						this.callbacks.onExaSettingChange("enabled", enabled);
						break;
					case "exa-search":
						this.callbacks.onExaSettingChange("enableSearch", enabled);
						break;
					case "exa-linkedin":
						this.callbacks.onExaSettingChange("enableLinkedin", enabled);
						break;
					case "exa-company":
						this.callbacks.onExaSettingChange("enableCompany", enabled);
						break;
					case "exa-researcher":
						this.callbacks.onExaSettingChange("enableResearcher", enabled);
						break;
					case "exa-websets":
						this.callbacks.onExaSettingChange("enableWebsets", enabled);
						break;
				}
			},
			() => this.callbacks.onCancel(),
		);

		this.addChild(this.currentList);
	}

	private showPluginsTab(): void {
		this.pluginComponent = new PluginSettingsComponent(this.config.cwd, {
			onClose: () => this.callbacks.onCancel(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
		});
		this.addChild(this.pluginComponent);
	}

	getFocusComponent(): SettingsList | PluginSettingsComponent {
		// Return the current focusable component - one of these will always be set
		return (this.currentList || this.pluginComponent)!;
	}

	handleInput(data: string): void {
		// Handle tab switching first (tab, shift+tab, or left/right arrows)
		if (isTab(data) || isShiftTab(data) || isArrowLeft(data) || isArrowRight(data)) {
			this.tabBar.handleInput(data);
			return;
		}

		// Escape at top level cancels
		if (isEscape(data) && !this.currentSubmenu) {
			this.callbacks.onCancel();
			return;
		}

		// Pass to current content
		if (this.currentList) {
			this.currentList.handleInput(data);
		} else if (this.pluginComponent) {
			this.pluginComponent.handleInput(data);
		}
	}
}
