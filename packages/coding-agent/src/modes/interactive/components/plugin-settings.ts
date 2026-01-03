/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (shows all installed plugins)
 *   - Plugin detail (enable/disable, features, config)
 *     - Feature toggles
 *     - Config value editor
 */

import {
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@oh-my-pi/pi-tui";
import { PluginManager } from "../../../core/plugins/manager";
import type { InstalledPlugin, PluginSettingSchema } from "../../../core/plugins/types";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

// =============================================================================
// Plugin List Component
// =============================================================================

export interface PluginListCallbacks {
	onPluginSelect: (plugin: InstalledPlugin) => void;
	onCancel: () => void;
}

/**
 * Shows list of installed plugins with enable/disable status.
 * Selecting a plugin opens its detail view.
 */
export class PluginListComponent extends Container {
	private selectList: SelectList;
	private plugins: InstalledPlugin[];

	constructor(plugins: InstalledPlugin[], callbacks: PluginListCallbacks) {
		super();
		this.plugins = plugins;

		// Title
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "  Plugins")), 0, 0));
		this.addChild(new Spacer(1));

		if (plugins.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Install with: omp plugin install <package>"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());

			// Create empty list that just handles escape
			this.selectList = new SelectList([], 1, getSelectListTheme());
			this.selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = plugins.map((p) => {
			const status = p.enabled ? theme.fg("success", "●") : theme.fg("muted", "○");
			const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
			const enabledCount = p.enabledFeatures?.length ?? featureCount;

			let details = `v${p.version}`;
			if (featureCount > 0) {
				details += ` · ${enabledCount}/${featureCount} features`;
			}

			return {
				value: p.name,
				label: `${status} ${p.name}`,
				description: details,
			};
		});

		this.selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		this.selectList.onSelect = (item) => {
			const plugin = this.plugins.find((p) => p.name === item.value);
			if (plugin) {
				callbacks.onPluginSelect(plugin);
			}
		};

		this.selectList.onCancel = callbacks.onCancel;

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to configure · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends Container {
	private settingsList!: SettingsList;
	private plugin: InstalledPlugin;
	private manager: PluginManager;
	private callbacks: PluginDetailCallbacks;

	constructor(plugin: InstalledPlugin, manager: PluginManager, callbacks: PluginDetailCallbacks) {
		super();
		this.plugin = plugin;
		this.manager = manager;
		this.callbacks = callbacks;

		this.rebuild();
	}

	private rebuild(): void {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${plugin.name}`)), 0, 0));
		if (manifest.description) {
			this.addChild(new Text(theme.fg("muted", `  ${manifest.description}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [];

		// Enable/disable toggle
		items.push({
			id: "__enabled__",
			label: "Enabled",
			description: "Enable or disable this plugin",
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		// Feature toggles
		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_, f]) => f.default)
				.map(([name]) => name);

			// If enabledFeatures is null, use defaults
			const effectiveEnabled = plugin.enabledFeatures === null ? new Set(defaultFeatures) : enabledSet;

			for (const [featName, feat] of Object.entries(manifest.features)) {
				const isEnabled = effectiveEnabled.has(featName);
				items.push({
					id: `feature:${featName}`,
					label: `  ${featName}`,
					description: feat.description || `Enable ${featName} feature`,
					currentValue: isEnabled ? "true" : "false",
					values: ["true", "false"],
				});
			}
		}

		// Config settings
		if (manifest.settings && Object.keys(manifest.settings).length > 0) {
			const settings = this.manager.getPluginSettings(plugin.name);

			for (const [key, schema] of Object.entries(manifest.settings)) {
				const currentValue = settings[key] ?? schema.default;
				const displayValue = schema.secret && currentValue ? "••••••••" : String(currentValue ?? "(not set)");

				if (schema.type === "boolean") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: currentValue ? "true" : "false",
						values: ["true", "false"],
					});
				} else if (schema.type === "enum") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: String(currentValue ?? schema.default ?? ""),
						submenu: (cv, done) =>
							new ConfigEnumSubmenu(
								key,
								schema.description || `Select value for ${key}`,
								schema.values,
								cv,
								(value) => {
									this.callbacks.onConfigChange(key, value);
									done(value);
								},
								() => done(),
							),
					});
				} else {
					// string or number - show as submenu with input
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: displayValue,
						submenu: (cv, done) =>
							new ConfigInputSubmenu(
								key,
								schema,
								cv === "(not set)" ? "" : cv,
								(value) => {
									const parsed = schema.type === "number" ? Number(value) : value;
									this.callbacks.onConfigChange(key, parsed);
									done(String(value));
								},
								() => done(),
							),
					});
				}
			}
		}

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					this.callbacks.onEnabledChange(newValue === "true");
					this.plugin = { ...this.plugin, enabled: newValue === "true" };
				} else if (id.startsWith("feature:")) {
					const featName = id.slice(8);
					this.callbacks.onFeatureChange(featName, newValue === "true");
					// Update local state
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: [...current] };
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					const schema = this.plugin.manifest.settings?.[key];
					if (schema?.type === "boolean") {
						this.callbacks.onConfigChange(key, newValue === "true");
					}
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Submenu for enum config values.
 */
class ConfigEnumSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		key: string,
		description: string,
		values: string[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SelectItem[] = values.map((v) => ({ value: v, label: v }));
		this.selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		const currentIndex = values.indexOf(currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

/**
 * Submenu for string/number config values with text input.
 */
class ConfigInputSubmenu extends Container {
	private input: Input;
	private onSubmit: (value: string) => void;
	private onCancel: () => void;

	constructor(
		key: string,
		schema: PluginSettingSchema,
		currentValue: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (schema.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", schema.description), 0, 0));
		}

		// Type hint
		let hint = `Type: ${schema.type}`;
		if (schema.type === "number") {
			const numSchema = schema as { min?: number; max?: number };
			if (numSchema.min !== undefined || numSchema.max !== undefined) {
				hint += ` (${numSchema.min ?? ""}..${numSchema.max ?? ""})`;
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));

		this.addChild(new Spacer(1));

		// Input field
		this.input = new Input();
		if (!schema.secret && currentValue) {
			this.input.setValue(currentValue);
		}

		this.input.onSubmit = (value) => {
			if (value.trim()) {
				this.onSubmit(value);
			} else {
				this.onCancel();
			}
		};

		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "\x1b\x1b") {
			this.onCancel();
			return;
		}
		this.input.handleInput(data);
	}
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void;
}

/** Component with handleInput method */
interface InputHandler {
	handleInput(data: string): void;
}

/**
 * Top-level plugin settings component.
 * Manages navigation between plugin list and plugin detail views.
 */
export class PluginSettingsComponent extends Container {
	private manager: PluginManager;
	private callbacks: PluginSettingsCallbacks;
	private viewComponent: (Container & InputHandler) | null = null;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	private currentView: "list" | "detail" = "list";
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	private currentPlugin: InstalledPlugin | null = null;

	constructor(cwd: string, callbacks: PluginSettingsCallbacks) {
		super();
		this.manager = new PluginManager(cwd);
		this.callbacks = callbacks;
		this.showPluginList();
	}

	private async showPluginList(): Promise<void> {
		this.currentView = "list";
		this.currentPlugin = null;
		this.clear();

		const plugins = await this.manager.list();

		this.viewComponent = new PluginListComponent(plugins, {
			onPluginSelect: (plugin) => this.showPluginDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.viewComponent);
	}

	private showPluginDetail(plugin: InstalledPlugin): void {
		this.currentView = "detail";
		this.currentPlugin = plugin;
		this.clear();

		this.viewComponent = new PluginDetailComponent(plugin, this.manager, {
			onEnabledChange: async (enabled) => {
				await this.manager.setEnabled(plugin.name, enabled);
				this.callbacks.onPluginChanged();
			},
			onFeatureChange: async (feature, enabled) => {
				const current = new Set(this.manager.getEnabledFeatures(plugin.name) ?? []);
				if (enabled) {
					current.add(feature);
				} else {
					current.delete(feature);
				}
				await this.manager.setEnabledFeatures(plugin.name, [...current]);
				this.callbacks.onPluginChanged();
			},
			onConfigChange: (key, value) => {
				this.manager.setPluginSetting(plugin.name, key, value);
				this.callbacks.onPluginChanged();
			},
			onBack: () => this.showPluginList(),
		});

		this.addChild(this.viewComponent);
	}

	handleInput(data: string): void {
		this.viewComponent?.handleInput(data);
	}
}
