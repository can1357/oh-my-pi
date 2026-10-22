/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (npm plugins + marketplace plugins)
 *   - Plugin details (enablement, manifest settings, and marketplace metadata)
 */
import {
	type Component,
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	type SgrMouseEvent,
	Spacer,
	Text,
} from "../index";
import { logger } from "@oh-my-pi/pi-utils";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { shortenPath } from "../render/render-utils";
import { OverlayPanel } from "../chrome/overlay-box";
import { FormField, SelectFormField, TextFormField } from "../components/form";
import { formTheme } from "../chrome/form-theme";
import { type PrefsEditing, SettingsFormField, type SettingsList } from "../components/settings-list";
import { editorKey } from "../chrome/keybinding-hints";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { col, node, span, text } from "../native/describe";
import type { TspPrefsControl, TspPrefsSection } from "@oh-my-pi/pi-wire";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";

const PLUGIN_SETTINGS_ROLE = "omp.overlay.plugin-settings";
/** A plugin row's control on the native settings page: open the plugin's settings. */
const PLUGIN_CONFIGURE: TspPrefsControl = { k: "action", label: "Configure", act: "open" };

/** The plugins tab as a native settings page draws it (the settings selector puts it in its `prefs` node). */
export interface PluginPrefsPage {
	lead: string;
	sections: TspPrefsSection[];
	focus: string | null;
	editing: PrefsEditing | null;
	/** An open value editor without a native control, shown over the page. */
	editor?: NativeChild;
}

/**
 * A plugin detail list as native page sections: on/off rows as switches,
 * value rows as an edit button showing the value (the row's editor opens
 * over the page, see {@link prefsDetailEvent}).
 */
function prefsDetailPage(title: string, lead: string, list: SettingsList | undefined): PluginPrefsPage {
	if (!list) return { lead, sections: [], focus: null, editing: null };
	const sections = list.prefsSections(
		() => ({ id: "plugin", title }),
		(item): TspPrefsControl =>
			item.values?.length === 2 && item.values.includes("true") && item.values.includes("false")
				? { k: "switch", on: item.currentValue === "true" }
				: { k: "action", label: item.currentValue.trim() || "Edit…", act: "edit" },
	);
	const open = list.openSubmenu;
	return {
		lead,
		sections: sections.map(section => ({
			...section,
			rows: section.rows.map(row => ({ ...row, label: row.label.trim() })),
		})),
		focus: list.prefsFocus().row ?? null,
		editing: null,
		editor: open ? col([open.component], { role: "omp.prefs.editor" }) : undefined,
	};
}

/** A native page event on a plugin detail list, through the keys' code paths. */
function prefsDetailEvent(list: SettingsList | undefined, event: NativeUiEvent): void {
	if (!list) return;
	switch (event.type) {
		case "change":
			if (typeof event.value === "boolean") list.applyValue(event.item, String(event.value));
			return;
		case "select":
			list.selectItem(event.item);
			return;
		case "activate":
			list.openSubmenuFor(event.item);
			return;
		case "action":
			if (event.act === "edit" && event.value) list.openSubmenuFor(event.value);
			else if (event.act === "close" && event.value && list.openSubmenu?.id === event.value)
				list.handleInput("\x1b");
			return;
		case "toggle":
			return;
	}
}

/** Setting metadata consumed by the plugin settings UI. */
export type PluginSettingSchema = {
	description?: string;
	secret?: boolean;
} & (
	| { type: "string"; default?: string }
	| { type: "number"; default?: number; min?: number; max?: number }
	| { type: "boolean"; default?: boolean }
	| { type: "enum"; default?: string; values: string[] }
);

/** Installed runtime plugin fields consumed by the settings UI. */
export interface InstalledPlugin {
	name: string;
	version: string;
	enabled: boolean;
	enabledFeatures: string[] | null;
	manifest: {
		description?: string;
		features?: Record<string, { description?: string; default?: boolean }>;
		settings?: Record<string, PluginSettingSchema>;
	};
}

/** Installed marketplace metadata consumed by the settings UI. */
export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	shadowedBy?: "project";
	entries: {
		installPath: string;
		version: string;
		installedAt: string;
		lastUpdated: string;
		gitCommitSha?: string;
		enabled?: boolean;
	}[];
}

/** Runtime plugin manager capabilities required by the settings UI. */
export interface PluginSettingsManager {
	list(): Promise<InstalledPlugin[]>;
	getPlugin(name: string, options?: { path?: string }): Promise<InstalledPlugin | undefined>;
	getPluginSettings(name: string): Promise<Record<string, unknown>>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	getEnabledFeatures(name: string): Promise<string[] | null>;
	setEnabledFeatures(name: string, features: string[] | null): Promise<void>;
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
}

/** Marketplace manager capabilities required by the settings UI. */
export interface PluginSettingsMarketplaceManager {
	listInstalledPlugins(): Promise<InstalledPluginSummary[]>;
	setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void>;
}

/** Host-owned managers and plugin identifier parsing. */
export interface PluginSettingsHost {
	manager: PluginSettingsManager;
	createMarketplaceManager(): Promise<PluginSettingsMarketplaceManager>;
	parsePluginId(id: string): { name: string } | null;
}

/**
 * Forwards a keystroke to `input`, but cancels via `onCancel` when the user presses Escape.
 *
 * Escape is decoded via `matchesKey` rather than a raw `\x1b` compare: inside the
 * fullscreen settings overlay the kitty keyboard protocol is active (ghostty/kitty),
 * where the Escape key arrives as the CSI-u sequence `\x1b[27u`, not a bare `\x1b`.
 * The literal fallbacks preserve legacy single/double-escape on terminals without it.
 */
export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

// =============================================================================
// Plugin List Component
// =============================================================================

/**
 * One row in the unified plugin list. npm and marketplace plugins live in
 * separate registries with different shapes, so a tagged union keeps both
 * paths type-safe end-to-end (list rendering, value lookup, detail callback).
 */
export type PluginListEntry =
	| { kind: "npm"; plugin: InstalledPlugin }
	| { kind: "marketplace"; plugin: InstalledPluginSummary };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onMarketplaceSelect: (plugin: InstalledPluginSummary) => void;
	onCancel: () => void;
}

/**
 * True when the marketplace summary's first entry is not explicitly disabled.
 * Mirrors the `/plugins list` convention: a missing `enabled` flag means enabled.
 */
function marketplaceEnabled(summary: InstalledPluginSummary): boolean {
	return summary.entries[0]?.enabled !== false;
}

async function buildPluginConfigItems(
	plugin: InstalledPlugin,
	manager: PluginSettingsManager,
	onConfigChange: (key: string, value: unknown) => void | Promise<void>,
	requestRender?: () => void,
): Promise<SettingItem[]> {
	const schemaSettings = plugin.manifest.settings;
	if (!schemaSettings) return [];

	const settings = await manager.getPluginSettings(plugin.name);
	const items: SettingItem[] = [];
	for (const key in schemaSettings) {
		const schema = schemaSettings[key];
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
					createConfigEnumPanel(
						key,
						schema.description || `Select value for ${key}`,
						schema.values,
						cv,
						value => {
							const result = onConfigChange(key, value);
							done(value);
							return result;
						},
						() => done(),
						requestRender,
					),
			});
		} else {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || `Configure ${key}`,
				currentValue: displayValue,
				submenu: (cv, done) =>
					createConfigInputPanel(
						key,
						schema,
						cv === "(not set)" ? "" : cv,
						value => {
							const parsed = schema.type === "number" ? Number(value) : value;
							const result = onConfigChange(key, parsed);
							done(String(value));
							return result;
						},
						() => done(),
						requestRender,
					),
			});
		}
	}
	return items;
}

/**
 * Stable SelectList value for a list entry. Combined with `findEntryByValue`
 * this keeps lookup correct even when the same plugin id exists in both user
 * and project scope (one of which is `shadowedBy: "project"`).
 */
function entryValue(entry: PluginListEntry): string {
	if (entry.kind === "npm") return `npm:${entry.plugin.name}`;
	return `mkt:${entry.plugin.scope}:${entry.plugin.id}`;
}

function findEntryByValue(entries: ReadonlyArray<PluginListEntry>, value: string): PluginListEntry | undefined {
	return entries.find(e => entryValue(e) === value);
}

/**
 * Shows installed plugins from both registries (npm + marketplace) with
 * enable/disable status, scope tag, and shadow indicator. Selecting an entry
 * fans out to the kind-specific detail callback.
 */
export class PluginListComponent extends OverlayPanel {
	readonly #selectList: SelectList;
	#native: NativeNode | undefined;

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super("Plugins", PLUGIN_SETTINGS_ROLE);
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Install npm plugins:        omp plugin install <package>"), 0, 0));
			this.addChild(
				new Text(theme.fg("dim", "Install marketplace plugins: omp plugin install <name>@<marketplace>"), 0, 0),
			);
			this.addChild(new Spacer(1));

			// Empty list still handles Escape so the user can leave the panel.
			this.#selectList = new SelectList([], 1, getSelectListTheme());
			this.#selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = entries.map(entry => this.#renderItem(entry));

		// Marketplace plugin ids (`name@marketplace`) routinely run past the
		// SelectList default primary column (32 chars). Widen the bound so the
		// id remains readable; the description gets whatever width is left.
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});

		this.#selectList.onSelect = item => {
			const found = findEntryByValue(this.entries, item.value);
			if (!found) return;
			if (found.kind === "npm") callbacks.onNpmSelect(found.plugin);
			else callbacks.onMarketplaceSelect(found.plugin);
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`${editorKey("tui.select.confirm")} to configure · ${editorKey("tui.select.cancel")} to go back`,
				),
				0,
				0,
			),
		);
	}

	/** The installed plugins as one native page section: a row per plugin with its status and a Configure button. */
	prefsPage(): PluginPrefsPage {
		const rows = this.entries.map(entry => {
			const id = entryValue(entry);
			if (entry.kind === "npm") {
				const p = entry.plugin;
				const features = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
				const parts = [p.enabled ? "Enabled" : "Disabled", "npm", `v${p.version}`];
				if (features > 0) parts.push(`${p.enabledFeatures?.length ?? features}/${features} features`);
				return { id, label: p.name, hint: parts.join(" · "), control: PLUGIN_CONFIGURE };
			}
			const s = entry.plugin;
			const parts = [marketplaceEnabled(s) ? "Enabled" : "Disabled", "marketplace", s.scope];
			parts.push(`v${s.entries[0]?.version ?? "?"}`);
			return {
				id,
				label: s.id,
				hint: parts.join(" · "),
				warning: s.shadowedBy ? `Shadowed by the ${s.shadowedBy} install` : undefined,
				control: PLUGIN_CONFIGURE,
			};
		});
		return {
			lead:
				rows.length > 0
					? "Plugins installed for you and this project. Configure one to turn it or its features on and off."
					: "No plugins installed. Install one with omp plugin install <package>, or <name>@<marketplace>.",
			sections: rows.length > 0 ? [{ id: "installed", title: "Installed", rows }] : [],
			focus: this.#selectList.getSelectedItem()?.value ?? null,
			editing: null,
		};
	}

	/** A native page event: a row click moves the selection, Configure (or a double click) opens the plugin. */
	handlePrefsEvent(event: NativeUiEvent): void {
		if (event.type === "select") this.#selectList.setSelectedValue(event.item);
		else if (event.type === "activate") this.#selectList.handleNativeEvent(event);
		else if (event.type === "action" && event.act === "open" && event.value) {
			this.#selectList.handleNativeEvent({ type: "activate", key: event.key, item: event.value });
		}
	}

	/** The plugin list (the select list describes itself) and its hints, or install guidance when empty. */
	override describe(_cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const body =
			this.entries.length === 0
				? [
						text([span("No plugins installed", "muted")]),
						node("kv", {
							items: [
								{ k: "Install npm plugins", v: [span("omp plugin install <package>", "code")] },
								{
									k: "Install marketplace plugins",
									v: [span("omp plugin install <name>@<marketplace>", "code")],
								},
							],
						}),
						hintsRow([actionHint("tui.select.cancel", "go back")]),
					]
				: [
						this.#selectList,
						hintsRow([actionHint("tui.select.confirm", "configure"), actionHint("tui.select.cancel", "go back")]),
					];
		this.#native = overlayCard(PLUGIN_SETTINGS_ROLE, this.title, body);
		return this.#native;
	}

	#renderItem(entry: PluginListEntry): SelectItem {
		const kindBadge = theme.fg("dim", entry.kind === "npm" ? "[npm]" : "[marketplace]");

		if (entry.kind === "npm") {
			const p = entry.plugin;
			const status = p.enabled
				? theme.fg("success", theme.status.enabled)
				: theme.fg("muted", theme.status.disabled);
			const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
			const enabledCount = p.enabledFeatures?.length ?? featureCount;

			let details = `${kindBadge} ${theme.sep.dot} v${p.version}`;
			if (featureCount > 0) {
				details += ` ${theme.sep.dot} ${enabledCount}/${featureCount} features`;
			}

			return {
				value: entryValue(entry),
				label: `${status} ${p.name}`,
				description: details,
			};
		}

		const summary = entry.plugin;
		const enabled = marketplaceEnabled(summary);
		const status = enabled ? theme.fg("success", theme.status.enabled) : theme.fg("muted", theme.status.disabled);
		const scopeTag = theme.fg("dim", `[${summary.scope}]`);
		const shadowMarker = summary.shadowedBy ? ` ${theme.fg("warning", theme.status.shadowed)}` : "";
		const version = summary.entries[0]?.version ?? "?";

		let details = `${kindBadge} ${scopeTag} ${theme.sep.dot} v${version}`;
		if (summary.shadowedBy) {
			details += ` ${theme.sep.dot} shadowed by ${summary.shadowedBy}`;
		}

		return {
			value: entryValue(entry),
			label: `${status} ${summary.id}${shadowMarker}`,
			description: details,
		};
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void | Promise<void>;
	/** Schedules a frame after an asynchronous config submission settles. */
	requestRender?: () => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends OverlayPanel {
	#settingsList!: SettingsFormField;

	constructor(
		private plugin: InstalledPlugin,
		private readonly manager: PluginSettingsManager,
		private readonly callbacks: PluginDetailCallbacks,
	) {
		super(plugin.name, PLUGIN_SETTINGS_ROLE);

		void this.#rebuild();
	}

	async #rebuild(): Promise<void> {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		this.title = plugin.name;

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
				.filter(([_featureName, f]) => f.default)
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

		items.push(
			...(await buildPluginConfigItems(
				plugin,
				this.manager,
				this.callbacks.onConfigChange,
				this.callbacks.requestRender,
			)),
		);

		this.#settingsList = new SettingsFormField({
			fieldTheme: formTheme,
			description: manifest.description || undefined,
			items,
			maxVisible: Math.min(items.length, 10),
			settingsTheme: getSettingsListTheme(),
			hint: `${editorKey("tui.select.confirm")} to edit · ${editorKey("tui.select.cancel")} to go back`,
			onChange: (id, newValue) => {
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
			onCancel: this.callbacks.onBack,
		});

		this.addChild(this.#settingsList);
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}

	/** This plugin's settings as a native page section. */
	prefsPage(): PluginPrefsPage {
		return prefsDetailPage(
			this.plugin.name,
			this.plugin.manifest.description || "Turn the plugin and its features on and off, and change its settings.",
			this.#settingsList?.settingsList,
		);
	}

	/** A native page event on this plugin's settings. */
	handlePrefsEvent(event: NativeUiEvent): void {
		prefsDetailEvent(this.#settingsList?.settingsList, event);
	}
}

// =============================================================================
// Marketplace Plugin Detail Component
// =============================================================================

export interface MarketplacePluginDetailCallbacks {
	parsePluginId: PluginSettingsHost["parsePluginId"];
	onEnabledChange: (enabled: boolean) => void;
	onConfigChange: (pluginName: string, key: string, value: unknown) => void;
	/** Schedules a TUI frame after asynchronous manifest settings load. */
	requestRender?: () => void;
	onBack: () => void;
}

/**
 * Detail view for a marketplace plugin, including settings declared by its
 * runtime package and metadata from the installed-plugins registry.
 */
export class MarketplacePluginDetailComponent extends OverlayPanel {
	#settingsList!: SettingsFormField;

	constructor(
		private plugin: InstalledPluginSummary,
		private readonly manager: PluginSettingsManager,
		private readonly callbacks: MarketplacePluginDetailCallbacks,
	) {
		super(plugin.id, PLUGIN_SETTINGS_ROLE);
		this.#render(undefined, []);
		void this.#loadConfig();
	}

	async #loadConfig(): Promise<void> {
		const entry = this.plugin.entries[0];
		if (!entry) return;

		const fallbackName = this.callbacks.parsePluginId(this.plugin.id)?.name ?? this.plugin.id;
		try {
			const runtimePlugin = await this.manager.getPlugin(fallbackName, { path: entry.installPath });
			if (!runtimePlugin) return;
			const configItems = await buildPluginConfigItems(
				runtimePlugin,
				this.manager,
				(key, value) => this.callbacks.onConfigChange(runtimePlugin.name, key, value),
				this.callbacks.requestRender,
			);
			this.#render(runtimePlugin, configItems);
			this.callbacks.requestRender?.();
		} catch (err) {
			logger.error("Settings → Plugins: failed to load marketplace plugin settings", {
				pluginId: this.plugin.id,
				path: entry.installPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#render(runtimePlugin: InstalledPlugin | undefined, configItems: SettingItem[]): void {
		this.clear();

		const plugin = this.plugin;
		const entry = plugin.entries[0];
		this.title = plugin.id;
		const subtitleParts = [`[${plugin.scope}]`];
		if (plugin.shadowedBy) subtitleParts.push(`${theme.status.shadowed} shadowed by ${plugin.shadowedBy}`);

		const items: SettingItem[] = [
			{
				id: "__enabled__",
				label: "Enabled",
				description: "Enable or disable this marketplace plugin",
				currentValue: marketplaceEnabled(plugin) ? "true" : "false",
				values: ["true", "false"],
			},
			...configItems,
		];
		const summary: Component[] = [
			new Text(theme.fg("dim", `version       ${entry?.version ?? "(unknown)"}`), 0, 0),
			new Text(theme.fg("dim", `scope         ${plugin.scope}`), 0, 0),
			new Text(
				theme.fg("dim", `install path  ${entry?.installPath ? shortenPath(entry.installPath) : "(unknown)"}`),
				0,
				0,
			),
			new Text(theme.fg("dim", `installed at  ${entry?.installedAt ?? "(unknown)"}`), 0, 0),
			new Text(theme.fg("dim", `last updated  ${entry?.lastUpdated ?? "(unknown)"}`), 0, 0),
		];
		if (entry?.gitCommitSha) {
			summary.push(new Text(theme.fg("dim", `git sha       ${entry.gitCommitSha}`), 0, 0));
		}
		summary.push(new Spacer(1));
		this.#settingsList = new SettingsFormField({
			fieldTheme: formTheme,
			description: subtitleParts.join(" ") || undefined,
			items,
			maxVisible: Math.min(items.length, 10),
			settingsTheme: getSettingsListTheme(),
			summary,
			hint: `${editorKey("tui.select.confirm")} to edit · ${editorKey("tui.select.cancel")} to go back`,
			onChange: (id, newValue) => {
				if (id === "__enabled__") {
					const next = newValue === "true";
					this.callbacks.onEnabledChange(next);
					this.plugin = {
						...this.plugin,
						entries: this.plugin.entries.map(e => ({ ...e, enabled: next })),
					};
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					if (runtimePlugin?.manifest.settings?.[key]?.type === "boolean") {
						this.callbacks.onConfigChange(runtimePlugin.name, key, newValue === "true");
					}
				}
			},
			onCancel: this.callbacks.onBack,
		});

		this.addChild(this.#settingsList);
	}

	handleInput(data: string): void {
		this.#settingsList.handleInput(data);
	}

	/** This plugin's settings as a native page section, with its install facts as the lead. */
	prefsPage(): PluginPrefsPage {
		const entry = this.plugin.entries[0];
		const facts = [`${this.plugin.scope} install`, `v${entry?.version ?? "?"}`];
		if (entry?.installPath) facts.push(shortenPath(entry.installPath));
		if (this.plugin.shadowedBy) facts.push(`shadowed by the ${this.plugin.shadowedBy} install`);
		return prefsDetailPage(this.plugin.id, facts.join(" · "), this.#settingsList?.settingsList);
	}

	/** A native page event on this plugin's settings. */
	handlePrefsEvent(event: NativeUiEvent): void {
		prefsDetailEvent(this.#settingsList?.settingsList, event);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Thin OverlayPanel boundary around a shared form field. The panel title stays
 * the setting key; input, paste, focus, and mouse all forward to the field.
 */
class ConfigFieldPanel extends OverlayPanel {
	#field: FormField;

	constructor(key: string, field: FormField) {
		super(key, `${PLUGIN_SETTINGS_ROLE}.field`);
		this.#field = field;
		this.addChild(field);
	}

	get focused(): boolean {
		return this.#field.focused;
	}

	set focused(value: boolean) {
		this.#field.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#field.setUseTerminalCursor(useTerminalCursor);
	}

	handleInput(data: string): void {
		this.#field.handleInput(data);
	}

	pasteText(text: string): void {
		this.#field.pasteText(text);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		// OverlayPanel contributes one top-border row and a two-column body inset.
		this.#field.routeMouse(event, line - 1, col - 2);
	}
}

/** Enum setting submenu backed by a shared select field. */
function createConfigEnumPanel(
	key: string,
	description: string,
	values: string[],
	currentValue: string,
	onSelect: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): Component {
	const field = new SelectFormField({
		theme: formTheme,
		description: description || undefined,
		leadingSpace: true,
		items: values.map(v => ({ value: v, label: v })),
		currentValue,
		maxVisible: 8,
		selectTheme: getSelectListTheme(),
		hint: `${editorKey("tui.select.confirm")} to select · ${editorKey("tui.select.cancel")} to cancel`,
		onSubmit: onSelect,
		onCancel,
		requestRender,
	});
	return new ConfigFieldPanel(key, field);
}

/** String/number setting submenu backed by a shared text field. */
function createConfigInputPanel(
	key: string,
	schema: PluginSettingSchema,
	currentValue: string,
	onSubmit: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): Component {
	let typeHint = `Type: ${schema.type}`;
	if (schema.type === "number" && (schema.min !== undefined || schema.max !== undefined)) {
		typeHint += ` (${schema.min ?? ""}..${schema.max ?? ""})`;
	}
	const field = new TextFormField({
		theme: formTheme,
		description: schema.description || undefined,
		details: [...(schema.description ? [new Spacer(1)] : []), new Text(theme.fg("dim", typeHint), 0, 0)],
		leadingSpace: true,
		secret: schema.secret,
		initialValue: !schema.secret ? currentValue : undefined,
		empty: "cancel",
		hint: `${editorKey("tui.input.submit")} to save · ${editorKey("tui.select.cancel")} to cancel`,
		onSubmit,
		onCancel,
		requestRender,
	});
	return new ConfigFieldPanel(key, field);
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

/** The plugin a toggle switched, and which way: consumers must warn that already-running sessions keep a disabled plugin bound. */
export interface PluginSettingsChange {
	readonly pluginName: string;
	readonly enabled: boolean;
	/** Scope still enabling the plugin after this toggle, when another install kept it on. */
	readonly stillEnabledBy?: "user" | "project";
}

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: (change?: PluginSettingsChange) => void | Promise<void>;
	/** Schedules a TUI frame after asynchronous plugin data loads. */
	requestRender?: () => void;
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
	readonly #host: PluginSettingsHost;
	#manager: PluginSettingsManager;
	#viewComponent: (Component & InputHandler) | null = null;
	// oxlint-disable-next-line no-unused-private-class-members -- state tracking for view management
	#currentView: "list" | "npm-detail" | "marketplace-detail" = "list";
	// oxlint-disable-next-line no-unused-private-class-members -- state tracking for view management
	#currentPlugin: InstalledPlugin | null = null;
	// oxlint-disable-next-line no-unused-private-class-members -- state tracking for view management
	#currentMarketplacePlugin: InstalledPluginSummary | null = null;

	constructor(
		host: PluginSettingsHost,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#host = host;
		this.#manager = host.manager;
		this.#showPluginList();
	}

	async #showPluginList(): Promise<void> {
		this.#currentView = "list";
		this.#currentPlugin = null;
		this.#currentMarketplacePlugin = null;
		this.clear();

		// Surface registry failures without taking the whole tab down — either
		// registry can fail to load (corrupt JSON, missing project root) and the
		// user still benefits from the other half. An uncaught rejection here
		// would also leave the tab permanently blank: this method is invoked
		// fire-and-forget from the constructor, so nothing awaits it.
		const [npmPlugins, marketplacePlugins] = await Promise.all([
			this.#manager.list().catch((err): InstalledPlugin[] => {
				logger.error("Settings → Plugins: failed to list npm plugins", {
					error: err instanceof Error ? err.message : String(err),
				});
				return [];
			}),
			this.#host
				.createMarketplaceManager()
				.then(mgr => mgr.listInstalledPlugins())
				.catch((err): InstalledPluginSummary[] => {
					logger.error("Settings → Plugins: failed to list marketplace plugins", {
						error: err instanceof Error ? err.message : String(err),
					});
					return [];
				}),
		]);

		const entries: PluginListEntry[] = [
			...npmPlugins.map((plugin): PluginListEntry => ({ kind: "npm", plugin })),
			...marketplacePlugins.map((plugin): PluginListEntry => ({ kind: "marketplace", plugin })),
		];

		this.#viewComponent = new PluginListComponent(entries, {
			onNpmSelect: plugin => this.#showPluginDetail(plugin),
			onMarketplaceSelect: plugin => this.#showMarketplaceDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.#viewComponent);

		// The list mounts after the first frame (npm + marketplace listing is
		// async and this method runs fire-and-forget), so ask for a repaint —
		// otherwise the tab stays blank until an unrelated event forces a
		// render, e.g. reopening /settings (issue #9526).
		this.callbacks.requestRender?.();
	}

	/** The current view (list or a plugin's settings) as a native settings page. */
	prefsPage(): PluginPrefsPage {
		const view = this.#viewComponent;
		if (
			view instanceof PluginListComponent ||
			view instanceof PluginDetailComponent ||
			view instanceof MarketplacePluginDetailComponent
		) {
			return view.prefsPage();
		}
		return { lead: "Loading installed plugins…", sections: [], focus: null, editing: null };
	}

	/** Routes a native page event to the current view. */
	handlePrefsEvent(event: NativeUiEvent): void {
		const view = this.#viewComponent;
		if (
			view instanceof PluginListComponent ||
			view instanceof PluginDetailComponent ||
			view instanceof MarketplacePluginDetailComponent
		) {
			view.handlePrefsEvent(event);
		}
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#currentView = "npm-detail";
		this.#currentPlugin = plugin;
		this.#currentMarketplacePlugin = null;
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#manager, {
			onEnabledChange: async enabled => {
				await this.#manager.setEnabled(plugin.name, enabled);
				await this.callbacks.onPluginChanged({ pluginName: plugin.name, enabled });
			},
			onFeatureChange: async (feature, enabled) => {
				const current = new Set((await this.#manager.getEnabledFeatures(plugin.name)) ?? []);
				if (enabled) {
					current.add(feature);
				} else {
					current.delete(feature);
				}
				await this.#manager.setEnabledFeatures(plugin.name, [...current]);
				await this.callbacks.onPluginChanged();
			},
			onConfigChange: async (key, value) => {
				await this.#manager.setPluginSetting(plugin.name, key, value);
				await this.callbacks.onPluginChanged();
			},
			onBack: () => this.#showPluginList(),
			requestRender: this.callbacks.requestRender,
		});

		this.addChild(this.#viewComponent);
	}

	#showMarketplaceDetail(plugin: InstalledPluginSummary): void {
		this.#currentView = "marketplace-detail";
		this.#currentPlugin = null;
		this.#currentMarketplacePlugin = plugin;
		this.clear();

		this.#viewComponent = new MarketplacePluginDetailComponent(plugin, this.#manager, {
			parsePluginId: id => this.#host.parsePluginId(id),
			onEnabledChange: async enabled => {
				try {
					const mgr = await this.#host.createMarketplaceManager();
					await mgr.setPluginEnabled(plugin.id, enabled, plugin.scope);
					// A disable only writes the toggled scope; report which install, if
					// any, still enables the plugin, so the notice does not claim a
					// restart is enough when another scope keeps it on.
					let stillEnabledBy: "user" | "project" | undefined;
					if (!enabled) {
						// The toggle is persisted before this read, so a failed re-read
						// must not drop the status update: fall back to the plain
						// running-session notice.
						stillEnabledBy = await mgr
							.listInstalledPlugins()
							.then(
								remaining =>
									remaining
										.filter(summary => summary.id === plugin.id && summary.scope !== plugin.scope)
										.find(summary => summary.entries.some(entry => entry.enabled !== false))?.scope,
							)
							.catch(() => undefined);
					}
					await this.callbacks.onPluginChanged({ pluginName: plugin.id, enabled, stillEnabledBy });
				} catch (err) {
					logger.error("Settings → Plugins: failed to toggle marketplace plugin", {
						pluginId: plugin.id,
						scope: plugin.scope,
						enabled,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
			onConfigChange: async (pluginName, key, value) => {
				await this.#manager.setPluginSetting(pluginName, key, value);
				await this.callbacks.onPluginChanged();
			},
			onBack: () => this.#showPluginList(),
			requestRender: this.callbacks.requestRender,
		});

		this.addChild(this.#viewComponent);
	}

	handleInput(data: string): void {
		if (!this.#viewComponent) {
			// The list view mounts asynchronously (npm + marketplace listing).
			// Until it does — or if listing rejected and no view ever mounted —
			// Escape must still close the panel instead of leaving /settings
			// non-dismissible.
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.callbacks.onClose();
			}
			return;
		}
		this.#viewComponent.handleInput(data);
	}
}
