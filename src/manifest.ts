import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	GLOBAL_PACKAGE_JSON,
	NODE_MODULES_DIR,
	PLUGINS_DIR,
	PROJECT_PACKAGE_JSON,
	PROJECT_PLUGINS_JSON,
} from "@omp/paths";

/**
 * Format permission-related errors with actionable guidance
 */
function formatPermissionError(err: NodeJS.ErrnoException, path: string): string {
	if (err.code === "EACCES" || err.code === "EPERM") {
		return `Permission denied: Cannot write to ${path}. Check directory permissions or run with appropriate privileges.`;
	}
	return err.message;
}

/**
 * OMP field in package.json - defines what files to install
 */
export interface OmpInstallEntry {
	src: string;
	dest: string;
	/** If true, this file is copied (not symlinked) and can be edited by omp */
	copy?: boolean;
}

/**
 * Runtime configuration stored in plugin's runtime.json
 * This file is copied (not symlinked) and edited by omp features/config commands
 */
export interface PluginRuntimeConfig {
	features?: string[];
	options?: Record<string, unknown>;
}

/**
 * Runtime variable definition with type, default, and metadata
 */
export interface OmpVariable {
	type: "string" | "number" | "boolean" | "string[]";
	default?: string | number | boolean | string[];
	description?: string;
	required?: boolean;
	/** Environment variable name if injected as env (e.g., "EXA_API_KEY") */
	env?: string;
}

/**
 * Feature definition - metadata only, no install entries
 * All feature files are always installed; runtime.json controls which are active
 */
export interface OmpFeature {
	description?: string;
	/** Runtime variables specific to this feature */
	variables?: Record<string, OmpVariable>;
	/** Default enabled state (default: true) */
	default?: boolean;
}

export interface OmpField {
	/** Top-level install entries (always installed, not feature-gated) */
	install?: OmpInstallEntry[];
	/** Top-level runtime variables (always available) */
	variables?: Record<string, OmpVariable>;
	/** Named features with their own install entries and variables */
	features?: Record<string, OmpFeature>;
	/** Disabled state (managed by omp, not plugin author) */
	disabled?: boolean;
}

/**
 * Package.json structure for plugins
 */
export interface PluginPackageJson {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	omp?: OmpField;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	files?: string[];
}

/**
 * Per-plugin configuration stored in plugins.json
 */
export interface PluginConfig {
	/**
	 * Enabled feature names:
	 * - null/undefined: use plugin defaults (first install = all, reinstall = preserve)
	 * - ["*"]: explicitly all features
	 * - []: no optional features (core only)
	 * - ["f1", "f2"]: specific features
	 */
	features?: string[] | null;
	/** Runtime variable overrides */
	variables?: Record<string, string | number | boolean | string[]>;
}

/**
 * Global/project plugins.json structure
 */
export interface PluginsJson {
	plugins: Record<string, string>; // name -> version specifier
	devDependencies?: Record<string, string>; // dev dependencies
	disabled?: string[]; // disabled plugin names
	/** Per-plugin feature and variable config */
	config?: Record<string, PluginConfig>;
}

/**
 * Initialize the global plugins directory with package.json
 */
export async function initGlobalPlugins(): Promise<void> {
	try {
		await mkdir(PLUGINS_DIR, { recursive: true });

		if (!existsSync(GLOBAL_PACKAGE_JSON)) {
			const packageJson = {
				name: "pi-plugins",
				version: "1.0.0",
				private: true,
				description: "Global pi plugins managed by omp",
				dependencies: {},
			};
			await writeFile(GLOBAL_PACKAGE_JSON, JSON.stringify(packageJson, null, 2));
		}
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "EACCES" || error.code === "EPERM") {
			throw new Error(formatPermissionError(error, PLUGINS_DIR));
		}
		throw err;
	}
}

/**
 * Initialize the project-local .pi directory with plugins.json and package.json
 */
export async function initProjectPlugins(): Promise<void> {
	const PROJECT_PI_DIR = dirname(PROJECT_PLUGINS_JSON);
	try {
		await mkdir(PROJECT_PI_DIR, { recursive: true });

		// Create plugins.json if it doesn't exist
		if (!existsSync(PROJECT_PLUGINS_JSON)) {
			const pluginsJson = {
				plugins: {},
			};
			await writeFile(PROJECT_PLUGINS_JSON, JSON.stringify(pluginsJson, null, 2));
		}

		// Create package.json if it doesn't exist (for npm operations)
		if (!existsSync(PROJECT_PACKAGE_JSON)) {
			const packageJson = {
				name: "pi-project-plugins",
				version: "1.0.0",
				private: true,
				description: "Project-local pi plugins managed by omp",
				dependencies: {},
			};
			await writeFile(PROJECT_PACKAGE_JSON, JSON.stringify(packageJson, null, 2));
		}
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "EACCES" || error.code === "EPERM") {
			throw new Error(formatPermissionError(error, PROJECT_PI_DIR));
		}
		throw err;
	}
}

/**
 * Load plugins.json (global or project)
 */
export async function loadPluginsJson(global = true): Promise<PluginsJson> {
	const path = global ? GLOBAL_PACKAGE_JSON : PROJECT_PLUGINS_JSON;

	try {
		const data = await readFile(path, "utf-8");
		const parsed = JSON.parse(data);

		if (global) {
			// Global uses standard package.json format
			return {
				plugins: parsed.dependencies || {},
				devDependencies: parsed.devDependencies || {},
				disabled: parsed.omp?.disabled || [],
				config: parsed.omp?.config || {},
			};
		}

		// Project uses plugins.json format
		return {
			plugins: parsed.plugins || {},
			devDependencies: parsed.devDependencies || {},
			disabled: parsed.disabled || [],
			config: parsed.config || {},
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { plugins: {}, devDependencies: {}, disabled: [], config: {} };
		}
		throw err;
	}
}

/**
 * Sync .pi/package.json with plugins.json for npm operations in project-local mode
 */
async function syncProjectPackageJson(data: PluginsJson): Promise<void> {
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await readFile(PROJECT_PACKAGE_JSON, "utf-8"));
	} catch {
		existing = {
			name: "pi-project-plugins",
			version: "1.0.0",
			private: true,
			description: "Project-local pi plugins managed by omp",
		};
	}

	existing.dependencies = data.plugins;
	if (data.devDependencies && Object.keys(data.devDependencies).length > 0) {
		existing.devDependencies = data.devDependencies;
	} else {
		delete existing.devDependencies;
	}

	await writeFile(PROJECT_PACKAGE_JSON, JSON.stringify(existing, null, 2));
}

/**
 * Save plugins.json (global or project)
 */
export async function savePluginsJson(data: PluginsJson, global = true): Promise<void> {
	const path = global ? GLOBAL_PACKAGE_JSON : PROJECT_PLUGINS_JSON;

	try {
		await mkdir(dirname(path), { recursive: true });

		if (global) {
			// Read existing package.json and update dependencies
			let existing: Record<string, unknown> = {};
			try {
				existing = JSON.parse(await readFile(path, "utf-8"));
			} catch {
				existing = {
					name: "pi-plugins",
					version: "1.0.0",
					private: true,
					description: "Global pi plugins managed by omp",
				};
			}

			existing.dependencies = data.plugins;
			if (data.devDependencies && Object.keys(data.devDependencies).length > 0) {
				existing.devDependencies = data.devDependencies;
			} else {
				delete existing.devDependencies;
			}

			// Build omp field with disabled and config
			const ompField: Record<string, unknown> = (existing.omp as Record<string, unknown>) || {};
			if (data.disabled?.length) {
				ompField.disabled = data.disabled;
			} else {
				delete ompField.disabled;
			}
			if (data.config && Object.keys(data.config).length > 0) {
				ompField.config = data.config;
			} else {
				delete ompField.config;
			}
			if (Object.keys(ompField).length > 0) {
				existing.omp = ompField;
			} else {
				delete existing.omp;
			}

			await writeFile(path, JSON.stringify(existing, null, 2));
		} else {
			// Project uses simple plugins.json format
			const output: Record<string, unknown> = { plugins: data.plugins };
			if (data.devDependencies && Object.keys(data.devDependencies).length > 0) {
				output.devDependencies = data.devDependencies;
			}
			if (data.disabled?.length) {
				output.disabled = data.disabled;
			}
			if (data.config && Object.keys(data.config).length > 0) {
				output.config = data.config;
			}
			await writeFile(path, JSON.stringify(output, null, 2));

			// Sync .pi/package.json for npm operations
			await syncProjectPackageJson(data);
		}
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "EACCES" || error.code === "EPERM") {
			throw new Error(formatPermissionError(error, path));
		}
		throw err;
	}
}

/**
 * Read a plugin's package.json from node_modules
 */
export async function readPluginPackageJson(pluginName: string, global = true): Promise<PluginPackageJson | null> {
	const nodeModules = global ? NODE_MODULES_DIR : ".pi/node_modules";
	let pkgPath: string;

	// Handle scoped packages
	if (pluginName.startsWith("@")) {
		pkgPath = join(nodeModules, pluginName, "package.json");
	} else {
		pkgPath = join(nodeModules, pluginName, "package.json");
	}

	try {
		const data = await readFile(pkgPath, "utf-8");
		return JSON.parse(data) as PluginPackageJson;
	} catch {
		return null;
	}
}

/**
 * Get the source directory for a plugin in node_modules
 */
export function getPluginSourceDir(pluginName: string, global = true): string {
	const nodeModules = global ? NODE_MODULES_DIR : ".pi/node_modules";
	return join(nodeModules, pluginName);
}

/**
 * Get all installed plugins with their info
 */
export async function getInstalledPlugins(global = true): Promise<Map<string, PluginPackageJson>> {
	const pluginsJson = await loadPluginsJson(global);
	const plugins = new Map<string, PluginPackageJson>();

	for (const name of Object.keys(pluginsJson.plugins)) {
		const pkgJson = await readPluginPackageJson(name, global);
		if (pkgJson) {
			plugins.set(name, pkgJson);
		}
	}

	return plugins;
}
