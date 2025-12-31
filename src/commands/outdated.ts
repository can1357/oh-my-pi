import { loadPluginsJson } from "@omp/manifest";
import { npmOutdated } from "@omp/npm";
import { PLUGINS_DIR, resolveScope } from "@omp/paths";
import chalk from "chalk";

export interface OutdatedOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * List plugins with newer versions available
 */
export async function showOutdated(options: OutdatedOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";

	console.log(chalk.blue("Checking for outdated plugins..."));

	try {
		const outdated = await npmOutdated(prefix);
		const pluginsJson = await loadPluginsJson(isGlobal);

		// Filter to only show plugins we manage
		const managedOutdated = Object.entries(outdated).filter(([name]) => {
			return pluginsJson.plugins[name] !== undefined;
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

		// Header
		console.log(
			chalk.dim("  Package".padEnd(30)) +
				chalk.dim("Current".padEnd(15)) +
				chalk.dim("Wanted".padEnd(15)) +
				chalk.dim("Latest"),
		);

		for (const [name, versions] of managedOutdated) {
			const current = versions.current || "?";
			const wanted = versions.wanted || "?";
			const latest = versions.latest || "?";

			const hasMinorUpdate = wanted !== current;
			const hasMajorUpdate = latest !== wanted;

			const wantedColor = hasMinorUpdate ? chalk.yellow : chalk.dim;
			const latestColor = hasMajorUpdate ? chalk.red : wantedColor;

			console.log(
				`  ${chalk.white(name.padEnd(28))}` +
					`${chalk.dim(current.padEnd(15))}` +
					`${wantedColor(wanted.padEnd(15))}` +
					`${latestColor(latest)}`,
			);
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
