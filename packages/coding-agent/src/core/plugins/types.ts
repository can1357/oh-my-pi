// =============================================================================
// Plugin Manifest Types (from package.json omp/pi field)
// =============================================================================

/**
 * Feature definition for selective plugin installation.
 * Features allow plugins to expose optional functionality.
 */
export interface PluginFeature {
	/** Human-readable description */
	description?: string;
	/** Whether this feature is enabled by default */
	default?: boolean;
	/** Additional tool entry points provided by this feature */
	tools?: string[];
	/** Additional hook entry points provided by this feature */
	hooks?: string[];
	/** Additional command files provided by this feature */
	commands?: string[];
}

/**
 * Plugin manifest from package.json omp or pi field.
 */
export interface PluginManifest {
	/** Plugin display name (defaults to package name) */
	name?: string;
	/** Plugin version (copied from package.json version) */
	version: string;
	/** Human-readable description */
	description?: string;

	/** Entry point for base tools (relative path from package root) */
	tools?: string;
	/** Entry point for base hooks (relative path from package root) */
	hooks?: string;
	/** Command files (relative paths from package root) */
	commands?: string[];

	/** Feature definitions for selective installation */
	features?: Record<string, PluginFeature>;

	/** Settings schema for plugin configuration */
	settings?: Record<string, PluginSettingSchema>;
}

// =============================================================================
// Plugin Settings Schema Types
// =============================================================================

export type PluginSettingType = "string" | "number" | "boolean" | "enum";

interface PluginSettingBase {
	/** Setting type */
	type: PluginSettingType;
	/** Human-readable description */
	description?: string;
	/** If true, mask value in UI and logs */
	secret?: boolean;
	/** Environment variable to use as fallback value */
	env?: string;
}

export interface StringSetting extends PluginSettingBase {
	type: "string";
	default?: string;
}

export interface NumberSetting extends PluginSettingBase {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
	step?: number;
}

export interface BooleanSetting extends PluginSettingBase {
	type: "boolean";
	default?: boolean;
}

export interface EnumSetting extends PluginSettingBase {
	type: "enum";
	/** Allowed values */
	values: string[];
	default?: string;
}

export type PluginSettingSchema = StringSetting | NumberSetting | BooleanSetting | EnumSetting;

// =============================================================================
// Installed Plugin Types
// =============================================================================

/**
 * Represents an installed plugin with full metadata.
 */
export interface InstalledPlugin {
	/** npm package name */
	name: string;
	/** Installed version */
	version: string;
	/** Absolute path to package directory */
	path: string;
	/** Parsed omp/pi manifest */
	manifest: PluginManifest;
	/**
	 * Enabled features:
	 * - null: use defaults (all features with default: true)
	 * - string[]: specific features enabled
	 */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

// =============================================================================
// Runtime Config Types (stored in omp-plugins.lock.json)
// =============================================================================

/**
 * Per-plugin runtime state stored in lock file.
 */
export interface PluginRuntimeState {
	/** Installed version */
	version: string;
	/** Enabled features (null = defaults) */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

/**
 * Runtime configuration persisted to omp-plugins.lock.json.
 * Tracks plugin states and settings across sessions.
 */
export interface PluginRuntimeConfig {
	/** Plugin states keyed by package name */
	plugins: Record<string, PluginRuntimeState>;
	/** Plugin settings keyed by package name, then setting key */
	settings: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Project Override Types
// =============================================================================

/**
 * Project-local plugin overrides (stored in .omp/plugin-overrides.json).
 * Allows per-project plugin configuration without modifying global state.
 */
export interface ProjectPluginOverrides {
	/** Plugins to disable in this project */
	disabled?: string[];
	/** Per-plugin feature overrides */
	features?: Record<string, string[]>;
	/** Per-plugin setting overrides */
	settings?: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Doctor Types
// =============================================================================

export interface DoctorCheck {
	/** Check identifier */
	name: string;
	/** Check result status */
	status: "ok" | "warning" | "error";
	/** Human-readable message */
	message: string;
	/** Whether --fix resolved this issue */
	fixed?: boolean;
}

// =============================================================================
// Install Options Types
// =============================================================================

export interface InstallOptions {
	/** Overwrite existing without prompting */
	force?: boolean;
	/** Preview changes without applying */
	dryRun?: boolean;
}

export interface DoctorOptions {
	/** Attempt automatic fixes */
	fix?: boolean;
}
