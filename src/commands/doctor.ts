import { existsSync } from "node:fs";
import { detectAllConflicts, formatConflicts } from "@omp/conflicts";
import { getInstalledPlugins, loadPluginsJson, readPluginPackageJson } from "@omp/manifest";
import {
	GLOBAL_PACKAGE_JSON,
	NODE_MODULES_DIR,
	PLUGINS_DIR,
	PROJECT_NODE_MODULES,
	PROJECT_PLUGINS_JSON,
	resolveScope,
} from "@omp/paths";
import { checkPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface DoctorOptions {
	global?: boolean;
	local?: boolean;
	fix?: boolean;
	json?: boolean;
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
}
