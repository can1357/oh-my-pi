import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	GLOBAL_PACKAGE_JSON,
	LEGACY_MANIFEST_PATH,
	NODE_MODULES_DIR,
	PLUGINS_DIR,
	PROJECT_PLUGINS_JSON,
} from "@omp/paths";

/**
 * OMP field in package.json - defines what files to install
 */
export interface OmpInstallEntry {
	src: string;
	dest: string;
}

export interface OmpField {
	install?: OmpInstallEntry[];
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
 * Global/project plugins.json structure
 */
export interface PluginsJson {
	plugins: Record<string, string>; // name -> version specifier
	devDependencies?: Record<string, string>; // dev dependencies
	disabled?: string[]; // disabled plugin names
}

/**
 * Legacy manifest structure (for migration)
 */
export interface LegacyPluginInfo {
	type: "github" | "local" | "npm";
	repo?: string;
	package?: string;
	path?: string;
	subdir?: string;
	version?: string;
	linked?: boolean;
	installed: string[];
	installedAt: string;
}

export interface LegacyManifest {
	plugins: Record<string, LegacyPluginInfo>;
}

/**
 * Initialize the global plugins directory with package.json
 */
export async function initGlobalPlugins(): Promise<void> {
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
			};
		}

		// Project uses plugins.json format
		return {
			plugins: parsed.plugins || {},
			devDependencies: parsed.devDependencies || {},
			disabled: parsed.disabled || [],
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { plugins: {}, devDependencies: {}, disabled: [] };
		}
		throw err;
	}
}

/**
 * Save plugins.json (global or project)
 */
export async function savePluginsJson(data: PluginsJson, global = true): Promise<void> {
	const path = global ? GLOBAL_PACKAGE_JSON : PROJECT_PLUGINS_JSON;
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
		if (data.disabled?.length) {
			existing.omp = { ...((existing.omp as Record<string, unknown>) || {}), disabled: data.disabled };
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
		await writeFile(path, JSON.stringify(output, null, 2));
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
 * Check if legacy manifest.json exists
 */
export function hasLegacyManifest(): boolean {
	return existsSync(LEGACY_MANIFEST_PATH);
}

/**
 * Load legacy manifest.json
 */
export async function loadLegacyManifest(): Promise<LegacyManifest> {
	try {
		const data = await readFile(LEGACY_MANIFEST_PATH, "utf-8");
		return JSON.parse(data) as LegacyManifest;
	} catch {
		return { plugins: {} };
	}
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
