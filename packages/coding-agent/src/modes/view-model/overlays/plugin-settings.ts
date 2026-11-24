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
