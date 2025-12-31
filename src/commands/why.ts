import { existsSync, lstatSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getInstalledPlugins, getPluginSourceDir, readPluginPackageJson } from "@omp/manifest";
import { getProjectPiDir, PI_CONFIG_DIR, resolveScope } from "@omp/paths";
import { traceInstalledFile } from "@omp/symlinks";
import chalk from "chalk";

export interface WhyOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * Validates that a resolved path stays within the base directory.
 * Prevents path traversal attacks via malicious user input.
 */
function isPathWithinBase(basePath: string, targetPath: string): boolean {
	const normalizedBase = resolve(basePath);
	const resolvedTarget = resolve(basePath, targetPath);
	const rel = relative(normalizedBase, resolvedTarget);
	if (rel === "") return true;
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	return true;
}

/**
 * Show which plugin installed a file
 */
export async function whyFile(filePath: string, options: WhyOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);

	// Determine the base directory based on scope
	const baseDir = isGlobal ? PI_CONFIG_DIR : getProjectPiDir();

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
		const projectPiDir = getProjectPiDir();
		if (filePath.startsWith(projectPiDir)) {
			relativePath = relative(projectPiDir, filePath);
		} else if (filePath.startsWith(".pi/")) {
			relativePath = filePath.slice(4); // Remove .pi/
		}
	}

	// Validate path doesn't escape base directory (prevents path traversal attacks)
	if (!isPathWithinBase(baseDir, relativePath)) {
		console.log(chalk.red(`Error: Path traversal blocked - path escapes base directory`));
		process.exitCode = 1;
		return;
	}

	// Check if it's a path in agent/ directory
	if (!relativePath.startsWith("agent/")) {
		// Try prepending agent/
		const withAgent = `agent/${relativePath}`;
		// Re-validate with agent/ prefix
		if (isPathWithinBase(baseDir, withAgent)) {
			const fullWithAgent = join(baseDir, withAgent);
			if (existsSync(fullWithAgent)) {
				relativePath = withAgent;
			}
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
		// Verify it's actually a symlink pointing to the right place
		if (!isSymlink) {
			console.log(chalk.yellow("⚠ This file exists but is not a symlink"));
			console.log(chalk.dim("  It may have been manually created or the symlink was replaced."));
			console.log(chalk.dim(`  Expected to be installed by: ${result.plugin}`));
		} else {
			// Verify symlink points to correct source
			const expectedSrc = join(getPluginSourceDir(result.plugin, isGlobal), result.entry.src);
			if (target !== expectedSrc) {
				console.log(chalk.yellow("⚠ Symlink target does not match expected source"));
				console.log(chalk.dim(`  Expected: ${expectedSrc}`));
				console.log(chalk.dim(`  Actual: ${target}`));
				console.log(chalk.dim(`  Expected to be installed by: ${result.plugin}`));
			} else {
				console.log(chalk.green(`✓ Installed by: ${result.plugin}`));
				console.log(chalk.dim(`  Source: ${result.entry.src}`));
				console.log(chalk.dim(`  Dest: ${result.entry.dest}`));
			}
		}

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
