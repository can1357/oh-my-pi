import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { type Conflict, detectConflicts, formatConflicts } from "../conflicts.js";
import {
	getInstalledPlugins,
	initGlobalPlugins,
	loadPluginsJson,
	type PluginPackageJson,
	readPluginPackageJson,
	savePluginsJson,
} from "../manifest.js";
import { npmInfo, npmInstall } from "../npm.js";
import { NODE_MODULES_DIR, PLUGINS_DIR, PROJECT_NODE_MODULES, PROJECT_PLUGINS_JSON } from "../paths.js";
import { createPluginSymlinks } from "../symlinks.js";

export interface InstallOptions {
	global?: boolean;
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
	const isGlobal = options.global !== false; // Default to global
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

		try {
			console.log(chalk.blue(`\nInstalling ${pkgSpec}...`));

			// 1. Resolve version from npm registry
			const info = await npmInfo(pkgSpec);
			if (!info) {
				console.log(chalk.red(`  ✗ Package not found: ${name}`));
				results.push({ name, version, success: false, error: "Package not found" });
				continue;
			}

			// 2. Check for conflicts before installing
			// We need to fetch the package.json to check omp.install
			// For now, we'll check after npm install and rollback if needed

			// 3. npm install
			console.log(chalk.dim(`  Fetching from npm...`));
			await npmInstall([pkgSpec], prefix, { save: options.save || isGlobal });

			// 4. Read package.json from installed package
			const pkgJson = await readPluginPackageJson(name, isGlobal);
			if (!pkgJson) {
				console.log(chalk.yellow(`  ⚠ Installed but no package.json found`));
				results.push({ name, version: info.version, success: true });
				continue;
			}

			// 5. Check for conflicts
			const conflicts = detectConflicts(name, pkgJson, existingPlugins);

			if (conflicts.length > 0 && !options.force) {
				// Handle conflicts
				let abort = false;
				for (const conflict of conflicts) {
					const choice = await promptConflictResolution(conflict);
					if (choice === null) {
						abort = true;
						break;
					}
					// If user chose the new plugin, we continue
					// If user chose existing plugin, we skip this destination
					// For now, simplify: if not aborted, force overwrite
				}

				if (abort) {
					console.log(chalk.yellow(`  Aborted due to conflicts`));
					// Rollback: uninstall the package
					execSync(`npm uninstall --prefix ${prefix} ${name}`, { stdio: "pipe" });
					results.push({ name, version: info.version, success: false, error: "Conflicts" });
					continue;
				}
			}

			// 6. Create symlinks for omp.install entries
			const _symlinkResult = await createPluginSymlinks(name, pkgJson, isGlobal);

			// 7. Process dependencies with omp field
			if (pkgJson.dependencies) {
				for (const depName of Object.keys(pkgJson.dependencies)) {
					const depPkgJson = await readPluginPackageJson(depName, isGlobal);
					if (depPkgJson?.omp?.install) {
						console.log(chalk.dim(`  Processing dependency: ${depName}`));
						await createPluginSymlinks(depName, depPkgJson, isGlobal);
					}
				}
			}

			// Add to installed plugins map for subsequent conflict detection
			existingPlugins.set(name, pkgJson);

			console.log(chalk.green(`✓ Installed ${name}@${info.version}`));
			results.push({ name, version: info.version, success: true });
		} catch (err) {
			const errorMsg = (err as Error).message;
			console.log(chalk.red(`  ✗ Failed to install ${name}: ${errorMsg}`));
			results.push({ name, version, success: false, error: errorMsg });
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
		pluginsJson.plugins[pluginName] = `file:${localPath}`;
		await savePluginsJson(pluginsJson, isGlobal);

		// Create symlinks
		await createPluginSymlinks(pluginName, pkgJson, isGlobal);

		console.log(chalk.green(`✓ Installed ${pluginName}@${pkgJson.version}`));
		return { name: pluginName, version: pkgJson.version, success: true };
	} catch (err) {
		const errorMsg = (err as Error).message;
		console.log(chalk.red(`  ✗ Failed: ${errorMsg}`));
		return { name: basename(localPath), version: "local", success: false, error: errorMsg };
	}
}
