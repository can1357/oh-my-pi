import { existsSync, lstatSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import type { OmpInstallEntry, PluginPackageJson } from "@omp/manifest";
import { getPluginSourceDir } from "@omp/manifest";
import { PI_CONFIG_DIR, PROJECT_PI_DIR } from "@omp/paths";
import chalk from "chalk";

const isWindows = platform() === "win32";

/**
 * Format permission-related errors with actionable guidance
 */
function formatPermissionError(err: NodeJS.ErrnoException, path: string): string {
	if (err.code === "EACCES" || err.code === "EPERM") {
		return `Permission denied: Cannot write to ${path}. Check directory permissions or run with appropriate privileges.`;
	}
	return err.message;
}

/**
 * Validates that a target path stays within the base directory.
 * Prevents path traversal attacks via malicious dest entries like '../../../etc/passwd'.
 */
function isPathWithinBase(basePath: string, targetPath: string): boolean {
	const normalizedBase = resolve(basePath);
	const resolvedTarget = resolve(basePath, targetPath);
	// Must start with base path followed by separator (or be exactly the base)
	return resolvedTarget === normalizedBase || resolvedTarget.startsWith(normalizedBase + "/");
}

/**
 * Get the base directory for symlink destinations based on scope
 */
function getBaseDir(global: boolean): string {
	return global ? PI_CONFIG_DIR : PROJECT_PI_DIR;
}

export interface SymlinkResult {
	created: string[];
	errors: string[];
}

/**
 * Create symlinks for a plugin's omp.install entries
 * @param skipDestinations - Set of destination paths to skip (e.g., due to conflict resolution)
 */
export async function createPluginSymlinks(
	pluginName: string,
	pkgJson: PluginPackageJson,
	global = true,
	verbose = true,
	skipDestinations?: Set<string>,
): Promise<SymlinkResult> {
	const result: SymlinkResult = { created: [], errors: [] };
	const sourceDir = getPluginSourceDir(pluginName, global);

	if (!pkgJson.omp?.install?.length) {
		if (verbose) {
			console.log(chalk.dim("  No omp.install entries found"));
		}
		return result;
	}

	const baseDir = getBaseDir(global);

	for (const entry of pkgJson.omp.install) {
		// Skip destinations that the user chose to keep from existing plugins
		if (skipDestinations?.has(entry.dest)) {
			if (verbose) {
				console.log(chalk.dim(`  Skipped: ${entry.dest} (conflict resolved to existing plugin)`));
			}
			continue;
		}

		// Validate dest path stays within base directory (prevents path traversal attacks)
		if (!isPathWithinBase(baseDir, entry.dest)) {
			const msg = `Path traversal blocked: ${entry.dest} escapes base directory`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.red(`  ✗ ${msg}`));
			}
			continue;
		}

		try {
			const src = join(sourceDir, entry.src);
			const dest = join(baseDir, entry.dest);

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

			// Create symlink (use junctions on Windows for directories to avoid admin requirement)
			try {
				if (isWindows) {
					const stats = lstatSync(src);
					if (stats.isDirectory()) {
						await symlink(src, dest, "junction");
					} else {
						await symlink(src, dest, "file");
					}
				} else {
					await symlink(src, dest);
				}
			} catch (symlinkErr) {
				const error = symlinkErr as NodeJS.ErrnoException;
				if (isWindows && error.code === "EPERM") {
					console.log(chalk.red(`  Permission denied creating symlink.`));
					console.log(chalk.dim("  On Windows, enable Developer Mode or run as Administrator."));
					console.log(chalk.dim("  Settings > Update & Security > For developers > Developer Mode"));
				}
				throw symlinkErr;
			}
			result.created.push(entry.dest);

			if (verbose) {
				console.log(chalk.dim(`  Linked: ${entry.dest} → ${entry.src}`));
			}
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			const msg = `Failed to link ${entry.dest}: ${formatPermissionError(error, join(baseDir, entry.dest))}`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.red(`  ✗ ${msg}`));
				if (error.code === "EACCES" || error.code === "EPERM") {
					console.log(chalk.dim("  Check directory permissions or run with appropriate privileges."));
				}
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
	global = true,
	verbose = true,
): Promise<SymlinkResult> {
	const result: SymlinkResult = { created: [], errors: [] };

	if (!pkgJson.omp?.install?.length) {
		return result;
	}

	const baseDir = getBaseDir(global);

	for (const entry of pkgJson.omp.install) {
		// Validate dest path stays within base directory (prevents path traversal attacks)
		if (!isPathWithinBase(baseDir, entry.dest)) {
			const msg = `Path traversal blocked: ${entry.dest} escapes base directory`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.red(`  ✗ ${msg}`));
			}
			continue;
		}

		const dest = join(baseDir, entry.dest);

		try {
			if (existsSync(dest)) {
				const stats = lstatSync(dest);
				if (!stats.isSymbolicLink()) {
					const msg = `Skipping ${entry.dest}: not a symlink (may contain user data)`;
					result.errors.push(msg);
					if (verbose) {
						console.log(chalk.yellow(`  ⚠ ${msg}`));
					}
					continue;
				}

				await rm(dest, { force: true, recursive: true });
				result.created.push(entry.dest);
				if (verbose) {
					console.log(chalk.dim(`  Removed: ${entry.dest}`));
				}
			}
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			const msg = `Failed to remove ${entry.dest}: ${formatPermissionError(error, dest)}`;
			result.errors.push(msg);
			if (verbose) {
				console.log(chalk.yellow(`  ⚠ ${msg}`));
				if (error.code === "EACCES" || error.code === "EPERM") {
					console.log(chalk.dim("  Check directory permissions or run with appropriate privileges."));
				}
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
	const baseDir = getBaseDir(global);

	if (!pkgJson.omp?.install?.length) {
		return result;
	}

	for (const entry of pkgJson.omp.install) {
		// Skip entries with path traversal (treat as broken)
		if (!isPathWithinBase(baseDir, entry.dest)) {
			result.broken.push(entry.dest);
			continue;
		}

		const src = join(sourceDir, entry.src);
		const dest = join(baseDir, entry.dest);

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
	global = true,
): Promise<{ plugin: string; entry: OmpInstallEntry } | null> {
	// Normalize the path relative to the base directory
	const baseDir = getBaseDir(global);
	let relativePath = filePath;
	if (filePath.startsWith(baseDir)) {
		relativePath = filePath.slice(baseDir.length + 1);
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
