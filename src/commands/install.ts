import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Conflict, detectConflicts, detectIntraPluginDuplicates, formatConflicts } from "@omp/conflicts";
import {
	getInstalledPlugins,
	initGlobalPlugins,
	loadPluginsJson,
	type PluginPackageJson,
	readPluginPackageJson,
	savePluginsJson,
} from "@omp/manifest";
import { npmInfo, npmInstall } from "@omp/npm";
import {
	NODE_MODULES_DIR,
	PI_CONFIG_DIR,
	PLUGINS_DIR,
	PROJECT_NODE_MODULES,
	PROJECT_PI_DIR,
	PROJECT_PLUGINS_JSON,
	resolveScope,
} from "@omp/paths";
import { createPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

/**
 * Process omp dependencies recursively with cycle detection.
 * Creates symlinks for dependencies that have omp.install entries.
 */
async function processOmpDependencies(
	pkgJson: PluginPackageJson,
	isGlobal: boolean,
	seen: Set<string>,
): Promise<void> {
	if (!pkgJson.dependencies) return;

	for (const depName of Object.keys(pkgJson.dependencies)) {
		if (seen.has(depName)) {
			console.log(chalk.yellow(`  Skipping circular dependency: ${depName}`));
			continue;
		}
		seen.add(depName);

		const depPkgJson = await readPluginPackageJson(depName, isGlobal);
		if (depPkgJson?.omp?.install) {
			console.log(chalk.dim(`  Processing dependency: ${depName}`));
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
		console.log(chalk.yellow(`\n⚠ Conflict: ${formatConflicts([conflict])[0]}`));
		conflict.plugins.forEach((p, i) => {
			console.log(`  [${i + 1}] ${p.name}`);
		});
		console.log(`  [${conflict.plugins.length + 1}] abort`);

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
 * Parse package specifier into name and version
 */
function parsePackageSpec(spec: string): { name: string; version: string } {
	// Handle scoped packages: @scope/name@version
	if (spec.startsWith("@")) {
		const lastAt = spec.lastIndexOf("@");
		if (lastAt > 0) {
			return {
				name: spec.slice(0, lastAt),
				version: spec.slice(lastAt + 1),
			};
		}
		return { name: spec, version: "latest" };
	}

	// Handle regular packages: name@version
	const atIndex = spec.indexOf("@");
	if (atIndex > 0) {
		return {
			name: spec.slice(0, atIndex),
			version: spec.slice(atIndex + 1),
		};
	}

	return { name: spec, version: "latest" };
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
	const isGlobal = resolveScope(options);
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const _nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	// Initialize plugins directory if needed
	if (isGlobal) {
		await initGlobalPlugins();
	} else {
		// Ensure project .pi directory exists
		await mkdir(prefix, { recursive: true });
		// Initialize plugins.json if it doesn't exist
		if (!existsSync(PROJECT_PLUGINS_JSON)) {
			await savePluginsJson({ plugins: {} }, false);
		}
	}

	// If no packages specified, install from plugins.json
	if (!packages || packages.length === 0) {
		const pluginsJson = await loadPluginsJson(isGlobal);
		packages = Object.entries(pluginsJson.plugins).map(([name, version]) => `${name}@${version}`);

		if (packages.length === 0) {
			console.log(chalk.yellow("No plugins to install."));
			console.log(
				chalk.dim(isGlobal ? "Add plugins with: omp install <package>" : "Add plugins to .pi/plugins.json"),
			);
			process.exitCode = 1;
			return;
		}

		console.log(
			chalk.blue(`Installing ${packages.length} plugin(s) from ${isGlobal ? "package.json" : "plugins.json"}...`),
		);
	}

	// Get existing plugins for conflict detection
	const existingPlugins = await getInstalledPlugins(isGlobal);

	const results: Array<{ name: string; version: string; success: boolean; error?: string }> = [];

	for (const spec of packages) {
		// Check if it's a local path
		if (isLocalPath(spec)) {
			const result = await installLocalPlugin(spec, isGlobal, options);
			results.push(result);
			continue;
		}

		const { name, version } = parsePackageSpec(spec);
		const pkgSpec = version === "latest" ? name : `${name}@${version}`;

		// Track installation state for rollback
		let npmInstallSucceeded = false;
		let createdSymlinks: string[] = [];
		let resolvedVersion = version;

		try {
			console.log(chalk.blue(`\nInstalling ${pkgSpec}...`));

			// 1. Resolve version and fetch package metadata from npm registry
			// npm info includes omp field if present in package.json
			const info = await npmInfo(pkgSpec);
			if (!info) {
				console.log(chalk.red(`  ✗ Package not found: ${name}`));
				process.exitCode = 1;
				results.push({ name, version, success: false, error: "Package not found" });
				continue;
			}
			resolvedVersion = info.version;

			// 2. Check for conflicts BEFORE npm install using registry metadata
			const skipDestinations = new Set<string>();
			const preInstallPkgJson = info.omp?.install
				? { name: info.name, version: info.version, omp: info.omp }
				: null;

			if (preInstallPkgJson) {
				// Check for intra-plugin duplicates first
				const intraDupes = detectIntraPluginDuplicates(preInstallPkgJson);
				if (intraDupes.length > 0) {
					console.log(chalk.red(`  ✗ Plugin has duplicate destinations:`));
					for (const dupe of intraDupes) {
						console.log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
					}
					process.exitCode = 1;
					results.push({ name, version: info.version, success: false, error: "Duplicate destinations in plugin" });
					continue;
				}

				const preInstallConflicts = detectConflicts(name, preInstallPkgJson, existingPlugins);

				if (preInstallConflicts.length > 0 && !options.force) {
					// Check for non-interactive terminal (CI environments)
					if (!process.stdout.isTTY || !process.stdin.isTTY) {
						console.log(chalk.red("Conflicts detected in non-interactive mode. Use --force to override."));
						for (const conflict of preInstallConflicts) {
							console.log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						process.exitCode = 1;
						results.push({ name, version: info.version, success: false, error: "Conflicts in non-interactive mode" });
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
						console.log(chalk.yellow(`  Aborted due to conflicts (before download)`));
						process.exitCode = 1;
						results.push({ name, version: info.version, success: false, error: "Conflicts" });
						continue;
					}
				}
			}

			// 3. npm install - only reached if no conflicts or user resolved them
			console.log(chalk.dim(`  Fetching from npm...`));
			await npmInstall([pkgSpec], prefix, { save: options.save || isGlobal });
			npmInstallSucceeded = true;

			// 4. Read package.json from installed package
			const pkgJson = await readPluginPackageJson(name, isGlobal);
			if (!pkgJson) {
				console.log(chalk.yellow(`  ⚠ Installed but no package.json found`));
				results.push({ name, version: info.version, success: true });
				continue;
			}

			// 5. Re-check conflicts with full package.json if we didn't check pre-install
			// This handles edge cases where omp field wasn't in registry metadata
			if (!preInstallPkgJson) {
				// Check for intra-plugin duplicates first
				const intraDupes = detectIntraPluginDuplicates(pkgJson);
				if (intraDupes.length > 0) {
					console.log(chalk.red(`  ✗ Plugin has duplicate destinations:`));
					for (const dupe of intraDupes) {
						console.log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
					}
					// Rollback: uninstall the package
					execFileSync("npm", ["uninstall", "--prefix", prefix, name], { stdio: "pipe" });
					process.exitCode = 1;
					results.push({ name, version: info.version, success: false, error: "Duplicate destinations in plugin" });
					continue;
				}

				const conflicts = detectConflicts(name, pkgJson, existingPlugins);

				if (conflicts.length > 0 && !options.force) {
					// Check for non-interactive terminal (CI environments)
					if (!process.stdout.isTTY || !process.stdin.isTTY) {
						console.log(chalk.red("Conflicts detected in non-interactive mode. Use --force to override."));
						for (const conflict of conflicts) {
							console.log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", prefix, name], { stdio: "pipe" });
						process.exitCode = 1;
						results.push({ name, version: info.version, success: false, error: "Conflicts in non-interactive mode" });
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
						console.log(chalk.yellow(`  Aborted due to conflicts`));
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", prefix, name], { stdio: "pipe" });
						process.exitCode = 1;
						results.push({ name, version: info.version, success: false, error: "Conflicts" });
						continue;
					}
				}
			}

			// 6. Create symlinks for omp.install entries (skip destinations user assigned to existing plugins)
			const symlinkResult = await createPluginSymlinks(name, pkgJson, isGlobal, true, skipDestinations);
			createdSymlinks = symlinkResult.created;

			// 7. Process dependencies with omp field (with cycle detection)
			await processOmpDependencies(pkgJson, isGlobal, new Set([name]));

			// 8. Update manifest if --save or --save-dev was passed
			// For global mode, npm --save already updates package.json dependencies
			// but we need to handle devDependencies manually
			// For project-local mode, we must manually update plugins.json
			if (options.save || options.saveDev) {
				const pluginsJson = await loadPluginsJson(isGlobal);
				if (options.saveDev) {
					// Save to devDependencies
					if (!pluginsJson.devDependencies) {
						pluginsJson.devDependencies = {};
					}
					pluginsJson.devDependencies[name] = info.version;
					// Remove from plugins if it was there
					delete pluginsJson.plugins[name];
				} else if (!isGlobal) {
					// Save to plugins (project-local mode only - npm handles global)
					pluginsJson.plugins[name] = info.version;
				}
				await savePluginsJson(pluginsJson, isGlobal);
			}

			// Add to installed plugins map for subsequent conflict detection
			existingPlugins.set(name, pkgJson);

			console.log(chalk.green(`✓ Installed ${name}@${info.version}`));
			results.push({ name, version: info.version, success: true });
		} catch (err) {
			const errorMsg = (err as Error).message;
			console.log(chalk.red(`  ✗ Failed to install ${name}: ${errorMsg}`));

			// Rollback: remove any symlinks that were created
			if (createdSymlinks.length > 0) {
				console.log(chalk.dim("  Rolling back symlinks..."));
				const baseDir = isGlobal ? PI_CONFIG_DIR : PROJECT_PI_DIR;
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
				console.log(chalk.dim("  Rolling back npm install..."));
				try {
					execFileSync("npm", ["uninstall", "--prefix", prefix, name], { stdio: "pipe" });
				} catch {
					// Ignore cleanup errors
				}
			}

			process.exitCode = 1;
			results.push({ name, version: resolvedVersion, success: false, error: errorMsg });
		}
	}

	// Summary
	const successful = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	console.log();
	if (successful.length > 0) {
		console.log(chalk.green(`✓ Installed ${successful.length} plugin(s)`));
	}
	if (failed.length > 0) {
		console.log(chalk.red(`✗ Failed to install ${failed.length} plugin(s)`));
		process.exitCode = 1;
	}

	if (options.json) {
		console.log(JSON.stringify({ results }, null, 2));
	}
}

/**
 * Install a local plugin (copy or link based on path type)
 */
async function installLocalPlugin(
	localPath: string,
	isGlobal: boolean,
	_options: InstallOptions,
): Promise<{ name: string; version: string; success: boolean; error?: string }> {
	// Expand ~ to home directory
	if (localPath.startsWith("~")) {
		localPath = join(process.env.HOME || "", localPath.slice(1));
	}
	localPath = resolve(localPath);

	if (!existsSync(localPath)) {
		console.log(chalk.red(`Error: Path does not exist: ${localPath}`));
		process.exitCode = 1;
		return { name: basename(localPath), version: "local", success: false, error: "Path not found" };
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
			console.log(chalk.red(`\nError: Plugin has duplicate destinations:`));
			for (const dupe of intraDupes) {
				console.log(chalk.red(`  ${dupe.dest} ← ${dupe.sources.join(", ")}`));
			}
			process.exitCode = 1;
			return { name: pluginName, version: pkgJson.version, success: false, error: "Duplicate destinations in plugin" };
		}

		console.log(chalk.blue(`\nInstalling ${pluginName} from ${localPath}...`));

		// Create node_modules directory
		await mkdir(nodeModules, { recursive: true });

		// Remove existing if present
		if (existsSync(pluginDir)) {
			await rm(pluginDir, { recursive: true, force: true });
		}

		// Copy the plugin
		await cp(localPath, pluginDir, { recursive: true });
		console.log(chalk.dim(`  Copied to ${pluginDir}`));

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

		console.log(chalk.green(`✓ Installed ${pluginName}@${pkgJson.version}`));
		return { name: pluginName, version: pkgJson.version, success: true };
	} catch (err) {
		const errorMsg = (err as Error).message;
		console.log(chalk.red(`  ✗ Failed: ${errorMsg}`));
		process.exitCode = 1;
		return { name: basename(localPath), version: "local", success: false, error: errorMsg };
	}
}
