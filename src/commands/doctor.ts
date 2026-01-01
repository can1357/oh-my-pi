import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { detectAllConflicts, formatConflicts } from "@omp/conflicts";
import { writeLoader } from "@omp/loader";
import type { OmpInstallEntry } from "@omp/manifest";
import {
	getInstalledPlugins,
	isValidPluginName,
	loadPluginsJson,
	readPluginPackageJson,
	savePluginsJson,
} from "@omp/manifest";
import { GLOBAL_PACKAGE_JSON, NODE_MODULES_DIR, PI_CONFIG_DIR, PLUGINS_DIR } from "@omp/paths";
import { checkPluginSymlinks, createPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface DoctorOptions {
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
 * Validates that a target path stays within the base directory.
 * Prevents path traversal attacks via malicious dest entries like '../../../etc/passwd'.
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
 * Validate an omp.install entry for basic integrity
 */
function validateInstallEntry(
	entry: OmpInstallEntry,
	baseDir: string,
): { valid: true } | { valid: false; reason: string } {
	// Check for empty or missing src
	if (!entry.src || typeof entry.src !== "string" || entry.src.trim() === "") {
		return { valid: false, reason: "empty or missing 'src' field" };
	}
	// Check for empty or missing dest
	if (!entry.dest || typeof entry.dest !== "string" || entry.dest.trim() === "") {
		return { valid: false, reason: "empty or missing 'dest' field" };
	}
	// Check for path traversal in src
	if (entry.src.includes("..")) {
		return { valid: false, reason: `path traversal in src: '${entry.src}'` };
	}
	// Check for path traversal in dest
	if (!isPathWithinBase(baseDir, entry.dest)) {
		return { valid: false, reason: `path traversal in dest: '${entry.dest}'` };
	}
	return { valid: true };
}

/**
 * Validate plugin package.json has required fields
 */
function validatePluginPackageJson(
	pkgJson: unknown,
	pluginName: string,
): { valid: true } | { valid: false; errors: string[] } {
	const errors: string[] = [];

	if (!pkgJson || typeof pkgJson !== "object") {
		return { valid: false, errors: ["package.json is not a valid object"] };
	}

	const pkg = pkgJson as Record<string, unknown>;

	// Required fields
	if (!pkg.name || typeof pkg.name !== "string") {
		errors.push("missing or invalid 'name' field");
	} else if (pkg.name !== pluginName) {
		errors.push(`name mismatch: package.json has '${pkg.name}', expected '${pluginName}'`);
	}

	if (!pkg.version || typeof pkg.version !== "string") {
		errors.push("missing or invalid 'version' field");
	}

	// Validate omp field if present
	if (pkg.omp !== undefined) {
		if (typeof pkg.omp !== "object" || pkg.omp === null) {
			errors.push("'omp' field must be an object");
		} else {
			const omp = pkg.omp as Record<string, unknown>;
			// Validate install array if present
			if (omp.install !== undefined) {
				if (!Array.isArray(omp.install)) {
					errors.push("'omp.install' must be an array");
				}
			}
			// Validate features object if present
			if (omp.features !== undefined) {
				if (typeof omp.features !== "object" || omp.features === null || Array.isArray(omp.features)) {
					errors.push("'omp.features' must be an object");
				}
			}
		}
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Run health checks on the plugin system
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
	const results: DiagnosticResult[] = [];

	console.log(chalk.blue("Running health checks...\n"));

	// 1. Check plugins directory exists
	if (!existsSync(PLUGINS_DIR)) {
		results.push({
			check: "Plugins directory",
			status: "warning",
			message: `${PLUGINS_DIR} does not exist`,
			fix: "Run: omp install <package>",
		});
	} else {
		results.push({
			check: "Plugins directory",
			status: "ok",
			message: PLUGINS_DIR,
		});
	}

	// 2. Check package.json exists
	if (!existsSync(GLOBAL_PACKAGE_JSON)) {
		results.push({
			check: "Package manifest",
			status: "warning",
			message: `${GLOBAL_PACKAGE_JSON} does not exist`,
			fix: "Run: omp install <package>",
		});
	} else {
		results.push({
			check: "Package manifest",
			status: "ok",
			message: GLOBAL_PACKAGE_JSON,
		});
	}

	// 3. Check node_modules exists
	if (!existsSync(NODE_MODULES_DIR)) {
		results.push({
			check: "Node modules",
			status: "warning",
			message: `${NODE_MODULES_DIR} does not exist`,
		});
	} else {
		results.push({
			check: "Node modules",
			status: "ok",
			message: NODE_MODULES_DIR,
		});
	}

	// 4. Check each plugin's symlinks
	const installedPlugins = await getInstalledPlugins();
	const brokenSymlinks: string[] = [];
	const missingSymlinks: string[] = [];

	for (const [name, pkgJson] of installedPlugins) {
		const symlinkStatus = await checkPluginSymlinks(name, pkgJson);

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
	const pluginsJson = await loadPluginsJson();
	const orphaned: string[] = [];
	for (const name of Object.keys(pluginsJson.plugins)) {
		const pkgJson = await readPluginPackageJson(name);
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
	const transitiveDeps = pluginsJson.transitiveDeps || {};
	for (const [name, pkgJson] of installedPlugins) {
		if (pkgJson.dependencies) {
			for (const depName of Object.keys(pkgJson.dependencies)) {
				const depPkgJson = await readPluginPackageJson(depName);
				if (!depPkgJson) {
					// Dependency not found in node_modules
					// Check if it's supposed to be an omp plugin by looking in the plugins manifest
					if (pluginsJson.plugins[depName]) {
						missingDeps.push(`${name} requires ${depName} (not in node_modules)`);
					}
				} else if (depPkgJson.omp?.install && depPkgJson.omp.install.length > 0) {
					// Dependency is an omp plugin (has install entries) and is present - that's fine
					// Check if it's registered in the plugins manifest or as a transitive dep
					if (!pluginsJson.plugins[depName] && !transitiveDeps[depName]) {
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
			fix: "Run: npm install in ~/.pi/plugins",
		});
	}

	// 8. Validate omp.install entries for all plugins
	const malformedInstallEntries: string[] = [];
	for (const [name, pkgJson] of installedPlugins) {
		const installEntries = pkgJson.omp?.install ?? [];
		for (let i = 0; i < installEntries.length; i++) {
			const entry = installEntries[i];
			const validation = validateInstallEntry(entry, PI_CONFIG_DIR);
			if (!validation.valid) {
				malformedInstallEntries.push(`${name} omp.install[${i}]: ${validation.reason}`);
			}
		}
	}

	if (malformedInstallEntries.length > 0) {
		results.push({
			check: "Malformed omp.install entries",
			status: "error",
			message: `${malformedInstallEntries.length} invalid install entry(s)`,
			fix: "Fix plugin package.json omp.install entries or report to plugin author",
		});
	} else if (installedPlugins.size > 0) {
		results.push({
			check: "Install entries",
			status: "ok",
			message: "All omp.install entries valid",
		});
	}

	// 9. Validate plugin package.json schema
	const schemaErrors: string[] = [];
	for (const name of Object.keys(pluginsJson.plugins)) {
		const pkgPath = join(NODE_MODULES_DIR, name, "package.json");
		try {
			const raw = await readFile(pkgPath, "utf-8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (parseErr) {
				schemaErrors.push(`${name}: invalid JSON - ${(parseErr as Error).message}`);
				continue;
			}
			const validation = validatePluginPackageJson(parsed, name);
			if (!validation.valid) {
				schemaErrors.push(...validation.errors.map((e) => `${name}: ${e}`));
			}
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code !== "ENOENT") {
				schemaErrors.push(`${name}: failed to read package.json - ${error.message}`);
			}
			// ENOENT already handled by orphaned check
		}
	}

	if (schemaErrors.length > 0) {
		results.push({
			check: "Plugin package.json schema",
			status: "error",
			message: `${schemaErrors.length} schema error(s)`,
			fix: "Fix plugin package.json files or report to plugin author",
		});
	} else if (Object.keys(pluginsJson.plugins).length > 0) {
		results.push({
			check: "Plugin package.json schema",
			status: "ok",
			message: "All plugin package.json files valid",
		});
	}

	// 10. Check peerDependencies satisfaction
	const unsatisfiedPeerDeps: string[] = [];
	for (const [name, pkgJson] of installedPlugins) {
		const peerDeps = (pkgJson as unknown as Record<string, unknown>).peerDependencies as
			| Record<string, string>
			| undefined;
		if (peerDeps) {
			for (const [peerName, _peerVersion] of Object.entries(peerDeps)) {
				// Check if peer dep is installed
				const peerPkgJson = await readPluginPackageJson(peerName);
				if (!peerPkgJson) {
					// Peer dep not in node_modules - missing
					unsatisfiedPeerDeps.push(`${name} peerDependencies: ${peerName} is not installed`);
				}
				// Note: Version range validation would require semver, keeping simple for now
			}
		}
	}

	if (unsatisfiedPeerDeps.length > 0) {
		results.push({
			check: "Peer dependencies",
			status: "warning",
			message: `${unsatisfiedPeerDeps.length} unsatisfied peer dep(s)`,
			fix: "Install missing peer dependencies",
		});
	} else {
		const hasPeerDeps = [...installedPlugins.values()].some(
			(pkg) => (pkg as unknown as Record<string, unknown>).peerDependencies,
		);
		if (hasPeerDeps) {
			results.push({
				check: "Peer dependencies",
				status: "ok",
				message: "All peer dependencies satisfied",
			});
		}
	}

	// 11. Check optionalDependencies that are present are valid
	const invalidOptionalDeps: string[] = [];
	for (const [name, pkgJson] of installedPlugins) {
		const optDeps = (pkgJson as unknown as Record<string, unknown>).optionalDependencies as
			| Record<string, string>
			| undefined;
		if (optDeps) {
			for (const [optName] of Object.entries(optDeps)) {
				// Validate optional dep name
				if (!isValidPluginName(optName)) {
					invalidOptionalDeps.push(`${name} optionalDependencies: invalid package name '${optName}'`);
					continue;
				}
				// If present, check it's valid
				const optPkgJson = await readPluginPackageJson(optName);
				if (optPkgJson) {
					// It's installed, validate its package.json
					const validation = validatePluginPackageJson(optPkgJson, optName);
					if (!validation.valid) {
						invalidOptionalDeps.push(`${name} optionalDependency ${optName}: ${validation.errors.join(", ")}`);
					}
				}
				// If not present, that's fine - it's optional
			}
		}
	}

	if (invalidOptionalDeps.length > 0) {
		results.push({
			check: "Optional dependencies",
			status: "warning",
			message: `${invalidOptionalDeps.length} invalid optional dep(s)`,
			fix: "Fix or remove invalid optional dependencies",
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

	// Show malformed install entries details
	if (malformedInstallEntries.length > 0) {
		console.log(chalk.red("\nMalformed omp.install entries:"));
		for (const e of malformedInstallEntries) {
			console.log(chalk.dim(`  - ${e}`));
		}
	}

	// Show schema errors details
	if (schemaErrors.length > 0) {
		console.log(chalk.red("\nPlugin package.json schema errors:"));
		for (const e of schemaErrors) {
			console.log(chalk.dim(`  - ${e}`));
		}
	}

	// Show unsatisfied peer dependencies details
	if (unsatisfiedPeerDeps.length > 0) {
		console.log(chalk.yellow("\nUnsatisfied peer dependencies:"));
		for (const p of unsatisfiedPeerDeps) {
			console.log(chalk.dim(`  - ${p}`));
		}
	}

	// Show invalid optional dependencies details
	if (invalidOptionalDeps.length > 0) {
		console.log(chalk.yellow("\nInvalid optional dependencies:"));
		for (const o of invalidOptionalDeps) {
			console.log(chalk.dim(`  - ${o}`));
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
				const symlinkResult = await createPluginSymlinks(name, pkgJson, false);
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
			await savePluginsJson(pluginsJson);
			fixedAnything = true;
		}

		// Conflicts cannot be auto-fixed
		if (conflicts.length > 0) {
			console.log(chalk.yellow("\nConflicts cannot be auto-fixed. Please resolve manually:"));
			for (const conflict of formatConflicts(conflicts)) {
				console.log(chalk.dim(`  - ${conflict}`));
			}
		}

		// Always ensure the OMP loader and tools.json are up to date
		await writeLoader();

		if (fixedAnything) {
			console.log(chalk.green("\n✓ Fixes applied. Run 'omp doctor' again to verify."));
		} else if (conflicts.length === 0) {
			console.log(chalk.dim("\nNo fixable issues found."));
		}
	}
}
