import { existsSync, lstatSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getInstalledPlugins, readPluginPackageJson } from "@omp/manifest";
import { PI_CONFIG_DIR, PROJECT_PI_DIR, resolveScope } from "@omp/paths";
import { traceInstalledFile } from "@omp/symlinks";
import chalk from "chalk";

export interface WhyOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * Show which plugin installed a file
 */
export async function whyFile(filePath: string, options: WhyOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);

	// Determine the base directory based on scope
	const baseDir = isGlobal ? PI_CONFIG_DIR : resolve(PROJECT_PI_DIR);

	// Normalize path - make it relative to the appropriate base directory
	let relativePath = filePath;
	if (isGlobal) {
		if (filePath.startsWith(PI_CONFIG_DIR)) {
			relativePath = relative(PI_CONFIG_DIR, filePath);
		} else if (filePath.startsWith("~/.pi/")) {
			relativePath = filePath.slice(6); // Remove ~/.pi/
		}
	} else {
		// Project-local mode
		const resolvedProjectDir = resolve(PROJECT_PI_DIR);
		if (filePath.startsWith(resolvedProjectDir)) {
			relativePath = relative(resolvedProjectDir, filePath);
		} else if (filePath.startsWith(".pi/")) {
			relativePath = filePath.slice(4); // Remove .pi/
		}
	}

	// Check if it's a path in agent/ directory
	if (!relativePath.startsWith("agent/")) {
		// Try prepending agent/
		const withAgent = `agent/${relativePath}`;
		const fullWithAgent = join(baseDir, withAgent);
		if (existsSync(fullWithAgent)) {
			relativePath = withAgent;
		}
	}

	const fullPath = join(baseDir, relativePath);

	// Check if file exists
	if (!existsSync(fullPath)) {
		console.log(chalk.yellow(`File not found: ${fullPath}`));
		process.exitCode = 1;
		return;
	}

	// Check if it's a symlink
	const stats = lstatSync(fullPath);
	const isSymlink = stats.isSymbolicLink();

	let target: string | null = null;
	if (isSymlink) {
		target = await readlink(fullPath);
	}

	// Search through installed plugins
	const installedPlugins = await getInstalledPlugins(isGlobal);
	const result = await traceInstalledFile(relativePath, installedPlugins, isGlobal);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					path: relativePath,
					fullPath,
					isSymlink,
					target,
					plugin: result?.plugin || null,
					source: result?.entry.src || null,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`File: ${relativePath}`));
	console.log(chalk.dim(`Full path: ${fullPath}`));
	console.log();

	if (isSymlink && target) {
		console.log(`${chalk.dim("Type: ")}symlink`);
		console.log(chalk.dim("Target: ") + target);
		console.log();
	}

	if (result) {
		console.log(chalk.green(`✓ Installed by: ${result.plugin}`));
		console.log(chalk.dim(`  Source: ${result.entry.src}`));
		console.log(chalk.dim(`  Dest: ${result.entry.dest}`));

		// Get plugin info
		const pkgJson = await readPluginPackageJson(result.plugin, isGlobal);
		if (pkgJson) {
			console.log();
			console.log(chalk.dim(`Plugin version: ${pkgJson.version}`));
			if (pkgJson.description) {
				console.log(chalk.dim(`Description: ${pkgJson.description}`));
			}
		}
	} else {
		console.log(chalk.yellow("⚠ Not installed by any tracked plugin"));
		console.log(chalk.dim("  This file may have been created manually or by a plugin that was uninstalled."));
	}
}
