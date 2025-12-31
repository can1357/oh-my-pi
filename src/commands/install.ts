import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Conflict, detectConflicts, detectIntraPluginDuplicates, formatConflicts } from "@omp/conflicts";
import { updateLockFile } from "@omp/lockfile";
import {
	getInstalledPlugins,
	initGlobalPlugins,
	initProjectPlugins,
	loadPluginsJson,
	type PluginConfig,
	type PluginPackageJson,
	readPluginPackageJson,
	savePluginsJson,
} from "@omp/manifest";
import { npmInfo, npmInstall } from "@omp/npm";
import { log, outputJson, setJsonMode } from "@omp/output";
import {
	getProjectPiDir,
	NODE_MODULES_DIR,
	PI_CONFIG_DIR,
	PLUGINS_DIR,
	PROJECT_NODE_MODULES,
	resolveScope,
} from "@omp/paths";
import { createPluginSymlinks, getAllFeatureNames, getDefaultFeatures } from "@omp/symlinks";
import chalk from "chalk";

/**
 * Parsed package specifier with optional features
 */
export interface ParsedPackageSpec {
	name: string;
	version: string;
	/** null = not specified, [] = explicit empty, string[] = specific features */
	features: string[] | null;
	/** true if [*] was used */
	allFeatures: boolean;
}

/**
 * Parse package specifier with optional features bracket syntax.
 * Examples:
 *   "exa" -> { name: "exa", version: "latest", features: null }
 *   "exa@^1.0" -> { name: "exa", version: "^1.0", features: null }
 *   "exa[search]" -> { name: "exa", version: "latest", features: ["search"] }
 *   "exa[search,websets]@^1.0" -> { name: "exa", version: "^1.0", features: ["search", "websets"] }
 *   "@scope/exa[*]" -> { name: "@scope/exa", version: "latest", allFeatures: true }
 *   "exa[]" -> { name: "exa", version: "latest", features: [] } (no optional features)
 */
export function parsePackageSpecWithFeatures(spec: string): ParsedPackageSpec {
	// Regex breakdown:
	// ^(@?[^@[\]]+)  - Capture name (optionally scoped with @, no @ [ or ] in name)
	// (?:\[([^\]]*)\])?  - Optionally capture features inside []
	// (?:@(.+))?$  - Optionally capture version after @
	const match = spec.match(/^(@?[^@[\]]+)(?:\[([^\]]*)\])?(?:@(.+))?$/);

	if (!match) {
		// Fallback: treat as plain name
		return {
			name: spec,
			version: "latest",
			features: null,
			allFeatures: false,
		};
	}

	const [, name, featuresStr, version = "latest"] = match;

	// No bracket at all
	if (featuresStr === undefined) {
		return { name, version, features: null, allFeatures: false };
	}

	// [*] = all features
	if (featuresStr === "*") {
		return { name, version, features: null, allFeatures: true };
	}

	// [] = explicit empty (no optional features, core only)
	if (featuresStr === "") {
		return { name, version, features: [], allFeatures: false };
	}

	// [f1,f2,...] = specific features
	const features = featuresStr
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	return { name, version, features, allFeatures: false };
}

/**
 * Resolve which features to enable based on user request, existing config, and plugin defaults.
 *
 * Resolution order:
 * 1. User explicitly requested [*] -> all features
 * 2. User explicitly specified [f1,f2] -> exactly those features
 * 3. Reinstall with no bracket -> preserve existing selection
 * 4. First install with no bracket -> ALL features
 */
export function resolveFeatures(
	pkgJson: PluginPackageJson,
	requested: ParsedPackageSpec,
	existingConfig: PluginConfig | undefined,
	isReinstall: boolean,
): { enabledFeatures: string[]; configToStore: PluginConfig | undefined } {
	const pluginFeatures = pkgJson.omp?.features || {};
	const allFeatureNames = Object.keys(pluginFeatures);

	// No features defined in plugin -> nothing to configure
	if (allFeatureNames.length === 0) {
		return { enabledFeatures: [], configToStore: undefined };
	}

	// Case 1: User explicitly requested [*] -> all features
	if (requested.allFeatures) {
		return {
			enabledFeatures: allFeatureNames,
			configToStore: { features: ["*"] },
		};
	}

	// Case 2: User explicitly specified features -> use exactly those
	if (requested.features !== null) {
		// Validate requested features exist
		for (const f of requested.features) {
			if (!pluginFeatures[f]) {
				throw new Error(`Unknown feature "${f}". Available: ${allFeatureNames.join(", ")}`);
			}
		}
		return {
			enabledFeatures: requested.features,
			configToStore: { features: requested.features },
		};
	}

	// Case 3: Reinstall with no bracket -> preserve existing config
	if (isReinstall && existingConfig?.features !== undefined) {
		const storedFeatures = existingConfig.features;

		// null means "first install, used defaults" - recompute defaults in case plugin updated
		if (storedFeatures === null) {
			return {
				enabledFeatures: getDefaultFeatures(pluginFeatures),
				configToStore: undefined, // Keep existing
			};
		}

		// ["*"] means explicitly all
		if (Array.isArray(storedFeatures) && storedFeatures.includes("*")) {
			return {
				enabledFeatures: allFeatureNames,
				configToStore: undefined,
			};
		}

		// Specific features
		return {
			enabledFeatures: storedFeatures as string[],
			configToStore: undefined,
		};
	}

	// Case 4: First install with no bracket -> use DEFAULT features
	if (!isReinstall) {
		const defaultFeatures = getDefaultFeatures(pluginFeatures);
		return {
			enabledFeatures: defaultFeatures,
			configToStore: { features: null }, // null = "first install, used defaults"
		};
	}

	// Case 5: Reinstall, no existing config -> use defaults
	return {
		enabledFeatures: getDefaultFeatures(pluginFeatures),
		configToStore: undefined,
	};
}

/**
 * Process omp dependencies recursively with cycle detection.
 * Creates symlinks for dependencies that have omp.install entries.
 */
async function processOmpDependencies(pkgJson: PluginPackageJson, isGlobal: boolean, seen: Set<string>): Promise<void> {
	if (!pkgJson.dependencies) return;

	for (const depName of Object.keys(pkgJson.dependencies)) {
		if (seen.has(depName)) {
			log(chalk.yellow(`  Skipping circular dependency: ${depName}`));
			continue;
		}
		seen.add(depName);

		const depPkgJson = await readPluginPackageJson(depName, isGlobal);
		if (depPkgJson?.omp?.install) {
			log(chalk.dim(`  Processing dependency: ${depName}`));
			await createPluginSymlinks(depName, depPkgJson, isGlobal);
			// Recurse into this dependency's dependencies
			await processOmpDependencies(depPkgJson, isGlobal, seen);
		}
	}
}

export interface InstallOptions {
	global?: boolean;
	local?: boolean;
	save?: boolean;
	saveDev?: boolean;
	force?: boolean;
	json?: boolean;
}

/**
 * Prompt user to choose when there's a conflict
 */
async function promptConflictResolution(conflict: Conflict): Promise<number | null> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		log(chalk.yellow(`\n⚠ Conflict: ${formatConflicts([conflict])[0]}`));
		conflict.plugins.forEach((p, i) => {
			log(`  [${i + 1}] ${p.name}`);
		});
		log(`  [${conflict.plugins.length + 1}] abort`);

		rl.question("  Choose: ", (answer) => {
			rl.close();
			const choice = parseInt(answer, 10);
			if (choice > 0 && choice <= conflict.plugins.length) {
				resolve(choice - 1);
			} else {
				resolve(null);
			}
		});
	});
}

/**
 * Check if a path looks like a local path
 */
function isLocalPath(spec: string): boolean {
	return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~");
}

/**
 * Install plugins from package specifiers
 * omp install [pkg...]
 */
export async function installPlugin(packages?: string[], options: InstallOptions = {}): Promise<void> {
	// Enable JSON mode early so all human output is suppressed
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const prefix = isGlobal ? PLUGINS_DIR : getProjectPiDir();
	const _nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	// Initialize plugins directory if needed
	if (isGlobal) {
		await initGlobalPlugins();
	} else {
		// Initialize project .pi directory with both plugins.json and package.json
		await initProjectPlugins();
	}

	// If no packages specified, install from plugins.json
	if (!packages || packages.length === 0) {
		const pluginsJson = await loadPluginsJson(isGlobal);
		// Prefer locked versions for reproducible installs
		const lockFile = await import("@omp/lockfile").then((m) => m.loadLockFile(isGlobal));
		packages = await Promise.all(
			Object.entries(pluginsJson.plugins).map(async ([name, version]) => {
				// Use locked version if available for reproducibility
				const lockedVersion = lockFile?.packages[name]?.version;
				return `${name}@${lockedVersion || version}`;
			}),
		);

		if (packages.length === 0) {
			log(chalk.yellow("No plugins to install."));
			log(chalk.dim(isGlobal ? "Add plugins with: omp install <package>" : "Add plugins to .pi/plugins.json"));
			process.exitCode = 1;
			return;
		}

		log(chalk.blue(`Installing ${packages.length} plugin(s) from ${isGlobal ? "package.json" : "plugins.json"}...`));
	}

	// Get existing plugins for conflict detection
	const existingPlugins = await getInstalledPlugins(isGlobal);

	const results: Array<{
		name: string;
		version: string;
		success: boolean;
		error?: string;
	}> = [];

	// Load plugins.json once for reinstall detection and config storage
	let pluginsJson = await loadPluginsJson(isGlobal);

	for (const spec of packages) {
		// Check if it's a local path
		if (isLocalPath(spec)) {
			const result = await installLocalPlugin(spec, isGlobal, options);
			results.push(result);
			continue;
		}

		const parsed = parsePackageSpecWithFeatures(spec);
		const { name, version } = parsed;
		const pkgSpec = version === "latest" ? name : `${name}@${version}`;

		// Track installation state for rollback
		let npmInstallSucceeded = false;
		let createdSymlinks: string[] = [];
		let resolvedVersion = version;

		// Check if this is a reinstall (plugin already exists)
		const isReinstall = existingPlugins.has(name) || !!pluginsJson.plugins[name];
		const existingConfig = pluginsJson.config?.[name];

		// Pending manifest changes (committed only on full success)
		let pendingPluginEntry: { name: string; version: string; isDev: boolean } | null = null;
		let pendingConfig: PluginConfig | null = null;
		let pendingLockUpdate: { name: string; version: string } | null = null;

		try {
			log(chalk.blue(`\nInstalling ${pkgSpec}...`));

			// 1. Resolve version and fetch package metadata from npm registry
			// npm info includes omp field if present in package.json
			const info = await npmInfo(pkgSpec);
			if (!info) {
				log(chalk.red(`  ✗ Package not found: ${name}`));
				process.exitCode = 1;
				results.push({
					name,
					version,
					success: false,
					error: "Package not found",
				});
				continue;
			}
			resolvedVersion = info.version;

			// 2. Check for conflicts BEFORE npm install using registry metadata
			const skipDestinations = new Set<string>();
			const preInstallPkgJson = info.omp?.install ? { name: info.name, version: info.version, omp: info.omp } : null;

			if (preInstallPkgJson) {
				// Check for intra-plugin duplicates first
				const intraDupes = detectIntraPluginDuplicates(preInstallPkgJson);
				if (intraDupes.length > 0) {
					log(chalk.red(`  ✗ Plugin has duplicate destinations:`));
					for (const dupe of intraDupes) {
						log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
					}
					process.exitCode = 1;
					results.push({
						name,
						version: info.version,
						success: false,
						error: "Duplicate destinations in plugin",
					});
					continue;
				}

				const preInstallConflicts = detectConflicts(name, preInstallPkgJson, existingPlugins);

				if (preInstallConflicts.length > 0 && !options.force) {
					// Check for non-interactive terminal (CI environments)
					if (!process.stdout.isTTY || !process.stdin.isTTY) {
						log(chalk.red("Conflicts detected in non-interactive mode. Use --force to override."));
						for (const conflict of preInstallConflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts in non-interactive mode",
						});
						continue;
					}

					// Handle conflicts BEFORE downloading the package
					let abort = false;
					for (const conflict of preInstallConflicts) {
						const choice = await promptConflictResolution(conflict);
						if (choice === null) {
							abort = true;
							break;
						}
						// choice is 0-indexed: 0 = first plugin (existing), last index = new plugin
						const newPluginIndex = conflict.plugins.length - 1;
						if (choice !== newPluginIndex) {
							// User chose an existing plugin, skip this destination
							skipDestinations.add(conflict.dest);
						}
					}

					if (abort) {
						log(chalk.yellow(`  Aborted due to conflicts (before download)`));
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts",
						});
						continue;
					}
				}
			}

			// 3. npm install - only reached if no conflicts or user resolved them
			log(chalk.dim(`  Fetching from npm...`));
			await npmInstall([pkgSpec], prefix, { save: options.save || isGlobal });
			npmInstallSucceeded = true;

			// 4. Read package.json from installed package
			const pkgJson = await readPluginPackageJson(name, isGlobal);
			if (!pkgJson) {
				log(chalk.yellow(`  ⚠ Installed but no package.json found`));
				results.push({ name, version: info.version, success: true });
				continue;
			}

			// 5. Re-check conflicts with full package.json if we didn't check pre-install
			// This handles edge cases where omp field wasn't in registry metadata
			if (!preInstallPkgJson) {
				// Check for intra-plugin duplicates first
				const intraDupes = detectIntraPluginDuplicates(pkgJson);
				if (intraDupes.length > 0) {
					log(chalk.red(`  ✗ Plugin has duplicate destinations:`));
					for (const dupe of intraDupes) {
						log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
					}
					// Rollback: uninstall the package
					execFileSync("npm", ["uninstall", "--prefix", prefix, name], {
						stdio: "pipe",
					});
					process.exitCode = 1;
					results.push({
						name,
						version: info.version,
						success: false,
						error: "Duplicate destinations in plugin",
					});
					continue;
				}

				const conflicts = detectConflicts(name, pkgJson, existingPlugins);

				if (conflicts.length > 0 && !options.force) {
					// Check for non-interactive terminal (CI environments)
					if (!process.stdout.isTTY || !process.stdin.isTTY) {
						log(chalk.red("Conflicts detected in non-interactive mode. Use --force to override."));
						for (const conflict of conflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", prefix, name], {
							stdio: "pipe",
						});
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts in non-interactive mode",
						});
						continue;
					}

					let abort = false;
					for (const conflict of conflicts) {
						const choice = await promptConflictResolution(conflict);
						if (choice === null) {
							abort = true;
							break;
						}
						const newPluginIndex = conflict.plugins.length - 1;
						if (choice !== newPluginIndex) {
							skipDestinations.add(conflict.dest);
						}
					}

					if (abort) {
						log(chalk.yellow(`  Aborted due to conflicts`));
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", prefix, name], {
							stdio: "pipe",
						});
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts",
						});
						continue;
					}
				}
			}

			// 6. Resolve features and create symlinks
			const { enabledFeatures, configToStore } = resolveFeatures(pkgJson, parsed, existingConfig, isReinstall);

			// Log feature selection if plugin has features
			const allFeatureNames = getAllFeatureNames(pkgJson);
			if (allFeatureNames.length > 0) {
				if (enabledFeatures.length === allFeatureNames.length) {
					log(chalk.dim(`  Features: all (${enabledFeatures.join(", ")})`));
				} else if (enabledFeatures.length === 0) {
					log(chalk.dim(`  Features: none (core only)`));
				} else {
					log(chalk.dim(`  Features: ${enabledFeatures.join(", ")}`));
				}
			}

			// Create symlinks for omp.install entries (skip destinations user assigned to existing plugins)
			const symlinkResult = await createPluginSymlinks(
				name,
				pkgJson,
				isGlobal,
				true,
				skipDestinations,
				enabledFeatures,
			);
			createdSymlinks = symlinkResult.created;

			// 7. Process dependencies with omp field (with cycle detection)
			await processOmpDependencies(pkgJson, isGlobal, new Set([name]));

			// 8. Stage manifest and config changes (written only after full success)
			// For global mode, npm --save already updates package.json dependencies
			// but we need to handle devDependencies and config manually
			// For project-local mode, we must manually update plugins.json
			if (options.save || options.saveDev || configToStore) {
				if (options.saveDev) {
					pendingPluginEntry = { name, version: info.version, isDev: true };
				} else if (!isGlobal) {
					pendingPluginEntry = { name, version: info.version, isDev: false };
				}

				if (configToStore) {
					pendingConfig = configToStore;
				}
			}

			// Stage lock file update
			pendingLockUpdate = { name, version: info.version };

			// Add to installed plugins map for subsequent conflict detection
			existingPlugins.set(name, pkgJson);

			// 9. Commit all manifest changes atomically after all operations succeeded
			// This ensures plugins.json is only written if npm install + symlinks both succeeded
			if (pendingPluginEntry || pendingConfig) {
				// Reload to avoid stale data if multiple packages are being installed
				pluginsJson = await loadPluginsJson(isGlobal);

				if (pendingPluginEntry) {
					if (pendingPluginEntry.isDev) {
						if (!pluginsJson.devDependencies) {
							pluginsJson.devDependencies = {};
						}
						pluginsJson.devDependencies[pendingPluginEntry.name] = pendingPluginEntry.version;
						delete pluginsJson.plugins[pendingPluginEntry.name];
					} else {
						pluginsJson.plugins[pendingPluginEntry.name] = pendingPluginEntry.version;
					}
				}

				if (pendingConfig) {
					if (!pluginsJson.config) {
						pluginsJson.config = {};
					}
					pluginsJson.config[name] = {
						...pluginsJson.config[name],
						...pendingConfig,
					};
				}

				await savePluginsJson(pluginsJson, isGlobal);
			}

			// Update lock file with exact version (after manifest is committed)
			if (pendingLockUpdate) {
				await updateLockFile(pendingLockUpdate.name, pendingLockUpdate.version, isGlobal);
			}

			log(chalk.green(`✓ Installed ${name}@${info.version}`));
			results.push({ name, version: info.version, success: true });
		} catch (err) {
			const errorMsg = (err as Error).message;
			log(chalk.red(`  ✗ Failed to install ${name}: ${errorMsg}`));

			// Rollback: remove any symlinks that were created
			if (createdSymlinks.length > 0) {
				log(chalk.dim("  Rolling back symlinks..."));
				const baseDir = isGlobal ? PI_CONFIG_DIR : getProjectPiDir();
				for (const dest of createdSymlinks) {
					try {
						await rm(join(baseDir, dest), { force: true, recursive: true });
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			// Rollback: uninstall npm package if it was installed
			if (npmInstallSucceeded) {
				log(chalk.dim("  Rolling back npm install..."));
				try {
					execFileSync("npm", ["uninstall", "--prefix", prefix, name], {
						stdio: "pipe",
					});
				} catch {
					// Ignore cleanup errors
				}
			}

			process.exitCode = 1;
			results.push({
				name,
				version: resolvedVersion,
				success: false,
				error: errorMsg,
			});
		}
	}

	// Summary
	const successful = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	log();
	if (successful.length > 0) {
		log(chalk.green(`✓ Installed ${successful.length} plugin(s)`));
	}
	if (failed.length > 0) {
		log(chalk.red(`✗ Failed to install ${failed.length} plugin(s)`));
		process.exitCode = 1;
	}

	if (options.json) {
		outputJson({ results });
	}
}

/**
 * Install a local plugin (copy or link based on path type)
 */
async function installLocalPlugin(
	localPath: string,
	isGlobal: boolean,
	_options: InstallOptions,
): Promise<{
	name: string;
	version: string;
	success: boolean;
	error?: string;
}> {
	// Expand ~ to home directory
	if (localPath.startsWith("~")) {
		localPath = join(process.env.HOME || "", localPath.slice(1));
	}
	localPath = resolve(localPath);

	if (!existsSync(localPath)) {
		log(chalk.red(`Error: Path does not exist: ${localPath}`));
		process.exitCode = 1;
		return {
			name: basename(localPath),
			version: "local",
			success: false,
			error: "Path not found",
		};
	}

	const _prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	try {
		// Read package.json from local path
		const localPkgJsonPath = join(localPath, "package.json");
		let pkgJson: PluginPackageJson;

		if (existsSync(localPkgJsonPath)) {
			pkgJson = JSON.parse(await readFile(localPkgJsonPath, "utf-8"));
		} else {
			// Check for omp.json (legacy format)
			const ompJsonPath = join(localPath, "omp.json");
			if (existsSync(ompJsonPath)) {
				const ompJson = JSON.parse(await readFile(ompJsonPath, "utf-8"));
				// Convert omp.json to package.json format
				pkgJson = {
					name: ompJson.name || basename(localPath),
					version: ompJson.version || "0.0.0",
					description: ompJson.description,
					keywords: ["omp-plugin"],
					omp: {
						install: ompJson.install,
					},
				};
			} else {
				pkgJson = {
					name: basename(localPath),
					version: "0.0.0",
					keywords: ["omp-plugin"],
				};
			}
		}

		const pluginName = pkgJson.name;
		const pluginDir = join(nodeModules, pluginName);

		// Check for intra-plugin duplicates
		const intraDupes = detectIntraPluginDuplicates(pkgJson);
		if (intraDupes.length > 0) {
			log(chalk.red(`\nError: Plugin has duplicate destinations:`));
			for (const dupe of intraDupes) {
				log(chalk.red(`  ${dupe.dest} ← ${dupe.sources.join(", ")}`));
			}
			process.exitCode = 1;
			return {
				name: pluginName,
				version: pkgJson.version,
				success: false,
				error: "Duplicate destinations in plugin",
			};
		}

		log(chalk.blue(`\nInstalling ${pluginName} from ${localPath}...`));

		// Create node_modules directory
		await mkdir(nodeModules, { recursive: true });

		// Remove existing if present
		if (existsSync(pluginDir)) {
			await rm(pluginDir, { recursive: true, force: true });
		}

		// Copy the plugin
		await cp(localPath, pluginDir, { recursive: true });
		log(chalk.dim(`  Copied to ${pluginDir}`));

		// Update plugins.json/package.json
		const pluginsJson = await loadPluginsJson(isGlobal);
		if (_options.saveDev) {
			if (!pluginsJson.devDependencies) {
				pluginsJson.devDependencies = {};
			}
			pluginsJson.devDependencies[pluginName] = `file:${localPath}`;
			// Remove from plugins if it was there
			delete pluginsJson.plugins[pluginName];
		} else {
			pluginsJson.plugins[pluginName] = `file:${localPath}`;
		}
		await savePluginsJson(pluginsJson, isGlobal);

		// Create symlinks
		await createPluginSymlinks(pluginName, pkgJson, isGlobal);

		// Update lock file for local plugin
		await updateLockFile(pluginName, pkgJson.version, isGlobal);

		log(chalk.green(`✓ Installed ${pluginName}@${pkgJson.version}`));
		return { name: pluginName, version: pkgJson.version, success: true };
	} catch (err) {
		const errorMsg = (err as Error).message;
		log(chalk.red(`  ✗ Failed: ${errorMsg}`));
		process.exitCode = 1;
		return {
			name: basename(localPath),
			version: "local",
			success: false,
			error: errorMsg,
		};
	}
}
