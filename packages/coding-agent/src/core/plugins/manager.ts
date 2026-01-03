import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractPackageName, parsePluginSpec } from "./parser";
import {
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectPluginOverrides,
} from "./paths";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";

// =============================================================================
// Validation
// =============================================================================

/** Valid npm package name pattern (scoped and unscoped, with optional version) */
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/**
 * Validate package name to prevent command injection.
 */
function validatePackageName(name: string): void {
	// Remove version specifier for validation
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

// =============================================================================
// Plugin Manager
// =============================================================================

export class PluginManager {
	private runtimeConfig: PluginRuntimeConfig;
	private cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
		this.runtimeConfig = this.loadRuntimeConfig();
	}

	// ==========================================================================
	// Runtime Config Management
	// ==========================================================================

	private loadRuntimeConfig(): PluginRuntimeConfig {
		const lockPath = getPluginsLockfile();
		if (!existsSync(lockPath)) {
			return { plugins: {}, settings: {} };
		}
		try {
			return JSON.parse(readFileSync(lockPath, "utf-8"));
		} catch {
			return { plugins: {}, settings: {} };
		}
	}

	private saveRuntimeConfig(): void {
		this.ensurePluginsDir();
		writeFileSync(getPluginsLockfile(), JSON.stringify(this.runtimeConfig, null, 2));
	}

	private loadProjectOverrides(): ProjectPluginOverrides {
		const overridesPath = getProjectPluginOverrides(this.cwd);
		if (!existsSync(overridesPath)) {
			return {};
		}
		try {
			return JSON.parse(readFileSync(overridesPath, "utf-8"));
		} catch {
			return {};
		}
	}

	// ==========================================================================
	// Directory Management
	// ==========================================================================

	private ensurePluginsDir(): void {
		const dir = getPluginsDir();
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const nodeModules = getPluginsNodeModules();
		if (!existsSync(nodeModules)) {
			mkdirSync(nodeModules, { recursive: true });
		}
	}

	private ensurePackageJson(): void {
		this.ensurePluginsDir();
		const pkgJsonPath = getPluginsPackageJson();
		if (!existsSync(pkgJsonPath)) {
			writeFileSync(
				pkgJsonPath,
				JSON.stringify(
					{
						name: "omp-plugins",
						private: true,
						dependencies: {},
					},
					null,
					2,
				),
			);
		}
	}

	// ==========================================================================
	// Install / Uninstall
	// ==========================================================================

	/**
	 * Install a plugin from npm with optional feature selection.
	 *
	 * @param specString - Package specifier with optional features: "pkg", "pkg[feat]", "pkg[*]", "pkg[]"
	 * @param options - Install options
	 * @returns Installed plugin metadata
	 */
	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		validatePackageName(spec.packageName);

		this.ensurePackageJson();

		if (options.dryRun) {
			return {
				name: spec.packageName,
				version: "0.0.0-dryrun",
				path: "",
				manifest: { version: "0.0.0-dryrun" },
				enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
				enabled: true,
			};
		}

		// Run npm install
		const proc = Bun.spawn(["npm", "install", spec.packageName], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`npm install failed: ${stderr}`);
		}

		// Resolve actual package name (strip version specifier)
		const actualName = extractPackageName(spec.packageName);
		const pkgPath = join(getPluginsNodeModules(), actualName, "package.json");

		if (!existsSync(pkgPath)) {
			throw new Error(`Package installed but package.json not found at ${pkgPath}`);
		}

		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const manifest: PluginManifest = pkg.omp || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		// Resolve enabled features
		let enabledFeatures: string[] | null = null;
		if (spec.features === "*") {
			// All features
			enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
		} else if (Array.isArray(spec.features)) {
			if (spec.features.length > 0) {
				// Validate requested features exist
				if (manifest.features) {
					for (const feat of spec.features) {
						if (!(feat in manifest.features)) {
							throw new Error(
								`Unknown feature "${feat}" in ${actualName}. Available: ${Object.keys(manifest.features).join(", ")}`,
							);
						}
					}
				}
				enabledFeatures = spec.features;
			} else {
				// Empty array = no optional features
				enabledFeatures = [];
			}
		}
		// null = use defaults

		// Update runtime config
		this.runtimeConfig.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures,
			enabled: true,
		};
		this.saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: join(getPluginsNodeModules(), actualName),
			manifest,
			enabledFeatures,
			enabled: true,
		};
	}

	/**
	 * Uninstall a plugin.
	 */
	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		this.ensurePackageJson();

		const proc = Bun.spawn(["npm", "uninstall", name], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`npm uninstall failed for ${name}`);
		}

		// Remove from runtime config
		delete this.runtimeConfig.plugins[name];
		delete this.runtimeConfig.settings[name];
		this.saveRuntimeConfig();
	}

	/**
	 * List all installed plugins.
	 */
	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		if (!existsSync(pkgJsonPath)) {
			return [];
		}

		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		const deps = pkg.dependencies || {};
		const projectOverrides = this.loadProjectOverrides();
		const plugins: InstalledPlugin[] = [];

		for (const [name] of Object.entries(deps)) {
			const pluginPkgPath = join(getPluginsNodeModules(), name, "package.json");
			if (existsSync(pluginPkgPath)) {
				const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, "utf-8"));
				const manifest: PluginManifest = pluginPkg.omp || pluginPkg.pi || { version: pluginPkg.version };
				manifest.version = pluginPkg.version;

				const runtimeState = this.runtimeConfig.plugins[name] || {
					version: pluginPkg.version,
					enabledFeatures: null,
					enabled: true,
				};

				// Apply project overrides
				const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;
				const projectFeatures = projectOverrides.features?.[name];

				plugins.push({
					name,
					version: pluginPkg.version,
					path: join(getPluginsNodeModules(), name),
					manifest,
					enabledFeatures: projectFeatures ?? runtimeState.enabledFeatures,
					enabled: runtimeState.enabled && !isDisabledInProject,
				});
			}
		}

		return plugins;
	}

	/**
	 * Link a local plugin for development.
	 */
	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = resolve(this.cwd, localPath);

		const pkgFile = join(absolutePath, "package.json");
		if (!existsSync(pkgFile)) {
			throw new Error(`package.json not found at ${absolutePath}`);
		}

		const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
		if (!pkg.name) {
			throw new Error("package.json must have a name field");
		}

		this.ensurePluginsDir();

		const linkPath = join(getPluginsNodeModules(), pkg.name);

		// Handle scoped packages
		if (pkg.name.startsWith("@")) {
			const scopeDir = join(getPluginsNodeModules(), pkg.name.split("/")[0]);
			if (!existsSync(scopeDir)) {
				mkdirSync(scopeDir, { recursive: true });
			}
		}

		// Remove existing
		try {
			const stat = lstatSync(linkPath);
			if (stat.isSymbolicLink() || stat.isDirectory()) {
				unlinkSync(linkPath);
			}
		} catch {
			// Doesn't exist
		}

		symlinkSync(absolutePath, linkPath);

		const manifest: PluginManifest = pkg.omp || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		// Add to runtime config
		this.runtimeConfig.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		this.saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	// ==========================================================================
	// Enable / Disable
	// ==========================================================================

	/**
	 * Enable or disable a plugin globally.
	 */
	async setEnabled(name: string, enabled: boolean): Promise<void> {
		if (!this.runtimeConfig.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}
		this.runtimeConfig.plugins[name].enabled = enabled;
		this.saveRuntimeConfig();
	}

	// ==========================================================================
	// Features
	// ==========================================================================

	/**
	 * Get enabled features for a plugin.
	 */
	getEnabledFeatures(name: string): string[] | null {
		return this.runtimeConfig.plugins[name]?.enabledFeatures ?? null;
	}

	/**
	 * Set enabled features for a plugin.
	 */
	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		if (!this.runtimeConfig.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}

		// Validate features if setting specific ones
		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find((p) => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`Unknown feature "${feat}" in ${name}. Available: ${Object.keys(plugin.manifest.features).join(", ")}`,
						);
					}
				}
			}
		}

		this.runtimeConfig.plugins[name].enabledFeatures = features;
		this.saveRuntimeConfig();
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	/**
	 * Get all settings for a plugin.
	 */
	getPluginSettings(name: string): Record<string, unknown> {
		const global = this.runtimeConfig.settings[name] || {};
		const projectOverrides = this.loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		// Project settings override global
		return { ...global, ...project };
	}

	/**
	 * Set a plugin setting value.
	 */
	setPluginSetting(name: string, key: string, value: unknown): void {
		if (!this.runtimeConfig.settings[name]) {
			this.runtimeConfig.settings[name] = {};
		}
		this.runtimeConfig.settings[name][key] = value;
		this.saveRuntimeConfig();
	}

	/**
	 * Delete a plugin setting.
	 */
	deletePluginSetting(name: string, key: string): void {
		if (this.runtimeConfig.settings[name]) {
			delete this.runtimeConfig.settings[name][key];
			this.saveRuntimeConfig();
		}
	}

	// ==========================================================================
	// Doctor
	// ==========================================================================

	/**
	 * Run health checks on the plugin system.
	 */
	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		// Check 1: Plugins directory exists
		const pluginsDir = getPluginsDir();
		checks.push({
			name: "plugins_directory",
			status: existsSync(pluginsDir) ? "ok" : "warning",
			message: existsSync(pluginsDir) ? `Found at ${pluginsDir}` : "Not created yet",
		});

		// Check 2: package.json exists
		const pkgJsonPath = getPluginsPackageJson();
		const hasPkgJson = existsSync(pkgJsonPath);
		checks.push({
			name: "package_manifest",
			status: hasPkgJson ? "ok" : "warning",
			message: hasPkgJson ? "Found" : "Not created yet",
		});

		// Check 3: node_modules exists
		const nodeModulesPath = getPluginsNodeModules();
		const hasNodeModules = existsSync(nodeModulesPath);
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : hasPkgJson ? "error" : "warning",
			message: hasNodeModules ? "Found" : "Missing (run npm install in plugins dir)",
		});

		if (!hasPkgJson) {
			return checks;
		}

		// Check each installed plugin
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		const deps = pkg.dependencies || {};

		for (const [name] of Object.entries(deps)) {
			const pluginPath = join(nodeModulesPath, name);
			const pluginPkgPath = join(pluginPath, "package.json");

			if (!existsSync(pluginPath)) {
				const fixed = options.fix ? await this.fixMissingPlugin() : false;
				checks.push({
					name: `plugin:${name}`,
					status: "error",
					message: "Missing from node_modules",
					fixed,
				});
				continue;
			}

			if (!existsSync(pluginPkgPath)) {
				checks.push({
					name: `plugin:${name}`,
					status: "error",
					message: "Missing package.json",
				});
				continue;
			}

			const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, "utf-8"));
			const hasManifest = !!(pluginPkg.omp || pluginPkg.pi);
			const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No omp/pi manifest (not an omp plugin)`,
			});

			// Check tools path exists if specified
			if (manifest?.tools) {
				const toolsPath = join(pluginPath, manifest.tools);
				if (!existsSync(toolsPath)) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			// Check hooks path exists if specified
			if (manifest?.hooks) {
				const hooksPath = join(pluginPath, manifest.hooks);
				if (!existsSync(hooksPath)) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			// Check enabled features exist in manifest
			const runtimeState = this.runtimeConfig.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? this.removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		// Check for orphaned runtime config entries
		for (const name of Object.keys(this.runtimeConfig.plugins)) {
			if (!(name in deps)) {
				const fixed = options.fix ? this.removeOrphanedConfig(name) : false;
				checks.push({
					name: `orphan:${name}`,
					status: "warning",
					message: "Plugin in config but not installed",
					fixed,
				});
			}
		}

		return checks;
	}

	private async fixMissingPlugin(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["npm", "install"], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			return (await proc.exited) === 0;
		} catch {
			return false;
		}
	}

	private removeInvalidFeature(name: string, feat: string): boolean {
		const state = this.runtimeConfig.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter((f) => f !== feat);
			this.saveRuntimeConfig();
			return true;
		}
		return false;
	}

	private removeOrphanedConfig(name: string): boolean {
		delete this.runtimeConfig.plugins[name];
		delete this.runtimeConfig.settings[name];
		this.saveRuntimeConfig();
		return true;
	}
}

// =============================================================================
// Setting Validation
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate a setting value against its schema.
 */
export function validateSetting(value: unknown, schema: PluginSettingSchema): ValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

/**
 * Parse a string value according to a setting schema's type.
 */
export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
