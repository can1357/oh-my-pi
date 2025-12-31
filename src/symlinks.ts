import { existsSync, lstatSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type { OmpInstallEntry, PluginPackageJson } from "./manifest.js";
import { getPluginSourceDir } from "./manifest.js";
import { PI_CONFIG_DIR } from "./paths.js";

export interface SymlinkResult {
	created: string[];
	errors: string[];
}

/**
 * Create symlinks for a plugin's omp.install entries
 */
export async function createPluginSymlinks(
	pluginName: string,
	pkgJson: PluginPackageJson,
	global = true,
	verbose = true,
): Promise<SymlinkResult> {
	const result: SymlinkResult = { created: [], errors: [] };
	const sourceDir = getPluginSourceDir(pluginName, global);

	if (!pkgJson.omp?.install?.length) {
		if (verbose) {
			console.log(chalk.dim("  No omp.install entries found"));
		}
		return result;
	}

	for (const entry of pkgJson.omp.install) {
		try {
			const src = join(sourceDir, entry.src);
			const dest = join(PI_CONFIG_DIR, entry.dest);

			// Check if source exists
			if (!existsSync(src)) {
				result.errors.push(`Source not found: ${entry.src}`);
				if (verbose) {
					console.log(chalk.yellow(`  ⚠ Source not found: ${entry.src}`));
				}
				continue;
			}

			// Create parent directory
			await mkdir(dirname(dest), { recursive: true });

			// Remove existing symlink/file if it exists
			try {
				await rm(dest, { force: true, recursive: true });
			} catch {}

			// Create symlink
			await symlink(src, dest);
			result.created.push(entry.dest);

			if (verbose) {
				console.log(chalk.dim(`  Linked: ${entry.dest} → ${entry.src}`));
			}
		} catch (err) {
			const msg = `Failed to link ${entry.dest}: ${(err as Error).message}`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.red(`  ✗ ${msg}`));
			}
		}
	}

	return result;
}

/**
 * Remove symlinks for a plugin's omp.install entries
 */
export async function removePluginSymlinks(
	_pluginName: string,
	pkgJson: PluginPackageJson,
	verbose = true,
): Promise<SymlinkResult> {
	const result: SymlinkResult = { created: [], errors: [] };

	if (!pkgJson.omp?.install?.length) {
		return result;
	}

	for (const entry of pkgJson.omp.install) {
		const dest = join(PI_CONFIG_DIR, entry.dest);

		try {
			if (existsSync(dest)) {
				await rm(dest, { force: true, recursive: true });
				result.created.push(entry.dest);
				if (verbose) {
					console.log(chalk.dim(`  Removed: ${entry.dest}`));
				}
			}
		} catch (err) {
			const msg = `Failed to remove ${entry.dest}: ${(err as Error).message}`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.yellow(`  ⚠ ${msg}`));
			}
		}
	}

	return result;
}

/**
 * Check symlink health for a plugin
 */
export async function checkPluginSymlinks(
	pluginName: string,
	pkgJson: PluginPackageJson,
	global = true,
): Promise<{ valid: string[]; broken: string[]; missing: string[] }> {
	const result = { valid: [] as string[], broken: [] as string[], missing: [] as string[] };
	const sourceDir = getPluginSourceDir(pluginName, global);

	if (!pkgJson.omp?.install?.length) {
		return result;
	}

	for (const entry of pkgJson.omp.install) {
		const src = join(sourceDir, entry.src);
		const dest = join(PI_CONFIG_DIR, entry.dest);

		if (!existsSync(dest)) {
			result.missing.push(entry.dest);
			continue;
		}

		try {
			const stats = lstatSync(dest);
			if (stats.isSymbolicLink()) {
				const _target = await readlink(dest);
				if (existsSync(src)) {
					result.valid.push(entry.dest);
				} else {
					result.broken.push(entry.dest);
				}
			} else {
				// Not a symlink, might be a file that was overwritten
				result.broken.push(entry.dest);
			}
		} catch {
			result.broken.push(entry.dest);
		}
	}

	return result;
}

/**
 * Get plugin name from an installed symlink destination
 */
export async function getPluginForSymlink(
	dest: string,
	installedPlugins: Map<string, PluginPackageJson>,
): Promise<string | null> {
	for (const [name, pkgJson] of installedPlugins) {
		if (pkgJson.omp?.install) {
			for (const entry of pkgJson.omp.install) {
				if (entry.dest === dest) {
					return name;
				}
			}
		}
	}
	return null;
}

/**
 * Find all symlinks installed by plugins and trace them back
 */
export async function traceInstalledFile(
	filePath: string,
	installedPlugins: Map<string, PluginPackageJson>,
): Promise<{ plugin: string; entry: OmpInstallEntry } | null> {
	// Normalize the path relative to PI_CONFIG_DIR
	let relativePath = filePath;
	if (filePath.startsWith(PI_CONFIG_DIR)) {
		relativePath = filePath.slice(PI_CONFIG_DIR.length + 1);
	}

	for (const [name, pkgJson] of installedPlugins) {
		if (pkgJson.omp?.install) {
			for (const entry of pkgJson.omp.install) {
				if (entry.dest === relativePath) {
					return { plugin: name, entry };
				}
			}
		}
	}

	return null;
}
