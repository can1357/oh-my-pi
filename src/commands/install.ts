import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Conflict, detectConflicts, detectIntraPluginDuplicates, formatConflicts } from "@omp/conflicts";
import { writeLoader } from "@omp/loader";
import { getLockedPackage, updateLockFile, verifyIntegrity } from "@omp/lockfile";
import {
	getInstalledPlugins,
	initGlobalPlugins,
	loadPluginsJson,
	type PluginConfig,
	type PluginPackageJson,
	readPluginPackageJson,
	savePluginsJson,
} from "@omp/manifest";
import { npmInfo, npmInstall, requireNpm } from "@omp/npm";
import { log, outputJson, setJsonMode } from "@omp/output";
import { NODE_MODULES_DIR, PI_CONFIG_DIR, PLUGINS_DIR } from "@omp/paths";
import { createProgress } from "@omp/progress";
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
 * Recurses into all dependencies to find transitive omp.install entries,
 * even if intermediate dependencies don't have omp.install themselves.
 * Returns a map of auto-linked transitive deps (depName -> parentPluginName).
 */
async function processOmpDependencies(
	pkgJson: PluginPackageJson,
	seen: Set<string>,
	parentPluginName: string,
	transitiveDeps: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
	if (!pkgJson.dependencies) return transitiveDeps;

	for (const depName of Object.keys(pkgJson.dependencies)) {
		if (seen.has(depName)) {
			log(chalk.yellow(`  Skipping circular dependency: ${depName}`));
			continue;
		}
		seen.add(depName);

		const depPkgJson = await readPluginPackageJson(depName);
		if (!depPkgJson) continue;

		// Create symlinks if this dependency has omp.install entries
		if (depPkgJson.omp?.install) {
			log(chalk.dim(`  Processing dependency: ${depName}`));
			await createPluginSymlinks(depName, depPkgJson, true);
			// Track this as a transitive dep (points to the top-level parent that pulled it in)
			transitiveDeps.set(depName, parentPluginName);
		}

		// Always recurse into transitive dependencies to find nested omp.install entries
		await processOmpDependencies(depPkgJson, seen, parentPluginName, transitiveDeps);
	}

	return transitiveDeps;
}

/**
 * Collect all transitive dependencies that have omp.install entries from registry metadata.
 * Used for pre-install conflict detection before npm install runs.
 * Returns a map of depName -> partial PluginPackageJson (with omp field).
 */
async function collectTransitiveOmpDeps(
	info: {
		name: string;
		version: string;
		dependencies?: Record<string, string>;
		omp?: { install?: Array<{ src: string; dest: string }> };
	},
	seen: Set<string> = new Set(),
): Promise<Map<string, PluginPackageJson>> {
	const result = new Map<string, PluginPackageJson>();

	if (!info.dependencies) return result;

	for (const depName of Object.keys(info.dependencies)) {
		if (seen.has(depName)) continue;
		seen.add(depName);

		const depInfo = await npmInfo(depName);
		if (!depInfo) continue;

		// If this dep has omp.install, add it to result
		if (depInfo.omp?.install?.length) {
			result.set(depName, {
				name: depInfo.name,
				version: depInfo.version,
				omp: depInfo.omp,
			} as PluginPackageJson);
		}

		// Recurse into this dep's dependencies
		const nestedDeps = await collectTransitiveOmpDeps(depInfo, seen);
		for (const [name, pkgJson] of nestedDeps) {
			result.set(name, pkgJson);
		}
	}

	return result;
}

/**
 * Conflict resolution strategies for non-interactive environments
 */
export type ConflictResolution = "abort" | "overwrite" | "skip" | "prompt";

export interface InstallOptions {
	save?: boolean;
	saveDev?: boolean;
	force?: boolean;
	json?: boolean;
	dryRun?: boolean;
	conflictResolution?: ConflictResolution;
}

/**
 * Prompt user to choose when there's a conflict.
 * Re-prompts on invalid input with an error message.
 * Returns null only if user explicitly chooses abort.
 */
async function promptConflictResolution(conflict: Conflict): Promise<number | null> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const maxChoice = conflict.plugins.length + 1;
	const validChoices = Array.from({ length: maxChoice }, (_, i) => i + 1);

	const displayPrompt = (showHeader: boolean) => {
		if (showHeader) {
			log(chalk.yellow(`\n⚠ Conflict: ${formatConflicts([conflict])[0]}`));
			conflict.plugins.forEach((p, i) => {
				log(`  [${i + 1}] ${p.name}`);
			});
			log(`  [${conflict.plugins.length + 1}] abort`);
		}
	};

	return new Promise((resolve) => {
		displayPrompt(true);

		// Handle EOF (Ctrl+D) - resolve with null (abort)
		rl.on("close", () => {
			resolve(null);
		});

		const askQuestion = () => {
			rl.question("  Choose: ", (answer) => {
				const trimmed = answer.trim();
				const choice = parseInt(trimmed, 10);

				// Check for explicit abort choice
				if (choice === maxChoice) {
					rl.close();
					resolve(null);
					return;
				}

				// Check for valid plugin choice
				if (choice > 0 && choice <= conflict.plugins.length) {
					rl.close();
					resolve(choice - 1);
					return;
				}

				// Invalid input - show error and reprompt
				log(chalk.red(`  Invalid choice "${trimmed}". Valid options: ${validChoices.join(", ")}`));
				askQuestion();
			});
		};

		askQuestion();
	});
}

/**
 * Check if a spec is a file: protocol path (for linked plugins)
 */
function isFileProtocol(spec: string): boolean {
	return spec.startsWith("file:");
}

/**
 * Check if a path looks like a local directory path (not file: protocol)
 */
function isLocalDirectoryPath(spec: string): boolean {
	return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~");
}

/**
 * Dry-run operation types for install
 */
interface DryRunOperation {
	type: "npm-install" | "symlink" | "copy" | "config-update" | "manifest-update" | "lockfile-update";
	description: string;
	path?: string;
	target?: string;
}

/**
 * Display dry-run operations in a clear format
 */
function displayDryRunOperations(pluginName: string, operations: DryRunOperation[]): void {
	log(chalk.blue(`\n📋 Dry-run: ${pluginName}`));
	log(chalk.dim("  The following operations would be performed:\n"));

	const grouped = {
		npm: operations.filter((o) => o.type === "npm-install"),
		symlinks: operations.filter((o) => o.type === "symlink"),
		copies: operations.filter((o) => o.type === "copy"),
		configs: operations.filter((o) => o.type === "config-update"),
		manifests: operations.filter((o) => o.type === "manifest-update"),
		lockfiles: operations.filter((o) => o.type === "lockfile-update"),
	};

	if (grouped.npm.length > 0) {
		log(chalk.yellow("  📦 npm operations:"));
		for (const op of grouped.npm) {
			log(`     ${op.description}`);
		}
	}

	if (grouped.symlinks.length > 0) {
		log(chalk.yellow("  🔗 Symlinks to create:"));
		for (const op of grouped.symlinks) {
			log(`     ${op.path} → ${op.target}`);
		}
	}

	if (grouped.copies.length > 0) {
		log(chalk.yellow("  📄 Files to copy:"));
		for (const op of grouped.copies) {
			log(`     ${op.path} ← ${op.target}`);
		}
	}

	if (grouped.configs.length > 0) {
		log(chalk.yellow("  ⚙️  Config updates:"));
		for (const op of grouped.configs) {
			log(`     ${op.description}`);
		}
	}

	if (grouped.manifests.length > 0) {
		log(chalk.yellow("  📝 Manifest updates:"));
		for (const op of grouped.manifests) {
			log(`     ${op.description}`);
		}
	}

	if (grouped.lockfiles.length > 0) {
		log(chalk.yellow("  🔒 Lockfile updates:"));
		for (const op of grouped.lockfiles) {
			log(`     ${op.description}`);
		}
	}

	log();
}

/**
 * Install plugins from package specifiers
 * omp install [pkg...]
 */
export async function installPlugin(packages?: string[], options: InstallOptions = {}): Promise<void> {
	requireNpm();

	// Enable JSON mode early so all human output is suppressed
	if (options.json) {
		setJsonMode(true);
	}

	// Dry-run mode announcement
	if (options.dryRun) {
		log(chalk.cyan("🔍 DRY-RUN MODE: No changes will be made\n"));
	}

	// Initialize global plugins directory
	await initGlobalPlugins();

	// If no packages specified, install from plugins.json
	if (!packages || packages.length === 0) {
		const pluginsJson = await loadPluginsJson();
		// Prefer locked versions for reproducible installs
		const lockFile = await import("@omp/lockfile").then((m) => m.loadLockFile());
		packages = await Promise.all(
			Object.entries(pluginsJson.plugins).map(async ([name, version]) => {
				// file: protocol paths need special handling
				if (version.startsWith("file:")) {
					return version; // Keep the file: protocol for linked plugins
				}
				// Use locked version if available for reproducibility
				const lockedVersion = lockFile?.packages[name]?.version;
				return `${name}@${lockedVersion || version}`;
			}),
		);

		if (packages.length === 0) {
			log(chalk.yellow("No plugins to install."));
			log(chalk.dim("Add plugins with: omp install <package>"));
			process.exitCode = 1;
			return;
		}

		log(chalk.blue(`Installing ${packages.length} plugin(s) from package.json...`));
	}

	// Get existing plugins for conflict detection
	const existingPlugins = await getInstalledPlugins();

	const results: Array<{
		name: string;
		version: string;
		success: boolean;
		error?: string;
	}> = [];

	// Load plugins.json once for reinstall detection and config storage
	let pluginsJson = await loadPluginsJson();

	for (const spec of packages) {
		// Handle file: protocol paths (linked plugins)
		if (isFileProtocol(spec)) {
			const localPath = spec.slice(5); // Remove "file:" prefix
			const result = await installLocalPlugin(localPath, options);
			results.push(result);
			continue;
		}

		// Reject local directory paths - only file: protocol is supported
		if (isLocalDirectoryPath(spec)) {
			log(chalk.red(`Error: Local directory paths are not supported. Use 'omp link ${spec}' instead.`));
			results.push({
				name: basename(spec),
				version: "local",
				success: false,
				error: "Use 'omp link' for local plugins",
			});
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
		let pendingLockUpdate: {
			name: string;
			version: string;
			resolved?: string;
			integrity?: string;
		} | null = null;

		try {
			log(chalk.blue(`\nInstalling ${pkgSpec}...`));

			// 1. Resolve version and fetch package metadata from npm registry
			// npm info includes omp field if present in package.json
			const fetchProgress = createProgress(`Fetching package info for ${name}...`);
			const info = await npmInfo(pkgSpec);
			if (!info) {
				fetchProgress.fail(`Package not found: ${name}`);
				process.exitCode = 1;
				results.push({
					name,
					version,
					success: false,
					error: "Package not found",
				});
				continue;
			}
			fetchProgress.succeed(`Found ${info.name}@${info.version}`);
			resolvedVersion = info.version;

			// Verify integrity if package was previously locked
			const lockedEntry = await getLockedPackage(name);
			if (lockedEntry?.integrity && info.dist?.integrity) {
				if (!verifyIntegrity(lockedEntry.integrity, info.dist.integrity)) {
					log(
						chalk.red(`  ✗ Integrity mismatch for ${name}@${info.version}: registry hash differs from lockfile`),
					);
					log(chalk.dim(`    Expected: ${lockedEntry.integrity}`));
					log(chalk.dim(`    Got: ${info.dist.integrity}`));
					log(chalk.yellow(`    This could indicate registry compromise or republished package.`));
					process.exitCode = 1;
					results.push({
						name,
						version: info.version,
						success: false,
						error: "Integrity verification failed",
					});
					continue;
				}
			}

			// 2. Check for conflicts BEFORE npm install using registry metadata
			const skipDestinations = new Set<string>();
			const preInstallPkgJson = info.omp?.install ? { name: info.name, version: info.version, omp: info.omp } : null;

			// Collect transitive deps with omp.install for conflict detection
			const transitiveDeps = await collectTransitiveOmpDeps(info);
			const hasOmpContent = preInstallPkgJson || transitiveDeps.size > 0;

			if (hasOmpContent) {
				// Check for intra-plugin duplicates first (in main plugin)
				if (preInstallPkgJson) {
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
				}

				// Check intra-plugin duplicates in transitive deps too
				let hasTransitiveDupes = false;
				for (const [depName, depPkgJson] of transitiveDeps) {
					const intraDupes = detectIntraPluginDuplicates(depPkgJson);
					if (intraDupes.length > 0) {
						log(chalk.red(`  ✗ Dependency ${depName} has duplicate destinations:`));
						for (const dupe of intraDupes) {
							log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
						}
						hasTransitiveDupes = true;
					}
				}
				if (hasTransitiveDupes) {
					process.exitCode = 1;
					results.push({
						name,
						version: info.version,
						success: false,
						error: "Duplicate destinations in transitive dependency",
					});
					continue;
				}

				// Create a synthetic package.json for conflict checking if main plugin has no omp
				const pkgJsonForConflicts =
					preInstallPkgJson ||
					({
						name: info.name,
						version: info.version,
					} as PluginPackageJson);

				const preInstallConflicts = detectConflicts(name, pkgJsonForConflicts, existingPlugins, transitiveDeps);

				if (preInstallConflicts.length > 0 && !options.force) {
					// Determine conflict resolution strategy
					const isNonInteractive = !process.stdout.isTTY || !process.stdin.isTTY;
					const resolution = options.conflictResolution || (isNonInteractive ? undefined : "prompt");

					// Non-interactive without explicit resolution strategy
					if (isNonInteractive && !resolution) {
						log(
							chalk.red(
								"Conflicts detected in non-interactive mode. Use --conflict-resolution or --force to proceed.",
							),
						);
						log(chalk.dim("  Options: --conflict-resolution=abort|overwrite|skip"));
						log(chalk.dim("           --force (alias for --conflict-resolution=overwrite)"));
						for (const conflict of preInstallConflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts in non-interactive mode without resolution strategy",
						});
						continue;
					}

					// Handle based on resolution strategy
					if (resolution === "abort") {
						log(chalk.yellow(`  Aborted due to conflicts (--conflict-resolution=abort)`));
						for (const conflict of preInstallConflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts (abort strategy)",
						});
						continue;
					}

					if (resolution === "skip") {
						// Skip all conflicting destinations, keeping existing plugins
						for (const conflict of preInstallConflicts) {
							skipDestinations.add(conflict.dest);
							log(chalk.dim(`  Skipping ${conflict.dest} (keeping existing)`));
						}
					} else if (resolution === "overwrite") {
						// Don't add to skipDestinations - will overwrite existing
						for (const conflict of preInstallConflicts) {
							log(chalk.dim(`  Overwriting ${conflict.dest}`));
						}
					} else {
						// Interactive prompt mode
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
			}

			// 3. Dry-run mode: compute and display operations, skip execution
			if (options.dryRun) {
				const dryRunOps: DryRunOperation[] = [];
				const baseDir = PI_CONFIG_DIR;

				// npm install operation
				dryRunOps.push({
					type: "npm-install",
					description: `npm install ${pkgSpec} --prefix ${PLUGINS_DIR}`,
				});

				// Compute symlink/copy operations from registry metadata
				if (info.omp?.install) {
					for (const entry of info.omp.install) {
						if (skipDestinations.has(entry.dest)) continue;

						if (entry.copy) {
							dryRunOps.push({
								type: "copy",
								description: `Copy ${entry.src} to ${entry.dest}`,
								path: join(baseDir, entry.dest),
								target: entry.src,
							});
						} else {
							dryRunOps.push({
								type: "symlink",
								description: `Symlink ${entry.dest} → ${entry.src}`,
								path: join(baseDir, entry.dest),
								target: entry.src,
							});
						}
					}
				}

				// Transitive deps with omp.install
				for (const [depName, depPkgJson] of transitiveDeps) {
					if (depPkgJson.omp?.install) {
						for (const entry of depPkgJson.omp.install) {
							dryRunOps.push({
								type: "symlink",
								description: `Symlink from ${depName}: ${entry.dest} → ${entry.src}`,
								path: join(baseDir, entry.dest),
								target: `${depName}/${entry.src}`,
							});
						}
					}
				}

				// Manifest updates
				if (options.save || options.saveDev) {
					dryRunOps.push({
						type: "manifest-update",
						description: `Add ${name}@${info.version} to package.json`,
					});
				}

				// Lockfile update
				dryRunOps.push({
					type: "lockfile-update",
					description: `Record ${name}@${info.version} in omp-lock.json`,
				});

				displayDryRunOperations(name, dryRunOps);
				results.push({ name, version: info.version, success: true });
				continue;
			}

			// 3. npm install - only reached if no conflicts or user resolved them
			log(chalk.dim(`  Fetching from npm...`));
			await npmInstall([pkgSpec], PLUGINS_DIR, { save: options.save ?? true });
			npmInstallSucceeded = true;

			// 4. Read package.json from installed package
			const pkgJson = await readPluginPackageJson(name);
			if (!pkgJson) {
				log(chalk.yellow(`  ⚠ Installed but no package.json found`));
				results.push({ name, version: info.version, success: true });
				continue;
			}

			// 5. Re-check conflicts with full package.json if we didn't check pre-install
			// This handles edge cases where omp field wasn't in registry metadata
			if (!hasOmpContent) {
				// Check for intra-plugin duplicates first
				const intraDupes = detectIntraPluginDuplicates(pkgJson);
				if (intraDupes.length > 0) {
					log(chalk.red(`  ✗ Plugin has duplicate destinations:`));
					for (const dupe of intraDupes) {
						log(chalk.red(`    ${dupe.dest} ← ${dupe.sources.join(", ")}`));
					}
					// Rollback: uninstall the package
					execFileSync("npm", ["uninstall", "--prefix", PLUGINS_DIR, name], {
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

				// Read transitive deps from installed packages (more accurate than registry)
				const installedTransitiveDeps = new Map<string, PluginPackageJson>();
				if (pkgJson.dependencies) {
					const seen = new Set<string>([name]);
					const collectInstalled = async (deps: Record<string, string>) => {
						for (const depName of Object.keys(deps)) {
							if (seen.has(depName)) continue;
							seen.add(depName);
							const depPkgJson = await readPluginPackageJson(depName);
							if (depPkgJson?.omp?.install) {
								installedTransitiveDeps.set(depName, depPkgJson);
							}
							if (depPkgJson?.dependencies) {
								await collectInstalled(depPkgJson.dependencies);
							}
						}
					};
					await collectInstalled(pkgJson.dependencies);
				}

				const conflicts = detectConflicts(name, pkgJson, existingPlugins, installedTransitiveDeps);

				if (conflicts.length > 0 && !options.force) {
					// Determine conflict resolution strategy
					const isNonInteractive = !process.stdout.isTTY || !process.stdin.isTTY;
					const resolution = options.conflictResolution || (isNonInteractive ? undefined : "prompt");

					// Non-interactive without explicit resolution strategy
					if (isNonInteractive && !resolution) {
						log(
							chalk.red(
								"Conflicts detected in non-interactive mode. Use --conflict-resolution or --force to proceed.",
							),
						);
						log(chalk.dim("  Options: --conflict-resolution=abort|overwrite|skip"));
						log(chalk.dim("           --force (alias for --conflict-resolution=overwrite)"));
						for (const conflict of conflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", PLUGINS_DIR, name], {
							stdio: "pipe",
						});
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts in non-interactive mode without resolution strategy",
						});
						continue;
					}

					// Handle based on resolution strategy
					if (resolution === "abort") {
						log(chalk.yellow(`  Aborted due to conflicts (--conflict-resolution=abort)`));
						for (const conflict of conflicts) {
							log(chalk.yellow(`  ⚠ ${formatConflicts([conflict])[0]}`));
						}
						// Rollback: uninstall the package
						execFileSync("npm", ["uninstall", "--prefix", PLUGINS_DIR, name], {
							stdio: "pipe",
						});
						process.exitCode = 1;
						results.push({
							name,
							version: info.version,
							success: false,
							error: "Conflicts (abort strategy)",
						});
						continue;
					}

					if (resolution === "skip") {
						// Skip all conflicting destinations, keeping existing plugins
						for (const conflict of conflicts) {
							skipDestinations.add(conflict.dest);
							log(chalk.dim(`  Skipping ${conflict.dest} (keeping existing)`));
						}
					} else if (resolution === "overwrite") {
						// Don't add to skipDestinations - will overwrite existing
						for (const conflict of conflicts) {
							log(chalk.dim(`  Overwriting ${conflict.dest}`));
						}
					} else {
						// Interactive prompt mode
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
							execFileSync("npm", ["uninstall", "--prefix", PLUGINS_DIR, name], {
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
			const symlinkResult = await createPluginSymlinks(name, pkgJson, true, skipDestinations, enabledFeatures);
			createdSymlinks = symlinkResult.created;

			// 7. Process dependencies with omp field (with cycle detection)
			const autoLinkedTransitiveDeps = await processOmpDependencies(pkgJson, new Set([name]), name);

			// 8. Stage manifest and config changes (written only after full success)
			// npm --save already updates package.json dependencies
			// but we need to handle devDependencies and config manually
			// Also register any auto-linked transitive deps
			const hasTransitiveDeps = autoLinkedTransitiveDeps.size > 0;
			if (options.saveDev || configToStore || hasTransitiveDeps) {
				if (options.saveDev) {
					pendingPluginEntry = { name, version: info.version, isDev: true };
				}

				if (configToStore) {
					pendingConfig = configToStore;
				}
			}

			// Stage lock file update with integrity data
			pendingLockUpdate = {
				name,
				version: info.version,
				resolved: info.dist?.tarball,
				integrity: info.dist?.integrity,
			};

			// Add to installed plugins map for subsequent conflict detection
			existingPlugins.set(name, pkgJson);

			// 9. Commit all manifest changes atomically after all operations succeeded
			// This ensures plugins.json is only written if npm install + symlinks both succeeded
			if (pendingPluginEntry || pendingConfig || hasTransitiveDeps) {
				// Reload to avoid stale data if multiple packages are being installed
				pluginsJson = await loadPluginsJson();

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

				// Register auto-linked transitive dependencies
				if (hasTransitiveDeps) {
					if (!pluginsJson.transitiveDeps) {
						pluginsJson.transitiveDeps = {};
					}
					for (const [depName, parentName] of autoLinkedTransitiveDeps) {
						pluginsJson.transitiveDeps[depName] = parentName;
					}
				}

				await savePluginsJson(pluginsJson);
			}

			// Update lock file with exact version and integrity (after manifest is committed)
			if (pendingLockUpdate) {
				await updateLockFile(pendingLockUpdate.name, {
					version: pendingLockUpdate.version,
					resolved: pendingLockUpdate.resolved,
					integrity: pendingLockUpdate.integrity,
				});
			}

			log(chalk.green(`✓ Installed ${name}@${info.version}`));
			results.push({ name, version: info.version, success: true });
		} catch (err) {
			const errorMsg = (err as Error).message;
			log(chalk.red(`  ✗ Failed to install ${name}: ${errorMsg}`));

			// Rollback: remove any symlinks that were created
			if (createdSymlinks.length > 0) {
				log(chalk.dim("  Rolling back symlinks..."));
				for (const dest of createdSymlinks) {
					try {
						await rm(join(PI_CONFIG_DIR, dest), { force: true, recursive: true });
					} catch {
						// Ignore cleanup errors
					}
				}
			}

			// Rollback: uninstall npm package if it was installed
			if (npmInstallSucceeded) {
				log(chalk.dim("  Rolling back npm install..."));
				try {
					execFileSync("npm", ["uninstall", "--prefix", PLUGINS_DIR, name], {
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

	// Ensure the OMP loader is in place (only if not dry-run and we installed something)
	if (!options.dryRun && successful.length > 0) {
		await writeLoader();
	}

	log();
	if (options.dryRun) {
		log(chalk.cyan(`✓ Dry-run complete: ${successful.length} plugin(s) would be installed`));
		if (failed.length > 0) {
			log(chalk.yellow(`  ${failed.length} plugin(s) would fail (conflicts, not found, etc.)`));
		}
	} else {
		if (successful.length > 0) {
			log(chalk.green(`✓ Installed ${successful.length} plugin(s)`));
		}
		if (failed.length > 0) {
			log(chalk.red(`✗ Failed to install ${failed.length} plugin(s)`));
			process.exitCode = 1;
		}
	}

	if (options.json) {
		outputJson({ results, dryRun: options.dryRun });
	}
}

/**
 * Install a local plugin from file: protocol path (used for linked plugins)
 */
async function installLocalPlugin(
	localPath: string,
	options: InstallOptions,
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

	const nodeModules = NODE_MODULES_DIR;

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

		// Dry-run mode: compute and display operations, skip execution
		if (options.dryRun) {
			const dryRunOps: DryRunOperation[] = [];

			// Copy operation
			dryRunOps.push({
				type: "copy",
				description: `Copy plugin directory to ${pluginDir}`,
				path: pluginDir,
				target: localPath,
			});

			// Compute symlink/copy operations from package.json
			if (pkgJson.omp?.install) {
				for (const entry of pkgJson.omp.install) {
					if (entry.copy) {
						dryRunOps.push({
							type: "copy",
							description: `Copy ${entry.src} to ${entry.dest}`,
							path: join(PI_CONFIG_DIR, entry.dest),
							target: entry.src,
						});
					} else {
						dryRunOps.push({
							type: "symlink",
							description: `Symlink ${entry.dest} → ${entry.src}`,
							path: join(PI_CONFIG_DIR, entry.dest),
							target: entry.src,
						});
					}
				}
			}

			// Manifest update
			dryRunOps.push({
				type: "manifest-update",
				description: `Add ${pluginName}@file:${localPath} to package.json`,
			});

			// Lockfile update
			dryRunOps.push({
				type: "lockfile-update",
				description: `Record ${pluginName}@${pkgJson.version} in omp-lock.json`,
			});

			displayDryRunOperations(pluginName, dryRunOps);
			return { name: pluginName, version: pkgJson.version, success: true };
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

		// Track state for rollback
		const pluginCopied = true;
		let symlinksCreated = false;

		try {
			// Create symlinks
			await createPluginSymlinks(pluginName, pkgJson);
			symlinksCreated = true;

			// Update package.json
			const pluginsJson = await loadPluginsJson();
			if (options.saveDev) {
				if (!pluginsJson.devDependencies) {
					pluginsJson.devDependencies = {};
				}
				pluginsJson.devDependencies[pluginName] = `file:${localPath}`;
				// Remove from plugins if it was there
				delete pluginsJson.plugins[pluginName];
			} else {
				pluginsJson.plugins[pluginName] = `file:${localPath}`;
			}
			await savePluginsJson(pluginsJson);

			// Update lock file for local plugin
			await updateLockFile(pluginName, { version: pkgJson.version });
		} catch (err) {
			// Rollback: remove copied plugin directory
			if (pluginCopied) {
				log(chalk.dim("  Rolling back copied plugin..."));
				try {
					await rm(pluginDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
			// Rollback: remove symlinks if they were created
			if (symlinksCreated && pkgJson.omp?.install) {
				log(chalk.dim("  Rolling back symlinks..."));
				for (const entry of pkgJson.omp.install) {
					try {
						await rm(join(PI_CONFIG_DIR, entry.dest), { force: true, recursive: true });
					} catch {
						// Ignore cleanup errors
					}
				}
			}
			throw err;
		}

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
