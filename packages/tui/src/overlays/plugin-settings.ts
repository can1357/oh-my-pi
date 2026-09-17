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
import { FormField, SelectFormField, TextFormField, type FormFieldTheme } from "../components/form";
import { SettingsFormField } from "../components/settings-list";

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

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super("Plugins");
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
		this.addChild(new Text(theme.fg("dim", "Enter to configure · Esc to go back"), 0, 0));
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
		super(plugin.name);

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
			hint: DETAIL_FOOTER_HINT,
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
		super(plugin.id);
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
			hint: DETAIL_FOOTER_HINT,
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
}

// =============================================================================
// Config Submenus
// =============================================================================

const formTheme: FormFieldTheme = {
	label: text => theme.bold(theme.fg("accent", text)),
	description: text => theme.fg("muted", text),
	error: text => theme.fg("error", text),
	hint: text => theme.fg("dim", text),
};

/** Shared footer hint for plugin detail lists. */
const DETAIL_FOOTER_HINT = "Enter to edit · Esc to go back";

/**
 * Thin OverlayPanel boundary around a shared form field. The panel title stays
 * the setting key; input, paste, focus, and mouse all forward to the field.
 */
class ConfigFieldPanel extends OverlayPanel {
	#field: FormField;

	constructor(key: string, field: FormField) {
		super(key);
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
		hint: "Enter to select · Esc to cancel",
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
		hint: "Enter to save · Esc to cancel",
		onSubmit,
		onCancel,
		requestRender,
	});
	return new ConfigFieldPanel(key, field);
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void | Promise<void>;
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

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#currentView = "npm-detail";
		this.#currentPlugin = plugin;
		this.#currentMarketplacePlugin = null;
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#manager, {
			onEnabledChange: async enabled => {
				await this.#manager.setEnabled(plugin.name, enabled);
				await this.callbacks.onPluginChanged();
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
					await this.callbacks.onPluginChanged();
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
