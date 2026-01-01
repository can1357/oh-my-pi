import { loadPluginsJson } from "@omp/manifest";
import { npmOutdated, requireNpm } from "@omp/npm";
import { padEnd, sanitize, truncate } from "@omp/output";
import { PLUGINS_DIR } from "@omp/paths";
import chalk from "chalk";

export interface OutdatedOptions {
	json?: boolean;
}

/**
 * List plugins with newer versions available
 */
export async function showOutdated(options: OutdatedOptions = {}): Promise<void> {
	requireNpm();

	const prefix = PLUGINS_DIR;

	console.log(chalk.blue("Checking for outdated plugins..."));

	try {
		const outdated = await npmOutdated(prefix);
		const pluginsJson = await loadPluginsJson();

		// Filter to only show plugins we manage AND are not local
		const managedOutdated = Object.entries(outdated).filter(([name]) => {
			const specifier = pluginsJson.plugins[name];
			if (!specifier) return false; // Not in our manifest
			if (specifier.startsWith("file:")) return false; // Local plugin, skip
			return true;
		});

		if (managedOutdated.length === 0) {
			console.log(chalk.green("\n✓ All plugins are up to date!"));
			return;
		}

		if (options.json) {
			const result = Object.fromEntries(managedOutdated);
			console.log(JSON.stringify({ outdated: result }, null, 2));
			return;
		}

		console.log(chalk.bold(`\nOutdated plugins (${managedOutdated.length}):\n`));

		// Column widths
		const COL_NAME = 28;
		const COL_VERSION = 15;

		// Header
		console.log(
			chalk.dim(padEnd("  Package", COL_NAME + 2)) +
				chalk.dim(padEnd("Current", COL_VERSION)) +
				chalk.dim(padEnd("Wanted", COL_VERSION)) +
				chalk.dim("Latest"),
		);

		for (const [rawName, versions] of managedOutdated) {
			// Sanitize npm metadata, truncate long names
			const name = truncate(sanitize(rawName), COL_NAME);
			const current = sanitize(versions.current || "?");
			const wanted = sanitize(versions.wanted || "?");
			const latest = sanitize(versions.latest || "?");

			const hasMinorUpdate = wanted !== current;
			const hasMajorUpdate = latest !== wanted;

			const wantedColor = hasMinorUpdate ? chalk.yellow : chalk.dim;
			const latestColor = hasMajorUpdate ? chalk.red : wantedColor;

			console.log(
				`  ${padEnd(chalk.white(name), COL_NAME)}` +
					`${padEnd(chalk.dim(current), COL_VERSION)}` +
					`${padEnd(wantedColor(wanted), COL_VERSION)}` +
					`${latestColor(latest)}`,
			);
		}

		// Note about local plugins excluded from check
		const localPlugins = Object.entries(pluginsJson.plugins).filter(([_, spec]) => spec.startsWith("file:"));
		if (localPlugins.length > 0) {
			console.log(chalk.dim(`\nNote: ${localPlugins.length} local plugin(s) excluded from check`));
		}

		console.log();
		console.log(chalk.dim("Update with: omp update [package]"));
		console.log(chalk.dim("  - 'wanted' = latest within semver range"));
		console.log(chalk.dim("  - 'latest' = latest available version"));
	} catch (err) {
		console.log(chalk.red(`Error checking outdated: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
