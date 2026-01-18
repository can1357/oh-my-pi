import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	matchesKey,
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
import type { SettingsManager, StatusLineSettings } from "../../../core/settings-manager";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { PluginSettingsComponent } from "./plugin-settings";
import { getSettingsForTab, type SettingDef } from "./settings-defs";
import { getPreset } from "./status-line/presets";
import { StatusLineSegmentEditorComponent } from "./status-line-segment-editor";

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
	private previewText: Text | null = null;
	private getPreview: (() => string) | undefined;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		getPreview?: () => string,
	) {
		super();
		this.getPreview = getPreview;

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
			this.previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.previewText);
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
				// Update preview after the preview callback has applied changes
				this.updatePreview();
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	private updatePreview(): void {
		if (this.previewText && this.getPreview) {
			this.previewText.setText(this.getPreview());
		}
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

type TabId = string;

const SETTINGS_TABS: Tab[] = [
	{ id: "behavior", label: "Behavior" },
	{ id: "tools", label: "Tools" },
	{ id: "display", label: "Display" },
	{ id: "voice", label: "Voice" },
	{ id: "status", label: "Status" },
	{ id: "lsp", label: "LSP" },
	{ id: "exa", label: "Exa" },
	{ id: "plugins", label: "Plugins" },
];

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not SettingsManager.
 */
export interface SettingsRuntimeContext {
	/** Available thinking levels (from session) */
	availableThinkingLevels: ThinkingLevel[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel;
	/** Available themes */
	availableThemes: string[];
	/** Working directory for plugins tab */
	cwd: string;
}

/**
 * Callback when any setting changes.
 * The handler should dispatch based on settingId.
 */
export type SettingChangeHandler = (settingId: string, newValue: string | boolean) => void;

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: SettingChangeHandler;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string) => void;
	/** Called for status line preview while configuring - updates actual status line */
	onStatusLinePreview?: (settings: Partial<StatusLineSettings>) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void;
	/** Called when settings panel is closed */
	onCancel: () => void;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent extends Container {
	private tabBar: TabBar;
	private currentList: SettingsList | null = null;
	private currentSubmenu: Container | null = null;
	private pluginComponent: PluginSettingsComponent | null = null;
	private statusPreviewContainer: Container | null = null;
	private statusPreviewText: Text | null = null;
	private currentTabId: TabId = "behavior";

	private settingsManager: SettingsManager;
	private context: SettingsRuntimeContext;
	private callbacks: SettingsCallbacks;

	constructor(settingsManager: SettingsManager, context: SettingsRuntimeContext, callbacks: SettingsCallbacks) {
		super();

		this.settingsManager = settingsManager;
		this.context = context;
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
		this.switchToTab("behavior");

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	private switchToTab(tabId: TabId): void {
		this.currentTabId = tabId;

		// Remove current content
		if (this.currentList) {
			this.removeChild(this.currentList);
			this.currentList = null;
		}
		if (this.pluginComponent) {
			this.removeChild(this.pluginComponent);
			this.pluginComponent = null;
		}
		if (this.statusPreviewContainer) {
			this.removeChild(this.statusPreviewContainer);
			this.statusPreviewContainer = null;
			this.statusPreviewText = null;
		}

		// Remove bottom border temporarily
		const bottomBorder = this.children[this.children.length - 1];
		this.removeChild(bottomBorder);

		if (tabId === "plugins") {
			this.showPluginsTab();
		} else {
			this.showSettingsTab(tabId);
		}

		// Re-add bottom border
		this.addChild(bottomBorder);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	private defToItem(def: SettingDef): SettingItem | null {
		// Check condition
		if (def.type === "boolean" && def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.getCurrentValue(def);

		switch (def.type) {
			case "boolean":
				return {
					id: def.id,
					label: def.label,
					description: def.description,
					currentValue: currentValue ? "true" : "false",
					values: ["true", "false"],
				};

			case "enum":
				return {
					id: def.id,
					label: def.label,
					description: def.description,
					currentValue: currentValue as string,
					values: [...def.values],
				};

			case "submenu":
				return {
					id: def.id,
					label: def.label,
					description: def.description,
					currentValue: currentValue as string,
					submenu: (cv, done) => this.createSubmenu(def, cv, done),
				};
		}
	}

	/**
	 * Get the current value for a setting, using runtime context for special cases.
	 */
	private getCurrentValue(def: SettingDef): string | boolean {
		// Special cases that come from runtime context instead of SettingsManager
		switch (def.id) {
			case "thinkingLevel":
				return this.context.thinkingLevel;
			default:
				return def.get(this.settingsManager);
		}
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	private createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		// Special case: segment editor
		if (def.id === "statusLineSegments") {
			return this.createSegmentEditor(done);
		}

		let options = def.getOptions(this.settingsManager);

		// Special case: inject runtime options
		if (def.id === "thinkingLevel") {
			options = this.context.availableThinkingLevels.map((level) => {
				const baseOpt = def.getOptions(this.settingsManager).find((o) => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.id === "theme") {
			options = this.context.availableThemes.map((t) => ({ value: t, label: t }));
		}

		// Preview handlers
		let onPreview: ((value: string) => void) | undefined;
		let onPreviewCancel: (() => void) | undefined;

		if (def.id === "theme") {
			onPreview = this.callbacks.onThemePreview;
			onPreviewCancel = () => this.callbacks.onThemePreview?.(currentValue);
		} else if (def.id === "statusLinePreset") {
			onPreview = (value) => {
				const presetDef = getPreset((value as StatusLineSettings["preset"]) ?? "default");
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLineSettings["preset"],
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
				this.updateStatusPreview();
			};
			onPreviewCancel = () => {
				const currentPreset = this.settingsManager.getStatusLinePreset();
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
				this.updateStatusPreview();
			};
		} else if (def.id === "statusLineSeparator") {
			onPreview = (value) => {
				this.callbacks.onStatusLinePreview?.({
					separator: value as StatusLineSettings["separator"],
				});
				this.updateStatusPreview();
			};
			onPreviewCancel = () => {
				const currentSettings = this.settingsManager.getStatusLineSettings();
				const separator =
					currentSettings.separator ?? getPreset(this.settingsManager.getStatusLinePreset()).separator;
				this.callbacks.onStatusLinePreview?.({
					separator,
				});
				this.updateStatusPreview();
			};
		}

		// Provide status line preview for theme selection
		const getPreview = def.id === "theme" ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			def.description,
			options,
			currentValue,
			(value) => {
				// Persist to SettingsManager
				def.set(this.settingsManager, value);
				// Notify for side effects
				this.callbacks.onChange(def.id, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
		);
	}

	/**
	 * Create the segment editor component.
	 */
	private createSegmentEditor(done: (value?: string) => void): Container {
		const currentSettings = this.settingsManager.getStatusLineSettings();
		const preset = currentSettings.preset ?? "default";
		const presetDef = getPreset(preset);

		const leftSegments = currentSettings.leftSegments ?? presetDef.leftSegments;
		const rightSegments = currentSettings.rightSegments ?? presetDef.rightSegments;

		return new StatusLineSegmentEditorComponent(leftSegments, rightSegments, {
			onSave: (left, right) => {
				this.settingsManager.setStatusLineLeftSegments(left);
				this.settingsManager.setStatusLineRightSegments(right);
				this.callbacks.onChange("statusLineSegments", "saved");
				this.callbacks.onStatusLinePreview?.({ leftSegments: left, rightSegments: right });
				this.updateStatusPreview();
				done("saved");
			},
			onCancel: () => {
				// Restore preview to saved state
				const saved = this.settingsManager.getStatusLineSettings();
				const savedPreset = getPreset(saved.preset ?? "default");
				this.callbacks.onStatusLinePreview?.({
					leftSegments: saved.leftSegments ?? savedPreset.leftSegments,
					rightSegments: saved.rightSegments ?? savedPreset.rightSegments,
				});
				this.updateStatusPreview();
				done();
			},
			onPreview: (left, right) => {
				this.callbacks.onStatusLinePreview?.({ leftSegments: left, rightSegments: right });
				this.updateStatusPreview();
			},
		});
	}

	/**
	 * Show a settings tab using definitions.
	 */
	private showSettingsTab(tabId: string): void {
		const defs = getSettingsForTab(tabId);
		const items: SettingItem[] = [];

		for (const def of defs) {
			const item = this.defToItem(def);
			if (item) {
				items.push(item);
			}
		}

		// Add status line preview for status tab
		if (tabId === "status") {
			this.statusPreviewContainer = new Container();
			this.statusPreviewContainer.addChild(new Spacer(1));
			this.statusPreviewContainer.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			this.statusPreviewText = new Text(this.getStatusPreviewString(), 0, 0);
			this.statusPreviewContainer.addChild(this.statusPreviewText);
			this.statusPreviewContainer.addChild(new Spacer(1));
			this.addChild(this.statusPreviewContainer);
		}

		this.currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defs.find((d) => d.id === id);
				if (!def) return;

				// Persist to SettingsManager based on type
				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					def.set(this.settingsManager, boolValue);
					this.callbacks.onChange(id, boolValue);

					// Trigger status line preview for status tab boolean settings
					if (tabId === "status") {
						this.triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					def.set(this.settingsManager, newValue);
					this.callbacks.onChange(id, newValue);
				}
				// Submenu types are handled in createSubmenu
			},
			() => this.callbacks.onCancel(),
		);

		this.addChild(this.currentList);
	}

	/**
	 * Get the status line preview string.
	 */
	private getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	private triggerStatusLinePreview(): void {
		const settings = this.settingsManager.getStatusLineSettings();
		this.callbacks.onStatusLinePreview?.(settings);
		// Update inline preview
		this.updateStatusPreview();
	}

	/**
	 * Update the inline status preview text.
	 */
	private updateStatusPreview(): void {
		if (this.statusPreviewText && this.currentTabId === "status") {
			this.statusPreviewText.setText(this.getStatusPreviewString());
		}
	}

	private showPluginsTab(): void {
		this.pluginComponent = new PluginSettingsComponent(this.context.cwd, {
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
		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "left") ||
			matchesKey(data, "right")
		) {
			this.tabBar.handleInput(data);
			return;
		}

		// Escape at top level cancels
		if ((matchesKey(data, "escape") || matchesKey(data, "esc")) && !this.currentSubmenu) {
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
