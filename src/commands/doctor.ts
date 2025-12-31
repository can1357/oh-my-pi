import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { detectAllConflicts, formatConflicts } from "@omp/conflicts";
import { getInstalledPlugins, loadPluginsJson, readPluginPackageJson, savePluginsJson } from "@omp/manifest";
import {
	GLOBAL_PACKAGE_JSON,
	NODE_MODULES_DIR,
	PLUGINS_DIR,
	PROJECT_NODE_MODULES,
	PROJECT_PLUGINS_JSON,
	resolveScope,
} from "@omp/paths";
import { checkPluginSymlinks, createPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface DoctorOptions {
	global?: boolean;
	local?: boolean;
	fix?: boolean;
	json?: boolean;
	force?: boolean;
	yes?: boolean;
}

interface DiagnosticResult {
	check: string;
	status: "ok" | "warning" | "error";
	message: string;
	fix?: string;
}

/**
 * Run health checks on the plugin system
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const results: DiagnosticResult[] = [];

	console.log(chalk.blue("Running health checks...\n"));

	// 1. Check plugins directory exists
	const pluginsDir = isGlobal ? PLUGINS_DIR : ".pi";
	if (!existsSync(pluginsDir)) {
		results.push({
			check: "Plugins directory",
			status: "warning",
			message: `${pluginsDir} does not exist`,
			fix: "Run: omp install <package>",
		});
	} else {
		results.push({
			check: "Plugins directory",
			status: "ok",
			message: pluginsDir,
		});
	}

	// 2. Check package.json exists
	const packageJsonPath = isGlobal ? GLOBAL_PACKAGE_JSON : PROJECT_PLUGINS_JSON;
	if (!existsSync(packageJsonPath)) {
		results.push({
			check: "Package manifest",
			status: "warning",
			message: `${packageJsonPath} does not exist`,
			fix: isGlobal ? "Run: omp install <package>" : "Run: omp init",
		});
	} else {
		results.push({
			check: "Package manifest",
			status: "ok",
			message: packageJsonPath,
		});
	}

	// 3. Check node_modules exists
	const nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;
	if (!existsSync(nodeModules)) {
		results.push({
			check: "Node modules",
			status: "warning",
			message: `${nodeModules} does not exist`,
		});
	} else {
		results.push({
			check: "Node modules",
			status: "ok",
			message: nodeModules,
		});
	}

	// 4. Check each plugin's symlinks
	const installedPlugins = await getInstalledPlugins(isGlobal);
	const brokenSymlinks: string[] = [];
	const missingSymlinks: string[] = [];

	for (const [name, pkgJson] of installedPlugins) {
		const symlinkStatus = await checkPluginSymlinks(name, pkgJson, isGlobal);

		if (symlinkStatus.broken.length > 0) {
			brokenSymlinks.push(...symlinkStatus.broken.map((s) => `${name}: ${s}`));
		}
		if (symlinkStatus.missing.length > 0) {
			missingSymlinks.push(...symlinkStatus.missing.map((s) => `${name}: ${s}`));
		}
	}

	if (brokenSymlinks.length > 0) {
		results.push({
			check: "Broken symlinks",
			status: "error",
			message: `${brokenSymlinks.length} broken symlink(s)`,
			fix: "Run: omp update <plugin> to re-create symlinks",
		});
	} else {
		results.push({
			check: "Symlinks",
			status: "ok",
			message: "All symlinks valid",
		});
	}

	if (missingSymlinks.length > 0) {
		results.push({
			check: "Missing symlinks",
			status: "warning",
			message: `${missingSymlinks.length} expected symlink(s) not found`,
			fix: "Run: omp update <plugin> to re-create symlinks",
		});
	}

	// 5. Check for conflicts
	const conflicts = detectAllConflicts(installedPlugins);
	if (conflicts.length > 0) {
		results.push({
			check: "Conflicts",
			status: "warning",
			message: formatConflicts(conflicts).join("; "),
		});
	} else {
		results.push({
			check: "Conflicts",
			status: "ok",
			message: "No conflicts detected",
		});
	}

	// 6. Check for orphaned entries in package.json
	const pluginsJson = await loadPluginsJson(isGlobal);
	const orphaned: string[] = [];
	for (const name of Object.keys(pluginsJson.plugins)) {
		const pkgJson = await readPluginPackageJson(name, isGlobal);
		if (!pkgJson) {
			orphaned.push(name);
		}
	}

	if (orphaned.length > 0) {
		results.push({
			check: "Orphaned entries",
			status: "warning",
			message: `${orphaned.length} plugin(s) in manifest but not in node_modules: ${orphaned.join(", ")}`,
			fix: "Run: omp install (to reinstall) or remove from manifest",
		});
	}

	// 7. Check for missing omp dependencies
	const missingDeps: string[] = [];
	for (const [name, pkgJson] of installedPlugins) {
		if (pkgJson.dependencies) {
			for (const depName of Object.keys(pkgJson.dependencies)) {
				const depPkgJson = await readPluginPackageJson(depName, isGlobal);
				if (!depPkgJson) {
					// Dependency not found in node_modules
					// Check if it's supposed to be an omp plugin by looking in the plugins manifest
					if (pluginsJson.plugins[depName]) {
						missingDeps.push(`${name} requires ${depName} (not in node_modules)`);
					}
				} else if (depPkgJson.omp?.install && depPkgJson.omp.install.length > 0) {
					// Dependency is an omp plugin (has install entries) and is present - that's fine
					// But check if it's registered in the plugins manifest
					if (!pluginsJson.plugins[depName]) {
						missingDeps.push(`${name} requires omp plugin ${depName} (installed but not in manifest)`);
					}
				}
			}
		}
	}

	if (missingDeps.length > 0) {
		results.push({
			check: "Missing omp dependencies",
			status: "warning",
			message: missingDeps.join("; "),
			fix: isGlobal ? "Run: npm install in ~/.pi/plugins" : "Run: npm install in .pi",
		});
	}

	// Output results
	if (options.json) {
		console.log(JSON.stringify({ results }, null, 2));
		return;
	}

	for (const result of results) {
		let icon: string;
		let color: typeof chalk;

		switch (result.status) {
			case "ok":
				icon = "✓";
				color = chalk.green;
				break;
			case "warning":
				icon = "⚠";
				color = chalk.yellow;
				break;
			case "error":
				icon = "✗";
				color = chalk.red;
				break;
		}

		console.log(color(`${icon} ${result.check}: `) + result.message);

		if (result.fix && result.status !== "ok") {
			console.log(chalk.dim(`    ${result.fix}`));
		}
	}

	// Summary
	const errors = results.filter((r) => r.status === "error");
	const warnings = results.filter((r) => r.status === "warning");

	console.log();
	if (errors.length === 0 && warnings.length === 0) {
		console.log(chalk.green("✓ All checks passed!"));
	} else {
		if (errors.length > 0) {
			console.log(chalk.red(`${errors.length} error(s) found`));
			process.exitCode = 1;
		}
		if (warnings.length > 0) {
			console.log(chalk.yellow(`${warnings.length} warning(s) found`));
		}
	}

	// Show broken symlinks details
	if (brokenSymlinks.length > 0) {
		console.log(chalk.red("\nBroken symlinks:"));
		for (const s of brokenSymlinks) {
			console.log(chalk.dim(`  - ${s}`));
		}
	}

	if (missingSymlinks.length > 0) {
		console.log(chalk.yellow("\nMissing symlinks:"));
		for (const s of missingSymlinks) {
			console.log(chalk.dim(`  - ${s}`));
		}
	}

	// Apply fixes if --fix flag was passed
	if (options.fix) {
		// Collect all destructive operations for confirmation
		const destructiveOps: string[] = [];

		if (orphaned.length > 0) {
			for (const name of orphaned) {
				destructiveOps.push(`Remove orphaned manifest entry: ${name}`);
			}
		}

		// Show what will be done and require confirmation
		if (destructiveOps.length > 0) {
			console.log(
				chalk.yellow(`\nThe following ${destructiveOps.length} destructive operation(s) will be performed:`),
			);
			for (const op of destructiveOps) {
				console.log(chalk.dim(`  - ${op}`));
			}
			console.log();

			const skipConfirmation = options.force || options.yes;
			const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

			if (!skipConfirmation) {
				if (!isInteractive) {
					console.log(chalk.red("Error: Destructive operations require confirmation."));
					console.log(chalk.dim("Use --force or --yes flag in non-interactive environments."));
					process.exitCode = 1;
					return;
				}

				const rl = createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				const answer = await new Promise<string>((resolve) => {
					rl.question(chalk.yellow("Proceed with fixes? [y/N] "), (ans) => {
						rl.close();
						resolve(ans);
					});
				});

				if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
					console.log(chalk.dim("Fix aborted."));
					return;
				}
			}
		}

		let fixedAnything = false;

		// Fix broken/missing symlinks by re-creating them
		if (brokenSymlinks.length > 0 || missingSymlinks.length > 0) {
			console.log(chalk.blue("\nAttempting to fix broken/missing symlinks..."));
			for (const [name, pkgJson] of installedPlugins) {
				const symlinkResult = await createPluginSymlinks(name, pkgJson, isGlobal, false);
				if (symlinkResult.created.length > 0) {
					fixedAnything = true;
					console.log(chalk.green(`  ✓ Re-created symlinks for ${name}`));
				}
				if (symlinkResult.errors.length > 0) {
					for (const err of symlinkResult.errors) {
						console.log(chalk.red(`  ✗ ${name}: ${err}`));
					}
				}
			}
		}

		// Remove orphaned manifest entries
		if (orphaned.length > 0) {
			console.log(chalk.blue("\nRemoving orphaned entries from manifest..."));
			for (const name of orphaned) {
				delete pluginsJson.plugins[name];
				console.log(chalk.green(`  ✓ Removed ${name}`));
			}
			await savePluginsJson(pluginsJson, isGlobal);
			fixedAnything = true;
		}

		// Conflicts cannot be auto-fixed
		if (conflicts.length > 0) {
			console.log(chalk.yellow("\nConflicts cannot be auto-fixed. Please resolve manually:"));
			for (const conflict of formatConflicts(conflicts)) {
				console.log(chalk.dim(`  - ${conflict}`));
			}
		}

		if (fixedAnything) {
			console.log(chalk.green("\n✓ Fixes applied. Run 'omp doctor' again to verify."));
		} else if (conflicts.length === 0) {
			console.log(chalk.dim("\nNo fixable issues found."));
		}
	}
}
