import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { writeLoader } from "@omp/loader";
import { loadPluginsJson, type OmpInstallEntry, type PluginPackageJson, savePluginsJson } from "@omp/manifest";
import { NODE_MODULES_DIR } from "@omp/paths";
import { createPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

async function confirmCreate(path: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log(chalk.dim("  Non-interactive mode: auto-creating package.json"));
		return true;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(chalk.yellow(`  Create minimal package.json at ${path}? [Y/n] `), (answer) => {
			rl.close();
			resolve(answer.toLowerCase() !== "n");
		});
	});
}

export interface LinkOptions {
	name?: string;
	force?: boolean;
	yes?: boolean;
}

/**
 * Link a local plugin directory for development
 * Creates a symlink in node_modules pointing to the local directory
 */
export async function linkPlugin(localPath: string, options: LinkOptions = {}): Promise<void> {
	const nodeModules = NODE_MODULES_DIR;

	// Expand ~ to home directory
	if (localPath.startsWith("~")) {
		localPath = join(process.env.HOME || "", localPath.slice(1));
	}
	localPath = resolve(localPath);

	// Verify the path exists
	if (!existsSync(localPath)) {
		console.log(chalk.red(`Error: Path does not exist: ${localPath}`));
		process.exitCode = 1;
		return;
	}

	// Read package.json from local path
	let pkgJson: PluginPackageJson;
	const localPkgJsonPath = join(localPath, "package.json");
	const localOmpJsonPath = join(localPath, "omp.json");

	if (existsSync(localPkgJsonPath)) {
		try {
			pkgJson = JSON.parse(await readFile(localPkgJsonPath, "utf-8"));
		} catch (err) {
			console.log(chalk.red(`Error: Invalid JSON in ${localPkgJsonPath}: ${(err as Error).message}`));
			process.exitCode = 1;
			return;
		}
	} else if (existsSync(localOmpJsonPath)) {
		// Convert legacy omp.json to package.json format
		let ompJson: Record<string, unknown>;
		try {
			ompJson = JSON.parse(await readFile(localOmpJsonPath, "utf-8"));
		} catch (err) {
			console.log(chalk.red(`Error: Invalid JSON in ${localOmpJsonPath}: ${(err as Error).message}`));
			process.exitCode = 1;
			return;
		}
		pkgJson = {
			name: (ompJson.name as string) || options.name || basename(localPath),
			version: (ompJson.version as string) || "0.0.0-dev",
			description: ompJson.description as string | undefined,
			keywords: ["omp-plugin"],
			omp: {
				install: ompJson.install as OmpInstallEntry[] | undefined,
			},
		};

		// Persist the conversion to package.json
		console.log(chalk.dim("  Converting omp.json to package.json..."));
		await writeFile(localPkgJsonPath, JSON.stringify(pkgJson, null, 2));
	} else {
		// Create minimal package.json so npm operations work correctly
		console.log(chalk.yellow("  No package.json found in target directory."));
		const shouldCreate = await confirmCreate(localPkgJsonPath);
		if (!shouldCreate) {
			console.log(chalk.yellow("  Aborted: package.json required for linking"));
			process.exitCode = 1;
			return;
		}
		pkgJson = {
			name: options.name || basename(localPath),
			version: "0.0.0-dev",
			keywords: ["omp-plugin"],
			omp: {
				install: [],
			},
		};
		console.log(chalk.dim("  Creating minimal package.json..."));
		await writeFile(localPkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}

	const pluginName = options.name || pkgJson.name;
	if (!pluginName) {
		console.log(chalk.red("Error: Plugin name is required. Set 'name' in package.json or use --name option."));
		process.exitCode = 1;
		return;
	}
	const pluginDir = join(nodeModules, pluginName);

	// Check if already installed
	const pluginsJson = await loadPluginsJson();
	if (pluginsJson.plugins[pluginName]) {
		const existingSpec = pluginsJson.plugins[pluginName];
		const isLinked = existingSpec.startsWith("file:");

		if (isLinked) {
			console.log(chalk.yellow(`Plugin "${pluginName}" is already linked.`));
			console.log(chalk.dim(`  Current link: ${existingSpec}`));
			console.log(chalk.dim("  Re-linking..."));
			// Continue with the linking process (will overwrite)
		} else if (options.force) {
			console.log(chalk.yellow(`Plugin "${pluginName}" is installed from npm. Overwriting with link...`));
			// Continue with the linking process (will overwrite)
		} else {
			console.log(chalk.yellow(`Plugin "${pluginName}" is already installed from npm.`));
			console.log(chalk.dim("Use omp uninstall first, or specify a different name with -n"));
			console.log(chalk.dim("Or use --force to overwrite the npm installation"));
			process.exitCode = 1;
			return;
		}
	}

	try {
		console.log(chalk.blue(`Linking ${localPath}...`));

		// Create parent directory (handles scoped packages like @org/name)
		await mkdir(dirname(pluginDir), { recursive: true });

		// Remove existing if present - with confirmation for non-symlink directories
		if (existsSync(pluginDir)) {
			const stat = lstatSync(pluginDir);
			const isSymlink = stat.isSymbolicLink();

			if (!isSymlink) {
				// Real directory or file - requires confirmation
				console.log(chalk.yellow(`\nWarning: ${pluginDir} exists and is not a symlink.`));
				console.log(chalk.dim("This directory/file will be deleted:"));
				console.log(chalk.dim(`  - ${pluginDir}`));

				const skipConfirmation = options.force || options.yes;
				const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

				if (!skipConfirmation) {
					if (!isInteractive) {
						console.log(chalk.red("\nError: Destructive operation requires confirmation."));
						console.log(chalk.dim("Use --force or --yes flag in non-interactive environments."));
						process.exitCode = 1;
						return;
					}

					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
					});
					const answer = await new Promise<string>((resolve) => {
						rl.question(chalk.yellow("\nDelete this and proceed with linking? [y/N] "), (ans) => {
							rl.close();
							resolve(ans);
						});
					});

					if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
						console.log(chalk.dim("Link aborted."));
						return;
					}
				}
			}

			await rm(pluginDir, { force: true, recursive: true });
		}

		// Create symlink to the plugin directory
		await symlink(localPath, pluginDir);
		console.log(chalk.dim(`  Symlinked: ${pluginDir} → ${localPath}`));

		// Update plugins.json with file: protocol
		pluginsJson.plugins[pluginName] = `file:${localPath}`;
		await savePluginsJson(pluginsJson);

		// Create symlinks for omp.install entries
		if (pkgJson.omp?.install?.length) {
			await createPluginSymlinks(pluginName, pkgJson);
		}

		// Ensure the OMP loader is in place
		await writeLoader();

		console.log(
			chalk.green(`\n✓ Linked "${pluginName}"${pkgJson.version ? ` v${pkgJson.version}` : ""} (development mode)`),
		);
		console.log(chalk.dim("  Changes to the source will be reflected immediately"));
	} catch (err) {
		console.log(chalk.red(`Error linking plugin: ${(err as Error).message}`));
		process.exitCode = 1;
		// Cleanup on failure
		try {
			await rm(pluginDir, { force: true });
		} catch {}
	}
}
